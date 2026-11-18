'use strict';

/**
 * Network request interception for Swiftly.
 *
 * Handles:
 *   - Ad/tracker blocking via the compiled Blocklist
 *   - HTTPS-only mode (upgrade http:// to https://)
 *   - Optional HTTP-to-HTTPS upgrades and additional tracker request blocking
 *
 * Attached to each session via session.webRequest.onBeforeRequest / onHeadersReceived.
 */

const { session } = require('electron');
const Blocklist = require('./blocklist').Blocklist;

/** The shared blocklist instance, wired up from main.js at startup. */
const blocklist = new Blocklist();
let blockedRequestCount = 0;

/**
 * Configure network interception on a session.
 * @param {Electron.Session} targetSession
 * @param {object|Function} getPreferences
 */
function configureNetwork(targetSession, getPreferences = () => ({})) {
  targetSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const prefs = typeof getPreferences === 'function' ? getPreferences() : getPreferences;
    if (prefs.blockAdsAndTrackers !== false && blocklist.shouldBlock(details.url)) {
      blockedRequestCount += 1;
      callback({ cancel: true });
      return;
    }

    if (prefs.httpsOnly && /^http:\/\//i.test(details.url)) {
      callback({ redirectUrl: details.url.replace(/^http:\/\//i, 'https://') });
      return;
    }

    // This is request-level tracker blocking, not a DNS resolver change.
    if (prefs.secureDns && /:\/\/(?:[^/]+\.)?(?:doubleclick\.net|google-analytics\.com|googletagmanager\.com)\//i.test(details.url)) {
      blockedRequestCount += 1;
      callback({ cancel: true });
      return;
    }

    callback({});
  });
}

/** Enable or disable ad/tracker blocking globally across all sessions. */
function setBlockAdsAndTrackers(enabled) {
  blocklist.setEnabled(enabled);
}

function privacyShieldStatus(enabled = blocklist.enabled) {
  return { enabled: Boolean(enabled), blockedRequests: blockedRequestCount };
}

/** Load the default built-in blocklist plus any user-supplied file. */
function loadDefaultBlocklist() {
  // A small curated default list so blocking works out of the box.
  const defaults = [
    '||doubleclick.net^',
    '||google-analytics.com^',
    '||googletagmanager.com^',
    '||facebook.com/tr^',
    '||connect.facebook.net^',
    '||adservice.google.com^',
    '||adsystem.amazon.com^',
    '||amazon-adsystem.com^',
    '||adnxs.com^',
    '||taboola.com^',
    '||outbrain.com^',
    '||analytics.twitter.com^',
    '||secure.imrworldwide.com^',
    '||scorecardresearch.com^',
    '||bidswitch.net^',
    '||pubmatic.com^',
    '||rubiconproject.com^',
    '||quantserve.com^',
    '||ads.yahoo.com^',
    '||criteo.com^',
    '||outbrainimg.com^',
    '||disqus.com^',
    '||disquscdn.com^',
  ];
  blocklist.addRules(defaults);
}

module.exports = {
  configureNetwork,
  setBlockAdsAndTrackers,
  loadDefaultBlocklist,
  privacyShieldStatus,
  blocklist,
};
