"""Secrets a deployment generates for itself (api/_lib/instance-secrets.js):
with no environment variables they are generated once, stored, and stable
across requests and cold starts; an environment variable, when set, is used
and nothing is stored. Runs the real request guard against real Postgres
(PGlite, see pg_harness.js) in an isolated Node process."""
from __future__ import annotations

import subprocess
import unittest

from ._paths import ROOT

PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"

# No secret variables at all: each scenario sets the ones it needs before
# requiring the API, so modules see the environment a deployment would.
PRELUDE = r"""
for (const name of ['SESSION_SECRET', 'SYNC_TOKEN', 'OAUTH_SIGNING_SECRET', 'INTEGRATION_ENCRYPTION_KEY', 'INTEGRATION_ENCRYPTION_KEYS_PREVIOUS', 'MCP_TOKEN']) delete process.env[name];
process.env.DATABASE_URL = 'postgres://unused-in-tests';
const assert = require('assert/strict');
const { createTestDb } = require('./tests/unit/pg_harness');
const db = require('./api/_lib/db');
const secrets = require('./api/_lib/instance-secrets');
async function database() {
  const testDb = await createTestDb();
  db.getSql = () => testDb.sql;
  return testDb.sql;
}
function call(handler, { method = 'GET', headers = {}, query = {}, body } = {}) {
  const res = { code: null, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; }, end() { return this; } };
  return Promise.resolve(handler({ method, headers: { 'x-forwarded-for': '198.51.100.7', ...headers }, query, body }, res)).then(() => res);
}
const session = () => call(require('./api/auth.js'), { query: { action: 'session' } });
async function stored(sql) {
  return Object.fromEntries((await sql('select name, value from instance_secrets order by name')).map(row => [row.name, row.value]));
}
"""


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class InstanceSecretTests(unittest.TestCase):
    def run_node(self, body: str) -> None:
        script = PRELUDE + "(async () => {\n" + body + "\n})().catch(e => { console.error(e); process.exit(1); });"
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_without_env_vars_secrets_are_generated_and_stable(self):
        self.run_node(r"""
const sql = await database();
assert.equal((await session()).code, 200);
const first = await stored(sql);
assert.deepEqual(Object.keys(first), ['INTEGRATION_ENCRYPTION_KEY', 'OAUTH_SIGNING_SECRET', 'SESSION_SECRET', 'SYNC_TOKEN']);
for (const name of ['OAUTH_SIGNING_SECRET', 'SESSION_SECRET', 'SYNC_TOKEN']) assert.match(first[name], /^[0-9a-f]{64}$/, name);
assert.equal(Buffer.from(first.INTEGRATION_ENCRYPTION_KEY, 'base64').length, 32);
for (const name of Object.keys(first)) assert.equal(secrets.instanceSecret(name), first[name], name);

await session();
secrets.forgetInstanceSecrets();  // a cold start reads the same values back
await session();
assert.deepEqual(await stored(sql), first);
assert.equal(secrets.instanceSecret('SESSION_SECRET'), first.SESSION_SECRET);
""")

    def test_a_generated_session_secret_signs_working_sessions(self):
        self.run_node(r"""
const sql = await database();
await session();
const { setSessionCookie } = require('./api/_lib/auth');
let cookie = '';
setSessionCookie({ setHeader: (_, value) => { cookie = value.split(';')[0]; } }, { email: 'owner@example.test' });
await sql("insert into app_config (key, value) values ('instance_owner', '{\"email\": \"owner@example.test\"}'::jsonb)");
const res = await call(require('./api/auth.js'), { headers: { cookie }, query: { action: 'session' } });
assert.equal(res.body.email, 'owner@example.test');
""")

    def test_a_generated_sync_token_authenticates_machine_writes(self):
        self.run_node(r"""
await database();
await session();
const { isSyncTokenValid } = require('./api/_lib/auth');
const token = secrets.instanceSecret('SYNC_TOKEN');
assert.equal(isSyncTokenValid({ headers: { 'x-sync-token': token } }), true);
assert.equal(isSyncTokenValid({ headers: { 'x-sync-token': 'f'.repeat(64) } }), false);
""")

    def test_a_generated_encryption_key_seals_and_opens(self):
        self.run_node(r"""
await database();
await session();
const box = require('./api/_lib/secret-box');
const sealed = box.seal('ghp_example');
assert.match(sealed, /^v2:/);
assert.equal(box.open(sealed), 'ghp_example');
""")

    def test_env_vars_win_and_nothing_is_stored(self):
        self.run_node(r"""
process.env.SESSION_SECRET = 'from-the-environment';
process.env.SYNC_TOKEN = 'sync-from-the-environment';
process.env.OAUTH_SIGNING_SECRET = 'oauth-from-the-environment';
process.env.INTEGRATION_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
const sql = await database();
await session();
assert.deepEqual(await stored(sql), {});
assert.equal(secrets.instanceSecret('SESSION_SECRET'), 'from-the-environment');
assert.equal(secrets.secretSource('SYNC_TOKEN'), 'environment');
""")

    def test_a_set_session_secret_keeps_the_old_fallbacks(self):
        # OAuth signing and integration encryption have always fallen back to
        # SESSION_SECRET; a deployment that sets it keeps exactly that.
        self.run_node(r"""
process.env.SESSION_SECRET = 'from-the-environment';
const sql = await database();
await session();
assert.deepEqual(Object.keys(await stored(sql)), ['SYNC_TOKEN']);
assert.equal(secrets.instanceSecret('OAUTH_SIGNING_SECRET'), null);
const box = require('./api/_lib/secret-box');
assert.match(box.seal('ghp_example'), /^v1:/, 'still sealed with the SESSION_SECRET-derived key');
""")

    def test_racing_cold_starts_agree_on_one_value(self):
        self.run_node(r"""
const sql = await database();
// Another instance stored its values first; this one must adopt them.
await sql("insert into instance_secrets (name, value) values ('SYNC_TOKEN', $1)", ['a'.repeat(64)]);
await session();
assert.equal(secrets.instanceSecret('SYNC_TOKEN'), 'a'.repeat(64));
""")



if __name__ == "__main__":
    unittest.main()
