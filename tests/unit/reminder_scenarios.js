// Recurring reminders, driven through the real /api/reminders handlers and the
// feed against real Postgres (PGlite, see pg_harness.js). Invoked by
// test_recurring_reminders.py as `node tests/unit/reminder_scenarios.js <name>`.
process.env.SESSION_SECRET = 'reminder-scenarios-secret';
process.env.DATABASE_URL = 'postgres://unused-in-tests';
require('./pg_harness').allowAccounts('alice@example.test,bob@example.test');

const assert = require('assert/strict');
const { createTestDb } = require('./pg_harness');
const db = require('../../api/_lib/db');
const { setSessionCookie } = require('../../api/_lib/auth');

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const DAY = 24 * 3600e3;

// feed.js and resources.js destructure getSql at require time, so point it at
// the test database before loading them.
async function setup({ preMigration = false } = {}) {
  const testDb = await createTestDb();
  // A production database the deploy has reached but the migration hasn't.
  if (preMigration) await testDb.sql`alter table reminders drop column if exists recurrence`;
  db.getSql = () => testDb.sql;
  return {
    ...testDb,
    collection: require('../../api/reminders/index'),
    item: require('../../api/reminders/[id]'),
    feed: require('../../api/feed'),
  };
}

function sessionCookie(email) {
  let header = '';
  setSessionCookie({ setHeader: (_, value) => { header = value; } }, { email });
  return header.split(';')[0];
}

