// What Claude and ChatGPT ran into driving Cardlake's MCP tools (the 2026-10-02
// bug bash): dates, links, checklists, Misc card nesting, pins and snoozes on
// finished cards, list_feed's filters and cursors. Driven through the real MCP
// server and SDK client against PGlite, as in mcp_scenarios.js.
// Invoked by test_card_inputs.py as `node tests/unit/card_input_scenarios.js <name>`.
process.env.SESSION_SECRET = 'card-input-scenarios-secret';
process.env.DATABASE_URL = 'postgres://unused-in-tests';
require('./pg_harness').allowAccounts('alice@example.test,bob@example.test');

const assert = require('assert/strict');
const { createTestDb } = require('./pg_harness');
const db = require('../../api/_lib/db');

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const DAY = 864e5;

async function setup() {
  const testDb = await createTestDb();
  db.getSql = () => testDb.sql;
  return testDb;
}

async function connect(tenant) {
  const { createMcpServer } = require('../../api/_lib/mcp-server');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = await createMcpServer(tenant);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'cardle-test', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const tools = (await client.listTools()).tools;
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  return { client, tools, call };
}

function data(result) {
  assert.ok(!result.isError, result.content?.[0]?.text);
  return result.structuredContent;
}

function refused(result, pattern) {
  assert.equal(result.isError, true, `expected an error, got ${result.content?.[0]?.text}`);
  if (pattern) assert.match(result.content[0].text, pattern);
  return result.content[0].text;
}

