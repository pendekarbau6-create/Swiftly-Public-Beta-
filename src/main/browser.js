'use strict';

/**
 * Window and tab management.
 *
 * Each tab and the browser chrome are separate child `WebContentsView`s. The
 * shell reports its height, and the active page is laid out below that strip.
 */

const { BrowserWindow, WebContentsView, shell, nativeTheme, session: electronSession } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

const START_URL = 'swifty://start';
const MIN_VIEW_WIDTH = 320;
const DEFAULT_CHROME_HEIGHT = 100;
const MIN_ZOOM_LEVEL = -5;
const MAX_ZOOM_LEVEL = 5;
const HIBERNATE_AFTER_MS = 10 * 60 * 1000;

const READER_EXTRACTION_SCRIPT = `(() => {
  const root = document.querySelector('article') || document.querySelector('main') || document.body;
  const title = document.querySelector('h1')?.innerText?.trim() || document.title || location.hostname;
  const author = document.querySelector('meta[name="author"]')?.content
    || document.querySelector('[rel="author"]')?.innerText
    || '';
  const excluded = 'nav, aside, footer, header, [role="navigation"], [aria-hidden="true"]';
  const nodes = [...root.querySelectorAll('h1,h2,h3,p,blockquote,li')]
    .filter((node) => !node.closest(excluded))
    .map((node) => ({ tag: /^H[1-3]$/.test(node.tagName) ? node.tagName.toLowerCase() : 'p', text: node.innerText.trim() }))
    .filter((block) => block.text.length > 24);
  const blocks = nodes.length ? nodes : (root.innerText || '')
    .split(/\\n{2,}/)
    .map((text) => ({ tag: 'p', text: text.trim() }))
    .filter((block) => block.text.length > 40);
  const content = [];
  let length = 0;
  for (const block of blocks) {
    if (content.length >= 400 || length >= 180000) break;
    const text = block.text.slice(0, 12000);
    content.push({ tag: block.tag, text });
    length += text.length;
  }
  return { title, author: String(author).trim().slice(0, 120), source: location.href, content };
})()`;

class Tab {
  constructor(id, view, { url }) {
    this.id = id;
    this.view = view;
    this.url = url;
    this.title = '';
    this.favicon = '';
    this.loading = false;
    this.canGoBack = false;
    this.canGoForward = false;
    this.loadingFavicon = false;
    this.openerId = null;
    this.muted = false;
    this.failedUrl = '';
    this.pinned = false;
    this.audible = false;
    this.hibernated = false;
    this.hibernating = false;
    this.hibernationTimer = null;
    this.readerModeActive = false;
    this.readerSourceUrl = '';
    this.readerContent = null;
  }

  get webContents() {
    return this.view.webContents;
  }
}

