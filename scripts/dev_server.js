#!/usr/bin/env node
// Minimal local stand-in for `vercel dev`: serves public/ statically and
// routes /api/* to the same handler files Vercel would use, with the same
// filesystem conventions (index.js, [id].js, nested [id]/child.js). No
// vercel.json rewrites are applied -- those are unrelated to this repo's
// direct api/**/*.js file routing.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const ROOT = path.join(__dirname, '..');
const API_DIR = path.join(ROOT, 'api');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
// vercel.json's page rewrites, e.g. "/setup" -> "/setup.html".
const ACCOUNT_PAGES = new Set(['/setup', '/signin']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function findRoute(dir, segments) {
  if (segments.length === 0) {
    const indexFile = path.join(dir, 'index.js');
    return fs.existsSync(indexFile) ? { file: indexFile, params: {} } : null;
  }
  const [head, ...rest] = segments;
  if (rest.length === 0) {
    const exact = path.join(dir, `${head}.js`);
    if (fs.existsSync(exact)) return { file: exact, params: {} };
  }
  const literalDir = path.join(dir, head);
  if (fs.existsSync(literalDir) && fs.statSync(literalDir).isDirectory()) {
    const found = findRoute(literalDir, rest);
    if (found) return found;
  }
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return null; }
  for (const entry of entries) {
    if (entry.isDirectory() && /^\[.+\]$/.test(entry.name)) {
      const found = findRoute(path.join(dir, entry.name), rest);
      if (found) return { file: found.file, params: { [entry.name.slice(1, -1)]: head, ...found.params } };
    }
  }
  if (rest.length === 0) {
    for (const entry of entries) {
      if (entry.isFile() && /^\[.+\]\.js$/.test(entry.name)) {
        return { file: path.join(dir, entry.name), params: { [entry.name.slice(1, entry.name.length - 4)]: head } };
      }
    }
  }
  return null;
}

function shimResponse(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); return res; };
  res.send = body => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(body); return res; };
  return res;
}

async function serveApi(req, res, segments, query) {
  const route = findRoute(API_DIR, segments);
  if (!route) { shimResponse(res).status(404).json({ error: 'Not found' }); return; }
  delete require.cache[require.resolve(route.file)];
  // Also clear cached _lib modules so edits to shared helpers take effect
  // without restarting the whole server.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(API_DIR, '_lib'))) delete require.cache[key];
  }
  // Local-dev-only route files aren't wrapped individually, so apply the
  // same revoked-session guard production functions use (a no-op for the
  // ones that already are).
  const { withSessionGuard } = require(path.join(API_DIR, '_lib', 'session-guard'));
  const handler = withSessionGuard(require(route.file));
  req.query = { ...query, ...route.params };
  shimResponse(res);
  try {
    await handler(req, res);
  } catch (error) {
    console.error(`[dev-server] ${req.method} ${req.url} ->`, error);
    if (!res.headersSent) res.status(500).json({ error: error.message || String(error) });
  }
}

function serveStatic(req, res, pathname) {
  let filePath = path.join(PUBLIC_DIR, decodeURIComponent(pathname));
  if (pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');
  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isDirectory()) filePath = path.join(filePath, 'index.html');
    fs.readFile(filePath, (readErr, data) => {
      if (readErr) { res.statusCode = 404; res.end('Not found'); return; }
      res.setHeader('Content-Type', CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream');
      res.end(data);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const query = Object.fromEntries(url.searchParams);
  if (url.pathname.startsWith('/api/')) {
    const segments = url.pathname.slice('/api/'.length).split('/').filter(Boolean);
    await serveApi(req, res, segments, query);
    return;
  }
  // Mirrors vercel.json's "/" rewrite: the app, which sends a signed-out
  // visitor to sign in (or to setup).
  if (ACCOUNT_PAGES.has(url.pathname)) return serveStatic(req, res, `${url.pathname}.html`);
  serveStatic(req, res, url.pathname === '/' ? '/vault/index.html' : url.pathname);
});

server.listen(PORT, () => {
  console.log(`Cardlake dev server: http://localhost:${PORT} (also served at /vault/)`);
});
