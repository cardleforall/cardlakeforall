process.env.SESSION_SECRET = 'migrate-test-secret';
process.env.DATABASE_URL = 'postgres://unused';
process.env.SYNC_TOKEN = 'test-sync';
require('./pg_harness').allowAccounts('alice@example.test');
const assert = require('assert/strict');
const { createTestDb } = require('./pg_harness');
const db = require('../../api/_lib/db');
const { setSessionCookie } = require('../../api/_lib/auth');
const ALICE = 'alice@example.test', ADMIN = 'owner@example.test';
function cookie(email) { let value; setSessionCookie({ setHeader(_, v) { value = v; } }, { email }); return value.split(';')[0]; }
async function call(handler, req) {
  const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, end(body) { this.body = body; return this; }, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; } };
  await handler(req, res); return res;
}
// An empty database, so whether the schema was applied is visible. pg_harness
// may already have loaded api/migrate.js with the real getSql bound, so it
// is loaded again once the test database is in place.
async function setup() {
  const test = await createTestDb({ schema: false }); db.getSql = () => test.sql;
  delete require.cache[require.resolve('../../api/migrate')];
  return { ...test, migrate: require('../../api/migrate') };
}
const migrateRequest = (headers, query = {}) => ({ method: 'POST', url: '/api/migrate', query, headers });
const hasTable = async (sql, name) => (await sql`select to_regclass(${`public.${name}`}) is not null as present`)[0].present;
const scenarios = {
  // Sign-up is open, so any session -- even an administrator's -- is refused.
  async sessions_cannot_migrate() {
    // The request guard applies the schema on its own (_lib/schema.js); what
    // only the sync token may do is run this route.
    const { migrate } = await setup();
    for (const email of [ALICE, ADMIN]) {
      const res = await call(migrate, migrateRequest({ cookie: cookie(email) }));
      assert.equal(res.statusCode, 401, email);
    }
    assert.equal((await call(migrate, migrateRequest({}))).statusCode, 401, 'anonymous');
    assert.equal((await call(migrate, migrateRequest({ 'x-sync-token': 'wrong-token' }))).statusCode, 401, 'wrong token');
  },
  // The sync token applies the schema, and ?seed=1 no longer writes anything.
  async sync_token_applies_schema_only() {
    const { sql, migrate } = await setup();
    const res = await call(migrate, migrateRequest({ 'x-sync-token': 'test-sync' }, { seed: '1' }));
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(await hasTable(sql, 'learning_entries'), true);
    for (const table of ['kanban_items', 'work_items', 'family_updates', 'bookmarks', 'talking_points']) {
      assert.equal((await sql(`select count(*)::int as n from ${table}`))[0].n, 0, table);
    }
    assert.equal((await call(migrate, migrateRequest({ 'x-sync-token': 'test-sync' }))).statusCode, 200, 'safe to re-run');
  },
};
scenarios[process.argv[2]]().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
