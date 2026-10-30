"""Login-CSRF protection (api/_lib/http.js allowSameOrigin): every POST that
signs a browser in or out -- first-run setup, password sign-in, sign-out on
all devices and the MCP consent page -- is refused when the browser says it
came from another site. And /api/migrate answers only
the sync token, never a session. Real handlers against real Postgres
(PGlite, see pg_harness.js) in an isolated Node process."""
from __future__ import annotations

import subprocess
import unittest

from ._paths import ROOT

PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"

PRELUDE = r"""
for (const name of ['SESSION_SECRET', 'CARDLE_SETUP_OPEN']) delete process.env[name];
process.env.DATABASE_URL = 'postgres://unused-in-tests';
process.env.SYNC_TOKEN = 'origin-test-sync-token';
const assert = require('assert/strict');
const { createTestDb } = require('./tests/unit/pg_harness');
const db = require('./api/_lib/db');
async function database() {
  const testDb = await createTestDb();
  db.getSql = () => testDb.sql;
}
async function call(handler, { method = 'POST', query = {}, headers = {}, body } = {}) {
  const res = { statusCode: 200, body: null, headers: {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; } };
  await handler({ method, query, headers: { 'x-forwarded-for': '198.51.100.7', ...headers }, body }, res);
  const set = String(res.headers['Set-Cookie'] || '');
  res.cookie = set.startsWith('lh_session=') && !set.includes('Max-Age=0') ? set.split(';')[0] : null;
  return res;
}
const foreign = { origin: 'https://evil.example', host: 'cardlake.example' };
const ours = { origin: 'https://cardlake.example', host: 'cardlake.example' };
const OWNER = { name: 'Olive', email: 'olive@example.test', password: 'correct horse battery' };
"""


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class SignInOriginTests(unittest.TestCase):
    def run_node(self, body: str) -> None:
        script = PRELUDE + "(async () => {\n" + body + "\n})().then(() => process.exit(0), e => { console.error(e); process.exit(1); });"
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_same_origin_is_judged_by_the_request_host(self):
        self.run_node(r"""
const { isSameOriginRequest } = require('./api/_lib/http');
const same = (origin, host, extra = {}) => isSameOriginRequest({ headers: { ...(origin === undefined ? {} : { origin }), host, ...extra } });
// Any address the deployment answers on works without a list.
for (const [origin, host] of [
  ['https://cardlake.example', 'cardlake.example'], ['https://my-cardlake.vercel.app', 'my-cardlake.vercel.app'],
  ['https://my-cardlake-git-x-team.vercel.app', 'my-cardlake-git-x-team.vercel.app'],
  ['http://localhost:3000', 'localhost:3000'], ['https://Cardlake.Example', 'cardlake.example'],
]) assert.equal(same(origin, host), true, origin);
assert.equal(same('https://cardlake.example', 'internal', { 'x-forwarded-host': 'cardlake.example' }), true, 'the forwarded host is the public one');
// No Origin: not a browser page, so it can't carry a visitor's browser.
assert.equal(same(undefined, 'cardlake.example'), true);
assert.equal(same('', 'cardlake.example'), true);
// Another site, a look-alike, another port or an opaque origin is refused.
for (const [origin, host] of [['https://evil.example', 'cardlake.example'], ['https://cardlake.example.evil.example', 'cardlake.example'],
  ['http://localhost:4000', 'localhost:3000'], ['null', 'cardlake.example'], ['not a url', 'cardlake.example']])
  assert.equal(same(origin, host), false, origin);
""")

    def test_cross_site_sign_in_posts_are_refused(self):
        self.run_node(r"""
await database();
const auth = require('./api/auth.js');
const refuse = async (handler, query, body, extra = {}) => {
  const res = await call(handler, { query, headers: { ...foreign, ...extra }, body });
  assert.equal(res.statusCode, 403, JSON.stringify([query, res.body]));
  assert.equal(res.body.code, 'CROSS_ORIGIN_REQUEST');
  assert.equal(res.cookie, null, 'no session is set');
};
// Setup from another site doesn't claim the Cardlake or sign anyone in.
await refuse(auth, { action: 'setup' }, OWNER);
const status = await call(auth, { method: 'GET', query: { action: 'setup' }, headers: ours });
assert.equal(status.body.needed, true, 'still unclaimed');
// From the site itself it works as before.
const setup = await call(auth, { query: { action: 'setup' }, headers: ours, body: OWNER });
assert.equal(setup.statusCode, 201, JSON.stringify(setup.body));
// Password sign-in and sign-out everywhere.
await refuse(auth, { action: 'sign-in' }, { email: OWNER.email, password: OWNER.password });
const signIn = await call(auth, { query: { action: 'sign-in' }, headers: ours, body: { email: OWNER.email, password: OWNER.password } });
assert.equal(signIn.statusCode, 200, JSON.stringify(signIn.body));
// The local-dev copies of the routes refuse the same way.
await refuse(require('./api/auth/sign-in.js'), {}, { email: OWNER.email, password: OWNER.password });
await refuse(require('./api/auth/setup.js'), {}, OWNER);
await refuse(require('./api/auth/sign-out-everywhere.js'), {}, {}, { cookie: signIn.cookie });
await refuse(auth, { action: 'sign-out-everywhere' }, {}, { cookie: signIn.cookie });
const session = await call(auth, { method: 'GET', query: { action: 'session' }, headers: { cookie: signIn.cookie } });
assert.equal(session.body.email, OWNER.email, 'the refused request ended nothing');
""")

    def test_the_consent_page_refuses_other_sites_but_the_token_endpoint_does_not(self):
        self.run_node(r"""
await database();
const oauth = require('./api/oauth.js');
for (const body of [{ session: true }, { email: OWNER.email, password: OWNER.password }]) {
  const refused = await call(oauth, { query: { action: 'authorize' }, headers: foreign, body });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.body.code, 'CROSS_ORIGIN_REQUEST');
}
const expired = await call(oauth, { query: { action: 'authorize' }, headers: ours, body: { session: true } });
assert.equal(expired.statusCode, 400, 'from our page it reaches the usual transaction check');
// The token endpoint is called from the AI platforms' own origins.
const token = await call(oauth, { query: { action: 'token' }, headers: { origin: 'https://claude.ai', host: 'cardlake.example' }, body: { grant_type: 'nope' } });
assert.equal(token.statusCode, 400);
assert.equal(token.body.error, 'unsupported_grant_type');
""")

    def test_migrate_answers_only_the_sync_token(self):
        self.run_node(r"""
await database();
const auth = require('./api/auth.js');
const migrate = require('./api/migrate.js');
const owner = await call(auth, { query: { action: 'setup' }, headers: ours, body: OWNER });
assert.ok(owner.cookie);
const withSession = await call(migrate, { headers: { cookie: owner.cookie } });
assert.equal(withSession.statusCode, 401, 'a session, even the owner\'s, is refused');
assert.equal((await call(migrate)).statusCode, 401);
assert.equal((await call(migrate, { headers: { 'x-sync-token': 'wrong' } })).statusCode, 401);
const ok = await call(migrate, { headers: { 'x-sync-token': process.env.SYNC_TOKEN } });
assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
""")


if __name__ == "__main__":
    unittest.main()
