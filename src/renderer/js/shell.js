'use strict';

/**
 * Swiftly shell — tab strip, address bar, suggestions and the window menu.
 *
 * The shell owns no page state; it renders what the main process tells it and
 * sends intents back. The active tab id is the only piece of state kept here.
 */

const api = window.swiftly;

const state = {
  tabs: [],
  activeTabId: null,
  suggestions: [],
  suggestionText: '',
  editing: false,
  findMatches: 0,
  prefs: {},
  bookmarks: [],
  zoomLevel: 0,
};

/* ------------------------------------------------------------------ util */

const $ = (selector) => document.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A readable label for the current page. */
function displayFor(url, { full = false } = {}) {
  if (!url) return '';
  if (url.startsWith('swifty://search')) {
    try {
      const query = new URL(url).searchParams.get('q') || '';
      return query || 'Swiftly Search';
    } catch {
      return 'Swiftly Search';
    }
  }
  if (url.startsWith('swifty://')) {
    const page = url.replace('swifty://', '').replace(/\/$/, '');
    const labels = {
      start: 'Swiftly',
      history: 'History',
      bookmarks: 'Bookmarks',
      downloads: 'Downloads',
      settings: 'Settings',
      account: 'Swiftly account',
       store: 'Swiftly Store',
    };
    return labels[page] || page;
  }
  try {
    const parsed = new URL(url);
    // Prefer the origin as-is for non-http schemes (data:, blob:, …).
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url;
    if (full) return url;
    const path = parsed.pathname.replace(/\/$/, '');
    return `${parsed.hostname.replace(/^www\./, '')}${path && path !== '/' ? path : ''}`;
  } catch {
    return url;
  }
}

/** Is this text a URL rather than a search term? */
function looksLikeUrl(text) {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return true;
  if (/^(about|data|swifty):/i.test(trimmed)) return true;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed)) return true;
  return /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(trimmed);
}

/** A stable colour for a favicon fallback letter. */
function letterColor(host) {
  let hash = 0;
  for (let i = 0; i < host.length; i += 1) {
    hash = (hash * 31 + host.charCodeAt(i)) % 360;
  }
  return `hsl(${hash}, 52%, 46%)`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/* ---------------------------------------------------------------- toasts */

/** A brief, self-dismissing message in the corner of the window. */
function showToast(message, { tone = 'ok', action = null, actionLabel = '' } = {}) {
  if (!message) return;
  const stack = $('#toasts');
  const node = el('div', 'toast');
  if (tone === 'warn') node.classList.add('warn');
  node.appendChild(el('span', null, message));

  if (action) {
    const button = el('button', 'toast-action', actionLabel || 'View');
    button.type = 'button';
    button.addEventListener('click', () => {
      action();
      dismissToast(node);
    });
    node.appendChild(button);
  }

  stack.appendChild(node);
  // Keep at most three messages so a burst of events cannot stack up.
  while (stack.children.length > 3) dismissToast(stack.firstChild);
  const dismissTimer = setTimeout(() => dismissToast(node), 6000);
  node._dismissTimer = dismissTimer;
}

/* ----------------------------------------------------------------- toasts dismiss */
function dismissToast(node) {
  if (!node || !node.parentNode) return;
  if (node._dismissTimer) { clearTimeout(node._dismissTimer); node._dismissTimer = null; }
  if (node.classList.contains('toast-leaving')) return;
  node.classList.add('toast-leaving');
  let done = false;
  const finish = () => { if (done) return; done = true; node.remove(); };
  node.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 260);
}

/* ------------------------------------------------------------------ zoom */

function applyZoom(level) {
  state.zoomLevel = Number(level) || 0;
  const indicator = $('#zoom-indicator');
  const percent = Math.round(100 * 1.2 ** state.zoomLevel);
  indicator.hidden = Math.abs(state.zoomLevel) < 0.01;
  indicator.textContent = `${percent}%`;
}

