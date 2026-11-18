'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  canonicalizeUrl,
  extractPage,
  loadIndex,
  rankPages,
  saveIndex,
  tokenize,
} = require('../search-engine');
const { crawl } = require('../search-engine/crawl');
const { canCrawl, parseRobots } = require('../search-engine/robots');
const { createServer } = require('../search-engine/server');

test('local index search ranks title matches and returns useful excerpts', () => {
  const pages = [
    { url: 'https://docs.example/fox', title: 'Red fox guide', text: 'A red fox is a small wild animal. ' + 'More information. '.repeat(20) },
    { url: 'https://docs.example/color', title: 'Color notes', text: 'Red is a warm color, followed by a fox illustration.' },
  ];

  const results = rankPages('red fox', pages);
  assert.equal(results[0].url, 'https://docs.example/fox');
  assert.match(results[0].snippet, /red fox/i);
  assert.deepEqual(rankPages('the and of', pages), []);
});

test('tokenization normalizes Unicode and removes common stop words', () => {
  assert.deepEqual(tokenize('The CAFÉ is near a river'), ['café', 'near', 'river']);
  assert.deepEqual(tokenize('C++ and AI'), ['c', 'ai']);
  const text = extractPage('<p>&constructor; &amp;</p>', 'https://example.test/').text;
  assert.deepEqual(tokenize(text), ['constructor']);
});

test('HTML extraction removes non-content and reports indexing directives', () => {
  const page = extractPage(
    '<html><head><title>Red &amp; Fox</title><meta name="robots" content="nofollow"></head>'
      + '<body><nav>navigation noise</nav><main>A red fox lives here.'
      + '<a href="/more" rel="nofollow">More details</a></main><script>hidden noise</script></body></html>',
    'https://example.test/article',
  );

  assert.equal(page.title, 'Red & Fox');
  assert.match(page.text, /A red fox lives here/);
  assert.doesNotMatch(page.text, /navigation noise|hidden noise/);
  assert.equal(page.nofollow, true);
  assert.deepEqual(page.links, [{ href: '/more', nofollow: true }]);
  const excluded = extractPage(
    '<meta name="robots" content="none"><p>Not for indexing.</p>',
    'https://example.test/noindex',
  );
  assert.equal(excluded.noindex, true);
  assert.equal(excluded.nofollow, true);
});

test('URL normalization rejects unsafe schemes and removes crawl-trap query strings', () => {
  assert.equal(canonicalizeUrl('https://example.test/page?next=1#part'), 'https://example.test/page');
  assert.equal(canonicalizeUrl('file:///etc/passwd'), '');
  assert.equal(canonicalizeUrl('https://user:pass@example.test/'), '');
});

test('robots rules prefer the most specific match and honor allow ties', () => {
  const robots = parseRobots([
    'User-agent: *',
    'Disallow: /private',
    'Allow: /private/public',
    'Disallow: /query/*',
    'Allow: /query/ok$',
    'Crawl-delay: 2',
  ].join('\n'));

  assert.equal(canCrawl('https://example.test/private/page', robots), false);
  assert.equal(canCrawl('https://example.test/private/public/page', robots), true);
  assert.equal(canCrawl('https://example.test/open', robots), true);
  assert.equal(canCrawl('https://example.test/query/page/2', robots), false);
  assert.equal(canCrawl('https://example.test/query/ok', robots), true);
  assert.equal(robots.crawlDelay, 2);
  assert.equal(canCrawl('https://example.test/private', parseRobots('User-agent:\nDisallow: /')), true);
});

test('local search index is saved and loaded from the configured file', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swiftly-search-test-'));
  const file = path.join(directory, 'index.json');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.deepEqual(await loadIndex(file), { version: 1, updatedAt: null, pages: [] });
  const index = {
    version: 1,
    updatedAt: '2026-11-18T00:00:00.000Z',
    pages: [{ url: 'https://example.test/', title: 'Example', text: 'A page' }],
  };
  await saveIndex(index, file);
  assert.deepEqual(await loadIndex(file), index);
  const updated = { ...index, updatedAt: '2026-11-18T00:01:00.000Z' };
  await saveIndex(updated, file);
  assert.deepEqual(await loadIndex(file), updated);
});

test('crawler indexes same-origin pages and honors robots and query-loop guards', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swiftly-crawl-test-'));
  const indexPath = path.join(directory, 'index.json');
  let privatePageRequested = false;
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('User-agent: *\nDisallow: /private');
      return;
    }
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<title>Swiftly Index</title><main>Search your own local index.'
        + '<a href="/docs?page=1">Docs</a><a href="/private/secret">Private</a>'
        + '<a href="https://outside.example/page">Outside</a></main>');
      return;
    }
    if (request.url === '/docs') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<title>Search docs</title><p>The search engine stores indexed pages.</p>');
      return;
    }
    if (request.url.startsWith('/private')) privatePageRequested = true;
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const address = server.address();
  const result = await crawl([`http://127.0.0.1:${address.port}/`], {
    maxPages: 5,
    indexPath,
    log: () => {},
    warn: () => {},
  });
  const index = await loadIndex(indexPath);

  assert.equal(result.fetched, 2);
  assert.equal(index.pages.length, 2);
  assert.equal(privatePageRequested, false);
  assert.deepEqual(new Set(index.pages.map((page) => new URL(page.url).pathname)), new Set(['/', '/docs']));
});

test('crawler fails closed and caches a robots.txt error for the origin', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swiftly-robots-test-'));
  const indexPath = path.join(directory, 'index.json');
  let robotsRequests = 0;
  let pageRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/robots.txt') {
      robotsRequests += 1;
      response.writeHead(503);
    } else {
      pageRequests += 1;
      response.writeHead(200, { 'Content-Type': 'text/html' });
    }
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  await crawl([`${origin}/one`, `${origin}/two`], {
    maxPages: 5,
    indexPath,
    log: () => {},
    warn: () => {},
  });
  assert.equal(robotsRequests, 1);
  assert.equal(pageRequests, 0);
});

test('standalone web server serves the UI and searches its own index', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'swiftly-search-server-test-'));
  const indexPath = path.join(directory, 'index.json');
  await saveIndex({
    version: 1,
    updatedAt: new Date().toISOString(),
    pages: [{
      url: 'https://docs.example.test/c',
      title: 'C programming language',
      text: 'C is a general-purpose programming language.',
    }],
  }, indexPath);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const server = createServer({ indexPath });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await home.text(), /your own search index/i);

  const stats = await (await fetch(`${base}/api/stats`)).json();
  assert.equal(stats.indexedPages, 1);
  const search = await (await fetch(`${base}/api/search?q=C`)).json();
  assert.equal(search.results[0].url, 'https://docs.example.test/c');
  assert.equal((await fetch(`${base}/api/search`, { method: 'POST' })).status, 405);
  assert.equal(Object.keys(require.cache).some((file) => file.includes(`${path.sep}electron${path.sep}`)), false);
});
