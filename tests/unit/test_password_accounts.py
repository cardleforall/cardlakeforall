"""The owner's password account (api/_lib/local-accounts.js): first-run
setup, password sign-in, a Cardlake's single owner, and MCP OAuth with a
password. Runs the real handlers against real Postgres (PGlite, see
pg_harness.js) in an isolated Node process, with no secrets configured -- a
fresh one-click deployment."""
from __future__ import annotations

import json
import subprocess
import unittest

from ._paths import ROOT, source

PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"

PRELUDE = r"""
for (const name of ['SESSION_SECRET', 'SYNC_TOKEN', 'OAUTH_SIGNING_SECRET', 'INTEGRATION_ENCRYPTION_KEY', 'CARDLE_SETUP_OPEN', 'MCP_TOKEN']) delete process.env[name];
process.env.DATABASE_URL = 'postgres://unused-in-tests';
const assert = require('assert/strict');
const crypto = require('crypto');
const { createTestDb } = require('./tests/unit/pg_harness');
const db = require('./api/_lib/db');
// Required once the test database is in place: route files read getSql
// when they load.
let auth;
const PASSWORD = 'correct horse battery';
async function database() {
  const testDb = await createTestDb();
  db.getSql = () => testDb.sql;
  auth = require('./api/auth.js');
  return testDb.sql;
}
// Drives a handler the way Vercel would; remembers the session cookie a
// response sets, like a browser.
async function call(handler, { method = 'GET', query = {}, body, cookie = '', from } = {}) {
  const res = { code: null, body: null, headers: {}, html: null,
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; },
    send(h) { this.html = h; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } };
  const headers = { 'x-forwarded-for': from || '198.51.100.1' };
  if (cookie) headers.cookie = cookie;
  await handler({ method, headers, query, body }, res);
  const set = String(res.headers['Set-Cookie'] || '');
  res.cookie = set.startsWith('lh_session=') && !set.includes('Max-Age=0') ? set.split(';')[0] : null;
  return res;
}
const config = () => call(auth, { query: { action: 'config' } });
const setupStatus = () => call(auth, { query: { action: 'setup' } });
const setUp = (fields = {}) => call(auth, { method: 'POST', query: { action: 'setup' }, body: { name: 'Olive Owner', email: 'olive@example.test', password: PASSWORD, ...fields } });
const signIn = (email, password, from) => call(auth, { method: 'POST', query: { action: 'sign-in' }, body: { email, password }, from });
const session = cookie => call(auth, { query: { action: 'session' }, cookie });
async function owner() {
  const res = await setUp();
  assert.equal(res.code, 201, JSON.stringify(res.body));
  return res.cookie;
}
async function ageSetupWindow(sql, hours) {
  await sql(`update app_config set value = jsonb_build_object('at', (now() - interval '${hours} hours')::text) where key = 'instance_created_at'`);
}
"""


