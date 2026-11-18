'use strict';

/**
 * Preload for the shell (tab strip, address bar, window chrome).
 */

const { contextBridge } = require('electron');
const { buildApi } = require('./api');

contextBridge.exposeInMainWorld('swiftly', buildApi());
