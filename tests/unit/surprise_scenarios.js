// Behavioral checks for "Deal me 5" (api/_lib/surprise.js), run against real
// Postgres (PGlite, see pg_harness.js) through api/vault.js and api/feed.js,
// the routes production uses. Feeds are faked: nothing touches the network.
// Invoked by test_surprise.py as `node tests/unit/surprise_scenarios.js <name>`;
// exits non-zero with a message on the first failed assertion.
process.env.SESSION_SECRET = 'surprise-scenarios-secret';
process.env.DATABASE_URL = 'postgres://unused-in-tests';
require('./pg_harness').allowAccounts('alice@example.test,bob@example.test');
// limits.js reads this once at load, so the card-limit scenario sets it first.
if (process.argv[2] === 'deals_stop_at_the_card_limit') process.env.CARDLE_MAX_CARDS_PER_USER = '3';

const assert = require('assert/strict');
const crypto = require('crypto');
const { createTestDb } = require('./pg_harness');
const db = require('../../api/_lib/db');
const { setSessionCookie } = require('../../api/_lib/auth');
const { SOURCES, EVERGREEN, CHALLENGES } = require('../../api/_lib/surprise-sources');

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- fake feeds -------------------------------------------------------------

const videoId = (source, i) => crypto.createHash('md5').update(`${source.id}:${i}`).digest('base64url').slice(0, 11);