let themeCatalogCache = null;
async function themeCatalog() {
  if (themeCatalogCache) return themeCatalogCache;
  try {
    themeCatalogCache = await api.store.catalog();
  } catch {
    themeCatalogCache = { themes: [] };
  }
  return themeCatalogCache;
}

async function applyActiveTheme(activeThemeId) {
  const catalog = await themeCatalog();
  const theme = (catalog.themes || []).find((item) => item.id === (activeThemeId || 'default'))
    || (catalog.themes || []).find((item) => item.id === 'default');
  if (theme && theme.vars) {
    for (const [key, value] of Object.entries(theme.vars)) {
      document.documentElement.style.setProperty(key, value);
    }
    const mode = theme.mode === 'system' ? null : theme.mode;
    if (mode) {
      document.documentElement.dataset.theme = mode;
      document.documentElement.style.colorScheme = mode;
    } else {
      delete document.documentElement.dataset.theme;
      document.documentElement.style.colorScheme = 'light dark';
    }
  } else {
    if (state.prefs.theme && state.prefs.theme !== 'system') {
      document.documentElement.dataset.theme = state.prefs.theme;
      document.documentElement.style.colorScheme = state.prefs.theme;
    } else {
      delete document.documentElement.dataset.theme;
      document.documentElement.style.colorScheme = 'light dark';
    }
  }
  // Invalidate cache when searches change? keep.
}

/* ------------------------------------------------------------ tab strip */

function renderTabs() {
  const strip = $('#tabs');
  strip.textContent = '';

  for (const tab of state.tabs) {
    const node = el('div', 'tab');
    node.dataset.tabId = tab.id;
    node.setAttribute('role', 'tab');
    node.title = tab.title || tab.url;
    if (tab.id === state.activeTabId) {
      node.classList.add('active');
      node.setAttribute('aria-selected', 'true');
    }
    if (tab.loading) {
      node.classList.add('is-loading');
      const progress = el('span', 'tab-progress');
      progress.setAttribute('aria-hidden', 'true');
      node.appendChild(progress);
    }

    if (tab.loading) {
      node.appendChild(el('span', 'tab-spinner'));
    } else if (tab.favicon) {
      const image = el('img', 'tab-favicon');
      image.src = tab.favicon;
      image.alt = '';
      image.addEventListener('error', () => {
        image.remove();
        node.insertBefore(faviconFallback(tab), node.firstChild);
      });
      node.appendChild(image);
    } else {
      node.appendChild(faviconFallback(tab));
    }

    const title = el('span', 'tab-title', tab.title || displayFor(tab.url) || 'New Tab');
    node.appendChild(title);
    if (tab.hibernated) {
      node.classList.add('is-hibernated');
      node.title = `${tab.title || tab.url} — sleeping; select to reload`;
    }

    if (tab.muted || tab.audible) {
      const audio = el('button', 'tab-audio');
      audio.type = 'button';
      audio.title = tab.muted ? 'Unmute tab' : 'Mute tab';
      audio.setAttribute('aria-label', audio.title);
      audio.innerHTML = tab.muted
        ? '<svg viewBox="0 0 16 16"><path d="M3 6h2l3-2.5v9L5 10H3z"/><path d="M11 6.5l3 3M14 6.5l-3 3"/></svg>'
        : '<svg viewBox="0 0 16 16"><path d="M3 6h2l3-2.5v9L5 10H3z"/><path d="M11 6a3 3 0 0 1 0 4"/></svg>';
      audio.addEventListener('mousedown', (event) => event.stopPropagation());
      audio.addEventListener('click', (event) => {
        event.stopPropagation();
        api.tabs.mute(tab.id, !tab.muted);
      });
      node.appendChild(audio);
    }

    const close = el('button', 'tab-close');
    close.title = 'Close tab';
    close.setAttribute('aria-label', `Close ${tab.title || 'tab'}`);
    close.innerHTML = '<svg viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8"/></svg>';
    close.addEventListener('mousedown', (event) => event.stopPropagation());
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      api.tabs.close(tab.id);
    });
    node.appendChild(close);

    node.addEventListener('mousedown', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        api.tabs.close(tab.id);
        return;
      }
      if (event.button === 0) {
        // Don't activate (and re-render) when the click lands on a tab control.
        if (event.target && event.target.closest && event.target.closest('.tab-close, .tab-audio')) return;
        api.tabs.activate(tab.id);
      }
    });

    node.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      api.tabs.activate(tab.id);
      openTabMenu(tab);
    });

    node.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/swifty-tab', tab.id);
      event.dataTransfer.effectAllowed = 'move';
      node.classList.add('dragging');
    });
    node.addEventListener('dragend', () => node.classList.remove('dragging'));
    node.addEventListener('dragover', (event) => {
      event.preventDefault();
      node.classList.add('drop-target');
    });
    node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
    node.addEventListener('drop', (event) => {
      event.preventDefault();
      node.classList.remove('drop-target');
      const dragged = event.dataTransfer.getData('text/swifty-tab');
      if (!dragged) return;
      const index = state.tabs.findIndex((item) => item.id === tab.id);
      if (dragged !== tab.id) api.tabs.move(dragged, index);
    });

    strip.appendChild(node);
  }
}

