'use strict';

/**
 * Application entry point.
 *
 * Registers the `swifty:` protocol that serves Swiftly's own pages, wires up
 * session behaviour (downloads, permissions) and boots the first window.
 */

const { app, protocol, session, nativeTheme, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const { Store } = require('./store');
const { BrowserController } = require('./browser');
const { registerIpc } = require('./ipc');
const { buildMenu } = require('./menu');
const { configureNetwork, loadDefaultBlocklist, setBlockAdsAndTrackers } = require('./network');
const { PasswordManager } = require('./passwords');
const { THEMES, EXTENSIONS } = require('./catalog');
const PAGES_DIR = path.join(__dirname, '..', 'pages');

const store = new Store(path.join(app.getPath('userData'), 'swiftly.json'));
const passwords = new PasswordManager(path.join(app.getPath('userData'), 'passwords.json'));
const themeShop = { themes: THEMES, extensions: EXTENSIONS, purchases: [] };

/** Every open window controller. */
const controllers = [];
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = controllers[0]?.window;
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
}

/* ------------------------------------------------------------- protocol */

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'swifty',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** Serve a file from the pages directory, refusing anything outside it. */
async function serveFile(filePath) {
  const resolved = path.resolve(filePath);
  const pagesRoot = path.resolve(PAGES_DIR);
  const relative = path.relative(pagesRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const data = await fs.promises.readFile(resolved);
    const type = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    return new Response(data, {
      status: 200,
      headers: { 'Content-Type': type, 'Cache-Control': 'no-cache' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function registerProtocol() {
  protocol.handle('swifty', async (request) => {
    const url = new URL(request.url);
    const host = url.hostname || 'start';
    const pathname = decodeURIComponent(url.pathname || '/');

    // `swifty://start/` is the start page; `swifty://start/assets/x.css`
    // resolves to <pages>/assets/x.css.
    const relative = pathname === '/' || pathname === ''
      ? `${host}.html`
      : pathname.replace(/^\/+/, '');
    const target = path.join(PAGES_DIR, relative);

    if (!fs.existsSync(target)) {
      console.warn(`[swiftly] 404 for ${request.url} -> ${target}`);
      return new Response('Not found', { status: 404 });
    }
    return serveFile(target);
  });
}

/* -------------------------------------------------------------- session */

function configureSession(targetSession) {
  targetSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const allowed = ['clipboard-sanitized-write', 'fullscreen'];
    callback(allowed.includes(permission));
  });

  targetSession.setPermissionCheckHandler((_webContents, permission) => {
    return ['clipboard-sanitized-write', 'fullscreen'].includes(permission);
  });

  targetSession.on('will-download', (_event, item) => {
    const prefs = store.getPrefs();
    // Honour the configured download folder, and only prompt when asked to.
    if (!prefs.askWhereToSave && prefs.downloadDirectory) {
      try {
        fs.mkdirSync(prefs.downloadDirectory, { recursive: true });
        const target = path.join(prefs.downloadDirectory, item.getFilename());
        item.setSavePath(target);
      } catch (error) {
        console.error('[swiftly] could not use the download folder:', error.message);
      }
    }

    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      filename: item.getFilename(),
      url: item.getURL(),
      mime: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: 'progressing',
      savePath: item.getSavePath() || '',
    };
    store.addDownload(record);

    item.on('updated', (_event, state) => {
      // The save path is only decided once a "save as" dialog resolves or
      // the download starts writing, so pick it up as progress arrives.
      const savePath = item.getSavePath() || record.savePath;
      record.savePath = savePath;
      store.updateDownload(record.id, {
        receivedBytes: item.getReceivedBytes(),
        state: state === 'interrupted' ? 'paused' : 'progressing',
        savePath,
      });
    });
    item.once('done', (_event, state) => {
      const updated = store.updateDownload(record.id, {
        receivedBytes: item.getReceivedBytes(),
        savePath: item.getSavePath(),
        state: state === 'completed' ? 'completed' : 'cancelled',
      });
      const message = state === 'completed'
        ? `Downloaded ${record.filename}`
        : `Download ${state}: ${record.filename}`;
      for (const controller of controllers) {
        controller.send('swiftly:toast', {
          tone: state === 'completed' ? 'ok' : 'warn',
          message,
          action: state === 'completed' && updated?.savePath ? 'open-download' : null,
          savePath: updated?.savePath || '',
        });
      }
    });
  });

  targetSession.setSpellCheckerEnabled(store.getPrefs().spellcheck !== false);
  applyPrivacyHeaders(targetSession);
}

/**
 * One request-header hook for everything Swiftly wants to change on the way
 * out: the Do Not Track signal and, optionally, stripping cookies from
 * cross-site subresource requests.
 *
 * Electron allows a single `onBeforeSendHeaders` listener per session, so
 * both behaviours share this handler and read preferences at call time —
 * toggling either setting takes effect without a restart.
 */
function applyPrivacyHeaders(targetSession) {
  targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const prefs = store.getPrefs();
    const headers = { ...details.requestHeaders };

    if (prefs.sendDoNotTrack === false) {
      for (const header of Object.keys(headers)) {
        if (header.toLowerCase() === 'dnt') delete headers[header];
      }
    } else {
      headers.DNT = '1';
    }

    if (prefs.blockThirdPartyCookies) {
      let topHost = '';
      let requestHost = '';
      try {
        topHost = new URL(details.referrer || '').hostname;
        requestHost = new URL(details.url).hostname;
      } catch {
        topHost = '';
      }
      const sameSite = !topHost || !requestHost || topHost === requestHost
        || requestHost.endsWith(`.${topHost}`) || topHost.endsWith(`.${requestHost}`);
      if (!sameSite) {
        for (const header of Object.keys(headers)) {
          if (header.toLowerCase() === 'cookie') delete headers[header];
        }
      }
    }

    callback({ requestHeaders: headers });
  });
}

