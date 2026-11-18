'use strict';

/**
 * Local SQLite history store.
 *
 * sql.js runs SQLite through WebAssembly so Swiftly does not need a native
 * add-on. Changes are exported to a normal SQLite file after they settle.
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_HISTORY = 5000;
const INSERT_HISTORY = `
  INSERT OR IGNORE INTO history (id, url, title, visited_at, visit_count, kind)
  VALUES (?, ?, ?, ?, ?, ?)
`;

class HistoryDatabase {
  static async open(filePath) {
    const initSqlJs = require('sql.js');
    const distDirectory = path.dirname(require.resolve('sql.js'));
    const SQL = await initSqlJs({
      locateFile: (filename) => path.join(distDirectory, filename),
    });
    return new HistoryDatabase(filePath, SQL);
  }

  constructor(filePath, SQL) {
    this.filePath = filePath;
    this.SQL = SQL;
    this.writeTimer = null;
    this.db = this.readDatabase();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        visited_at INTEGER NOT NULL,
        visit_count INTEGER NOT NULL DEFAULT 1,
        kind TEXT NOT NULL DEFAULT 'page'
      );
      CREATE INDEX IF NOT EXISTS history_visited_idx
        ON history (visited_at DESC, seq DESC);
      CREATE INDEX IF NOT EXISTS history_url_idx ON history (url);
      PRAGMA secure_delete = ON;
      PRAGMA user_version = 1;
    `);
    this.db.create_function('swiftly_lower', (value) => String(value || '').toLowerCase());
    this.persist();
  }

  readDatabase() {
    if (!fs.existsSync(this.filePath)) return new this.SQL.Database();
    try {
      return new this.SQL.Database(fs.readFileSync(this.filePath));
    } catch (error) {
      const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
      fs.renameSync(this.filePath, backupPath);
      console.error(`[swiftly] history database was unreadable; moved it to ${backupPath}: ${error.message}`);
      return new this.SQL.Database();
    }
  }

  /** Import history saved by older Swiftly versions in swiftly.json. */
  migrate(entries = []) {
    if (!entries.length) return;
    const recentEntries = entries.slice(0, MAX_HISTORY).reverse();
    this.db.exec('BEGIN TRANSACTION');
    try {
      for (const entry of recentEntries) {
        if (!entry || typeof entry.url !== 'string' || !entry.url) continue;
        const visitedAt = Number.isFinite(entry.visitedAt) ? entry.visitedAt : Date.now();
        const visitCount = Number.isInteger(entry.visitCount) && entry.visitCount > 0
          ? entry.visitCount
          : 1;
        this.db.run(INSERT_HISTORY, [
          typeof entry.id === 'string' && entry.id ? entry.id : randomUUID(),
          entry.url,
          String(entry.title || entry.url),
          visitedAt,
          visitCount,
          typeof entry.kind === 'string' ? entry.kind : 'page',
        ]);
      }
      this.trim();
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    this.persist();
  }

  add(entry = {}) {
    const url = String(entry.url || '');
    if (!url) return null;

    const title = String(entry.title || url);
    const kind = String(entry.kind || 'page');
    const visitedAt = Number.isFinite(entry.visitedAt) ? entry.visitedAt : Date.now();
    const latest = this.first(`
      SELECT id, url, title, visited_at AS visitedAt,
        visit_count AS visitCount, kind
      FROM history
      ORDER BY visited_at DESC, seq DESC
      LIMIT 1
    `);

    let record;
    this.db.exec('BEGIN TRANSACTION');
    try {
      if (latest && latest.url === url) {
        record = {
          ...latest,
          title,
          visitedAt: Math.max(visitedAt, latest.visitedAt),
          visitCount: latest.visitCount + 1,
          kind,
        };
        this.db.run(`
          UPDATE history
          SET title = ?, visited_at = ?, visit_count = ?, kind = ?
          WHERE id = ?
        `, [record.title, record.visitedAt, record.visitCount, record.kind, record.id]);
      } else {
        record = {
          id: randomUUID(),
          url,
          title,
          visitedAt,
          visitCount: 1,
          kind,
        };
        this.db.run(INSERT_HISTORY, [
          record.id,
          record.url,
          record.title,
          record.visitedAt,
          record.visitCount,
          record.kind,
        ]);
      }
      this.trim();
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    this.schedulePersist();
    return record;
  }

  list({ query = '', limit = 500, from = 0 } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    const numericLimit = Number(limit);
    const safeLimit = Math.max(0, Math.min(
      MAX_HISTORY,
      Number.isFinite(numericLimit) ? Math.floor(numericLimit) : 500,
    ));
    const safeFrom = Math.max(0, Math.floor(Number(from) || 0));
    const conditions = needle
      ? 'WHERE instr(swiftly_lower(title), ?) > 0 OR instr(swiftly_lower(url), ?) > 0'
      : '';
    const statement = this.db.prepare(`
      SELECT id, url, title, visited_at AS visitedAt,
        visit_count AS visitCount, kind
      FROM history
      ${conditions}
      ORDER BY visited_at DESC, seq DESC
      LIMIT ? OFFSET ?
    `);

    try {
      statement.bind(needle
        ? [needle, needle, safeLimit, safeFrom]
        : [safeLimit, safeFrom]);
      const entries = [];
      while (statement.step()) entries.push(statement.getAsObject());
      return entries;
    } finally {
      statement.free();
    }
  }

  remove(id) {
    this.db.run('DELETE FROM history WHERE id = ?', [String(id || '')]);
    if (this.db.getRowsModified()) this.schedulePersist();
  }

  clear() {
    this.db.exec('DELETE FROM history');
    this.schedulePersist();
  }

  close() {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
      try {
        this.persist();
      } catch (error) {
        console.error('[swiftly] failed to flush history:', error.message);
      }
    }
    if (this.db) this.db.close();
    this.db = null;
  }

  trim() {
    this.db.run(`
      DELETE FROM history
      WHERE seq NOT IN (
        SELECT seq FROM history
        ORDER BY visited_at DESC, seq DESC
        LIMIT ?
      )
    `, [MAX_HISTORY]);
  }

  first(sql, parameters = []) {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(parameters);
      return statement.step() ? statement.getAsObject() : null;
    } finally {
      statement.free();
    }
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, Buffer.from(this.db.export()));
    fs.renameSync(tempPath, this.filePath);
  }

  schedulePersist() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      try {
        this.persist();
      } catch (error) {
        console.error('[swiftly] failed to persist history:', error.message);
      }
    }, 400);
  }
}

module.exports = { HistoryDatabase, MAX_HISTORY };