function faviconFallback(tab) {
  const host = hostOf(tab.url) || 'S';
  const node = el('span', 'tab-favicon letter', host.charAt(0));
  node.style.background = letterColor(host);
  return node;
}

/* ----------------------------------------------------------- bookmark bar */

function renderBookmarkBar() {
  const bar = $('#bookmarkbar');
  const visible = Boolean(state.prefs.showBookmarkBar);
  bar.hidden = !visible;
  if (!visible) return;

  const list = $('#bookmarks');
  list.textContent = '';
  for (const bookmark of state.bookmarks) {
    const host = hostOf(bookmark.url);
    const node = el('button', 'bookmark');
    node.type = 'button';
    node.title = bookmark.title ? `${bookmark.title}\n${bookmark.url}` : bookmark.url;

    const icon = el('span', 'bookmark-icon');
    if (host) {
      const image = el('img');
      image.src = `https://${host}/favicon.ico`;
      image.alt = '';
      image.addEventListener('error', () => {
        image.remove();
        icon.textContent = host.charAt(0).toUpperCase();
        icon.style.background = letterColor(host);
      });
      icon.appendChild(image);
    } else {
      icon.textContent = '★';
      icon.style.background = letterColor(bookmark.url);
    }
    node.appendChild(icon);
    node.appendChild(el('span', 'bookmark-label', bookmark.title || bookmark.url));

    node.addEventListener('click', () => api.tabs.navigate(state.activeTabId, bookmark.url));
    node.addEventListener('auxclick', (event) => {
      if (event.button === 1) api.tabs.create(bookmark.url, { background: true });
    });
    list.appendChild(node);
  }
}

async function refreshBookmarks() {
  state.bookmarks = await api.bookmarks.list().catch(() => []);
  renderBookmarkBar();
  updateOmnibox();
}

/* --------------------------------------------------------- tab menu */

const TAB_MENU = [
  {
    label: 'New Tab to the Right',
    action: (tab) => api.tabs.create('', { background: true }),
  },
  { label: 'Duplicate Tab', action: (tab) => api.tabs.duplicate(tab.id) },
  { separator: true },
  {
    label: 'Reload Tab',
    action: (tab) => api.tabs.reload(tab.id),
  },
  { label: 'Speed Reader', action: (tab) => toggleReader(tab) },
  {
    label: 'Mute / Unmute Tab',
    action: (tab) => api.tabs.mute(tab.id, !tab.muted),
  },
  {
    label: 'Copy Page Address',
    action: (tab) => api.tabs.copyUrl(tab.url),
  },
  { separator: true },
  { label: 'Move Tab Left', action: (tab) => api.tabs.shift(tab.id, -1) },
  { label: 'Move Tab Right', action: (tab) => api.tabs.shift(tab.id, 1) },
  { separator: true },
  { label: 'Close Tab', action: (tab) => api.tabs.close(tab.id) },
  {
    label: 'Close Other Tabs',
    action: (tab) => {
      for (const other of state.tabs.filter((item) => item.id !== tab.id)) {
        api.tabs.close(other.id);
      }
    },
  },
];

