'use strict';

/**
 * A small cookie jar.
 *
 * Some search engines only serve their server-rendered result layout to
 * clients that look like returning visitors. Priming a session with the
 * homepage — and keeping the cookies — makes the difference between a full
 * result list and an empty, JavaScript-only page.
 */

const DEFAULT_MAX_AGE = 60 * 60 * 24 * 365; // one year

class CookieJar {
  constructor() {
    /** @type {Map<string, {value:string, domain:string, path:string, expires:number, secure:boolean}>} */
    this.cookies = new Map();
  }

  /** Store the cookies from a response's Set-Cookie headers. */
  absorb(headers, url) {
    const raw = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get && headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
    if (!raw || !raw.length) return;

    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return;
    }

    for (const line of raw) {
      const parts = String(line).split(';');
      const [nameValue, ...attrs] = parts;
      const eq = nameValue.indexOf('=');
      if (eq < 1) continue;

      const name = nameValue.slice(0, eq).trim();
      const value = nameValue.slice(eq + 1).trim();
      if (!name) continue;

      let domain = host;
      let path = '/';
      let expires = Date.now() + DEFAULT_MAX_AGE * 1000;
      let secure = false;

      for (const attr of attrs) {
        const [rawKey, ...rest] = attr.split('=');
        const key = rawKey.trim().toLowerCase();
        const attrValue = rest.join('=').trim();

        if (key === 'domain' && attrValue) {
          domain = attrValue.replace(/^\./, '').toLowerCase();
        } else if (key === 'path' && attrValue) {
          path = attrValue;
        } else if (key === 'secure') {
          secure = true;
        } else if (key === 'max-age') {
          const seconds = parseInt(attrValue, 10);
          if (Number.isFinite(seconds)) expires = Date.now() + seconds * 1000;
        } else if (key === 'expires') {
          const parsed = Date.parse(attrValue);
          if (Number.isFinite(parsed)) expires = parsed;
        }
      }

      // A cookie may only be set for the domain that issued it.
      if (domain !== host && !host.endsWith(`.${domain}`)) continue;

      const key2 = `${domain}|${path}|${name}`;
      if (expires <= Date.now()) {
        this.cookies.delete(key2);
      } else {
        this.cookies.set(key2, { name, value, domain, path, expires, secure });
      }
    }
  }

  /** Build the `Cookie` header for a URL, or '' when nothing applies. */
  headerFor(url) {
    let host = '';
    let path = '/';
    let secure = false;
    try {
      const parsed = new URL(url);
      host = parsed.hostname.toLowerCase();
      path = parsed.pathname || '/';
      secure = parsed.protocol === 'https:';
    } catch {
      return '';
    }

    const now = Date.now();
    const parts = [];
    for (const [key, cookie] of this.cookies) {
      if (cookie.expires <= now) {
        this.cookies.delete(key);
        continue;
      }
      if (cookie.secure && !secure) continue;
      if (cookie.domain !== host && !host.endsWith(`.${cookie.domain}`)) continue;
      if (!path.startsWith(cookie.path)) continue;
      parts.push(`${cookie.name}=${cookie.value}`);
    }
    return parts.join('; ');
  }

  /** Does this jar hold any cookies for the given host? */
  hasFor(host) {
    const target = String(host).toLowerCase();
    const now = Date.now();
    for (const [, cookie] of this.cookies) {
      if (cookie.expires <= now) continue;
      if (cookie.domain === target || target.endsWith(`.${cookie.domain}`)) return true;
    }
    return false;
  }

  clear() {
    this.cookies.clear();
  }

  get size() {
    return this.cookies.size;
  }
}

module.exports = { CookieJar };
