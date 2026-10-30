// Behavioral checks for first-run onboarding (api/_lib/onboarding.js), run
// against real Postgres (PGlite, see pg_harness.js) through api/vault.js, the
// route production uses. Invoked by test_onboarding.py as
// `node tests/unit/onboarding_scenarios.js <name>`; exits non-zero with a
// message on the first failed assertion.
process.env.SESSION_SECRET = 'onboarding-scenarios-secret';
process.env.DATABASE_URL = 'postgres://unused-in-tests';
require('./pg_harness').allowAccounts('alice@example.test,bob@example.test,carol@example.test');
// limits.js reads this once at load, so the card-limit scenario sets it first.
if (process.argv[2] === 'seeding_stops_at_the_card_limit') process.env.CARDLE_MAX_CARDS_PER_USER = '5';

const assert = require('assert/strict');
const { createTestDb } = require('./pg_harness');
const db = require('../../api/_lib/db');
const { setSessionCookie } = require('../../api/_lib/auth');
const { findPersona } = require('../../api/_lib/onboarding-personas');

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';

async function setup() {
  const testDb = await createTestDb();
  db.getSql = () => testDb.sql;
  return { ...testDb, vault: require('../../api/vault') };
}

function sessionCookie(email) {
  let header = '';
  setSessionCookie({ setHeader: (_, value) => { header = value; } }, { email });
  return header.split(';')[0];
}

async function call(handler, email, { method = 'GET', action, body } = {}) {
  const query = { resource: 'onboarding', ...(action ? { action } : {}) };
  const req = { method, url: '/api/onboarding', query, body, headers: email ? { cookie: sessionCookie(email) } : {} };
  const res = {
    statusCode: 200, body: undefined, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
    end() { return this; },
    setHeader(key, value) { this.headers[key] = value; },
    getHeader(key) { return this.headers[key]; },
  };
  await handler(req, res);
  return res;
}

const status = (vault, email) => call(vault, email);
const pick = (vault, email, persona, timeZone = 'UTC') => call(vault, email, { method: 'POST', body: { persona, timeZone } });
const clear = (vault, email) => call(vault, email, { method: 'DELETE', action: 'samples' });

async function cardCounts(sql, email) {
  const [row] = await sql`select
    (select count(*)::int from learning_entries where user_email = ${email} and deleted_at is null) as learning,
    (select count(*)::int from reminders where user_email = ${email} and deleted_at is null) as reminder,
    (select count(*)::int from work_items where user_email = ${email} and deleted_at is null) as work,
    (select count(*)::int from family_updates where user_email = ${email} and deleted_at is null) as family,
    (select count(*)::int from bookmarks where user_email = ${email} and deleted_at is null) as bookmark,
    (select count(*)::int from talking_points where user_email = ${email} and deleted_at is null) as talking_point`;
  return { ...row, total: Object.values(row).reduce((sum, n) => sum + n, 0) };
}

function expectedCounts(personaId) {
  const counts = { learning: 0, reminder: 0, work: 0, family: 0, bookmark: 0, talking_point: 0 };
  for (const card of findPersona(personaId).cards) counts[card.type] += 1;
  return counts;
}

