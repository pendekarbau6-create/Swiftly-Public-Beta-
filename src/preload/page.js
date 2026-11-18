'use strict';

/**
 * Preload for page contents.
 *
 * Swiftly's own pages (`swifty://…`) get the full API. Ordinary websites
 * get nothing — the bridge is never exposed to them, so a page cannot reach
 * history, bookmarks or the tab manager.
 */

const { contextBridge } = require('electron');
const { buildApi } = require('./api');

/** The tab this page is rendered in, injected by the main process. */
function currentTabId() {
  const arg = process.argv.find((value) => value.startsWith('--swiftly-tab-id='));
  return arg ? arg.slice('--swiftly-tab-id='.length) : null;
}

const isInternal = () => {
  try {
    return window.location.protocol === 'swifty:';
  } catch {
    return false;
  }
};

if (isInternal()) {
  const api = buildApi();
  contextBridge.exposeInMainWorld('swiftly', { ...api, currentTabId: currentTabId() });
} else {
  // A tiny, harmless marker so the page can tell it is running in Swiftly.
  contextBridge.exposeInMainWorld('swiftlyHost', { name: 'Swiftly' });
}
