// An owner's whole path through a fresh deployment, over real HTTP and
// through vercel.json's routing (vercel_router.js), against an empty
// database with no secret variables set: what someone gets the moment the
// Deploy button finishes. Every other test calls handlers directly with a
// hand-built query, so a wrong rewrite would only show up here.
// Invoked by test_owner_journey.py.
'use strict';

for (const name of ['SESSION_SECRET', 'SYNC_TOKEN', 'OAUTH_SIGNING_SECRET', 'INTEGRATION_ENCRYPTION_KEY', 'INTEGRATION_ENCRYPTION_KEYS_PREVIOUS', 'MCP_TOKEN', 'CRON_SECRET', 'CARDLE_SETUP_OPEN']) delete process.env[name];
process.env.DATABASE_URL = 'postgres://unused-in-tests';

const assert = require('assert/strict');
const crypto = require('crypto');
const { createTestDb } = require('./pg_harness');
const db = require('../../api/_lib/db');
const { startServer } = require('./vercel_router');

const PASSWORD = 'correct horse battery';

// A browser: keeps cookies per name, sends Origin on POSTs like a page does.
function browser(origin) {
  const jar = new Map();
  return async function request(pathname, { method = 'GET', json, form, headers = {}, cookies = true } = {}) {
    const sent = { ...headers };
    if (cookies && jar.size) sent.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (method !== 'GET' && !('origin' in sent)) sent.origin = origin;
    let body;
    if (json !== undefined) { sent['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (form !== undefined) { sent['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const res = await fetch(origin + pathname, { method, headers: sent, body, redirect: 'manual' });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const [name, ...value] = pair.split('=');
      if (attrs.some(a => /max-age=0/i.test(a)) || value.join('=') === '') jar.delete(name.trim());
      else jar.set(name.trim(), value.join('='));
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { /* a page */ }
    return { status: res.status, text, data, headers: res.headers };
  };
}

const mcpCall = (request, authorization, method, params = {}) => request('/api/mcp', {
  method: 'POST', cookies: false,
  headers: { authorization, accept: 'application/json, text/event-stream', origin: undefined },
  json: { jsonrpc: '2.0', id: 1, method, params },
});

(async () => {
  const testDb = await createTestDb({ schema: false });
  db.getSql = () => testDb.sql;
  const { server, origin } = await startServer();
  // The deployment's own address, as Vercel's production domain would give.
  process.env.CARDLE_PUBLIC_ORIGIN = origin;
  const owner = browser(origin);
  const stranger = browser(origin);
  try {
    // 1. A fresh deployment opens on setup; nothing has been typed anywhere.
    const home = await owner('/');
    assert.equal(home.status, 200);
    assert.match(home.text, /id="dashboard-app"/, '/ serves the vault');
    assert.deepEqual((await owner('/api/auth/config')).data, { setupNeeded: true });
    assert.match((await owner('/setup')).text, /Set up your Cardlake/);
    assert.match((await owner('/signin')).text, /Sign in to Cardlake/);
    assert.match((await owner('/robots.txt')).text, /Disallow: \//);

    // 2. Setup makes the owner and signs them in; a cross-site attempt can't.
    const forged = await stranger('/api/auth/setup', { method: 'POST', json: { email: 'mallory@example.test', password: PASSWORD }, headers: { origin: 'https://evil.example' } });
    assert.equal(forged.status, 403, 'login CSRF refused');
    const setup = await owner('/api/auth/setup', { method: 'POST', json: { name: 'Olive', email: 'olive@example.test', password: PASSWORD } });
    assert.equal(setup.status, 201, setup.text);
    assert.equal((await owner('/api/auth/session')).data.email, 'olive@example.test');
    assert.deepEqual((await owner('/api/auth/config')).data, { setupNeeded: false });
    const second = await stranger('/api/auth/setup', { method: 'POST', json: { email: 'mallory@example.test', password: PASSWORD } });
    assert.equal(second.status, 403, 'nobody else can set it up');

    // 3. Cards, through the rewritten resource routes, end up in the feed.
    const made = await owner('/api/reminders', { method: 'POST', json: { title: 'Call the dentist' } });
    assert.equal(made.status, 201, made.text);
    const id = (made.data.item || made.data.reminder || made.data).id;
    assert.ok(id, made.text);
    assert.equal((await owner(`/api/reminders/${id}`, { method: 'PATCH', json: { title: 'Call the dentist on Monday' } })).status, 200);
    const bookmark = await owner('/api/bookmarks', { method: 'POST', json: { title: 'Cardlake docs', url: 'https://example.test/docs' } });
    assert.equal(bookmark.status, 201, bookmark.text);
    const feed = await owner('/api/feed');
    assert.equal(feed.status, 200, feed.text);
    const titles = feed.data.cards.map(card => card.title);
    assert.ok(titles.includes('Call the dentist on Monday') && titles.includes('Cardlake docs'), titles.join(', '));
    assert.equal((await owner('/api/dashboard/stats')).data.stats.reminders, 1);
    // A signed-out visitor sees none of it.
    const outside = await stranger('/api/feed');
    assert.ok(!outside.data.cards.some(card => card.title === 'Call the dentist on Monday'), 'private cards stay private');
    assert.equal((await stranger('/api/reminders', { method: 'POST', json: { title: 'x' } })).status, 401);

    // 4. Connect AI: a personal token reaches the MCP server.
    const token = await owner('/api/auth/tokens', { method: 'POST', json: { label: 'Claude Code' } });
    assert.equal(token.status, 201, token.text);
    const tools = await mcpCall(owner, `Bearer ${token.data.token.token}`, 'tools/list');
    assert.equal(tools.status, 200, tools.text);
    assert.ok(tools.data.result.tools.some(tool => tool.name === 'list_feed'), tools.text);
    const listed = await mcpCall(owner, `Bearer ${token.data.token.token}`, 'tools/call', { name: 'list_feed', arguments: {} });
    assert.match(listed.text, /Call the dentist on Monday/);

    // 5. Claude.ai and ChatGPT: discovery, consent with the session, token.
    const meta = (await owner('/.well-known/oauth-authorization-server')).data;
    assert.equal(meta.issuer, origin);
    assert.equal((await owner('/.well-known/oauth-protected-resource')).data.resource, `${origin}/api/mcp`);
    const oauth = require('../../api/_lib/oauth');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const params = new URLSearchParams({
      response_type: 'code', client_id: oauth.CLAUDE_CLIENT_ID, redirect_uri: oauth.CLAUDE_REDIRECT_URI,
      resource: `${origin}/api/mcp`, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', scope: 'cardle.read cardle.write', state: 'xyz',
    });
    const consent = await owner(`/oauth/authorize?${params}`);
    assert.equal(consent.status, 200, consent.text);
    assert.match(consent.text, /Continue as olive@example\.test/);
    const approved = await owner('/oauth/authorize', { method: 'POST', json: { session: true } });
    assert.ok(approved.data?.redirect, approved.text);
    const code = new URL(approved.data.redirect).searchParams.get('code');
    const issued = await stranger('/oauth/token', { method: 'POST', form: { grant_type: 'authorization_code', code, client_id: oauth.CLAUDE_CLIENT_ID, redirect_uri: oauth.CLAUDE_REDIRECT_URI, resource: `${origin}/api/mcp`, code_verifier: verifier } });
    assert.equal(issued.status, 200, issued.text);
    assert.equal((await mcpCall(owner, `Bearer ${issued.data.access_token}`, 'tools/list')).status, 200);
    const challenge = await mcpCall(owner, 'Bearer not.a.token', 'tools/list');
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get('www-authenticate'), /resource_metadata=/);

    // 6. The sync token: shown to the owner, and enough for /api/migrate.
    const instance = await owner('/api/auth/instance');
    assert.equal(instance.data.sync_token.source, 'generated');
    assert.equal((await stranger('/api/auth/instance')).status, 401);
    const migrated = await stranger('/api/migrate', { method: 'POST', headers: { 'x-sync-token': instance.data.sync_token.value } });
    assert.equal(migrated.status, 200, migrated.text);

    // 7. Sign out everywhere ends this session; the password signs in again.
    const before = browser(origin);
    assert.equal((await before('/api/auth/sign-in', { method: 'POST', json: { email: 'olive@example.test', password: PASSWORD } })).status, 200);
    assert.equal((await owner('/api/auth/sign-out-everywhere', { method: 'POST' })).status, 200);
    assert.equal((await owner('/api/auth/session')).data.email, null);
    assert.equal((await before('/api/auth/session')).data.email, null, 'the other device is signed out too');
    assert.equal((await stranger('/api/auth/sign-in', { method: 'POST', json: { email: 'mallory@example.test', password: PASSWORD } })).status, 401);
    assert.equal((await owner('/api/auth/sign-in', { method: 'POST', json: { email: 'olive@example.test', password: PASSWORD } })).status, 200);
    assert.equal((await owner('/api/auth/session')).data.email, 'olive@example.test');

    // 8. Routes Cardlake doesn't have aren't reachable.
    for (const gone of ['/api/admin', '/api/signup', '/api/feedback', '/landing.html', '/api/auth/google', '/api/auth/test-session', '/api/auth/login']) {
      const res = await owner(gone, gone.startsWith('/api/auth/') ? { method: 'POST', json: {} } : {});
      assert.equal(res.status, 404, `${gone}: ${res.status}`);
    }
  } finally {
    server.close();
  }
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