// A feed with `count` recent items, plus an item too old to deal and, on
// YouTube, a Short: neither may ever be dealt.
function atomFeed(source, count) {
  const isYoutube = source.id.startsWith('yt:');
  const entry = (i, daysOld, short = false) => {
    const id = videoId(source, i);
    const link = isYoutube ? `https://www.youtube.com/${short ? `shorts/${id}` : `watch?v=${id}`}` : `https://example.test/${source.id.slice(4)}/${i}`;
    return `<entry>${isYoutube ? `<yt:videoId>${id}</yt:videoId>` : ''}<title>${source.name} &amp; item ${i}</title><link rel="alternate" href="${link}"/><published>${new Date(Date.now() - daysOld * DAY_MS).toISOString()}</published></entry>`;
  };
  const entries = Array.from({ length: count }, (_, i) => entry(i, i + 1));
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>${source.name}</title>${entries.join('')}${isYoutube ? entry(90, 2, true) : ''}${entry(91, 200)}</feed>`;
}

// Replaces global fetch. `failing` lists source ids whose feed is down.
function fakeFeeds({ perSource = 3, failing = [] } = {}) {
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(url);
    const source = SOURCES.find(s => s.feed === url);
    if (!source || failing === 'all' || failing.includes(source.id)) return { ok: false, status: 503, text: async () => '' };
    return { ok: true, status: 200, text: async () => atomFeed(source, perSource) };
  };
  return calls;
}

// ---- calling the API --------------------------------------------------------

async function setup(feeds) {
  const calls = fakeFeeds(feeds);
  const testDb = await createTestDb();
  db.getSql = () => testDb.sql;
  return { ...testDb, calls, vault: require('../../api/vault'), feed: require('../../api/feed') };
}

function sessionCookie(email) {
  let header = '';
  setSessionCookie({ setHeader: (_, value) => { header = value; } }, { email });
  return header.split(';')[0];
}

async function call(handler, email, { method = 'GET', query = { resource: 'surprise' }, url = '/api/surprise', body } = {}) {
  const req = { method, url, query, body, headers: email ? { cookie: sessionCookie(email) } : {} };
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
const dealCards = (vault, email, body = {}) => call(vault, email, { method: 'POST', body });
const openFeed = (feed, email) => call(feed, email, { query: {}, url: '/api/feed' });
// Deals made in one test run back to back would otherwise count as a double tap.
const allowNextDeal = (sql, email) => sql`update users set last_deal_at = null where email = ${email}`;

async function liveCards(sql, email) {
  return sql`
    select 'learning' as type, id, title, url from learning_entries where user_email = ${email} and deleted_at is null
    union all select 'reminder', id, title, null from reminders where user_email = ${email} and deleted_at is null`;
}

// Which fake source a dealt link came from.
const sourceOfUrl = url => SOURCES.find(s => Array.from({ length: 100 }, (_, i) => (s.id.startsWith('yt:') ? `https://www.youtube.com/watch?v=${videoId(s, i)}` : `https://example.test/${s.id.slice(4)}/${i}`)).includes(url));

const scenarios = {
  async first_deal_saves_topics_and_deals_four_learnings_and_one_thing_to_try() {
    const { sql, vault } = await setup();
    const before = await status(vault, ALICE);
    assert.equal(before.statusCode, 200, JSON.stringify(before.body));
    assert.equal(before.body.available, true);
    assert.equal(before.body.interests, null, 'the picker must open on the first tap');
    assert.equal(before.body.dealsLeftToday, 3);
    assert.ok(before.body.unseen > 5);

    const res = await dealCards(vault, ALICE, { topics: ['science', 'not-a-topic'] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.dealt, 5);
    const cards = await liveCards(sql, ALICE);
    const learnings = cards.filter(c => c.type === 'learning');
    assert.equal(learnings.length, 4);
    const sources = learnings.map(c => sourceOfUrl(c.url));
    assert.ok(sources.every(s => s && s.topic === 'science'), 'every learning comes from the chosen topic');
    assert.equal(new Set(sources.map(s => s.id)).size, 4, 'at most one card per source');
    assert.ok(learnings.every(c => !c.url.includes('/shorts/')), 'Shorts are never dealt');
    const [challenge] = cards.filter(c => c.type === 'reminder');
    assert.ok(CHALLENGES.some(ch => ch.topic === 'science' && ch.title === challenge.title));
    const [{ interests }] = await sql`select interests from users where email = ${ALICE}`;
    assert.deepEqual(interests, ['science'], 'unknown topics are dropped');

    const after = await status(vault, ALICE);
    assert.deepEqual(after.body.interests, ['science']);
    assert.equal(after.body.dealsLeftToday, 2);
    assert.equal(after.body.trials.length, 5);
    assert.ok(after.body.trials.every(t => t.kind === 'dealt' && Date.parse(t.expiresAt) > Date.now() + 13 * DAY_MS));
    assert.equal((await liveCards(sql, BOB)).length, 0, 'dealing leaked into another account');
    const [event] = await sql`select context from user_events where user_email = ${ALICE} and event_type = 'surprise.deal'`;
    assert.equal(event.context.count, 5);
  },

  async deals_never_repeat_a_card_and_stop_after_three_a_day() {
    const { sql, vault } = await setup({ perSource: 6 });
    const dealt = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await dealCards(vault, ALICE, { topics: ['health'] });
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));
      dealt.push(...res.body.cards.map(c => c.title));
      await allowNextDeal(sql, ALICE);
    }
    const keys = await sql`select item_key from surprise_deals where user_email = ${ALICE}`;
    assert.equal(keys.length, 15);
    assert.equal(new Set(keys.map(k => k.item_key)).size, 15, 'a card was dealt twice');
    const fourth = await dealCards(vault, ALICE);
    assert.equal(fourth.statusCode, 429);
    assert.equal(fourth.body.code, 'DEAL_LIMIT');
    assert.equal((await status(vault, ALICE)).body.dealsLeftToday, 0);
    // Another account has its own allowance.
    assert.equal((await dealCards(vault, BOB, { topics: ['health'] })).statusCode, 200);
  },

  async a_new_deal_adds_to_the_last_one_whose_cards_stay_for_their_trial() {
    const { sql, vault, feed } = await setup();
    const first = await dealCards(vault, ALICE, { topics: ['ai'] });
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    await dealCards(vault, BOB, { topics: ['ai'] });
    const [liked, edited] = first.body.cards.filter(c => c.type === 'learning');
    await sql`insert into feed_state (user_email, item_type, item_id, liked_at) values (${ALICE}, 'learning', ${liked.id}, now())`;
    await sql`update learning_entries set notes = 'My own note', updated_at = now() + interval '1 second' where id = ${edited.id}`;
    await allowNextDeal(sql, ALICE);
    const second = await dealCards(vault, ALICE);
    assert.equal(second.statusCode, 200, JSON.stringify(second.body));
    assert.equal(second.body.replaced, undefined, 'a deal no longer replaces anything');
    // Every card from the first deal is still there, untouched ones included.
    const live = new Set((await liveCards(sql, ALICE)).map(c => c.id));
    for (const card of [...first.body.cards, ...second.body.cards]) assert.ok(live.has(card.id), `${card.title} should still be in the feed`);
    assert.equal(live.size, 10);
    const trials = new Set((await status(vault, ALICE)).body.trials.map(t => t.id));
    assert.equal(trials.size, 8, 'untouched cards from both deals are on trial; liked and edited ones are kept');
    assert.ok(!trials.has(liked.id) && !trials.has(edited.id));

    // Once the first deal's 14 days are up, only its untouched cards go.
    await sql`update surprise_deals set dealt_at = now() - interval '15 days' where user_email = ${ALICE} and deal_id = (select deal_id from surprise_deals where item_id = ${liked.id})`;
    assert.equal((await openFeed(feed, ALICE)).statusCode, 200);
    const after = new Set((await liveCards(sql, ALICE)).map(c => c.id));
    assert.deepEqual([...after].sort(), [liked.id, edited.id, ...second.body.cards.map(c => c.id)].sort());
    const outcomes = await sql`select outcome, count(*)::int as n from surprise_deals where user_email = ${ALICE} and deal_id = (select deal_id from surprise_deals where item_id = ${liked.id}) group by outcome order by outcome`;
    assert.deepEqual(outcomes.map(o => [o.outcome, o.n]), [['expired', 3], ['kept', 2]]);
    assert.equal((await liveCards(sql, BOB)).length, 5, "a deal must not touch another account's cards");
  },

  async untouched_dealt_and_starter_cards_expire_after_two_weeks_when_the_feed_opens() {
    const { sql, vault, feed } = await setup();
    await call(vault, ALICE, { method: 'POST', query: { resource: 'onboarding' }, url: '/api/onboarding', body: { persona: 'curious_learner' } });
    const samples = (await liveCards(sql, ALICE)).length;
    const res = await dealCards(vault, ALICE, { topics: ['money'] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const pinned = res.body.cards[0];
    await sql`insert into feed_state (user_email, item_type, item_id, pinned_at) values (${ALICE}, ${pinned.type}, ${pinned.id}, now())`;
    assert.equal((await status(vault, ALICE)).body.trials.filter(t => t.kind === 'sample').length > 0, true);

    // Opening the feed before the trial is over removes nothing.
    assert.equal((await openFeed(feed, ALICE)).statusCode, 200);
    assert.ok((await liveCards(sql, ALICE)).length >= 5);

    await sql`update surprise_deals set dealt_at = now() - interval '15 days' where user_email = ${ALICE}`;
    await sql`update users set onboarded_at = now() - interval '15 days' where email = ${ALICE}`;
    const opened = await openFeed(feed, ALICE);
    assert.equal(opened.statusCode, 200, JSON.stringify(opened.body));
    const live = await liveCards(sql, ALICE);
    assert.deepEqual(live.map(c => c.id), [pinned.id], 'only the pinned card survives');
    assert.ok(samples > 0);
    const [{ sample_cards: left }] = await sql`select sample_cards from users where email = ${ALICE}`;
    assert.deepEqual(left, []);
    assert.equal((await status(vault, ALICE)).body.trials.length, 0);
  },

  async a_double_tap_deals_once() {
    const { sql, vault } = await setup();
    const [a, b] = await Promise.all([dealCards(vault, ALICE, { topics: ['history'] }), dealCards(vault, ALICE, { topics: ['history'] })]);
    assert.deepEqual([a.statusCode, b.statusCode].sort(), [200, 409]);
    assert.equal([a, b].find(r => r.statusCode === 409).body.code, 'DEAL_IN_PROGRESS');
    assert.equal((await liveCards(sql, ALICE)).length, 5);
  },

  async broken_feeds_fall_back_to_the_evergreen_list() {
    const { sql, vault } = await setup({ failing: 'all' });
    const res = await dealCards(vault, ALICE, { topics: ['health'] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const learnings = (await liveCards(sql, ALICE)).filter(c => c.type === 'learning');
    assert.equal(learnings.length, 4);
    assert.ok(learnings.every(c => EVERGREEN.some(e => e.url === c.url)));
    const healthFirst = learnings.filter(c => EVERGREEN.find(e => e.url === c.url).topic === 'health').length;
    assert.equal(healthFirst, EVERGREEN.filter(e => e.topic === 'health').length, 'evergreen picks favour the chosen topic');
    const errors = await sql`select count(*)::int as n from surprise_sources where last_error is not null`;
    assert.equal(errors[0].n, SOURCES.length);
  },

  async one_broken_feed_does_not_stop_the_others_and_the_pool_refreshes_at_most_twice_a_day() {
    const { sql, vault, calls } = await setup({ failing: ['yt:veritasium'] });
    await status(vault, ALICE);
    await status(vault, BOB);
    assert.equal(calls.length, SOURCES.length, 'the pool refreshed more than once');
    const [{ n: pooled }] = await sql`select count(*)::int as n from surprise_pool`;
    assert.equal(pooled, (SOURCES.length - 1) * 3, 'only fresh, non-Short items from working feeds are pooled');
    const [broken] = await sql`select last_error, ok_at from surprise_sources where id = 'yt:veritasium'`;
    assert.match(broken.last_error, /503/);
    assert.equal(broken.ok_at, null);
    // Twelve hours later every source is fetched again, without duplicating items.
    await sql`update surprise_sources set checked_at = now() - interval '13 hours'`;
    await status(vault, ALICE);
    assert.equal(calls.length, SOURCES.length * 2);
    assert.equal((await sql`select count(*)::int as n from surprise_pool`)[0].n, pooled);
  },

  async deals_stop_at_the_card_limit() {
    const { sql, vault } = await setup();
    const res = await dealCards(vault, ALICE, { topics: ['ai'] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.dealt, 3);
    await sql`insert into feed_state (user_email, item_type, item_id, liked_at) select ${ALICE}, item_type, item_id, now() from surprise_deals where user_email = ${ALICE}`;
    await allowNextDeal(sql, ALICE);
    const full = await dealCards(vault, ALICE);
    assert.equal(full.statusCode, 409);
    assert.equal(full.body.code, 'CARD_LIMIT');
    assert.equal((await liveCards(sql, ALICE)).length, 3);
  },

  async bad_requests_are_refused() {
    const { sql, vault } = await setup();
    assert.equal((await status(vault, null)).statusCode, 401);
    assert.equal((await dealCards(vault, null, { topics: ['ai'] })).statusCode, 401);
    const bad = await dealCards(vault, ALICE, { topics: 'ai' });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.code, 'INVALID_TOPICS');
    assert.equal((await liveCards(sql, ALICE)).length, 0);
  },

  async when_everything_has_been_dealt_nothing_is_removed() {
    const { sql, vault } = await setup();
    const first = await dealCards(vault, ALICE, { topics: ['ai'] });
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    const pool = await sql`select key from surprise_pool`;
    const everyKey = [...pool.map(p => p.key), ...EVERGREEN.map(e => e.key), ...CHALLENGES.map(c => c.key)];
    for (const key of everyKey) {
      await sql`insert into surprise_deals (user_email, deal_id, item_key, item_type, item_id, settled_at, outcome) values (${ALICE}, gen_random_uuid(), ${key}, 'learning', gen_random_uuid(), now() - interval '2 days', 'expired') on conflict do nothing`;
    }
    await sql`update surprise_deals set dealt_at = now() - interval '2 days' where settled_at is not null`;
    await allowNextDeal(sql, ALICE);
    assert.equal((await status(vault, ALICE)).body.unseen, 0);
    const res = await dealCards(vault, ALICE);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'NOTHING_LEFT');
    assert.equal((await liveCards(sql, ALICE)).length, 5, 'a refused deal removes nothing');
  },

  async before_the_migration_deal_me_5_switches_itself_off() {
    const { sql, vault, feed } = await setup();
    await sql`alter table users drop column interests`;
    const res = await status(vault, ALICE);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.available, false);
    assert.equal((await dealCards(vault, ALICE, { topics: ['ai'] })).statusCode, 503);
    assert.equal((await openFeed(feed, ALICE)).statusCode, 200, 'the feed must still open');
  },
};

require('./scenario_runner').runScenario(scenarios);
