'use strict';

(() => {

/* Settings: preferences plus live search-provider health. */

const { el, applyTheme, go } = window.swiftlyPage;
const api = window.swiftly;

/** Selects whose value is a string saved verbatim. */
const SELECTS = ['theme', 'safeSearch', 'region'];

/** Switches, in the order they appear on the page. */
const SWITCHES = [
  'showBookmarkBar',
  'compactTabs',
  'showSuggestions',
  'restoreLastSession',
  'openInNewTab',
  'alwaysShowFullUrl',
  'smoothScrolling',
  'spellcheck',
  'askWhereToSave',
  'sendDoNotTrack',
  'blockThirdPartyCookies',
  'blockAdsAndTrackers',
  'httpsOnly',
  'clearOnExit',
  'hibernateTabs',
];

/** Text fields saved as typed. */
const TEXTS = ['homepage', 'downloadDirectory'];

let prefs = {};

function setSwitch(node, value) {
  node.setAttribute('aria-checked', String(Boolean(value)));
}

function zoomPercent(level) {
  return `${Math.round((1.2 ** Number(level || 0)) * 100)}%`;
}

function syncControls() {
  for (const key of SELECTS) {
    const node = document.getElementById(key);
    if (node) node.value = String(prefs[key]);
  }
  for (const key of SWITCHES) {
    const node = document.getElementById(key);
    if (node) setSwitch(node, prefs[key]);
  }
  for (const key of TEXTS) {
    const node = document.getElementById(key);
    if (node) node.value = String(prefs[key] || '');
  }
  const results = document.getElementById('resultsPerPage');
  if (results) results.value = String(prefs.resultsPerPage);
  const zoom = document.getElementById('zoomLevel');
  if (zoom) {
    zoom.value = String(prefs.zoomLevel || 0);
    document.getElementById('zoom-value').textContent = zoomPercent(prefs.zoomLevel);
  }
  const engine = document.getElementById('searchEngine');
  if (engine) engine.value = prefs.searchEngine || 'swifty';
}

/** Fill the search-engine select from the providers the app reports. */
async function fillSearchEngines() {
  const select = document.getElementById('searchEngine');
  select.textContent = '';

  const combined = document.createElement('option');
  combined.value = 'swifty';
  combined.textContent = 'Swiftly Search (combined)';
  select.appendChild(combined);

  let list = [];
  try {
    list = await api.searchProviders();
  } catch {
    list = [];
  }

  for (const provider of list) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.name || provider.id;
    select.appendChild(option);
  }

  // A stored engine that no provider claims still needs an option, otherwise
  // the select would silently fall back to the first entry.
  if (prefs.searchEngine && prefs.searchEngine !== 'swifty'
    && !list.some((provider) => provider.id === prefs.searchEngine)) {
    const option = document.createElement('option');
    option.value = prefs.searchEngine;
    option.textContent = prefs.searchEngine;
    select.appendChild(option);
  }

  select.value = prefs.searchEngine || 'swifty';
  select.addEventListener('change', async () => {
    prefs = await api.prefs.set('searchEngine', select.value);
    select.value = prefs.searchEngine;
  });
}

function bindControls() {
  for (const key of SELECTS) {
    const node = document.getElementById(key);
    if (!node) continue;
    node.addEventListener('change', async () => {
      prefs = await api.prefs.set(key, node.value);
      if (key === 'theme') await applyTheme();
    });
  }

  for (const key of SWITCHES) {
    const node = document.getElementById(key);
    if (!node) continue;
    node.addEventListener('click', async () => {
      const wanted = node.getAttribute('aria-checked') !== 'true';
      setSwitch(node, wanted);
      prefs = await api.prefs.set(key, wanted);
      // Reflect what was actually stored, in case the value was rejected.
      setSwitch(node, prefs[key]);
    });
  }

  for (const key of TEXTS) {
    const node = document.getElementById(key);
    if (!node) continue;
    const commit = async () => {
      if (node.value === String(prefs[key] || '')) return;
      prefs = await api.prefs.set(key, node.value.trim());
      node.value = String(prefs[key] || '');
    };
    node.addEventListener('change', commit);
    node.addEventListener('blur', commit);
  }

  const results = document.getElementById('resultsPerPage');
  results.addEventListener('change', async () => {
    prefs = await api.prefs.set('resultsPerPage', Number(results.value));
    results.value = String(prefs.resultsPerPage);
  });

  const zoom = document.getElementById('zoomLevel');
  const zoomValue = document.getElementById('zoom-value');
  zoom.addEventListener('input', () => {
    zoomValue.textContent = zoomPercent(zoom.value);
  });
  zoom.addEventListener('change', async () => {
    prefs = await api.prefs.set('zoomLevel', Number(zoom.value));
    zoom.value = String(prefs.zoomLevel);
    zoomValue.textContent = zoomPercent(prefs.zoomLevel);
  });

  document.getElementById('homepage-use-start').addEventListener('click', async () => {
    const node = document.getElementById('homepage');
    node.value = 'swifty://start';
    prefs = await api.prefs.set('homepage', node.value);
  });

  document.getElementById('choose-download').addEventListener('click', async () => {
    const folder = await api.downloads.chooseFolder();
    if (!folder) return;
    prefs = await api.prefs.set('downloadDirectory', folder);
    document.getElementById('downloadDirectory').value = String(prefs.downloadDirectory || '');
  });

  document.getElementById('reset-prefs').addEventListener('click', async () => {
    prefs = await api.prefs.reset();
    applyLocalTheme(prefs.theme);
    syncControls();
  });

  document.getElementById('clear-history').addEventListener('click', async () => {
    const button = document.getElementById('clear-history');
    await api.history.clear();
    button.textContent = 'Cleared';
    setTimeout(() => { button.textContent = 'Clear now'; }, 1600);
  });
}

async function renderProviders() {
  const box = document.getElementById('providers');
  box.textContent = '';

  let providers = [];
  try {
    providers = await api.searchStatus();
  } catch {
    providers = [];
  }

  if (!providers.length) {
    box.appendChild(el('div', 'status-row', 'No providers reported.'));
    return;
  }

  for (const provider of providers) {
    const row = el('div', 'status-row');
    const dot = el('span', 'status-dot');
    dot.classList.add(provider.coolingDown || provider.failures > 0 ? 'bad' : 'ok');
    row.appendChild(dot);

    const label = el('span', null, provider.name);
    row.appendChild(label);

    const detail = el('span', 'mono');
    if (provider.coolingDown) detail.textContent = 'temporarily unavailable';
    else if (provider.successes) detail.textContent = `${provider.successes} ok · ${provider.failures} failed`;
    else detail.textContent = provider.lastError || 'not used yet';
    row.appendChild(detail);

    box.appendChild(row);
  }
}

async function renderAccount() {
  const status = document.getElementById('account-status');
  const account = await api.accounts.current().catch(() => null);
  status.textContent = account ? `Signed in as ${account.email}` : 'No profile signed in';
}

document.getElementById('reset-session').addEventListener('click', async () => {
  await api.resetSearchSession();
  renderProviders();
});

document.getElementById('manage-account').addEventListener('click', () => go('swifty://account'));
document.getElementById('open-store').addEventListener('click', () => go('swifty://store'));
document.getElementById('view-history').addEventListener('click', () => go('swifty://history'));

api.appInfo().then((info) => {
  document.getElementById('about').textContent =
    `${info.name} ${info.version} · Electron ${info.electron} · Chromium ${info.chrome}`;
});

function reportPaintTiming() {
  const entry = performance.getEntriesByName('first-contentful-paint')[0];
  const status = document.getElementById('paint-status');
  if (!entry) {
    status.textContent = 'Paint timing unavailable';
    return;
  }
  const elapsed = Math.round(entry.startTime);
  status.textContent = `${elapsed} ms · ${elapsed < 50 ? 'within target' : 'over target'}`;
}

(async function init() {
  await applyTheme();
  prefs = await api.prefs.get();
  bindControls();
  await fillSearchEngines();
  syncControls();
  renderProviders();
  renderAccount();
  reportPaintTiming();
})();

})();
