'use strict';

const { setTimeout: sleep } = require('node:timers/promises');
const { canonicalizeUrl, extractPage, loadIndex, saveIndex } = require('./index');
const { canCrawl, parseRobots } = require('./robots');

const USER_AGENT = 'SwiftlySearchBot/0.1 (local self-hosted indexer)';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_QUEUED_PAGES = 5000;
const REQUEST_TIMEOUT_MS = 10000;
const MIN_ORIGIN_DELAY_MS = 1000;

async function readLimited(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeds ${maxBytes} bytes`);
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

async function fetchResource(
  value,
  origin,
  maxBytes = MAX_RESPONSE_BYTES,
  { beforeRequest = async () => {}, afterRequest = () => {} } = {},
) {
  let current = value;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    await beforeRequest();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1',
          'User-Agent': USER_AGENT,
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) return { status: response.status, text: '', url: current, headers: response.headers };
        const redirected = canonicalizeUrl(new URL(location, current).toString());
        if (!redirected || new URL(redirected).origin !== origin) {
          throw new Error('Cross-origin redirect refused');
        }
        current = redirected;
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, text: '', url: current, headers: response.headers };
      }

      const text = await readLimited(response, maxBytes);
      return { status: response.status, text, url: response.url || current, headers: response.headers };
    } finally {
      clearTimeout(timer);
      afterRequest();
    }
  }
  throw new Error('Too many redirects');
}

async function getRobots(origin, requestOptions) {
  const response = await fetchResource(`${origin}/robots.txt`, origin, 256 * 1024, requestOptions);
  if (response.status === 404 || response.status === 410) {
    return parseRobots('');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`robots.txt returned HTTP ${response.status}`);
  }
  return parseRobots(response.text);
}

function parseArguments(argv) {
  const seeds = [];
  let maxPages = 25;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--max-pages') {
      maxPages = Number(argv[i + 1]);
      i += 1;
    } else if (argv[i].startsWith('--max-pages=')) {
      maxPages = Number(argv[i].slice('--max-pages='.length));
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      return { help: true, seeds: [], maxPages };
    } else {
      seeds.push(argv[i]);
    }
  }
  return { help: false, seeds, maxPages };
}

async function crawl(seeds, {
  maxPages = 25,
  indexPath,
  log = console.log,
  warn = console.warn,
} = {}) {
  const queue = [];
  const origins = new Set();
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new Error('maxPages must be an integer from 1 to 100.');
  }
  if (seeds.length > 20) throw new Error('Provide no more than 20 seed URLs per crawl.');
  for (const seed of seeds) {
    const url = canonicalizeUrl(seed);
    if (!url) throw new Error(`Invalid HTTP(S) seed URL: ${seed}`);
    const origin = new URL(url).origin;
    origins.add(origin);
    queue.push({ url, origin });
  }
  if (!queue.length) throw new Error('Provide at least one seed URL.');

  const index = await loadIndex(indexPath);
  const pages = new Map(index.pages.map((page) => [page.url, page]));
  const visited = new Set();
  const enqueued = new Set(queue.map((item) => item.url));
  const robotsByOrigin = new Map();
  const lastRequestByOrigin = new Map();
  const requestOptionsFor = (origin) => ({
    beforeRequest: async () => {
      const robotsDelay = (robotsByOrigin.get(origin)?.crawlDelay || 0) * 1000;
      const delay = Math.max(MIN_ORIGIN_DELAY_MS, robotsDelay);
      const elapsed = Date.now() - (lastRequestByOrigin.get(origin) || 0);
      if (elapsed < delay) await sleep(delay - elapsed);
    },
    afterRequest: () => lastRequestByOrigin.set(origin, Date.now()),
  });
  let fetched = 0;
  let requests = 0;

  while (queue.length && requests < maxPages) {
    const { url, origin } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      if (!robotsByOrigin.has(origin)) {
        try {
          robotsByOrigin.set(origin, await getRobots(origin, requestOptionsFor(origin)));
        } catch (error) {
          robotsByOrigin.set(origin, { rules: [{ allow: false, path: '/' }], crawlDelay: null });
          warn(`Could not read robots.txt for ${origin}; skipping that origin: ${error.message}`);
          continue;
        }
      }
      const robots = robotsByOrigin.get(origin);
      if (!canCrawl(url, robots)) {
        log(`Skipped by robots.txt: ${url}`);
        continue;
      }

      requests += 1;
      const response = await fetchResource(url, origin, MAX_RESPONSE_BYTES, requestOptionsFor(origin));
      if (response.status < 200 || response.status >= 300) {
        warn(`Skipped HTTP ${response.status}: ${url}`);
        continue;
      }
      fetched += 1;
      const contentType = response.headers.get('content-type') || '';
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        log(`Skipped non-HTML page: ${url}`);
        continue;
      }
      const page = extractPage(response.text, response.url, response.headers);
      const finalUrl = canonicalizeUrl(response.url) || url;
      const canonical = canonicalizeUrl(page.canonical);
      const pageUrl = canonical && new URL(canonical).origin === origin ? canonical : finalUrl;

      if (!page.noindex && page.text) {
        pages.set(pageUrl, {
          url: pageUrl,
          title: page.title,
          text: page.text,
          indexedAt: new Date().toISOString(),
        });
        log(`Indexed: ${page.title} — ${pageUrl}`);
      } else {
        log(`Fetched but not indexed: ${pageUrl}`);
      }

      if (!page.nofollow) {
        for (const link of page.links) {
          if (link.nofollow) continue;
          let resolved;
          try {
            resolved = canonicalizeUrl(new URL(link.href, response.url).toString());
          } catch {
            continue;
          }
          if (!resolved) continue;
          const linkOrigin = new URL(resolved).origin;
          if (origins.has(linkOrigin) && !enqueued.has(resolved) && enqueued.size < MAX_QUEUED_PAGES) {
            enqueued.add(resolved);
            queue.push({ url: resolved, origin: linkOrigin });
          }
        }
      }
    } catch (error) {
      warn(`Could not crawl ${url}: ${error.message}`);
    }
  }

  const updated = { version: 1, updatedAt: new Date().toISOString(), pages: [...pages.values()] };
  await saveIndex(updated, indexPath);
  return { fetched, indexed: pages.size, remaining: queue.length };
}

async function main() {
  const { help, seeds, maxPages } = parseArguments(process.argv.slice(2));
  if (help || !seeds.length) {
    console.log('Usage: node search-engine/crawl.js <seed-url> [seed-url ...] [--max-pages 25]');
    console.log('Crawls same-origin HTML pages, obeying robots.txt and a minimum 1-second per-origin delay.');
    if (!help) process.exitCode = 1;
    return;
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new Error('--max-pages must be an integer from 1 to 100.');
  }

  const result = await crawl(seeds, { maxPages });
  console.log(`Crawl complete: ${result.fetched} pages fetched; ${result.indexed} pages in the local index.`);
  if (result.remaining) {
    console.log(`${result.remaining} discovered URLs were not processed; rerun with the same seeds to rediscover them.`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Crawl failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { crawl, fetchResource, parseArguments };