/** Clear the browsing traces the user asked to be removed on exit. */
async function clearBrowsingData() {
  try {
    store.clearHistory();
    store.clearDownloads();
    const targets = ['cookies', 'cache', 'storage', 'websql', 'indexdb', 'shadercache'];
    await Promise.all([
      session.defaultSession.clearStorageData({ storages: targets }),
      session.defaultSession.clearCache(),
    ]);
  } catch (error) {
    console.error('[swiftly] failed to clear browsing data:', error.message);
  }
}

/* --------------------------------------------------------------- window */

/**
 * Electron changed the shape of the `console-message` event between major
 * versions: older builds pass `(event, level, message, …)`, newer ones pass a
 * single event object. Support both.
 */
function readConsoleMessage(args) {
  const LEVELS = ['debug', 'info', 'warning', 'error'];
  if (args.length >= 3 && typeof args[1] === 'number') {
    return { level: LEVELS[args[1]] || 'info', message: args[2] };
  }
  const event = args[0] || {};
  return {
    level: LEVELS[event.level] || 'info',
    message: event.message || '',
  };
}

function createWindow({ incognito = false } = {}) {
  const controller = new BrowserController({ store, incognito });
  if (incognito) {
    configureSession(controller.session);
    configureNetwork(controller.session, () => store.getPrefs());
  }

  // Listeners are attached before the window exists so the very first tab
  // is covered too. Events go to the shell view, which is where the chrome
  // and address bar actually live.
  const push = (channel) => (payload) => controller.send(`swiftly:${channel}`, payload);

  controller.on('tabs-changed', push('tabs-changed'));
  controller.on('tab-updated', push('tab-updated'));
  controller.on('tab-activated', push('tab-activated'));
  controller.on('find-result', push('find-result'));

  controller.on('tab-created', (tab) => {
    tab.webContents.on('console-message', (...args) => {
      const { level, message } = readConsoleMessage(args);
      if (level === 'debug' || !message) return;
      console.log(`[page:${level}] ${message}`);
    });
    tab.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.error(`[swiftly] preload failed (${preloadPath}): ${error.message}`);
    });
  });

  const window = controller.createWindow();

  window.__swiftlyController = controller;
  controllers.push(controller);

  // Surface renderer console output in the terminal — invaluable when a page
  // misbehaves and there is no devtools open.
  controller.shellView.webContents.on('console-message', (...args) => {
    const { level, message } = readConsoleMessage(args);
    if (level === 'debug' || !message) return;
    console.log(`[shell:${level}] ${message}`);
  });
  window.on('closed', () => {
    const index = controllers.indexOf(controller);
    if (index >= 0) controllers.splice(index, 1);
  });

  if (incognito) {
    controller.send('swiftly:incognito', true);
  }

  return { controller, window };
}

/* ----------------------------------------------------------------- boot */

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  await store.initializeHistory();
  registerProtocol();
  configureSession(session.defaultSession);
  loadDefaultBlocklist();
  setBlockAdsAndTrackers(store.getPrefs().blockAdsAndTrackers !== false);
  configureNetwork(session.defaultSession, () => store.getPrefs());
  global.__swiftlyPasswords = passwords;
  global.__swiftlyThemeShop = themeShop;

  const theme = store.getPrefs().theme;
  nativeTheme.themeSource = theme === 'system' ? 'system' : theme;

  Menu.setApplicationMenu(buildMenu({ store, controllers, createWindow }));

  registerIpc({ store, controllers, createWindow });

  createWindow();

  // Development capture: `electron . --shot <dir> [delayMs] [url]`
  const shotIndex = process.argv.indexOf('--shot');
  if (shotIndex >= 0) {
    const outputDir = process.argv[shotIndex + 1] || path.join(process.cwd(), 'shots');
    const delay = Number(process.argv[shotIndex + 2]) || 3000;
    // The URL is the next positional argument; flags and their values are
    // skipped.
    const evalIndex = process.argv.indexOf('--eval');
    const script = evalIndex >= 0 ? process.argv[evalIndex + 1] || '' : '';
    let url = '';
    for (let i = shotIndex + 3; i < process.argv.length; i += 1) {
      if (i === evalIndex || i === evalIndex + 1) continue;
      if (!process.argv[i].startsWith('--')) {
        url = process.argv[i];
        break;
      }
    }
    const { capture } = require('./devshot');
    setTimeout(async () => {
      await capture({
        window: controllers[0].window,
        outputDir,
        delay: 0,
        url,
        script,
      });
      app.quit();
    }, delay);
  }

  app.on('activate', () => {
    if (require('electron').BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (store.getPrefs().clearOnExit) {
    // Kick the wipe off, but do not block quit on it: the history database
    // must stay open until its own flush completes.
    clearBrowsingData();
  }
  store.close();
});
