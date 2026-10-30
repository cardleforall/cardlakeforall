// The daily retention purge (api/_lib/retention.js), run against real
// Postgres (PGlite, see pg_harness.js). Invoked by test_retention.py as
// `node tests/unit/retention_scenarios.js <name>`.
process.env.SESSION_SECRET = 'retention-scenarios-secret';
process.env.DATABASE_URL = 'postgres://unused-in-tests';
require('./pg_harness').allowAccounts('alice@example.test,bob@example.test');

const assert = require('assert/strict');
// Storage stands in for Vercel Blob: it records what was deleted, and can be
// made to fail.
const storage = { deleted: [], failing: false };
const blobPath = require.resolve('@vercel/blob');
require.cache[blobPath] = { id: blobPath, filename: blobPath, loaded: true, exports: { del: async urls => {
  if (storage.failing) throw new Error('storage unavailable');
  storage.deleted.push(...[].concat(urls));
} } };
const { createTestDb } = require('./pg_harness');
const db = require('../../api/_lib/db');

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-02T03:00:00Z');
const ago = days => new Date(NOW.getTime() - days * DAY).toISOString();

async function setup() {
  const testDb = await createTestDb();
  db.getSql = () => testDb.sql;
  return { ...testDb, retention: require('../../api/_lib/retention') };
}

const count = async (sql, table) => (await sql(`select count(*)::int as n from ${table}`))[0].n;

// One card per table: live, deleted 89 days ago, and deleted 91 days ago.
async function seedCards(sql, email) {
  const inserts = {
    learning_entries: d => sql`insert into learning_entries (user_email, title, status, category, deleted_at) values (${email}, 'L', 'saved', 'ai', ${d}) returning id`,
    kanban_items: d => sql`insert into kanban_items (user_email, title, deleted_at) values (${email}, 'K', ${d}) returning id`,
    work_items: d => sql`insert into work_items (user_email, title, deleted_at) values (${email}, 'W', ${d}) returning id`,
    family_updates: d => sql`insert into family_updates (user_email, person, content, deleted_at) values (${email}, 'F', 'c', ${d}) returning id`,
    bookmarks: d => sql`insert into bookmarks (user_email, title, deleted_at) values (${email}, 'B', ${d}) returning id`,
    talking_points: d => sql`insert into talking_points (user_email, section_title, content, deleted_at) values (${email}, 'T', 'c', ${d}) returning id`,
    reminders: d => sql`insert into reminders (user_email, title, deleted_at) values (${email}, 'R', ${d}) returning id`,
    files: d => sql`insert into files (user_email, name, mime_type, byte_size, blob_url, deleted_at) values (${email}, 'f.txt', 'text/plain', 1, 'https://blob.test/f', ${d}) returning id`,
  };
  const ids = {};
  for (const [table, insert] of Object.entries(inserts)) {
    ids[table] = { live: (await insert(null))[0].id, recent: (await insert(ago(89)))[0].id, expired: (await insert(ago(91)))[0].id };
  }
  return ids;
}

