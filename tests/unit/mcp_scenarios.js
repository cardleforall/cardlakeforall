// What MCP tool calls return, driven through the real server (createMcpServer)
// and SDK client over an in-memory transport, against real Postgres (PGlite,
// see pg_harness.js). Going through the SDK matters: it validates each
// result's structuredContent against the tool's outputSchema and turns a
// mismatch into an error result, which handler-level tests never see.
// Invoked by test_mcp_tool_results.py as `node tests/unit/mcp_scenarios.js <name>`.
process.env.SESSION_SECRET = 'mcp-scenarios-secret';
process.env.DATABASE_URL = 'postgres://unused-in-tests';
require('./pg_harness').allowAccounts('alice@example.test,bob@example.test');

const assert = require('assert/strict');
const { createTestDb } = require('./pg_harness');
const db = require('../../api/_lib/db');
const { setSessionCookie } = require('../../api/_lib/auth');

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const SHARED = 'default';
const MISSING = '00000000-0000-4000-8000-000000000000';

// mcp-tools destructures getSql at require time, so point it at the test
// database before anything loads it.
async function setup() {
  const testDb = await createTestDb();
  db.getSql = () => testDb.sql;
  return testDb;
}

async function connect(tenant, scopes) {
  const { createMcpServer } = require('../../api/_lib/mcp-server');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = await createMcpServer(tenant, scopes);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cardle-test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  // The client checks structuredContent against the schemas it listed, as
  // Claude and ChatGPT do, on top of the server's own check.
  const tools = (await client.listTools()).tools;
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return { client, tools, call };
}

function sessionCookie(email) {
  let header = '';
  setSessionCookie({ setHeader: (_, value) => { header = value; } }, { email });
  return header.split(';')[0];
}

async function callHandler(handler, tenant, body, method = 'POST') {
  const req = { method, headers: { cookie: sessionCookie(tenant) }, query: {}, body };
  const res = { code: null, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  await handler(req, res);
  return res;
}

function stubGithub(repos) {
  global.fetch = async url => {
    const match = /repos\/([^/]+)\/([^/?]+)(\/issues)?/.exec(url);
    const issues = match && repos[`${match[1]}/${match[2]}`];
    if (!issues) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (match[3] ? issues : { full_name: `${match[1]}/${match[2]}` }) };
  };
}

const issue = (number, title, extra = {}) => ({ number, title, body: '', state: 'open', assignees: [], labels: [], html_url: `https://github.test/${number}`, ...extra });

function data(result) {
  assert.ok(!result.isError, result.content?.[0]?.text);
  assert.ok(result.structuredContent, `no structuredContent in ${result.content?.[0]?.text}`);
  return result.structuredContent;
}

// An account holding every card type, with pinned, liked and snoozed cards,
// a standalone file and a GitHub issue synced from a connected repository.
async function seedFullAccount(sql, tenant, call) {
  const ids = {};
  ids.reminder = data(await call('create_reminder', { title: 'Call the dentist', due_date: '2026-10-01' })).id;
  ids.learning = data(await call('create_learning', { title: 'An article', url: 'https://example.test/a', status: 'saved', category: 'ai' })).id;
  ids.work = data(await call('create_work_item', { title: 'Ship it', items: [{ text: 'Tests', completed: true }, { text: 'Deploy' }] })).id;
  ids.family = data(await call('create_family_update', { person: 'Sam', content: 'Started school' })).id;
  ids.bookmark = data(await call('create_bookmark', { title: 'Docs', url: 'https://example.test/docs', category: 'tech' })).id;
  ids.talking_point = data(await call('create_talking_point', { section_title: 'Roadmap', content: 'Q4 goals' })).id;
  ids.file = (await sql`insert into files (user_email, name, mime_type, byte_size, blob_url) values (${tenant}, 'notes.pdf', 'application/pdf', 2048, 'https://blob.test/notes.pdf') returning id`)[0].id;

  stubGithub({ 'alice/app': [issue(1, 'From GitHub', { labels: [{ name: 'bug' }] }), issue(2, 'Closed one', { state: 'closed' })] });
  const handlers = require('../../api/_lib/integration-handlers');
  const connected = await callHandler(handlers.githubConnection, tenant, { token: 'github_pat_test', repo: 'alice/app' });
  assert.equal(connected.code, 200, JSON.stringify(connected.body));
  ids.sync = await call('sync_github_issues');
  ids.kanban = (await sql`select id from kanban_items where user_email = ${tenant} and external_source = 'github' and title = 'From GitHub'`)[0].id;

  ids.pin = await call('pin_card', { card_type: 'reminder', card_id: ids.reminder });
  ids.like = await call('like_card', { card_type: 'kanban', card_id: ids.kanban });
  ids.snooze = await call('snooze_card', { card_type: 'bookmark', card_id: ids.bookmark });
  return ids;
}

