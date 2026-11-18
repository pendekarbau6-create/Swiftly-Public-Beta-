'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const commonSource = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'pages', 'assets', 'common.js'),
  'utf8',
);

function createThemePage() {
  const inlineProperties = new Map();
  const root = {
    dataset: {},
    style: {
      colorScheme: '',
      setProperty: (key, value) => inlineProperties.set(key, value),
      removeProperty: (key) => inlineProperties.delete(key),
    },
  };
  let appearance = 'light';
  const prefs = { theme: 'light', activeTheme: 'forest' };
  const theme = {
    id: 'forest',
    mode: 'light',
    vars: {
      '--bg': '#edf2ec',
      '--surface': '#f6faf5',
      '--text': '#1f2a22',
      '--accent': '#2f6b4f',
      '--accent-soft': 'rgba(47, 107, 79, 0.12)',
      '--accent-text': '#ffffff',
    },
  };
  const window = {
    matchMedia: () => ({ matches: appearance === 'dark' }),
    swiftly: {
      prefs: { get: async () => ({ ...prefs }) },
      store: { catalog: async () => ({ themes: [theme] }) },
    },
  };
  const context = {
    window,
    document: { documentElement: root, createElement: () => ({}) },
    URL,
    Date,
    Map,
    Set,
  };
  vm.runInNewContext(commonSource, context);

  return {
    applyTheme: window.swiftlyPage.applyTheme,
    inlineProperties,
    prefs,
    root,
    setAppearance: (value) => { appearance = value; },
  };
}

test('explicit dark appearance overrides a light custom theme palette', async () => {
  const page = createThemePage();
  await page.applyTheme();
  assert.equal(page.inlineProperties.get('--bg'), '#edf2ec');

  page.prefs.theme = 'dark';
  await page.applyTheme();

  assert.equal(page.root.dataset.theme, 'dark');
  assert.equal(page.root.style.colorScheme, 'dark');
  assert.equal(page.inlineProperties.has('--bg'), false);
  assert.equal(page.inlineProperties.has('--surface'), false);
  assert.equal(page.inlineProperties.get('--accent'), '#2f6b4f');
});

test('system appearance follows the OS when applying a system theme', async () => {
  const page = createThemePage();
  page.prefs.theme = 'system';
  page.prefs.activeTheme = 'default';
  page.setAppearance('dark');
  await page.applyTheme();

  assert.equal(page.root.dataset.theme, undefined);
  assert.equal(page.root.style.colorScheme, 'light dark');
});

test('system appearance overrides a light custom palette when the OS is dark', async () => {
  const page = createThemePage();
  page.prefs.theme = 'system';
  page.setAppearance('dark');
  await page.applyTheme();

  assert.equal(page.root.dataset.theme, undefined);
  assert.equal(page.root.style.colorScheme, 'light dark');
  assert.equal(page.inlineProperties.has('--bg'), false);
  assert.equal(page.inlineProperties.get('--accent'), '#2f6b4f');
});
