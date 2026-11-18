'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in',
  'i', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were', 'with',
]);
const MAX_PAGE_TEXT = 200000;

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') {
      const key = entity.toLowerCase();
      return Object.hasOwn(named, key) ? named[key] : match;
    }
    const hex = entity[1].toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return match;
    try {
      return String.fromCodePoint(code);
    } catch {
      return match;
    }
  });
}

function cleanText(value) {
  return decodeEntities(String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attributes(source) {
  const result = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = pattern.exec(source))) {
    result[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function canonicalizeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    url.hash = '';
    url.search = '';
    return url.toString();
  } catch {
    return '';
  }
}

function extractPage(html, sourceUrl, responseHeaders = {}) {
  const source = String(html || '');
  const metas = [...source.matchAll(/<meta\b([^>]*)>/gi)].map((match) => attributes(match[1]));
  const robots = metas
    .filter((meta) => ['robots', 'googlebot', 'swiftlysearchbot'].includes((meta.name || '').toLowerCase()))
    .map((meta) => meta.content || '')
    .join(',');
  const headerRules = typeof responseHeaders.get === 'function'
    ? responseHeaders.get('x-robots-tag') || ''
    : responseHeaders['x-robots-tag'] || '';
  const directives = `${robots},${headerRules}`;
  const noindex = /\b(?:noindex|none)\b/i.test(directives);
  const nofollow = /\b(?:nofollow|none)\b/i.test(directives);

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source);
  const title = cleanText(titleMatch?.[1]) || new URL(sourceUrl).hostname;
  const canonicalTag = [...source.matchAll(/<link\b([^>]*)>/gi)]
    .map((match) => attributes(match[1]))
    .find((attr) => (attr.rel || '').toLowerCase().split(/\s+/).includes('canonical'));
  let canonical = sourceUrl;
  if (canonicalTag?.href) {
    try {
      canonical = new URL(canonicalTag.href, sourceUrl).toString();
    } catch {
      canonical = sourceUrl;
    }
  }

  const body = source
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<(script|style|noscript|svg|iframe|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]+(?:hidden|aria-hidden\s*=\s*["']true["'])[^>]*>[\s\S]*?<\/[^>]+>/gi, ' ');
  const text = cleanText(body).slice(0, MAX_PAGE_TEXT);
  const links = [];
  const linkSource = source
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  for (const match of linkSource.matchAll(/<a\b([^>]*)>/gi)) {
    const attr = attributes(match[1]);
    if (attr.href) {
      links.push({
        href: attr.href,
        nofollow: (attr.rel || '').toLowerCase().split(/\s+/).includes('nofollow'),
      });
    }
  }

  return { title, text, canonical, links, noindex, nofollow };
}

function tokenize(value) {
  const words = String(value || '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.filter((word) => !STOP_WORDS.has(word));
}

function countTerms(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  return counts;
}

function makeSnippet(text, queryTerms, maxLength = 240) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (source.length <= maxLength) return source;
  const lower = source.toLowerCase();
  const positions = queryTerms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
  const matchAt = positions.length ? Math.min(...positions) : 0;
  const start = Math.max(0, Math.min(matchAt - 70, source.length - maxLength));
  const excerpt = source.slice(start, start + maxLength).trim();
  return `${start ? '…' : ''}${excerpt}${start + maxLength < source.length ? '…' : ''}`;
}

function rankPages(query, pages, limit = 10) {
  const queryTerms = [...new Set(tokenize(query))];
  if (!queryTerms.length || !pages.length) return [];

  const documents = pages.map((page) => {
    const bodyTokens = tokenize(page.text);
    const titleTokens = tokenize(page.title);
    return {
      page,
      body: countTerms(bodyTokens),
      title: countTerms(titleTokens),
      length: bodyTokens.length,
    };
  });
  const averageLength = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length || 1;
  const documentFrequency = new Map(queryTerms.map((term) => [
    term,
    documents.filter((doc) => doc.body.has(term) || doc.title.has(term)).length,
  ]));

  const ranked = [];
  for (const document of documents) {
    let score = 0;
    for (const term of queryTerms) {
      const frequency = document.body.get(term) || 0;
      const titleFrequency = document.title.get(term) || 0;
      const totalFrequency = frequency + titleFrequency * 3;
      if (!totalFrequency) continue;

      const df = documentFrequency.get(term) || 0;
      const inverseFrequency = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      const denominator = totalFrequency + 1.2 * (0.25 + 0.75 * document.length / averageLength);
      score += inverseFrequency * (totalFrequency * 2.2) / denominator;
    }
    if (score > 0) {
      ranked.push({
        title: document.page.title,
        url: document.page.url,
        snippet: makeSnippet(document.page.text, queryTerms),
        score,
      });
    }
  }

  const unique = new Map();
  for (const result of ranked.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url))) {
    if (!unique.has(result.url)) unique.set(result.url, result);
  }
  return [...unique.values()].slice(0, Math.max(1, Math.min(50, Number(limit) || 10)));
}

function defaultIndexPath() {
  const directory = process.env.SWIFTLY_SEARCH_DATA
    ? path.resolve(process.env.SWIFTLY_SEARCH_DATA)
    : path.join(os.homedir(), '.swiftly-search');
  return path.join(directory, 'index.json');
}

async function loadIndex(filePath = defaultIndexPath()) {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
    if (parsed.version !== 1 || !Array.isArray(parsed.pages)) {
      throw new Error(`Unsupported search index format: ${filePath}`);
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, updatedAt: null, pages: [] };
    throw error;
  }
}

async function saveIndex(index, filePath = defaultIndexPath()) {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(index)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
}

module.exports = {
  canonicalizeUrl,
  extractPage,
  loadIndex,
  rankPages,
  saveIndex,
  tokenize,
};
