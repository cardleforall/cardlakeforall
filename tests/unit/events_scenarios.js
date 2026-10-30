// Behavioral checks for the user-action log (api/_lib/events.js), run against
// real Postgres (PGlite, see pg_harness.js) through the actual HTTP handlers.
// Invoked by test_user_events.py as `node tests/unit/events_scenarios.js
// <name>`; exits non-zero with a message on the first failed assertion.
process.env.SESSION_SECRET = 'events-scenarios-secret';
process.env.DATABASE_URL = 'postgres://unused-in-tests';
require('./pg_harness').allowAccounts('alice@example.test');

const assert = require('assert/strict');
const { createTestDb } = require('./pg_harness');
const db = require('../../api/_lib/db');
const { setSessionCookie } = require('../../api/_lib/auth');

const ALICE = 'alice@example.test';
const UUID = '0b6f6d4e-7a57-4c4a-9c1e-2f0a3b8d9e11';

async function setup() {
  const testDb = await createTestDb();
  db.getSql = () => testDb.sql;
  return { ...testDb, feed: require('../../api/feed'), vault: require('../../api/vault'), auth: require('../../api/auth') };
}

function sessionCookie(email) {
  let header = '';
  setSessionCookie({ setHeader: (_, value) => { header = value; } }, { email });
  return header.split(';')[0];
}

function request(email, { method = 'GET', url = '/api/test', query = {}, body } = {}) {
  return { method, url, query, body, headers: email ? { cookie: sessionCookie(email) } : {} };
}

async function call(handler, req) {
  const res = {
    statusCode: 200, body: undefined, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
    setHeader(key, value) { this.headers[key] = value; },
    getHeader(key) { return this.headers[key]; },
  };
  await handler(req, res);
  return res;
}

async function events(sql) {
  return sql`select user_email, event_type, source, item_type, item_id::text as item_id, context, client_at from user_events order by id`;
}

async function createReminder(vault, title) {
  const res = await call(vault, request(ALICE, { method: 'POST', url: '/api/reminders', query: { resource: 'reminders' }, body: { title } }));
  assert.equal(res.statusCode, 201, JSON.stringify(res.body));
  return res.body.reminder.id;
}

const feedAction = (feed, action, id) => call(feed, request(ALICE, { method: 'POST', url: '/api/feed', body: { action, item_type: 'reminder', item_id: id } }));

