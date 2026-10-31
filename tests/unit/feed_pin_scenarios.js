// Pins and snoozes, run against real Postgres (PGlite, see pg_harness.js).
// Invoked by test_feed_pins.py as `node tests/unit/feed_pin_scenarios.js <name>`.
process.env.SESSION_SECRET = 'feed-pin-scenarios-secret';
process.env.DATABASE_URL = 'postgres://unused-in-tests';
require('./pg_harness').allowAccounts('alice@example.test');

const assert = require('assert/strict');
const { createTestDb } = require('./pg_harness');
const db = require('../../api/_lib/db');

const ALICE = 'alice@example.test';

// feed.js destructures getSql at require time, so point it at the test
// database before loading it.
async function setup() {
  const testDb = await createTestDb();
  db.getSql = () => testDb.sql;
  return { ...testDb, feed: require('../../api/feed') };
}

async function reminders(sql, titles) {
  const ids = [];
  for (const title of titles) ids.push((await sql`insert into reminders (user_email, title) values (${ALICE}, ${title}) returning id`)[0].id);
  return ids;
}

const pinnedAt = async (sql, id) => (await sql`select pinned_at from feed_state where user_email = ${ALICE} and item_id = ${id}`)[0]?.pinned_at ?? null;

const scenarios = {
  // Both sorts keep pinned cards first; the response names the sort it used,
  // and anything unrecognised gets the AI order.
  async pins_stay_first_under_either_sort() {
    const { sql, feed } = await setup();
    const [old, pinned, newest] = await reminders(sql, ['Old', 'Pinned', 'Newest']);
    await sql`update reminders set created_at = now() - interval '9 days' where id = ${old}`;
    await sql`update reminders set created_at = now() - interval '5 days' where id = ${pinned}`;
    await sql`insert into learning_entries (user_email, title, status, category, created_at) values (${ALICE}, 'Middle', 'saved', 'ai', now() - interval '2 days')`;
    await feed.applyFeedAction(sql, ALICE, 'pin', 'reminder', pinned);

    const byDate = await feed.buildFeedResponse(sql, ALICE, { sort: 'newest' });
    assert.equal(byDate.sort, 'newest');
    assert.deepEqual(byDate.cards.map(c => c.title), ['Pinned', 'Newest', 'Middle', 'Old']);

    for (const sort of ['ai', undefined, 'bogus']) {
      const res = await feed.buildFeedResponse(sql, ALICE, { sort });
      assert.equal(res.sort, 'ai');
      assert.equal(res.cards[0].title, 'Pinned');
      assert.deepEqual(res.cards.map(c => c.title).sort(), ['Middle', 'Newest', 'Old', 'Pinned']);
    }
  },

  // Pinning already clears a snooze; snoozing clears a pin, so a snoozed card
  // never holds one of the three slots out of sight.
  async snoozing_a_pinned_card_frees_its_pin_slot() {
    const { sql, feed } = await setup();
    const [one, two, three, four] = await reminders(sql, ['One', 'Two', 'Three', 'Four']);
    for (const id of [one, two, three]) await feed.applyFeedAction(sql, ALICE, 'pin', 'reminder', id);
    await assert.rejects(feed.applyFeedAction(sql, ALICE, 'pin', 'reminder', four), /only pin up to 3/);

    await feed.applyFeedAction(sql, ALICE, 'remind_later', 'reminder', three);
    assert.equal(await pinnedAt(sql, three), null);
    const res = await feed.buildFeedResponse(sql, ALICE, {});
    assert.equal(res.stats.pinned_cards, 2);
    assert.equal(res.stats.snoozed_count, 1);

    await feed.applyFeedAction(sql, ALICE, 'pin', 'reminder', four);
    assert.notEqual(await pinnedAt(sql, four), null);
    // Bringing it back doesn't re-pin it over the limit.
    await feed.applyFeedAction(sql, ALICE, 'unremind_later', 'reminder', three);
    assert.equal((await feed.buildFeedResponse(sql, ALICE, {})).stats.pinned_cards, 3);
  },

  // Cards snoozed while pinned before this change are still pinned in the
  // database; they mustn't count against the cap the feed shows.
  async a_snoozed_card_still_marked_pinned_does_not_use_a_slot() {
    const { sql, feed } = await setup();
    const [one, two, three, four] = await reminders(sql, ['One', 'Two', 'Three', 'Four']);
    for (const id of [one, two, three]) await feed.applyFeedAction(sql, ALICE, 'pin', 'reminder', id);
    await sql`update feed_state set remind_later_until = now() + interval '1 day' where user_email = ${ALICE} and item_id = ${three}`;
    assert.equal((await feed.buildFeedResponse(sql, ALICE, {})).stats.pinned_cards, 2);

    await feed.applyFeedAction(sql, ALICE, 'pin', 'reminder', four);
    assert.notEqual(await pinnedAt(sql, four), null);
  },
};

require('./scenario_runner').runScenario(scenarios);