class Scenarios(unittest.TestCase):
    def run_node(self, body: str) -> None:
        script = PRELUDE + "(async () => {\n" + body + "\n})().catch(e => { console.error(e); process.exit(1); });"
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class SetupTests(Scenarios):
    def test_a_fresh_instance_sends_people_to_setup(self):
        self.run_node(r"""
await database();
const res = await config();
assert.deepEqual(res.body, { setupNeeded: true }, 'the pages learn only whether setup is needed');
const status = await setupStatus();
assert.equal(status.body.open, true);
assert.equal(status.body.reason, 'new');
assert.ok(Date.parse(status.body.closes_at) > Date.now());
""")

    def test_setup_makes_the_owner_and_signs_them_in(self):
        self.run_node(r"""
const sql = await database();
const cookie = await owner();
const me = await session(cookie);
assert.equal(me.body.email, 'olive@example.test');
assert.equal(me.body.isAdmin, undefined, 'there is nothing to administer');
assert.deepEqual((await config()).body, { setupNeeded: false });
const users = await sql("select password_hash from users where email = 'olive@example.test'");
assert.match(users[0].password_hash, /^\$2[aby]\$/, 'a bcrypt hash, never the password');
const recorded = await sql("select value from app_config where key = 'instance_owner'");
assert.equal(recorded[0].value.email, 'olive@example.test');
""")

    def test_a_second_person_cannot_create_an_account(self):
        self.run_node(r"""
const sql = await database();
await owner();
const second = await setUp({ email: 'mallory@example.test' });
assert.equal(second.code, 403);
assert.equal(second.body.code, 'SETUP_CLOSED');
assert.equal(second.cookie, null);
assert.equal((await setupStatus()).body.reason, 'done');
assert.equal((await sql('select count(*)::int as n from users')).at(0).n, 1, 'still only the owner');
""")

    def test_racing_setups_have_exactly_one_winner(self):
        self.run_node(r"""
const sql = await database();
const results = await Promise.all(['a', 'b', 'c'].map(name => setUp({ email: `${name}@example.test` })));
const winners = results.filter(res => res.code === 201);
assert.equal(winners.length, 1, JSON.stringify(results.map(res => res.body)));
const recorded = await sql("select value from app_config where key = 'instance_owner'");
assert.equal(recorded[0].value.email, winners[0].body.email);
""")

    def test_setup_closes_an_hour_after_the_instance_starts(self):
        self.run_node(r"""
const sql = await database();
await ageSetupWindow(sql, 2);
const status = await setupStatus();
assert.equal(status.body.open, false);
assert.equal(status.body.reason, 'expired');
assert.equal((await setUp()).code, 403);
assert.equal((await config()).body.setupNeeded, true, 'still sent to /setup, which explains how to reopen it');
""")

    def test_a_different_email_replaces_the_owner_and_their_access_ends(self):
        self.run_node(r"""
const sql = await database();
// A stranger got there first, and connected an assistant.
const strangerCookie = (await setUp({ email: 'mallory@example.test' })).cookie;
const token = await call(auth, { method: 'POST', query: { action: 'tokens' }, body: { label: 'Stranger' }, cookie: strangerCookie });
assert.equal(token.code, 201);
await sql("insert into bookmarks (user_email, title) values ('mallory@example.test', 'Stranger card')");
await ageSetupWindow(sql, 30);
process.env.CARDLE_SETUP_OPEN = '1';
assert.equal((await setupStatus()).body.reason, 'reopened');
const taken = await setUp({ email: 'olive@example.test' });
assert.equal(taken.code, 201, JSON.stringify(taken.body));
assert.equal((await session(taken.cookie)).body.email, 'olive@example.test');
assert.equal((await session(strangerCookie)).body.email, null, "the replaced owner's session stops working");
assert.equal((await signIn('mallory@example.test', PASSWORD)).code, 401, 'and they cannot sign in again');
const tokens = await sql("select revoked_at from api_tokens where user_email = 'mallory@example.test'");
assert.ok(tokens.every(row => row.revoked_at), 'their Connect AI tokens are revoked');
const kept = await sql("select count(*)::int as n from bookmarks where user_email = 'mallory@example.test' and deleted_at is null");
assert.equal(kept[0].n, 1, 'their cards stay in the database, out of reach');
""")

    def test_setup_open_replaces_a_forgotten_password_and_keeps_the_cards(self):
        self.run_node(r"""
const sql = await database();
const cookie = await owner();
await sql("insert into bookmarks (user_email, title) values ('olive@example.test', 'Mine')");
process.env.CARDLE_SETUP_OPEN = '1';
assert.equal((await setUp({ password: 'a brand new password' })).code, 201);
assert.equal((await signIn('olive@example.test', PASSWORD)).code, 401);
const res = await signIn('olive@example.test', 'a brand new password');
assert.equal(res.code, 200);
assert.equal((await session(cookie)).body.email, 'olive@example.test', 'the same owner stays signed in elsewhere');
const mine = await sql("select count(*)::int as n from bookmarks where user_email = 'olive@example.test' and deleted_at is null");
assert.equal(mine[0].n, 1);
""")

    def test_setup_checks_its_input(self):
        self.run_node(r"""
await database();
assert.equal((await setUp({ password: 'short' })).body.code, 'PASSWORD_TOO_SHORT');
assert.equal((await setUp({ password: 'x'.repeat(73) })).body.code, 'PASSWORD_TOO_LONG');
assert.equal((await setUp({ password: 'é'.repeat(37) })).body.code, 'PASSWORD_TOO_LONG', '72 bytes, not characters');
assert.equal((await setUp({ email: 'not an email' })).code, 400);
assert.equal((await setupStatus()).body.open, true, 'a refused attempt leaves setup open');
""")

    def test_setup_is_rate_limited(self):
        self.run_node(r"""
await database();
let res;
for (let i = 0; i < 10; i += 1) res = await call(auth, { method: 'POST', query: { action: 'setup' }, body: { email: 'olive@example.test', password: 'short' }, from: '203.0.113.60' });
assert.equal(res.body.code, 'PASSWORD_TOO_SHORT');
res = await call(auth, { method: 'POST', query: { action: 'setup' }, body: { email: 'olive@example.test', password: PASSWORD }, from: '203.0.113.60' });
assert.equal(res.code, 429);
""")


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class SignInTests(Scenarios):
    def test_the_right_password_signs_in(self):
        self.run_node(r"""
await database();
await owner();
const res = await signIn('Olive@Example.test', PASSWORD);
assert.equal(res.code, 200);
assert.equal((await session(res.cookie)).body.email, 'olive@example.test');
""")

    def test_a_wrong_password_or_unknown_email_is_refused_alike(self):
        self.run_node(r"""
await database();
await owner();
const wrong = await signIn('olive@example.test', 'not the password');
const unknown = await signIn('nobody@example.test', PASSWORD);
assert.equal(wrong.code, 401);
assert.equal(unknown.code, 401);
assert.equal(wrong.body.error, unknown.body.error, "doesn't say which email is the owner's");
assert.equal(wrong.cookie, null);
""")

    def test_nobody_but_the_owner_can_sign_in(self):
        self.run_node(r"""
const sql = await database();
await owner();
// A password row for someone else, however it got there, signs nobody in.
const bcrypt = require('bcryptjs');
await sql('insert into users (email, password_hash) values ($1, $2)', ['second@example.test', await bcrypt.hash(PASSWORD, 4)]);
const res = await signIn('second@example.test', PASSWORD);
assert.equal(res.code, 401);
assert.equal(res.cookie, null);
// Nor does a session minted for them.
const { setSessionCookie } = require('./api/_lib/auth');
let cookie = '';
setSessionCookie({ setHeader: (_, v) => { cookie = v.split(';')[0]; } }, { email: 'second@example.test' });
const me = await session(cookie);
assert.equal(me.body.email, null);
assert.match(String(me.headers['Set-Cookie']), /Max-Age=0/, 'the browser is told to drop it');
""")

    def test_sign_in_is_rate_limited(self):
        self.run_node(r"""
await database();
await owner();
const from = '203.0.113.50';
let res;
for (let i = 0; i < 10; i += 1) res = await signIn('olive@example.test', `guess ${i}`, from);
assert.equal(res.code, 401);
res = await signIn('olive@example.test', PASSWORD, from);
assert.equal(res.code, 429, 'even the right password waits once the limit is hit');
assert.equal(res.body.code, 'RATE_LIMITED');
assert.equal((await signIn('olive@example.test', PASSWORD, '203.0.113.51')).code, 200);
""")


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class SyncTokenTests(Scenarios):
    def test_the_owner_sees_a_generated_sync_token(self):
        self.run_node(r"""
await database();
const cookie = await owner();
const secrets = require('./api/_lib/instance-secrets');
const res = await call(auth, { query: { action: 'instance' }, cookie });
assert.equal(res.code, 200);
assert.deepEqual(res.body.sync_token, { source: 'generated', value: secrets.instanceSecret('SYNC_TOKEN') });
assert.equal((await call(auth, { query: { action: 'instance' } })).code, 401, 'never to a signed-out visitor');
""")

    def test_a_sync_token_set_in_vercel_is_never_echoed_back(self):
        self.run_node(r"""
process.env.SYNC_TOKEN = 'sync-from-the-environment';
await database();
const cookie = await owner();
const res = await call(auth, { query: { action: 'instance' }, cookie });
assert.deepEqual(res.body.sync_token, { source: 'environment', value: null });
""")


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class McpOAuthWithPasswordTests(Scenarios):
    OAUTH = r"""
const oauth = require('./api/_lib/oauth');
const oauthRoute = (...args) => require('./api/oauth.js')(...args);
const verifier = crypto.randomBytes(32).toString('base64url');
const params = {
  response_type: 'code', client_id: oauth.CLAUDE_CLIENT_ID, redirect_uri: oauth.CLAUDE_REDIRECT_URI,
  resource: oauth.RESOURCE, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
  code_challenge_method: 'S256', scope: 'cardle.read cardle.write', state: 'xyz',
};
async function authorize(cookie, body) {
  const page = await call(oauthRoute, { query: { action: 'authorize', ...params }, cookie });
  assert.equal(page.code, 200);
  const tx = String(page.headers['Set-Cookie']).split(';')[0];
  const res = await call(oauthRoute, { method: 'POST', query: { action: 'authorize' }, body, cookie: [cookie, tx].filter(Boolean).join('; ') });
  return { page, res };
}
async function exchange(redirect) {
  const code = new URL(redirect).searchParams.get('code');
  return call(oauthRoute, { method: 'POST', query: { action: 'token' }, body: { grant_type: 'authorization_code', code, client_id: oauth.CLAUDE_CLIENT_ID, redirect_uri: oauth.CLAUDE_REDIRECT_URI, resource: oauth.RESOURCE, code_verifier: verifier } });
}
"""

    def test_a_password_session_authorizes_an_ai_assistant(self):
        self.run_node(self.OAUTH + r"""
await database();
const cookie = await owner();
const { page, res } = await authorize(cookie, { session: true });
assert.match(page.html, /Continue as olive@example.test/);
assert.ok(res.body.redirect, JSON.stringify(res.body));
const tokens = await exchange(res.body.redirect);
assert.equal(tokens.code, 200, JSON.stringify(tokens.body));
const resolved = oauth.resolveOAuthAuthorization({ headers: { authorization: `Bearer ${tokens.body.access_token}` } });
assert.equal(resolved.tenant, 'olive@example.test');
""")

    def test_the_consent_page_signs_in_with_the_owners_password(self):
        self.run_node(self.OAUTH + r"""
await database();
await owner();
const { page, res } = await authorize('', { email: 'olive@example.test', password: PASSWORD });
assert.match(page.html, /type="password"/);
assert.doesNotMatch(page.html, /google/i);
assert.ok(res.body.redirect, JSON.stringify(res.body));
assert.equal((await exchange(res.body.redirect)).code, 200);
const wrong = await authorize('', { email: 'olive@example.test', password: 'wrong password' });
assert.equal(wrong.res.code, 401);
assert.equal(wrong.res.body.redirect, undefined);
""")

    def test_a_replaced_owner_cannot_refresh_their_assistants_tokens(self):
        self.run_node(self.OAUTH + r"""
const sql = await database();
const cookie = await owner();
const { res } = await authorize(cookie, { session: true });
const tokens = await exchange(res.body.redirect);
process.env.CARDLE_SETUP_OPEN = '1';
assert.equal((await setUp({ email: 'new-owner@example.test' })).code, 201);
const refreshed = await call(oauthRoute, { method: 'POST', query: { action: 'token' }, body: { grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: oauth.CLAUDE_CLIENT_ID } });
assert.equal(refreshed.code, 400);
const { isAccountActive } = require('./api/_lib/session-guard');
assert.equal(await isAccountActive('olive@example.test'), false, 'their hour-long access token stops at the MCP server too');
""")

    def test_an_assistant_reaches_the_mcp_server_on_a_cold_instance(self):
        # Regression: api/mcp.js takes only bearer credentials, so it isn't
        # wrapped in the request guard, and on a fresh instance it never
        # loaded the generated OAuth signing secret. Every OAuth call crashed
        # the function, so Claude authorized but then couldn't connect.
        self.run_node(self.OAUTH + r"""
await database();
const cookie = await owner();
const { res } = await authorize(cookie, { session: true });
const tokens = await exchange(res.body.redirect);
assert.equal(tokens.code, 200, JSON.stringify(tokens.body));
const secrets = require('./api/_lib/instance-secrets');
secrets.forgetInstanceSecrets();  // a new instance: nothing loaded yet
assert.throws(() => oauth.resolveOAuthAuthorization({ headers: { authorization: `Bearer ${tokens.body.access_token}` } }), /not configured/);

// The real endpoint over real HTTP, as Vercel runs it.
const http = require('http');
const mcp = require('./api/mcp.js');
const server = http.createServer(async (req, res) => {
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(b)); return res; };
  let raw = '';
  for await (const chunk of req) raw += chunk;
  req.body = raw ? JSON.parse(raw) : undefined;
  req.query = {};
  await mcp(req, res);
});
await new Promise(resolve => server.listen(0, resolve));
const post = async authorization => {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: authorization },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }),
  });
  return { status: response.status, body: await response.text() };
};
const garbage = await post('Bearer not.a.token');
assert.equal(garbage.status, 401, garbage.body);
secrets.forgetInstanceSecrets();
const ok = await post(`Bearer ${tokens.body.access_token}`);
assert.equal(ok.status, 200, ok.body);
assert.match(ok.body, /"serverInfo"/);
server.close();
""")

    def test_the_consent_page_limits_password_guesses(self):
        # The consent page takes the owner's password too, so it is a second
        # place to guess it: the same 10 tries per 15 minutes as /signin.
        self.run_node(self.OAUTH + r"""
await database();
await owner();
const page = await call(oauthRoute, { query: { action: 'authorize', ...params } });
const tx = String(page.headers['Set-Cookie']).split(';')[0];
const from = '203.0.113.70';
const guess = password => call(oauthRoute, { method: 'POST', query: { action: 'authorize' }, body: { email: 'olive@example.test', password }, cookie: tx, from });
for (let i = 0; i < 10; i += 1) assert.equal((await guess(`guess ${i}`)).code, 401, `guess ${i + 1}`);
const limited = await guess(PASSWORD);
assert.equal(limited.code, 429, 'even the right password waits once the limit is hit');
assert.equal(limited.body.redirect, undefined);
// It is the sign-in limit: guesses here count against /signin as well.
assert.equal((await signIn('olive@example.test', PASSWORD, from)).code, 429);
""")

    def test_connect_ai_tokens_work_with_a_password_session(self):
        self.run_node(r"""
await database();
const cookie = await owner();
const made = await call(auth, { method: 'POST', query: { action: 'tokens' }, body: { label: 'Claude Desktop' }, cookie });
assert.equal(made.code, 201, JSON.stringify(made.body));
assert.ok(made.body.token.token);
""")


