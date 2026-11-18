'use strict';

/**
 * The Swiftly search engine.
 *
 * Responsibilities:
 *  - run the instant-answer pass (calculator, conversions, weather, …)
 *  - run the web-results pass across a chain of providers with failover
 *  - keep each provider's health so a blocked engine is skipped for a while
 *  - assemble a knowledge panel and related searches
 *  - cache aggressively, because people repeat themselves
 */

const providers = require('./providers');
const { instantAnswer } = require('./instant');
const { suggest } = require('./suggest');
const { LRUCache } = require('./cache');
const { hostOf } = require('./html');

const resultsCache = new LRUCache({ max: 300, ttl: 5 * 60 * 1000 });
const typoCache = new LRUCache({ max: 200, ttl: 30 * 60 * 1000 });

/** Per-provider health: consecutive failures put a provider on ice. */
const health = new Map();

const COOLDOWN_AFTER_FAILURES = 2;
const COOLDOWN_MS = 60 * 1000;
const AUTOMATIC_PROVIDER_TIMEOUT_MS = 3000;

function providerState(id) {
  if (!health.has(id)) {
    health.set(id, { failures: 0, cooldownUntil: 0, lastError: null, successes: 0, latency: 0 });
  }
  return health.get(id);
}

function markSuccess(id, latency) {
  const state = providerState(id);
  state.failures = 0;
  state.cooldownUntil = 0;
  state.successes += 1;
  state.latency = latency;
  state.lastError = null;
}

function markFailure(id, error) {
  const state = providerState(id);
  state.failures += 1;
  state.lastError = error?.message || String(error);
  if (state.failures >= COOLDOWN_AFTER_FAILURES) {
    state.cooldownUntil = Date.now() + COOLDOWN_MS;
  }
}

/** Providers ordered by preference, with healthy ones first. */
function orderedProviders(preferred) {
  const all = providers.list();
  const preferredIds = new Set(preferred || []);
  const now = Date.now();
  return all.sort((a, b) => {
    const aPreferred = preferredIds.has(a.id) ? 0 : 1;
    const bPreferred = preferredIds.has(b.id) ? 0 : 1;
    if (aPreferred !== bPreferred) return aPreferred - bPreferred;
    const aState = providerState(a.id);
    const bState = providerState(b.id);
    const aBlocked = aState.cooldownUntil > now;
    const bBlocked = bState.cooldownUntil > now;
    if (aBlocked !== bBlocked) return aBlocked ? 1 : -1;
    if (aState.failures !== bState.failures) return aState.failures - bState.failures;
    return a.id.localeCompare(b.id);
  });
}

/**
 * The chain to try for one search.
 *
 * When the user explicitly pinned a provider set, that list is exhaustive and
 * a cooling-down provider is still attempted — being the only source is
 * better than returning nothing. Otherwise the automatic chain skips
 * providers that are currently on ice.
 */
function buildChain({ providerIds, preferredProviders }) {
  const now = Date.now();
  if (Array.isArray(providerIds) && providerIds.length) {
    const wanted = new Set(providerIds);
    const pinned = providers.list().filter((provider) => wanted.has(provider.id));
    if (pinned.length) return pinned;
  }
  return orderedProviders(preferredProviders)
    .filter((provider) => providerState(provider.id).cooldownUntil <= now);
}

/**
 * Words that mark a query as a question or a task rather than a named thing.
 * A knowledge panel only makes sense for something with a name.
 */
const NON_ENTITY_WORDS = /\b(how|why|when|where|who|whom|whose|what|which|vs|versus|best|download|install|price|near|review|tutorial|guide|examples?|alternative|compare|login|sign|with|for|from|about|into|using|does|do|is|are|can|should|would|could|will|list|top|free|online|meaning|define|definition)\b/i;

/** Does this query look like it wants an encyclopedia answer? */
function looksLikeEntity(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2 || trimmed.length > 48) return false;
  if (/[?]$/.test(trimmed)) return false;
  if (/[0-9]/.test(trimmed) && !/^[\p{L}]/u.test(trimmed)) return false;
  if (/[+*/^=<>%]/.test(trimmed)) return false;
  if (NON_ENTITY_WORDS.test(trimmed)) return false;
  // Prepositions mean the query is a phrase, not a name.
  if (/\b(in|at|of|and|or|to|on)\b/i.test(trimmed)) return false;
  return /^[\p{L}\p{N}][\p{L}\p{N}\s.'&+-]*$/u.test(trimmed);
}

