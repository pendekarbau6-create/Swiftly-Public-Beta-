'use strict';

/**
 * Wikipedia provider — powers the knowledge panel, definitions, and the
 * "search within Wikipedia" fallback when no web engine is reachable.
 */

const { getJson } = require('../http');
const { cleanText, stripTags } = require('../html');

const API = 'https://en.wikipedia.org/w/api.php';
const SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const HUMAN_ENTITY_ID = 'Q5';
const PERSON_DESCRIPTION = /\b(actor|actress|singer|songwriter|musician|rapper|politician|athlete|footballer|cricketer|scientist|entrepreneur|businessperson|activist|comedian|journalist|model|composer|screenwriter|historian|philosopher|engineer|economist|painter|photographer|lawyer|physician|professor|researcher|astronaut|monarch|dancer|writer|author|poet|director|producer|presenter|personality|polymath)\b/i;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function valueFor(claims, property) {
  return claims?.[property]?.find((claim) => claim.mainsnak?.snaktype === 'value')
    ?.mainsnak?.datavalue?.value;
}

function itemIdsFor(claims, property, limit) {
  return (claims?.[property] || [])
    .map((claim) => claim.mainsnak?.datavalue?.value?.id)
    .filter((id) => typeof id === 'string' && /^Q\d+$/.test(id))
    .slice(0, limit);
}

function formatWikidataDate(value) {
  const match = /^([+-])(\d+)-(\d{2})-(\d{2})/.exec(value?.time || '');
  if (!match) return '';

  const year = Number(match[2]);
  const displayYear = `${year}${match[1] === '-' ? ' BCE' : ''}`;
  if ((value.precision || 0) < 10) return displayYear;

  const month = Number(match[3]);
  if (month < 1 || month > 12) return displayYear;
  if (value.precision === 10) return `${MONTHS[month - 1]} ${displayYear}`;

  const day = Number(match[4]);
  return day >= 1 && day <= 31
    ? `${MONTHS[month - 1]} ${day}, ${displayYear}`
    : `${MONTHS[month - 1]} ${displayYear}`;
}

function personFactsFromWikidata(claims, labels) {
  if (!itemIdsFor(claims, 'P31', 10).includes(HUMAN_ENTITY_ID)) return [];

  const facts = [];
  const birthDate = formatWikidataDate(valueFor(claims, 'P569'));
  const birthPlace = itemIdsFor(claims, 'P19', 1)[0];
  const nationalities = itemIdsFor(claims, 'P27', 2)
    .map((id) => labels[id])
    .filter(Boolean);
  const occupations = itemIdsFor(claims, 'P106', 3)
    .map((id) => labels[id])
    .filter(Boolean);
  const deathDate = formatWikidataDate(valueFor(claims, 'P570'));

  if (birthDate) facts.push({ label: 'Born', value: birthDate });
  if (birthPlace && labels[birthPlace]) facts.push({ label: 'Birthplace', value: labels[birthPlace] });
  if (nationalities.length) facts.push({ label: 'Nationality', value: nationalities.join(', ') });
  if (occupations.length) facts.push({ label: 'Occupation', value: occupations.join(', ') });
  if (deathDate) facts.push({ label: 'Died', value: deathDate });
  return facts;
}

