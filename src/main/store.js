'use strict';

/**
 * Persistent storage for Swiftly's local profile.
 *
 * Preferences, bookmarks, downloads and accounts live in a debounced JSON
 * document. Browsing history lives in history.sqlite and is capped so it
 * cannot grow without bound.
 */

const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const { HistoryDatabase, MAX_HISTORY } = require('./history-db');

const scryptAsync = promisify(scrypt);

const MAX_DOWNLOADS = 200;
const MAX_READING_LIST = 50;

function isSavedAccount(value) {
  return Boolean(value
    && typeof value === 'object'
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.email === 'string'
    && typeof value.passwordSalt === 'string'
    && typeof value.passwordHash === 'string'
    && Number.isFinite(value.createdAt));
}

const DEFAULT_PREFS = {
  // Appearance
  theme: 'system',                 // 'light' | 'dark' | 'system'
  showBookmarkBar: false,          // chrome bar under the toolbar
  compactTabs: false,              // narrower tabs in the strip
  // Search
  searchEngine: 'swifty',          // 'swifty' aggregator, or a provider id
  safeSearch: 'moderate',          // 'off' | 'moderate' | 'strict'
  region: 'en-US',
  resultsPerPage: 20,              // how many web results to collect
  showSuggestions: true,           // omnibox completions
  openInNewTab: false,             // follow results in a background tab
  alwaysShowFullUrl: false,        // show the full URL instead of a pretty one
  // Browsing
  homepage: 'swifty://start',
  restoreLastSession: true,
  smoothScrolling: true,
  zoomLevel: 0,                    // per-profile page zoom, 0 = 100%
  // Privacy
  sendDoNotTrack: true,
  blockThirdPartyCookies: false,
  blockAdsAndTrackers: true,
  httpsOnly: false,
  clearOnExit: false,
  hibernateTabs: false,
  // Downloads
  downloadDirectory: '',           // '' = Electron's default location
  askWhereToSave: false,
  // Language
  spellcheck: true,
  languages: 'en-US',
  // Appearance extensions
  activeTheme: 'default',
};

/** Allowed values for enumerated preferences. */
const PREF_OPTIONS = {
  theme: ['system', 'light', 'dark'],
  safeSearch: ['off', 'moderate', 'strict'],
  resultsPerPage: [5, 10, 20, 30, 50],
};

const MIN_ZOOM = -5;
const MAX_ZOOM = 5;

/**
 * Coerce a value coming from the renderer or the preferences file into
 * something the browser can safely use. Unknown keys and invalid values keep
 * the current (or default) setting instead of poisoning the profile.
 */
function sanitizePref(key, value, fallback) {
  const options = PREF_OPTIONS[key];
  if (options) {
    const match = options.find((option) => option === value
      || (typeof option === 'number' && Number(option) === Number(value)));
    return match === undefined ? fallback : match;
  }

  switch (key) {
    case 'region':
      return typeof value === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(value) ? value : fallback;
    case 'homepage':
      return typeof value === 'string' && value.length <= 2048 ? value.trim() || fallback : fallback;
    case 'downloadDirectory':
      return typeof value === 'string' && value.length <= 1024 ? value.trim() : fallback;
    case 'zoomLevel': {
      const zoom = Math.round(Number(value));
      if (!Number.isFinite(zoom)) return fallback;
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    }
    case 'languages':
      return typeof value === 'string' && /^[A-Za-z,;*\- ]{2,120}$/.test(value) ? value : fallback;
    case 'searchEngine':
      return typeof value === 'string' && /^[a-z]{2,24}$/.test(value) ? value : fallback;
     case 'activeTheme':
       return typeof value === 'string' && /^[a-z-]{2,24}$/.test(value) ? value : fallback;
    default:
      return typeof value === 'boolean' ? value : fallback;
  }
}

