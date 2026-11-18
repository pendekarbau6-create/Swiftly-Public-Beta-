'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loadIndex, rankPages } = require('./index');

const HOST = '127.0.0.1';
const PORT = Number(process.env.SWIFTLY_SEARCH_PORT || 4177);
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

async function handle(request, response, indexPath) {
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    sendJson(response, 405, { error: 'Only GET requests are supported.' });
    return;
  }

  let url;
  try {
    url = new URL(request.url, `http://${HOST}:${PORT}`);
  } catch {
    sendJson(response, 400, { error: 'Invalid request URL.' });
    return;
  }

  if (url.pathname === '/api/stats') {
    const index = await loadIndex(indexPath);
    sendJson(response, 200, { indexedPages: index.pages.length, updatedAt: index.updatedAt });
    return;
  }

  if (url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').trim().slice(0, 200);
    const requestedLimit = Number(url.searchParams.get('limit')) || 10;
    const limit = Math.max(1, Math.min(20, Math.floor(requestedLimit)));
    const index = await loadIndex(indexPath);
    const results = query ? rankPages(query, index.pages, limit) : [];
    sendJson(response, 200, {
      query,
      results,
      total: results.length,
      indexedPages: index.pages.length,
      updatedAt: index.updatedAt,
    });
    return;
  }

  const asset = STATIC_FILES[url.pathname];
  if (!asset) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }

  const content = await fs.readFile(path.join(PUBLIC_DIR, asset[0]));
  response.writeHead(200, {
    'Content-Type': asset[1],
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(content);
}

function createServer({ indexPath } = {}) {
  return http.createServer((request, response) => {
    handle(request, response, indexPath).catch((error) => {
      console.error(`Search request failed: ${error.message}`);
      if (!response.headersSent) sendJson(response, 500, { error: 'Search service failed to read its local index.' });
      else response.destroy();
    });
  });
}

function startServer({ port = PORT, indexPath } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (port > 0 && port < 1024)) {
    throw new Error('SWIFTLY_SEARCH_PORT must be 0 or an integer from 1024 to 65535.');
  }

  const server = createServer({ indexPath });
  server.listen(port, HOST, () => {
    const address = server.address();
    console.log(`Swiftly Search is ready at http://${HOST}:${address.port}`);
    console.log('This server searches its own local index and does not use Electron or external search providers.');
  });
  return server;
}

if (require.main === module) {
  try {
    startServer();
  } catch (error) {
    console.error(`Could not start search service: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createServer, handle, startServer };
