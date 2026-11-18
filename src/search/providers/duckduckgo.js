'use strict';

/**
 * DuckDuckGo HTML provider (failover).
 *
 * DuckDuckGo is unreachable from some networks (including the one Swiftly was
 * first built on) but works well elsewhere, so it stays in the rotation. The
 * lite endpoint is used as it is much lighter on bandwidth.
 */

const { get } = require('../http');
const { cleanText, absoluteUrl } = require('../html');
const { makeResult, dedupe } = require('./common');

const ENDPOINTS = [
  'https://lite.duckduckgo.com/lite/',
  'https://html.duckduckgo.com/html/',
];

async function search(query, { limit = 20, safeSearch = 'moderate', region = 'en-US', signal } = {}) {
  // DuckDuckGo expects "country-language" (us-en), while Swiftly stores the
  // BCP-47 form (en-US).
  const [language, country] = String(region || 'en-US').split('-');
  const ddgRegion = country ? `${country.toLowerCase()}-${language.toLowerCase()}` : 'wt-wt';
  const params = new URLSearchParams({
    q: query,
    kl: ddgRegion,
    kp: safeSearch === 'strict' ? '1' : safeSearch === 'off' ? '-2' : '-1',
  });

  let lastError = null;
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await get(`${endpoint}?${params.toString()}`, {
        timeout: 10000,
        retries: 0,
        signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: 'https://duckduckgo.com/',
        },
      });

      const html = response.body;
      const results = [];

      // Classic HTML layout: <a class="result__a" href="...">Title</a>
      // followed by <a class="result__snippet">...</a>
      const linkRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m;
      while ((m = linkRe.exec(html)) !== null && results.length < limit) {
        const snippetMatch = /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(
          html.slice(m.index, m.index + 2000),
        );
        const result = makeResult({
          title: cleanText(m[2]),
          url: absoluteUrl(m[1], 'https://duckduckgo.com'),
          snippet: snippetMatch ? cleanText(snippetMatch[1]) : '',
          provider: 'duckduckgo',
          baseUrl: 'https://duckduckgo.com',
        });
        if (result.url) results.push(result);
      }

      if (results.length) {
        return { provider: 'duckduckgo', results: dedupe(results), related: [] };
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('DuckDuckGo returned no results');
}

module.exports = { search, name: 'DuckDuckGo', id: 'duckduckgo' };