const OUTPUT_VALIDATION = /Output validation error|structured content/i;

const scenarios = {
  // AC 1: every successful call, of every kind of tool, carries the same data
  // twice -- as text for older clients, and as structuredContent.
  async every_successful_result_carries_matching_structured_content() {
    const { sql } = await setup();
    const { call } = await connect(ALICE);
    const results = [];
    const record = async (name, args) => { const result = await call(name, args); results.push([name, result]); return result; };

    const ids = await seedFullAccount(sql, ALICE, record);
    results.push(['sync_github_issues', ids.sync], ['pin_card', ids.pin], ['like_card', ids.like], ['snooze_card', ids.snooze]);
    await record('list_feed', {});
    await record('list_feed', { view: 'snoozed' });
    await record('get_dashboard_stats');
    await record('get_account');
    await record('list_integrations');
    await record('update_reminder', { id: ids.reminder, completed: true });
    await record('update_learning', { id: ids.learning, status: 'watched' });
    await record('update_work_item', { id: ids.work, items: [{ text: 'Tests', completed: true }] });
    await record('update_family_update', { id: ids.family, content: 'Loves school' });
    await record('update_bookmark', { id: ids.bookmark, notes: 'Read later' });
    await record('update_talking_point', { id: ids.talking_point, content: 'Q1 goals' });
    await record('unsnooze_card', { card_type: 'bookmark', card_id: ids.bookmark });
    await record('unpin_card', { card_type: 'reminder', card_id: ids.reminder });
    await record('unlike_card', { card_type: 'kanban', card_id: ids.kanban });
    await record('delete_reminder', { id: ids.reminder });
    await record('delete_learning', { id: ids.learning });

    for (const [name, result] of results) {
      assert.ok(!result.isError, `${name} failed: ${result.content?.[0]?.text}`);
      assert.equal(result.content[0].type, 'text', name);
      assert.ok(result.structuredContent && typeof result.structuredContent === 'object', `${name} has no structuredContent`);
      assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text), `${name}: structuredContent differs from its text`);
    }
    // Dates arrive as the ISO strings the text shows, not as Date objects.
    const created = results.find(([name]) => name === 'create_reminder')[1].structuredContent;
    assert.equal(typeof created.created_at, 'string');
  },

  // AC 2: failures stay plain-text errors, with nothing structured to misread.
  async failed_results_have_no_structured_content() {
    const { sql } = await setup();
    const { call } = await connect(ALICE);
    const reminders = [];
    for (const title of ['One', 'Two', 'Three', 'Four']) reminders.push(data(await call('create_reminder', { title })).id);
    for (const id of reminders.slice(0, 3)) data(await call('pin_card', { card_type: 'reminder', card_id: id }));

    const failures = {
      fourth_pin: await call('pin_card', { card_type: 'reminder', card_id: reminders[3] }),
      unknown_card: await call('snooze_card', { card_type: 'reminder', card_id: MISSING }),
      unknown_delete: await call('delete_bookmark', { id: MISSING }),
      unknown_update: await call('update_reminder', { id: MISSING, title: 'Nope' }),
      github_not_connected: await call('sync_github_issues'),
    };
    for (const [label, result] of Object.entries(failures)) {
      assert.equal(result.isError, true, `${label} should fail`);
      assert.equal(result.structuredContent, undefined, `${label} carries structuredContent`);
      assert.match(result.content[0].text, /^Error: /, label);
      assert.doesNotMatch(result.content[0].text, OUTPUT_VALIDATION, label);
    }
    assert.match(failures.fourth_pin.content[0].text, /pin up to 3/);
    assert.equal((await sql`select count(*)::int as n from feed_state where pinned_at is not null`)[0].n, 3);
  },

  // AC 4: each declared output schema accepts what the tool really returns,
  // for a full account, an empty one, and the shared MCP_TOKEN tenant. A
  // schema that is too strict would turn a working tool into an error.
  async output_schemas_accept_real_results() {
    const { sql } = await setup();
    const checkAll = async (label, tenant, { seed = false } = {}) => {
      const { tools, call } = await connect(tenant);
      const withSchema = new Set(tools.filter(tool => tool.outputSchema).map(tool => tool.name));
      assert.ok(withSchema.size > 0, 'no tool declares an output schema');
      const checked = new Set();
      const check = async (name, args) => {
        const result = await call(name, args);
        assert.ok(!result.isError, `${label} ${name}: ${result.content?.[0]?.text}`);
        assert.ok(result.structuredContent, `${label} ${name} has no structuredContent`);
        checked.add(name);
        return result.structuredContent;
      };

      let ids = null;
      if (seed) {
        ids = await seedFullAccount(sql, tenant, call);
        for (const [name, result] of [['sync_github_issues', ids.sync], ['pin_card', ids.pin], ['like_card', ids.like], ['snooze_card', ids.snooze]]) {
          assert.ok(!result.isError, `${label} ${name}: ${result.content?.[0]?.text}`);
          checked.add(name);
        }
      }
      const feed = await check('list_feed', {});
      await check('list_feed', { view: 'snoozed' });
      await check('list_feed', { liked_only: true, limit: 1 });
      await check('get_dashboard_stats');
      await check('get_account');
      await check('list_integrations');
      if (!seed) {
        assert.deepEqual(await check('search_cards', { query: 'anything' }), { cards: [], next_cursor: null, total: 0 });
        return { feed, checked, withSchema };
      }

      assert.ok(feed.cards.length >= 7, `expected every card type in the feed, got ${feed.cards.map(c => c.type)}`);
      assert.ok(feed.next_cursor === null || typeof feed.next_cursor === 'string');
      await check('list_feed', { types: ['kanban'], status: 'backlog' });
      assert.ok((await check('search_cards', { query: 'e' })).total >= 7);
      for (const card of feed.cards) await check('get_card', { card_type: card.type, card_id: card.id });
      await check('list_feed', { limit: 2 });
      await check('unsnooze_card', { card_type: 'bookmark', card_id: ids.bookmark });
      await check('unpin_card', { card_type: 'reminder', card_id: ids.reminder });
      await check('unlike_card', { card_type: 'kanban', card_id: ids.kanban });
      for (const name of ['reminder', 'work_item', 'family_update', 'bookmark', 'talking_point']) {
        const cardType = { reminder: 'reminder', work_item: 'work', family_update: 'family', bookmark: 'bookmark', talking_point: 'talking_point' }[name];
        await check(`delete_${name}`, { id: ids[cardType] });
      }
      await check('delete_learning', { id: ids.learning });
      const missed = [...withSchema].filter(name => !checked.has(name));
      assert.deepEqual(missed, [], `tools with an output schema that were never exercised: ${missed}`);
      return { feed, checked, withSchema };
    };

    await checkAll('full account', ALICE, { seed: true });
    const empty = await checkAll('empty account', BOB);
    assert.deepEqual(empty.feed.cards, []);
    assert.equal(empty.feed.next_cursor, null);
    const shared = await checkAll('shared tenant', SHARED);
    assert.deepEqual(shared.feed.cards, []);
    const account = data(await (await connect(SHARED)).call('get_account'));
    assert.deepEqual(account, { account_id: SHARED, email: null, display_name: null });
  },

  // AC 1: every word of the query must appear, in any order and case, across
  // every card type -- snoozed cards and synced GitHub issues included.
  async search_cards_finds_cards_by_their_words() {
    const { sql } = await setup();
    const { call } = await connect(ALICE);
    const ids = await seedFullAccount(sql, ALICE, call);
    await (await connect(BOB)).call('create_reminder', { title: 'Call the dentist for Bob' });
    const search = async args => data(await call('search_cards', args));
    const found = async query => (await search({ query })).cards.map(card => [card.type, card.id]);

    assert.deepEqual(await found('DENTIST call'), [['reminder', ids.reminder]]);
    assert.deepEqual(await found('article'), [['learning', ids.learning]]);
    assert.deepEqual(await found('ship it'), [['work', ids.work]]);
    assert.deepEqual(await found('school sam'), [['family', ids.family]]);
    assert.deepEqual(await found('roadmap'), [['talking_point', ids.talking_point]]);
    assert.deepEqual(await found('notes.pdf'), [['file', ids.file]]);
    const snoozed = (await search({ query: 'example.test/docs' })).cards;
    assert.deepEqual(snoozed.map(card => card.id), [ids.bookmark], 'snoozed cards are searched too');
    assert.ok(snoozed[0].remind_later_until, 'a snoozed card says so');
    assert.deepEqual(await found('bug'), [['kanban', ids.kanban]], 'GitHub issues match their labels');
    assert.deepEqual(await found('app#1'), [['kanban', ids.kanban]], 'and their issue number');

    // Finished cards leave the feed but are still found: they're what people
    // search for later.
    data(await call('update_reminder', { id: ids.reminder, completed: true }));
    assert.deepEqual(await found('dentist'), [['reminder', ids.reminder]]);
    assert.equal((await found('closed one')).length, 1, 'a closed GitHub issue is found');

    // Newest first, whatever the feed's rotation order.
    const older = data(await call('create_reminder', { title: 'Ordering older' })).id;
    const newer = data(await call('create_reminder', { title: 'Ordering newer' })).id;
    await sql`update reminders set created_at = now() - interval '2 days' where id = ${older}`;
    await sql`update reminders set created_at = now() - interval '1 day' where id = ${newer}`;
    assert.deepEqual((await search({ query: 'ordering' })).cards.map(card => card.id), [newer, older]);

    assert.deepEqual(await search({ query: 'nothing matches this' }), { cards: [], next_cursor: null, total: 0 });
  },

  // AC 3 and 4: filters, paging, totals, and queries that are rejected.
  async search_cards_filters_pages_and_validates() {
    await setup();
    const { call } = await connect(ALICE);
    for (let n = 1; n <= 5; n += 1) data(await call('create_reminder', { title: `Paging item ${n}` }));
    data(await call('create_bookmark', { title: 'Paging item bookmark' }));
    const search = async args => data(await call('search_cards', args));

    const reminders = await search({ query: 'paging item', types: ['reminder'] });
    assert.equal(reminders.total, 5);
    assert.ok(reminders.cards.every(card => card.type === 'reminder'));

    const seen = [];
    let page = await search({ query: 'paging item', limit: 2 });
    assert.equal(page.total, 6);
    assert.equal(page.cards.length, 2);
    for (let guard = 0; guard < 5; guard += 1) {
      seen.push(...page.cards.map(card => card.id));
      if (!page.next_cursor) break;
      page = await search({ query: 'paging item', limit: 2, cursor: page.next_cursor });
    }
    assert.equal(page.next_cursor, null);
    assert.equal(seen.length, 6);
    assert.equal(new Set(seen).size, 6, 'no card appears on two pages');
    assert.equal((await search({ query: 'paging' })).cards.length, 6, 'default page size is 10');

    for (const query of ['', '   ', 'x'.repeat(101)]) {
      const result = await call('search_cards', { query });
      assert.equal(result.isError, true, `query ${JSON.stringify(query.slice(0, 10))} should be rejected`);
      assert.equal(result.structuredContent, undefined);
    }
  },

  // AC 2: deleted cards, another account's cards, and GitHub issues once the
  // integration is disconnected never come back from search or get_card.
  async search_and_get_card_never_show_hidden_cards() {
    const { sql } = await setup();
    const { call } = await connect(ALICE);
    const ids = await seedFullAccount(sql, ALICE, call);
    data(await (await connect(BOB)).call('create_reminder', { title: 'Bob private dentist' }));
    const found = async query => data(await call('search_cards', { query })).cards.map(card => card.id);

    assert.deepEqual(await found('bob private'), []);
    data(await call('delete_reminder', { id: ids.reminder }));
    assert.deepEqual(await found('dentist'), []);

    assert.deepEqual(await found('from github'), [ids.kanban]);
    const handlers = require('../../api/_lib/integration-handlers');
    assert.equal((await callHandler(handlers.githubConnection, ALICE, undefined, 'DELETE')).code, 200);
    assert.deepEqual(await found('from github'), []);
    const gone = await call('get_card', { card_type: 'kanban', card_id: ids.kanban });
    assert.equal(gone.isError, true);
  },

  // Results carry what the assistant asked about and nothing else: no account
  // email, no internal row ids or bookkeeping (ChatGPT's app review asks for
  // "only data directly relevant to the user's request"). get_account is the
  // one tool whose job is to report the email.
  async results_carry_no_account_email_or_bookkeeping() {
    await setup();
    const { call } = await connect(ALICE);
    const BOOKKEEPING = ['user_email', 'sort_order', 'updated_at', 'deleted_at'];
    const checked = [];
    const clean = (name, value) => {
      const text = JSON.stringify(value);
      assert.ok(!text.includes(ALICE), `${name} returns the account email`);
      for (const field of BOOKKEEPING) assert.ok(!(field in value), `${name} returns ${field}`);
      checked.push(name);
      return value;
    };

    const created = {
      reminder: clean('create_reminder', data(await call('create_reminder', { title: 'Call the dentist', due_date: '2026-10-01' }))),
      learning: clean('create_learning', data(await call('create_learning', { title: 'Hooks', status: 'saved', category: 'ai' }))),
      work: clean('create_work_item', data(await call('create_work_item', { title: 'Ship', items: [{ text: 'Tests' }] }))),
      family: clean('create_family_update', data(await call('create_family_update', { person: 'Sam', content: 'School' }))),
      bookmark: clean('create_bookmark', data(await call('create_bookmark', { title: 'Docs', url: 'https://example.test' }))),
      talking_point: clean('create_talking_point', data(await call('create_talking_point', { section_title: 'Q4', content: 'Goals' }))),
    };
    // The card's own fields are all still there.
    assert.equal(created.reminder.title, 'Call the dentist');
    assert.ok(created.reminder.id && created.reminder.created_at);
    assert.deepEqual(created.work.items.map(item => item.text), ['Tests']);
    assert.equal(created.learning.status, 'saved');

    assert.equal(clean('update_reminder', data(await call('update_reminder', { id: created.reminder.id, completed: true }))).completed, true);
    assert.equal(clean('update_learning', data(await call('update_learning', { id: created.learning.id, status: 'watched' }))).status, 'watched');
    clean('update_work_item', data(await call('update_work_item', { id: created.work.id, title: 'Shipped' })));
    clean('update_family_update', data(await call('update_family_update', { id: created.family.id, content: 'Loves school' })));
    clean('update_bookmark', data(await call('update_bookmark', { id: created.bookmark.id, notes: 'Later' })));
    clean('update_talking_point', data(await call('update_talking_point', { id: created.talking_point.id, content: 'New goals' })));

    // A feed action says which card, and its pin / like / snooze state now.
    const card = { card_type: 'bookmark', card_id: created.bookmark.id };
    const shape = ['card_type', 'card_id', 'pinned_at', 'liked_at', 'snoozed_until'];
    const act = async (name, expect) => {
      const result = clean(name, data(await call(name, card)));
      assert.deepEqual(Object.keys(result).sort(), [...shape].sort(), `${name} result shape`);
      assert.equal(result.card_type, 'bookmark');
      assert.equal(result.card_id, created.bookmark.id);
      for (const [field, set] of Object.entries(expect)) assert.equal(!!result[field], set, `${name}: ${field}`);
    };
    await act('pin_card', { pinned_at: true });
    await act('like_card', { pinned_at: true, liked_at: true });
    await act('snooze_card', { liked_at: true, snoozed_until: true });
    await act('unsnooze_card', { snoozed_until: false });
    await act('unlike_card', { liked_at: false });
    await act('unpin_card', { pinned_at: false });

    assert.equal(checked.length, 18);

    // Cards read from the feed lose the app's row order and dismissed stamp,
    // but keep created_at and the pin / like / snooze fields.
    const INTERNAL = ['sort_order', 'dismissed_at'];
    const listed = data(await call('list_feed', {})).cards;
    const searched = data(await call('search_cards', { query: 'Docs' })).cards;
    const fetched = data(await call('get_card', { card_type: 'bookmark', card_id: created.bookmark.id })).card;
    assert.ok(listed.length > 0 && searched.length > 0, 'the cards were found');
    for (const card of [...listed, ...searched, fetched]) {
      for (const field of INTERNAL) assert.ok(!(field in card), `a read returns ${field}`);
      for (const field of ['id', 'type', 'title', 'created_at', 'pinned_at', 'liked_at', 'remind_later_until']) {
        assert.ok(field in card, `a read lost ${field}`);
      }
    }
    assert.equal(data(await call('get_account')).email, ALICE, 'get_account still reports the email');
  },

  // list_feed uses the app's AI order unless asked for date added, and says
  // which order it used.
  async list_feed_sorts_by_ai_unless_asked_for_newest() {
    const { sql } = await setup();
    const feed = require('../../api/feed');
    await sql`insert into reminders (user_email, title, due_date, created_at) values (${ALICE}, 'Overdue', now() - interval '1 day', now() - interval '20 days')`;
    await sql`insert into bookmarks (user_email, title, category, created_at) values (${ALICE}, 'Fresh', 'tech', now() - interval '1 hour')`;
    await sql`insert into learning_entries (user_email, title, status, category, created_at) values (${ALICE}, 'Middle', 'saved', 'ai', now() - interval '5 days')`;
    const { call, tools } = await connect(ALICE);
    assert.deepEqual(tools.find(tool => tool.name === 'list_feed').inputSchema.properties.sort.enum, ['ai', 'newest']);

    const byDefault = data(await call('list_feed', {}));
    assert.equal(byDefault.sort, 'ai');
    assert.equal(byDefault.cards[0].title, 'Overdue');
    assert.deepEqual(byDefault.cards.map(c => c.id), (await feed.buildFeedResponse(sql, ALICE, {})).cards.map(c => c.id), 'MCP and the app agree on the AI order');

    const newest = data(await call('list_feed', { sort: 'newest' }));
    assert.equal(newest.sort, 'newest');
    assert.deepEqual(newest.cards.map(c => c.title), ['Fresh', 'Middle', 'Overdue']);

    const bad = await call('list_feed', { sort: 'random' });
    assert.ok(bad.isError, 'an unknown sort is refused, not silently replaced');
  },

  // A file card links to Cardlake's own download route; the raw blob address
  // behind it never leaves the server -- not in the public feed API, and not
  // through any MCP read.
  async file_cards_never_expose_the_storage_url() {
    const { sql } = await setup();
    const blobUrl = 'https://abc123.private.blob.vercel-storage.com/notes-XYZ.pdf';
    const id = (await sql`insert into files (user_email, name, mime_type, byte_size, blob_url) values (${ALICE}, 'notes.pdf', 'application/pdf', 2048, ${blobUrl}) returning id`)[0].id;
    const feed = require('../../api/feed');
    const { call } = await connect(ALICE);

    const seen = {
      feed_api: (await feed.buildFeedResponse(sql, ALICE, {})).cards.find(card => card.id === id),
      list_feed: data(await call('list_feed', {})).cards.find(card => card.id === id),
      search_cards: data(await call('search_cards', { query: 'notes.pdf' })).cards[0],
      get_card: data(await call('get_card', { card_type: 'file', card_id: id })).card,
    };
    for (const [where, card] of Object.entries(seen)) {
      assert.ok(card, `${where} did not return the file card`);
      assert.equal(card.metadata.blob_url, `/api/feed?file_id=${id}`, where);
      assert.ok(!('storage_url' in card.metadata), `${where} exposes storage_url`);
      assert.ok(!JSON.stringify(card).includes('blob.vercel-storage'), `${where} exposes the blob address`);
    }
  },

  // AC 5: one card in full, with its attachments and feed state; every way
  // of not finding one gives the same answer.
  async get_card_returns_one_card_with_its_state() {
    const { sql } = await setup();
    const { call } = await connect(ALICE);
    const ids = await seedFullAccount(sql, ALICE, call);
    await sql`insert into attachments (user_email, parent_type, parent_id, name, mime_type, byte_size, blob_url) values (${ALICE}, 'work', ${ids.work}, 'plan.pdf', 'application/pdf', 1024, 'https://blob.test/plan.pdf')`;
    const get = async (card_type, card_id) => data(await call('get_card', { card_type, card_id })).card;

    const work = await get('work', ids.work);
    assert.equal(work.id, ids.work);
    assert.equal(work.title, 'Ship it');
    assert.deepEqual(work.metadata.items.map(item => item.text), ['Tests', 'Deploy']);
    assert.deepEqual(work.metadata.attachments.map(a => a.name), ['plan.pdf']);
    assert.ok((await get('reminder', ids.reminder)).pinned_at);
    assert.ok((await get('kanban', ids.kanban)).liked_at);
    assert.ok((await get('bookmark', ids.bookmark)).remind_later_until, 'snoozed cards can be read');

    const bobCard = data(await (await connect(BOB)).call('create_reminder', { title: 'Bob only' })).id;
    const deleted = data(await call('create_family_update', { person: 'Gone', content: 'Deleted soon' })).id;
    data(await call('delete_family_update', { id: deleted }));
    const misses = {
      unknown: ['reminder', MISSING],
      another_account: ['reminder', bobCard],
      deleted: ['family', deleted],
      wrong_type: ['bookmark', ids.reminder],
    };
    for (const [label, [card_type, card_id]] of Object.entries(misses)) {
      const result = await call('get_card', { card_type, card_id });
      assert.equal(result.isError, true, label);
      assert.equal(result.content[0].text, 'Error: Card not found', label);
      assert.equal(result.structuredContent, undefined, label);
    }
  },
  // Recurring reminders through MCP: the tools advertise the rule, store it,
  // and completing a recurring reminder rolls it forward instead of closing it.
  async reminder_tools_support_recurrence() {
    await setup();
    const { tools, call } = await connect(ALICE);
    for (const name of ['create_reminder', 'update_reminder']) {
      const recurrence = tools.find(tool => tool.name === name).inputSchema.properties.recurrence;
      assert.ok(recurrence, `${name} accepts recurrence`);
      assert.match(JSON.stringify(recurrence), /daily.*weekly.*monthly.*yearly/);
    }
    const created = data(await call('create_reminder', { title: 'Pay rent', due_date: '2099-01-31', recurrence: 'monthly' }));
    assert.equal(created.recurrence, 'monthly');
    const done = data(await call('update_reminder', { id: created.id, completed: true }));
    assert.equal(done.completed, false);
    assert.equal(new Date(done.due_date).toISOString(), '2099-02-28T00:00:00.000Z');
    const cleared = data(await call('update_reminder', { id: created.id, recurrence: 'none' }));
    assert.equal(cleared.recurrence, null);
    const rejected = await call('create_reminder', { title: 'Hourly', recurrence: 'hourly' });
    assert.equal(rejected.isError, true);
  },

  // Connected assistants call the MCP tools by name, and clients cache the
  // tool list (docs/MCP_SERVER.md, "Stability"). Removing or renaming a
  // tool, or making it require a new argument, breaks those callers, so this
  // fails until the change goes through a deprecation instead. Adding tools,
  // or optional arguments, is fine and needs no change here.
  async public_tools_keep_their_names_and_required_arguments() {
    await setup();
    const { tools } = await connect(ALICE);
    const listed = new Map(tools.map(tool => [tool.name, tool.inputSchema.required || []]));
    const PUBLIC_TOOLS = {
      create_bookmark: ['title'], create_family_update: ['content', 'person'],
      create_learning: ['category', 'status', 'title'], create_reminder: ['title'],
      create_talking_point: ['content', 'section_title'], create_work_item: ['title'],
      delete_bookmark: ['id'], delete_family_update: ['id'], delete_learning: ['id'],
      delete_reminder: ['id'], delete_talking_point: ['id'], delete_work_item: ['id'],
      get_account: [], get_card: ['card_id', 'card_type'], get_dashboard_stats: [],
      like_card: ['card_id', 'card_type'], list_feed: [], list_integrations: [],
      pin_card: ['card_id', 'card_type'], search_cards: ['query'],
      snooze_card: ['card_id', 'card_type'], sync_github_issues: [],
      unlike_card: ['card_id', 'card_type'], unpin_card: ['card_id', 'card_type'],
      unsnooze_card: ['card_id', 'card_type'],
      update_bookmark: ['id'], update_family_update: ['id'], update_learning: ['id'],
      update_reminder: ['id'], update_talking_point: ['id'], update_work_item: ['id'],
    };
    for (const [name, required] of Object.entries(PUBLIC_TOOLS)) {
      assert.ok(listed.has(name), `public tool ${name} was removed or renamed`);
      const added = listed.get(name).filter(arg => !required.includes(arg));
      assert.deepEqual(added, [], `${name} now requires ${added.join(', ')}; existing callers don't send it`);
    }
  },
};

require('./scenario_runner').runScenario(scenarios);
