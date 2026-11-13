// Service worker: looks up IMDb and Rotten Tomatoes ratings for a film.
// The content script (running on letterboxd.com) already knows the Letterboxd
// rating, IMDb id, title and year from the Letterboxd film page.

const CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const NEG_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours for "not found"
const inflight = new Map();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  let job;
  if (msg?.type === 'imdb') job = cached(`imdb:${msg.imdbId}`, () => getImdb(msg));
  else if (msg?.type === 'rt') job = cached(`rt:${msg.imdbId || msg.slug}`, () => getRt(msg));
  else if (msg?.type === 'pg') job = cached(`pg:${msg.imdbId}`, () => getParentsGuide(msg));
  else return false;
  job.then(sendResponse, (err) => sendResponse({ ok: false, reason: 'error', error: String(err) }));
  return true; // async response
});

// ---------- caching ----------

async function cached(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const hit = (await chrome.storage.local.get(key))[key];
    if (hit && Date.now() - hit.ts < (hit.data.ok ? CACHE_TTL_MS : NEG_CACHE_TTL_MS)) return hit.data;
    const data = await fn();
    // Don't cache transient failures (blocked / network) so a later hover can retry.
    if (data.ok || data.reason === 'notfound') {
      await chrome.storage.local.set({ [key]: { ts: Date.now(), data } });
    }
    return data;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

async function getOmdbKey() {
  const { omdbKey } = await chrome.storage.sync.get('omdbKey');
  return (omdbKey || '').trim();
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { credentials: 'omit', ...opts });
  if (res.status !== 200) return { status: res.status, text: '' };
  return { status: 200, text: await res.text() };
}

// ---------- OMDb (optional, needs a free key from omdbapi.com) ----------

const omdbInflight = new Map();
function omdb(imdbId, key) {
  const k = imdbId + key;
  if (!omdbInflight.has(k)) {
    const p = fetch(`https://www.omdbapi.com/?i=${encodeURIComponent(imdbId)}&apikey=${encodeURIComponent(key)}`)
      .then((r) => r.json())
      .catch(() => null)
      .finally(() => setTimeout(() => omdbInflight.delete(k), 5000));
    omdbInflight.set(k, p);
  }
  return omdbInflight.get(k);
}

// ---------- IMDb ----------

async function getImdb({ imdbId }) {
  if (!imdbId) return { ok: false, reason: 'noid' };
  const url = `https://www.imdb.com/title/${imdbId}/`;
  let blocked = false;

  try {
    // Sent from the user's own browser, with their IMDb cookies.
    const { status, text } = await fetchText(url, { credentials: 'include' });
    if (status === 200 && text) {
      const parsed = parseImdb(text);
      if (parsed) return { ok: true, url, source: 'imdb', ...parsed };
      if (!/aws-waf|challenge/i.test(text.slice(0, 5000))) {
        // Page loaded fine but the title simply has no rating yet.
        if (/"@type":"(Movie|TVSeries|TVEpisode|TVMovie|VideoGame|CreativeWork)"/.test(text)) {
          return { ok: false, reason: 'notfound', url };
        }
      }
      blocked = true;
    } else {
      blocked = true;
    }
  } catch {
    blocked = true;
  }

  const key = await getOmdbKey();
  if (key) {
    const d = await omdb(imdbId, key);
    if (d && d.Response === 'True') {
      const rating = parseFloat(d.imdbRating);
      if (!isNaN(rating)) {
        return {
          ok: true,
          url,
          source: 'omdb',
          rating,
          votes: parseInt(String(d.imdbVotes).replace(/,/g, ''), 10) || null,
        };
      }
      return { ok: false, reason: 'notfound', url };
    }
  }
  return { ok: false, reason: blocked ? (key ? 'error' : 'blocked') : 'error', url };
}

function parseImdb(html) {
  // 1) JSON-LD block
  const ld = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ld) {
    try {
      const data = JSON.parse(ld[1]);
      const ar = data.aggregateRating;
      if (ar && ar.ratingValue != null) {
        return { rating: Number(ar.ratingValue), votes: Number(ar.ratingCount) || null };
      }
    } catch {}
  }
  // 2) Next.js data
  const m = html.match(/"ratingsSummary":\{"aggregateRating":([\d.]+),"voteCount":(\d+)/);
  if (m) return { rating: Number(m[1]), votes: Number(m[2]) };
  return null;
}

// ---------- IMDb parents guide ----------

const PG_SHORT = {
  NUDITY: 'Sex & Nudity',
  VIOLENCE: 'Violence & Gore',
  PROFANITY: 'Profanity',
  ALCOHOL: 'Alcohol & Drugs',
  FRIGHTENING: 'Frightening',
};

async function getParentsGuide({ imdbId }) {
  if (!imdbId) return { ok: false, reason: 'noid' };
  const url = `https://www.imdb.com/title/${imdbId}/parentalguide/`;
  let text;
  try {
    const res = await fetchText(url, { credentials: 'include' });
    if (res.status !== 200) return { ok: false, reason: 'blocked', url };
    text = res.text;
  } catch {
    return { ok: false, reason: 'error', url };
  }
  const m = text.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return { ok: false, reason: 'blocked', url };
  let cd;
  try {
    cd = JSON.parse(m[1]).props.pageProps.contentData;
  } catch {
    return { ok: false, reason: 'error', url };
  }
  const cats = (cd?.categories || []).map((c) => ({
    id: c.id,
    title: PG_SHORT[c.id] || c.title,
    fullTitle: c.title,
    severity: c.totalSeverityVotes ? c.severitySummary?.text || null : null,
    votes: c.severitySummary?.votes ?? null,
    totalVotes: c.totalSeverityVotes || 0,
    items: (c.items || [])
      .filter((i) => !i.isSpoiler)
      .slice(0, 40)
      .map((i) => i.text || i.machineTranslatedText?.value?.plaidHtml || '')
      .filter(Boolean),
    spoilers: c.spoilerItemsCount || 0,
    // IMDb only embeds the first page of entries; the rest are on the site.
    more: Math.max(0, (c.pagination?.totalItems || 0) - (c.items || []).length),
  }));
  if (!cats.length) return { ok: false, reason: 'notfound', url };
  const cert = cd.contentRatingData?.certificate?.certificate;
  return {
    ok: true,
    url,
    rating: cert?.rating || null,
    ratingBody: cert?.ratingsBody?.id || null,
    ratingReason: cd.contentRatingData?.ratingReason || cert?.ratingReason || null,
    categories: cats,
  };
}

