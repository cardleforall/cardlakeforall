"""Every deployed function works on a fresh deployment's cold instance with
no secret variables set: the database is empty, nothing is loaded yet, and
the function has to apply the schema and load (or generate) the secrets
itself. Most other tests set SESSION_SECRET, which hides exactly this:
api/mcp.js once crashed on every call because, unlike the guarded
functions, it never loaded the generated OAuth signing secret.

Runs the real handlers against real Postgres (PGlite, see pg_harness.js)
in an isolated Node process."""
from __future__ import annotations

import fnmatch
import json
import subprocess
import unittest

from ._paths import API, ROOT, source

PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"

# One harmless request per deployed function, and the answer it should
# get from a signed-out caller. A new function needs an entry here.
REQUESTS = {
    "api/auth.js": ({"method": "GET", "query": {"action": "session"}}, 200),
    "api/feed.js": ({"method": "GET", "query": {}}, 200),
    "api/learnings.js": ({"method": "GET", "query": {}}, 200),
    "api/learnings/[id].js": ({"method": "PATCH", "query": {"id": "00000000-0000-4000-8000-000000000000"}, "body": {}}, 401),
    "api/learnings/reorder.js": ({"method": "POST", "query": {}, "body": {}}, 401),
    "api/mcp.js": ({"method": "POST", "query": {}, "body": {}, "headers": {"authorization": "Bearer not.a.token"}}, 401),
    "api/migrate.js": ({"method": "POST", "query": {}}, 401),
    "api/oauth.js": ({"method": "POST", "query": {"action": "token"}, "body": {"grant_type": "nope"}}, 400),
    "api/sync/markdown.js": ({"method": "GET", "query": {}}, 401),
    "api/vault.js": ({"method": "GET", "query": {"resource": "reminders"}}, 200),
}


def deployed_functions() -> list[str]:
    ignored = [line.strip() for line in source(ROOT / ".vercelignore").splitlines()
               if line.strip() and not line.startswith("#")]
    found = []
    for path in sorted(API.rglob("*.js")):
        rel = path.relative_to(ROOT).as_posix()
        if "/_lib/" in rel or any(fnmatch.fnmatch(rel, pattern) for pattern in ignored):
            continue
        found.append(rel)
    return found


SCRIPT = r"""
for (const name of ['SESSION_SECRET', 'SYNC_TOKEN', 'OAUTH_SIGNING_SECRET', 'INTEGRATION_ENCRYPTION_KEY', 'INTEGRATION_ENCRYPTION_KEYS_PREVIOUS', 'MCP_TOKEN', 'CRON_SECRET']) delete process.env[name];
process.env.DATABASE_URL = 'postgres://unused-in-tests';
const assert = require('assert/strict');
const { createTestDb } = require('./tests/unit/pg_harness');
const db = require('./api/_lib/db');
const schema = require('./api/_lib/schema');
const secrets = require('./api/_lib/instance-secrets');
const requests = JSON.parse(process.argv[1]);
(async () => {
  // A brand-new database: not even the schema yet.
  const testDb = await createTestDb({ schema: false });
  db.getSql = () => testDb.sql;
  const seen = [];
  for (const [file, [request, expected]] of Object.entries(requests)) {
    // Every call is a cold instance: nothing applied or loaded in memory.
    schema.resetSchemaCache();
    secrets.forgetInstanceSecrets();
    const handler = require(`./${file}`);
    const res = { code: null, body: null, headers: {},
      status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; },
      send(b) { this.body = b; return this; }, end() { return this; },
      setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; } };
    const req = { headers: { 'x-forwarded-for': '198.51.100.20', ...(request.headers || {}) }, url: `/${file}`, on() {}, ...request };
    try {
      await handler(req, res);
    } catch (error) {
      throw new Error(`${file} threw on a cold instance: ${error.message}`);
    }
    assert.equal(res.code, expected, `${file}: ${JSON.stringify(res.body)}`);
    seen.push(file);
  }
  // The secrets were generated once and every function used the same ones.
  const stored = await testDb.sql('select name from instance_secrets order by name');
  assert.deepEqual(stored.map(row => row.name), ['INTEGRATION_ENCRYPTION_KEY', 'OAUTH_SIGNING_SECRET', 'SESSION_SECRET', 'SYNC_TOKEN']);
  console.log(JSON.stringify(seen));
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
"""


class ColdStartTests(unittest.TestCase):
    def test_every_deployed_function_has_a_cold_start_request(self):
        self.assertEqual(sorted(REQUESTS), sorted(deployed_functions()),
                         "add a request for each new deployed function to REQUESTS")

    @unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
    def test_every_deployed_function_works_with_no_secrets_set(self):
        result = subprocess.run(["node", "-e", SCRIPT, json.dumps(REQUESTS)], cwd=ROOT,
                                capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        self.assertEqual(sorted(json.loads(result.stdout.strip().splitlines()[-1])), sorted(REQUESTS))


if __name__ == "__main__":
    unittest.main()
