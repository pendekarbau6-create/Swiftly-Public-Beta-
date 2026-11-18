'use strict';

/**
 * Shared utilities for Swiftly's main process and renderers.
 * Pure functions only â€” no Electron or Node I/O â€” so they can be
 * required from anywhere without side effects.
 */

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/** Escape a string for safe use inside a RegExp. */
function escapeRegExp(value) {
  return String(value).replace(ESCAPE_RE, '\\$&');
}

/** Turn a glob-ish pattern (with * wildcards) into a RegExp. */
function globToRegex(pattern) {
  const body = escapeRegExp(pattern).replace(/\*/g, '.*');
  return new RegExp(`^${body}$`, 'i');
}

/** Match a URL against a list of glob patterns. */
function matchesAny(url, patterns) {
  for (const pattern of patterns) {
    try {
      if (globToRegex(pattern).test(url)) return true;
    } catch {
      /* ignore malformed patterns */
    }
  }
  return false;
}

/** Extract the registrable domain (e.g. example.com) from a URL. */
function registrableDomain(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    return parts.slice(-2).join('.');
  } catch {
    return '';
  }
}

/** Clamp a number between min and max. */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/** Debounce a function call. */
function debounce(fn, delay) {
  let timer = null;
  return function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/** Throttle a function call. */
function throttle(fn, delay) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= delay) {
      last = now;
      fn.apply(this, args);
    }
  };
}

/** Deep-clone a JSON-safe value. */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Parse a query string into an object (last value wins). */
function parseQuery(query) {
  const out = {};
  if (!query) return out;
  const cleaned = query.startsWith('?') ? query.slice(1) : query;
  for (const pair of cleaned.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) {
      out[decodeURIComponent(pair)] = true;
    } else {
      out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
    }
  }
  return out;
}

/** Format bytes into a human-readable string. */
function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Human-friendly relative time. */
function relativeTime(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.max(0, (Date.now() - Number(timestamp)) / 1000);
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

module.exports = {
  escapeRegExp,
  globToRegex,
  matchesAny,
  registrableDomain,
  clamp,
  debounce,
  throttle,
  clone,
  parseQuery,
  formatBytes,
  relativeTime,
};
