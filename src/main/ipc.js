'use strict';

/**
 * IPC surface.
 *
 * The shell renderer and Swiftly's internal pages talk to the main process
 * through these channels. Everything that touches the network, the disk or a
 * browser window lives behind this boundary.
 */

const { ipcMain, shell, clipboard, nativeTheme, app, Menu, dialog } = require('electron');
const fs = require('node:fs');
const engine = require('../search/engine');
const { suggest } = require('../search/suggest');
const { instantAnswer } = require('../search/instant');
const bingProvider = require('../search/providers/bing');
const providers = require('../search/providers');
const { privacyShieldStatus, setBlockAdsAndTrackers } = require('./network');

/** The controller a request should act on. */
function controllerFor(controllers, tabId) {
  if (!controllers.length) return null;
  if (tabId) {
    for (const controller of controllers) {
      const tab = controller.getTab(tabId);
      if (tab) return controller;
    }
  }
  const active = controllers[0];
  return active || null;
}

/** Turn whatever the user typed into a URL, or null if it is a search. */
function resolveTarget(input, { searchPrefix = 'swifty://search?q=' } = {}) {
  const text = String(input || '').trim();
  if (!text) return null;

  // A URL with a scheme goes straight to the browser.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^about:/i.test(text) || /^data:/i.test(text)) {
    return text;
  }
  if (/^(javascript|file|chrome|devtools):/i.test(text)) return null;

  // A bare host with a dot and no spaces looks like a domain.
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text) && !/\s/.test(text)) {
    const withScheme = `https://${text}`;
    return withScheme;
  }
  if (/^localhost(:\d+)?(\/.*)?$/.test(text)) return `http://${text}`;

  // Anything else is a search query.
  return `${searchPrefix}${encodeURIComponent(text)}`;
}