/** Normalise a title for comparison: lowercase, letters and digits only. */
function normalizeEntity(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Build the knowledge panel.
 *
 * The panel is deliberately conservative: it only appears when the query is
 * very close to an encyclopedia article title. A loose match produces panels
 * for novels and TV shows that merely share a word with the query, which is
 * worse than showing nothing at all.
 */
async function knowledgePanel(query, results, { signal } = {}) {
  if (!looksLikeEntity(query)) return null;

  const wikipedia = require('./providers/wikipedia');
  const needle = normalizeEntity(query);
  if (!needle) return null;

  // 1. An exact (or near-exact) article title is the strongest signal.
  try {
    const summary = await wikipedia.summary(query, { signal });
    if (summary) {
      const title = normalizeEntity(summary.title);
      if (title === needle || (needle.length >= 4 && title.includes(needle) && title.length <= needle.length * 1.4)) {
        return summary;
      }
    }
  } catch {
    /* fall through */
  }

  // 2. Otherwise, if the query names a thing, try a Wikipedia search and
  //    accept it only when the article title matches closely.
  try {
    const found = await wikipedia.search(query, { signal });
    if (!found || !found.extract) return null;
    const title = normalizeEntity(found.title);
    if (title === needle) return found;
    if (needle.length >= 5 && title.includes(needle)) return found;
    if (title.includes(needle) && title.length <= needle.length * 1.5) return found;
  } catch {
    /* no panel */
  }

  return null;
}

/**
 * Perform a full search.
 *
 * @param {string} query
 * @param {object} options
 * @returns {Promise<object>}
 */
async function search(query, options = {}) {
  const {
    limit = 20,
    safeSearch = 'moderate',
    region = 'en-US',
    providers: preferredProviders = null,
    providerIds = null,
    includeInstant = true,
    includeKnowledge = true,
    signal,
  } = options;

  const started = Date.now();
  const trimmed = String(query || '').trim();
  if (!trimmed) {
    return { query: trimmed, results: [], instant: null, knowledge: null, related: [], provider: null, took: 0 };
  }

  let providerKey = 'automatic';
  if (Array.isArray(providerIds) && providerIds.length) {
    providerKey = `only-${providerIds.join(',')}`;
  } else if (Array.isArray(preferredProviders) && preferredProviders.length) {
    providerKey = `prefer-${preferredProviders.join(',')}`;
  }
  const cacheKey = `r:${providerKey}:${safeSearch}:${region}:${limit}:${trimmed.toLowerCase()}`;
  const cached = resultsCache.get(cacheKey);
  if (cached) {
    // Add typo suggestions if no results and no instant answer
    if (!cached.results.length && !cached.instant) {
      try {
        const typoKey = `t:${trimmed.toLowerCase()}`;
        const cachedTypo = typoCache.get(typoKey);
        if (cachedTypo) {
          cached.instant = cachedTypo;
        } else {
          const suggestions = await suggest(trimmed, { signal, limit: 1 });
          if (suggestions.length > 0 && suggestions[0].title.toLowerCase() !== trimmed.toLowerCase()) {
            const typoSuggestion = {
              kind: 'include',
              title: `Include result for "${suggestions[0].title}"`,
              url: suggestions[0].title,
            };
            cached.instant = typoSuggestion;
            typoCache.set(typoKey, typoSuggestion);
          }
        }
      } catch {
        // Fail silently if suggestion fails
      }
    }
    return { ...cached, cached: true, took: Date.now() - started };
  }

  // The instant answer is cheap for local computations and quick for the
  // network ones, so it runs alongside the web search rather than after it.
  const instantPromise = includeInstant
    ? instantAnswer(trimmed, { signal }).catch(() => null)
    : Promise.resolve(null);
  const knowledgePromise = instantPromise.then((instant) => (
    includeKnowledge && !instant
      ? knowledgePanel(trimmed, [], { signal }).catch(() => null)
      : null
  ));

  const chain = buildChain({ providerIds, preferredProviders });
  const collected = [];
  const related = [];
  let usedProvider = null;
  const failures = [];

  // A pinned provider is the user's explicit choice, so it may run even while
  // cooling down; the automatic chain already excludes those.
  const pinned = Array.isArray(providerIds) && providerIds.length > 0;

  // Run providers in parallel so a slow engine cannot block the others.
  // Cooling-down providers are still skipped unless pinned.
  const eligible = [];
  for (const provider of chain) {
    const state = providerState(provider.id);
    if (!pinned && state.cooldownUntil > Date.now()) {
      failures.push({ provider: provider.id, reason: 'cooling down' });
      continue;
    }
    eligible.push(provider);
  }

  const outcomes = await Promise.allSettled(eligible.map(async (provider) => {
    const providerStart = Date.now();
    const controller = new AbortController();
    const timeout = !pinned
      ? setTimeout(() => controller.abort(
        new Error(`Automatic search provider timed out after ${AUTOMATIC_PROVIDER_TIMEOUT_MS}ms`),
      ), AUTOMATIC_PROVIDER_TIMEOUT_MS)
      : null;
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const outcome = await provider.search(trimmed, {
        limit,
        safeSearch,
        region,
        signal: controller.signal,
      });
      markSuccess(provider.id, Date.now() - providerStart);
      return { provider, outcome };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }));

  for (const settled of outcomes) {
    if (settled.status === 'fulfilled') {
      const { provider, outcome } = settled.value;
      if (!outcome || !outcome.results || !outcome.results.length) continue;
      if (!usedProvider) usedProvider = provider.id;
      for (const result of outcome.results) {
        if (collected.length >= limit) break;
        if (!collected.some((r) => r.url === result.url)) collected.push(result);
      }
      for (const item of outcome.related || []) {
        if (related.length < 8 && !related.some((r) => r.title.toLowerCase() === item.title.toLowerCase())) {
          related.push(item);
        }
      }
    } else {
      const provider = eligible[outcomes.indexOf(settled)];
      if (provider) {
        markFailure(provider.id, settled.reason);
        failures.push({ provider: provider.id, reason: settled.reason?.message || String(settled.reason) });
      }
    }
  }

  const instant = await instantPromise;
  const knowledge = await knowledgePromise;

  const payload = {
    query: trimmed,
    results: collected.map((result) => ({ ...result, favicon: faviconFor(result.url) })),
    instant,
    knowledge,
    related,
    provider: usedProvider,
    failures,
    took: Date.now() - started,
  };

  // Add typo suggestions if no results and no instant answer
  // Also show typo suggestions when results seem unrelated to the query
  if (!payload.results.length && !payload.instant) {
    try {
      const typoKey = `t:${trimmed.toLowerCase()}`;
      const cachedTypo = typoCache.get(typoKey);
      if (cachedTypo) {
        payload.instant = cachedTypo;
      } else {
        const suggestions = await suggest(trimmed, { signal, limit: 1 });
        if (suggestions.length > 0 && suggestions[0].title.toLowerCase() !== trimmed.toLowerCase()) {
          const typoSuggestion = {
            kind: 'include',
            title: `Include result for "${suggestions[0].title}"`,
            url: suggestions[0].title,
          };
          payload.instant = typoSuggestion;
          typoCache.set(typoKey, typoSuggestion);
        }
      }
    } catch {
      // Fail silently if suggestion fails
    }
  }

  // If results exist but seem unrelated, also suggest the correction
  // (e.g., "swiflty" returning "Vietnamese Food" results)
  if (payload.results.length > 0 && !payload.instant) {
    try {
      const firstResult = payload.results[0];
      const normalizedQuery = normalizeEntity(trimmed);
      const normalizedResult = normalizeEntity(firstResult.title);
      
      // If the first result doesn't match the query at all, suggest correction
      if (normalizedQuery && normalizedResult && normalizedQuery !== normalizedResult) {
        // Check if query and first result share any significant words
        const queryWords = normalizedQuery.split(/\s+/).filter(w => w.length > 2);
        const resultWords = normalizedResult.split(/\s+/).filter(w => w.length > 2);
        const sharedWords = queryWords.filter(w => resultWords.includes(w));
        
        // If no shared words and we have good suggestions, show typo correction
        if (sharedWords.length === 0) {
          const typoKey = `t:${trimmed.toLowerCase()}`;
          const cachedTypo = typoCache.get(typoKey);
          if (cachedTypo) {
            payload.instant = cachedTypo;
          } else {
            const suggestions = await suggest(trimmed, { signal, limit: 1 });
            if (suggestions.length > 0 && suggestions[0].title.toLowerCase() !== trimmed.toLowerCase()) {
              const typoSuggestion = {
                kind: 'include',
                title: `Include result for "${suggestions[0].title}"`,
                url: suggestions[0].title,
              };
              payload.instant = typoSuggestion;
              typoCache.set(typoKey, typoSuggestion);
            }
          }
        }
      }
    } catch {
      // Fail silently if suggestion fails
    }
  }

  resultsCache.set(cacheKey, payload);
  return payload;
}

function faviconFor(url) {
  const host = hostOf(url);
  if (!host) return '';
  return `https://${host}/favicon.ico`;
}

/** Health snapshot — surfaced in Settings so the user can see what is working. */
function status() {
  return providers.list().map((provider) => {
    const state = providerState(provider.id);
    return {
      id: provider.id,
      name: provider.name,
      failures: state.failures,
      successes: state.successes,
      coolingDown: state.cooldownUntil > Date.now(),
      lastError: state.lastError,
      latency: state.latency,
    };
  });
}

module.exports = { search, suggest, instantAnswer, status, resultsCache, typoCache };
