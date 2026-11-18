'use strict';

(() => {

/* Saved bookmarks: filter, open, remove. */

const { el, hostOf, faviconNode, go, emptyState, applyTheme } = window.swiftlyPage;
const api = window.swiftly;

const listBox = document.getElementById('list');
const subtitle = document.getElementById('subtitle');
const filterInput = document.getElementById('filter');

function rowFor(bookmark) {
  const row = el('div', 'list-row');
  row.appendChild(faviconNode(bookmark.url));

  const body = el('div', 'list-body');
  body.appendChild(el('div', 'list-title', bookmark.title || bookmark.url));
  body.appendChild(el('div', 'list-meta', hostOf(bookmark.url)));
  row.appendChild(body);

  const actions = el('div', 'list-actions');
  const remove = el('button', 'icon-button');
  remove.title = 'Remove bookmark';
  remove.innerHTML = '<svg viewBox="0 0 16 16"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8"/></svg>';
  remove.addEventListener('click', async (event) => {
    event.stopPropagation();
    await api.bookmarks.remove(bookmark.id);
    row.remove();
  });
  actions.appendChild(remove);
  row.appendChild(actions);

  row.addEventListener('click', () => go(bookmark.url));
  return row;
}

async function render(query = '') {
  const all = await api.bookmarks.list();
  const needle = query.trim().toLowerCase();
  const entries = needle
    ? all.filter((item) => item.title.toLowerCase().includes(needle) || item.url.toLowerCase().includes(needle))
    : all;

  listBox.textContent = '';

  if (!entries.length) {
    listBox.appendChild(emptyState(
      needle ? `No bookmarks match “${query}”.` : 'No bookmarks yet — press Ctrl+D on any page to save it.',
      'star',
    ));
    subtitle.textContent = 'Pages you saved';
    return;
  }

  for (const entry of entries) listBox.appendChild(rowFor(entry));
  subtitle.textContent = `${entries.length} bookmark${entries.length === 1 ? '' : 's'}`;
}

let filterTimer = null;
filterInput.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => render(filterInput.value.trim()), 140);
});

applyTheme();
render();

})();