class BrowserController {
  /**
   * @param {object} options
   * @param {import('./store').Store} options.store
   * @param {boolean} [options.incognito]
   */
  constructor({ store, incognito = false }) {
    this.store = store;
    this.incognito = incognito;
    this.window = null;
    this.shellView = null;
    this.tabs = [];
    this.activeTabId = null;
    this.closedTabs = [];
    this.listeners = new Set();
    this.focusModeActive = false;
    this.focusModeStartedAt = 0;
    this.focusModeMinutesRecorded = 0;
    this.focusModeTimer = null;
    // Where the shell chrome ends and the page content begins. Kept per
    // window because the bookmark bar makes it differ between windows.
    this.chromeHeight = DEFAULT_CHROME_HEIGHT;

    // An incognito window gets its own in-memory partition, so cookies and
    // storage never touch the profile or leak between sessions.
    this.session = incognito
      ? electronSession.fromPartition(`swiftly-incognito-${randomUUID()}`)
      : electronSession.defaultSession;

    if (incognito) {
      this.session.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback(['clipboard-sanitized-write', 'fullscreen'].includes(permission));
      });
      this.session.setPermissionCheckHandler((_webContents, permission) => {
        return ['clipboard-sanitized-write', 'fullscreen'].includes(permission);
      });
    }
  }

  /* ------------------------------------------------------------- events */

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {(payload:any)=>void} listener
   */
  on(event, listener) {
    const wrapped = (name, payload) => {
      if (name === event) listener(payload);
    };
    this.listeners.add(wrapped);
    return () => this.listeners.delete(wrapped);
  }

  emit(event, payload) {
    for (const listener of this.listeners) {
      try {
        listener(event, payload);
      } catch (error) {
        console.error('[swiftly] listener error:', error.message);
      }
    }
  }

  /**
   * Send a message to the shell.
   *
   * The shell lives in its own child view, not in the window's root web
   * contents, so events have to be addressed to it directly.
   */
  send(channel, payload) {
    const shell = this.shellView?.webContents;
    if (!shell || shell.isDestroyed()) return;
    shell.send(channel, payload);
  }

  /* -------------------------------------------------------------- window */

  createWindow() {
    const prefs = this.store.getPrefs();
    const stored = this.store.getSession('windowBounds');
    const bounds = this.validBounds(stored) || { width: 1280, height: 840 };

    const window = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      minWidth: MIN_VIEW_WIDTH,
      minHeight: 420,
      show: false,
      backgroundColor: prefs.theme === 'dark' || nativeTheme.shouldUseDarkColors
        ? '#14161a'
        : '#f7f7f4',
      titleBarStyle: 'hidden',
      titleBarOverlay: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'shell.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });

    this.window = window;
    this.applyWindowPrefs();

    /*
     * Keep the shell in the chrome strip only. Native child views do not pass
     * mouse events through transparent pixels, so extending this view over
     * the page would make the page look visible but leave it unclickable.
     */
    this.shellView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'shell.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
    this.shellView.setBackgroundColor('#00000000');
    window.contentView.addChildView(this.shellView);
    this.shellView.webContents.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

    /*
     * The window's own web contents stays empty — the shell lives in a child
     * view — so `ready-to-show` never fires. Wait for the shell instead.
     */
    this.shellView.webContents.once('did-finish-load', () => {
      this.shellReady = true;
      if (!window.isDestroyed()) {
        window.show();
        this.layout();
      }
    });

    window.once('ready-to-show', () => {
      if (!window.isDestroyed() && !window.isVisible()) window.show();
    });

    window.on('resize', () => this.layout());
    window.on('move', () => this.saveBounds());
    window.on('close', () => {
      this.saveBounds();
      this.saveSession();
    });
    window.on('closed', () => {
      this.finishFocusSession();
      this.focusModeActive = false;
      for (const tab of this.tabs) this.clearTabHibernateTimer(tab);
      this.window = null;
      this.shellView = null;
      this.tabs = [];
      this.activeTabId = null;
    });

    this.createTab({ url: START_URL });
    this.restoreSession();
    return window;
  }

  /** Bounds are only reused when they still sit on an attached display. */
  validBounds(bounds) {
    if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
    if (bounds.width < MIN_VIEW_WIDTH || bounds.height < 420) return null;
    const { screen } = require('electron');
    const area = screen.getDisplayMatching(bounds).workArea;
    // Require a usable slice of the title bar to stay on screen, otherwise a
    // window closed on a detached monitor would open off screen forever.
    const visible = bounds.x < area.x + area.width - 80
      && bounds.x + bounds.width > area.x + 80
      && bounds.y < area.y + area.height - 40
      && bounds.y + bounds.height > area.y;
    return visible ? bounds : { width: bounds.width, height: bounds.height };
  }

  /** Push stored preferences into the native window. */
  applyWindowPrefs() {
    if (!this.window || this.window.isDestroyed()) return;
    const prefs = this.store.getPrefs();
    nativeTheme.themeSource = prefs.theme === 'system' ? 'system' : prefs.theme;
    this.window.setBackgroundColor(
      prefs.theme === 'dark' || nativeTheme.shouldUseDarkColors ? '#14161a' : '#f7f7f4',
    );
    if (typeof this.window.setTitleBarOverlay === 'function') {
      try {
        this.window.setTitleBarOverlay({
          color: '#00000000',
          symbolColor: nativeTheme.shouldUseDarkColors ? '#c3c8d2' : '#5b6270',
          height: 40,
        });
      } catch {
        /* Not every platform supports a title bar overlay. */
      }
    }
  }

  /** Remember the open tabs so the next launch can pick them up. */
  saveSession() {
    const urls = this.tabs
      .map((tab) => tab.url)
      .filter((url) => url && url !== START_URL);
    this.store.setSession('tabs', urls.slice(-12));
  }

  /** Reopen the tabs from the previous session, if the user wants that. */
  restoreSession() {
    if (!this.store.getPrefs().restoreLastSession) return;
    const saved = this.store.getSession('tabs');
    if (!saved || !saved.length) return;

    for (const url of saved) {
      this.createTab({ url, background: true });
    }
    // Keep the start page as the active tab.
    const start = this.tabs[this.tabs.length - 1];
    if (start) this.activateTab(start.id);
  }

  saveBounds() {
    if (!this.window || this.window.isDestroyed()) return;
    const bounds = this.window.getBounds();
    this.store.setSession('windowBounds', bounds);
  }

  /** The shell renderer reports the height of its chrome. */
  setChromeHeight(height) {
    if (Number.isFinite(height) && height > 0 && height !== this.chromeHeight) {
      this.chromeHeight = height;
      this.layout();
    }
  }

  /** Apply page preferences that live on the web contents, not the window. */
  applyPagePrefs(tab) {
    if (!tab || tab.webContents.isDestroyed()) return;
    const prefs = this.store.getPrefs();
    // Zoom is stored as a per-profile value and applied to every new page.
    if (prefs.zoomLevel !== tab.appliedZoom) {
      tab.appliedZoom = prefs.zoomLevel;
      tab.webContents.setZoomLevel(prefs.zoomLevel);
    }
    if (prefs.spellcheck !== tab.appliedSpellcheck) {
      tab.appliedSpellcheck = prefs.spellcheck;
      tab.webContents.session.setSpellCheckerEnabled(prefs.spellcheck);
    }
  }

  /* ---------------------------------------------------------------- tabs */

  createTab({ url = START_URL, openerId = null, background = false, index = -1 } = {}) {
    if (!this.window) return null;

    const id = randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'page.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: true,
        backgroundThrottling: true,
        session: this.session,
        // Lets a page know which tab it is running in, so links it opens act
        // on that tab rather than whichever one happens to be active.
        additionalArguments: [`--swiftly-tab-id=${id}`],
      },
    });

    const tab = new Tab(id, view, { url });
    tab.openerId = openerId;

    this.tabs.push(tab);
    if (index >= 0 && index < this.tabs.length - 1) {
      this.tabs.splice(this.tabs.length - 1, 1);
      this.tabs.splice(index, 0, tab);
    }

    this.attachTabEvents(tab);
    // Pages start below the shell, so they can sit above it in native z-order
    // without covering the browser controls.
    this.window.contentView.addChildView(view);
    view.setVisible(false);

    this.emit('tab-created', tab);
    this.applyPagePrefs(tab);
    this.scheduleTabHibernate(tab);

    view.webContents.loadURL(url).catch((error) => {
      console.error('[swiftly] failed to load', url, error.message);
    });

    if (!background) this.activateTab(id);

    this.emit('tabs-changed', this.tabState());
    return tab;
  }

  attachTabEvents(tab) {
    const wc = tab.webContents;

    wc.on('page-title-updated', (event, title) => {
      event.preventDefault();
      tab.title = title;
      this.emit('tab-updated', this.tabSummary(tab));
    });

    wc.on('page-favicon-updated', (_event, favicons) => {
      if (favicons && favicons.length) {
        tab.favicon = favicons[0];
        this.emit('tab-updated', this.tabSummary(tab));
      }
    });

    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.emit('tab-updated', this.tabSummary(tab));
    });

    wc.on('did-stop-loading', () => {
      tab.loading = false;
      if (tab.hibernating) {
        tab.hibernating = false;
        tab.hibernated = true;
        tab.webContents.navigationHistory.clear();
        tab.canGoBack = false;
        tab.canGoForward = false;
        this.emit('tab-updated', this.tabSummary(tab));
        return;
      }
      if (tab.hibernated) return;
      this.updateNavState(tab);
      this.captureFavicon(tab);
      this.recordHistory(tab);
      this.emit('tab-updated', this.tabSummary(tab));
      this.scheduleTabHibernate(tab);
    });

    wc.on('did-start-navigation', (_event, url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      if (tab.hibernating || (tab.hibernated && url === 'about:blank')) return;
      if (tab.readerModeActive && !url.startsWith('swifty://reader')) {
        tab.readerModeActive = false;
        tab.readerSourceUrl = '';
        tab.readerContent = null;
      }
      tab.failedUrl = '';
      tab.url = url;
      this.updateNavState(tab);
      this.emit('tab-updated', this.tabSummary(tab));
    });

    wc.on('did-navigate', (_event, url) => {
      if (tab.hibernating || (tab.hibernated && url === 'about:blank')) return;
      tab.url = url;
      this.updateNavState(tab);
      this.emit('tab-updated', this.tabSummary(tab));
    });

    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (tab.readerModeActive && !url.startsWith('swifty://reader')) {
        tab.readerModeActive = false;
        tab.readerSourceUrl = '';
        tab.readerContent = null;
      }
      tab.url = url;
      this.updateNavState(tab);
      this.emit('tab-updated', this.tabSummary(tab));
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode === -3) return; // aborted by a newer navigation
      tab.loading = false;
      tab.failedUrl = validatedURL || tab.url;
      tab.error = { code: errorCode, description: errorDescription || 'This page could not load.' };
      this.emit('tab-updated', this.tabSummary(tab));
    });

    wc.on('audio-state-changed', (event) => {
      tab.audible = Boolean(event.audible);
      if (!tab.audible) this.scheduleTabHibernate(tab);
      this.emit('tab-updated', this.tabSummary(tab));
    });

    wc.setWindowOpenHandler(({ url, disposition }) => {
      // External links open in a new tab rather than a popup window.
      if (/^https?:/i.test(url) || /^swifty:/i.test(url)) {
        const background = disposition === 'background-tab';
        this.createTab({ url, openerId: tab.id, background });
      } else if (/^mailto:|^tel:/i.test(url)) {
        shell.openExternal(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    wc.on('found-in-page', (_event, result) => {
      this.emit('find-result', {
        matches: result.matches,
        activeMatch: result.activeMatchOrdinal,
        selectionArea: result.selectionArea,
      });
    });
  }

  /** Remember a visited page so it shows up in history and the start page. */
  recordHistory(tab) {
    if (this.incognito) return;
    const url = tab.url;
    if (!url) return;
    // Only real pages and search results belong in history — the browser's
    // own settings, downloads and bookmark manager are not "visits".
    if (!/^(https?:|swifty:)/i.test(url)) return;
    if (/^swifty:(?!search)/i.test(url)) return;
    if (/^https?:/i.test(url) && /^(chrome-error|about:)/i.test(url)) return;
    if (tab.failedUrl) return;

    this.store.addHistory({
      url,
      title: tab.title || url,
      kind: /^swifty:search/i.test(url) ? 'search' : 'page',
    });
  }

  /** Ask the page for its own favicon — more reliable than guessing a path. */
  captureFavicon(tab) {
    if (tab.loadingFavicon) return;
    tab.loadingFavicon = true;
    tab.webContents
      .executeJavaScript(`(() => {
        try {
          const link = document.querySelector('link[rel~="icon"][href]');
          if (link) return link.href;
          const canvas = document.querySelector('link[rel="apple-touch-icon"]');
          if (canvas) return canvas.href;
        } catch (e) {}
        return null;
      })()`, true)
      .then((favicon) => {
        if (favicon && /^https?:/i.test(favicon)) {
          tab.favicon = favicon;
          this.emit('tab-updated', this.tabSummary(tab));
        }
      })
      .catch(() => {})
      .finally(() => {
        tab.loadingFavicon = false;
      });
  }

  updateNavState(tab) {
    tab.canGoBack = tab.webContents.navigationHistory.canGoBack();
    tab.canGoForward = tab.webContents.navigationHistory.canGoForward();
  }

  activateTab(id) {
    const tab = this.tabs.find((item) => item.id === id);
    if (!tab || !this.window) return;
    // A closed window means every view is gone; nothing to activate.
    if (tab.webContents.isDestroyed()) return;

    for (const other of this.tabs) {
      other.view.setVisible(other.id === id);
    }
    // Re-add the active page at the top of the native view stack. The page
    // starts below the chrome, so this cannot cover any browser controls.
    this.window.contentView.addChildView(tab.view);
    this.activeTabId = id;
    if (tab.hibernated || tab.hibernating) this.wakeTab(tab);
    this.clearTabHibernateTimer(tab);
    this.updateTabHibernation();
    this.layout();
    tab.webContents.focus();
    this.emit('tabs-changed', this.tabState());
    this.emit('tab-activated', this.tabSummary(tab));
  }

  closeTab(id) {
    const index = this.tabs.findIndex((item) => item.id === id);
    if (index < 0) return;

    const tab = this.tabs[index];
    this.clearTabHibernateTimer(tab);
    // The start page is not a meaningful thing to "reopen".
    if (tab.url && tab.url !== START_URL) {
      this.closedTabs.push({ url: tab.url, index, title: tab.title });
      if (this.closedTabs.length > 25) this.closedTabs.shift();
    }

    if (this.window && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(tab.view);
    }
    if (!tab.webContents.isDestroyed()) tab.webContents.close();
    this.tabs.splice(index, 1);

    if (this.activeTabId === id) {
      const next = this.tabs[index] || this.tabs[index - 1] || this.tabs[0];
      this.activeTabId = next ? next.id : null;
      if (next) {
        this.activateTab(next.id);
      } else {
        this.createTab({ url: START_URL });
        return;
      }
    }

    this.emit('tabs-changed', this.tabState());
  }

  /** Re-open the most recently closed tab. */
  reopenClosedTab() {
    const last = this.closedTabs.pop();
    if (!last) return null;
    const tab = this.createTab({
      url: last.url,
      index: Math.min(last.index, this.tabs.length),
      background: true,
    });
    if (tab) this.activateTab(tab.id);
    return tab;
  }

  moveTab(id, toIndex) {
    const from = this.tabs.findIndex((item) => item.id === id);
    if (from < 0) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab);
    this.emit('tabs-changed', this.tabState());
  }

  getTab(id) {
    return this.tabs.find((item) => item.id === id) || null;
  }

  get activeTab() {
    return this.getTab(this.activeTabId);
  }

  /* ---------------------------------------------------------- navigation */

  navigate(id, url) {
    const tab = this.getTab(id) || this.activeTab;
    if (!tab) return;
    tab.hibernated = false;
    tab.hibernating = false;
    tab.hibernatedUrl = '';
    const openingReader = /^swifty:\/\/reader(?:[/?#]|$)/i.test(url) && tab.readerModeActive;
    if (!openingReader) {
      tab.readerModeActive = false;
      tab.readerSourceUrl = '';
      tab.readerContent = null;
    }
    tab.programmatic = true;
    tab.webContents.loadURL(url).catch((error) => {
      // A navigation superseded by a newer one is normal, not a failure.
      if (error.message && /ERR_ABORTED \(-3\)/.test(error.message)) return;
      console.error(`[swiftly] navigation failed (${url}): ${error.message}`);
    }).finally(() => {
      tab.programmatic = false;
    });
  }

  goBack(id) {
    const tab = this.getTab(id) || this.activeTab;
    if (tab) tab.webContents.navigationHistory.goBack();
  }

  goForward(id) {
    const tab = this.getTab(id) || this.activeTab;
    if (tab) tab.webContents.navigationHistory.goForward();
  }

  reload(id, ignoreCache = false) {
    const tab = this.getTab(id) || this.activeTab;
    if (!tab) return;
    if (tab.loading) {
      tab.webContents.stop();
      return;
    }
    if (tab.failedUrl) {
      // A failed load leaves the error page behind; retry the real URL.
      tab.failedUrl = '';
      tab.error = null;
      this.navigate(tab.id, tab.url);
      return;
    }
    if (ignoreCache) tab.webContents.reloadIgnoringCache();
    else tab.webContents.reload();
  }

  stop(id) {
    const tab = this.getTab(id) || this.activeTab;
    if (tab) tab.webContents.stop();
  }

  /* --------------------------------------------------------------- zoom */

  /** Step the shared zoom level and push it to every open tab. */
  adjustZoom(delta, id = null) {
    const prefs = this.store.getPrefs();
    const next = Math.max(MIN_ZOOM_LEVEL, Math.min(MAX_ZOOM_LEVEL, prefs.zoomLevel + delta));
    this.store.setPref('zoomLevel', next);
    for (const tab of this.tabs) {
      tab.appliedZoom = undefined;
      this.applyPagePrefs(tab);
    }
    void id;
    return next;
  }

  resetZoom() {
    this.store.setPref('zoomLevel', 0);
    for (const tab of this.tabs) {
      tab.appliedZoom = undefined;
      this.applyPagePrefs(tab);
    }
    return 0;
  }

  /** Mute or unmute a single tab. */
  setMuted(id, muted) {
    const tab = this.getTab(id) || this.activeTab;
    if (!tab) return false;
    tab.muted = Boolean(muted);
    tab.webContents.setAudioMuted(tab.muted);
    this.emit('tab-updated', this.tabSummary(tab));
    return tab.muted;
  }

  async toggleReaderMode(id) {
    const tab = this.getTab(id) || this.activeTab;
    if (!tab || tab.webContents.isDestroyed()) {
      return { ok: false, error: 'The current tab is unavailable.' };
    }

    if (tab.readerModeActive) {
      const sourceUrl = tab.readerSourceUrl;
      tab.readerModeActive = false;
      tab.readerSourceUrl = '';
      tab.readerContent = null;
      this.navigate(tab.id, sourceUrl);
      this.emit('tab-updated', this.tabSummary(tab));
      return { ok: true, enabled: false };
    }

    if (!/^https?:/i.test(tab.url)) {
      return { ok: false, error: 'Speed Reader works on web pages.' };
    }

    const sourceUrl = tab.url;
    let content;
    try {
      content = await tab.webContents.executeJavaScript(READER_EXTRACTION_SCRIPT, true);
    } catch (error) {
      return { ok: false, error: `Could not read this page: ${error.message}` };
    }
    if (!content?.content?.length) {
      return { ok: false, error: 'No readable article text was found on this page.' };
    }
    if (tab.url !== sourceUrl || tab.webContents.isDestroyed()) {
      return { ok: false, error: 'The page changed before Reader Mode could open.' };
    }

    tab.readerSourceUrl = sourceUrl;
    tab.readerContent = content;
    tab.readerModeActive = true;
    this.navigate(tab.id, `swifty://reader?tabId=${encodeURIComponent(tab.id)}`);
    this.emit('tab-updated', this.tabSummary(tab));
    return { ok: true, enabled: true };
  }

  clearTabHibernateTimer(tab) {
    if (tab?.hibernationTimer) {
      clearTimeout(tab.hibernationTimer);
      tab.hibernationTimer = null;
    }
  }

  scheduleTabHibernate(tab) {
    this.clearTabHibernateTimer(tab);
    if (!this.store.getPrefs().hibernateTabs
      || this.incognito
      || tab.id === this.activeTabId
      || tab.pinned
      || tab.audible
      || tab.readerModeActive
      || tab.hibernated
      || tab.hibernating
      || tab.loading
      || !/^https?:/i.test(tab.url)
      || tab.webContents.isDestroyed()) return;

    tab.hibernationTimer = setTimeout(() => {
      tab.hibernationTimer = null;
      this.hibernateTab(tab.id);
    }, HIBERNATE_AFTER_MS);
    tab.hibernationTimer.unref?.();
  }

  updateTabHibernation() {
    const enabled = this.store.getPrefs().hibernateTabs;
    for (const tab of this.tabs) {
      if (!enabled) {
        this.clearTabHibernateTimer(tab);
        continue;
      }
      this.scheduleTabHibernate(tab);
    }
  }

  async hibernateTab(id) {
    const tab = this.getTab(id);
    if (!tab || tab.id === this.activeTabId || tab.pinned || tab.audible
      || tab.readerModeActive || tab.hibernated || tab.hibernating
      || tab.loading || tab.webContents.isDestroyed()
      || !/^https?:/i.test(tab.url) || !this.store.getPrefs().hibernateTabs) return false;

    try {
      tab.hibernatedScroll = await tab.webContents.executeJavaScript(
        'Math.max(0, window.scrollY || document.documentElement.scrollTop || 0)',
        true,
      );
    } catch {
      tab.hibernatedScroll = 0;
    }
    if (tab.id === this.activeTabId || !this.store.getPrefs().hibernateTabs) return false;

    tab.hibernatedUrl = tab.url;
    tab.hibernating = true;
    tab.webContents.loadURL('about:blank').catch((error) => {
      tab.hibernated = false;
      tab.hibernating = false;
      tab.hibernatedUrl = '';
      console.error(`[swiftly] failed to hibernate tab ${tab.id}: ${error.message}`);
    });
    return true;
  }

  wakeTab(tab) {
    const url = tab.hibernatedUrl || tab.url;
    const scroll = Math.max(0, Number(tab.hibernatedScroll) || 0);
    tab.hibernated = false;
    tab.hibernating = false;
    tab.hibernatedUrl = '';
    tab.url = url;
    tab.loading = true;
    tab.webContents.loadURL(url).catch((error) => {
      tab.loading = false;
      tab.error = { code: 0, description: error.message || 'This page could not load.' };
      this.emit('tab-updated', this.tabSummary(tab));
    }).then(() => {
      if (!scroll || tab.webContents.isDestroyed() || tab.id !== this.activeTabId
        || tab.webContents.getURL() !== url) return;
      return tab.webContents.executeJavaScript(`window.scrollTo(0, ${scroll})`, true);
    }).catch((error) => {
      console.warn(`[swiftly] failed to restore scroll position in tab ${tab.id}: ${error.message}`);
    });
  }

  /* -------------------------------------------------------------- focus mode */
  toggleFocusMode(enabled) {
    const next = Boolean(enabled);
    if (next === this.focusModeActive) return next;

    if (next) {
      this.focusModeActive = true;
      this.focusModeStartedAt = Date.now();
      this.focusModeMinutesRecorded = 0;
      this.focusModeTimer = setInterval(() => this.recordFocusMinutes(), 10000);
    } else {
      this.finishFocusSession();
      this.focusModeActive = false;
    }

    this.send('swiftly:focus-mode-changed', this.focusModeActive);
    
    if (next) {
      // In focus mode, hibernate non-essential tabs
      this.tabs.forEach((tab) => {
        if (tab.id !== this.activeTabId && !tab.hibernated && !tab.hibernating) {
          this.hibernateTab(tab.id);
        }
      });
    } else {
      // Wake up hibernated tabs
      this.tabs.forEach((tab) => {
        if (tab.hibernated || tab.hibernating) {
          this.wakeTab(tab);
        }
      });
    }
    return this.focusModeActive;
  }

  recordFocusMinutes() {
    if (!this.focusModeActive || !this.focusModeStartedAt) return;
    const elapsed = Math.floor((Date.now() - this.focusModeStartedAt) / 60000);
    const additional = elapsed - this.focusModeMinutesRecorded;
    if (additional <= 0) return;

    const minutes = this.store.addFocusModeMinutes(additional);
    this.focusModeMinutesRecorded = elapsed;
    this.broadcastFocusMinutes(minutes);
  }

  finishFocusSession() {
    if (this.focusModeTimer) clearInterval(this.focusModeTimer);
    this.focusModeTimer = null;
    this.recordFocusMinutes();
    this.focusModeStartedAt = 0;
    this.focusModeMinutesRecorded = 0;
  }

  broadcastFocusMinutes(minutes) {
    for (const tab of this.tabs) {
      if (!tab.url.startsWith('swifty://') || tab.webContents.isDestroyed()) continue;
      tab.webContents.send('swiftly:focus-minutes-changed', minutes);
    }
  }

  /** Move the active tab one slot left or right. */
  shiftTab(id, delta) {
    const from = this.tabs.findIndex((item) => item.id === id);
    if (from < 0) return;
    const to = from + delta;
    if (to < 0 || to >= this.tabs.length) return;
    this.moveTab(id, to);
  }

  /* -------------------------------------------------------------- layout */

  layout() {
    if (!this.window || this.window.isDestroyed()) return;

    const bounds = this.window.getContentBounds();
    const width = Math.max(MIN_VIEW_WIDTH, bounds.width);
    const chrome = Math.min(this.chromeHeight, Math.max(0, bounds.height - 120));
    const height = Math.max(120, bounds.height - chrome);

    // The native shell only occupies the browser chrome. Native popup menus
    // handle dropdowns without putting an input-blocking view over the page.
    if (this.shellView) {
      this.shellView.setBounds({ x: 0, y: 0, width, height: chrome });
    }

    const tab = this.activeTab;
    if (!tab || tab.webContents.isDestroyed()) return;

    tab.view.setBounds({ x: 0, y: chrome, width, height });
  }

  /* -------------------------------------------------------------- state */

  tabSummary(tab) {
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      muted: tab.muted,
      audible: tab.audible,
      failed: Boolean(tab.failedUrl),
      error: tab.error || null,
      hibernated: tab.hibernated,
      readerModeActive: tab.readerModeActive,
    };
  }

  tabState() {
    return {
      tabs: this.tabs.map((tab) => this.tabSummary(tab)),
      activeTabId: this.activeTabId,
    };
  }
}

module.exports = { BrowserController, START_URL };
