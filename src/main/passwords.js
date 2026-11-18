'use strict';

/**
 * Password manager for Swiftly.
 * Stores site credentials (username + encrypted password) in the profile,
 * offers save / fill / autofill / delete operations, and integrates with
 * the account system's scrypt-based key derivation so passwords are never
 * stored in plain text on disk.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID, scrypt } = require('node:crypto');
const { registrableDomain } = require('../utils');

const scryptAsync = require('node:util').promisify(scrypt);
const crypto = require('node:crypto');

const MAX_CREDENTIALS = 500;

function isSavedCredential(value) {
  return Boolean(
    value && typeof value === 'object' &&
    typeof value.id === 'string' &&
    typeof value.username === 'string' &&
    typeof value.passwordHash === 'string' &&
    typeof value.passwordSalt === 'string' &&
    typeof value.domain === 'string' &&
    Number.isFinite(value.createdAt),
  );
}

class PasswordManager {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { version: 1, credentials: [] };
    this.masterKey = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        version: parsed.version || 1,
        credentials: Array.isArray(parsed.credentials)
          ? parsed.credentials.filter(isSavedCredential)
          : [],
      };
    } catch {
      this.data = { version: 1, credentials: [] };
    }
  }

  saveNow() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temp = this.filePath + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(temp, this.filePath);
    } catch (error) {
      console.error('[swiftly] failed to persist passwords:', error.message);
    }
  }

  async setMasterPassword(password) {
    const salt = randomBytes(16);
    const key = await scryptAsync(password, salt, 32);
    this.masterKey = { salt: salt.toString('hex'), key: Buffer.from(key) };
    return this.masterKey.salt;
  }

  async encrypt(value) {
    if (!this.masterKey) throw new Error('Password manager is not unlocked');
    const iv = randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.masterKey.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(String(value), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      data: encrypted.toString('hex'),
    };
  }

  async decrypt(enc) {
    if (!this.masterKey) throw new Error('Password manager is not unlocked');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.masterKey.key,
      Buffer.from(enc.iv, 'hex'),
    );
    decipher.setAuthTag(Buffer.from(enc.tag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(enc.data, 'hex')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  list() {
    return this.data.credentials.map((cred) => ({
      id: cred.id,
      domain: cred.domain,
      username: cred.username,
      createdAt: cred.createdAt,
    }));
  }

  findForUrl(url) {
    if (!url) return [];
    let hostname = '';
    try { hostname = new URL(url).hostname; } catch { return []; }
    const domain = registrableDomain(url);
    const matches = this.data.credentials.filter((cred) => {
      return cred.domain === domain || cred.domain === hostname;
    });
    matches.sort((a, b) => {
      const aExact = a.domain === hostname ? 1 : 0;
      const bExact = b.domain === hostname ? 1 : 0;
      return bExact - aExact;
    });
    return matches;
  }

  async get(id) {
    const cred = this.data.credentials.find((item) => item.id === id);
    if (!cred) return null;
    const password = await this.decrypt(cred.password);
    return { id: cred.id, domain: cred.domain, username: cred.username, password };
  }

  async set({ domain, username, password }) {
    if (!domain || !username || !password) throw new Error('Domain, username and password are required');
    let hostname = '';
    try { hostname = new URL(domain).hostname; } catch { hostname = domain; }
    const cleanDomain = registrableDomain(domain) || hostname;

    const existing = this.data.credentials.find(
      (item) => item.domain === cleanDomain && item.username === username,
    );

    const encrypted = await this.encrypt(password);
    const now = Date.now();

    if (existing) {
      existing.password = encrypted;
      existing.passwordSalt = this.masterKey.salt;
      existing.updatedAt = now;
      this.saveNow();
      return existing;
    }

    if (this.data.credentials.length >= MAX_CREDENTIALS) {
      this.data.credentials.shift();
    }

    const record = {
      id: randomUUID(),
      domain: cleanDomain,
      username,
      password: encrypted,
      passwordSalt: this.masterKey.salt,
      createdAt: now,
    };
    this.data.credentials.push(record);
    this.saveNow();
    return record;
  }

  remove(id) {
    const before = this.data.credentials.length;
    this.data.credentials = this.data.credentials.filter((item) => item.id !== id);
    if (this.data.credentials.length !== before) this.saveNow();
    return this.data.credentials.length !== before;
  }

  removeForDomain(domain) {
    const cleanDomain = registrableDomain(domain);
    const before = this.data.credentials.length;
    this.data.credentials = this.data.credentials.filter(
      (item) => item.domain !== cleanDomain && item.domain !== domain,
    );
    if (this.data.credentials.length !== before) this.saveNow();
    return this.data.credentials.length !== before;
  }

  hasForDomain(domain) {
    const cleanDomain = registrableDomain(domain);
    return this.data.credentials.some(
      (item) => item.domain === cleanDomain || item.domain === domain,
    );
  }
}

module.exports = { PasswordManager, MAX_CREDENTIALS };
