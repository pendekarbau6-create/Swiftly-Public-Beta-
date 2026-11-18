'use strict';

(() => {

/* Browsing history: filter, open, remove individual entries, clear all. */

const { el, hostOf, faviconNode, relativeTime, go, emptyState, applyTheme } = window.swiftlyPage;
const api = window.swiftly;

const listBox = document.getElementById('list');
const subtitle = document.getElementById('subtitle');
const filterInput = document.getElementById('filter');

function rowFor(entry) {
  const row = el('div', 'list-row');
  row.appendChild(faviconNode(entry.url));

  const body = el('div', 'list-body');
  body.appendChild(el('div', 'list-title', entry.title || entry.url));
  const meta = el('div', 'list-meta');
  meta.textContent = `${hostOf(entry.url)} · ${relativeTime(entry.visitedAt)}`;
  if (entry.visitCount > 1) meta.textContent += ` · ${entry.visitCount} visits`;
  body.appendChild(meta);
  row.appendChild(body);

  const actions = el('div', 'list-actions');
  const remove = el('button', 'icon-button');
  remove.title = 'Remove from history';
  remove.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8"/></svg>';
  remove.addEventListener('click', async (event) => {
    event.stopPropagation();
    await api.history.remove(entry.id);
    row.remove();
  });
  actions.appendChild(remove);
  row.appendChild(actions);

  row.addEventListener('click', () => go(entry.url));
  return row;
}

async function render(query = '') {
  const entries = (await api.history.list(query, 400)).filter((entry) => {
    // Only real pages and search results belong in history.
    if (!entry.url.startsWith('swifty://')) return true;
    return entry.url.startsWith('swifty://search');
  });
  listBox.textContent = '';

  if (!entries.length) {
    listBox.appendChild(emptyState(
      query ? `Nothing in history matches “${query}”.` : 'No history yet — pages you visit will show up here.',
      'clock',
    ));
    subtitle.textContent = query ? '0 matches' : 'Your browsing history';
    return;
  }

  // Group by day so a long history stays readable.
  let lastDay = '';
  for (const entry of entries) {
    const day = new Date(entry.visitedAt || Date.now()).toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    if (day !== lastDay) {
      lastDay = day;
      listBox.appendChild(el('div', 'list-group', day));
    }
    listBox.appendChild(rowFor(entry));
  }
  subtitle.textContent = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
}

let filterTimer = null;
filterInput.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => render(filterInput.value.trim()), 140);
});

document.getElementById('clear').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  // Clearing history is destructive and irreversible, so require a second
  // press instead of wiping everything on one stray click.
  if (button.dataset.confirm !== 'true') {
    button.dataset.confirm = 'true';
    button.textContent = 'Click again to confirm';
    setTimeout(() => {
      button.dataset.confirm = 'false';
      button.textContent = 'Clear all';
    }, 4000);
    return;
  }
  button.dataset.confirm = 'false';
  button.textContent = 'Clear all';
  await api.history.clear();
  render(filterInput.value.trim());
});

applyTheme();
render();

})();