// ---------- Rotten Tomatoes ----------

async function getRt({ imdbId, title, year }) {
  // 1) Exact mapping IMDb id -> RT id via Wikidata (property P1258).
  let rtUrl = imdbId ? await rtUrlFromWikidata(imdbId) : null;
  let data = rtUrl ? await parseRtPage(rtUrl) : null;

  // 2) Fall back to RT search by title + year.
  if (!data && title) {
    const found = await rtSearch(title, year);
    if (found && found !== rtUrl) {
      rtUrl = found;
      data = await parseRtPage(rtUrl);
    }
  }
  if (data) return { ok: true, url: rtUrl, source: 'rt', ...data };

  // 3) Fall back to OMDb (Tomatometer only).
  const key = imdbId ? await getOmdbKey() : '';
  if (key) {
    const d = await omdb(imdbId, key);
    const r = d?.Ratings?.find((x) => x.Source === 'Rotten Tomatoes');
    if (r) {
      return {
        ok: true,
        url: rtUrl || rtSearchUrl(title),
        source: 'omdb',
        critics: parseInt(r.Value, 10),
        audience: null,
      };
    }
  }
  return { ok: false, reason: 'notfound', url: rtUrl || rtSearchUrl(title) };
}

function rtSearchUrl(title) {
  return `https://www.rottentomatoes.com/search?search=${encodeURIComponent(title || '')}`;
}

async function rtUrlFromWikidata(imdbId) {
  const query = `SELECT ?rt WHERE { ?f wdt:P345 "${imdbId.replace(/[^a-z0-9]/gi, '')}"; wdt:P1258 ?rt } LIMIT 5`;
  try {
    const r = await fetch(
      `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(query)}`,
      { headers: { Accept: 'application/sparql-results+json' } }
    );
    if (!r.ok) return null;
    const j = await r.json();
    const ids = j.results.bindings.map((b) => b.rt.value).filter((v) => /^m\//.test(v));
    return ids.length ? `https://www.rottentomatoes.com/${ids[0]}` : null;
  } catch {
    return null;
  }
}

function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\band\b/g, '&')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9&]+/g, '');
}

async function rtSearch(title, year) {
  try {
    const { status, text } = await fetchText(rtSearchUrl(title));
    if (status !== 200) return null;
    // Only the "Movies" section.
    const sec = text.match(/<search-page-result[^>]*type="movie"[^>]*>([\s\S]*?)<\/search-page-result>/);
    if (!sec) return null;
    const rows = [...sec[1].matchAll(/<search-page-media-row([^>]*)>([\s\S]*?)<\/search-page-media-row>/g)].map((m) => {
      const y = (m[1].match(/release-year="(\d{4})"/) || [])[1];
      const a = m[2].match(/<a[^>]*href="([^"]+)"[^>]*data-qa="info-name"[^>]*>([\s\S]*?)<\/a>/);
      return a ? { year: y ? Number(y) : null, url: a[1], title: a[2].trim() } : null;
    }).filter(Boolean);

    const want = normTitle(title);
    const yr = Number(year) || null;
    const near = (r) => yr && r.year && Math.abs(r.year - yr) <= 1;
    return (
      rows.find((r) => normTitle(r.title) === want && r.year === yr) ||
      rows.find((r) => normTitle(r.title) === want && near(r)) ||
      rows.find((r) => r.year === yr && normTitle(r.title).includes(want)) ||
      (!yr ? rows.find((r) => normTitle(r.title) === want) : null) ||
      null
    )?.url ?? null;
  } catch {
    return null;
  }
}

async function parseRtPage(url) {
  try {
    const { status, text } = await fetchText(url);
    if (status !== 200) return null;
    const sc = text.match(/<script[^>]*id="media-scorecard-json"[^>]*>([\s\S]*?)<\/script>/);
    if (sc) {
      try {
        const j = JSON.parse(sc[1]);
        const pct = (s) => {
          const n = parseInt(String(s?.scorePercent ?? ''), 10);
          return isNaN(n) ? null : n;
        };
        const critics = pct(j.criticsScore);
        const audience = j.hideAudienceScore ? null : pct(j.audienceScore);
        if (critics != null || audience != null) {
          return {
            critics,
            criticsCertified: !!j.criticsScore?.certified,
            criticsCount: j.criticsScore?.reviewCount ?? null,
            audience,
            audienceCertified: !!j.audienceScore?.certified,
            audienceCount: j.audienceScore?.bandedRatingCount ?? null,
          };
        }
        return { critics: null, audience: null }; // page exists, no scores yet
      } catch {}
    }
    const ar = text.match(/"aggregateRating":\{[^}]*"ratingValue":"?(\d+)"?/);
    if (ar) return { critics: Number(ar[1]), audience: null };
    return { critics: null, audience: null };
  } catch {
    return null;
  }
}
