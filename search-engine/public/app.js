'use strict';

const form = document.getElementById('search-form');
const input = document.getElementById('query');
const submit = document.getElementById('submit');
const status = document.getElementById('status');
const results = document.getElementById('results');
const emptyIndex = document.getElementById('empty-index');
const indexStats = document.getElementById('index-stats');

function renderResults(items) {
  results.replaceChildren();
  for (const item of items) {
    let destination;
    try {
      destination = new URL(item.url);
      if (!['http:', 'https:'].includes(destination.protocol)) continue;
    } catch {
      continue;
    }

    const card = document.createElement('article');
    card.className = 'result';

    const url = document.createElement('p');
    url.className = 'result-url';
    url.textContent = destination.hostname + destination.pathname;

    const title = document.createElement('a');
    title.className = 'result-title';
    title.href = destination.href;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.textContent = item.title || destination.hostname;

    const snippet = document.createElement('p');
    snippet.className = 'result-snippet';
    snippet.textContent = item.snippet || '';

    card.append(url, title, snippet);
    results.append(card);
  }
}

async function updateStats() {
  try {
    const response = await fetch('/api/stats');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const stats = await response.json();
    indexStats.textContent = `${stats.indexedPages} indexed ${stats.indexedPages === 1 ? 'page' : 'pages'}`;
    emptyIndex.hidden = stats.indexedPages > 0;
  } catch {
    indexStats.textContent = 'Could not load index status';
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (!query) {
    status.textContent = 'Enter a search term.';
    input.focus();
    return;
  }

  submit.disabled = true;
  status.textContent = 'Searching your local index…';
  results.replaceChildren();
  try {
    const params = new URLSearchParams({ q: query });
    const response = await fetch(`/api/search?${params}`);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);

    renderResults(payload.results);
    status.textContent = payload.total
      ? `${payload.total} ${payload.total === 1 ? 'result' : 'results'} for “${payload.query}”`
      : `No indexed pages matched “${payload.query}”.`;
    history.replaceState(null, '', `/?${params}`);
    emptyIndex.hidden = payload.indexedPages > 0;
  } catch (error) {
    status.textContent = `Search failed: ${error.message}`;
  } finally {
    submit.disabled = false;
  }
});

const initialQuery = new URLSearchParams(location.search).get('q') || '';
if (initialQuery) {
  input.value = initialQuery;
  form.requestSubmit();
}
updateStats();
