'use strict';

/**
 * Bing web results provider — Swiftly's primary search source.
 *
 * Two things were needed to get good results out of Bing:
 *
 *  1. A primed session. Bing only serves its full server-rendered result list
 *     to clients that carry cookies from a previous visit. Without them the
 *     page comes back as an empty, JavaScript-driven shell.
 *  2. `setlang=` rather than `mkt=`. The `mkt` parameter selects a different
 *     layout that the HTML scraper cannot read.
 *
 * The HTML layout is used for results because its ranking is noticeably better
 * than the RSS rendering, which tends to match only the first word of a
 * multi-word query. RSS is kept as a fallback for when the HTML path is
 * unavailable.
 */

const { get } = require('../http');
const { CookieJar } = require('../session');
const { cleanText, absoluteUrl } = require('../html');
const { makeResult, dedupe, saysNoResults } = require('./common');

const ENDPOINT = 'https://www.bing.com/search';
const HOME = 'https://www.bing.com/';

const jar = new CookieJar();
let primed = false;
let priming = null;

const SESSION_TTL = 30 * 60 * 1000;
let lastPrimed = 0;

/**
 * Request pacing.
 *
 * Bursting Bing with queries makes it answer with a heavily filtered result
 * set — technically valid, but useless. Spacing requests out keeps the
 * rankings honest.
 */
const MIN_GAP_MS = 900;
let lastRequestAt = 0;
let queue = Promise.resolve();

/**
 * Words that carry no signal when judging whether results match a query.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'you', 'your', 'are', 'was', 'how', 'what',
  'why', 'when', 'where', 'who', 'from', 'this', 'that', 'into', 'about',
  'best', 'vs', 'versus', 'can', 'does', 'make', 'use', 'using', 'get',
]);

/**
 * Does the result list actually look like it answers the query?
 *
 * Bing occasionally answers a machine-looking request with results for an
 * unrelated query — valid HTML, entirely beside the point. When the top hits
 * share no vocabulary with the query we treat the response as suspect and
 * try again with a fresh session.
 */
function relevance(query, results) {
  const tokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9+]+/i)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  if (!tokens.length) return 1;
  if (!results.length) return 0;

  const top = results.slice(0, 6);
  const matching = top.filter((result) => {
    const haystack = `${result.title} ${result.url} ${result.snippet}`.toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  }).length;

  return matching / top.length;
}

/** Run a task after the minimum gap since the previous Bing request. */
function paced(task) {
  const run = queue.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      return await task();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  // Keep the chain alive even when a task rejects.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

/** Stop one caller waiting for a shared operation when its request is cancelled. */
function waitForSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Search request aborted'));

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason || new Error('Search request aborted'));
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

function delay(ms, signal) {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason || new Error('Search request aborted'));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason || new Error('Search request aborted'));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Visit the homepage once so the search endpoint sees a returning client. */
async function ensureSession(force = false, signal) {
  const fresh = primed && Date.now() - lastPrimed < SESSION_TTL;
  if (fresh && !force) return;
  if (priming) return waitForSignal(priming, signal);

  // Priming is not a search query, so it should not consume the query pacing gap.
  priming = (async () => {
    try {
      const response = await get(HOME, {
        timeout: 10000,
        retries: 1,
        jar,
        headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
      primed = response.status === 200;
      if (primed) lastPrimed = Date.now();
    } catch {
      primed = false;
    } finally {
      priming = null;
    }
  })();

  return waitForSignal(priming, signal);
}

/** Split the HTML result page into individual `<li class="b_algo">` blocks. */
function splitResults(html) {
  const parts = html.split(/<li class="b_algo"/g);
  parts.shift();
  return parts;
}

/** Pull the title link out of a result block. */
function extractTitle(block) {
  const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
  const scope = h2 ? h2[1] : block;
  const link = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(scope);
  if (!link) return null;
  return { url: link[1], title: cleanText(link[2]) };
}

/** Pull the description paragraph out of a result block. */
function extractSnippet(block) {
  const caption = /<div class="b_caption"[^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<div)/i.exec(block);
  const scope = caption ? caption[1] : block;
  const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(scope);
  if (p) return cleanText(p[1]);
  const fallback = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
  return fallback ? cleanText(fallback[1]) : '';
}

/** Pull the human-readable URL and any date stamp from a result block. */
function extractMeta(block) {
  let display = '';
  const cite = /<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(block);
  if (cite) display = cleanText(cite[1]);

  let date = '';
  const dt = /<span class="news_dt"[^>]*>([\s\S]*?)<\/span>/i.exec(block);
  if (dt) date = cleanText(dt[1]);

  return { display, date };
}

/** Related searches from the HTML layout. */
function extractRelated(html) {
  const related = [];
  const seen = new Set();
  const container = /<div class="b_rsContainer"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i.exec(html);
  const scope = container ? container[1] : '';
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(scope)) !== null) {
    const label = cleanText(m[2]);
    if (!label || label.length > 60) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    related.push({ title: label, url: absoluteUrl(m[1], 'https://www.bing.com') });
  }
  return related.slice(0, 8);
}

