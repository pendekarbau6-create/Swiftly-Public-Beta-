'use strict';

/**
 * Brave Search provider (failover).
 *
 * Brave renders each web hit inside a `<div class="snippet" data-type="web">`
 * block. It rate-limits aggressively, so failures are expected and handled by
 * the engine's provider failover.
 */

const { get } = require('../http');
const { cleanText } = require('../html');
const { makeResult, dedupe, saysNoResults } = require('./common');

const ENDPOINT = 'https://search.brave.com/search';

async function search(query, { limit = 20, safeSearch = 'moderate', region = 'en-US', signal } = {}) {
  const params = new URLSearchParams({
    q: query,
    source: 'web',
    count: String(Math.min(limit, 20)),
    safesearch: safeSearch === 'strict' ? 'strict' : safeSearch === 'off' ? 'off' : 'moderate',
    country: region.split('-')[1] ? region.split('-')[1].toLowerCase() : 'us',
  });

  const response = await get(`${ENDPOINT}?${params.toString()}`, {
    timeout: 12000,
    retries: 1,
    signal,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: 'https://search.brave.com/',
    },
  });

  const html = response.body;
  const results = [];

  const blocks = html.split(/<div class="snippet[^"]*"[^>]*data-type="web"/g);
  blocks.shift();

  for (const block of blocks) {
    const cut = block.split(/<div class="snippet[^"]*"[^>]*data-type="/i)[0];
    const link = /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(cut);
    if (!link) continue;

    const desc = /<div class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(cut)
      || /<div class="snippet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(cut);

    const result = makeResult({
      title: cleanText(link[2]),
      url: link[1],
      snippet: desc ? cleanText(desc[1]) : '',
      provider: 'brave',
      baseUrl: 'https://search.brave.com',
    });

    if (result.url) results.push(result);
    if (results.length >= limit) break;
  }

  if (!results.length && !saysNoResults(html)) {
    throw new Error('Brave returned no parseable results');
  }

  return { provider: 'brave', results: dedupe(results), related: [] };
}

module.exports = { search, name: 'Brave Search', id: 'brave' };