const scenarios = {
  async only_a_brand_new_account_is_sent_to_onboarding() {
    const { sql, vault } = await setup();
    const fresh = await status(vault, ALICE);
    assert.equal(fresh.statusCode, 200, JSON.stringify(fresh.body));
    assert.equal(fresh.body.needsOnboarding, true);
    assert.equal(fresh.body.personas.length, 4);
    // An account from before onboarding existed has cards and no onboarded_at.
    await sql`insert into reminders (user_email, title) values (${BOB}, 'An existing card')`;
    assert.equal((await status(vault, BOB)).body.needsOnboarding, false);
    assert.equal((await status(vault, null)).statusCode, 401);
  },

  async an_account_that_signed_up_from_its_assistant_is_offered_onboarding() {
    const { sql, vault } = await setup();
    const CAROL = 'carol@example.test';
    // Bob's account predates onboarding; Alice onboarded once it existed.
    await sql`insert into users (email, created_at) values (${BOB}, now() - interval '30 days')`;
    await sql`insert into reminders (user_email, title) values (${BOB}, 'An existing card')`;
    await sql`insert into users (email, created_at, onboarded_at) values (${ALICE}, now() - interval '10 days', now() - interval '10 days')`;
    // Carol signed up later by connecting Claude and saved a card there.
    await sql`insert into users (email) values (${CAROL})`;
    await sql`insert into reminders (user_email, title) values (${CAROL}, 'Saved from Claude')`;
    const carol = await status(vault, CAROL);
    assert.equal(carol.body.needsOnboarding, true, 'a new account must not skip onboarding for having cards');
    assert.equal(carol.body.cardCount, 1);
    assert.equal((await status(vault, BOB)).body.needsOnboarding, false, 'an account from before onboarding must not be sent to it');
    await pick(vault, CAROL, 'empty');
    assert.equal((await status(vault, CAROL)).body.needsOnboarding, false);
  },

  async picking_a_persona_seeds_its_cards_into_that_account_only() {
    const { sql, vault } = await setup();
    const res = await pick(vault, ALICE, 'agentic_exec');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const persona = findPersona('agentic_exec');
    assert.equal(res.body.seeded, persona.cards.length);
    const { total, ...byType } = await cardCounts(sql, ALICE);
    assert.deepEqual(byType, expectedCounts('agentic_exec'));
    assert.equal((await cardCounts(sql, BOB)).total, 0, 'seeding leaked into another account');
    const after = await status(vault, ALICE);
    assert.equal(after.body.needsOnboarding, false);
    assert.equal(after.body.persona, 'agentic_exec');
    assert.equal(after.body.sampleCount, persona.cards.length);
    // Work checklists use the shape the feed and MCP tools expect.
    const [work] = await sql`select items from work_items where user_email = ${ALICE}`;
    assert.deepEqual(work.items[0], { text: 'Pick 3 pilots', completed: false });
  },

  async bad_requests_are_refused() {
    const { sql, vault } = await setup();
    assert.equal((await pick(vault, null, 'agentic_exec')).statusCode, 401);
    const unknown = await pick(vault, ALICE, 'astronaut');
    assert.equal(unknown.statusCode, 400);
    assert.equal(unknown.body.code, 'UNKNOWN_PERSONA');
    assert.equal((await cardCounts(sql, ALICE)).total, 0);
    assert.equal((await status(vault, ALICE)).body.needsOnboarding, true, 'a refused pick must not finish onboarding');
  },

  async picking_twice_adds_the_cards_once() {
    const { sql, vault } = await setup();
    const [first, second] = await Promise.all([pick(vault, ALICE, 'ai_builder'), pick(vault, ALICE, 'ai_builder')]);
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.body.seeded + second.body.seeded, findPersona('ai_builder').cards.length);
    const again = await pick(vault, ALICE, 'curious_learner');
    assert.equal(again.body.alreadyOnboarded, true);
    assert.equal((await cardCounts(sql, ALICE)).total, findPersona('ai_builder').cards.length);
  },

  async starting_empty_finishes_onboarding_without_cards() {
    const { sql, vault } = await setup();
    const res = await pick(vault, ALICE, 'empty');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.seeded, 0);
    assert.equal((await cardCounts(sql, ALICE)).total, 0);
    const after = await status(vault, ALICE);
    assert.equal(after.body.needsOnboarding, false, 'an empty feed must not loop back into onboarding');
    assert.equal(after.body.sampleCount, 0);
  },

  async seeding_stops_at_the_card_limit() {
    const { sql, vault } = await setup();
    await sql`insert into reminders (user_email, title) values (${ALICE}, 'Mine 1'), (${ALICE}, 'Mine 2')`;
    const res = await pick(vault, ALICE, 'product_leader');
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.seeded, 3);
    assert.equal(res.body.skipped, findPersona('product_leader').cards.length - 3);
    assert.equal((await cardCounts(sql, ALICE)).total, 5);
  },

  async reminders_fall_due_at_the_next_local_time() {
    const { sql, vault } = await setup();
    await pick(vault, ALICE, 'agentic_exec', 'Asia/Kolkata');
    const [gym] = await sql`select due_date from reminders where user_email = ${ALICE} and title = 'Gym 7am'`;
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(gym.due_date));
    assert.equal(local, '07:00');
    assert.ok(new Date(gym.due_date) > new Date(), 'reminder is already overdue');
    assert.ok(new Date(gym.due_date) - new Date() <= 24 * 3600 * 1000, 'reminder is more than a day away');
    // Pure checks, including a DST boundary and an unknown zone falling back to UTC.
    // Required here, not at the top: onboarding.js takes db.getSql at load, so it
    // must load after setup() points that at the test database.
    const { nextOccurrence } = require('../../api/_lib/onboarding');
    const at = iso => new Date(iso);
    assert.equal(nextOccurrence('07:00', 'UTC', at('2026-09-28T06:00:00Z')).toISOString(), '2026-09-28T07:00:00.000Z');
    assert.equal(nextOccurrence('07:00', 'UTC', at('2026-09-28T07:00:00Z')).toISOString(), '2026-09-29T07:00:00.000Z');
    assert.equal(nextOccurrence('07:00', 'America/New_York', at('2026-11-01T03:00:00Z')).toISOString(), '2026-11-01T12:00:00.000Z');
    await pick(vault, BOB, 'curious_learner', 'Not/AZone');
    const [study] = await sql`select due_date from reminders where user_email = ${BOB} and title = 'Study block 8pm'`;
    assert.equal(new Date(study.due_date).getUTCHours(), 20);
    const [undated] = await sql`select due_date from reminders where user_email = ${BOB} and title = 'Read 20 pages'`;
    assert.equal(undated.due_date, null);
  },

  async clearing_samples_keeps_the_cards_someone_made_their_own() {
    const { sql, vault } = await setup();
    await pick(vault, ALICE, 'agentic_exec');
    await sql`insert into reminders (user_email, title) values (${ALICE}, 'My own card')`;
    // Make three samples "theirs": an edit, a pin, an attachment.
    const [edited] = await sql`select id from reminders where user_email = ${ALICE} and title = 'Gym 7am'`;
    await sql`update reminders set title = 'Gym 6am' where id = ${edited.id}`;
    const [pinned] = await sql`select id from learning_entries where user_email = ${ALICE} and title = 'What is MCP?'`;
    await sql`insert into feed_state (user_email, item_type, item_id, pinned_at) values (${ALICE}, 'learning', ${pinned.id}, now())`;
    const [attached] = await sql`select id from work_items where user_email = ${ALICE}`;
    await sql`insert into attachments (user_email, parent_type, parent_id, name, mime_type, byte_size, blob_url) values (${ALICE}, 'work', ${attached.id}, 'a.png', 'image/png', 1, 'https://blob.example/a.png')`;

    const res = await clear(vault, ALICE);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.kept, 3);
    assert.equal(res.body.cleared, findPersona('agentic_exec').cards.length - 3);
    assert.equal((await cardCounts(sql, ALICE)).total, 4);
    assert.equal((await status(vault, ALICE)).body.sampleCount, 0);
    assert.equal((await clear(vault, null)).statusCode, 401);
  },

  async connecting_an_assistant_is_detected() {
    const { sql, vault } = await setup();
    assert.equal((await status(vault, ALICE)).body.aiConnected, false);
    await sql`insert into oauth_refresh_tokens (token_hash, user_email, client_id, resource, scope, expires_at) values ('h1', ${ALICE}, 'claude', 'https://cardlake.example/api/mcp', 'cardle', now() + interval '30 days')`;
    assert.equal((await status(vault, ALICE)).body.aiConnected, true);
    assert.equal((await status(vault, BOB)).body.aiConnected, false);
  },

  async before_the_migration_onboarding_switches_itself_off() {
    const { sql, vault } = await setup();
    await sql`alter table users drop column onboarded_at`;
    const res = await status(vault, ALICE);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.available, false);
    assert.equal(res.body.needsOnboarding, false, 'nobody may be sent to an onboarding that cannot finish');
    const seed = await pick(vault, ALICE, 'agentic_exec');
    assert.equal(seed.statusCode, 503);
    assert.equal((await cardCounts(sql, ALICE)).total, 0);
  },
};

const name = process.argv[2];
if (!scenarios[name]) {
  console.error(`Unknown scenario: ${name}`);
  process.exit(2);
}
scenarios[name]().then(() => process.exit(0), error => {
  console.error(error.stack || error);
  process.exit(1);
});