function openTabMenu(tab) {
  pendingTabMenu = tab;
  api.popupMenu({
    kind: 'tab',
    items: TAB_MENU.map((item) => (item.separator ? { separator: true } : { label: item.label })),
  }).catch(() => {});
}

let pendingTabMenu = null;

/* ------------------------------------------------------------- omnibox */

const omnibox = $('#omnibox');
const input = $('#omnibox-input');

function activeTab() {
  return state.tabs.find((tab) => tab.id === state.activeTabId) || null;
}

function toggleReader(tab = activeTab()) {
  if (!tab) return;
  api.reader.toggle(tab.id).then((result) => {
    if (!result?.ok) {
      showToast(result?.error || 'Speed Reader is not available for this page.', { tone: 'warn' });
      return;
    }
    showToast(result.enabled ? 'Speed Reader opened' : 'Speed Reader closed');
  }).catch((error) => {
    showToast(error.message || 'Could not open Speed Reader.', { tone: 'warn' });
  });
}

function updateOmnibox() {
  const tab = activeTab();
  if (!tab) return;

  if (!state.editing) {
    input.value = displayFor(tab.url, { full: state.prefs.alwaysShowFullUrl });
  }

  $('#nav-back').disabled = !tab.canGoBack;
  $('#nav-forward').disabled = !tab.canGoForward;
  $('#nav-reload').classList.toggle('loading', Boolean(tab.loading));

  omnibox.dataset.state = omniboxState(tab.url);
  omnibox.title = omniboxState(tab.url) === 'insecure'
    ? 'Not secure — this page is served over plain HTTP'
    : '';

  const marked = state.bookmarks.some((item) => item.url === tab.url);
  $('#omnibox-star').classList.toggle('bookmarked', marked);
  $('#omnibox-star').title = marked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
  updateFeatureButtons(tab);
}

function updateFeatureButtons(tab = activeTab()) {
  const shield = $('#privacy-shield');
  const shieldEnabled = state.prefs.blockAdsAndTrackers !== false;
  shield.classList.toggle('is-enabled', shieldEnabled);
  shield.setAttribute('aria-pressed', String(shieldEnabled));
  shield.title = shieldEnabled
    ? 'Privacy Shield enabled — click to disable ad and tracker blocking'
    : 'Privacy Shield disabled — click to block known ads and trackers';

  const reader = $('#reader-button');
  reader.disabled = !tab || (!/^https?:/i.test(tab.url) && !tab.readerModeActive);
  reader.classList.toggle('is-enabled', Boolean(tab?.readerModeActive));
  reader.title = tab?.readerModeActive ? 'Close Speed Reader' : 'Open Speed Reader';
}

