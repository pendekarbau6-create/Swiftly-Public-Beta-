'use strict';

/**
 * Search suggestions (omnibox autocomplete).
 *
 * Three independent sources are tried in order. Google returns the highest
 * quality completions, Yahoo is a solid backup, and Wikipedia guarantees we
 * always have something sensible even if both are throttled.
 */

const { getJson } = require('./http');
const { LRUCache } = require('./cache');

const cache = new LRUCache({ max: 300, ttl: 10 * 60 * 1000 });

const GOOGLE = 'https://clients1.google.com/complete/search';
const YAHOO = 'https://search.yahoo.com/sugg/gossip/gossip-us-ura/';

async function fromGoogle(query, { signal } = {}) {
  const params = new URLSearchParams({ client: 'chrome', q: query });
  const response = await getJson(`${GOOGLE}?${params.toString()}`, {
    timeout: 4000,
    retries: 0,
    signal,
    headers: { Accept: 'application/json,text/plain,*/*' },
  });
  const list = response.json?.[1];
  return Array.isArray(list) ? list.map((title) => ({ title, source: 'google' })) : [];
}

async function fromYahoo(query, { signal } = {}) {
  const params = new URLSearchParams({ output: 'sd1', command: query });
  const response = await getJson(`${YAHOO}?${params.toString()}`, {
    timeout: 4000,
    retries: 0,
    signal,
    headers: { Accept: 'application/json,text/plain,*/*' },
  });
  const list = response.json?.r;
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => (typeof entry === 'string' ? entry : entry.k))
    .filter(Boolean)
    .map((title) => ({ title, source: 'yahoo' }));
}

async function fromWikipedia(query, { signal } = {}) {
  const wikipedia = require('./providers/wikipedia');
  const hits = await wikipedia.opensearch(query, { limit: 8, signal });
  return hits.map((hit) => ({ title: hit.title, source: 'wikipedia', description: hit.description }));
}

/**
 * Get suggestions for a partial query.
 * @returns {Promise<Array<{title:string,source:string,description?:string}>>}
 */
async function suggest(query, { signal, limit = 10 } = {}) {
  const trimmed = (query || '').trim();
  if (trimmed.length < 2) return [];

  const key = `s:${trimmed.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return cached.slice(0, limit);

  const sources = [fromGoogle, fromYahoo, fromWikipedia];
  const collected = [];
  const errors = [];

  // Race the providers but keep them ordered by preference in the output.
  const outcomes = await Promise.allSettled(
    sources.map((fn) => fn(trimmed, { signal })),
  );

  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled' && Array.isArray(outcome.value)) {
      collected.push(...outcome.value);
    } else if (outcome.status === 'rejected') {
      errors.push({ source: sources[index].name, error: outcome.reason?.message });
    }
  });

  // Preserve source priority while removing duplicates.
  const priority = { google: 0, yahoo: 1, wikipedia: 2 };
  const seen = new Set();
  const merged = [];
  for (const item of collected.sort((a, b) => (priority[a.source] ?? 9) - (priority[b.source] ?? 9))) {
    const key2 = item.title.toLowerCase().trim();
    if (!key2 || seen.has(key2)) continue;
    seen.add(key2);
    merged.push(item);
  }

  cache.set(key, merged);
  return merged.slice(0, limit);
}

module.exports = { suggest, cache };