const scenarios = {
  // Only unambiguous dates are stored, and refusals say what to send instead.
  async dates_are_unambiguous_or_refused() {
    await setup();
    const { call } = await connect(ALICE);
    let n = 0;
    const create = due_date => call('create_reminder', { title: `Dentist ${n += 1}`, due_date });

    refused(await create('tomorrow'), /Invalid due_date: use a date like 2026-10-05/);
    refused(await create('2026-02-30'), /not a real calendar date/);
    refused(await create('2026-13-01'), /not a real calendar date/);
    refused(await create('0'), /Invalid due_date/);
    refused(await create('10/05/2026'), /Invalid due_date/);
    refused(await create('2026-10-05T25:00:00Z'), /not a real date and time/);
    const noZone = refused(await create('2026-10-05T09:00:00'), /no time zone/);
    assert.doesNotMatch(noZone, /RangeError|Invalid time value/);

    assert.equal(data(await create('2026-10-05')).due_date, '2026-10-05T00:00:00.000Z');
    assert.equal(data(await create('2026-10-05T09:00:00+05:30')).due_date, '2026-10-05T03:30:00.000Z');
    assert.equal(data(await create('2026-10-05T09:00:00Z')).due_date, '2026-10-05T09:00:00.000Z');
    assert.equal(data(await create('2028-02-29')).due_date, '2028-02-29T00:00:00.000Z');
  },

  // update_reminder can remove a due date (null), and the card shows it so
  // no reader can misread it. There is no reminder time: Cardlake sends no
  // notifications, so the tools neither offer nor return one.
  async reminder_dates_can_be_cleared_and_are_shown_plainly() {
    await setup();
    const { call, tools } = await connect(ALICE);
    for (const name of ['create_reminder', 'update_reminder']) {
      assert.ok(!('remind_at' in tools.find(tool => tool.name === name).inputSchema.properties), `${name} offers remind_at`);
    }
    const id = data(await call('create_reminder', { title: 'Call mom', due_date: '2026-10-03T09:00:00+05:30' })).id;

    const card = data(await call('get_card', { card_type: 'reminder', card_id: id })).card;
    assert.ok(!('remind_at' in card.metadata));
    assert.equal(card.subtitle, 'Due 3 Oct 2026, 03:30 UTC');

    const dayOnly = data(await call('create_reminder', { title: 'Renew passport', due_date: '2026-03-02' })).id;
    assert.equal(data(await call('get_card', { card_type: 'reminder', card_id: dayOnly })).card.subtitle, 'Due 2 Mar 2026');

    const cleared = data(await call('update_reminder', { id, due_date: null }));
    assert.equal(cleared.due_date, null);
    assert.ok(!('remind_at' in cleared));
    assert.equal(data(await call('get_card', { card_type: 'reminder', card_id: id })).card.subtitle, 'No due date');
  },

  // Titles that are only spaces are refused for learnings as for every other
  // card, and only web links are saved -- javascript: in any disguise is not.
  async learning_titles_and_links_are_checked() {
    await setup();
    const { call } = await connect(ALICE);
    let n = 0;
    const learning = extra => call('create_learning', { title: `Read this ${n += 1}`, status: 'saved', category: 'ai', ...extra });
    const bookmark = url => call('create_bookmark', { title: `Link ${n += 1}`, url });

    refused(await learning({ title: '   ' }), /title is required/);
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', 'java\tscript:alert(1)', '\u0001javascript:alert(1)', 'javascript:0/alert(1)', 'data:text/html,<script>alert(1)</script>']) {
      refused(await learning({ url }), /Invalid url/);
      refused(await bookmark(url), /Invalid url/);
    }
    for (const url of ['https://example.test/a', 'http://example.test', 'example.test/path', 'localhost:3000/x', 'example.test:8080/x']) {
      assert.equal(data(await learning({ url })).url, url);
      assert.equal(data(await bookmark(url)).url, url);
    }

    const id = data(await learning({})).id;
    refused(await call('update_learning', { id, title: '  ' }), /title is required/);
    refused(await call('update_learning', { id, url: 'javascript:alert(1)' }), /Invalid url/);
    assert.equal(data(await call('update_learning', { id, title: '  Trimmed  ' })).title, 'Trimmed');
  },

  // A linked card's subtitle is the site it links to, never the raw URL, for
  // cards saved before this change too (the subtitle is worked out on read).
  async link_subtitles_name_the_site_not_the_url() {
    await setup();
    const { call } = await connect(ALICE);
    let n = 0;
    const extra = type => (type === 'learning' ? { status: 'saved', category: 'ai' } : {});
    const subtitle = async (type, url) => {
      const id = data(await call(`create_${type}`, { title: `Linked ${n += 1}`, url, ...extra(type) })).id;
      return data(await call('get_card', { card_type: type, card_id: id })).card.subtitle;
    };
    assert.equal(await subtitle('learning', 'https://www.youtube.com/watch?v=HD8NPXRNPUO'), 'youtube.com');
    assert.equal(await subtitle('learning', 'https://simonwillison.net/2026/Oct/3/default-hard-budget-caps/'), 'simonwillison.net');
    assert.equal(await subtitle('bookmark', 'https://m.example.test/a?b=c'), 'example.test');
    assert.equal(await subtitle('bookmark', 'example.test/path'), 'example.test');
    assert.equal(await subtitle('learning', 'localhost:3000/x'), 'localhost');
    assert.equal(data(await call('get_card', { card_type: 'learning', card_id: data(await call('create_learning', { title: 'No link', ...extra('learning') })).id })).card.subtitle, '');
  },

  // A checklist holds real entries: blank ones are dropped, and the Work
  // tab's plain lines become entries that keep the ticks already on the card.
  async checklists_hold_real_entries_and_keep_their_ticks() {
    const { sql } = await setup();
    const { call } = await connect(ALICE);
    const created = data(await call('create_work_item', { title: 'Ship it', items: [{ text: '' }, { text: '   ' }, { text: ' Tests ', completed: true }, { text: 'Deploy' }] }));
    assert.deepEqual(created.items, [{ text: 'Tests', completed: true }, { text: 'Deploy', completed: false }]);

    // The Work tab saves the textarea as one string per line.
    const { validate } = require('../../api/_lib/resources');
    const configs = require('../../api/_lib/resource-configs');
    const values = validate({ title: 'Ship it', items: ['Tests', 'Deploy', 'Announce', ''] }, configs.work, false);
    const [row] = await configs.work.update(sql, ALICE, created.id, values);
    assert.deepEqual(row.items, [{ text: 'Tests', completed: true }, { text: 'Deploy', completed: false }, { text: 'Announce', completed: false }]);

    const card = data(await call('get_card', { card_type: 'work', card_id: created.id })).card;
    assert.equal(card.subtitle, '1/3 items done');
  },

  // A Misc card nests only under another of the same account's Misc cards,
  // never under itself or its own descendants, and can be un-nested.
  async misc_cards_nest_only_under_their_own_cards() {
    await setup();
    const { call } = await connect(ALICE);
    const bob = await connect(BOB);
    const misc = (title, subsection_of) => call('create_talking_point', { section_title: title, content: 'text', ...(subsection_of ? { subsection_of } : {}) });
    const top = data(await misc('Top')).id;
    const child = data(await misc('Child', top)).id;
    const bobsCard = data(await bob.call('create_talking_point', { section_title: 'Bob', content: 'private' })).id;

    const missing = refused(await misc('Orphan', '11111111-1111-4111-8111-111111111111'), /Invalid subsection_of/);
    const foreign = refused(await misc('Probe', bobsCard), /Invalid subsection_of/);
    assert.equal(missing, foreign, "another account's card looks exactly like a missing one");
    assert.doesNotMatch(missing, /foreign key|violates/);

    refused(await call('update_talking_point', { id: top, subsection_of: top }), /Invalid subsection_of/);
    refused(await call('update_talking_point', { id: top, subsection_of: child }), /Invalid subsection_of/);

    assert.equal(data(await call('update_talking_point', { id: child, subsection_of: null })).subsection_of, null);
  },

  // A pin on a card that has since been finished doesn't hold a slot, and a
  // finished card can't be pinned or snoozed: it isn't in the feed.
  async finished_cards_hold_no_pin_slot_and_cannot_be_pinned_or_snoozed() {
    await setup();
    const { call } = await connect(ALICE);
    const reminder = async title => data(await call('create_reminder', { title })).id;
    const [a, b, c, d] = [await reminder('A'), await reminder('B'), await reminder('C'), await reminder('D')];
    for (const id of [a, b, c]) data(await call('pin_card', { card_type: 'reminder', card_id: id }));
    refused(await call('pin_card', { card_type: 'reminder', card_id: d }), /only pin up to 3/);

    data(await call('update_reminder', { id: c, completed: true }));
    const stats = data(await call('list_feed', {})).stats;
    assert.equal(stats.pinned_cards, 2);
    data(await call('pin_card', { card_type: 'reminder', card_id: d }));

    refused(await call('pin_card', { card_type: 'reminder', card_id: c }), /finished/);
    refused(await call('snooze_card', { card_type: 'reminder', card_id: c }), /finished/);
    const learning = data(await call('create_learning', { title: 'Watched', status: 'watched', category: 'ai' })).id;
    refused(await call('snooze_card', { card_type: 'learning', card_id: learning }), /finished/);
  },

  // snooze_card takes a number of days; one day by default.
  async snooze_takes_a_number_of_days() {
    await setup();
    const { tools, call } = await connect(ALICE);
    assert.ok(tools.find(tool => tool.name === 'snooze_card').inputSchema.properties.days);
    const id = data(await call('create_reminder', { title: 'Later' })).id;
    const until = async args => new Date(data(await call('snooze_card', { card_type: 'reminder', card_id: id, ...args })).snoozed_until).getTime() - Date.now();

    const week = await until({ days: 7 });
    assert.ok(Math.abs(week - 7 * DAY) < 60e3, `snoozed for ${week / DAY} days`);
    const oneDay = await until({});
    assert.ok(Math.abs(oneDay - DAY) < 60e3, `snoozed for ${oneDay / DAY} days`);
    refused(await call('snooze_card', { card_type: 'reminder', card_id: id, days: 0 }));
  },

  // Created already done, a repeating reminder moves to its next occurrence
  // and is snoozed until then, as completing it later would.
  async a_repeating_reminder_created_done_moves_to_its_next_occurrence() {
    await setup();
    const { call } = await connect(ALICE);
    const created = data(await call('create_reminder', { title: 'Water plants', due_date: '2026-01-01', recurrence: 'daily', completed: true }));
    assert.equal(created.completed, false);
    assert.ok(new Date(created.due_date) > new Date(), 'moved to a future occurrence');
    const card = data(await call('get_card', { card_type: 'reminder', card_id: created.id })).card;
    assert.equal(new Date(card.remind_later_until).getTime(), new Date(created.due_date).getTime());

    const oneOff = data(await call('create_reminder', { title: 'Done already', completed: true }));
    assert.equal(oneOff.completed, true, 'a one-off reminder stays completed');
  },

  // list_feed's filters ignore case, and a value that can never match is an
  // error naming the real ones rather than an empty feed.
  async list_feed_filters_ignore_case_and_refuse_unknown_values() {
    await setup();
    const { call } = await connect(ALICE);
    const id = data(await call('create_learning', { title: 'Agents', status: 'saved', category: 'ai' })).id;

    assert.deepEqual(data(await call('list_feed', { category: 'AI' })).cards.map(card => card.id), [id]);
    assert.deepEqual(data(await call('list_feed', { status: 'Saved' })).cards.map(card => card.id), [id]);
    refused(await call('list_feed', { category: 'nonsense' }), /Invalid category "nonsense": use one of ai, others, tech/);
    refused(await call('list_feed', { status: 'open' }), /Invalid status "open": use one of saved/);
  },

  // A cursor must be a next_cursor Cardlake returned; anything else is an
  // error rather than a silent restart at page one.
  async made_up_cursors_are_refused() {
    await setup();
    const { call } = await connect(ALICE);
    for (let i = 0; i < 3; i += 1) data(await call('create_reminder', { title: `Note ${i}` }));

    const first = data(await call('list_feed', { limit: 2 }));
    assert.ok(first.next_cursor);
    assert.equal(data(await call('list_feed', { limit: 2, cursor: first.next_cursor })).cards.length, 1);
    const search = data(await call('search_cards', { query: 'note', limit: 2 }));
    assert.equal(data(await call('search_cards', { query: 'note', limit: 2, cursor: search.next_cursor })).cards.length, 1);

    for (const cursor of ['not-a-real-cursor', 'page2', Buffer.from('{"offset":-1}').toString('base64url')]) {
      refused(await call('list_feed', { cursor }), /Invalid cursor/);
      refused(await call('search_cards', { query: 'note', cursor }), /Invalid cursor/);
    }
  },

  // Every tool's title is in Title Case, as clients list them; descriptions
  // say what the results really contain.
  async tool_titles_and_descriptions_match_the_results() {
    await setup();
    const { tools } = await connect(ALICE);
    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} has a title`);
      for (const word of tool.title.split(' ')) assert.match(word, /^[A-Z]/, `${tool.name} title "${tool.title}"`);
    }
    assert.equal(tools.find(tool => tool.name === 'snooze_card').title, 'Snooze Card');
    assert.match(tools.find(tool => tool.name === 'get_dashboard_stats').description, /include finished cards/);
  },

  // A duplicate title is explained, not reported as a Postgres constraint.
  async duplicate_titles_are_explained() {
    await setup();
    const { call } = await connect(ALICE);
    data(await call('create_reminder', { title: 'Pay rent' }));
    const text = refused(await call('create_reminder', { title: 'Pay rent' }), /already exists.*search_cards/);
    assert.doesNotMatch(text, /constraint|duplicate key/);
  },

  // ChatGPT gets an explicit, empty content security policy for the card
  // widget, so it runs locked down instead of with "CSP off".
  async chatgpt_widget_declares_a_locked_down_csp() {
    await setup();
    const { client } = await connect(ALICE);
    const { contents } = await client.readResource({ uri: 'ui://cardle/cards-openai.html' });
    assert.deepEqual(contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    assert.deepEqual(contents[0]._meta['openai/widgetCSP'], { connect_domains: [], resource_domains: [] });
    const listed = (await client.listResources()).resources.find(resource => resource.uri === 'ui://cardle/cards-openai.html');
    assert.deepEqual(listed._meta['openai/widgetCSP'], { connect_domains: [], resource_domains: [] });
  },
};

const name = process.argv[2];
if (!scenarios[name]) {
  console.error(`Unknown scenario "${name}". Known: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}
scenarios[name]().then(() => process.exit(0), error => { console.error(error.stack || error); process.exit(1); });
