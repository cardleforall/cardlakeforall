"""Sessions roll and can be ended everywhere (api/_lib/session-guard.js,
api/_lib/account-routes.js): a device in use stays signed in, one left
unused runs out, and "Sign out on all devices" ends every session of the
owner at once. Real handlers against real Postgres (PGlite, see
pg_harness.js) in an isolated Node process."""
from __future__ import annotations

import json
import subprocess
import unittest

from ._paths import ROOT, source

PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"

PRELUDE = r"""
for (const name of ['SESSION_SECRET', 'SYNC_TOKEN', 'CARDLE_SETUP_OPEN']) delete process.env[name];
process.env.DATABASE_URL = 'postgres://unused-in-tests';
const assert = require('assert/strict');
const crypto = require('crypto');
const { createTestDb } = require('./tests/unit/pg_harness');
const db = require('./api/_lib/db');
let auth;
async function database() {
  const testDb = await createTestDb();
  db.getSql = () => testDb.sql;
  auth = require('./api/auth.js');
  return testDb.sql;
}
async function call(handler, { method = 'GET', query = {}, body, cookie = '' } = {}) {
  const res = { code: null, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } };
  const headers = { 'x-forwarded-for': '198.51.100.9' };
  if (cookie) headers.cookie = cookie;
  await handler({ method, headers, query, body }, res);
  const set = String(res.headers['Set-Cookie'] || '');
  res.cookie = set.startsWith('lh_session=') && !set.includes('Max-Age=0') ? set.split(';')[0] : null;
  res.cleared = set.startsWith('lh_session=') && set.includes('Max-Age=0');
  return res;
}
const session = cookie => call(auth, { query: { action: 'session' }, cookie });
async function owner() {
  const res = await call(auth, { method: 'POST', query: { action: 'setup' }, body: { name: 'Olive', email: 'olive@example.test', password: 'correct horse battery' } });
  assert.equal(res.code, 201, JSON.stringify(res.body));
  return res.cookie;
}
// A session cookie as if issued `ageMs` ago, signed with this deployment's secret.
function cookieIssued(ageMs, { ttl = 30 * 24 * 60 * 60, email = 'olive@example.test' } = {}) {
  const { instanceSecret } = require('./api/_lib/instance-secrets');
  const iat = Date.now() - ageMs;
  const body = Buffer.from(JSON.stringify({ authenticated: true, iat, ttl, exp: iat + ttl * 1000, email, name: 'Olive', picture: null })).toString('base64url');
  const signature = crypto.createHmac('sha256', instanceSecret('SESSION_SECRET')).update(body).digest('base64url');
  return `lh_session=${body}.${signature}`;
}
const payloadOf = cookie => JSON.parse(Buffer.from(cookie.split('=')[1].split('.')[0], 'base64url').toString('utf8'));
"""


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class SessionTests(unittest.TestCase):
    def run_node(self, body: str) -> None:
        script = PRELUDE + "(async () => {\n" + body + "\n})().catch(e => { console.error(e); process.exit(1); });"
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_a_session_in_use_is_renewed_once_a_day(self):
        self.run_node(r"""
await database();
await owner();
const fresh = await session(cookieIssued(60 * 1000));
assert.equal(fresh.body.email, 'olive@example.test');
assert.equal(fresh.cookie, null, 'not reissued on every request');
const dayOld = await session(cookieIssued(25 * 60 * 60 * 1000));
assert.equal(dayOld.body.email, 'olive@example.test');
assert.ok(dayOld.cookie, 'a day-old session is reissued');
const renewed = payloadOf(dayOld.cookie);
assert.ok(renewed.exp - Date.now() > 29.9 * 24 * 60 * 60 * 1000, 'for another 30 days');
assert.match(String(dayOld.headers['Set-Cookie']), /Max-Age=2592000/);
""")

    def test_an_unused_session_runs_out(self):
        self.run_node(r"""
await database();
await owner();
const old = await session(cookieIssued(31 * 24 * 60 * 60 * 1000));
assert.equal(old.body.email, null);
""")

    def test_only_full_span_sessions_roll(self):
        self.run_node(r"""
await database();
await owner();
const res = await session(cookieIssued(2 * 24 * 60 * 60 * 1000, { ttl: 7 * 24 * 60 * 60 }));
assert.equal(res.body.email, 'olive@example.test');
assert.equal(res.cookie, null, 'only full-span sessions roll');
""")

    def test_sign_out_everywhere_ends_every_session(self):
        self.run_node(r"""
await database();
const laptop = await owner();
const phone = cookieIssued(5 * 60 * 1000);
assert.equal((await session(phone)).body.email, 'olive@example.test');
const out = await call(auth, { method: 'POST', query: { action: 'sign-out-everywhere' }, cookie: laptop });
assert.equal(out.code, 200, JSON.stringify(out.body));
assert.ok(out.cleared, 'this device is signed out too');
assert.equal((await session(laptop)).body.email, null);
const phoneAfter = await session(phone);
assert.equal(phoneAfter.body.email, null);
assert.ok(phoneAfter.cleared, 'the other device is told to drop its cookie');
// Signing in again afterwards works.
const again = await call(auth, { method: 'POST', query: { action: 'sign-in' }, body: { email: 'olive@example.test', password: 'correct horse battery' } });
assert.equal((await session(again.cookie)).body.email, 'olive@example.test');
""")

    def test_sign_out_everywhere_needs_a_session(self):
        self.run_node(r"""
await database();
await owner();
const res = await call(auth, { method: 'POST', query: { action: 'sign-out-everywhere' } });
assert.equal(res.code, 401);
""")


class SessionWiringTests(unittest.TestCase):
    def test_the_route_and_button_are_wired(self):
        routes = {r["source"]: r["destination"] for r in json.loads(source(ROOT / "vercel.json"))["rewrites"]}
        self.assertEqual(routes["/api/auth/sign-out-everywhere"], "/api/auth?action=sign-out-everywhere")
        self.assertIn("data-signout-all hidden", source(ROOT / "public" / "vault" / "index.html"))
        self.assertIn("bindSignOutEverywhere();", source(ROOT / "public" / "vault" / "assets" / "vault.js"))
        self.assertIn("sessions_revoked_at timestamptz", source(ROOT / "schema-v2.sql"))


if __name__ == "__main__":
    unittest.main()
