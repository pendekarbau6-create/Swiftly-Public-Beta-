'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const wikipedia = require('../src/search/providers/wikipedia');
const { personFactsFromWikidata } = wikipedia;

function itemClaim(id) {
  return { mainsnak: { snaktype: 'value', datavalue: { value: { id } } } };
}

function dateClaim(time, precision) {
  return { mainsnak: { snaktype: 'value', datavalue: { value: { time, precision } } } };
}

test('formats sourced Wikidata facts for a human entity', () => {
  const claims = {
    P31: [itemClaim('Q5')],
    P569: [dateClaim('+1990-04-15T00:00:00Z', 11)],
    P19: [itemClaim('Q60')],
    P27: [itemClaim('Q30')],
    P106: [itemClaim('Q33999'), itemClaim('Q177220')],
  };
  const labels = {
    Q60: 'New York City',
    Q30: 'United States',
    Q33999: 'singer',
    Q177220: 'songwriter',
  };

  assert.deepEqual(personFactsFromWikidata(claims, labels), [
    { label: 'Born', value: 'April 15, 1990' },
    { label: 'Birthplace', value: 'New York City' },
    { label: 'Nationality', value: 'United States' },
    { label: 'Occupation', value: 'singer, songwriter' },
  ]);
});

test('does not present human facts for non-person entities', () => {
  assert.deepEqual(personFactsFromWikidata({ P31: [itemClaim('Q5')] }, {}), []);
  assert.deepEqual(personFactsFromWikidata({ P31: [itemClaim('Q11344')] }, {}), []);
});

test('Wikipedia summaries return quickly with an entity id for deferred person details', async (t) => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({
      title: 'Test Person',
      description: 'American singer-songwriter',
      extract: 'A short biography.',
      wikibase_item: 'Q123',
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Test_Person' } },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await wikipedia.summary('Test Person');

  assert.equal(result.personEntityId, 'Q123');
  assert.equal(result.facts, undefined);
  assert.equal(requests.length, 1);
});
