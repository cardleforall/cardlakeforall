// Behavioral checks for the Aurora streak and daily review counter, run
// against real Postgres (PGlite, see pg_harness.js). Invoked by
// test_feed_streak.py as `node tests/unit/streak_scenarios.js <name>`, with the
// process deliberately in a timezone that is neither UTC nor the viewer's, so
// a result can only be right if the code ignores the server clock's zone.
process.env.SESSION_SECRET = 'streak-scenarios-secret';
process.env.DATABASE_URL = 'postgres://unused-in-tests';
require('./pg_harness').allowAccounts('alice@example.test');

const assert = require('assert/strict');
const { createTestDb } = require('./pg_harness');
const db = require('../../api/_lib/db');
const { setSessionCookie } = require('../../api/_lib/auth');

const ALICE = 'alice@example.test';

// feed.js destructures getSql at require time, so point it at the test
// database before loading it.
async function setup() {
  const testDb = await createTestDb();
  db.getSql = () => testDb.sql;
  return { ...testDb, feed: require('../../api/feed') };
}

function sessionCookie(email) {
  let header = '';
  setSessionCookie({ setHeader: (_, value) => { header = value; } }, { email });
  return header.split(';')[0];
}

async function getFeed(handler, { email, query = {} } = {}) {
  const req = { method: 'GET', headers: email ? { cookie: sessionCookie(email) } : {}, query };
  const res = { code: null, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  await handler(req, res);
  assert.equal(res.code, 200, JSON.stringify(res.body));
  return res.body;
}

async function seedDays(sql, email, dates) {
  for (const date of dates) await sql`insert into vault_daily_activity (user_email, activity_date) values (${email}, ${date}::date)`;
}

const days = async (sql, email) => (await sql`select activity_date::text as d from vault_daily_activity where user_email = ${email} order by d`).map(r => r.d);

const scenarios = {
  // 02:00 in India is still the previous day in UTC. The streak must follow
  // the viewer's calendar: Neon's current_date and the server clock would both
  // have said "yesterday" and broken it.
  async streak_and_review_date_follow_the_viewers_timezone() {
    const { sql, feed } = await setup();
    await seedDays(sql, ALICE, ['2026-09-24', '2026-09-25']);
    const now = new Date('2026-09-25T20:30:00Z'); // 02:00 on the 26th in Kolkata

    const res = await feed.buildFeedResponse(sql, ALICE, { tz: 'Asia/Kolkata' }, { recordVisit: true, now });
    assert.equal(res.stats.review.date, '2026-09-26');
    assert.equal(res.stats.streak_days, 3);
    assert.deepEqual(await days(sql, ALICE), ['2026-09-24', '2026-09-25', '2026-09-26']);

    // A refresh the same day adds nothing and counts the same.
    const again = await feed.buildFeedResponse(sql, ALICE, { tz: 'Asia/Kolkata' }, { recordVisit: true, now });
    assert.equal(again.stats.streak_days, 3);
    assert.equal((await days(sql, ALICE)).length, 3);
  },

  async missing_or_unknown_timezone_falls_back_to_utc() {
    const { sql, feed } = await setup();
    const now = new Date('2026-09-25T20:30:00Z');
    for (const tz of [undefined, '', 'Not/AZone', 'x'.repeat(200)]) {
      const res = await feed.buildFeedResponse(sql, ALICE, tz === undefined ? {} : { tz }, { recordVisit: true, now });
      assert.equal(res.stats.review.date, '2026-09-25', `tz=${tz}`);
    }
    assert.deepEqual(await days(sql, ALICE), ['2026-09-25']);
  },

  // Today has no visit yet (e.g. an MCP client listing cards before the vault
  // is opened), so the streak ending yesterday is still alive. A missed day
  // breaks it.
  async streak_is_alive_until_the_day_ends_and_breaks_after_a_gap() {
    const { computeStreak } = require('../../api/feed');
    assert.equal(computeStreak([], '2026-09-26'), 0);
    assert.equal(computeStreak(['2026-09-26'], '2026-09-26'), 1);
    assert.equal(computeStreak(['2026-09-25', '2026-09-24'], '2026-09-26'), 2);
    assert.equal(computeStreak(['2026-09-24'], '2026-09-26'), 0);
    assert.equal(computeStreak(['2026-09-26', '2026-09-24', '2026-09-23'], '2026-09-26'), 1);
    // A day recorded "ahead" in another zone (travelling west) is not counted
    // as today and does not break the run behind it.
    assert.equal(computeStreak(['2026-09-27', '2026-09-26', '2026-09-25'], '2026-09-26'), 2);
    // Month, leap-day and US DST boundaries are single calendar days.
    assert.equal(computeStreak(['2026-03-01', '2026-02-28'], '2026-03-01'), 2);
    assert.equal(computeStreak(['2028-03-01', '2028-02-29', '2028-02-28'], '2028-03-01'), 3);
    assert.equal(computeStreak(['2026-03-09', '2026-03-08', '2026-03-07'], '2026-03-09'), 3);
    assert.equal(computeStreak(['2026-11-02', '2026-11-01', '2026-10-31'], '2026-11-02'), 3);
  },

  async reviewed_today_counts_in_the_viewers_timezone() {
    const { sql, feed } = await setup();
    // 01:30 on the 26th in Kolkata, still the 25th in UTC.
    await sql`insert into feed_state (user_email, item_type, item_id, reviewed_at) values (${ALICE}, 'reminder', gen_random_uuid(), '2026-09-25T20:00:00Z')`;
    const now = new Date('2026-09-26T06:00:00Z');
    const local = await feed.buildFeedResponse(sql, ALICE, { tz: 'Asia/Kolkata' }, { now });
    assert.equal(local.stats.review.reviewed_today, 1);
    const utc = await feed.buildFeedResponse(sql, ALICE, {}, { now });
    assert.equal(utc.stats.review.reviewed_today, 0);
  },

  // Only a signed-in person opening their own vault earns a streak day. The
  // shared vault's anonymous visitors and MCP listings must not.
  async only_signed_in_page_opens_record_a_streak_day() {
    const { sql, feed } = await setup();
    const anonymous = await getFeed(feed, { query: { tz: 'Asia/Kolkata' } });
    assert.equal(anonymous.stats.streak_days, 0);
    assert.deepEqual(await days(sql, 'default'), []);

    await feed.buildFeedResponse(sql, ALICE, { tz: 'Asia/Kolkata' });
    assert.deepEqual(await days(sql, ALICE), [], 'buildFeedResponse records nothing unless asked');

    const before = feed.localDate(new Date(), 'Asia/Kolkata');
    const signedIn = await getFeed(feed, { email: ALICE, query: { tz: 'Asia/Kolkata' } });
    const after = feed.localDate(new Date(), 'Asia/Kolkata');
    assert.equal(signedIn.stats.streak_days, 1);
    const recorded = await days(sql, ALICE);
    assert.equal(recorded.length, 1);
    assert.ok([before, after].includes(recorded[0]), `recorded ${recorded[0]}, expected the Kolkata date`);
  },
};

require('./scenario_runner').runScenario(scenarios);