/** Which icon the omnibox shows: secure lock, plain search, or a warning. */
function omniboxState(url) {
  if (!url) return 'search';
  if (/^swifty:/i.test(url)) return 'search';
  if (/^http:\/\//i.test(url)) return 'insecure';
  if (/^https:\/\//i.test(url)) return 'url';
  return 'search';
}

let suggestTimer = null;
let suggestionRequest = 0;

function onInputChanged() {
  clearTimeout(suggestTimer);
  const request = ++suggestionRequest;
  const text = input.value.trim();
  if (text.length < 1) {
    hideSuggestions();
    return;
  }
  suggestTimer = setTimeout(() => loadSuggestions(text, request), 110);
}

async function loadSuggestions(text, request) {
  let items = [];

  try {
    const [remote, history, bookmarks] = await Promise.all([
      api.suggest(text).catch(() => []),
      api.history.list(text, 6).catch(() => []),
      api.bookmarks.list().catch(() => []),
    ]);

    const seen = new Set();
    const push = (item) => {
      const key = item.title.toLowerCase();
      if (!item.title || seen.has(key)) return;
      seen.add(key);
      items.push(item);
    };

    for (const bookmark of bookmarks) {
      if (bookmark.title.toLowerCase().includes(text.toLowerCase())
        || bookmark.url.toLowerCase().includes(text.toLowerCase())) {
        push({ title: bookmark.title, url: bookmark.url, kind: 'bookmark' });
      }
    }

    for (const entry of history) {
      if (entry.title.toLowerCase().includes(text.toLowerCase())
        || entry.url.toLowerCase().includes(text.toLowerCase())) {
        push({ title: entry.title, url: entry.url, kind: 'history' });
      }
    }

    for (const item of remote) push({ title: item.title, url: '', kind: 'suggestion' });
  } catch {
    /* suggestions are a nicety — never block navigation */
  }

  if (request !== suggestionRequest || input.value.trim() !== text || !state.editing) return;

  state.suggestions = items;
  state.suggestionText = text;
}

function showSuggestionsMenu() {
  const text = input.value.trim();
  if (!text) return;

  const suggestions = state.suggestionText === text ? state.suggestions : [];
  const rect = omnibox.getBoundingClientRect();
  const menuItems = suggestions.slice(0, 12).map((item) => {
    const title = item.title.length > 80 ? `${item.title.slice(0, 77)}…` : item.title;
    const destination = item.url ? ` — ${displayFor(item.url)}` : '';
    return { label: `${title}${destination}`, url: item.url, text: item.title };
  });
  if (menuItems.length) menuItems.push({ separator: true });
  menuItems.push({ label: `Search for “${text}”`, text });

  api.popupMenu({
    kind: 'suggestions',
    x: Math.round(rect.left),
    y: Math.round(rect.bottom),
    items: menuItems,
  }).then((shown) => {
    if (shown === true) omnibox.setAttribute('aria-expanded', 'true');
  }).catch(() => {});
}

function hideSuggestions() {
  omnibox.setAttribute('aria-expanded', 'false');
  state.suggestions = [];
  state.suggestionText = '';
}

/** Send the omnibox contents to the engine — as a URL or as a search. */
function navigate(text) {
  const value = (text || '').trim();
  if (!value) return;
  hideSuggestions();
  input.blur();

  if (looksLikeUrl(value)) {
    api.tabs.navigate(state.activeTabId, value);
  } else {
    api.tabs.navigate(state.activeTabId, `swifty://search?q=${encodeURIComponent(value)}`);
  }
}

/* --------------------------------------------------------------- events */

input.addEventListener('focus', () => {
  state.editing = true;
  omnibox.classList.add('focused');
  input.select();
});

input.addEventListener('blur', () => {
  state.editing = false;
  omnibox.classList.remove('focused');
  hideSuggestions();
  updateOmnibox();
});

input.addEventListener('input', onInputChanged);

input.addEventListener('keydown', (event) => {
  switch (event.key) {
    case 'Enter':
      event.preventDefault();
      navigate(input.value);
      break;
    case 'ArrowDown':
    case 'ArrowUp':
      event.preventDefault();
      showSuggestionsMenu();
      break;
    case 'Escape':
      event.preventDefault();
      input.blur();
      break;
    default:
      break;
  }
});

$('#nav-back').addEventListener('click', () => api.tabs.back(state.activeTabId));
$('#nav-forward').addEventListener('click', () => api.tabs.forward(state.activeTabId));
$('#nav-reload').addEventListener('click', () => api.tabs.reload(state.activeTabId));
$('#nav-home').addEventListener('click', () => api.tabs.navigate(state.activeTabId, state.prefs.homepage || 'swifty://start'));
$('#new-tab').addEventListener('click', () => api.tabs.create(''));

$('#win-minimize').addEventListener('click', () => api.window.minimize());
$('#win-close').addEventListener('click', () => api.window.close());
$('#win-maximize').addEventListener('click', async () => {
  const maximized = await api.window.maximize();
  const btn = $('#win-maximize');
  btn.title = maximized ? 'Restore' : 'Maximize';
  btn.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
  btn.innerHTML = maximized
    ? '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="2.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="2.5" y="4.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'
    : '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
});
$('#bookmarks-manage').addEventListener('click', () => api.tabs.navigate(state.activeTabId, 'swifty://bookmarks'));

$('#zoom-indicator').addEventListener('click', async () => {
  const level = await api.zoom.reset();
  applyZoom(level);
});

$('#omnibox-star').addEventListener('click', async () => {
  const tab = activeTab();
  if (!tab) return;
  const result = await api.bookmarks.toggle({ url: tab.url, title: tab.title });
  await refreshBookmarks();
  showToast(result?.bookmarked ? 'Bookmark added' : 'Bookmark removed');
});

$('#privacy-shield').addEventListener('click', async () => {
  state.prefs = await api.prefs.set(
    'blockAdsAndTrackers',
    state.prefs.blockAdsAndTrackers === false,
  );
  updateFeatureButtons();
});
$('#reader-button').addEventListener('click', () => toggleReader());

$('#omnibox-suggestions').addEventListener('click', () => {
  if (!state.editing) {
    input.focus();
    input.select();
  }
  showSuggestionsMenu();
});

/* ----------------------------------------------------------- find in page */

const findbar = $('#findbar');
const findInput = $('#find-input');

function openFind() {
  findbar.hidden = false;
  findInput.focus();
  findInput.select();
}

function closeFind() {
  findbar.hidden = true;
  findInput.value = '';
  state.findMatches = 0;
  $('#find-count').textContent = '';
  api.find.stop();
}

findInput.addEventListener('input', () => {
  const text = findInput.value;
  if (!text) {
    state.findMatches = 0;
    $('#find-count').textContent = '';
    api.find.stop();
    return;
  }
  api.find.start(text, true);
});

findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    api.find.next(findInput.value, event.shiftKey ? false : true);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeFind();
  }
});

