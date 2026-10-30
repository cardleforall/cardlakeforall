"""A fresh deployment sets up its own database (api/_lib/schema.js): the first
request applies schema-v2.sql, later requests don't, and requests racing on a
cold start apply it once. Runs the real request guard against real Postgres
(PGlite, see pg_harness.js) in an isolated Node process."""
from __future__ import annotations

import subprocess
import unittest

from ._paths import ROOT, source

PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"

# A database with nothing in it, and a client that counts how many times the
# schema's first table is created -- one count per application of the file.
PRELUDE = r"""
process.env.SESSION_SECRET = 'schema-test-secret';
process.env.DATABASE_URL = 'postgres://unused-in-tests';
const assert = require('assert/strict');
const { createTestDb } = require('./tests/unit/pg_harness');
const db = require('./api/_lib/db');
const schema = require('./api/_lib/schema');
const handler = require('./api/auth.js');
let applications = 0;
async function emptyDatabase() {
  const testDb = await createTestDb({ schema: false });
  const counting = async (first, ...rest) => {
    if (typeof first === 'string' && /create table if not exists learning_entries/i.test(first)) applications += 1;
    return testDb.sql(first, ...rest);
  };
  db.getSql = () => counting;
  return testDb.sql;
}
async function request() {
  const res = { code: null, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  await handler({ method: 'GET', headers: {}, query: { action: 'session' } }, res);
  return res;
}
"""


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class SchemaAutoApplyTests(unittest.TestCase):
    def run_node(self, body: str) -> None:
        script = PRELUDE + "(async () => {\n" + body + "\n})().catch(e => { console.error(e); process.exit(1); });"
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_a_fresh_database_gets_its_schema_on_the_first_request(self):
        self.run_node(r"""
const sql = await emptyDatabase();
const res = await request();
assert.equal(res.code, 200);
assert.equal(applications, 1);
const tables = await sql("select table_name from information_schema.tables where table_name in ('users', 'learning_entries', 'app_config')");
assert.equal(tables.length, 3);
const stored = await sql("select value from app_config where key = 'schema_hash'");
assert.equal(stored[0].value.hash, schema.readSchema().hash);
""")

    def test_a_second_request_does_not_reapply_it(self):
        self.run_node(r"""
await emptyDatabase();
await request();
await request();
assert.equal(applications, 1, 'a warm instance skips the check');
schema.resetSchemaCache();  // a cold start: the stored hash matches
await request();
assert.equal(applications, 1, 'a cold start finds the stored hash current');
""")

    def test_concurrent_first_requests_apply_it_once(self):
        self.run_node(r"""
await emptyDatabase();
const responses = await Promise.all([request(), request(), request(), request()]);
assert.deepEqual(responses.map(res => res.code), [200, 200, 200, 200]);
assert.equal(applications, 1);
""")

    def test_a_changed_schema_file_is_applied_again(self):
        self.run_node(r"""
const sql = await emptyDatabase();
await request();
await sql("update app_config set value = '{\"hash\": \"an-older-schema\"}'::jsonb where key = 'schema_hash'");
schema.resetSchemaCache();
await request();
assert.equal(applications, 2);
""")

    def test_it_never_seeds_sample_data(self):
        self.run_node(r"""
const sql = await emptyDatabase();
await request();
for (const table of ['kanban_items', 'work_items', 'family_updates', 'bookmarks', 'talking_points', 'reminders']) {
  const rows = await sql(`select count(*)::int as n from ${table}`);
  assert.equal(rows[0].n, 0, table);
}
""")


class SchemaAutoApplyWiringTests(unittest.TestCase):
    def test_every_function_checks_the_schema_through_the_guard(self):
        guard = source(ROOT / "api" / "_lib" / "session-guard.js")
        self.assertIn("ensureSchema()", guard)

    def test_migrate_and_auto_apply_share_one_statement_splitter(self):
        self.assertNotIn("function splitStatements", source(ROOT / "api" / "migrate.js"))
        self.assertIn("function splitStatements", source(ROOT / "api" / "_lib" / "schema.js"))


if __name__ == "__main__":
    unittest.main()