class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.historyFilePath = path.join(path.dirname(filePath), 'history.sqlite');
    this.historyDb = null;
    this.legacyHistory = [];
    this.data = {
      version: 1,
      prefs: { ...DEFAULT_PREFS },
      bookmarks: [],
      downloads: [],
      sessions: {},
      accounts: [],
      currentAccountId: null,
      searches: 0,
      purchasedThemes: ['default'],
      installedExtensions: ['ad-shield'],
      enabledExtensions: ['ad-shield'],
    };
    this.writeTimer = null;
    this.load();
  }

  async initializeHistory() {
    if (this.historyDb) return;
    const database = await HistoryDatabase.open(this.historyFilePath);
    try {
      database.migrate(this.legacyHistory);
    } catch (error) {
      database.close();
      throw error;
    }
    this.historyDb = database;
    if (this.legacyHistory.length) {
      this.legacyHistory = [];
      this.saveNow();
    }
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        version: parsed.version || 1,
        prefs: this.normalizePrefs(parsed.prefs),
        bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : [],
        downloads: Array.isArray(parsed.downloads) ? parsed.downloads : [],
        sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts.filter(isSavedAccount) : [],
        currentAccountId: typeof parsed.currentAccountId === 'string' ? parsed.currentAccountId : null,
        searches: Number.isFinite(parsed.searches) ? Math.max(0, Math.round(parsed.searches)) : 0,
        purchasedThemes: Array.isArray(parsed.purchasedThemes) ? parsed.purchasedThemes.filter((x) => typeof x === 'string') : ['default'],
        installedExtensions: Array.isArray(parsed.installedExtensions) ? parsed.installedExtensions.filter((x) => typeof x === 'string') : ['ad-shield'],
        enabledExtensions: Array.isArray(parsed.enabledExtensions) ? parsed.enabledExtensions.filter((x) => typeof x === 'string') : ['ad-shield'],
      };
      this.legacyHistory = Array.isArray(parsed.history) ? parsed.history : [];
    } catch {
      // A missing or corrupt file simply means a fresh start.
      this.data = {
        version: 1,
        prefs: { ...DEFAULT_PREFS },
        bookmarks: [],
        downloads: [],
        sessions: {},
        accounts: [],
        currentAccountId: null,
        searches: 0,
        purchasedThemes: ['default'],
        installedExtensions: ['ad-shield'],
        enabledExtensions: ['ad-shield'],
      };
      this.legacyHistory = [];
    }
  }

  /** Only known keys survive a load, and every value is coerced into range. */
  normalizePrefs(raw = {}) {
    const prefs = { ...DEFAULT_PREFS };
    if (!raw || typeof raw !== 'object') return prefs;
    for (const key of Object.keys(DEFAULT_PREFS)) {
      if (!(key in raw)) continue;
      prefs[key] = sanitizePref(key, raw[key], DEFAULT_PREFS[key]);
    }
    // Add daily streak fields if missing
    if (!raw.streak) {
      prefs.dailyStreak = 0;
      prefs.lastSearchDate = null;
      prefs.searchesEarned = 0;
      prefs.focusModeMinutes = 0;
    }
    return prefs;
  }

  /** Debounced atomic write. */
  save() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(temp, this.filePath);
    } catch (error) {
      console.error('[swiftly] failed to persist data:', error.message);
    }
  }

  /* ----------------------------------------------------------- preferences */

  getPrefs() {
    return { ...this.data.prefs };
  }

  setPref(key, value) {
    if (!(key in DEFAULT_PREFS)) return this.getPrefs();
    const next = sanitizePref(key, value, this.data.prefs[key] ?? DEFAULT_PREFS[key]);
    if (next === this.data.prefs[key]) return this.getPrefs();
    this.data.prefs[key] = next;
    this.save();
    return this.getPrefs();
  }

  /** Restore every preference to its shipped default. */
  resetPrefs() {
    this.data.prefs = { ...DEFAULT_PREFS };
    this.save();
    return this.getPrefs();
  }

  /* --------------------------------------------------------------- history */

  addHistory(entry) {
    return this.historyDb.add(entry);
  }

  listHistory({ query = '', limit = 500, from = 0 } = {}) {
    return this.historyDb.list({ query, limit, from });
  }

  deleteHistory(id) {
    this.historyDb.remove(id);
  }

  clearHistory() {
    this.historyDb.clear();
  }

  /** Distinct hosts the user visits, most used first. */
  topSites(limit = 8) {
    const counts = new Map();
    for (const item of this.historyDb.list({ limit: MAX_HISTORY })) {
      let host = '';
      try {
        const parsed = new URL(item.url);
        // Swiftly's own pages are not "sites".
        if (parsed.protocol === 'swifty:') continue;
        host = parsed.hostname.replace(/^www\./, '');
      } catch {
        continue;
      }
      if (!host) continue;
      const entry = counts.get(host) || { host, visits: 0, url: item.url, title: item.title };
      entry.visits += item.visitCount || 1;
      counts.set(host, entry);
    }
    return [...counts.values()].sort((a, b) => b.visits - a.visits).slice(0, limit);
  }

  /* ------------------------------------------------------------- bookmarks */

  listBookmarks() {
    return this.data.bookmarks.slice();
  }

  addBookmark({ url, title, folder = 'Bookmarks' }) {
    const existing = this.data.bookmarks.find((item) => item.url === url);
    if (existing) {
      existing.title = title || existing.title;
      this.save();
      return existing;
    }
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      title: title || url,
      folder,
      createdAt: Date.now(),
    };
    this.data.bookmarks.unshift(record);
    this.save();
    return record;
  }

  removeBookmark(id) {
    const before = this.data.bookmarks.length;
    this.data.bookmarks = this.data.bookmarks.filter((item) => item.id !== id);
    if (this.data.bookmarks.length !== before) this.save();
    return this.data.bookmarks.length !== before;
  }

  findBookmarkByUrl(url) {
    return this.data.bookmarks.find((item) => item.url === url) || null;
  }

  /* ------------------------------------------------------------- reading list */

  listReadingList() {
    return (this.data.readingList || []).slice();
  }

  addToReadingList({ url, title, excerpt }) {
    const existing = this.data.readingList?.find((item) => item.url === url);
    if (existing) return false;
    
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      url,
      title: title || url,
      excerpt: excerpt || '',
      addedAt: Date.now(),
      readAt: null,
    };
    
    if (!this.data.readingList) this.data.readingList = [];
    this.data.readingList.unshift(record);
    
    if (this.data.readingList.length > MAX_READING_LIST) {
      this.data.readingList.length = MAX_READING_LIST;
    }
    this.save();
    return true;
  }

  removeFromReadingList(id) {
    const before = this.data.readingList?.length || 0;
    this.data.readingList = (this.data.readingList || []).filter((item) => item.id !== id);
    if (this.data.readingList.length !== before) this.save();
    return this.data.readingList.length !== before;
  }

  markReadInReadingList(id) {
    const item = this.data.readingList?.find((item) => item.id === id);
    if (item) {
      item.readAt = Date.now();
      this.save();
      return true;
    }
    return false;
  }

  /* --------------------------------------------------------------- streak / rewards */

  getDailyStreak() {
    return this.data.prefs.dailyStreak || 0;
  }

  updateDailyStreak() {
    const today = new Date().toDateString();
    const lastDate = this.data.prefs.lastSearchDate;
    
    if (lastDate === today) return this.data.prefs.dailyStreak || 0;
    
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toDateString();
    
    if (lastDate === yesterday || !lastDate) {
      this.data.prefs.dailyStreak = (this.data.prefs.dailyStreak || 0) + 1;
    } else {
      this.data.prefs.dailyStreak = 1;
    }
    
    this.data.prefs.lastSearchDate = today;
    this.save();
    return this.data.prefs.dailyStreak;
  }

  getSearchesEarned() {
    return this.data.prefs.searchesEarned || 0;
  }

  addSearchesEarned(amount = 1) {
    const value = Number(amount) || 0;
    if (value <= 0) return this.data.prefs.searchesEarned || 0;
    
    this.data.prefs.searchesEarned = (this.data.prefs.searchesEarned || 0) + value;
    this.save();
    return this.data.prefs.searchesEarned;
  }

  spendSearchesEarned(amount) {
    const value = Math.max(0, Math.round(Number(amount) || 0));
    if ((this.data.prefs.searchesEarned || 0) < value) return false;
    this.data.prefs.searchesEarned -= value;
    this.save();
    return true;
  }

  getFocusModeMinutes() {
    return this.data.prefs.focusModeMinutes || 0;
  }

  addFocusModeMinutes(minutes) {
    const value = Math.max(0, Math.round(Number(minutes) || 0));
    this.data.prefs.focusModeMinutes = (this.data.prefs.focusModeMinutes || 0) + value;
    this.save();
    return this.data.prefs.focusModeMinutes;
  }

  /* --------------------------------------------------------------- account */

  /** Return the signed-in profile without exposing password material. */
  currentAccount() {
    const account = this.data.accounts.find((item) => item.id === this.data.currentAccountId);
    return account ? this.publicAccount(account) : null;
  }

  /** Create a device-local profile with a scrypt password hash. */
  async createAccount({ name, email, password } = {}) {
    const cleanName = String(name || '').trim().replace(/\s+/g, ' ');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const passphrase = String(password || '');

    if (cleanName.length < 2 || cleanName.length > 80 || /[\u0000-\u001f\u007f]/.test(cleanName)) {
      throw new Error('Enter a name between 2 and 80 characters.');
    }
    if (normalizedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new Error('Enter a valid email address.');
    }
    if (passphrase.length < 10 || passphrase.length > 128) {
      throw new Error('Use a password between 10 and 128 characters.');
    }
    if (this.data.accounts.some((item) => item.email === normalizedEmail)) {
      throw new Error('An account with this email already exists on this device.');
    }

    const salt = randomBytes(16);
    const hash = await scryptAsync(passphrase, salt, 64);

    // Check again after hashing so two quick form submissions cannot create
    // duplicate local accounts for the same email.
    if (this.data.accounts.some((item) => item.email === normalizedEmail)) {
      throw new Error('An account with this email already exists on this device.');
    }

    const account = {
      id: randomUUID(),
      name: cleanName,
      email: normalizedEmail,
      passwordSalt: salt.toString('hex'),
      passwordHash: Buffer.from(hash).toString('hex'),
      createdAt: Date.now(),
    };
    this.data.accounts.push(account);
    this.data.currentAccountId = account.id;
    this.save();
    return this.publicAccount(account);
  }

  /** Verify a local profile and sign it in. */
  async loginAccount({ email, password } = {}) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const passphrase = String(password || '');
    if (normalizedEmail.length > 254 || passphrase.length > 128) {
      throw new Error('Email or password is incorrect.');
    }
    const account = this.data.accounts.find((item) => item.email === normalizedEmail);

    // Do the same password derivation for an unknown email to avoid making
    // account lookup timing an easy way to enumerate local profiles.
    const salt = account && /^[a-f0-9]{32}$/i.test(account.passwordSalt || '')
      ? Buffer.from(account.passwordSalt, 'hex')
      : Buffer.alloc(16);
    const expected = account && /^[a-f0-9]{128}$/i.test(account.passwordHash || '')
      ? Buffer.from(account.passwordHash, 'hex')
      : Buffer.alloc(64);
    const actual = Buffer.from(await scryptAsync(passphrase, salt, 64));
    const verified = timingSafeEqual(actual, expected);

    if (!account || !verified) {
      throw new Error('Email or password is incorrect.');
    }

    this.data.currentAccountId = account.id;
    this.save();
    return this.publicAccount(account);
  }

  logoutAccount() {
    this.data.currentAccountId = null;
    this.save();
    return true;
  }

  publicAccount(account) {
    return {
      id: account.id,
      name: account.name,
      email: account.email,
      createdAt: account.createdAt,
    };
  }

  /* ------------------------------------------------------------- downloads */

  listDownloads() {
    return this.data.downloads.slice();
  }

  addDownload(record) {
    this.data.downloads.unshift({ ...record, startedAt: Date.now() });
    if (this.data.downloads.length > MAX_DOWNLOADS) this.data.downloads.length = MAX_DOWNLOADS;
    this.save();
  }

  updateDownload(id, patch) {
    const record = this.data.downloads.find((item) => item.id === id);
    if (!record) return null;
    Object.assign(record, patch);
    this.save();
    return record;
  }

  clearDownloads() {
    this.data.downloads = [];
    this.save();
  }

  /* -------------------------------------------------------------- sessions */

  getSession(name) {
    return this.data.sessions[name] || null;
  }

  setSession(name, value) {
    this.data.sessions[name] = value;
    this.save();
  }

  /* ------------------------------------------------------------- store currency / themes / extensions */

  getSearches() {
    return this.data.searches || 0;
  }

  incrementSearches(amount = 1) {
    const value = Number(amount) || 0;
    if (value <= 0) return this.data.searches || 0;
    this.data.searches = (this.data.searches || 0) + value;
    this.save();
    return this.data.searches;
  }

  spendSearches(amount) {
    const value = Math.max(0, Math.round(Number(amount) || 0));
    if ((this.data.searches || 0) < value) return false;
    this.data.searches -= value;
    this.save();
    return true;
  }

  listPurchasedThemes() {
    return (this.data.purchasedThemes || ['default']).slice();
  }

  ownsTheme(id) {
    return (this.data.purchasedThemes || []).includes(id);
  }

  purchaseTheme(id) {
    if (!this.ownsTheme(id)) {
      this.data.purchasedThemes = this.data.purchasedThemes || ['default'];
      this.data.purchasedThemes.push(id);
      this.save();
    }
    return true;
  }

  getActiveTheme() {
    return this.data.prefs.activeTheme || 'default';
  }

  setActiveTheme(id) {
    this.data.prefs.activeTheme = id;
    this.save();
    return this.getPrefs();
  }

  listInstalledExtensions() {
    return (this.data.installedExtensions || []).slice();
  }

  listEnabledExtensions() {
    return (this.data.enabledExtensions || []).slice();
  }

  isExtensionInstalled(id) {
    return (this.data.installedExtensions || []).includes(id);
  }

  isExtensionEnabled(id) {
    return (this.data.enabledExtensions || []).includes(id);
  }

  installExtension(id) {
    if (!this.isExtensionInstalled(id)) {
      this.data.installedExtensions = this.data.installedExtensions || [];
      this.data.installedExtensions.push(id);
    }
    if (!this.isExtensionEnabled(id)) {
      this.data.enabledExtensions = this.data.enabledExtensions || [];
      this.data.enabledExtensions.push(id);
    }
    this.save();
    return true;
  }

  uninstallExtension(id) {
    this.data.installedExtensions = (this.data.installedExtensions || []).filter((item) => item !== id);
    this.data.enabledExtensions = (this.data.enabledExtensions || []).filter((item) => item !== id);
    this.save();
    return true;
  }

  toggleExtension(id, enabled) {
    const set = new Set(this.data.enabledExtensions || []);
    if (enabled) set.add(id);
    else set.delete(id);
    this.data.enabledExtensions = [...set];
    this.save();
    return this.isExtensionEnabled(id);
  }

  close() {
    if (!this.historyDb) return;
    this.saveNow();
    this.historyDb.close();
    this.historyDb = null;
  }
}

module.exports = { Store, DEFAULT_PREFS };
