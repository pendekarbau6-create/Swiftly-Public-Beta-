'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const engine = require('../src/search/engine');
const providers = require('../src/search/providers');
const wikipedia = require('../src/search/providers/wikipedia');

test('skips the Wikipedia lookup for non-entity queries', async (t) => {
  const originalList = providers.list;
  const originalSummary = wikipedia.summary;
  let summaryCalls = 0;

  providers.list = () => [{
    id: 'test-provider',
    name: 'Test',
    search: async () => ({
      results: [{ title: 'Search latency', url: 'https://example.com', snippet: '' }],
      related: [],
    }),
  }];
  wikipedia.summary = async () => {
    summaryCalls += 1;
    return null;
  };
  t.after(() => {
    providers.list = originalList;
    wikipedia.summary = originalSummary;
  });

  const result = await engine.search('how to debug search latency', {
    includeInstant: false,
    includeKnowledge: true,
  });

  assert.equal(summaryCalls, 0);
  assert.equal(result.knowledge, null);
});

test('bounds slow providers in automatic combined searches', async (t) => {
  const originalList = providers.list;
  let aborted = false;

  providers.list = () => [{
    id: 'slow-test-provider',
    name: 'Slow test provider',
    search: (_query, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('cancelled'));
      }, { once: true });
    }),
  }];
  t.after(() => {
    providers.list = originalList;
  });

  const result = await engine.search('how to debug a slow search provider', {
    includeInstant: false,
    includeKnowledge: false,
  });

  assert.equal(aborted, true);
  assert.equal(result.failures[0].reason, 'cancelled');
});
