(async () => {

/* The Swiftly start page: search box, top sites, recent history and engagement features. */

const { el, hostOf, colorFor, faviconNode, relativeTime, go, emptyState, applyTheme } = window.swiftlyPage;
const api = window.swiftly;

const form = document.getElementById('search-form');
const queryInput = document.getElementById('q');
const accountLink = document.getElementById('account-link');
const accountLabel = document.getElementById('account-label');
const accountAvatar = document.getElementById('account-avatar');

/** Whether following a tile or a recent page opens a new tab. */
let openInNewTab = false;

/** Follow a link the way the user asked for, honouring modifier clicks. */
function follow(url, event = {}) {
  const wantsNewTab = openInNewTab || event.ctrlKey || event.metaKey || event.button === 1;
  if (wantsNewTab) {
    window.swiftly.tabs.create(url, { background: !event.ctrlKey && !event.metaKey });
  } else {
    go(url);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = queryInput.value.trim();
  if (!value) return;
  // Let the browser's address resolver handle domains, full URLs and searches.
  go(value);
});

accountLink.addEventListener('click', () => go('swifty://account'));

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

async function renderAccountLink() {
  const account = await api.accounts.current().catch(() => null);
  if (!account) return;
  accountLabel.textContent = account.name.split(/\s+/)[0];
  accountAvatar.textContent = initials(account.name);
  accountAvatar.hidden = false;
  accountLink.setAttribute('aria-label', `Swiftly account for ${account.name}`);
}

/** A tile for a site the user visits often. */
function siteTile(site) {
  const tile = el('a', 'tile');
  tile.href = site.url;
  const icon = el('div', 'tile-icon');
  const host = hostOf(site.url);

  const image = el('img');
  image.src = `https://${host}/favicon.ico`;
  image.alt = '';
  image.addEventListener('error', () => {
    image.remove();
    icon.textContent = host.charAt(0).toUpperCase();
    icon.style.background = colorFor(host);
  });
  icon.appendChild(image);

  tile.appendChild(icon);
  tile.appendChild(el('div', 'tile-label', site.title || host));
  tile.addEventListener('click', (event) => {
    event.preventDefault();
    follow(site.url, event);
  });
  tile.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    follow(site.url, event);
  });
  tile.title = site.url;
  return tile;
}

/** A row for the recently visited list. */
function recentRow(entry) {
  const row = el('a', 'list-row');
  row.href = entry.url;
  row.appendChild(faviconNode(entry.url));

  const body = el('div', 'list-body');
  body.appendChild(el('div', 'list-title', entry.title || entry.url));
  body.appendChild(el('div', 'list-meta', `${hostOf(entry.url)} · ${relativeTime(entry.visitedAt)}`));
  row.appendChild(body);

  row.addEventListener('click', (event) => {
    event.preventDefault();
    follow(entry.url, event);
  });
  row.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    follow(entry.url, event);
  });
  return row;
}

/* ------------------------------------------------------- engagement features */

async function renderEngagement() {
  // Render streak
  const streakEl = document.getElementById('streak-count');
  if (streakEl) {
    const streak = await api.streak.get().catch(() => 0);
    streakEl.textContent = streak;
  }

  // Render searches earned
  const searchesEl = document.getElementById('searches-count');
  if (searchesEl) {
    const searches = await api.searchesEarned.get().catch(() => 0);
    searchesEl.textContent = searches;
  }

  // Render focus minutes
  const focusEl = document.getElementById('focus-minutes');
  if (focusEl) {
    const minutes = await api.focus.minutes().catch(() => 0);
    focusEl.textContent = minutes;
  }

  // Focus mode buttons
  const focusStartBtn = document.getElementById('focus-start');
  const focusStopBtn = document.getElementById('focus-stop');
  const focusStatus = document.getElementById('focus-status');
  const setFocusState = (active) => {
    focusStartBtn.disabled = active;
    focusStopBtn.disabled = !active;
    focusStatus.textContent = active ? 'Focus session in progress' : '';
    focusStatus.removeAttribute('data-error');
  };
  const showFocusError = (error) => {
    focusStatus.textContent = error.message || 'Could not update focus mode.';
    focusStatus.dataset.error = 'true';
  };

  api.focus.state().then(setFocusState).catch(showFocusError);
  api.on('swiftly:focus-minutes-changed', (minutes) => {
    if (focusEl) focusEl.textContent = minutes;
  });

  if (focusStartBtn) {
    focusStartBtn.addEventListener('click', async () => {
      focusStartBtn.disabled = true;
      try {
        const result = await api.focus.toggle({ enabled: true });
        if (result !== true) throw new Error('Focus mode could not be started.');
        setFocusState(result);
      } catch (error) {
        focusStartBtn.disabled = false;
        showFocusError(error);
      }
    });
  }

  if (focusStopBtn) {
    focusStopBtn.addEventListener('click', async () => {
      focusStopBtn.disabled = true;
      try {
        const result = await api.focus.toggle({ enabled: false });
        if (result !== false) throw new Error('Focus mode could not be stopped.');
        setFocusState(result);
      } catch (error) {
        focusStopBtn.disabled = false;
        showFocusError(error);
      }
    });
  }
}

async function render() {
  const [topSites, allHistory] = await Promise.all([
    api.history.topSites().catch(() => []),
    api.history.list('', 12).catch(() => []),
  ]);

  // Searches are worth remembering; the browser's own pages are not.
  const history = allHistory.filter((entry) => {
    if (!entry.url.startsWith('swifty://')) return true;
    return entry.url.startsWith('swifty://search');
  });

  const tiles = document.getElementById('top-sites');
  const sitesSection = document.getElementById('top-sites-section');
  if (topSites.length) {
    for (const site of topSites) tiles.appendChild(siteTile(site));
  } else {
    sitesSection.remove();
  }

  const recent = document.getElementById('recent');
  const recentSection = document.getElementById('recent-section');
  if (history.length) {
    for (const entry of history) recent.appendChild(recentRow(entry));
  } else {
    recentSection.remove();
  }
}

await applyTheme();
api.prefs.get().then((prefs) => {
  openInNewTab = Boolean(prefs.openInNewTab);
}).catch(() => {});
render();
renderAccountLink();
renderEngagement();

})();