const scenarios = {
  // feed_state keeps only the latest state -- after an unlike there is no
  // trace of the like. The event log keeps every step, in order, and names
  // the fields a write touched without copying what the person typed.
  async feed_actions_keep_their_full_history() {
    const { sql, feed, vault } = await setup();
    const id = await createReminder(vault, 'Call the bank about the mortgage');
    for (const action of ['like', 'unlike', 'pin', 'unpin']) assert.equal((await feedAction(feed, action, id)).statusCode, 200);

    const [state] = await sql`select liked_at, pinned_at from feed_state where item_id = ${id}`;
    assert.equal(state.liked_at, null);
    const rows = await events(sql);
    assert.deepEqual(rows.map(row => row.event_type), ['card.create', 'feed.like', 'feed.unlike', 'feed.pin', 'feed.unpin']);
    for (const row of rows) {
      assert.equal(row.user_email, ALICE);
      assert.equal(row.source, 'web');
      assert.equal(row.item_type, 'reminder');
      assert.equal(row.item_id, id);
      assert.equal(row.context.status, 200 + (row.event_type === 'card.create' ? 1 : 0));
    }
    assert.ok(rows[0].context.fields.includes('title'));
    assert.equal(rows[0].context.completed, false);
    assert.ok(!JSON.stringify(rows).includes('mortgage'), 'free text leaked into the event log');
  },

  // A refused action is still something the person tried.
  async refused_actions_are_recorded_with_their_status() {
    const { sql, feed, vault } = await setup();
    const ids = [];
    for (const title of ['one', 'two', 'three', 'four']) ids.push(await createReminder(vault, title));
    for (const id of ids.slice(0, 3)) assert.equal((await feedAction(feed, 'pin', id)).statusCode, 200);
    assert.equal((await feedAction(feed, 'pin', ids[3])).statusCode, 400);
    const last = (await events(sql)).at(-1);
    assert.equal(last.event_type, 'feed.pin');
    assert.equal(last.item_id, ids[3]);
    assert.equal(last.context.status, 400);
  },

  // Each feed page served is recorded with its cards in order: the exposure
  // every later action is measured against. Anonymous (demo) views and plain
  // reads record nothing.
  async feed_pages_served_record_what_was_shown() {
    const { sql, feed, vault } = await setup();
    await createReminder(vault, 'first');
    await createReminder(vault, 'second');
    const before = (await events(sql)).length;

    const res = await call(feed, request(ALICE, { url: '/api/feed', query: { limit: '20' } }));
    assert.equal(res.statusCode, 200);
    const served = (await events(sql)).at(-1);
    assert.equal(served.event_type, 'feed.served');
    assert.deepEqual(served.context.cards, res.body.cards.map(card => [card.type, card.id]));
    assert.equal(served.context.view, res.body.view);

    await call(feed, request(null, { url: '/api/feed' }));
    await call(require('../../api/vault'), request(ALICE, { url: '/api/dashboard/stats', query: { resource: 'dashboard', action: 'stats' } }));
    assert.equal((await events(sql)).length, before + 1);
  },

  async anonymous_writes_record_nothing() {
    const { sql, feed } = await setup();
    const res = await call(feed, request(null, { method: 'POST', url: '/api/feed', body: { action: 'like', item_type: 'reminder', item_id: UUID } }));
    assert.equal(res.statusCode, 401);
    assert.equal((await events(sql)).length, 0);
  },

  // A write no handler describes is still recorded -- method, route, status --
  // but never its request body, which can hold credentials.
  async undescribed_writes_are_recorded_without_their_body() {
    const { sql } = await setup();
    const { withSessionGuard } = require('../../api/_lib/session-guard');
    const handler = withSessionGuard(async (req, res) => res.status(200).json({ ok: true }));
    await call(handler, request(ALICE, { method: 'POST', url: '/api/integrations/github?x=1', query: { resource: 'integrations', provider: 'github', token: 'ghp_supersecret' }, body: { token: 'ghp_supersecret' } }));
    const [row] = await events(sql);
    assert.equal(row.event_type, 'api.request');
    assert.equal(row.context.method, 'POST');
    assert.equal(row.context.path, '/api/integrations/github');
    assert.deepEqual(row.context.query, { resource: 'integrations', provider: 'github' });
    assert.ok(!JSON.stringify(row).includes('ghp_'), 'a credential reached the event log');
  },

  // Browser events: only known types are kept, ids and context are bounded,
  // implausible client clocks are dropped, and nobody is recorded without a
  // session. The /api/events request itself is not logged a second time.
  async client_events_are_validated() {
    const { sql, vault } = await setup();
    const post = (email, body) => call(vault, request(email, { method: 'POST', url: '/api/events', query: { resource: 'events' }, body }));
    const now = new Date().toISOString();
    const res = await post(ALICE, { events: [
      { type: 'card.impression', item_type: 'reminder', item_id: UUID, context: { position: 2 }, at: now },
      { type: 'admin.delete_everything', item_type: 'reminder', item_id: UUID },
      { type: 'card.open', item_type: 'reminder', item_id: 'sandbox-reminder', context: { position: 0 } },
      { type: 'card.close', item_type: 'nonsense', item_id: UUID, context: { blob: 'x'.repeat(5000) }, at: '2001-01-01T00:00:00Z' },
    ] });
    assert.equal(res.statusCode, 204);
    const rows = await events(sql);
    assert.deepEqual(rows.map(row => row.event_type), ['card.impression', 'card.open', 'card.close']);
    assert.equal(rows[0].item_id, UUID);
    assert.deepEqual(rows[0].context, { position: 2 });
    assert.ok(rows[0].client_at);
    assert.equal(rows[1].item_id, null);
    assert.equal(rows[2].item_type, null);
    assert.deepEqual(rows[2].context, { truncated: true });
    assert.equal(rows[2].client_at, null);

    assert.equal((await post(null, { events: [{ type: 'card.open' }] })).statusCode, 204);
    assert.equal((await post(ALICE, { events: Array.from({ length: 51 }, () => ({ type: 'card.open' })) })).statusCode, 413);
    assert.equal((await events(sql)).length, 3);
  },

  // The log must never cost the person their action.
  async a_failing_log_never_fails_the_action() {
    const { sql, feed, vault } = await setup();
    const id = await createReminder(vault, 'keep me');
    db.getSql = () => async (first, ...rest) => {
      const text = Array.isArray(first) ? first.join('?') : String(first);
      if (text.includes('user_events')) throw new Error('database unavailable');
      return sql(first, ...rest);
    };
    const res = await feedAction(feed, 'like', id);
    assert.equal(res.statusCode, 200);
    const [state] = await sql`select liked_at from feed_state where item_id = ${id}`;
    assert.ok(state.liked_at);
  },

  // Before /api/migrate has run, the first event creates the table.
  async the_table_is_created_on_first_use() {
    const { sql, feed, vault } = await setup();
    const id = await createReminder(vault, 'early');
    await sql`drop table user_events`;
    assert.equal((await feedAction(feed, 'like', id)).statusCode, 200);
    assert.deepEqual((await events(sql)).map(row => row.event_type), ['feed.like']);
  },

  // AI clients act for the person too: each tool call is one event, with the
  // card it touched (including a card it just created).
  async mcp_tool_calls_are_recorded() {
    const { sql, vault } = await setup();
    const id = await createReminder(vault, 'from the app');
    await sql`delete from user_events`;
    const tools = new Map();
    require('../../api/_lib/mcp-tools').registerTools({ registerTool(name, config, handler) { tools.set(name, handler); } }, ALICE);

    const snoozed = await tools.get('snooze_card')({ card_type: 'reminder', card_id: id });
    assert.ok(!snoozed.isError, JSON.stringify(snoozed));
    const created = await tools.get('create_reminder')({ title: 'from the assistant' });
    const createdId = JSON.parse(created.content[0].text).id;
    const failed = await tools.get('snooze_card')({ card_type: 'reminder', card_id: UUID });
    assert.ok(failed.isError);

    const rows = await events(sql);
    assert.deepEqual(rows.map(row => [row.event_type, row.source, row.item_id, row.context.ok]), [
      ['mcp.snooze_card', 'mcp', id, true],
      ['mcp.create_reminder', 'mcp', createdId, true],
      ['mcp.snooze_card', 'mcp', UUID, false],
    ]);
    assert.equal(rows[0].item_type, 'reminder');
    assert.ok(!JSON.stringify(rows).includes('from the assistant'));
  },

  // list_feed and search_cards return many cards; like feed.served on the web,
  // their event keeps which ones, in order, plus the filters -- but never the
  // search text. A failed call lists none.
  async mcp_card_lists_record_the_cards_returned() {
    const { sql, vault } = await setup();
    await createReminder(vault, 'pay the gas bill');
    await createReminder(vault, 'pay the water bill');
    await createReminder(vault, 'water the plants');
    await sql`delete from user_events`;
    const tools = new Map();
    require('../../api/_lib/mcp-tools').registerTools({ registerTool(name, config, handler) { tools.set(name, handler); } }, ALICE);

    const listed = (await tools.get('list_feed')({ types: ['reminder'], limit: 2 })).structuredContent;
    const found = (await tools.get('search_cards')({ query: 'bill' })).structuredContent;
    assert.ok((await tools.get('list_feed')({ cursor: 'not-a-cursor' })).isError);

    const rows = await events(sql);
    assert.deepEqual(rows.map(row => row.event_type), ['mcp.list_feed', 'mcp.search_cards', 'mcp.list_feed']);
    assert.equal(listed.cards.length, 2);
    assert.deepEqual(rows[0].context.cards, listed.cards.map(card => [card.type, card.id]));
    assert.deepEqual(rows[0].context.types, ['reminder']);
    assert.equal(rows[0].context.view, listed.view);
    assert.equal(found.cards.length, 2);
    assert.deepEqual(rows[1].context.cards, found.cards.map(card => [card.type, card.id]));
    assert.equal(rows[2].context.cards, undefined);
    assert.ok(!JSON.stringify(rows).includes('bill'), 'search text reached the event log');
  },

  // The local dev server guards route files that already guard themselves;
  // an action must still be one event, not two.
  async stacked_wrappers_record_once() {
    const { sql, vault } = await setup();
    const { withSessionGuard } = require('../../api/_lib/session-guard');
    const id = await createReminder(vault, 'once');
    assert.equal((await feedAction(withSessionGuard(require('../../api/feed')), 'like', id)).statusCode, 200);
    assert.deepEqual((await events(sql)).map(row => row.event_type), ['card.create', 'feed.like']);
  },

  async signing_out_is_recorded() {
    const { sql, auth } = await setup();
    const res = await call(auth, request(ALICE, { method: 'POST', url: '/api/auth/logout', query: { action: 'logout' } }));
    assert.equal(res.statusCode, 200);
    const rows = await events(sql);
    assert.deepEqual(rows.map(row => [row.event_type, row.user_email]), [['auth.sign_out', ALICE]]);
  },
};

const name = process.argv[2];
if (!scenarios[name]) {
  console.error(`Unknown scenario: ${name}`);
  process.exit(2);
}
scenarios[name]().then(() => process.exit(0), error => { console.error(error.stack || error); process.exit(1); });
