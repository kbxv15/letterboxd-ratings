const $ = (id) => document.getElementById(id);
const status = (t) => {
  $('status').textContent = t;
  setTimeout(() => ($('status').textContent = ''), 1800);
};

chrome.storage.sync.get(['omdbKey', 'hoverDelay', 'showPG']).then(({ omdbKey = '', hoverDelay = 350, showPG = true }) => {
  $('omdbKey').value = omdbKey;
  $('showPG').checked = showPG;
  $('hoverDelay').value = hoverDelay;
});

$('save').addEventListener('click', async () => {
  const delay = Math.max(0, Math.min(2000, parseInt($('hoverDelay').value, 10) || 0));
  await chrome.storage.sync.set({ omdbKey: $('omdbKey').value.trim(), hoverDelay: delay, showPG: $('showPG').checked });
  // Previous IMDb/RT failures may succeed with a new key.
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => /^(imdb|rt|pg):/.test(k) && !all[k].data?.ok);
  if (stale.length) await chrome.storage.local.remove(stale);
  status('Saved');
});

$('clear').addEventListener('click', async () => {
  await chrome.storage.local.clear();
  status('Cache cleared');
});