async function additionalPersonFacts(entityId, { signal } = {}) {
  const params = new URLSearchParams({
    action: 'wbgetentities',
    ids: entityId,
    props: 'claims',
    format: 'json',
  });
  const response = await getJson(`${WIKIDATA_API}?${params}`, {
    timeout: 2200,
    retries: 0,
    signal,
    headers: { Accept: 'application/json' },
  });
  const claims = response.json?.entities?.[entityId]?.claims;
  if (!claims || !itemIdsFor(claims, 'P31', 10).includes(HUMAN_ENTITY_ID)) return [];

  const ids = [...new Set([
    ...itemIdsFor(claims, 'P19', 1),
    ...itemIdsFor(claims, 'P27', 2),
    ...itemIdsFor(claims, 'P106', 3),
  ])];
  if (!ids.length) return personFactsFromWikidata(claims, {});

  const labelParams = new URLSearchParams({
    action: 'wbgetentities',
    ids: ids.join('|'),
    props: 'labels',
    languages: 'en',
    format: 'json',
  });
  const labelResponse = await getJson(`${WIKIDATA_API}?${labelParams}`, {
    timeout: 1500,
    retries: 0,
    signal,
    headers: { Accept: 'application/json' },
  });
  const labels = Object.fromEntries(ids.map((id) => (
    [id, labelResponse.json?.entities?.[id]?.labels?.en?.value || '']
  )));
  return personFactsFromWikidata(claims, labels);
}

/**
 * Resolve a possibly percent-encoded or underscored title to the form the
 * REST summary endpoint expects. A title that is already encoded must not be
 * encoded a second time, or "100%_Pure" style titles break.
 */
function summaryPath(title) {
  const text = String(title || '').trim();
  let decoded = text;
  if (/%[0-9a-f]{2}/i.test(text)) {
    try {
      decoded = decodeURIComponent(text);
    } catch {
      decoded = text;
    }
  }
  return encodeURIComponent(decoded.replace(/\s+/g, '_'));
}

/** Look up an article summary for the given title. */
async function summary(title, { signal } = {}) {
  const response = await getJson(`${SUMMARY}/${summaryPath(title)}`, {
    timeout: 8000,
    retries: 1,
    signal,
    headers: { Accept: 'application/json' },
  });

  const data = response.json;
  if (!data || data.type === 'https://mediawiki.org/wiki/HyperSwitch/errors/not_found') {
    return null;
  }

  const personEntityId = data.wikibase_item && PERSON_DESCRIPTION.test(data.description || '')
    ? data.wikibase_item
    : '';

  return {
    title: cleanText(data.title),
    description: cleanText(data.description),
    extract: cleanText(stripTags(data.extract)),
    url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${summaryPath(title)}`,
    image: data.thumbnail?.source || data.originalimage?.source || '',
    imageAlt: cleanText(data.thumbnail?.source ? title : ''),
    personEntityId,
  };
}

/**
 * Search Wikipedia and return the best matching article.
 * Uses the search API rather than opensearch so we get relevance ordering.
 */
async function search(query, { limit = 1, signal } = {}) {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(limit),
    srnamespace: '0',
    format: 'json',
    origin: '*',
  });

  const response = await getJson(`${API}?${params.toString()}`, {
    timeout: 8000,
    retries: 1,
    signal,
    headers: { Accept: 'application/json' },
  });

  const hits = response.json?.query?.search || [];
  if (!hits.length) return null;

  const best = hits[0];
  const article = await summary(best.title, { signal }).catch(() => null);
  if (!article) return null;

  return {
    ...article,
    snippet: cleanText(best.snippet.replace(/<[^>]*>/g, '')),
  };
}

/** Title suggestions straight from the encyclopedia. */
async function opensearch(query, { limit = 10, signal } = {}) {
  const params = new URLSearchParams({
    action: 'opensearch',
    search: query,
    limit: String(limit),
    namespace: '0',
    format: 'json',
    origin: '*',
  });

  const response = await getJson(`${API}?${params.toString()}`, {
    timeout: 6000,
    retries: 0,
    signal,
    headers: { Accept: 'application/json' },
  });

  const [titles, , descriptions, urls] = response.json || [];
  return (titles || []).map((title, index) => ({
    title,
    description: cleanText(descriptions?.[index] || ''),
    url: urls?.[index] || '',
  }));
}

module.exports = {
  search,
  summary,
  opensearch,
  additionalPersonFacts,
  personFactsFromWikidata,
  formatWikidataDate,
  name: 'Wikipedia',
  id: 'wikipedia',
};
