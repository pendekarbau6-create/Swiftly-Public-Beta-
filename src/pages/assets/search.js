(async () => {

/*
 * The Swiftly search results page.
 *
 * Renders, in order: an instant answer (calculator, conversion, weather,
 * definition), a knowledge panel, the web results and related searches.
 */

const { el, hostOf, colorFor, go, emptyState, applyTheme } = window.swiftlyPage;
const api = window.swiftly;

const queryInput = document.getElementById('q');
const meta = document.getElementById('meta');
const resultHeading = document.getElementById('result-heading');
const answers = document.getElementById('answers');
const resultsBox = document.getElementById('results');
const clearQuery = document.getElementById('clear-query');
const searchForm = document.getElementById('search-form');

const params = new URLSearchParams(window.location.search);
const query = params.get('q') || '';
queryInput.value = query;
resultHeading.textContent = query ? `Results for ${query}` : 'Find your next answer';
clearQuery.hidden = !query;

document.title = `${query} — Swiftly`;
meta.textContent = query ? 'Searching…' : 'Ready when you are';
meta.classList.toggle('is-loading', Boolean(query));

/* ------------------------------------------------------------- rendering */

function renderInstant(instant) {
  if (!instant) return;

  const box = el('div', 'answer');
  box.appendChild(el('div', 'answer-label', labelFor(instant.kind)));
  box.appendChild(el('div', 'answer-value', instant.title));

  if (instant.detail) box.appendChild(el('div', 'answer-detail', instant.detail));

  if (instant.kind === 'weather' && instant.forecast?.length) {
    const row = el('div', 'answer-forecast');
    for (const day of instant.forecast) {
      const cell = el('div', 'forecast-day');
      cell.appendChild(el('div', null, new Date(day.day).toLocaleDateString(undefined, { weekday: 'short' })));
      const range = el('strong', null, `${day.high}° / ${day.low}°`);
      cell.appendChild(range);
      cell.appendChild(el('div', null, day.label));
      row.appendChild(cell);
    }
    box.appendChild(row);
  }

  if (instant.kind === 'definition' && instant.meanings?.length) {
    const list = el('dl', 'answer-meaning');
    for (const meaning of instant.meanings) {
      list.appendChild(el('dt', null, meaning.partOfSpeech));
      list.appendChild(el('dd', null, meaning.definition));
    }
    box.appendChild(list);
  }

  if (instant.kind === 'include') {
    box.classList.add('answer-include');
    const link = el('a', null, instant.title);
    link.href = `swifty://search?q=${encodeURIComponent(instant.url)}`;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      go(link.href);
    });
    box.appendChild(link);
  }

  answers.appendChild(box);
}

function labelFor(kind) {
  const labels = {
    calculation: 'Calculation',
    conversion: 'Conversion',
    weather: 'Weather',
    definition: 'Definition',
    time: 'Local time',
    include: 'Included result',
  };
  return labels[kind] || 'Answer';
}

function renderKnowledge(knowledge) {
  if (!knowledge) return;

  const panel = el('aside', 'panel');
  panel.setAttribute('aria-label', `About ${knowledge.title}`);
  const text = el('div', 'panel-text');
  text.appendChild(el('h2', 'panel-title', knowledge.title));
  if (knowledge.description) text.appendChild(el('p', 'panel-description', knowledge.description));

  if (knowledge.extract) text.appendChild(el('p', 'panel-extract', knowledge.extract));

  if (knowledge.facts?.length) appendPersonFacts(text, knowledge.facts);

  const sources = el('div', 'panel-sources');
  if (knowledge.url) sources.appendChild(sourceLink('Read more on Wikipedia', knowledge.url));
  if (knowledge.factsSource) {
    sources.appendChild(sourceLink('Wikidata facts', knowledge.factsSource));
  }
  if (sources.childElementCount) text.appendChild(sources);

  let factsStatus = null;
  if (knowledge.personEntityId && !knowledge.facts?.length) {
    factsStatus = el('p', 'panel-facts-note is-loading', 'Loading additional details…');
    factsStatus.setAttribute('role', 'status');
    text.insertBefore(factsStatus, sources.childElementCount ? sources : null);
  }

  panel.appendChild(text);

  if (knowledge.image) {
    const image = el('img', 'panel-image');
    image.src = knowledge.image;
    image.alt = knowledge.imageAlt || knowledge.title;
    panel.appendChild(image);
  }

  answers.appendChild(panel);

  if (factsStatus) {
    api.searchPersonFacts(knowledge.personEntityId).then((facts) => {
      if (!panel.isConnected) return;
      if (!Array.isArray(facts)) throw new Error('Invalid person details response');
      factsStatus.remove();
      if (!facts.length) return;
      appendPersonFacts(text, facts, sources);
      const sourceUrl = `https://www.wikidata.org/wiki/${knowledge.personEntityId}`;
      if (!Array.from(sources.querySelectorAll('a')).some((source) => source.href === sourceUrl)) {
        sources.appendChild(sourceLink('Wikidata facts', sourceUrl));
        if (!sources.isConnected) text.appendChild(sources);
      }
    }).catch(() => {
      if (!panel.isConnected) return;
      factsStatus.classList.remove('is-loading');
      factsStatus.textContent = 'Additional profile details are temporarily unavailable.';
    });
  }
}

