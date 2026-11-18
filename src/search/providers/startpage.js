'use strict';

/**
 * Startpage web results provider (failover).
 *
 * Startpage sits behind an "Anubis" proof-of-work challenge on some networks;
 * when that fires the request raises a blocked error and the engine moves on
 * to the next provider.
 */

const { get } = require('../http');
const { cleanText } = require('../html');
const { makeResult, dedupe, saysNoResults } = require('./common');

const ENDPOINT = 'https://www.startpage.com/sp/search';

async function search(query, { limit = 20, safeSearch = 'moderate', region = 'en-US', signal } = {}) {
  const params = new URLSearchParams({
    query,
    language: region.split('-')[0],
    cat: 'web',
    safesearch: safeSearch === 'strict' ? 'strict' : safeSearch === 'off' ? 'off' : 'moderate',
  });

  const response = await get(`${ENDPOINT}?${params.toString()}`, {
    timeout: 12000,
    retries: 1,
    signal,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: 'https://www.startpage.com/',
    },
  });

  const html = response.body;
  const results = [];

  // Startpage renders each result as <div class="w-gl__result"> with a
  // <a class="w-gl__result-title"> link and a <p class="w-gl__result-description">.
  const blocks = html.split(/<div class="w-gl__result"/g);
  blocks.shift();

  for (const block of blocks) {
    const cut = block.split(/<div class="w-gl__result"/i)[0];
    const link = /<a\b[^>]*class="[^"]*w-gl__result-title[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(cut)
      || /<a\b[^>]*href="([^"]+)"[^>]*class="[^"]*w-gl__result-title[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(cut);
    if (!link) continue;

    const desc = /<p\b[^>]*class="[^"]*w-gl__result-description[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(cut);
    const cite = /<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(cut);

    const result = makeResult({
      title: cleanText(link[2]),
      url: link[1],
      snippet: desc ? cleanText(desc[1]) : '',
      displayUrl: cite ? cleanText(cite[1]) : '',
      provider: 'startpage',
      baseUrl: 'https://www.startpage.com',
    });

    if (result.url) results.push(result);
    if (results.length >= limit) break;
  }

  if (!results.length && !saysNoResults(html)) {
    throw new Error('Startpage returned no parseable results');
  }

  return { provider: 'startpage', results: dedupe(results), related: [] };
}

module.exports = { search, name: 'Startpage', id: 'startpage' };