class PasswordAccountWiringTests(unittest.TestCase):
    def test_account_pages_and_routes_are_wired(self):
        config = json.loads(source(ROOT / "vercel.json"))
        routes = {entry["source"]: entry["destination"] for entry in config["rewrites"]}
        for page in ("setup", "signin"):
            self.assertEqual(routes[f"/{page}"], f"/{page}.html")
        for action in ("config", "setup", "sign-in", "sign-out-everywhere", "instance"):
            self.assertEqual(routes[f"/api/auth/{action}"], f"/api/auth?action={action}")
            self.assertTrue((ROOT / "api" / "auth" / f"{action}.js").exists(), f"local-dev wrapper for {action}")
        # One owner and nobody else: no sign-up, invite, join or admin routes.
        for word in ("signup", "join", "invite", "access-users", "admin", "google", "test-session"):
            self.assertFalse(any(word in route for route in routes), word)
        self.assertFalse((ROOT / "api" / "admin.js").exists())

    def test_no_new_serverless_functions(self):
        # Hobby allows 12 functions per deployment; account routes live in
        # api/auth.js.
        for name in ("setup.js", "sign-in.js", "account.js"):
            self.assertFalse((ROOT / "api" / name).exists(), name)

    def test_a_fresh_instance_opens_on_setup(self):
        for page in (ROOT / "public" / "signin.html", ROOT / "public" / "vault" / "assets" / "vault.js", ROOT / "public" / "vault" / "assets" / "welcome.js"):
            text = source(page)
            self.assertIn("setupNeeded", text, page.name)
            self.assertIn("'/setup'", text, page.name)

    def test_setup_page_tells_the_owner_about_the_window(self):
        page = source(ROOT / "public" / "setup.html")
        self.assertIn("setup is open for one hour", page)
        self.assertIn("The first person to finish setup becomes the owner", page)
        self.assertIn("CARDLE_SETUP_OPEN", page)

    def test_the_sync_token_is_under_connect_ai_advanced(self):
        vault = source(ROOT / "public" / "vault" / "assets" / "vault.js")
        self.assertIn("showSyncToken(modal)", vault)
        self.assertIn("api('/api/auth/instance')", vault)
        self.assertIn("Advanced: sync token", vault)


if __name__ == "__main__":
    unittest.main()