$('#find-next').addEventListener('click', () => api.find.next(findInput.value, true));
$('#find-prev').addEventListener('click', () => api.find.next(findInput.value, false));
$('#find-close').addEventListener('click', closeFind);

api.on('swiftly:find-result', (payload) => {
  state.findMatches = payload.matches;
  $('#find-count').textContent = payload.matches
    ? `${payload.activeMatch}/${payload.matches}`
    : 'none';
});

/* ------------------------------------------------------------------ menu */

const MENU_ITEMS = [
  { label: 'New tab', hint: 'Ctrl+T', action: () => api.tabs.create('') },
  { label: 'New window', hint: 'Ctrl+N', action: () => api.window.new() },
  { label: 'Incognito window', hint: 'Ctrl+Shift+N', action: () => api.window.incognito() },
  { separator: true },
  { label: 'History', hint: 'Ctrl+H', action: () => api.tabs.navigate(state.activeTabId, 'swifty://history') },
  { label: 'Bookmarks', hint: 'Ctrl+Shift+O', action: () => api.tabs.navigate(state.activeTabId, 'swifty://bookmarks') },
  { label: 'Downloads', hint: 'Ctrl+J', action: () => api.tabs.navigate(state.activeTabId, 'swifty://downloads') },
  { separator: true },
  {
    label: 'Bookmarks bar',
    hint: 'Ctrl+Shift+B',
    action: () => api.prefs.set('showBookmarkBar', !state.prefs.showBookmarkBar),
  },
  { label: 'Zoom in', hint: 'Ctrl++', action: () => api.zoom.change(0.5).then(applyZoom) },
  { label: 'Zoom out', hint: 'Ctrl+-', action: () => api.zoom.change(-0.5).then(applyZoom) },
  { label: 'Actual size', hint: 'Ctrl+0', action: () => api.zoom.reset().then(applyZoom) },
  { separator: true },
  { label: 'Reopen closed tab', hint: 'Ctrl+Shift+T', action: () => api.tabs.reopenClosed() },
  { label: 'Find in page', hint: 'Ctrl+F', action: openFind },
  { label: 'Speed Reader', action: () => toggleReader() },
  {
    label: 'Toggle Privacy Shield',
    action: async () => {
      state.prefs = await api.prefs.set(
        'blockAdsAndTrackers',
        state.prefs.blockAdsAndTrackers === false,
      );
      updateFeatureButtons();
    },
  },
  {
    label: 'Toggle Native Shield (HTTPS-only)',
    action: async () => {
      state.prefs = await api.prefs.set('httpsOnly', !state.prefs.httpsOnly);
    },
  },
  { separator: true },
  { label: 'Swiftly account', action: () => api.tabs.navigate(state.activeTabId, 'swifty://account') },
  { label: 'Settings', hint: 'Ctrl+,', action: () => api.tabs.navigate(state.activeTabId, 'swifty://settings') },
   { label: 'Swiftly Store', action: () => api.tabs.navigate(state.activeTabId, 'swifty://store') },
  { separator: true },
  { label: 'Toggle theme', action: toggleTheme },
];

