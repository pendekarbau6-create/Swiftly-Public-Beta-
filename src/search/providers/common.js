'use strict';

/**
 * Shared helpers for result providers.
 */

const { cleanText, cleanAttr, absoluteUrl, unwrapRedirect, hostOf, prettyUrl } = require('../html');

/** Build a normalised result row from a provider's raw extraction. */
function makeResult({ title, url, snippet, displayUrl, date, provider, baseUrl }) {
  const clean = {
    title: cleanText(title).slice(0, 300),
    url: unwrapRedirect(url),
    snippet: cleanText(snippet).slice(0, 600),
    displayUrl: '',
    date: cleanText(date).slice(0, 120),
    provider,
  };

  if (!/^https?:\/\//i.test(clean.url)) {
    // Resolve relative links against the provider that produced them, not a
    // hard-coded engine, so failover providers keep working.
    const absolute = absoluteUrl(clean.url, baseUrl || 'https://www.bing.com');
    clean.url = /^https?:\/\//i.test(absolute) ? absolute : '';
  }

  if (displayUrl) {
    clean.displayUrl = cleanText(displayUrl);
  } else {
    clean.displayUrl = prettyUrl(clean.url);
  }

  if (!clean.title && clean.url) {
    clean.title = hostOf(clean.url);
  }
  if (!clean.snippet) {
    clean.snippet = '';
  }

  return clean;
}

/** Icon URL for a result — we prefer the site's own favicon, privacy first. */
function faviconFor(url) {
  const host = hostOf(url);
  if (!host) return '';
  return `https://${host}/favicon.ico`;
}

/** Remove results that are not real web pages (engine redirects, internal links). */
function isUsable(result) {
  if (!result || !result.url) return false;
  if (!/^https?:\/\//i.test(result.url)) return false;
  if (!result.title && !result.snippet) return false;
  try {
    const parsed = new URL(result.url);
    const host = parsed.hostname;
    // Only the search engine's own result-wrapper links are noise. A page
    // that genuinely lives on bing.com is a valid result for other providers.
    if (/(^|\.)bing\.com$/i.test(host) && /^\/(ck|search|images|videos|maps)\b/i.test(parsed.pathname)) {
      return false;
    }
    if (/(^|\.)microsoft\.com$/i.test(host) && /translator/.test(result.url)) return false;
    if (/(^|\.)startpage\.com$/i.test(host) && /^\/(sp\/)?(do|search)\b/i.test(parsed.pathname)) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

/** Tracking parameters that never change which page is shown. */
const TRACKING_PARAMS = /^(utm_|gclid$|fbclid$|msclkid$|mc_eid$|mc_cid$|ref_src$|ref$|si$|spm$|igshid$|_ga$)/i;

/** A dedupe key that ignores tracking noise, so the same page appears once. */
function dedupeKey(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
    }
    parsed.hash = '';
    const host = parsed.hostname.replace(/^www\./, '');
    const query = parsed.searchParams.toString();
    return `${host}${parsed.pathname.replace(/\/$/, '')}${query ? `?${query}` : ''}`;
  } catch {
    return url;
  }
}

/** Deduplicate results by URL while preserving order. */
function dedupe(results) {
  const seen = new Set();
  const out = [];
  for (const result of results) {
    if (!isUsable(result)) continue;
    const key = dedupeKey(result.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
  }
  return out;
}

/** Read an attribute from an opening tag fragment. */
function attr(fragment, name) {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i');
  const single = new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i');
  const m = re.exec(fragment) || single.exec(fragment);
  return m ? cleanAttr(m[1]) : '';
}

/**
 * Marker phrases engines use when a query legitimately has no results.
 * A page that renders without one of these *and* yields no parsed results
 * means the layout changed or we were served a JavaScript-only shell.
 */
const NO_RESULTS_MARKERS = [
  'there are no results', 'no results found', 'did not match any',
  'check your spelling', 'try different keywords', 'no se encontraron',
];

/** Does this page explicitly say there is nothing to find? */
function saysNoResults(html) {
  const head = html.slice(0, 20000).toLowerCase();
  return NO_RESULTS_MARKERS.some((marker) => head.includes(marker));
}

module.exports = {
  makeResult,
  faviconFor,
  isUsable,
  dedupe,
  dedupeKey,
  attr,
  saysNoResults,
};