function appendPersonFacts(container, facts, before = null) {
  const list = el('dl', 'panel-facts');
  list.setAttribute('aria-label', 'Person details');
  list.setAttribute('aria-live', 'polite');
  for (const fact of facts) {
    if (!fact?.label || !fact?.value) continue;
    const item = el('div', 'panel-fact');
    item.appendChild(el('dt', 'panel-fact-label', fact.label));
    item.appendChild(el('dd', 'panel-fact-value', fact.value));
    list.appendChild(item);
  }
  if (list.childElementCount) {
    if (before?.parentNode === container) container.insertBefore(list, before);
    else container.appendChild(list);
  }
}

function sourceLink(label, url) {
  const source = el('a', 'panel-source-link', label);
  source.href = url;
  source.addEventListener('click', (event) => {
    event.preventDefault();
    go(source.href);
  });
  return source;
}

function renderResult(result) {
  const row = el('div', 'result');

  const head = el('div', 'result-head');
  const favicon = el('span', 'result-favicon');
  const host = hostOf(result.url);
  if (host) {
    const image = el('img');
    image.src = result.favicon || `https://${host}/favicon.ico`;
    image.alt = '';
    image.addEventListener('error', () => {
      image.remove();
      favicon.textContent = host.charAt(0).toUpperCase();
      favicon.style.background = colorFor(host);
      favicon.style.color = '#fff';
      favicon.style.fontWeight = '700';
      favicon.style.display = 'grid';
      favicon.style.placeItems = 'center';
      favicon.style.fontSize = '10px';
    });
    favicon.appendChild(image);
  }
  head.appendChild(favicon);
  head.appendChild(el('span', 'result-host', result.displayUrl || host));

  if (result.date) {
    const date = el('span', 'result-date', result.date);
    head.appendChild(date);
  }
  row.appendChild(head);

  const title = el('h3', 'result-title');
  const link = el('a', 'result-link', result.title);
  link.href = result.url;
  link.addEventListener('click', (event) => {
    event.preventDefault();
    openResult(result.url, event);
  });
  link.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    openResult(result.url, event);
  });
  title.appendChild(link);
  row.appendChild(title);

  if (result.snippet) {
    row.appendChild(el('p', 'result-snippet', result.snippet));
  }

  return row;
}

/** Follow a result, honouring the "open in a new tab" preference. */
let openResultsInNewTab = false;

function openResult(url, event = {}) {
  // Middle-click and Ctrl/Cmd-click always mean "new tab", regardless of the
  // preference — that is what every browser does.
  const wantsNewTab = openResultsInNewTab || event.button === 1
    || event.ctrlKey || event.metaKey;
  if (wantsNewTab) {
    // Background tabs keep the current results page in view.
    window.swiftly.tabs.create(url, { background: !event.ctrlKey && !event.metaKey });
  } else {
    go(url);
  }
}

function renderRelated(related) {
  if (!related?.length) return;

  const section = el('section', 'related-searches');
  section.setAttribute('aria-label', 'Related searches');
  section.appendChild(el('h2', 'related-title', 'Explore related searches'));

  const list = el('div', 'related-list');
  for (const item of related) {
    const link = el('a', 'related-chip');
    link.href = `swifty://search?q=${encodeURIComponent(item.title)}`;
    link.appendChild(el('span', null, item.title));
    link.appendChild(el('span', 'related-arrow', '↗'));
    link.addEventListener('click', (event) => {
      event.preventDefault();
      go(link.href);
    });
    list.appendChild(link);
  }
  section.appendChild(list);
  resultsBox.appendChild(section);
}

/* -------------------------------------------------------------- plumbing */