function toggleTheme() {
  const root = document.documentElement;
  const isDark = root.dataset.theme
    ? root.dataset.theme === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = isDark ? 'light' : 'dark';
  root.dataset.theme = next;
  api.prefs.set('theme', next);
}

$('#menu-button').addEventListener('click', (event) => {
  event.stopPropagation();
  const rect = $('#menu-button').getBoundingClientRect();
  const items = MENU_ITEMS.map((item) => item.separator
    ? { separator: true }
    : { label: item.hint ? `${item.label}    ${item.hint}` : item.label });
  api.popupMenu({
    kind: 'browser-menu',
    x: Math.round(rect.left),
    y: Math.round(rect.bottom),
    items,
  }).catch(() => {});
});

api.on('swiftly:menu-selected', ({ index, kind } = {}) => {
  if (kind === 'tab') {
    const entry = TAB_MENU[index];
    const tab = pendingTabMenu;
    pendingTabMenu = null;
    if (entry && !entry.separator && tab) entry.action(tab);
    return;
  }
  const item = MENU_ITEMS[index];
  if (item && !item.separator) item.action();
});

api.on('swiftly:menu-closed', ({ kind } = {}) => {
  if (kind === 'suggestions') hideSuggestions();
  if (kind === 'tab') pendingTabMenu = null;
});

/* ------------------------------------------------------- main -> shell */

api.on('swiftly:tabs-changed', (payload) => {
  state.tabs = payload.tabs;
  state.activeTabId = payload.activeTabId;
  renderTabs();
  updateOmnibox();
});

api.on('swiftly:tab-updated', (tab) => {
  const index = state.tabs.findIndex((item) => item.id === tab.id);
  if (index >= 0) {
    state.tabs[index] = tab;
    renderTabs();
  }
  if (tab.id === state.activeTabId) updateOmnibox();
});

api.on('swiftly:tab-activated', (tab) => {
  state.activeTabId = tab.id;
  renderTabs();
  updateOmnibox();
  updateFeatureButtons(tab);
});

api.on('swiftly:prefs-changed', (prefs) => {
  state.prefs = prefs;
  themeCatalogCache = null;
  applyActiveTheme(prefs.activeTheme);
  document.documentElement.dataset.fullUrl = String(Boolean(prefs.alwaysShowFullUrl));
  $('#tabstrip').classList.toggle('compact', Boolean(prefs.compactTabs));
  renderBookmarkBar();
  updateOmnibox();
  updateFeatureButtons();
  reportChromeHeight();
});

api.on('swiftly:toast', (payload = {}) => {
  if (payload.action === 'open-download' && payload.savePath) {
    showToast(payload.message, {
      tone: payload.tone,
      actionLabel: 'Open',
      action: () => api.downloads.open(payload.savePath),
    });
    return;
  }
  showToast(payload.message, { tone: payload.tone });
});

