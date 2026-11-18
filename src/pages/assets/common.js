'use strict';

/**
 * Shared helpers for Swiftly's internal pages.
 */

const api = window.swiftly;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Stable colour for a tile/letter avatar. */
function colorFor(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  return `hsl(${hash}, 52%, 46%)`;
}

/** Build a favicon element that falls back to a coloured letter. */
function faviconNode(url, size = 18) {
  const host = hostOf(url);
  const wrap = el('span', 'list-icon');
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  wrap.style.flexBasis = `${size}px`;
  if (host) {
    const image = el('img');
    image.src = `https://${host}/favicon.ico`;
    image.alt = '';
    image.addEventListener('error', () => {
      image.remove();
      wrap.textContent = host.charAt(0).toUpperCase();
      wrap.style.background = colorFor(host);
      wrap.style.color = '#fff';
      wrap.style.fontWeight = '700';
      wrap.style.fontSize = '11px';
    });
    wrap.appendChild(image);
  }
  return wrap;
}

/** Human-friendly relative time. */
function relativeTime(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.floor(days)}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Navigate the tab this page lives in. */
function go(url) {
  api.tabs.navigate(api.currentTabId || null, url);
}

/** Open a URL in a new tab. */
function openInNewTab(url) {
  api.tabs.create(url);
}

/** Shared empty-state block. */
function emptyState(message, icon = 'search') {
  const wrap = el('div', 'empty');
  const paths = {
    search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
    clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.2v4l2.6 1.6"/>',
    star: '<path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
    down: '<path d="M8 2v8m0 0L5 7m3 3l3-3"/><path d="M2.5 12.5h11"/>',
  };
  wrap.innerHTML = `<svg viewBox="0 0 16 16">${paths[icon] || paths.search}</svg><p></p>`;
  wrap.querySelector('p').textContent = message;
  return wrap;
}

/** Apply the user's theme preference to this page. */
async function applyTheme() {
  const prefs = await api.prefs.get();
  let theme = null;
  try {
    const catalog = await api.store.catalog();
    theme = (catalog.themes || []).find((item) => item.id === (prefs.activeTheme || 'default'));
  } catch {
    theme = null;
  }
  if (theme && theme.vars) {
    const requestedMode = prefs.theme || 'system';
    const mode = requestedMode === 'system' ? null : requestedMode;
    const effectiveMode = mode
      || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const paletteMatchesMode = effectiveMode === theme.mode;
    const modeIndependentVars = new Set(['--accent', '--accent-soft', '--accent-text', '--danger']);

    for (const [key, value] of Object.entries(theme.vars)) {
      if (paletteMatchesMode || modeIndependentVars.has(key)) {
        document.documentElement.style.setProperty(key, value);
      } else {
        document.documentElement.style.removeProperty(key);
      }
    }
    if (mode) {
      document.documentElement.dataset.theme = mode;
      document.documentElement.style.colorScheme = mode;
      document.documentElement.style.setProperty('--logo-filter', mode === 'dark' ? 'invert(1)' : 'none');
    } else {
      delete document.documentElement.dataset.theme;
      document.documentElement.style.colorScheme = 'light dark';
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.style.setProperty('--logo-filter', prefersDark ? 'invert(1)' : 'none');
    }
  } else {
    if (prefs.theme && prefs.theme !== 'system') {
      document.documentElement.dataset.theme = prefs.theme;
      document.documentElement.style.colorScheme = prefs.theme;
      document.documentElement.style.setProperty('--logo-filter', prefs.theme === 'dark' ? 'invert(1)' : 'none');
    } else {
      delete document.documentElement.dataset.theme;
      document.documentElement.style.colorScheme = 'light dark';
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.style.setProperty('--logo-filter', prefersDark ? 'invert(1)' : 'none');
    }
  }
}

window.swiftlyPage = { el, hostOf, colorFor, faviconNode, relativeTime, formatBytes, go, openInNewTab, emptyState, applyTheme };
