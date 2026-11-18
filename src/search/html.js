'use strict';

/**
 * Minimal HTML helpers used by the search providers.
 * Deliberately dependency-free: the search engine must stay fast to boot.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', lsquo: '\u2018',
  rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', bull: '\u2022',
  middot: '\u00b7', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  deg: '\u00b0', plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7',
  frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be', eacute: '\u00e9',
  egrave: '\u00e8', agrave: '\u00e0', ccedil: '\u00e7', uuml: '\u00fc',
  ouml: '\u00f6', auml: '\u00e4', szlig: '\u00df', laquo: '\u00ab',
  raquo: '\u00bb', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5',
  cent: '\u00a2', sect: '\u00a7', para: '\u00b6', dagger: '\u2020',
  larr: '\u2190', rarr: '\u2192', harr: '\u2194', infin: '\u221e',
  ne: '\u2260', le: '\u2264', ge: '\u2265', minus: '\u2212',
};

/** Decode named and numeric (decimal + hex) HTML entities. */
function decodeEntities(input) {
  if (!input) return '';
  return String(input).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Remove every tag, keeping their text content. */
function stripTags(input) {
  if (!input) return '';
  return String(input)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ');
}

/** Normalise whitespace and decode entities — the standard tail of any scrape. */
function cleanText(input) {
  return decodeEntities(stripTags(input)).replace(/\s+/g, ' ').trim();
}

/** Collapse whitespace but keep entity decoding (for attribute-ish values). */
function cleanAttr(input) {
  return decodeEntities(input).replace(/\s+/g, ' ').trim();
}

/** Resolve a possibly relative href against a base URL. */
function absoluteUrl(href, base) {
  if (!href) return '';
  const raw = decodeEntities(href).trim();
  if (!raw) return '';
  try {
    return new URL(raw, base).toString();
  } catch {
    return '';
  }
}

/**
 * Unwrap redirect URLs used by search engines so the result points at the
 * real destination. Bing encodes the target in a base64url `u=` parameter
 * prefixed with "a1"; DuckDuckGo uses a percent-encoded `uddg=` parameter;
 * other engines simply redirect.
 */
function unwrapRedirect(href) {
  const url = decodeEntities(href || '').trim();
  if (!url) return '';

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  // DuckDuckGo (both /l/ and /l/?uddg=) wraps every outbound link.
  const uddg = parsed.searchParams.get('uddg');
  if (uddg) {
    try {
      const decoded = decodeURIComponent(uddg);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      /* fall through */
    }
  }

  // Google's /url?q= and Yahoo's /RU= forms.
  const google = parsed.searchParams.get('q') || parsed.searchParams.get('url');
  if (google && /^https?:\/\//i.test(google) && !/^https?:\/\/[^/]*google\./i.test(google)) {
    return google;
  }
  const yahoo = parsed.searchParams.get('RU');
  if (yahoo && /^https?:\/\//i.test(yahoo)) return yahoo;
  // Yahoo also embeds the target in its path: /RU=<encoded>/RK=2
  const yahooPath = /\/RU=([^/]+)/i.exec(parsed.pathname + parsed.search);
  if (yahooPath) {
    try {
      const decoded = decodeURIComponent(yahooPath[1]);
      if (/^https?:\/\//i.test(decoded)) return decoded;
    } catch {
      /* fall through */
    }
  }

  const isBing = /(^|\.)bing\.com$/i.test(parsed.hostname);
  if (isBing && parsed.pathname.startsWith('/ck/')) {
    const u = parsed.searchParams.get('u');
    if (u && u.startsWith('a1')) {
      const decoded = decodeBase64Url(u.slice(2));
      if (decoded && /^https?:\/\//i.test(decoded)) return decoded;
    }
  }

  return url;
}

/** Decode base64url without relying on Node's Buffer being present. */
function decodeBase64Url(value) {
  try {
    if (typeof Buffer !== 'undefined') {
      const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      return Buffer.from(padded, 'base64').toString('utf8');
    }
  } catch {
    /* fall through to manual decoding */
  }
  return '';
}

/** Extract the "display" URL (without protocol) for a result row. */
function prettyUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '');
    const path = parsed.pathname.replace(/\/$/, '');
    return path && path !== '/' ? `${host}${path}` : host;
  } catch {
    return url || '';
  }
}

/** Host portion of a URL, used for favicon resolution. */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** Find the first capture group of a regex, tolerating no match. */
function match1(re, text) {
  const m = re.exec(text || '');
  return m ? m[1] : '';
}

module.exports = {
  NAMED_ENTITIES,
  decodeEntities,
  stripTags,
  cleanText,
  cleanAttr,
  absoluteUrl,
  unwrapRedirect,
  prettyUrl,
  hostOf,
  match1,
};