api.on('swiftly:zoom-changed', ({ level } = {}) => applyZoom(level));

api.on('swiftly:find-open', () => openFind());

api.on('swiftly:find-step', ({ forward } = {}) => {
  if (findbar.hidden) return;
  if (!findInput.value) return;
  api.find.next(findInput.value, forward !== false);
});

api.on('swiftly:focus-omnibox', () => {
  input.focus();
  input.select();
});

api.on('swiftly:bookmark-added', () => refreshBookmarks());

api.on('swiftly:incognito', () => {
  document.documentElement.dataset.incognito = 'true';
  const icon = $('#omnibox-icon');
  if (!icon.querySelector('.icon-private')) {
    icon.insertAdjacentHTML('afterbegin',
      '<svg class="icon-private" viewBox="0 0 16 16" aria-hidden="true">'
      + '<path d="M2.5 6.5h11l-1 4.5h-9z"/><path d="M5 6.5L6.6 3h2.8l1.6 3.5"/></svg>');
  }
  showToast('Incognito window — history and cookies stay out of this session');
});

/* ----------------------------------------------------------------- boot */

function reportChromeHeight() {
  const height = $('#chrome').getBoundingClientRect().height;
  api.setChromeHeight(Math.ceil(height));
}

window.addEventListener('resize', () => {
  reportChromeHeight();
});

(async function init() {
  const tabs = await api.tabs.state();
  state.tabs = tabs.tabs;
  state.activeTabId = tabs.activeTabId;
  renderTabs();

  state.prefs = await api.prefs.get().catch(() => ({}));
  await applyActiveTheme(state.prefs.activeTheme);
  $('#tabstrip').classList.toggle('compact', Boolean(state.prefs.compactTabs));

  await refreshBookmarks();
  updateOmnibox();
  reportChromeHeight();
  api.zoom.get().then(applyZoom).catch(() => {});

  // Run cinematic startup animation after everything is rendered
  runStartupAnimation();

  /*
   * Only shortcuts the application menu cannot express live here. Everything
   * else (Ctrl+T/W/D/F/L/R, zoom, bookmarks bar) is a menu accelerator, so
   * handling it here too would run the action twice.
   */
  document.addEventListener('keydown', (event) => {
    const accel = event.ctrlKey || event.metaKey;
    if (!accel) return;

    // Ctrl+Tab cycles tabs (Ctrl+Shift+Tab cycles backwards).
    if (event.key === 'Tab') {
      event.preventDefault();
      const list = state.tabs;
      if (list.length < 2) return;
      const current = list.findIndex((tab) => tab.id === state.activeTabId);
      const step = event.shiftKey ? -1 : 1;
      const next = list[(current + step + list.length) % list.length];
      api.tabs.activate(next.id);
      return;
    }

    // Ctrl+1..8 jump to a tab; Ctrl+9 jumps to the last one.
    if (/^[1-9]$/.test(event.key)) {
      const list = state.tabs;
      const index = event.key === '9' ? list.length - 1 : Number(event.key) - 1;
      const target = list[index];
      if (!target) return;
      event.preventDefault();
      api.tabs.activate(target.id);
    }
  });
})();

/* ---------------------------------------------------------- startup animation */

function runStartupAnimation() {
  const chrome = $('#chrome');
  const overlay = $('#startup-overlay');
  if (!chrome) return;

  // Set initial state for animation
  chrome.style.opacity = '0';
  chrome.style.transform = 'scale(0.98)';
  chrome.style.transition = 'opacity 350ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 350ms cubic-bezier(0.2, 0.8, 0.2, 1)';

  // Trigger reflow
  void chrome.offsetWidth;

  // Run the cinematic startup sequence
  chrome.style.opacity = '1';
  chrome.style.transform = 'scale(1)';

  // Hide overlay after animation completes
  if (overlay) {
    setTimeout(() => {
      overlay.classList.add('is-hidden');
    }, 450);
  }
}