function registerIpc({ store, controllers, createWindow }) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await fn(event, ...args);
      } catch (error) {
        console.error(`[swiftly] ipc ${channel} failed:`, error);
        return { error: error.message };
      }
    });
  };

  /* ------------------------------------------------------------- search */

  handle('swiftly:search', async (_event, { query, limit } = {}) => {
    const prefs = store.getPrefs();
    const onlyBing = prefs.searchEngine === 'bing';
    const known = providers.list().some((provider) => provider.id === prefs.searchEngine);
    const result = await engine.search(query, {
      limit: limit || prefs.resultsPerPage,
      safeSearch: prefs.safeSearch,
      region: prefs.region,
      providerIds: onlyBing ? ['bing']
        : known && prefs.searchEngine !== 'swifty' ? [prefs.searchEngine]
          : null,
    });
    if (query && String(query).trim()) {
      try { store.incrementSearches(1); } catch {}
      // Update daily streak and add search credits as a reward
      try { store.updateDailyStreak(); } catch {}
    }
    return result;
  });

  handle('swiftly:search.person-facts', async (event, { entityId } = {}) => {
    const senderUrl = new URL(event.sender.getURL());
    if (senderUrl.protocol !== 'swifty:' || senderUrl.hostname !== 'search') return [];
    if (typeof entityId !== 'string' || !/^Q\d+$/.test(entityId)) return [];
    const wikipedia = require('../search/providers/wikipedia');
    return wikipedia.additionalPersonFacts(entityId);
  });

  handle('swiftly:suggest', async (_event, { query } = {}) => {
    if (!store.getPrefs().showSuggestions) return [];
    return suggest(query);
  });

  handle('swiftly:instant', async (_event, { query } = {}) => instantAnswer(query));

  handle('swiftly:search.status', async () => engine.status());

  handle('swiftly:search.providers', async () => providers.list().map((provider) => ({
    id: provider.id,
    name: provider.name,
  })));

  handle('swiftly:search.reset', async () => {
    // Reset every provider that keeps session state, not just Bing.
    for (const provider of providers.list()) {
      if (typeof provider.reset === 'function') provider.reset();
    }
    bingProvider.reset();
    engine.resultsCache.clear();
    return engine.status();
  });

  /* ------------------------------------------------------------ history */

  handle('swiftly:history.list', async (_event, { query, limit } = {}) => {
    return store.listHistory({ query, limit: limit || 300 });
  });

  handle('swiftly:history.add', async (_event, entry = {}) => {
    return store.addHistory(entry);
  });

  handle('swiftly:history.delete', async (_event, { id } = {}) => {
    store.deleteHistory(id);
    return true;
  });

  handle('swiftly:history.clear', async () => {
    store.clearHistory();
    return true;
  });

  handle('swiftly:history.topsites', async () => store.topSites(8));

  /* ---------------------------------------------------------- bookmarks */

  handle('swiftly:bookmarks.list', async () => store.listBookmarks());

  handle('swiftly:bookmarks.add', async (_event, entry = {}) => {
    return store.addBookmark(entry);
  });

  handle('swiftly:bookmarks.remove', async (_event, { id } = {}) => {
    return store.removeBookmark(id);
  });

  handle('swiftly:bookmarks.toggle', async (_event, entry = {}) => {
    const existing = store.findBookmarkByUrl(entry.url);
    if (existing) {
      store.removeBookmark(existing.id);
      return { bookmarked: false };
    }
    store.addBookmark(entry);
    return { bookmarked: true };
  });

  /* ---------------------------------------------------------- reading list */

  handle('swiftly:reading.list', async () => store.listReadingList());

  handle('swiftly:reading.add', async (_event, { url, title, excerpt } = {}) => {
    return store.addToReadingList({ url, title, excerpt });
  });

  handle('swiftly:reading.remove', async (_event, { id } = {}) => {
    return store.removeFromReadingList(id);
  });

  handle('swiftly:reading.markread', async (_event, { id } = {}) => {
    return store.markReadInReadingList(id);
  });

  /* --------------------------------------------------------------- streak / rewards */
  handle('swiftly:streak.get', async () => store.getDailyStreak());

  handle('swiftly:streak.update', async () => {
    const streak = store.updateDailyStreak();
    // Add searches earned as a reward
    store.addSearchesEarned(1);
    return { streak, searchesEarned: store.getSearchesEarned() };
  });

  handle('swiftly:searchesearned.get', async () => store.getSearchesEarned());

  handle('swiftly:searchesearned.add', async (_event, { amount } = {}) => {
    return store.addSearchesEarned(amount);
  });

  handle('swiftly:searchesearned.spend', async (_event, { amount } = {}) => {
    const success = store.spendSearchesEarned(amount);
    return { success, searchesEarned: store.getSearchesEarned() };
  });

  handle('swiftly:focus.minutes', async () => store.getFocusModeMinutes());

  handle('swiftly:focus.add', async (_event, { minutes } = {}) => {
    return store.addFocusModeMinutes(minutes);
  });

  /* --------------------------------------------------------------- account */
  handle('swiftly:account.current', async () => store.currentAccount());
  handle('swiftly:account.signup', async (_event, { name, email, password } = {}) => {
    return store.createAccount({ name, email, password });
  });
  handle('swiftly:account.login', async (_event, { email, password } = {}) => {
    return store.loginAccount({ email, password });
  });
  handle('swiftly:account.logout', async () => {
    store.logoutAccount();
    return true;
  });

  /* --------------------------------------------------------------- store */
  handle('swiftly:store.catalog', async () => {
    const { THEMES, EXTENSIONS } = require('./catalog');
    const searches = store.getSearches();
    const purchased = new Set(store.listPurchasedThemes());
    const installed = new Set(store.listInstalledExtensions());
    const enabled = new Set(store.listEnabledExtensions());
    const activeTheme = store.getActiveTheme();
    return {
      searches,
      activeTheme,
      themes: THEMES.map((theme) => ({
        id: theme.id,
        name: theme.name,
        description: theme.description,
        cost: theme.cost,
        mode: theme.mode,
        accent: theme.accent,
        owned: purchased.has(theme.id),
        active: activeTheme === theme.id,
        vars: theme.vars,
      })),
      extensions: EXTENSIONS.map((ext) => ({
        id: ext.id,
        name: ext.name,
        description: ext.description,
        installed: installed.has(ext.id),
        enabled: enabled.has(ext.id),
      })),
    };
  });

  handle('swiftly:theme.purchase', async (_event, { id } = {}) => {
    const { THEMES } = require('./catalog');
    const theme = THEMES.find((item) => item.id === id);
    if (!theme) return { error: 'Unknown theme' };
    if (store.ownsTheme(id)) return { ok: true, searches: store.getSearches(), alreadyOwned: true };
    if (!store.spendSearches(theme.cost)) {
      return { error: 'Not enough searches', searches: store.getSearches(), cost: theme.cost };
    }
    store.purchaseTheme(id);
    return { ok: true, searches: store.getSearches() };
  });

  handle('swiftly:theme.apply', async (_event, { id } = {}) => {
    const { THEMES } = require('./catalog');
    const theme = THEMES.find((item) => item.id === id);
    if (!theme) return { error: 'Unknown theme' };
    if (!store.ownsTheme(id)) return { error: 'Theme not owned' };
    const prefs = store.setActiveTheme(id);
    // Keep prefs.theme in sync with the theme's mode for native chrome.
    if (theme.mode === 'light' || theme.mode === 'dark') {
      store.setPref('theme', theme.mode);
    } else {
      store.setPref('theme', 'system');
    }
    const finalPrefs = store.getPrefs();
    for (const controller of controllers) {
      controller.applyWindowPrefs();
      for (const tab of controller.tabs) {
        tab.appliedZoom = undefined;
        tab.appliedSpellcheck = undefined;
        controller.applyPagePrefs(tab);
      }
      controller.send('swiftly:prefs-changed', finalPrefs);
    }
    return finalPrefs;
  });

  handle('swiftly:extension.install', async (_event, { id } = {}) => {
    const { EXTENSIONS } = require('./catalog');
    if (!EXTENSIONS.some((item) => item.id === id)) return { error: 'Unknown extension' };
    store.installExtension(id);
    return { ok: true };
  });

  handle('swiftly:extension.uninstall', async (_event, { id } = {}) => {
    const { EXTENSIONS } = require('./catalog');
    const ext = EXTENSIONS.find((item) => item.id === id);
    if (!ext) return { error: 'Unknown extension' };
    if (ext.builtin) return { error: 'Cannot remove a built-in extension' };
    store.uninstallExtension(id);
    return { ok: true };
  });

  handle('swiftly:extension.toggle', async (_event, { id, enabled } = {}) => {
    store.toggleExtension(id, Boolean(enabled));
    if (id === 'ad-shield') {
      store.setPref('blockAdsAndTrackers', Boolean(enabled));
      broadcastPrefs(store.getPrefs());
    }
    return { ok: true, enabled: store.isExtensionEnabled(id) };
  });

  handle('swiftly:privacy.status', async () => (
    privacyShieldStatus(store.getPrefs().blockAdsAndTrackers)
  ));

  handle('swiftly:reader.toggle', async (event, { tabId } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (!controller) return { ok: false, error: 'No browser window is available.' };
    return controller.toggleReaderMode(tabId);
  });

  handle('swiftly:reader.content', async (event, { tabId } = {}) => {
    const controller = controllerFor(controllers, tabId);
    const tab = controller?.getTab(tabId);
    if (!tab || event.sender !== tab.webContents || !event.sender.getURL().startsWith('swifty://reader')) {
      throw new Error('Reader content is only available to its owning reader tab.');
    }
    return tab.readerContent;
  });
  /* ---------------------------------------------------------- downloads */

  handle('swiftly:downloads.list', async () => store.listDownloads());

  handle('swiftly:downloads.clear', async () => {
    store.clearDownloads();
    return true;
  });

  handle('swiftly:downloads.show', async (_event, { savePath } = {}) => {
    if (savePath) shell.showItemInFolder(savePath);
    return true;
  });

  handle('swiftly:downloads.open', async (_event, { savePath } = {}) => {
    if (!savePath) return false;
    const error = await shell.openPath(savePath);
    return error ? { error } : true;
  });

  handle('swiftly:downloads.chooseFolder', async (event) => {
    const controller = controllers.find((item) => item.shellView?.webContents === event.sender);
    const parent = controller?.window && !controller.window.isDestroyed() ? controller.window : null;
    const current = store.getPrefs().downloadDirectory;
    const result = await dialog.showOpenDialog(parent, {
      title: 'Choose where downloads are saved',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current && fs.existsSync(current) ? current : app.getPath('downloads'),
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  /* -------------------------------------------------------------- prefs */

  handle('swiftly:prefs.get', async () => store.getPrefs());

  handle('swiftly:prefs.set', async (_event, { key, value } = {}) => {
    const prefs = store.setPref(key, value);
    broadcastPrefs(prefs);
    return prefs;
  });

  handle('swiftly:prefs.reset', async () => {
    const prefs = store.resetPrefs();
    broadcastPrefs(prefs);
    return prefs;
  });

  function broadcastPrefs(prefs) {
    nativeTheme.themeSource = prefs.theme === 'system' ? 'system' : prefs.theme;
    setBlockAdsAndTrackers(prefs.blockAdsAndTrackers !== false);
    for (const controller of controllers) {
      controller.applyWindowPrefs();
      controller.updateTabHibernation();
      for (const tab of controller.tabs) {
        tab.appliedZoom = undefined;
        tab.appliedSpellcheck = undefined;
        controller.applyPagePrefs(tab);
      }
      controller.send('swiftly:prefs-changed', prefs);
    }
  }

  /* --------------------------------------------------------------- tabs */

  handle('swiftly:tabs.state', async () => {
    const controller = controllers[0];
    return controller ? controller.tabState() : { tabs: [], activeTabId: null };
  });

  handle('swiftly:tabs.create', async (_event, { url, tabId, background } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (!controller) return null;
    const target = url ? resolveTarget(url) : 'swifty://start';
    const tab = controller.createTab({ url: target, background: Boolean(background) });
    return tab ? controller.tabSummary(tab) : null;
  });

  handle('swiftly:tabs.close', async (_event, { tabId } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (controller) controller.closeTab(tabId);
    return true;
  });

  handle('swiftly:tabs.activate', async (_event, { tabId } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (controller) controller.activateTab(tabId);
    return true;
  });

  handle('swiftly:tabs.move', async (_event, { tabId, index } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (controller) controller.moveTab(tabId, index);
    return true;
  });

  handle('swiftly:tabs.navigate', async (_event, { tabId, url } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (!controller) return false;
    const target = resolveTarget(url);
    if (!target) return false;
    controller.navigate(tabId, target);
    return true;
  });

  handle('swiftly:tabs.back', async (_event, { tabId } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (controller) controller.goBack(tabId);
    return true;
  });

  handle('swiftly:tabs.forward', async (_event, { tabId } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (controller) controller.goForward(tabId);
    return true;
  });

  handle('swiftly:tabs.reload', async (_event, { tabId, hard } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (controller) controller.reload(tabId, Boolean(hard));
    return true;
  });

  handle('swiftly:tabs.stop', async (_event, { tabId } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (controller) controller.stop(tabId);
    return true;
  });

  handle('swiftly:tabs.reopenClosed', async () => {
    const controller = controllers[0];
    if (controller) controller.reopenClosedTab();
    return true;
  });

  handle('swiftly:tabs.mute', async (_event, { tabId, muted } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (!controller) return false;
    return controller.setMuted(tabId, muted);
  });

  handle('swiftly:tabs.duplicate', async (_event, { tabId } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    const tab = controller?.getTab(tabId);
    if (!controller || !tab) return null;
    const index = controller.tabs.findIndex((item) => item.id === tabId);
    const created = controller.createTab({ url: tab.url, index: index + 1, background: true });
    return created ? controller.tabSummary(created) : null;
  });

  handle('swiftly:tabs.shift', async (_event, { tabId, delta } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (controller) controller.shiftTab(tabId, Number(delta) < 0 ? -1 : 1);
    return true;
  });

  handle('swiftly:tabs.copyUrl', async (_event, { url } = {}) => {
    clipboard.writeText(String(url || ''));
    return true;
  });

  /* ---------------------------------------------------------------- zoom */

  handle('swiftly:zoom.change', async (_event, { delta, tabId } = {}) => {
    const controller = controllerFor(controllers, tabId) || controllers[0];
    if (!controller) return 0;
    return controller.adjustZoom(Number(delta) || 0, tabId);
  });

  handle('swiftly:zoom.get', async () => store.getPrefs().zoomLevel);

  handle('swiftly:zoom.reset', async () => {
    const controller = controllers[0];
    return controller ? controller.resetZoom() : 0;
  });

  /* --------------------------------------------------------- focus mode */
  handle('swiftly:focus.toggle', async (_event, { enabled } = {}) => {
    const controller = controllers[0];
    if (!controller) return false;
    return controller.toggleFocusMode(enabled);
  });

  handle('swiftly:focus.state', async () => {
    const controller = controllers[0];
    return controller ? controller.focusModeActive : false;
  });

  /* --------------------------------------------------------- find in page */

  handle('swiftly:find.start', async (_event, { text, forward } = {}) => {
    const controller = controllerFor(controllers) || controllers[0];
    const tab = controller?.activeTab;
    if (!tab || !text) return false;
    tab.webContents.findInPage(text, { forward: forward !== false });
    return true;
  });

  handle('swiftly:find.next', async (_event, { text, forward } = {}) => {
    const controller = controllerFor(controllers) || controllers[0];
    const tab = controller?.activeTab;
    if (!tab || !text) return false;
    tab.webContents.findInPage(text, { forward: forward !== false, findNext: true });
    return true;
  });

  handle('swiftly:find.stop', async () => {
    const controller = controllerFor(controllers) || controllers[0];
    const tab = controller?.activeTab;
    if (tab) tab.webContents.stopFindInPage('clearSelection');
    return true;
  });

  /* ------------------------------------------------------------- window */

  handle('swiftly:window.new', async () => {
    createWindow();
    return true;
  });

  handle('swiftly:window.incognito', async () => {
    createWindow({ incognito: true });
    return true;
  });

  handle('swiftly:chrome.height', async (_event, { height } = {}) => {
    // Only the window that owns this shell should be relaid out; other
    // windows may show a different bookmark bar.
    const owner = controllers.find((item) => item.shellView?.webContents === _event.sender);
    if (owner) owner.setChromeHeight(height);
    return true;
  });

  handle('swiftly:window.close', async (event) => {
    const owner = controllers.find((item) => item.shellView?.webContents === event.sender);
    const window = owner?.window;
    if (window && !window.isDestroyed()) window.close();
    return true;
  });

  handle('swiftly:window.minimize', async (event) => {
    const owner = controllers.find((item) => item.shellView?.webContents === event.sender);
    const window = owner?.window;
    if (window && !window.isDestroyed()) window.minimize();
    return true;
  });

  handle('swiftly:window.maximize', async (event) => {
    const owner = controllers.find((item) => item.shellView?.webContents === event.sender);
    const window = owner?.window;
    if (!window || window.isDestroyed()) return false;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return window.isMaximized();
  });

  handle('swiftly:popup.menu', async (event, payload = {}) => {
    const controller = controllers.find((item) => item.shellView?.webContents === event.sender);
    if (!controller?.window || controller.window.isDestroyed()) return false;

    const kind = ['suggestions', 'tab'].includes(payload.kind) ? payload.kind : 'browser-menu';
    const items = Array.isArray(payload.items) ? payload.items.slice(0, 24) : [];
    const template = items.map((item, index) => {
      if (item?.separator) return { type: 'separator' };
      const label = String(item?.label || '').trim().slice(0, 160);
      if (!label) return { type: 'separator' };

      return {
        label,
        type: item.checked === undefined ? 'normal' : 'checkbox',
        checked: item.checked === undefined ? undefined : Boolean(item.checked),
        click: () => {
          if (kind === 'suggestions') {
            const text = String(item?.text || '').trim();
            const target = item?.url ? resolveTarget(item.url) : resolveTarget(text);
            if (target) controller.navigate(controller.activeTabId, target);
            return;
          }
          controller.send('swiftly:menu-selected', { index, kind, value: item?.value });
        },
      };
    });

    if (!template.length || template.every((item) => item.type === 'separator')) return false;
    const menu = Menu.buildFromTemplate(template);
    const x = Number.isFinite(payload.x) ? Math.round(payload.x) : undefined;
    const y = Number.isFinite(payload.y) ? Math.round(payload.y) : undefined;
    menu.popup({
      window: controller.window,
      x,
      y,
      callback: () => controller.send('swiftly:menu-closed', { kind }),
    });
    return true;
  });

  handle('swiftly:external.open', async (_event, { url } = {}) => {
    if (/^https?:/i.test(url || '')) {
      await shell.openExternal(url);
      return true;
    }
    return false;
  });

  handle('swiftly:clipboard.write', async (_event, { text } = {}) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  handle('swiftly:clipboard.read', async () => clipboard.readText());

  handle('swiftly:app.info', async () => ({
    name: 'Swiftly',
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
  }));
}

module.exports = { registerIpc, resolveTarget };