async function call(handler, { method, email = ALICE, body, id } = {}) {
  const req = { method, headers: { cookie: sessionCookie(email) }, query: id ? { id } : {}, body };
  const res = { code: null, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  await handler(req, res);
  return res;
}

async function create(ctx, body, email = ALICE) {
  const res = await call(ctx.collection, { method: 'POST', email, body });
  assert.equal(res.code, 201, JSON.stringify(res.body));
  return res.body.reminder;
}

async function patch(ctx, id, body, email = ALICE) {
  return call(ctx.item, { method: 'PATCH', email, id, body });
}

async function complete(ctx, id) {
  const res = await patch(ctx, id, { completed: true });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  return res.body.reminder;
}

const iso = value => new Date(value).toISOString();

const scenarios = {
  // Rolling forward snoozes the card until its next occurrence, and a snoozed
  // card doesn't hold a pin slot (see feed_pin_scenarios.js).
  async completing_a_pinned_recurring_reminder_unpins_it() {
    const ctx = await setup();
    const daily = await create(ctx, { title: 'Stretch', recurrence: 'daily', due_date: new Date(Date.now() + 3600e3).toISOString() });
    await ctx.feed.applyFeedAction(ctx.sql, ALICE, 'pin', 'reminder', daily.id);
    await complete(ctx, daily.id);
    const [state] = await ctx.sql`select pinned_at, remind_later_until from feed_state where user_email = ${ALICE} and item_id = ${daily.id}`;
    assert.ok(state.remind_later_until, 'rolled forward and snoozed');
    assert.equal(state.pinned_at, null);
  },

  async recurrence_is_stored_on_create_and_defaults_to_null() {
    const ctx = await setup();
    const weekly = await create(ctx, { title: 'Water the plants', recurrence: 'weekly' });
    assert.equal(weekly.recurrence, 'weekly');
    const once = await create(ctx, { title: 'Call the dentist' });
    assert.equal(once.recurrence, null);
    const listed = (await call(ctx.collection, { method: 'GET' })).body.reminders;
    assert.equal(listed.find(r => r.id === weekly.id).recurrence, 'weekly');
  },

  async unknown_recurrence_is_rejected_and_none_clears_it() {
    const ctx = await setup();
    const bad = await call(ctx.collection, { method: 'POST', body: { title: 'Hourly', recurrence: 'hourly' } });
    assert.equal(bad.code, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.code, 'VALIDATION_ERROR');

    const reminder = await create(ctx, { title: 'Pay rent', recurrence: 'monthly' });
    const badPatch = await patch(ctx, reminder.id, { recurrence: 'fortnightly' });
    assert.equal(badPatch.code, 400, JSON.stringify(badPatch.body));
    for (const cleared of ['none', '', null]) {
      assert.equal((await patch(ctx, reminder.id, { recurrence: 'monthly' })).body.reminder.recurrence, 'monthly');
      const res = await patch(ctx, reminder.id, { recurrence: cleared });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal(res.body.reminder.recurrence, null, `recurrence=${JSON.stringify(cleared)}`);
    }
  },

  async completing_a_recurring_reminder_moves_due_forward() {
    const ctx = await setup();
    const due = new Date(Date.now() + DAY);
    const reminder = await create(ctx, { title: 'Take out the bins', recurrence: 'weekly', due_date: iso(due) });
    const next = await complete(ctx, reminder.id);
    assert.equal(next.completed, false);
    assert.equal(iso(next.due_date), iso(due.getTime() + 7 * DAY));
  },

  // Missed weeks are skipped, not stacked: the next occurrence is the first
  // one after now, on the same weekday and time as the original.
  async overdue_recurring_reminder_skips_missed_occurrences() {
    const ctx = await setup();
    const reminder = await create(ctx, { title: 'Weekly review', recurrence: 'weekly', due_date: '2020-01-06T09:00:00Z' });
    const next = new Date((await complete(ctx, reminder.id)).due_date);
    assert.ok(next > new Date(), `${next.toISOString()} should be in the future`);
    assert.ok(next <= new Date(Date.now() + 7 * DAY), `${next.toISOString()} should be within a week`);
    assert.equal(next.getUTCDay(), 1);
    assert.equal(next.toISOString().slice(11), '09:00:00.000Z');
  },

  async monthly_and_yearly_clamp_to_the_last_day_of_the_month() {
    const ctx = await setup();
    const cases = [
      ['monthly', '2099-01-31T12:00:00Z', '2099-02-28T12:00:00.000Z'],
      ['monthly', '2096-01-31T12:00:00Z', '2096-02-29T12:00:00.000Z'],
      ['monthly', '2099-03-31T12:00:00Z', '2099-04-30T12:00:00.000Z'],
      ['monthly', '2099-12-15T12:00:00Z', '2100-01-15T12:00:00.000Z'],
      ['yearly', '2096-02-29T12:00:00Z', '2097-02-28T12:00:00.000Z'],
      ['daily', '2099-12-31T12:00:00Z', '2100-01-01T12:00:00.000Z'],
    ];
    for (const [recurrence, due, expected] of cases) {
      const reminder = await create(ctx, { title: `${recurrence} ${due}`, recurrence, due_date: due });
      assert.equal(iso((await complete(ctx, reminder.id)).due_date), expected, `${recurrence} from ${due}`);
    }
  },

  async recurring_reminder_without_a_due_date_gets_one_interval_from_now() {
    const ctx = await setup();
    const reminder = await create(ctx, { title: 'Stretch', recurrence: 'daily' });
    const before = Date.now();
    const next = await complete(ctx, reminder.id);
    const after = Date.now();
    assert.equal(next.completed, false);
    const due = new Date(next.due_date).getTime();
    assert.ok(due >= before + DAY - 1000 && due <= after + DAY + 1000, `${next.due_date} should be a day from now`);
  },

  async completing_a_one_off_reminder_is_unchanged() {
    const ctx = await setup();
    const reminder = await create(ctx, { title: 'Renew passport', due_date: '2099-05-01' });
    const done = await complete(ctx, reminder.id);
    assert.equal(done.completed, true);
    assert.equal(iso(done.due_date), '2099-05-01T00:00:00.000Z');
    const feed = await ctx.feed.buildFeedResponse(ctx.sql, ALICE, {});
    assert.ok(!feed.cards.some(card => card.id === reminder.id), 'a completed one-off reminder leaves the feed');
  },

  async uncompleting_never_advances() {
    const ctx = await setup();
    const reminder = await create(ctx, { title: 'Floss', recurrence: 'daily', due_date: '2099-05-01T08:00:00Z' });
    const res = await patch(ctx, reminder.id, { completed: false });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(iso(res.body.reminder.due_date), '2099-05-01T08:00:00.000Z');
    // Editing other fields of a recurring reminder doesn't advance it either.
    const renamed = await patch(ctx, reminder.id, { title: 'Floss properly' });
    assert.equal(iso(renamed.body.reminder.due_date), '2099-05-01T08:00:00.000Z');
  },

  // Done for this week: the card is snoozed until it's due again, and reads
  // as a repeating reminder in the feed.
  async rolled_forward_reminder_is_snoozed_until_next_due_and_says_it_repeats() {
    const ctx = await setup();
    const due = new Date(Date.now() + DAY);
    const reminder = await create(ctx, { title: 'Call mum', recurrence: 'weekly', due_date: iso(due) });

    const before = await ctx.feed.buildFeedResponse(ctx.sql, ALICE, {});
    const card = before.cards.find(c => c.id === reminder.id);
    assert.ok(card, 'the recurring reminder is in the feed before it is done');
    assert.equal(card.metadata.recurrence, 'weekly');
    assert.match(card.subtitle, /, repeats weekly$/);

    const next = await complete(ctx, reminder.id);
    const active = await ctx.feed.buildFeedResponse(ctx.sql, ALICE, {});
    assert.ok(!active.cards.some(c => c.id === reminder.id), 'done for now: the card leaves the active feed');
    const snoozed = await ctx.feed.buildFeedResponse(ctx.sql, ALICE, { view: 'snoozed' });
    const later = snoozed.cards.find(c => c.id === reminder.id);
    assert.ok(later, 'the card is snoozed, not archived');
    assert.equal(iso(later.remind_later_until), iso(next.due_date));
  },

  // update_reminder is marked idempotent for MCP clients, and the detail
  // view's Dismiss can be clicked twice: a repeat must not skip a week.
  async completing_twice_does_not_skip_an_occurrence() {
    const ctx = await setup();
    const due = new Date(Date.now() + DAY);
    const reminder = await create(ctx, { title: 'Water the garden', recurrence: 'weekly', due_date: iso(due) });
    const first = await complete(ctx, reminder.id);
    const second = await complete(ctx, reminder.id);
    assert.equal(iso(second.due_date), iso(first.due_date));
    assert.equal(second.completed, false);
    const [state] = await ctx.sql`select remind_later_until from feed_state where item_id = ${reminder.id}`;
    assert.equal(iso(state.remind_later_until), iso(first.due_date));
    // Bringing it back to the feed and completing it again is a real completion.
    await ctx.feed.applyFeedAction(ctx.sql, ALICE, 'unremind_later', 'reminder', reminder.id);
    const third = await complete(ctx, reminder.id);
    assert.equal(iso(third.due_date), iso(new Date(first.due_date).getTime() + 7 * DAY));
  },

  // remind_at is retired (Cardlake sends no notifications). Rows saved before
  // then still hold one; it must neither be written nor steer the snooze.
  async a_stored_remind_at_is_ignored() {
    const ctx = await setup();
    const due = new Date(Date.now() + DAY);
    const reminder = await create(ctx, { title: 'Book club', recurrence: 'monthly', due_date: iso(due), remind_at: iso(due.getTime() - 2 * 3600e3) });
    const [created] = await ctx.sql`select remind_at from reminders where id = ${reminder.id}`;
    assert.equal(created.remind_at, null);
    await ctx.sql`update reminders set remind_at = ${iso(due.getTime() - 2 * 3600e3)} where id = ${reminder.id}`;
    const next = await complete(ctx, reminder.id);
    const [state] = await ctx.sql`select remind_later_until from feed_state where user_email = ${ALICE} and item_type = 'reminder' and item_id = ${reminder.id}`;
    assert.equal(iso(state.remind_later_until), iso(next.due_date));
  },

  // The deploy lands before the migration: plain reminders keep working
  // everywhere, and asking for recurrence says why it can't be done yet.
  async plain_reminders_work_before_the_migration() {
    const ctx = await setup({ preMigration: true });
    const reminder = await create(ctx, { title: 'Before the migration', due_date: '2099-05-01' });
    const listed = await call(ctx.collection, { method: 'GET' });
    assert.equal(listed.code, 200, JSON.stringify(listed.body));
    assert.ok(listed.body.reminders.some(r => r.id === reminder.id));
    const feed = await ctx.feed.buildFeedResponse(ctx.sql, ALICE, {});
    assert.ok(feed.cards.some(c => c.id === reminder.id), 'the feed still loads reminders');
    assert.equal((await complete(ctx, reminder.id)).completed, true);

    const recurring = await call(ctx.collection, { method: 'POST', body: { title: 'Too early', recurrence: 'weekly' } });
    assert.ok(recurring.code >= 400 && recurring.code < 500, `expected a client error, got ${recurring.code} ${JSON.stringify(recurring.body)}`);
    assert.match(recurring.body.error, /recurring/i);
    const recurringPatch = await patch(ctx, reminder.id, { recurrence: 'weekly' });
    assert.ok(recurringPatch.code >= 400 && recurringPatch.code < 500, `expected a client error, got ${recurringPatch.code}`);
    assert.match(recurringPatch.body.error, /recurring/i);
  },

  async another_account_cannot_complete_or_roll_forward_a_reminder() {
    const ctx = await setup();
    const reminder = await create(ctx, { title: 'Alice only', recurrence: 'weekly', due_date: '2099-05-01T08:00:00Z' });
    const res = await patch(ctx, reminder.id, { completed: true }, BOB);
    assert.equal(res.code, 404, JSON.stringify(res.body));
    const [row] = await ctx.sql`select due_date, completed from reminders where id = ${reminder.id}`;
    assert.equal(iso(row.due_date), '2099-05-01T08:00:00.000Z');
    assert.equal(row.completed, false);
    const states = await ctx.sql`select 1 from feed_state where item_id = ${reminder.id}`;
    assert.equal(states.length, 0, 'no feed state is written for another account');
  },

  // schema-v2.sql is re-run on every migration.
  async schema_adds_recurrence_and_is_safe_to_rerun() {
    const ctx = await setup();
    await ctx.applySchema();
    const [column] = await ctx.sql`select data_type from information_schema.columns where table_name = 'reminders' and column_name = 'recurrence'`;
    assert.equal(column?.data_type, 'text');
    await assert.rejects(ctx.sql`insert into reminders (user_email, title, recurrence) values (${ALICE}, 'raw', 'hourly')`, /check/i);
  },
};

require('./scenario_runner').runScenario(scenarios);
