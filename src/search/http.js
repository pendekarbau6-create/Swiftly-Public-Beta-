'use strict';

/**
 * HTTP layer for the Swiftly search engine.
 *
 * Handles timeouts, retries with backoff, rotating user agents, and — most
 * importantly — classifies *why* a request failed. Search engines throttle and
 * captcha aggressively, and the engine needs to tell "this provider is
 * blocking us" apart from "the network is down" to pick the right fallback.
 */

const AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
];

const DEFAULT_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
};

class HttpError extends Error {
  constructor(message, { status = 0, kind = 'network', url = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.kind = kind; // 'timeout' | 'blocked' | 'http' | 'network' | 'parse'
    this.url = url;
  }
}

let agentCursor = 0;
function nextAgent() {
  agentCursor = (agentCursor + 1) % AGENTS.length;
  return AGENTS[agentCursor];
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Detect interstitials that engines serve instead of real results. */
function looksBlocked(body, status) {
  if (status === 403 || status === 429 || status === 503) return true;
  if (!body) return false;
  const head = body.slice(0, 4000).toLowerCase();
  const markers = [
    'captcha', 'are you a robot', 'unusual traffic', 'recaptcha',
    'challenge-platform', 'cf-challenge', 'just a moment', 'anubis',
    'enable javascript and cookies', 'access denied', 'rate limit',
  ];
  return markers.some((m) => head.includes(m));
}

/**
 * Perform a GET request.
 * @returns {Promise<{ok:boolean,status:number,body:string,url:string,headers:Headers}>}
 */
async function get(url, options = {}) {
  const {
    timeout = 12000,
    retries = 1,
    headers = {},
    agent = null,
    method = 'GET',
    signal: outerSignal,
    jar = null,
  } = options;

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onOuterAbort = () => controller.abort();
    if (outerSignal) {
      if (outerSignal.aborted) controller.abort();
      else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
      const requestHeaders = {
        ...DEFAULT_HEADERS,
        'User-Agent': agent || nextAgent(),
        ...headers,
      };

      // Reuse cookies from the jar so the engine keeps a session with engines
      // that only serve their full layout to "returning" clients.
      if (jar) {
        const cookie = jar.headerFor(url);
        if (cookie && !requestHeaders.Cookie) requestHeaders.Cookie = cookie;
      }

      const response = await fetch(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: requestHeaders,
      });

      const body = await response.text();
      const finalUrl = response.url || url;

      if (jar) jar.absorb(response.headers, finalUrl);

      if (!response.ok) {
        const kind = looksBlocked(body, response.status) ? 'blocked' : 'http';
        throw new HttpError(`${response.status} from ${url}`, {
          status: response.status,
          kind,
          url: finalUrl,
        });
      }

      if (looksBlocked(body, response.status)) {
        throw new HttpError('Blocked by anti-bot interstitial', {
          status: response.status,
          kind: 'blocked',
          url: finalUrl,
        });
      }

      return { ok: true, status: response.status, body, url: finalUrl, headers: response.headers };
    } catch (error) {
      if (error instanceof HttpError) {
        lastError = error;
        // Blocked responses rarely recover on retry — fail fast.
        if (error.kind === 'blocked') break;
      } else if (outerSignal && outerSignal.aborted) {
        const reason = outerSignal.reason;
        lastError = new HttpError(reason?.message || 'Request aborted', {
          kind: 'timeout',
          url,
        });
      } else if (error.name === 'AbortError') {
        lastError = new HttpError(`Timed out after ${timeout}ms: ${url}`, {
          kind: 'timeout',
          url,
        });
      } else {
        lastError = new HttpError(error.message || 'Network error', {
          kind: 'network',
          url,
        });
      }

      if (attempt < retries) {
        await sleep(250 * (attempt + 1) + Math.floor(Math.random() * 150));
      }
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    }
  }

  throw lastError || new HttpError('Request failed', { url });
}

/** Perform a GET and parse the response as JSON. */
async function getJson(url, options = {}) {
  const response = await get(url, {
    ...options,
    headers: {
      Accept: 'application/json, text/plain, */*',
      ...(options.headers || {}),
    },
  });
  try {
    return { ...response, json: JSON.parse(response.body) };
  } catch {
    throw new HttpError('Malformed JSON response', {
      status: response.status,
      kind: 'parse',
      url: response.url,
    });
  }
}

module.exports = { get, getJson, HttpError, AGENTS, looksBlocked };