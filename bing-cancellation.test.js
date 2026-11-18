'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const bing = require('../src/search/providers/bing');

test('cancels waiting for an in-progress shared Bing session prime', async (t) => {
  const originalFetch = global.fetch;
  const requestedUrls = [];

  bing.reset();
  global.fetch = async (url, { signal }) => {
    requestedUrls.push(String(url));
    if (new URL(url).pathname !== '/') {
      if (signal.aborted) throw signal.reason || new Error('aborted');
      throw new Error('Unexpected search request');
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
    return {
      ok: true,
      status: 200,
      url: String(url),
      headers: { get: () => null },
      text: async () => '<html></html>',
    };
  };

  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    bing.reset();
    global.fetch = originalFetch;
  });

  const controller = new AbortController();
  const startedAt = Date.now();
  const search = bing.search('cancellation test', { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('automatic timeout')), 20);

  await assert.rejects(search, /automatic timeout/);
  assert.ok(Date.now() - startedAt < 150, 'search should stop waiting before session priming completes');
  assert.equal(requestedUrls.length, 1, 'an aborted search should not proceed to the Bing results endpoint');
});
