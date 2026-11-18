'use strict';

/**
 * Provider registry.
 *
 * Order matters: the first provider is the default, the rest are failover
 * sources used when one is throttled, blocked, or returns nothing.
 */

const bing = require('./bing');
const startpage = require('./startpage');
const brave = require('./brave');
const duckduckgo = require('./duckduckgo');
const wikipedia = require('./wikipedia');

const PROVIDERS = [bing, startpage, brave, duckduckgo];

/** Every provider that can return web results. */
function list() {
  return PROVIDERS.slice();
}

/** Look up a provider by id. */
function get(id) {
  return PROVIDERS.find((provider) => provider.id === id) || null;
}

module.exports = { list, get, wikipedia, PROVIDERS };