function showSkeleton() {
  resultsBox.textContent = '';
  resultsBox.setAttribute('aria-busy', 'true');
  for (let i = 0; i < 4; i += 1) {
    const row = el('div', 'result');
    row.setAttribute('aria-hidden', 'true');
    row.classList.add('result-skeleton');
    row.appendChild(el('div', 'skeleton skeleton-source'));
    row.appendChild(el('div', 'skeleton skeleton-title'));
    row.appendChild(el('div', 'skeleton skeleton-copy'));
    row.appendChild(el('div', 'skeleton skeleton-copy skeleton-copy-short'));
    resultsBox.appendChild(row);
  }
}

async function runSearch() {
  if (!query) {
    resultsBox.setAttribute('aria-busy', 'false');
    resultsBox.appendChild(emptyState('Search the web, discover new ideas, and get straight to the good stuff.'));
    return;
  }
  showSkeleton();

  let payload;
  let prefs = {};
  try {
    [payload, prefs] = await Promise.all([
      api.search(query),
      api.prefs.get().catch(() => ({})),
    ]);
    if (payload?.error) throw new Error(payload.error);
  } catch (error) {
    resultsBox.textContent = '';
    const failure = el('div', 'empty');
    failure.innerHTML = '<svg viewBox="0 0 16 16"><path d="M8 2l6 11H2z"/><path d="M8 6.5v3M8 11.6v.1"/></svg><p></p>';
    failure.querySelector('p').textContent = `Search failed: ${error.message || error}`;
    resultsBox.appendChild(failure);
    resultsBox.setAttribute('aria-busy', 'false');
    meta.classList.remove('is-loading');
    meta.textContent = 'Search unavailable';
    meta.classList.add('is-error');
    return;
  }

  // The preference decides how results open, so it must be known before the
  // rows are built — reading it after rendering left the first click wrong.
  openResultsInNewTab = Boolean(prefs.openInNewTab);

  answers.textContent = '';
  resultsBox.textContent = '';
  meta.classList.remove('is-loading');

  renderInstant(payload.instant);
  renderKnowledge(payload.knowledge);

  const count = payload.results.length;
  const ms = payload.took;
  const failures = payload.failures || [];
  resultsBox.setAttribute('aria-busy', 'false');
  const unavailable = count === 0 && failures.length > 0;
  const engineName = engineLabel(prefs.searchEngine, payload.provider);
  meta.title = failures.map(({ provider, reason }) => `${provider}: ${reason}`).join('\n');
  meta.textContent = count
    ? `${count} result${count === 1 ? '' : 's'} · ${engineName} · ${ms} ms${failures.length ? ' · partial results' : ''}`
    : unavailable ? `${engineName} unavailable` : 'No results found';
  meta.classList.toggle('has-results', count > 0);
  meta.classList.toggle('is-error', unavailable);

  if (!count) {
    let message;
    if (unavailable) {
      message = `Swiftly couldn’t reach ${engineName}. Check your connection and try again.`;
    } else {
      message = `Nothing found for “${query}”. Try different words.`;
    }
    resultsBox.appendChild(emptyState(message, 'search'));
  } else {
    for (const result of payload.results) resultsBox.appendChild(renderResult(result));
  }

  renderRelated(payload.related);
}

/** Human-readable name for the engine that answered. */
function engineLabel(preference, usedProvider) {
  if (preference && preference !== 'swifty') {
    const known = { bing: 'Bing', brave: 'Brave', duckduckgo: 'DuckDuckGo', startpage: 'Startpage' };
    return known[preference] || preference;
  }
  const known = { bing: 'Bing', brave: 'Brave', duckduckgo: 'DuckDuckGo', startpage: 'Startpage' };
  return usedProvider ? `Swiftly Search · ${known[usedProvider] || usedProvider}` : 'Swiftly Search';
}

function search() {
  const value = queryInput.value.trim();
  if (!value) return;
  window.location.search = `?q=${encodeURIComponent(value)}`;
}

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  search();
});
queryInput.addEventListener('input', () => {
  clearQuery.hidden = !queryInput.value;
});
clearQuery.addEventListener('click', () => {
  queryInput.value = '';
  clearQuery.hidden = true;
  queryInput.focus();
});
document.getElementById('home').addEventListener('click', () => go('swifty://start'));
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    queryInput.focus();
    queryInput.select();
  } else if (event.key === 'Escape' && document.activeElement === queryInput) {
    queryInput.value = '';
    clearQuery.hidden = true;
  }
});

await applyTheme();
runSearch();

})();