const scenarios = {
  // privacy.html#retention: deleted markers go after 90 days, activity history
  // after 24 months.
  async purge_deletes_only_what_is_past_its_retention_period() {
    const { sql, retention } = await setup();
    const alice = await seedCards(sql, ALICE);
    const bob = await seedCards(sql, BOB);
    const expired = alice.reminders.expired, live = alice.reminders.live;
    await sql`insert into feed_state (user_email, item_type, item_id, liked_at) values (${ALICE}, 'reminder', ${expired}, now()), (${ALICE}, 'reminder', ${live}, now())`;
    await sql`insert into attachments (user_email, parent_type, parent_id, name, mime_type, byte_size, blob_url, deleted_at) values
      (${ALICE}, 'reminder', ${expired}, 'a', 'text/plain', 1, 'https://blob.test/a', ${ago(91)}),
      (${ALICE}, 'reminder', ${live}, 'b', 'text/plain', 1, 'https://blob.test/b', ${ago(10)}),
      (${ALICE}, 'reminder', ${live}, 'c', 'text/plain', 1, 'https://blob.test/c', null)`;
    await sql`insert into user_events (user_email, event_type, created_at) values (${ALICE}, 'old', ${ago(732)}), (${ALICE}, 'kept', ${ago(700)})`;

    const purged = await retention.purgeExpired(sql, NOW);

    for (const ids of [alice, bob]) {
      for (const [table, card] of Object.entries(ids)) {
        const left = (await sql(`select id from ${table} where id = any($1::uuid[])`, [[card.live, card.recent, card.expired]])).map(r => r.id);
        assert.deepEqual(left.sort(), [card.live, card.recent].sort(), `${table}: only the card deleted over 90 days ago goes`);
      }
    }
    assert.equal(purged.reminders, 2);
    assert.equal(await count(sql, 'feed_state'), 1, 'the purged card\'s feed state goes with it');
    assert.equal(await count(sql, 'attachments'), 2);
    assert.deepEqual((await sql`select event_type from user_events`).map(r => r.event_type), ['kept']);
    assert.equal(purged.user_events, 1);
    // Stored objects go before the last reference to them does.
    assert.deepEqual(storage.deleted.sort(), ['https://blob.test/a', 'https://blob.test/f', 'https://blob.test/f']);
    assert.equal(purged.stored_objects_kept_for_retry, 0);

    // A second run the same day has nothing left to do.
    const again = await retention.purgeExpired(sql, NOW);
    assert.ok(Object.values(again).every(n => n === 0), JSON.stringify(again));
  },

  // If storage can't delete an object, its row stays so the next run can try
  // again; dropping the row would leave the object stored forever.
  async failed_storage_deletes_are_retried_not_orphaned() {
    const { sql, retention } = await setup();
    await sql`insert into files (user_email, name, mime_type, byte_size, blob_url, deleted_at) values (${ALICE}, 'f.txt', 'text/plain', 1, 'https://blob.test/old-file', ${ago(91)})`;
    await sql`insert into attachments (user_email, parent_type, parent_id, name, mime_type, byte_size, blob_url, deleted_at) values
      (${ALICE}, 'reminder', gen_random_uuid(), 'a', 'text/plain', 1, 'https://blob.test/old-attachment', ${ago(91)})`;
    storage.failing = true;
    const failed = await retention.purgeExpired(sql, NOW);
    assert.equal(failed.files, 0);
    assert.equal(failed.attachments, 0);
    assert.equal(failed.stored_objects_kept_for_retry, 2);
    assert.equal(await count(sql, 'files'), 1);
    assert.equal(await count(sql, 'attachments'), 1);
    storage.failing = false;
    const retried = await retention.purgeExpired(sql, NOW);
    assert.equal(retried.files, 1);
    assert.equal(retried.attachments, 1);
    assert.equal(retried.stored_objects_kept_for_retry, 0);
    assert.deepEqual(storage.deleted.sort(), ['https://blob.test/old-attachment', 'https://blob.test/old-file']);
    assert.equal(await count(sql, 'files'), 0);
    assert.equal(await count(sql, 'attachments'), 0);
  },

  // Only Vercel's scheduler, holding CRON_SECRET, can start it.
  async the_cron_endpoint_requires_the_cron_secret() {
    const { sql, retention } = await setup();
    await sql`insert into user_events (user_email, event_type, created_at) values (${ALICE}, 'old', '2020-01-01T00:00:00Z')`;
    const call = async (headers, method = 'GET') => {
      const req = { method, headers, query: { resource: 'retention' } };
      const res = { code: null, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; }, end() { return this; } };
      await retention.retentionHandler(req, res);
      return res;
    };
    delete process.env.CRON_SECRET;
    // Without the secret the route purges nothing itself: the request guard
    // runs the purge once a day instead (daily_purge_runs_after_requests...).
    const unset = await call({ authorization: 'Bearer anything' });
    assert.equal(unset.code, 200);
    assert.equal(unset.body.purged, null);
    assert.equal(await count(sql, 'user_events'), 1);
    process.env.CRON_SECRET = 'cron-test-secret';
    assert.equal((await call({})).code, 401);
    assert.equal((await call({ authorization: 'Bearer wrong-secret-same-len' })).code, 401);
    assert.equal((await call({ authorization: 'cron-test-secret' })).code, 401);
    assert.equal(await count(sql, 'user_events'), 1, 'nothing deleted without the secret');
    assert.equal((await call({ authorization: 'Bearer cron-test-secret' }, 'POST')).code, 405);
    const ok = await call({ authorization: 'Bearer cron-test-secret' });
    assert.equal(ok.code, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.purged.user_events, 1);
    assert.equal(await count(sql, 'user_events'), 0);
  },

  // Without CRON_SECRET (a self-hosted Cardlake), the request guard runs the
  // purge after a request it has already answered, at most once a day.
  async daily_purge_runs_after_requests_without_the_cron_secret() {
    delete process.env.CRON_SECRET;
    const { sql, retention } = await setup();
    const auth = require('../../api/auth.js');
    const order = [];
    const realSql = db.getSql();
    db.getSql = () => async (first, ...rest) => {
      const text = Array.isArray(first) ? first.join('?') : String(first);
      if (/app_config.value->>'at'/.test(text)) order.push('purge-check');
      return realSql(first, ...rest);
    };
    const request = async () => {
      const res = { code: null, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { order.push('response'); this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; }, end() { return this; } };
      await auth({ method: 'GET', headers: {}, query: { action: 'session' } }, res);
      return res;
    };
    const until = async check => { for (let i = 0; i < 200 && !(await check()); i += 1) await new Promise(r => setTimeout(r, 10)); };
    const expired = async title => (await sql`insert into bookmarks (user_email, title, deleted_at) values (${ALICE}, ${title}, now() - interval '91 days') returning id`)[0].id;
    const alive = async id => (await sql`select 1 from bookmarks where id = ${id}`).length > 0;

    const first = await expired('first');
    assert.equal((await request()).code, 200);
    await until(async () => !(await alive(first)));
    assert.equal(await alive(first), false, 'the first request of the day purges');
    assert.ok(order.indexOf('response') < order.indexOf('purge-check'), `answered before the purge started: ${order}`);
    const lastRun = (await sql`select value from app_config where key = 'retention_last_run'`)[0].value.at;
    assert.ok(Date.parse(lastRun) > Date.now() - 60000);

    // Later the same day: nothing more, on this instance or another one.
    const second = await expired('second');
    await request();
    await new Promise(r => setTimeout(r, 200));
    assert.equal(await alive(second), true);
    const tomorrow = new Date(Date.now() + 2 * 60 * 60 * 1000);
    assert.equal(await retention.runDailyPurgeIfDue(sql, { now: tomorrow }), null, 'another instance finds today claimed');

    // A day later it runs again, once, however many instances ask.
    const nextDay = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const later = new Date(nextDay.getTime() + 2 * 60 * 60 * 1000);
    const runs = await Promise.all([retention.claimDailyRun(sql, nextDay), retention.claimDailyRun(sql, nextDay)]);
    assert.deepEqual(runs.sort(), [false, true]);
    await sql`update app_config set value = jsonb_build_object('at', (now() - interval '25 hours')::text) where key = 'retention_last_run'`;
    const purged = await retention.runDailyPurgeIfDue(sql, { now: later });
    assert.equal(purged.bookmarks, 1);
    assert.equal(await alive(second), false);
  },

  // A failing purge never fails the request it follows, and Vercel Cron's
  // own run (CRON_SECRET set) means the guard leaves it alone.
  async daily_purge_never_fails_a_request_and_defers_to_the_cron() {
    delete process.env.CRON_SECRET;
    const { sql } = await setup();
    const auth = require('../../api/auth.js');
    const realSql = db.getSql();
    db.getSql = () => async (first, ...rest) => {
      const text = Array.isArray(first) ? first.join('?') : String(first);
      if (/delete from/.test(text)) throw new Error('database unavailable for deletes');
      return realSql(first, ...rest);
    };
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    const res = { code: null, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; }, end() { return this; } };
    await auth({ method: 'GET', headers: {}, query: { action: 'session' } }, res);
    await new Promise(r => setTimeout(r, 300));
    console.error = originalError;
    assert.equal(res.code, 200);
    assert.ok(errors.some(line => line.includes('[retention] daily purge failed')), errors.join('\n'));

    const fresh = await setup();
    db.getSql = () => fresh.sql;
    process.env.CRON_SECRET = 'cron-test-secret';
    await fresh.sql`insert into bookmarks (user_email, title, deleted_at) values (${ALICE}, 'kept for the cron', now() - interval '91 days')`;
    await auth({ method: 'GET', headers: {}, query: { action: 'session' } }, { status() { return this; }, json() { return this; }, setHeader() {}, end() { return this; } });
    await new Promise(r => setTimeout(r, 200));
    assert.equal(await count(fresh.sql, 'bookmarks'), 1, 'with CRON_SECRET the cron does it');
    assert.equal((await fresh.sql`select 1 from app_config where key = 'retention_last_run'`).length, 0);
  },
};

const name = process.argv[2];
if (!scenarios[name]) {
  console.error(`Unknown scenario "${name}". Known: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}
scenarios[name]().then(() => process.exit(0), error => { console.error(error.stack || error); process.exit(1); });
