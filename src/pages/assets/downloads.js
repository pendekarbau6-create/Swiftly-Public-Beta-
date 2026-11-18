'use strict';

(() => {

/* Download manager: progress, size, state, open and reveal-in-folder. */

const { el, formatBytes, relativeTime, emptyState, applyTheme } = window.swiftlyPage;
const api = window.swiftly;

const listBox = document.getElementById('list');
const subtitle = document.getElementById('subtitle');

/** A download that is still running changes size while the page is open. */
const ACTIVE_STATES = new Set(['progressing', 'paused']);

function progressFor(record) {
  if (!record.totalBytes) return null;
  return Math.min(100, Math.max(0, Math.round((record.receivedBytes / record.totalBytes) * 100)));
}

function stateLabel(record) {
  switch (record.state) {
    case 'completed': return 'Completed';
    case 'cancelled': return 'Cancelled';
    case 'paused': return 'Paused';
    case 'interrupted': return 'Interrupted';
    default: return 'Downloading';
  }
}

function rowFor(record) {
  const row = el('div', 'list-row');
  if (ACTIVE_STATES.has(record.state)) row.classList.add('active');

  const icon = el('span', 'list-icon');
  icon.innerHTML = '<svg viewBox="0 0 16 16"><path d="M8 2v8m0 0L5 7m3 3l3-3"/><path d="M2.5 12.5h11"/></svg>';
  row.appendChild(icon);

  const body = el('div', 'list-body');
  body.appendChild(el('div', 'list-title', record.filename || record.url));
  const meta = el('div', 'list-meta');

  const parts = [stateLabel(record)];
  if (record.totalBytes) {
    parts.push(`${formatBytes(record.receivedBytes)} of ${formatBytes(record.totalBytes)}`);
  } else if (record.receivedBytes) {
    parts.push(formatBytes(record.receivedBytes));
  }
  parts.push(relativeTime(record.startedAt));
  meta.textContent = parts.join(' · ');
  body.appendChild(meta);

  const progress = progressFor(record);
  if (progress !== null && ACTIVE_STATES.has(record.state)) {
    const bar = el('div', 'skeleton');
    bar.style.height = '4px';
    bar.style.marginTop = '6px';
    bar.style.width = `${progress}%`;
    bar.style.background = 'var(--accent)';
    bar.style.animation = 'none';
    body.appendChild(bar);
  }

  row.appendChild(body);

  // Completed downloads can be opened; everything with a path can be revealed.
  if (record.savePath && record.state !== 'cancelled') {
    const actions = el('div', 'list-actions');
    if (record.state === 'completed') {
      const open = el('button', 'icon-button');
      open.title = 'Open file';
      open.innerHTML = '<svg viewBox="0 0 16 16"><path d="M6 3.5H3.5v9h9V10"/><path d="M9 2.5h4.5V7"/><path d="M13.5 2.5L7.5 8.5"/></svg>';
      open.addEventListener('click', async (event) => {
        event.stopPropagation();
        const result = await api.downloads.open(record.savePath);
        if (result && result.error) subtitle.textContent = `Could not open the file: ${result.error}`;
      });
      actions.appendChild(open);
    }

    const reveal = el('button', 'icon-button');
    reveal.title = 'Show in folder';
    reveal.innerHTML = '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h4l1.5 2h5.5v6h-11z"/></svg>';
    reveal.addEventListener('click', (event) => {
      event.stopPropagation();
      api.downloads.show(record.savePath);
    });
    actions.appendChild(reveal);
    row.appendChild(actions);
  }

  return row;
}

async function render() {
  const records = await api.downloads.list();
  listBox.textContent = '';

  if (!records.length) {
    listBox.appendChild(emptyState('No downloads yet.', 'down'));
    subtitle.textContent = 'Files you have downloaded';
    return;
  }

  for (const record of records) listBox.appendChild(rowFor(record));
  subtitle.textContent = `${records.length} download${records.length === 1 ? '' : 's'}`;
}

document.getElementById('clear').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  if (button.dataset.confirm !== 'true') {
    button.dataset.confirm = 'true';
    button.textContent = 'Click again to confirm';
    setTimeout(() => {
      button.dataset.confirm = 'false';
      button.textContent = 'Clear list';
    }, 4000);
    return;
  }
  button.dataset.confirm = 'false';
  button.textContent = 'Clear list';
  await api.downloads.clear();
  render();
});

applyTheme();
render();

// A download started from another tab should show up here without a reload.
setInterval(() => {
  if (document.hidden) return;
  api.downloads.list().then((records) => {
    if (records.some((record) => ACTIVE_STATES.has(record.state))) render();
  }).catch(() => {});
}, 1200);

})();
