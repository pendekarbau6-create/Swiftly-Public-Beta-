'use strict';

/**
 * The API surface exposed to renderers.
 *
 * Shared by the shell (the tab strip and address bar) and by Swiftly's own
 * pages. External websites never receive this — the page preload only exposes
 * it for the `swifty:` scheme.
 */

const { ipcRenderer } = require('electron');

/** Events the main process is allowed to push to a renderer. */
const EVENT_CHANNELS = [
  'swiftly:tabs-changed',
  'swiftly:tab-updated',
  'swiftly:tab-activated',
  'swiftly:prefs-changed',
  'swiftly:bookmark-added',
  'swiftly:incognito',
  'swiftly:download-added',
  'swiftly:find-result',
  'swiftly:find-open',
  'swiftly:find-step',
  'swiftly:focus-omnibox',
  'swiftly:menu-selected',
  'swiftly:menu-closed',
  'swiftly:toast',
  'swiftly:zoom-changed',
  'swiftly:focus-minutes-changed',
];

function buildApi() {
  const on = (channel, listener) => {
    if (!EVENT_CHANNELS.includes(channel)) {
      throw new Error(`Unknown channel: ${channel}`);
    }
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  };

  return {
    search: (query, options = {}) => ipcRenderer.invoke('swiftly:search', { query, ...options }),
    searchPersonFacts: (entityId) => ipcRenderer.invoke('swiftly:search.person-facts', { entityId }),
    suggest: (query) => ipcRenderer.invoke('swiftly:suggest', { query }),
    instant: (query) => ipcRenderer.invoke('swiftly:instant', { query }),
    searchStatus: () => ipcRenderer.invoke('swiftly:search.status'),
    searchProviders: () => ipcRenderer.invoke('swiftly:search.providers'),
    resetSearchSession: () => ipcRenderer.invoke('swiftly:search.reset'),

    history: {
      list: (query, limit) => ipcRenderer.invoke('swiftly:history.list', { query, limit }),
      add: (entry) => ipcRenderer.invoke('swiftly:history.add', entry),
      remove: (id) => ipcRenderer.invoke('swiftly:history.delete', { id }),
      clear: () => ipcRenderer.invoke('swiftly:history.clear'),
      topSites: () => ipcRenderer.invoke('swiftly:history.topsites'),
    },

    bookmarks: {
      list: () => ipcRenderer.invoke('swiftly:bookmarks.list'),
      add: (entry) => ipcRenderer.invoke('swiftly:bookmarks.add', entry),
      remove: (id) => ipcRenderer.invoke('swiftly:bookmarks.remove', { id }),
      toggle: (entry) => ipcRenderer.invoke('swiftly:bookmarks.toggle', entry),
    },

    reading: {
      list: () => ipcRenderer.invoke('swiftly:reading.list'),
      add: ({ url, title, excerpt }) => ipcRenderer.invoke('swiftly:reading.add', { url, title, excerpt }),
      remove: (id) => ipcRenderer.invoke('swiftly:reading.remove', { id }),
      markRead: (id) => ipcRenderer.invoke('swiftly:reading.markread', { id }),
    },

    accounts: {
      current: () => ipcRenderer.invoke('swiftly:account.current'),
      signup: (details) => ipcRenderer.invoke('swiftly:account.signup', details),
      login: (details) => ipcRenderer.invoke('swiftly:account.login', details),
      logout: () => ipcRenderer.invoke('swiftly:account.logout'),
    },

    downloads: {
      list: () => ipcRenderer.invoke('swiftly:downloads.list'),
      clear: () => ipcRenderer.invoke('swiftly:downloads.clear'),
      show: (savePath) => ipcRenderer.invoke('swiftly:downloads.show', { savePath }),
      open: (savePath) => ipcRenderer.invoke('swiftly:downloads.open', { savePath }),
      chooseFolder: () => ipcRenderer.invoke('swiftly:downloads.chooseFolder'),
    },

    prefs: {
      get: () => ipcRenderer.invoke('swiftly:prefs.get'),
      set: (key, value) => ipcRenderer.invoke('swiftly:prefs.set', { key, value }),
      reset: () => ipcRenderer.invoke('swiftly:prefs.reset'),
    },

    tabs: {
      state: () => ipcRenderer.invoke('swiftly:tabs.state'),
      create: (url, options = {}) => ipcRenderer.invoke('swiftly:tabs.create', { url, ...options }),
      close: (tabId) => ipcRenderer.invoke('swiftly:tabs.close', { tabId }),
      activate: (tabId) => ipcRenderer.invoke('swiftly:tabs.activate', { tabId }),
      move: (tabId, index) => ipcRenderer.invoke('swiftly:tabs.move', { tabId, index }),
      navigate: (tabId, url) => ipcRenderer.invoke('swiftly:tabs.navigate', { tabId, url }),
      back: (tabId) => ipcRenderer.invoke('swiftly:tabs.back', { tabId }),
      forward: (tabId) => ipcRenderer.invoke('swiftly:tabs.forward', { tabId }),
      reload: (tabId, hard) => ipcRenderer.invoke('swiftly:tabs.reload', { tabId, hard }),
      stop: (tabId) => ipcRenderer.invoke('swiftly:tabs.stop', { tabId }),
      reopenClosed: () => ipcRenderer.invoke('swiftly:tabs.reopenClosed'),
      duplicate: (tabId) => ipcRenderer.invoke('swiftly:tabs.duplicate', { tabId }),
      mute: (tabId, muted) => ipcRenderer.invoke('swiftly:tabs.mute', { tabId, muted }),
      shift: (tabId, delta) => ipcRenderer.invoke('swiftly:tabs.shift', { tabId, delta }),
      copyUrl: (url) => ipcRenderer.invoke('swiftly:tabs.copyUrl', { url }),
    },

    privacy: {
      status: () => ipcRenderer.invoke('swiftly:privacy.status'),
    },
    reader: {
      toggle: (tabId) => ipcRenderer.invoke('swiftly:reader.toggle', { tabId }),
      content: (tabId) => ipcRenderer.invoke('swiftly:reader.content', { tabId }),
    },

    zoom: {
      get: () => ipcRenderer.invoke('swiftly:zoom.get'),
      change: (delta, tabId) => ipcRenderer.invoke('swiftly:zoom.change', { delta, tabId }),
      reset: () => ipcRenderer.invoke('swiftly:zoom.reset'),
    },

    window: {
      new: () => ipcRenderer.invoke('swiftly:window.new'),
      incognito: () => ipcRenderer.invoke('swiftly:window.incognito'),
      close: () => ipcRenderer.invoke('swiftly:window.close'),
      minimize: () => ipcRenderer.invoke('swiftly:window.minimize'),
      maximize: () => ipcRenderer.invoke('swiftly:window.maximize'),
    },

    setChromeHeight: (height) => ipcRenderer.invoke('swiftly:chrome.height', { height }),
    popupMenu: (payload) => ipcRenderer.invoke('swiftly:popup.menu', payload),

    openExternal: (url) => ipcRenderer.invoke('swiftly:external.open', { url }),

    find: {
      start: (text, forward = true) => ipcRenderer.invoke('swiftly:find.start', { text, forward }),
      next: (text, forward = true) => ipcRenderer.invoke('swiftly:find.next', { text, forward }),
      stop: () => ipcRenderer.invoke('swiftly:find.stop'),
    },

    clipboard: {
      write: (text) => ipcRenderer.invoke('swiftly:clipboard.write', { text }),
      read: () => ipcRenderer.invoke('swiftly:clipboard.read'),
    },

    appInfo: () => ipcRenderer.invoke('swiftly:app.info'),

    searches: {
      get: () => ipcRenderer.invoke('swiftly:searches.get'),
    },

    streak: {
      get: () => ipcRenderer.invoke('swiftly:streak.get'),
      update: () => ipcRenderer.invoke('swiftly:streak.update'),
    },

    searchesEarned: {
      get: () => ipcRenderer.invoke('swiftly:searchesearned.get'),
      add: (amount) => ipcRenderer.invoke('swiftly:searchesearned.add', { amount }),
      spend: (amount) => ipcRenderer.invoke('swiftly:searchesearned.spend', { amount }),
    },

    focus: {
      minutes: () => ipcRenderer.invoke('swiftly:focus.minutes'),
      add: (minutes) => ipcRenderer.invoke('swiftly:focus.add', { minutes }),
      toggle: (options) => ipcRenderer.invoke('swiftly:focus.toggle', options),
      state: () => ipcRenderer.invoke('swiftly:focus.state'),
    },

    store: {
      catalog: () => ipcRenderer.invoke('swiftly:store.catalog'),
      purchaseTheme: (id) => ipcRenderer.invoke('swiftly:theme.purchase', { id }),
      applyTheme: (id) => ipcRenderer.invoke('swiftly:theme.apply', { id }),
      installExtension: (id) => ipcRenderer.invoke('swiftly:extension.install', { id }),
      uninstallExtension: (id) => ipcRenderer.invoke('swiftly:extension.uninstall', { id }),
      toggleExtension: (id, enabled) => ipcRenderer.invoke('swiftly:extension.toggle', { id, enabled }),
    },

    on,
  };
}

module.exports = { buildApi, EVENT_CHANNELS };
