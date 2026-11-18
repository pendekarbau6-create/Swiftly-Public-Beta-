'use strict';

/**
 * Application menu.
 *
 * The accelerators here are the only ones that work reliably: the focused
 * element is usually inside a page's `WebContentsView`, so shortcuts handled
 * by the shell renderer would never fire. Menu accelerators are application
 * wide.
 */

const { Menu, shell, app } = require('electron');

/** Run an action against the active tab of the first window. */
function activeController(controllers) {
  return controllers[0] || null;
}

/** Apply a preference change and refresh every window's chrome. */
function applyPref({ store, controllers }, key, value) {
  const prefs = store.setPref(key, value);
  for (const controller of controllers) {
    controller.applyWindowPrefs();
    controller.send('swiftly:prefs-changed', prefs);
  }
  return prefs;
}

function buildMenu({ store, controllers, createWindow }) {
  const navigate = (url) => () => {
    const controller = activeController(controllers);
    if (controller) controller.navigate(controller.activeTabId, url);
  };

  const act = (fn) => () => {
    const controller = activeController(controllers);
    if (controller) fn(controller);
  };

  /** The shell owns the find bar, so the menu asks it to open. */
  const openFind = act((controller) => controller.send('swiftly:find-open', {}));

  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: act((controller) => {
            controller.createTab({ url: 'swifty://start' });
          }),
        },
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow(),
        },
        {
          label: 'New Incognito Window',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => createWindow({ incognito: true }),
        },
        { type: 'separator' },
        {
          label: 'Open Location…',
          accelerator: 'CmdOrCtrl+L',
          click: act((controller) => controller.send('swiftly:focus-omnibox', {})),
        },
        {
          label: 'Open Home Page',
          accelerator: 'Alt+Home',
          click: () => {
            const controller = activeController(controllers);
            if (controller) controller.navigate(controller.activeTabId, store.getPrefs().homepage);
          },
        },
        { type: 'separator' },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: act((controller) => {
            if (controller.activeTabId) controller.closeTab(controller.activeTabId);
          }),
        },
        {
          label: 'Close Window',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => {
            const controller = activeController(controllers);
            controller?.window?.close();
          },
        },
        { type: 'separator' },
        {
          label: 'Print…',
          accelerator: 'CmdOrCtrl+P',
          click: act((controller) => {
            controller.activeTab?.webContents.print({ silent: false, printBackground: true });
          }),
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: 'Find in Page…',
          accelerator: 'CmdOrCtrl+F',
          click: openFind,
        },
        {
          label: 'Find Next',
          accelerator: 'CmdOrCtrl+G',
          click: act((controller) => controller.send('swiftly:find-step', { forward: true })),
        },
        {
          label: 'Find Previous',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: act((controller) => controller.send('swiftly:find-step', { forward: false })),
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: act((controller) => controller.reload(controller.activeTabId)),
        },
        {
          label: 'Force Reload',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: act((controller) => controller.reload(controller.activeTabId, true)),
        },
        {
          label: 'Stop',
          accelerator: 'Esc',
          click: act((controller) => controller.stop(controller.activeTabId)),
        },
        { type: 'separator' },
        {
          label: 'Back',
          accelerator: 'Alt+Left',
          click: act((controller) => controller.goBack(controller.activeTabId)),
        },
        {
          label: 'Forward',
          accelerator: 'Alt+Right',
          click: act((controller) => controller.goForward(controller.activeTabId)),
        },
        { type: 'separator' },
        {
          label: 'Actual Size',
          accelerator: 'CmdOrCtrl+0',
          click: act((controller) => {
            const level = controller.resetZoom();
            controller.send('swiftly:zoom-changed', { level });
          }),
        },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+Plus',
          click: act((controller) => {
            const level = controller.adjustZoom(0.5);
            controller.send('swiftly:zoom-changed', { level });
          }),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: act((controller) => {
            const level = controller.adjustZoom(-0.5);
            controller.send('swiftly:zoom-changed', { level });
          }),
        },
        { type: 'separator' },
        {
          label: 'Bookmarks Bar',
          type: 'checkbox',
          checked: Boolean(store.getPrefs().showBookmarkBar),
          accelerator: 'CmdOrCtrl+Shift+B',
          click: (item) => applyPref({ store, controllers }, 'showBookmarkBar', item.checked),
        },
        {
          label: 'Compact Tabs',
          type: 'checkbox',
          checked: Boolean(store.getPrefs().compactTabs),
          click: (item) => applyPref({ store, controllers }, 'compactTabs', item.checked),
        },
        { type: 'separator' },
        {
          label: 'Toggle Full Screen',
          accelerator: 'F11',
          click: () => {
            const controller = activeController(controllers);
            controller?.window?.setFullScreen(!controller.window.isFullScreen());
          },
        },
        {
          label: 'Developer Tools',
          accelerator: 'F12',
          click: act((controller) => controller.activeTab?.webContents.toggleDevTools()),
        },
        {
          label: 'Inspect Browser Chrome',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: act((controller) => controller.shellView?.webContents.toggleDevTools()),
        },
      ],
    },
    {
      label: 'History',
      submenu: [
        {
          label: 'Back',
          accelerator: 'CmdOrCtrl+[',
          click: act((controller) => controller.goBack(controller.activeTabId)),
        },
        {
          label: 'Forward',
          accelerator: 'CmdOrCtrl+]',
          click: act((controller) => controller.goForward(controller.activeTabId)),
        },
        { type: 'separator' },
        {
          label: 'Reopen Closed Tab',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: act((controller) => controller.reopenClosedTab()),
        },
        { type: 'separator' },
        {
          label: 'History',
          accelerator: 'CmdOrCtrl+H',
          click: navigate('swifty://history'),
        },
        {
          label: 'Home',
          accelerator: 'CmdOrCtrl+Shift+H',
          click: () => {
            const controller = activeController(controllers);
            if (controller) controller.navigate(controller.activeTabId, store.getPrefs().homepage);
          },
        },
      ],
    },
    {
      label: 'Bookmarks',
      submenu: [
        {
          label: 'Bookmark This Tab',
          accelerator: 'CmdOrCtrl+D',
          click: () => {
            const controller = activeController(controllers);
            const tab = controller?.activeTab;
            if (!tab) return;
            store.addBookmark({ url: tab.url, title: tab.title });
            controller.send('swiftly:bookmark-added', { url: tab.url });
            controller.send('swiftly:toast', { tone: 'ok', message: 'Bookmark added' });
          },
        },
        {
          label: 'Show Bookmarks Bar',
          type: 'checkbox',
          checked: Boolean(store.getPrefs().showBookmarkBar),
          accelerator: 'CmdOrCtrl+Shift+B',
          click: (item) => applyPref({ store, controllers }, 'showBookmarkBar', item.checked),
        },
        { type: 'separator' },
        {
          label: 'Manage Bookmarks',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: navigate('swifty://bookmarks'),
        },
      ],
    },
    {
      label: 'Downloads',
      submenu: [
        {
          label: 'Downloads',
          accelerator: 'CmdOrCtrl+J',
          click: navigate('swifty://downloads'),
        },
        { type: 'separator' },
        {
          label: 'Ask Where to Save Each File',
          type: 'checkbox',
          checked: Boolean(store.getPrefs().askWhereToSave),
          click: (item) => applyPref({ store, controllers }, 'askWhereToSave', item.checked),
        },
        {
          label: 'Choose Download Folder…',
          click: async () => {
            const { dialog } = require('electron');
            const controller = activeController(controllers);
            const current = store.getPrefs().downloadDirectory;
            const result = await dialog.showOpenDialog(controller?.window || null, {
              title: 'Choose where downloads are saved',
              properties: ['openDirectory', 'createDirectory'],
              defaultPath: current || app.getPath('downloads'),
            });
            if (result.canceled || !result.filePaths.length) return;
            applyPref({ store, controllers }, 'downloadDirectory', result.filePaths[0]);
          },
        },
      ],
    },
    {
      label: 'Settings',
      submenu: [
        {
          label: 'Preferences',
          accelerator: 'CmdOrCtrl+,',
          click: navigate('swifty://settings'),
        },
        { type: 'separator' },
        {
          label: 'Smooth Scrolling',
          type: 'checkbox',
          checked: store.getPrefs().smoothScrolling !== false,
          click: (item) => applyPref({ store, controllers }, 'smoothScrolling', item.checked),
        },
        {
          label: 'Send “Do Not Track” Request',
          type: 'checkbox',
          checked: store.getPrefs().sendDoNotTrack !== false,
          click: (item) => applyPref({ store, controllers }, 'sendDoNotTrack', item.checked),
        },
        {
          label: 'Restore Tabs on Launch',
          type: 'checkbox',
          checked: Boolean(store.getPrefs().restoreLastSession),
          click: (item) => applyPref({ store, controllers }, 'restoreLastSession', item.checked),
        },
        { type: 'separator' },
        {
          label: 'Swiftly Account',
          click: navigate('swifty://account'),
        },
        {
          label: 'Swiftly Store',
          click: navigate('swifty://store'),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          click: navigate('swifty://start'),
        },
        { type: 'separator' },
        {
          label: 'About Swiftly',
          click: navigate('swifty://settings'),
        },
        {
          label: 'Swiftly Search Engine',
          click: () => shell.openExternal('https://duckduckgo.com/'),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