/** Fetch one page of the HTML result layout. */
async function fetchHtmlPage(query, { offset, safeSearch, region, signal }) {
  const params = new URLSearchParams({
    q: query,
    count: '10',
    setlang: region.split('-')[0] || 'en',
    form: 'QBLH',
  });
  if (offset > 1) params.set('first', String(offset));
  if (safeSearch === 'strict') params.set('safesearch', 'strict');
  else if (safeSearch === 'off') params.set('safesearch', 'off');

  const response = await paced(() => get(`${ENDPOINT}?${params.toString()}`, {
    timeout: 12000,
    retries: 1,
    signal,
    jar,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: 'https://www.bing.com/',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
    },
  }));

  const html = response.body;
  const results = [];

  for (const raw of splitResults(html)) {
    const block = raw.split(/<li class="b_algo"|<li class="b_ad"|<li class="b_ans"/i)[0];
    const title = extractTitle(block);
    if (!title || !title.title) continue;

    const meta = extractMeta(block);
    const result = makeResult({
      title: title.title,
      url: title.url,
      snippet: extractSnippet(block),
      displayUrl: meta.display,
      date: meta.date,
      provider: 'bing',
    });

    if (result.url) results.push(result);
  }

  return { results, related: extractRelated(html), html };
}

/** Read one XML element's text content. */
function xmlText(xml, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = re.exec(xml);
  return match ? cleanText(match[1]) : '';
}

/** Fallback path: the RSS rendering, which is clean but only ten items deep. */
async function searchRss(query, { limit, safeSearch, region, signal }) {
  const params = new URLSearchParams({
    format: 'rss',
    q: query,
    setlang: region.split('-')[0] || 'en',
  });
  if (safeSearch === 'strict') params.set('safesearch', 'strict');
  else if (safeSearch === 'off') params.set('safesearch', 'off');

  const response = await paced(() => get(`${ENDPOINT}?${params.toString()}`, {
    timeout: 10000,
    retries: 1,
    signal,
    jar,
    headers: {
      Accept: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      Referer: 'https://www.bing.com/',
    },
  }));

  const blocks = response.body.split(/<item\b[^>]*>/i).slice(1);
  const results = [];
  for (const block of blocks) {
    if (results.length >= limit) break;
    const link = xmlText(block, 'link');
    if (!link) continue;
    const result = makeResult({
      title: xmlText(block, 'title'),
      url: link,
      snippet: xmlText(block, 'description'),
      date: xmlText(block, 'pubDate'),
      provider: 'bing',
    });
    if (result.url) results.push(result);
  }
  return results;
}

async function search(query, { limit = 20, safeSearch = 'moderate', region = 'en-US', signal } = {}) {
  await ensureSession(false, signal);

  let page = await collect(query, { limit, safeSearch, region, signal });

  // If the results look unrelated to the query, start a fresh session and
  // try once more before giving up on a usable answer.
  if (page.results.length >= 3 && relevance(query, page.results) < 0.2) {
    reset();
    await ensureSession(true, signal);
    await delay(600, signal);
    const retry = await collect(query, { limit, safeSearch, region, signal });
    if (relevance(query, retry.results) >= relevance(query, page.results)) {
      page = retry;
    }
  }

  return {
    provider: 'bing',
    results: dedupe(page.results).slice(0, limit),
    related: page.related,
  };
}

/** Run the HTML layout across as many pages as the limit requires. */
async function collect(query, { limit, safeSearch, region, signal }) {
  let results = [];
  let related = [];
  let html = '';

  try {
    const page = await fetchHtmlPage(query, { offset: 1, safeSearch, region, signal });
    results = page.results;
    related = page.related;
    html = page.html;

    // Page through the HTML layout for deeper result lists.
    let offset = 11;
    while (results.length < limit && offset <= limit + 10) {
      const next = await fetchHtmlPage(query, { offset, safeSearch, region, signal });
      if (!next.results.length) break;
      let added = 0;
      for (const result of next.results) {
        if (results.length >= limit) break;
        if (!results.some((r) => r.url === result.url)) {
          results.push(result);
          added += 1;
        }
      }
      if (!added) break;
      offset += 10;
    }
  } catch {
    /* fall through to RSS */
  }

  if (!results.length) {
    try {
      results = await searchRss(query, { limit, safeSearch, region, signal });
    } catch {
      /* nothing left to try */
    }
  }

  // Neither layout produced anything and the page does not say "no results",
  // which means the markup changed or we were served an empty shell. Raising
  // lets the engine fail over to the next provider instead of reporting an
  // empty (but "successful") search.
  if (!results.length && !saysNoResults(html)) {
    throw new Error('Bing returned no parseable results');
  }

  return { results, related };
}

/** Forget the session — used by Settings → "reset search session". */
function reset() {
  jar.clear();
  primed = false;
  lastPrimed = 0;
}

module.exports = { search, reset, name: 'Bing', id: 'bing' };