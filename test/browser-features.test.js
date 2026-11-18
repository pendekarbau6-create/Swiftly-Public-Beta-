'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { BrowserController } = require('../src/main/browser');

function controllerFor(tab, prefs = {}) {
  const controller = Object.create(BrowserController.prototype);
  controller.tabs = [tab];
  controller.activeTabId = 'active';
  controller.incognito = false;
  controller.store = { getPrefs: () => prefs };
  controller.emit = () => {};
  return controller;
}

test('Speed Reader keeps its source content through reader navigation and exit', async () => {
  const navigations = [];
  const tab = {
    id: 'reader-tab',
    url: 'https://example.test/article',
    readerModeActive: false,
    readerSourceUrl: '',
    readerContent: null,
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async () => ({
        title: 'Article',
        source: 'https://example.test/article',
        content: [{ tag: 'p', text: 'Readable article content.' }],
      }),
      loadURL: async (url) => navigations.push(url),
    },
  };
  const controller = controllerFor(tab);

  assert.deepEqual(await controller.toggleReaderMode(tab.id), { ok: true, enabled: true });
  assert.equal(tab.readerModeActive, true);
  assert.equal(tab.readerContent.title, 'Article');
  assert.equal(navigations[0], `swifty://reader?tabId=${tab.id}`);

  assert.deepEqual(await controller.toggleReaderMode(tab.id), { ok: true, enabled: false });
  assert.equal(tab.readerModeActive, false);
  assert.equal(tab.readerContent, null);
  assert.equal(navigations[1], 'https://example.test/article');
});

test('tab hibernation reloads the saved URL and scroll position when awakened', async () => {
  const executedScripts = [];
  const tab = {
    id: 'sleeping-tab',
    url: 'https://example.test/page',
    loading: false,
    pinned: false,
    audible: false,
    readerModeActive: false,
    hibernated: false,
    hibernating: false,
    webContents: {
      currentUrl: 'https://example.test/page',
      isDestroyed: () => false,
      executeJavaScript: async (script) => {
        executedScripts.push(script);
        return script.includes('window.scrollY') ? 240 : undefined;
      },
      loadURL: async function loadURL(url) {
        this.currentUrl = url;
      },
      getURL() {
        return this.currentUrl;
      },
    },
  };
  const controller = controllerFor(tab, { hibernateTabs: true });

  assert.equal(await controller.hibernateTab(tab.id), true);
  assert.equal(tab.hibernating, true);
  assert.equal(tab.hibernatedUrl, 'https://example.test/page');
  assert.equal(tab.webContents.currentUrl, 'about:blank');

  tab.hibernating = false;
  tab.hibernated = true;
  controller.activeTabId = tab.id;
  controller.wakeTab(tab);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(tab.webContents.currentUrl, 'https://example.test/page');
  assert.ok(executedScripts.some((script) => script === 'window.scrollTo(0, 240)'));
});

test('focus mode records elapsed whole minutes and updates internal pages', () => {
  let totalMinutes = 0;
  const updates = [];
  const tab = {
    id: 'focus-tab',
    url: 'swifty://start',
    webContents: {
      isDestroyed: () => false,
      send: (channel, minutes) => updates.push({ channel, minutes }),
    },
  };
  const controller = Object.create(BrowserController.prototype);
  Object.assign(controller, {
    tabs: [tab],
    activeTabId: tab.id,
    focusModeActive: false,
    focusModeStartedAt: 0,
    focusModeMinutesRecorded: 0,
    focusModeTimer: null,
    store: {
      addFocusModeMinutes: (minutes) => {
        totalMinutes += minutes;
        return totalMinutes;
      },
    },
    send: () => {},
  });

  assert.equal(controller.toggleFocusMode(true), true);
  controller.focusModeStartedAt = Date.now() - 65000;
  controller.recordFocusMinutes();
  assert.equal(totalMinutes, 1);
  assert.deepEqual(updates.at(-1), { channel: 'swiftly:focus-minutes-changed', minutes: 1 });

  controller.focusModeStartedAt = Date.now() - 125000;
  controller.toggleFocusMode(false);
  assert.equal(totalMinutes, 2);
  assert.equal(controller.focusModeTimer, null);
});
