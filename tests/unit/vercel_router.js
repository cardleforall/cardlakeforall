// A small stand-in for how Vercel serves this repository, so a test can
// drive the deployed app over real HTTP: static files from public/ first,
// then vercel.json's rewrites, then the deployed functions -- only the
// api/*.js files .vercelignore keeps, as on Vercel, so a route that only
// works through an excluded local-dev file fails here too. Requests get
// Vercel's helpers (req.query, a parsed req.body, res.status/json/send).
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function deployedFunctions() {
  const ignored = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split('\n')
    .map(line => line.trim()).filter(line => line && !line.startsWith('#')).map(globToRegExp);
  const found = new Map();
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(ROOT, full).split(path.sep).join('/');
      if (entry.isDirectory()) { if (entry.name !== '_lib') walk(full); continue; }
      if (!rel.endsWith('.js') || ignored.some(pattern => pattern.test(rel))) continue;
      found.set(`/${rel.replace(/\.js$/, '')}`, full);
    }
  })(path.join(ROOT, 'api'));
  return found;
}

// "/api/:resource(a|b)/:id" -> a RegExp with named groups.
function sourceToRegExp(source) {
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const param = /:(\w+)(?:\(([^)]*)\))?/g;
  let pattern = '';
  let last = 0;
  for (const found of source.matchAll(param)) {
    pattern += escape(source.slice(last, found.index)) + `(?<${found[1]}>${found[2] ?? '[^/]+'})`;
    last = found.index + found[0].length;
  }
  return new RegExp(`^${pattern}${escape(source.slice(last))}$`);
}

function rewrites() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8')).rewrites
    .map(({ source, destination }) => ({ match: sourceToRegExp(source), destination }));
}

function staticFile(pathname) {
  const file = path.join(PUBLIC, decodeURIComponent(pathname));
  if (!file.startsWith(PUBLIC)) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch (_) { return null; }
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const type = String(req.headers['content-type'] || '');
  if (!raw) return undefined;
  if (type.includes('application/json')) return JSON.parse(raw);
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  return raw;
}

function withHelpers(res) {
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); return res; };
  res.send = body => { res.end(body); return res; };
  return res;
}

// Starts the server on a free port; resolves to { server, origin }.
function startServer() {
  const functions = deployedFunctions();
  const routes = rewrites();
  const server = http.createServer(async (req, res) => {
    withHelpers(res);
    try {
      const url = new URL(req.url, 'http://placeholder');
      let pathname = url.pathname;
      const query = Object.fromEntries(url.searchParams);
      // Vercel serves an existing file before trying rewrites.
      if (!staticFile(pathname)) {
        for (const route of routes) {
          const found = route.match.exec(pathname);
          if (!found) continue;
          const params = found.groups || {};
          const destination = new URL(route.destination.replace(/:(\w+)/g, (_, name) => encodeURIComponent(params[name] ?? '')), 'http://placeholder');
          pathname = destination.pathname;
          for (const [key, value] of destination.searchParams) query[key] = value;
          break;
        }
      }
      const file = staticFile(pathname);
      if (file) {
        res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
        return res.end(fs.readFileSync(file));
      }
      const fn = functions.get(pathname) || functions.get(`${pathname}/index`);
      if (!fn) return res.status(404).json({ error: 'NOT_FOUND', path: pathname });
      req.query = query;
      req.body = await readBody(req);
      await require(fn)(req, res);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: 'FUNCTION_INVOCATION_FAILED', message: error.message });
    }
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { deployedFunctions, rewrites, sourceToRegExp, startServer };
