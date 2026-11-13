// Content script for letterboxd.com: shows a ratings card when a film
// link / title / poster is hovered anywhere on the site.
(() => {
  if (window.__lbRatingsLoaded) return;
  window.__lbRatingsLoaded = true;

  const LB_TTL_MS = 24 * 60 * 60 * 1000;
  const FILM_PATH_RE = /^(?:https?:\/\/(?:www\.)?letterboxd\.com)?\/(?:[^/?#]+\/)?film\/([a-z0-9][a-z0-9-]*)(?:\/|$)/i;
  const LINK_ATTRS = ['href', 'data-target-link', 'data-item-link', 'data-film-link', 'data-original-link'];
  const MAX_DEPTH = 6;

  let hoverDelay = 350;
  let showPG = true;
  chrome.storage.sync.get(['hoverDelay', 'showPG']).then(({ hoverDelay: d, showPG: pg }) => {
    if (Number.isFinite(d)) hoverDelay = d;
    if (typeof pg === 'boolean') showPG = pg;
  });
  chrome.storage.onChanged.addListener((c) => {
    if (c.hoverDelay && Number.isFinite(c.hoverDelay.newValue)) hoverDelay = c.hoverDelay.newValue;
    if (c.showPG && typeof c.showPG.newValue === 'boolean') showPG = c.showPG.newValue;
  });

  // The film whose own page we're on: don't pop up for its own tabs/links.
  const pageFilm = (location.pathname.match(/^\/(?:[^/]+\/)?film\/([a-z0-9-]+)/i) || [])[1] || null;

  // ---------- card element ----------

  const card = document.createElement('div');
  card.id = 'lbr-card';
  card.setAttribute('role', 'tooltip');
  card.hidden = true;
  document.documentElement.appendChild(card);

  let activeEl = null;
  let activeSlug = null;
  let pendingEl = null;
  let showTimer = 0;
  let hideTimer = 0;
  let renderToken = 0;
  let current = null; // state object currently drawn in the card

  // Plot and parents guide rows expand/collapse on click.
  card.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pg], [data-plot], [data-cast]');
    if (!b || !current) return;
    e.preventDefault();
    if (b.dataset.plot) current.plotOpen = !current.plotOpen;
    else if (b.dataset.cast) current.castOpen = !current.castOpen;
    else current.open = current.open === b.dataset.pg ? null : b.dataset.pg;
    current.interacted = true;
    render(current);
    fit();
  });

  // ---------- target detection ----------

  function slugFromValue(v) {
    if (!v) return null;
    const m = v.match(FILM_PATH_RE);
    return m ? m[1].toLowerCase() : null;
  }

  function findFilm(start) {
    let node = start;
    for (let depth = 0; node && node !== document.body && depth < MAX_DEPTH; depth++, node = node.parentElement) {
      if (node.nodeType !== 1) continue;
      for (const attr of LINK_ATTRS) {
        const slug = slugFromValue(node.getAttribute(attr));
        if (slug) return { el: node, slug };
      }
      const s = node.getAttribute('data-film-slug');
      if (s && /^[a-z0-9-]+$/i.test(s)) return { el: node, slug: s.toLowerCase() };
    }
    return null;
  }

  // ---------- hover handling ----------

  document.addEventListener(
    'mouseover',
    (e) => {
      const t = e.target;
      if (card.contains(t)) {
        clearTimeout(hideTimer);
        return;
      }
      const hit = findFilm(t);
      if (!hit || hit.slug === pageFilm) {
        clearTimeout(showTimer);
        pendingEl = null;
        if (!card.hidden) scheduleHide();
        return;
      }
      if (hit.el === activeEl && !card.hidden) {
        clearTimeout(hideTimer);
        return;
      }
      if (hit.el === pendingEl) return; // still waiting on the same element
      clearTimeout(showTimer);
      pendingEl = hit.el;
      // Switching from one visible card to another film is quicker than a fresh hover.
      const delay = card.hidden ? hoverDelay : Math.min(hoverDelay, 250);
      showTimer = setTimeout(() => {
        pendingEl = null;
        show(hit.el, hit.slug);
      }, delay);
    },
    true
  );

  document.documentElement.addEventListener('mouseleave', () => {
    clearTimeout(showTimer);
    pendingEl = null;
    scheduleHide(0);
  });
  window.addEventListener('blur', () => hide());
  window.addEventListener(
    'scroll',
    (e) => !card.hidden && !(e.target instanceof Node && card.contains(e.target)) && position(),
    { passive: true, capture: true }
  );
  window.addEventListener('resize', () => hide());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide());
  // Letterboxd is partly a SPA (infinite scroll, modals): hide if the anchor disappears.
  new MutationObserver(() => {
    if (activeEl && !activeEl.isConnected) hide();
  }).observe(document.documentElement, { childList: true, subtree: true });

  function scheduleHide(ms = 200) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, ms);
  }

  function hide() {
    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    pendingEl = null;
    card.hidden = true;
    card.classList.remove('lbr-visible');
    activeEl = null;
    activeSlug = null;
    current = null;
    renderToken++;
  }

  function show(el, slug) {
    if (!el.isConnected) return;
    clearTimeout(hideTimer);
    activeEl = el;
    activeSlug = slug;
    const token = ++renderToken;
    render({ slug, loading: true });
    card.hidden = false;
    position();
    requestAnimationFrame(() => card.classList.add('lbr-visible'));
    load(slug, token);
  }

  // After the user has expanded something, keep the card where it is and just
  // make sure it still fits on screen (don't flip it around under the cursor).
  function reflow() {
    if (current?.interacted) fit();
    else position();
  }

  function fit() {
    const r = card.getBoundingClientRect();
    if (r.bottom > innerHeight - 8) card.style.top = `${Math.max(8, Math.round(innerHeight - 8 - r.height))}px`;
  }

  function position() {
    if (!activeEl) return;
    const r = activeEl.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return hide();
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const gap = 8;
    let top = r.bottom + gap;
    if (top + ch > innerHeight - 8 && r.top - gap - ch > 8) top = r.top - gap - ch;
    let left = r.left + r.width / 2 - cw / 2;
    left = Math.max(8, Math.min(left, innerWidth - cw - 8));
    card.style.top = `${Math.round(top)}px`;
    card.style.left = `${Math.round(left)}px`;
  }

  // ---------- data loading ----------

  const lbInflight = new Map();

  async function getLetterboxd(slug) {
    const key = `lb3:${slug}`;
    try {
      const hit = (await chrome.storage.local.get(key))[key];
      if (hit && Date.now() - hit.ts < LB_TTL_MS) return hit.data;
    } catch {}
    if (!lbInflight.has(slug)) {
      lbInflight.set(
        slug,
        (async () => {
          const res = await fetch(`/film/${slug}/`, { credentials: 'same-origin' });
          if (!res.ok) throw new Error(`Letterboxd ${res.status}`);
          const data = parseLetterboxd(await res.text(), slug);
          chrome.storage.local.set({ [key]: { ts: Date.now(), data } }).catch(() => {});
          return data;
        })().finally(() => lbInflight.delete(slug))
      );
    }
    return lbInflight.get(slug);
  }

  function parseLetterboxd(html, slug) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let ld = {};
    const ldEl = doc.querySelector('script[type="application/ld+json"]');
    if (ldEl) {
      try {
        ld = JSON.parse(ldEl.textContent.replace(/\/\*[\s\S]*?\*\//g, ''));
      } catch {}
    }
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.content || '';
    const yearMatch = ogTitle.match(/\((\d{4})\)\s*$/);
    const imdbHref = doc.querySelector('a[data-track-action="IMDb"], a[href*="imdb.com/title/"]')?.getAttribute('href') || '';
    const imdbId = (imdbHref.match(/\/title\/(tt\d+)/) || [])[1] || null;
    const ar = ld.aggregateRating || null;
    const meta = (sel) => doc.querySelector(sel)?.content || '';
    const description = ld.description || meta('meta[property="og:description"]') || meta('meta[name="description"]') || '';
    // Cast with character names (the link's title attribute); fall back to JSON-LD names.
    let cast = [...doc.querySelectorAll('.cast-list a[href^="/actor/"]')].map((a) => ({
      name: a.textContent.trim(),
      role: (a.getAttribute('title') || '').trim(),
      url: `https://letterboxd.com${a.getAttribute('href')}`,
    }));
    if (!cast.length) {
      cast = (Array.isArray(ld.actor) ? ld.actor : ld.actor ? [ld.actor] : [])
        .filter((a) => a?.name)
        .map((a) => ({ name: a.name, role: '', url: a.sameAs || '' }));
    }
    const castTotal = cast.length;
    cast = cast.filter((c) => c.name).slice(0, 25);
    const directors = (Array.isArray(ld.director) ? ld.director : ld.director ? [ld.director] : [])
      .map((d) => d.name)
      .filter(Boolean);
    return {
      slug,
      url: `https://letterboxd.com/film/${slug}/`,
      title: ld.name || ogTitle.replace(/\s*\(\d{4}\)\s*$/, '') || slug,
      year: yearMatch ? Number(yearMatch[1]) : null,
      poster: ld.image || null,
      directors,
      imdbId,
      rating: ar && ar.ratingValue != null ? Number(ar.ratingValue) : null,
      ratingCount: ar ? Number(ar.ratingCount) || null : null,
      description,
      cast,
      castTotal,
    };
  }

  function ask(msg) {
    return chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, reason: 'error', error: String(err) }));
  }

  async function load(slug, token) {
    const state = { slug, loading: true };
    current = state;
    const live = () => token === renderToken;
    let lb;
    try {
      lb = await getLetterboxd(slug);
    } catch (err) {
      if (live()) render({ slug, error: String(err.message || err) }), reflow();
      return;
    }
    if (!live()) return;
    Object.assign(state, {
      lb,
      imdb: lb.imdbId ? null : { ok: false, reason: 'noid' },
      rt: null,
      pg: lb.imdbId ? null : { ok: false, reason: 'noid' },
      wantPG: showPG,
    });
    render(state);
    reflow();

    const msgBase = { imdbId: lb.imdbId, title: lb.title, year: lb.year, slug };
    const imdbP = lb.imdbId
      ? ask({ type: 'imdb', ...msgBase }).then((r) => {
          state.imdb = r;
          if (live()) render(state), reflow();
        })
      : Promise.resolve();
    const rtP = ask({ type: 'rt', ...msgBase }).then((r) => {
      state.rt = r;
      if (live()) render(state), reflow();
    });
    const pgP =
      lb.imdbId && showPG
        ? ask({ type: 'pg', ...msgBase }).then((r) => {
            state.pg = r;
            if (live()) render(state), reflow();
          })
        : Promise.resolve();
    await Promise.all([imdbP, rtP, pgP]);
  }

  // ---------- rendering ----------

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function fmtCount(n) {
    if (!n) return '';
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
    return String(n);
  }

  const spinner = () => h('span', { class: 'lbr-spin', 'aria-label': 'Loading' });
  const muted = (t) => h('span', { class: 'lbr-muted' }, t);

  function row(logo, name, url, value, sub) {
    return h(
      'a',
      { class: 'lbr-row', href: url, target: '_blank', rel: 'noopener noreferrer' },
      logo,
      h('span', { class: 'lbr-name' }, name),
      h('span', { class: 'lbr-value' }, value),
      sub ? h('span', { class: 'lbr-sub' }, sub) : null
    );
  }

  const logoLB = () =>
    h('span', { class: 'lbr-logo lbr-logo-lb' }, h('i'), h('i'), h('i'));
  const logoIMDb = () => h('span', { class: 'lbr-logo lbr-logo-imdb' }, 'IMDb');
  function logoRT(score, certified) {
    let cls = 'lbr-logo lbr-logo-rt';
    if (score == null) cls += ' lbr-rt-none';
    else if (score < 60) cls += ' lbr-rt-rotten';
    else if (certified) cls += ' lbr-rt-certified';
    return h('span', { class: cls });
  }
  function logoPop(score) {
    let cls = 'lbr-logo lbr-logo-pop';
    if (score == null) cls += ' lbr-rt-none';
    else if (score < 60) cls += ' lbr-pop-stale';
    return h('span', { class: cls });
  }

  function render(state) {
    const { slug, lb, imdb, rt } = state;
    const body = [];

    if (state.error) {
      body.push(
        h('div', { class: 'lbr-head' }, h('div', { class: 'lbr-title' }, slug.replace(/-/g, ' '))),
        h('div', { class: 'lbr-error' }, `Couldn't load ratings (${state.error})`)
      );
      card.replaceChildren(...body);
      return;
    }

    if (!lb) {
      body.push(
        h('div', { class: 'lbr-head' }, h('div', { class: 'lbr-title lbr-muted' }, slug.replace(/-/g, ' '))),
        h('div', { class: 'lbr-rows' }, h('div', { class: 'lbr-loading' }, spinner(), ' Loading ratings…'))
      );
      card.replaceChildren(...body);
      return;
    }

    body.push(
      h(
        'div',
        { class: 'lbr-head' },
        lb.poster ? h('img', { class: 'lbr-poster', src: lb.poster, alt: '' }) : null,
        h(
          'div',
          { class: 'lbr-head-text' },
          h('div', { class: 'lbr-title' }, lb.title, lb.year ? h('span', { class: 'lbr-year' }, ` ${lb.year}`) : null),
          lb.directors.length ? h('div', { class: 'lbr-dir' }, `Directed by ${lb.directors.slice(0, 2).join(', ')}`) : null
        )
      )
    );

    if (lb.description) body.push(renderPlot(state));
    if (lb.cast?.length) body.push(renderCast(state));

    const rows = [];

    // Letterboxd
    rows.push(
      row(
        logoLB(),
        'Letterboxd',
        lb.url,
        lb.rating != null
          ? h('span', {}, h('b', {}, lb.rating.toFixed(2)), muted(' / 5'))
          : muted('Not enough ratings'),
        lb.ratingCount ? `${fmtCount(lb.ratingCount)} ratings` : null
      )
    );

    // IMDb
    const imdbUrl = lb.imdbId ? `https://www.imdb.com/title/${lb.imdbId}/` : `https://www.imdb.com/find/?q=${encodeURIComponent(lb.title)}`;
    let imdbVal;
    let imdbSub = null;
    if (!imdb) imdbVal = spinner();
    else if (imdb.ok) {
      imdbVal = h('span', {}, h('b', {}, imdb.rating.toFixed(1)), muted(' / 10'));
      imdbSub = imdb.votes ? `${fmtCount(imdb.votes)} votes` : null;
    } else if (imdb.reason === 'noid') imdbVal = muted('Not linked');
    else if (imdb.reason === 'notfound') imdbVal = muted('No rating yet');
    else if (imdb.reason === 'blocked') {
      imdbVal = muted('Unavailable');
      imdbSub = 'Add an OMDb key in settings';
    } else imdbVal = muted('Unavailable');
    rows.push(row(logoIMDb(), 'IMDb', imdbUrl, imdbVal, imdbSub));

    // Rotten Tomatoes
    const rtUrl = rt?.url || `https://www.rottentomatoes.com/search?search=${encodeURIComponent(lb.title)}`;
    if (!rt) {
      rows.push(row(logoRT(null), 'Tomatometer', rtUrl, spinner()));
      rows.push(row(logoPop(null), 'Popcornmeter', rtUrl, spinner()));
    } else if (!rt.ok) {
      rows.push(row(logoRT(null), 'Rotten Tomatoes', rtUrl, muted(rt.reason === 'notfound' ? 'Not found' : 'Unavailable')));
    } else {
      rows.push(
        row(
          logoRT(rt.critics, rt.criticsCertified),
          'Tomatometer',
          rtUrl,
          rt.critics != null ? h('b', {}, `${rt.critics}%`) : muted('No score yet'),
          rt.criticsCount ? `${rt.criticsCount} reviews` : null
        )
      );
      if (rt.source !== 'omdb') {
        rows.push(
          row(
            logoPop(rt.audience),
            'Popcornmeter',
            rtUrl,
            rt.audience != null ? h('b', {}, `${rt.audience}%`) : muted('No score yet'),
            rt.audienceCount || null
          )
        );
      }
    }

    body.push(h('div', { class: 'lbr-rows' }, rows));
    if (state.wantPG && lb.imdbId) body.push(renderPG(state));
    card.replaceChildren(...body);
  }

  // ---------- plot ----------

  function renderPlot(state) {
    const text = decodeHtml(state.lb.description);
    const open = !!state.plotOpen;
    return h(
      'div',
      { class: 'lbr-plot' },
      h(
        'button',
        { type: 'button', class: `lbr-pg-row${open ? ' lbr-open' : ''}`, 'data-plot': '1', 'aria-expanded': String(open) },
        h('span', { class: 'lbr-caret' }),
        h('span', { class: 'lbr-plot-label' }, 'Plot'),
        open ? null : h('span', { class: 'lbr-plot-preview' }, text)
      ),
      open ? h('div', { class: 'lbr-pg-details lbr-plot-text' }, text) : null
    );
  }

  // ---------- cast ----------

  function renderCast(state) {
    const { cast, castTotal, url } = state.lb;
    const open = !!state.castOpen;
    const more = Math.max(0, (castTotal || 0) - cast.length);
    return h(
      'div',
      { class: 'lbr-plot' },
      h(
        'button',
        { type: 'button', class: `lbr-pg-row${open ? ' lbr-open' : ''}`, 'data-cast': '1', 'aria-expanded': String(open) },
        h('span', { class: 'lbr-caret' }),
        h('span', { class: 'lbr-plot-label' }, 'Cast'),
        open ? null : h('span', { class: 'lbr-plot-preview' }, cast.slice(0, 4).map((c) => c.name).join(', '))
      ),
      open
        ? h(
            'div',
            { class: 'lbr-pg-details lbr-cast' },
            cast.map((c) =>
              h(
                c.url ? 'a' : 'div',
                { class: 'lbr-cast-row', href: c.url || null, target: c.url ? '_blank' : null, rel: c.url ? 'noopener noreferrer' : null },
                h('span', { class: 'lbr-cast-name' }, c.name),
                c.role ? h('span', { class: 'lbr-cast-role', title: c.role }, c.role) : null
              )
            ),
            more
              ? h(
                  'a',
                  { class: 'lbr-pg-spoil', href: `${url}cast/`, target: '_blank', rel: 'noopener noreferrer' },
                  `+ ${more} more on Letterboxd ↗`
                )
              : null
          )
        : null
    );
  }

  // ---------- parents guide ----------

  function decodeHtml(s) {
    // Guide entries come as small HTML snippets (entities, <br>, links). Parse inertly, keep text.
    return new DOMParser().parseFromString(String(s).replace(/<br\s*\/?>/gi, '\n'), 'text/html').body.textContent.trim();
  }

  function renderPG(state) {
    const { pg, lb } = state;
    const url = pg?.url || `https://www.imdb.com/title/${lb.imdbId}/parentalguide/`;
    const head = h(
      'div',
      { class: 'lbr-pg-head' },
      h('span', { class: 'lbr-pg-title' }, 'Parents guide'),
      pg?.ok && pg.rating ? h('span', { class: 'lbr-cert', title: pg.ratingBody || '' }, pg.rating) : null,
      h('a', { class: 'lbr-pg-link', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'IMDb ↗')
    );
    const parts = [head];
    if (!pg) {
      parts.push(h('div', { class: 'lbr-loading' }, spinner()));
    } else if (!pg.ok) {
      parts.push(
        muted(pg.reason === 'notfound' ? 'No parents guide on IMDb yet' : pg.reason === 'blocked' ? 'IMDb blocked the request. Open it on IMDb' : 'Unavailable')
      );
    } else {
      if (pg.ratingReason) parts.push(h('div', { class: 'lbr-pg-reason' }, pg.ratingReason));
      for (const c of pg.categories) {
        const open = state.open === c.id;
        const sev = c.severity ? c.severity.toLowerCase() : 'na';
        parts.push(
          h(
            'button',
            {
              type: 'button',
              class: `lbr-pg-row${open ? ' lbr-open' : ''}`,
              'data-pg': c.id,
              'aria-expanded': String(open),
              title: c.fullTitle,
            },
            h('span', { class: 'lbr-caret' }),
            h('span', { class: 'lbr-pg-name' }, c.title),
            h('span', { class: `lbr-sev lbr-sev-${sev}` }, c.severity || 'No votes')
          )
        );
        if (open) {
          const items = c.items.map(decodeHtml).filter(Boolean);
          parts.push(
            h(
              'div',
              { class: 'lbr-pg-details' },
              c.totalVotes
                ? h('div', { class: 'lbr-pg-votes' }, `${c.votes.toLocaleString()} of ${c.totalVotes.toLocaleString()} voters said “${c.severity}”`)
                : null,
              items.length ? h('ul', {}, items.map((t) => h('li', {}, t))) : muted('No details submitted.'),
              c.more || c.spoilers
                ? h(
                    'a',
                    { class: 'lbr-pg-spoil', href: url, target: '_blank', rel: 'noopener noreferrer' },
                    '+ ' +
                      [
                        c.more ? `${c.more} more` : '',
                        c.spoilers ? `${c.spoilers} spoiler ${c.spoilers === 1 ? 'entry' : 'entries'}` : '',
                      ]
                        .filter(Boolean)
                        .join(', ') +
                      ' on IMDb ↗'
                  )
                : null
            )
          );
        }
      }
    }
    return h('div', { class: 'lbr-pg' }, parts);
  }
})();
