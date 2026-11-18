'use strict';

/**
 * Ad and tracker blocklist for Swiftly.
 * Supports EasyList-style filter rules.
 */

const fs = require('node:fs');
const { matchesAny } = require('../utils');

const SKIP_RE = /^(#|!|\[|$)/;

class FilterRule {
  constructor(raw) {
    this.raw = raw;
    this.exception = false;
    this.cosmetic = false;
    this.regex = null;
    this.compile();
  }

  compile() {
    let rule = this.raw.trim();

    if (/^@@/.test(rule)) {
      this.exception = true;
      rule = rule.slice(2);
    }

    if (/^#?#/.test(rule)) {
      this.cosmetic = true;
      this.pattern = rule.replace(/^#?#/, '');
      return;
    }

    if (/^\|\|/.test(rule)) {
      const body = rule.replace(/^\|\|/, '').replace(/\^.*$/, '');
      this.pattern = `*://*.${body}/*`;
      this.regex = new RegExp(`(?:^|\\.)${escapeRegex(body)}(?:/|$)`, 'i');
      return;
    }

    if (/^\|/.test(rule)) {
      const body = rule.slice(1).replace(/\^.*$/, '');
      this.pattern = `${body}*`;
      this.regex = new RegExp(`^${escapeRegex(body)}`, 'i');
      return;
    }

    if (rule.includes('*') || rule.includes('^')) {
      const body = rule.replace(/\^/g, '');
      this.regex = new RegExp(escapeRegex(body).replace(/\*/g, '.*'), 'i');
      return;
    }

    this.pattern = rule;
    this.regex = new RegExp(escapeRegex(rule), 'i');
  }

  test(url) {
    if (this.exception || !this.regex) return false;
    return this.regex.test(url);
  }
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class Blocklist {
  constructor() {
    this.rules = [];
    this.exceptions = [];
    this.cosmetic = [];
    this.enabled = true;
    this.loaded = false;
  }

  loadFile(filePath) {
    if (!fs.existsSync(filePath)) return 0;
    const text = fs.readFileSync(filePath, 'utf8');
    return this.loadText(text);
  }

  loadText(text) {
    let count = 0;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || SKIP_RE.test(trimmed)) continue;
      const rule = new FilterRule(trimmed);
      if (rule.cosmetic) {
        this.cosmetic.push(rule);
      } else if (rule.exception) {
        this.exceptions.push(rule);
      } else {
        this.rules.push(rule);
      }
      count += 1;
    }
    this.loaded = true;
    return count;
  }

  addRules(rules = []) {
    for (const raw of rules) {
      const rule = new FilterRule(raw);
      if (rule.exception) this.exceptions.push(rule);
      else if (rule.cosmetic) this.cosmetic.push(rule);
      else this.rules.push(rule);
    }
    this.loaded = true;
  }

  shouldBlock(url) {
    if (!this.enabled) return false;
    for (const rule of this.exceptions) {
      if (rule.test(url)) return false;
    }
    for (const rule of this.rules) {
      if (rule.test(url)) return true;
    }
    return false;
  }

  cosmeticSelectors() {
    return this.cosmetic.map((rule) => rule.pattern);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
  }
}

module.exports = { Blocklist, FilterRule };
