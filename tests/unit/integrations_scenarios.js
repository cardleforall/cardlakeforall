// Behavioral checks for the integrations foundation, run against real Postgres
// (PGlite, see pg_harness.js) through the actual HTTP handlers. Invoked by
// test_integrations.py as `node tests/unit/integrations_scenarios.js <name>`;
// exits non-zero with a message on the first failed assertion.
process.env.SESSION_SECRET = 'integration-scenarios-secret';
process.env.DATABASE_URL = 'postgres://unused-in-tests';
// Integration writes re-check that the account is the owner. Alice and Bob
// stand in as tenants (pg_harness.js); Carol joins them when a scenario
// needs an owner who is then replaced.
require('./pg_harness').allowAccounts('alice@example.test,bob@example.test');

const assert = require('assert/strict');
const { createTestDb } = require('./pg_harness');
const db = require('../../api/_lib/db');
const { setSessionCookie } = require('../../api/_lib/auth');

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';

// Handlers destructure getSql at require time, so point it at the test
// database before loading anything that uses it.
async function setup(options) {
  const testDb = await createTestDb(options);
  db.getSql = () => testDb.sql;
  return {
    ...testDb,
    handlers: require('../../api/_lib/integration-handlers'),
    feed: require('../../api/feed'),
  };
}

// Who a request comes from: an account (a real signed session cookie minted
// by the auth code), the shared 'default' tenant (SHARED -- reached only with
// the sync token), or an anonymous visitor (null).
const SHARED = 'default';
const SYNC_TOKEN = 'scenario-sync-token';
process.env.SYNC_TOKEN = SYNC_TOKEN;
function sessionCookie(email) {
  let header = '';
  setSessionCookie({ setHeader: (_, value) => { header = value; } }, { email });
  return header.split(';')[0];
}

function request(tenant, { method = 'GET', body } = {}) {
  const headers = tenant === SHARED ? { 'x-sync-token': SYNC_TOKEN } : tenant ? { cookie: sessionCookie(tenant) } : {};
  return { method, headers, query: {}, body };
}

async function call(handler, req) {
  const res = { code: null, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
  await handler(req, res);
  return res;
}

// Minimal GitHub API: each "owner/repo" maps to its list of issues.
function stubGithub(repos) {
  global.fetch = async url => {
    const match = /repos\/([^/]+)\/([^/?]+)(\/issues)?/.exec(url);
    const issues = match && repos[`${match[1]}/${match[2]}`];
    if (!issues) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (match[3] ? issues : { full_name: `${match[1]}/${match[2]}` }) };
  };
}

const issue = (number, title, extra = {}) => ({ number, title, body: '', state: 'open', assignees: [], labels: [], html_url: `https://github.test/${number}`, ...extra });

async function liveGithubTitles(sql, tenant) {
  const rows = await sql`select title from kanban_items where user_email = ${tenant} and external_source = 'github' and deleted_at is null order by title`;
  return rows.map(row => row.title);
}

