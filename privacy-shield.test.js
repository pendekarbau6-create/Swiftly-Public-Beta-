'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const network = require('../src/main/network');

test('native network shield toggles tracker blocking and upgrades HTTP requests', async () => {
  const originalEnabled = network.blocklist.enabled;
  network.loadDefaultBlocklist();
  network.setBlockAdsAndTrackers(true);

  let onBeforeRequest;
  const fakeSession = {
    webRequest: {
      onBeforeRequest(_filter, listener) {
        onBeforeRequest = listener;
      },
    },
  };
  const prefs = { blockAdsAndTrackers: true, httpsOnly: false };
  network.configureNetwork(fakeSession, () => prefs);

  const request = (url) => new Promise((resolve) => {
    onBeforeRequest({ url }, resolve);
  });

  assert.deepEqual(await request('https://www.google-analytics.com/collect'), { cancel: true });

  prefs.blockAdsAndTrackers = false;
  prefs.httpsOnly = true;
  assert.deepEqual(await request('http://example.com/image.png'), {
    redirectUrl: 'https://example.com/image.png',
  });
  assert.equal(network.privacyShieldStatus(false).enabled, false);

  network.setBlockAdsAndTrackers(originalEnabled);
});