const scenarios = {
  // Every earlier shape of the GitHub connection becomes 'github_issues'
  // (keeping its onboarding), Cardlake-only board rows are removed while their
  // cards are kept, and re-running the migration changes nothing further.
  async migration_moves_github_connections_to_github_issues() {
    const { sql, applySchema } = await setup();
    const CAROL = 'carol@example.test';
    await sql`insert into integrations (user_email, provider, token, config, status, connected_at) values ('default', 'github', 'plain', '{"repo_owner":"o","repo_name":"r"}'::jsonb, 'connected', now() - interval '3 days')`;
    await sql`insert into integrations (user_email, provider, config, status, connected_at, onboarded_at) values (${ALICE}, 'kanban', '{"source":"github","repo_owner":"a","repo_name":"app"}'::jsonb, 'disconnected', now(), now())`;
    await sql`insert into integrations (user_email, provider, config, status, connected_at, onboarded_at) values (${BOB}, 'kanban', '{"source":"native"}'::jsonb, 'connected', now(), now())`;
    await sql`insert into integrations (user_email, provider, config, status, connected_at, onboarded_at) values (${CAROL}, 'github_issues', '{"repo_owner":"c","repo_name":"x"}'::jsonb, 'connected', now(), now())`;
    await sql`insert into kanban_items (user_email, title) values (${BOB}, 'Bob native card')`;
    await applySchema();

    const snapshot = async () => (await sql`select user_email, provider, config, status, onboarded_at is not null as onboarded from integrations order by user_email`)
      .map(r => [r.user_email, r.provider, r.config.source || null, r.status, r.onboarded]);
    // The shared 'default' tenant's connection is removed outright: that
    // tenant is public and never has integrations.
    const expected = [
      [ALICE, 'github_issues', null, 'disconnected', true],
      [CAROL, 'github_issues', null, 'connected', true],
    ];
    assert.deepEqual(await snapshot(), expected);
    assert.equal((await sql`select count(*)::int as n from kanban_items where user_email = ${BOB} and deleted_at is null`)[0].n, 1, 'native cards are kept');

    await applySchema();
    assert.deepEqual(await snapshot(), expected, 're-running the migration is a no-op');
  },

  // Two accounts syncing different repos -- and the same repo -- stay fully
  // isolated. Previously every account shared one 'default' connection, and a
  // sync soft-deleted every other account's GitHub cards.
  async github_sync_is_isolated_per_tenant() {
    const { sql, handlers } = await setup();
    stubGithub({ 'alice/app': [issue(1, 'Alice one'), issue(2, 'Alice two', { state: 'closed' })], 'bob/api': [issue(1, 'Bob one')] });

    for (const [tenant, repo] of [[ALICE, 'alice/app'], [BOB, 'bob/api']]) {
      const res = await call(handlers.githubConnection, request(tenant, { method: 'POST', body: { token: `github_pat_${tenant}`, repo } }));
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal(res.body.status, 'connected');
      assert.equal(res.body.repo, repo);
      assert.equal((await call(handlers.githubSync, request(tenant, { method: 'POST' }))).code, 200);
    }
    assert.deepEqual(await liveGithubTitles(sql, ALICE), ['Alice one', 'Alice two']);
    assert.deepEqual(await liveGithubTitles(sql, BOB), ['Bob one']);
    assert.equal((await sql`select status from kanban_items where title = 'Alice two'`)[0].status, 'done');

    // Re-syncing Alice after an issue disappears soft-deletes only hers.
    stubGithub({ 'alice/app': [issue(1, 'Alice one')], 'bob/api': [issue(1, 'Bob one')] });
    assert.equal((await call(handlers.githubSync, request(ALICE, { method: 'POST' }))).code, 200);
    assert.deepEqual(await liveGithubTitles(sql, ALICE), ['Alice one']);
    assert.deepEqual(await liveGithubTitles(sql, BOB), ['Bob one']);

    // Both accounts can sync the same repo; external ids no longer collide.
    stubGithub({ 'shared/repo': [issue(7, 'Shared seven')] });
    for (const tenant of [ALICE, BOB]) {
      await call(handlers.githubConnection, request(tenant, { method: 'POST', body: { token: 'github_pat_t', repo: 'shared/repo' } }));
      assert.equal((await call(handlers.githubSync, request(tenant, { method: 'POST' }))).code, 200);
      assert.deepEqual(await liveGithubTitles(sql, tenant), ['Shared seven']);
    }

    // Disconnecting Alice leaves Bob connected.
    await call(handlers.githubConnection, request(ALICE, { method: 'DELETE' }));
    assert.equal((await call(handlers.githubConnection, request(ALICE))).body.status, 'disconnected');
    assert.equal((await call(handlers.githubConnection, request(BOB))).body.status, 'connected');
  },

  async github_token_is_encrypted_at_rest_and_never_returned() {
    const { sql, handlers } = await setup();
    stubGithub({ 'o/r': [] });
    const res = await call(handlers.githubConnection, request(ALICE, { method: 'POST', body: { token: 'github_pat_supersecret', repo: 'o/r' } }));
    assert.equal(res.code, 200);
    assert.ok(!JSON.stringify(res.body).includes('github_pat_supersecret'), 'token must not be echoed back');
    const stored = (await sql`select token from integrations where user_email = ${ALICE}`)[0].token;
    assert.ok(stored.startsWith('v1:') && !stored.includes('github_pat_supersecret'), `stored token is not sealed: ${stored}`);

    // Sync decrypts it and sends it to GitHub as the bearer token.
    let sentAuth = null;
    global.fetch = async (url, options) => { sentAuth = options.headers.Authorization; return { ok: true, status: 200, json: async () => [] }; };
    assert.equal((await call(handlers.githubSync, request(ALICE, { method: 'POST' }))).code, 200);
    assert.equal(sentAuth, 'Bearer github_pat_supersecret');

    // A plaintext token saved before encryption existed is sealed on first use.
    await sql`update integrations set token = 'legacy_plain' where user_email = ${ALICE}`;
    assert.equal((await call(handlers.githubSync, request(ALICE, { method: 'POST' }))).code, 200);
    assert.equal(sentAuth, 'Bearer legacy_plain');
    assert.ok((await sql`select token from integrations where user_email = ${ALICE}`)[0].token.startsWith('v1:'));

    // A token sealed under a different key (SESSION_SECRET rotated) asks the
    // user to reconnect rather than failing opaquely.
    const { seal } = require('../../api/_lib/secret-box');
    process.env.SESSION_SECRET = 'rotated';
    const foreign = seal('x');
    process.env.SESSION_SECRET = 'integration-scenarios-secret';
    await sql`update integrations set token = ${foreign} where user_email = ${ALICE}`;
    const stale = await call(handlers.githubSync, request(ALICE, { method: 'POST' }));
    assert.equal(stale.code, 409);
    assert.equal(stale.body.code, 'INTEGRATION_RECONNECT_REQUIRED');
    assert.equal((await call(handlers.githubConnection, request(ALICE))).body.status, 'error');
  },

  async github_connect_rejects_malformed_repos_before_calling_github() {
    const { handlers } = await setup();
    let called = false;
    global.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
    for (const repo of ['noslash', 'a/b/c', '../x/y', 'o/r?x=1', 'o/r#frag', '']) {
      const res = await call(handlers.githubConnection, request(ALICE, { method: 'POST', body: { token: 'github_pat_t', repo } }));
      assert.equal(res.code, 400, repo);
    }
    assert.equal(called, false);
    const anon = await call(handlers.githubConnection, request(null, { method: 'POST', body: { token: 'github_pat_t', repo: 'o/r' } }));
    assert.equal(anon.code, 401);
  },

  // GitHub issues only reach the feed once GitHub Issues is connected, and
  // Cardlake-only Kanban cards never do; every other card type is unaffected.
  async feed_shows_github_issues_only_once_connected() {
    const { sql, feed, handlers } = await setup();
    await sql`insert into kanban_items (user_email, title, status) values (${ALICE}, 'Old native card', 'in_progress')`;
    await sql`insert into kanban_items (user_email, title, status, external_source, external_id, external_url) values (${ALICE}, 'Fix login', 'in_progress', 'github', 'acme/app#42', 'https://github.test/42')`;
    await sql`insert into reminders (user_email, title) values (${ALICE}, 'Call the bank')`;

    let res = await feed.buildFeedResponse(sql, ALICE, {});
    assert.deepEqual(res.cards.map(c => c.type), ['reminder']);
    assert.equal(res.stats.kanban_items, 0);
    const integration = res.integrations.find(i => i.id === 'github_issues');
    assert.equal(integration.name, 'GitHub Issues');
    assert.equal(integration.status, 'not_started');
    assert.equal(integration.card_count, 0);

    await sql`insert into integrations (user_email, provider, config, status, connected_at, onboarded_at) values (${ALICE}, 'github_issues', '{"repo_owner":"acme","repo_name":"app"}'::jsonb, 'connected', now(), now())`;
    res = await feed.buildFeedResponse(sql, ALICE, {});
    const kanbanCards = res.cards.filter(c => c.type === 'kanban');
    assert.deepEqual(kanbanCards.map(c => c.title), ['Fix login'], 'only the GitHub issue shows, never the native card');
    assert.equal(kanbanCards[0].integration, 'github_issues');
    assert.equal(kanbanCards[0].subtitle, 'acme/app#42, Assigned');
    assert.equal(kanbanCards[0].metadata.external_url, 'https://github.test/42');
    assert.equal(res.stats.kanban_items, 1);
    const live = res.integrations.find(i => i.id === 'github_issues');
    assert.equal(live.card_count, 1);
    assert.equal(live.acknowledged, false);
    assert.equal(live.repo, 'acme/app');
    assert.deepEqual((await feed.buildFeedResponse(sql, ALICE, { types: 'kanban' })).cards.map(c => c.title), ['Fix login']);

    // Onboarding is per tenant.
    await sql`insert into kanban_items (user_email, title, external_source, external_id) values (${BOB}, 'Bob issue', 'github', 'b/r#1')`;
    assert.equal((await feed.buildFeedResponse(sql, BOB, {})).cards.length, 0);

    // Disconnecting hides the issues again without deleting them.
    await sql`update integrations set status = 'disconnected' where user_email = ${ALICE}`;
    res = await feed.buildFeedResponse(sql, ALICE, {});
    assert.ok(!res.cards.some(c => c.type === 'kanban'));
    assert.equal((await sql`select count(*)::int as n from kanban_items where user_email = ${ALICE} and deleted_at is null`)[0].n, 2);

    // The list endpoint agrees with the feed payload.
    const list = await call(handlers.listIntegrations, request(ALICE));
    assert.equal(list.code, 200);
    assert.deepEqual(list.body.integrations.map(i => [i.id, i.status]), [['github_issues', 'disconnected']]);
  },

  // The one-time flow: steps are remembered for resuming, nothing reaches the
  // feed until GitHub is connected, the "New" cue clears only when
  // acknowledged, and a finished flow never records steps again.
  async onboarding_flow_is_resumable_and_one_time() {
    const { sql, feed, handlers } = await setup();
    const act = (tenant, action, body, integration = 'github_issues') => {
      const req = request(tenant, { method: 'POST', body });
      req.query = { integration, action };
      return call(handlers.integrationAction, req);
    };
    await sql`insert into kanban_items (user_email, title, external_source, external_id) values (${ALICE}, 'Waiting in the wings', 'github', 'a/app#1')`;

    let res = await act(ALICE, 'onboarding', { step: 'connect' });
    assert.equal(res.code, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'onboarding');
    assert.equal(res.body.onboarding_step, 'connect');
    assert.equal((await feed.buildFeedResponse(sql, ALICE, {})).cards.length, 0, 'a saved step must not leak cards into the feed');

    // Acknowledging before onboarding is finished changes nothing.
    assert.equal((await act(ALICE, 'acknowledge')).body.acknowledged, false);

    // Connecting GitHub finishes onboarding and clears the saved step.
    stubGithub({ 'a/app': [issue(1, 'Waiting in the wings')] });
    res = await call(handlers.githubConnection, request(ALICE, { method: 'POST', body: { token: 'github_pat_t', repo: 'a/app' } }));
    assert.equal(res.body.status, 'connected');
    assert.equal(res.body.onboarding_step, null);
    assert.equal(res.body.card_count, 1);
    assert.equal(res.body.acknowledged, false, '"New" cue shows until acknowledged');
    assert.deepEqual((await feed.buildFeedResponse(sql, ALICE, {})).cards.map(c => c.title), ['Waiting in the wings']);

    // Finished means finished: a stray step post does not reopen the flow.
    res = await act(ALICE, 'onboarding', { step: 'intro' });
    assert.equal(res.body.status, 'connected');
    assert.equal(res.body.onboarding_step, null);

    res = await act(ALICE, 'acknowledge');
    assert.equal(res.body.acknowledged, true);
    const firstAck = (await sql`select acknowledged_at from integrations where user_email = ${ALICE}`)[0].acknowledged_at;
    await act(ALICE, 'acknowledge');
    assert.deepEqual((await sql`select acknowledged_at from integrations where user_email = ${ALICE}`)[0].acknowledged_at, firstAck);

    // Validation and auth. Kanban is no longer an integration, and a
    // Cardlake-only "native" source no longer exists.
    assert.equal((await act(ALICE, 'onboarding', { step: 'source' })).code, 400);
    assert.equal((await act(null, 'acknowledge')).code, 401);
    assert.equal((await act(ALICE, 'native')).code, 404);
    assert.equal((await act(ALICE, 'acknowledge', undefined, 'kanban')).code, 404);
    assert.equal((await act(ALICE, 'acknowledge', undefined, 'nope')).code, 404);
  },

  // Dismissing a GitHub issue hides it instead of deleting it (a sync would
  // resurrect a deleted row), and the hide survives later syncs because a sync
  // keeps the row's id. Cardlake-owned cards still delete on dismiss.
  async dismissing_a_github_issue_hides_it_across_syncs() {
    const { sql, feed, handlers } = await setup();
    stubGithub({ 'a/app': [issue(1, 'Keep me'), issue(2, 'Hide me')] });
    await call(handlers.githubConnection, request(ALICE, { method: 'POST', body: { token: 'github_pat_t', repo: 'a/app' } }));
    await call(handlers.githubSync, request(ALICE, { method: 'POST' }));
    const titles = async () => (await feed.buildFeedResponse(sql, ALICE, { types: 'kanban' })).cards.map(c => c.title).sort();
    assert.deepEqual(await titles(), ['Hide me', 'Keep me']);

    const hideId = (await sql`select id from kanban_items where user_email = ${ALICE} and title = 'Hide me'`)[0].id;
    const result = await feed.applyFeedAction(sql, ALICE, 'dismiss', 'kanban', hideId);
    assert.equal(result.hidden, true);
    assert.deepEqual(await titles(), ['Keep me']);
    assert.equal((await sql`select deleted_at from kanban_items where id = ${hideId}`)[0].deleted_at, null, 'the issue row is not deleted');

    // Re-syncing (issue still open on GitHub) must not bring it back.
    assert.equal((await call(handlers.githubSync, request(ALICE, { method: 'POST' }))).code, 200);
    assert.deepEqual(await titles(), ['Keep me']);
    assert.equal((await sql`select id from kanban_items where user_email = ${ALICE} and title = 'Hide me'`)[0].id, hideId);

    // Another tenant cannot hide Alice's issue by id.
    const keepId = (await sql`select id from kanban_items where title = 'Keep me'`)[0].id;
    await assert.rejects(() => feed.applyFeedAction(sql, BOB, 'dismiss', 'kanban', keepId), /not found/i);
    assert.deepEqual(await titles(), ['Keep me']);

    // Cardlake-owned cards keep the old meaning of dismiss: delete.
    const reminder = (await sql`insert into reminders (user_email, title) values (${ALICE}, 'Call the bank') returning id`)[0].id;
    assert.equal((await feed.applyFeedAction(sql, ALICE, 'dismiss', 'reminder', reminder)).deleted, true);
    assert.ok((await sql`select deleted_at from reminders where id = ${reminder}`)[0].deleted_at);
  },

  // Feed state spans several resource tables, so it cannot have a normal
  // foreign key. Actions must still reject unknown or cross-tenant IDs rather
  // than creating invisible state rows (which could consume the pin limit).
  async feed_actions_do_not_create_orphan_state() {
    const { sql, feed } = await setup();
    const missingId = '00000000-0000-4000-8000-000000000000';
    for (const type of ['learning', 'kanban', 'work', 'family', 'bookmark', 'talking_point', 'reminder', 'file']) {
      for (const action of ['like', 'unlike', 'remind_later', 'unremind_later', 'pin', 'unpin']) {
        await assert.rejects(() => feed.applyFeedAction(sql, ALICE, action, type, missingId), /Item not found/);
      }
    }
    assert.equal((await sql`select count(*)::int as count from feed_state where user_email = ${ALICE}`)[0].count, 0);

    const reminder = (await sql`insert into reminders (user_email, title) values (${ALICE}, 'Stateful card') returning id`)[0].id;
    const result = await feed.applyFeedAction(sql, ALICE, 'like', 'reminder', reminder);
    assert.ok(result.feed_state.liked_at, 'valid cards retain their normal feed actions');
  },

  // Kanban cards come only from GitHub now: REST refuses hand-made creates
  // (they would be stored but never shown), and MCP offers integration tools
  // instead of Kanban create/update/delete tools.
  async hand_made_kanban_cards_are_refused_everywhere() {
    const { sql, handlers } = await setup();
    const { collection } = require('../../api/_lib/resources');
    const configs = require('../../api/_lib/resource-configs');
    const create = await call(collection(configs.kanban), request(ALICE, { method: 'POST', body: { title: 'By hand' } }));
    assert.equal(create.code, 409);
    assert.equal(create.body.code, 'KANBAN_COMES_FROM_GITHUB');
    assert.equal((await sql`select count(*)::int as n from kanban_items`)[0].n, 0);
    // Reading the list (used by the onboarding summary) still works.
    assert.equal((await call(collection(configs.kanban), request(ALICE))).code, 200);

    const tools = new Map();
    const server = { registerTool(name, config, handler) { tools.set(name, handler); } };
    require('../../api/_lib/mcp-tools').registerTools(server, ALICE);
    for (const gone of ['create_kanban_item', 'update_kanban_item', 'delete_kanban_item']) assert.ok(!tools.has(gone), gone);
    for (const name of ['list_integrations', 'sync_github_issues', 'list_feed', 'snooze_card']) assert.ok(tools.has(name), name);

    const text = result => JSON.parse(result.content[0].text);
    assert.deepEqual(text(await tools.get('list_integrations')({})).integrations.map(i => [i.id, i.status]), [['github_issues', 'not_started']]);
    const notConnected = await tools.get('sync_github_issues')({});
    assert.equal(notConnected.isError, true);
    assert.match(notConnected.content[0].text, /not connected/);

    stubGithub({ 'a/app': [issue(1, 'From GitHub')] });
    assert.equal((await call(handlers.githubConnection, request(ALICE, { method: 'POST', body: { token: 'github_pat_t', repo: 'a/app' } }))).code, 200);
    assert.equal(text(await tools.get('sync_github_issues')({})).synced, 1);
    const listed = text(await tools.get('list_integrations')({})).integrations[0];
    assert.equal(listed.status, 'connected');
    assert.equal(listed.card_count, 1);
    assert.ok(!JSON.stringify(listed).includes('"token"'));
  },

  // get_account reports only what the authenticated tenant already resolves
  // to -- never another account's profile -- and changes nothing.
  async mcp_get_account_reports_the_authenticated_identity() {
    const { sql } = await setup();
    await sql`insert into users (email, name, last_login_at) values (${ALICE}, 'Alice Example', '2026-01-01T00:00:00Z'), (${BOB}, 'Bob Example', '2026-01-01T00:00:00Z')`;
    const account = async tenant => {
      const tools = new Map();
      const server = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
      require('../../api/_lib/mcp-tools').registerTools(server, tenant);
      const tool = tools.get('get_account');
      assert.deepEqual(Object.keys(tool.config.inputSchema.shape), []);
      assert.match(tool.config.description, /confirm which Cardlake account this session is authenticated as/);
      const result = await tool.handler({});
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };

    assert.deepEqual(await account(ALICE), { account_id: ALICE, email: ALICE, display_name: 'Alice Example' });
    assert.deepEqual(await account(BOB), { account_id: BOB, email: BOB, display_name: 'Bob Example' });
    // A token for an account with no profile row yet (e.g. a personal access
    // token minted before its first Google login) still identifies it.
    assert.deepEqual(await account('carol@example.test'), { account_id: 'carol@example.test', email: 'carol@example.test', display_name: null });
    // The shared tenant (MCP_TOKEN) is not a person.
    assert.deepEqual(await account(SHARED), { account_id: SHARED, email: null, display_name: null });

    // Read-only: nothing about the profile rows changed.
    const rows = await sql`select email, name, last_login_at from users order by email`;
    assert.deepEqual(rows.map(r => [r.email, r.name, new Date(r.last_login_at).toISOString()]), [
      [ALICE, 'Alice Example', '2026-01-01T00:00:00.000Z'],
      [BOB, 'Bob Example', '2026-01-01T00:00:00.000Z'],
    ]);
  },

  // OAuth may grant a read-only or write-only subset. The MCP registry must
  // reflect that subset instead of rejecting a valid narrow token or exposing
  // mutation tools to it.
  async mcp_tools_respect_oauth_scopes() {
    await setup();
    const register = scopes => {
      const tools = new Map();
      const server = { registerTool(name, config, handler) { tools.set(name, { config, handler }); } };
      require('../../api/_lib/mcp-tools').registerTools(server, ALICE, scopes);
      return tools;
    };
    const reads = register(['cardle.read']);
    for (const name of ['list_feed', 'get_dashboard_stats', 'get_account', 'list_integrations']) {
      assert.ok(reads.has(name), `read-only token is missing ${name}`);
      assert.deepEqual(reads.get(name).config.securitySchemes[0].scopes, ['cardle.read']);
    }
    for (const name of ['create_reminder', 'snooze_card', 'sync_github_issues']) assert.ok(!reads.has(name), `read-only token exposes ${name}`);

    const writes = register(['cardle.write']);
    for (const name of ['create_reminder', 'snooze_card', 'sync_github_issues']) {
      assert.ok(writes.has(name), `write-only token is missing ${name}`);
      assert.deepEqual(writes.get(name).config.securitySchemes[0].scopes, ['cardle.write']);
    }
    for (const name of ['list_feed', 'get_dashboard_stats', 'get_account', 'list_integrations']) assert.ok(!writes.has(name), `write-only token exposes ${name}`);

    const full = register(['cardle.read', 'cardle.write']);
    for (const name of ['list_feed', 'get_account', 'create_reminder', 'snooze_card']) assert.ok(full.has(name), `full OAuth token is missing ${name}`);
  },

  // A real ChatGPT call revealed that the original one-hour access token
  // expired with no way for the client to renew it. Refresh tokens must rotate,
  // remain tied to their original public client/resource, preserve the narrow
  // scope, and stop working as soon as the account is no longer allowed.
  async oauth_refresh_tokens_rotate_and_respect_account_access() {
    const { sql } = await setup();
    const crypto = require('crypto');
    const oauth = require('../../api/_lib/oauth');
    const oauthHandler = require('../../api/oauth');
    const verifier = 'a'.repeat(43);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authorizationCode = 'chatgpt-test-code';
    await sql`insert into oauth_authorization_codes (code_hash, user_email, client_id, redirect_uri, resource, scope, code_challenge, expires_at) values (${oauth.hashToken(authorizationCode)}, ${ALICE}, ${oauth.CHATGPT_CLIENT_ID}, ${oauth.CHATGPT_REDIRECT_URI}, ${oauth.RESOURCE}, 'cardle.read', ${challenge}, now() + interval '10 minutes')`;

    const tokenRequest = body => call(oauthHandler, { method: 'POST', headers: {}, query: { action: 'token' }, body });
    const initial = await tokenRequest({
      grant_type: 'authorization_code', code: authorizationCode, client_id: oauth.CHATGPT_CLIENT_ID,
      redirect_uri: oauth.CHATGPT_REDIRECT_URI, resource: oauth.RESOURCE, code_verifier: verifier,
    });
    assert.equal(initial.code, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.token_type, 'Bearer');
    assert.equal(initial.body.expires_in, oauth.ACCESS_TTL_SECONDS);
    assert.equal(initial.body.refresh_token_expires_in, oauth.REFRESH_TTL_SECONDS);
    assert.equal(initial.body.scope, 'cardle.read');
    assert.equal(oauth.resolveOAuthAuthorization({ headers: { authorization: `Bearer ${initial.body.access_token}` } }).tenant, ALICE);

    // A mismatched resource cannot spend the refresh token; the correct client
    // can still use it afterwards.
    const wrongResource = await tokenRequest({ grant_type: 'refresh_token', refresh_token: initial.body.refresh_token, client_id: oauth.CHATGPT_CLIENT_ID, resource: 'https://evil.example/api/mcp' });
    assert.equal(wrongResource.code, 400);
    assert.equal(wrongResource.body.error, 'invalid_grant');
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: initial.body.refresh_token, client_id: oauth.CHATGPT_CLIENT_ID, resource: oauth.RESOURCE });
    assert.equal(refreshed.code, 200, JSON.stringify(refreshed.body));
    assert.notEqual(refreshed.body.refresh_token, initial.body.refresh_token, 'refresh tokens must rotate');
    assert.equal(refreshed.body.scope, 'cardle.read', 'a narrow grant must stay narrow after refresh');

    // Rotation makes replays useless, while a client-id mismatch leaves the
    // legitimate client able to spend its own current token.
    const replay = await tokenRequest({ grant_type: 'refresh_token', refresh_token: initial.body.refresh_token, client_id: oauth.CHATGPT_CLIENT_ID, resource: oauth.RESOURCE });
    assert.equal(replay.code, 400);
    const wrongClient = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshed.body.refresh_token, client_id: oauth.CLAUDE_CLIENT_ID, resource: oauth.RESOURCE });
    assert.equal(wrongClient.code, 400);
    const rotatedAgain = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshed.body.refresh_token, client_id: oauth.CHATGPT_CLIENT_ID });
    assert.equal(rotatedAgain.code, 200, JSON.stringify(rotatedAgain.body));

    // An account removed after its original authorization can neither refresh
    // nor use its old access token through api/mcp.js (covered separately).
    await sql`update oauth_refresh_tokens set user_email = 'removed@example.test' where token_hash = ${oauth.hashToken(rotatedAgain.body.refresh_token)}`;
    const removed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: rotatedAgain.body.refresh_token, client_id: oauth.CHATGPT_CLIENT_ID, resource: oauth.RESOURCE });
    assert.equal(removed.code, 400);
    assert.equal(removed.body.error, 'invalid_grant');
    assert.equal((await sql`select count(*)::int as n from oauth_refresh_tokens where used_at is null`)[0].n, 0, 'a removed account must not retain a live refresh token');
  },

  // The shared tenant is public -- every signed-out visitor reads it -- so it
  // never has integrations: nothing about one is ever shown (a private repo's
  // name leaked this way in production), none can be created, and its issue
  // rows never reach the feed.
  async shared_tenant_never_has_integrations() {
    const { sql, feed, handlers, applySchema } = await setup();
    await sql`insert into integrations (user_email, provider, config, status, connected_at, onboarded_at) values (${SHARED}, 'github_issues', '{"repo_owner":"secret-org","repo_name":"private-repo"}'::jsonb, 'connected', now(), now())`;
    await sql`insert into kanban_items (user_email, title, external_source, external_id) values (${SHARED}, 'Confidential issue', 'github', 'secret-org/private-repo#1')`;

    // Nothing is visible to an anonymous visitor.
    const list = await call(handlers.listIntegrations, request(null));
    assert.equal(list.body.integrations[0].status, 'not_started');
    assert.equal(list.body.integrations[0].repo, null);
    assert.equal((await call(handlers.githubConnection, request(null))).body.repo, null);
    const publicFeed = await feed.buildFeedResponse(sql, SHARED, {});
    assert.ok(!JSON.stringify(publicFeed).includes('private-repo'), 'repo name must not appear anywhere in the public feed payload');
    assert.ok(!publicFeed.cards.some(c => c.title === 'Confidential issue'));

    // Nothing can be set up for the shared tenant either -- and GitHub is
    // never even contacted.
    let githubCalled = false;
    global.fetch = async () => { githubCalled = true; return { ok: true, status: 200, json: async () => ({}) }; };
    const connect = await call(handlers.githubConnection, request(SHARED, { method: 'POST', body: { token: 'github_pat_t', repo: 'secret-org/private-repo' } }));
    assert.equal(connect.code, 403, JSON.stringify(connect.body));
    assert.equal(connect.body.code, 'INTEGRATIONS_NEED_PERSONAL_ACCOUNT');
    assert.equal(githubCalled, false);
    assert.equal((await call(handlers.githubSync, request(SHARED, { method: 'POST' }))).code, 403);
    for (const action of ['onboarding', 'acknowledge']) {
      const req = request(SHARED, { method: 'POST', body: { step: 'intro' } });
      req.query = { integration: 'github_issues', action };
      assert.equal((await call(handlers.integrationAction, req)).code, 403, action);
    }

    // A personal account is unaffected.
    stubGithub({ 'alice/app': [issue(1, 'Alice one')] });
    assert.equal((await call(handlers.githubConnection, request(ALICE, { method: 'POST', body: { token: 'github_pat_t', repo: 'alice/app' } }))).code, 200);

    // The migration clears the shared tenant's row and leaves Alice's alone.
    await applySchema();
    assert.deepEqual((await sql`select user_email from integrations order by user_email`).map(r => r.user_email), [ALICE]);
  },

  // Least privilege: only fine-grained tokens. A classic/OAuth token is refused
  // before GitHub is contacted; one that slips past the prefix check is caught
  // by the OAuth-scopes header GitHub only sends for broad tokens.
  async broad_github_tokens_are_refused() {
    const { sql, handlers } = await setup();
    let calls = 0;
    const connect = token => call(handlers.githubConnection, request(ALICE, { method: 'POST', body: { token, repo: 'a/app' } }));
    global.fetch = async () => { calls += 1; return { ok: true, status: 200, headers: { get: () => null }, json: async () => [] }; };
    for (const token of ['ghp_classic', 'gho_oauth', 'ghu_user', 'ghs_server', '0123456789abcdef0123456789abcdef01234567']) {
      const res = await connect(token);
      assert.equal(res.code, 400, token);
      assert.equal(res.body.code, 'GITHUB_TOKEN_TOO_BROAD', token);
    }
    assert.equal(calls, 0, 'GitHub must not be contacted for a refused token');

    global.fetch = async () => ({ ok: true, status: 200, headers: { get: name => (name === 'x-oauth-scopes' ? 'repo, admin:org' : null) }, json: async () => ({}) });
    const scoped = await connect('github_pat_but_classic_scopes');
    assert.equal(scoped.body.code, 'GITHUB_TOKEN_TOO_BROAD');
    assert.equal((await sql`select count(*)::int as n from integrations where token is not null`)[0].n, 0, 'nothing broad is ever stored');

    stubGithub({ 'a/app': [] });
    assert.equal((await connect('github_pat_fine')).code, 200);
  },

  // Connect tries a token against GitHub, so it is rate limited per source
  // like password login; sync has its own, looser budget.
  async connect_and_sync_are_rate_limited_per_source() {
    const { handlers } = await setup();
    stubGithub({ 'a/app': [] });
    const from = (ip, req) => { req.headers['x-forwarded-for'] = ip; return req; };
    const connect = ip => call(handlers.githubConnection, from(ip, request(ALICE, { method: 'POST', body: { token: 'github_pat_t', repo: 'a/app' } })));
    for (let i = 0; i < 10; i += 1) assert.equal((await connect('203.0.113.9')).code, 200, `attempt ${i + 1}`);
    const limited = await connect('203.0.113.9');
    assert.equal(limited.code, 429);
    assert.equal(limited.body.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers['Retry-After']) > 0);
    assert.equal((await connect('198.51.100.4')).code, 200, 'another source is unaffected');

    const sync = ip => call(handlers.githubSync, from(ip, request(ALICE, { method: 'POST' })));
    for (let i = 0; i < 30; i += 1) assert.equal((await sync('203.0.113.10')).code, 200, `sync ${i + 1}`);
    assert.equal((await sync('203.0.113.10')).code, 429);
  },

  // When a different email takes the Cardlake over (CARDLE_SETUP_OPEN=1),
  // the previous owner loses what they already hold: API tokens are
  // revoked, the stored GitHub token is wiped, synced issues are hidden, and
  // a still-valid session cannot reconnect GitHub.
  async replacing_the_owner_revokes_tokens_and_github() {
    const { sql, handlers } = await setup();
    const { allowAccounts } = require('./pg_harness');
    const { removeUserAccess } = require('../../api/_lib/offboarding');
    const access = require('../../api/_lib/access-control');
    const { createApiToken, resolveApiTokenTenant } = require('../../api/_lib/api-tokens');
    const CAROL = 'carol@example.test';
    allowAccounts(ALICE, BOB, CAROL);
    stubGithub({ 'c/app': [issue(1, 'Carol one'), issue(2, 'Carol two')] });
    assert.equal((await call(handlers.githubConnection, request(CAROL, { method: 'POST', body: { token: 'github_pat_carol', repo: 'c/app' } }))).code, 200);
    assert.equal((await call(handlers.githubSync, request(CAROL, { method: 'POST' }))).code, 200);
    const apiToken = await createApiToken(sql, CAROL, 'laptop');
    assert.equal(await resolveApiTokenTenant(sql, { headers: { authorization: `Bearer ${apiToken.token}` } }), CAROL);

    // Someone else is the owner now (local-accounts.js completeSetup).
    allowAccounts(ALICE, BOB);
    const removed = await removeUserAccess(sql, CAROL);
    assert.deepEqual(removed.revoked, { api_tokens: 1, integration_credentials: 1, synced_cards: 2 });

    assert.equal(await access.isOwnerEmail(sql, CAROL), false);
    assert.equal(await resolveApiTokenTenant(sql, { headers: { authorization: `Bearer ${apiToken.token}` } }), null);
    const row = (await sql`select token, status from integrations where user_email = ${CAROL}`)[0];
    assert.deepEqual([row.token, row.status], [null, 'disconnected']);
    assert.equal((await sql`select count(*)::int as n from kanban_items where user_email = ${CAROL} and deleted_at is null`)[0].n, 0);

    // Her session cookie is still signed and unexpired -- but GitHub stays shut.
    const reconnect = await call(handlers.githubConnection, request(CAROL, { method: 'POST', body: { token: 'github_pat_carol', repo: 'c/app' } }));
    assert.equal(reconnect.code, 403);
    assert.equal(reconnect.body.code, 'ACCESS_REVOKED');
    assert.equal((await call(handlers.githubSync, request(CAROL, { method: 'POST' }))).code, 403);
    const step = request(CAROL, { method: 'POST', body: { step: 'intro' } });
    step.query = { integration: 'github_issues', action: 'onboarding' };
    assert.equal((await call(handlers.integrationAction, step)).code, 403);

    // Running it again is harmless (every step is idempotent).
    const again = await removeUserAccess(sql, CAROL);
    assert.deepEqual(again.revoked, { api_tokens: 0, integration_credentials: 0, synced_cards: 0 });
  },

  // A replaced owner's existing session stops working on its very next
  // request: reads fall back to the public view, writes are refused, the
  // browser is told to drop the cookie, and a still-unexpired MCP OAuth token
  // no longer authenticates.
  async a_replaced_owners_session_stops_working_immediately() {
    const { sql } = await setup();
    const { allowAccounts } = require('./pg_harness');
    const { removeUserAccess } = require('../../api/_lib/offboarding');
    const { createAccessToken, SCOPES } = require('../../api/_lib/oauth');
    const CAROL = 'carol@example.test';
    allowAccounts(ALICE, BOB, CAROL);
    await sql`insert into reminders (user_email, title) values (${CAROL}, 'Carol private reminder')`;
    const feedHandler = require('../../api/feed');
    const authHandler = require('../../api/auth');
    const readFeed = async () => call(feedHandler, request(CAROL));
    const session = async () => { const req = request(CAROL); req.query = { action: 'session' }; return call(authHandler, req); };

    // Before: her own feed, and the allowed answer is now cached.
    let res = await readFeed();
    assert.deepEqual(res.body.cards.map(c => c.title), ['Carol private reminder']);
    assert.equal((await session()).body.authenticated, true);

    allowAccounts(ALICE, BOB);
    await removeUserAccess(sql, CAROL);

    // After, on the same instance: no waiting for the cache to expire.
    res = await readFeed();
    assert.equal(res.code, 200);
    assert.ok(!res.body.cards.some(c => c.title === 'Carol private reminder'), 'her data must not be served to her old cookie');
    assert.match(String(res.headers['Set-Cookie']), /lh_session=;.*Max-Age=0/, 'the browser is told to drop the cookie');
    assert.equal((await session()).body.authenticated, false);
    const write = request(CAROL, { method: 'POST', body: { action: 'pin', item_type: 'reminder', item_id: '00000000-0000-4000-8000-000000000000' } });
    assert.equal((await call(feedHandler, write)).code, 401);

    // MCP: a signed OAuth access token minted before the change (valid an hour).
    const mcp = require('../../api/mcp');
    const token = createAccessToken(CAROL, SCOPES);
    const mcpRes = await call(mcp, { method: 'POST', headers: { authorization: `Bearer ${token}` }, query: {}, body: {} });
    assert.equal(mcpRes.code, 401);

    // Everyone else is unaffected.
    assert.equal((await call(feedHandler, request(ALICE))).code, 200);
    assert.ok(!String((await call(feedHandler, request(ALICE))).headers['Set-Cookie'] || '').includes('Max-Age=0'));
  },

  // If the owner can't be read, the guard lets the request through
  // unchanged rather than signing everyone out on a database blip -- the
  // handler needs the same database and fails on its own.
  async session_guard_fails_open_when_the_owner_is_unreadable() {
    await setup();
    const { dropRevokedSession } = require('../../api/_lib/session-guard');
    const originalGetSql = db.getSql;
    db.getSql = () => { throw new Error('database unavailable'); };
    try {
      const req = request('carol@example.test');
      const before = req.headers.cookie;
      const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
      await dropRevokedSession(req, res);
      assert.equal(req.headers.cookie, before);
      assert.equal(res.headers['Set-Cookie'], undefined);
    } finally {
      db.getSql = originalGetSql;
    }
  },

  // The dedicated key's whole lifecycle, as an operator would run it: tokens
  // sealed before it existed move onto it on their next use, rotation keeps
  // old ciphertexts readable until they are resealed under the new key, and
  // retiring a key only breaks values that were never resealed.
  async dedicated_encryption_key_and_rotation() {
    const { sql, handlers } = await setup();
    const crypto = require('crypto');
    const newKey = () => crypto.randomBytes(32).toString('base64');
    const [keyA, keyB] = [newKey(), newKey()];
    const stored = async () => (await sql`select token from integrations where user_email = ${ALICE}`)[0].token;
    let sentAuth = null;
    global.fetch = async (url, options) => {
      sentAuth = options.headers.Authorization;
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => (url.includes('/issues') ? [] : {}) };
    };
    const sync = async () => (await call(handlers.githubSync, request(ALICE, { method: 'POST' }))).code;
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
    delete process.env.INTEGRATION_ENCRYPTION_KEYS_PREVIOUS;

    // No dedicated key yet: sealed with the original (v1) key.
    assert.equal((await call(handlers.githubConnection, request(ALICE, { method: 'POST', body: { token: 'github_pat_secret', repo: 'a/app' } }))).code, 200);
    assert.ok((await stored()).startsWith('v1:'));

    // Adding the key: the v1 value still opens, and moves onto the key on use.
    process.env.INTEGRATION_ENCRYPTION_KEY = keyA;
    assert.equal(await sync(), 200);
    assert.equal(sentAuth, 'Bearer github_pat_secret');
    const underA = await stored();
    assert.ok(underA.startsWith('v2:') && !underA.includes('github_pat_secret'));

    // Rotation: B is current, A is kept as previous until values are resealed.
    process.env.INTEGRATION_ENCRYPTION_KEY = keyB;
    process.env.INTEGRATION_ENCRYPTION_KEYS_PREVIOUS = keyA;
    assert.equal(await sync(), 200);
    assert.equal(sentAuth, 'Bearer github_pat_secret');
    const underB = await stored();
    assert.notEqual(underB.split(':')[1], underA.split(':')[1], 'resealed under the new key');

    // Retiring A is now safe for this value...
    delete process.env.INTEGRATION_ENCRYPTION_KEYS_PREVIOUS;
    assert.equal(await sync(), 200);
    // ...and a value still sealed under A (never used during rotation) asks
    // the user to reconnect rather than failing opaquely.
    await sql`update integrations set token = ${underA} where user_email = ${ALICE}`;
    const stale = await call(handlers.githubSync, request(ALICE, { method: 'POST' }));
    assert.equal(stale.code, 409);
    assert.equal(stale.body.code, 'INTEGRATION_RECONNECT_REQUIRED');

    // A fresh connect with the key set seals straight under it.
    assert.equal((await call(handlers.githubConnection, request(BOB, { method: 'POST', body: { token: 'github_pat_bob', repo: 'a/app' } }))).code, 200);
    assert.equal((await sql`select token from integrations where user_email = ${BOB}`)[0].token.split(':')[0], 'v2');

    // A misconfigured key fails loudly and stores nothing (no silent fallback).
    process.env.INTEGRATION_ENCRYPTION_KEY = crypto.randomBytes(16).toString('base64');
    const misconfigured = await call(handlers.githubConnection, request(ALICE, { method: 'POST', body: { token: 'github_pat_new', repo: 'a/app' } }));
    assert.equal(misconfigured.code, 500);
    assert.equal(await stored(), underA, 'nothing was overwritten');
    delete process.env.INTEGRATION_ENCRYPTION_KEY;
  },

  // Editing a GitHub-synced card is blocked while connected -- per tenant: Bob
  // being GitHub-connected must not affect Alice's cards.
  async kanban_write_guard_is_tenant_scoped() {
    const { sql, handlers } = await setup();
    const { kanbanWriteBlockReason } = require('../../api/_lib/integrations');
    stubGithub({ 'bob/api': [issue(1, 'Bob one')] });
    await call(handlers.githubConnection, request(BOB, { method: 'POST', body: { token: 'github_pat_t', repo: 'bob/api' } }));
    await call(handlers.githubSync, request(BOB, { method: 'POST' }));

    const bobCard = (await sql`select id from kanban_items where user_email = ${BOB}`)[0].id;
    assert.match(await kanbanWriteBlockReason(sql, BOB, bobCard), /synced from GitHub/);
    // Alice cannot even probe Bob's card id through her own tenant.
    assert.equal(await kanbanWriteBlockReason(sql, ALICE, bobCard), null);
  },
};

require('./scenario_runner').runScenario(scenarios);
