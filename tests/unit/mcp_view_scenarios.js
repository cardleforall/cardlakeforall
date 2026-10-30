// Drives the MCP Apps card view (api/_lib/mcp-app/cards.html) the way a host
// does: runs its script against a minimal DOM, answers ui/initialize, sends
// tool results, and checks every message the view posts. No DOM library or
// browser needed. Invoked by test_mcp_cards_view.py as
// `node tests/unit/mcp_view_scenarios.js <name>`.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The view as the server sends it, with this deployment's address filled in.
process.env.CARDLE_PUBLIC_ORIGIN = 'https://cardlake.example';
const { CARDS_VIEW_HTML } = require('../../api/_lib/mcp-app');

// Just enough of the DOM for the view. innerHTML throws: card text must only
// ever arrive through textContent.
class Node {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.className = ''; this.listeners = {}; this.ownText = ''; this.attributes = {}; this.disabled = false; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  set textContent(value) { this.children = []; this.ownText = String(value); }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('the view must not set innerHTML'); }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...nodes) { this.children = nodes; this.ownText = ''; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  click() { if (this.disabled) return; for (const handler of this.listeners.click || []) handler({ preventDefault() {} }); }
  findAll(predicate, found = []) { if (predicate(this)) found.push(this); for (const child of this.children) child.findAll(predicate, found); return found; }
  byClass(name) { return this.findAll(node => node.className.split(' ').includes(name)); }
}

function loadView() {
  const html = CARDS_VIEW_HTML;
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const root = new Node('main');
  const styleVars = {};
  const rootStyle = { setProperty(name, value) { styleVars[name] = value; }, colorScheme: '' };
  const sent = [];
  const parent = { postMessage(message, origin) { assert.equal(origin, '*'); sent.push(JSON.parse(JSON.stringify(message))); } };
  const listeners = [];
  const window = {
    parent,
    addEventListener(type, handler) { if (type === 'message') listeners.push(handler); },
  };
  const document = {
    getElementById: id => (id === 'root' ? root : null),
    createElement: tag => new Node(tag),
    documentElement: { style: rootStyle, scrollHeight: 240 },
    body: { scrollHeight: 240 },
  };
  vm.runInNewContext(script, { window, document, console });
  const deliver = (data, source = parent) => { for (const handler of listeners) handler({ data, source }); };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { root, sent, styleVars, rootStyle, deliver, settle, document };
}

// Connects the way a host would, and returns the view ready for results.
async function connected(hostContext = {}, hostCapabilities = {}) {
  const view = loadView();
  const init = view.sent[0];
  view.deliver({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'test-host', version: '1' }, hostCapabilities, hostContext } });
  await view.settle();
  return view;
}

const toolResult = structuredContent => ({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } });
const card = (overrides = {}) => ({ id: overrides.id || 'c1', type: 'reminder', title: 'Call the dentist', subtitle: 'Due tomorrow', body: '', metadata: {}, created_at: '2026-09-01T00:00:00Z', pinned_at: null, liked_at: null, remind_later_until: null, ...overrides });

const scenarios = {
  // AC 4: the handshake, in the order the spec requires.
  async view_initializes_with_the_host_and_applies_its_theme() {
    const view = loadView();
    assert.equal(view.sent.length, 1, 'only ui/initialize is sent before the host answers');
    const init = view.sent[0];
    assert.equal(init.jsonrpc, '2.0');
    assert.equal(init.method, 'ui/initialize');
    assert.equal(typeof init.id, 'number');
    assert.equal(init.params.protocolVersion, '2026-01-26');
    assert.equal(init.params.appInfo.name, 'cardle-cards');
    assert.ok(init.params.appCapabilities && typeof init.params.appCapabilities === 'object');

    view.deliver({ jsonrpc: '2.0', id: init.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'h', version: '1' }, hostCapabilities: {}, hostContext: { theme: 'dark', styles: { variables: { '--color-text-primary': '#fafafa', 'not-a-variable': 'x' } } } } });
    await view.settle();
    assert.ok(view.sent.some(m => m.method === 'ui/notifications/initialized'), 'initialized notification sent');
    assert.equal(view.rootStyle.colorScheme, 'dark');
    assert.equal(view.styleVars['--color-text-primary'], '#fafafa');
    assert.ok(!('not-a-variable' in view.styleVars), 'only CSS custom properties are applied');

    // A theme change later is applied too.
    view.deliver({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: { theme: 'light' } });
    assert.equal(view.rootStyle.colorScheme, 'light');
  },

  // AC 4: every result shape the three tools return renders one card per card.
  async view_renders_feed_pages_search_results_and_single_cards() {
    const view = await connected();
    view.deliver(toolResult({ cards: [card({ id: 'a', pinned_at: '2026-09-01T00:00:00Z' }), card({ id: 'b', type: 'kanban', title: 'Fix login', liked_at: '2026-09-02T00:00:00Z', metadata: { status: 'done' } })], next_cursor: 'abc', view: 'active', integrations: [], stats: {} }));
    let items = view.root.byClass('card');
    assert.equal(items.length, 2);
    assert.match(items[0].textContent, /Reminder.*Pinned.*Call the dentist.*Due tomorrow/);
    assert.match(items[1].textContent, /GitHub issue.*Liked.*Done.*Fix login/);
    assert.match(view.root.byClass('summary')[0].textContent, /2 cards \(more in Cardlake\)/);
    const size = view.sent.filter(m => m.method === 'ui/notifications/size-changed');
    assert.ok(size.length >= 1 && size.at(-1).params.height > 0, 'the view reports its height');

    view.deliver(toolResult({ cards: [card({ id: 'c', title: 'Dentist notes' })], next_cursor: null, total: 12 }));
    assert.equal(view.root.byClass('card').length, 1);
    assert.match(view.root.byClass('summary')[0].textContent, /Showing 1 of 12 cards/);

    view.deliver(toolResult({ card: card({ id: 'd', title: 'Just this one', remind_later_until: '2999-01-01T00:00:00Z' }) }));
    items = view.root.byClass('card');
    assert.equal(items.length, 1);
    assert.match(items[0].textContent, /Snoozed.*Just this one/);

    view.deliver(toolResult({ cards: [], next_cursor: null, total: 0 }));
    assert.equal(view.root.byClass('card').length, 0);
    assert.match(view.root.textContent, /No cards\./);

    view.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { isError: true, content: [{ type: 'text', text: 'Error: Card not found' }] } });
    assert.match(view.root.textContent, /Couldn't show these cards here\./);
  },

  // The talking_point card type is shown to people as "Misc".
  async view_labels_talking_point_cards_as_misc() {
    const view = await connected();
    view.deliver(toolResult({ cards: [card({ type: 'talking_point', title: 'Ask about the timeline', subtitle: '' })], next_cursor: null, view: 'active', integrations: [], stats: {} }));
    const item = view.root.byClass('card')[0];
    assert.match(item.textContent, /Misc.*Ask about the timeline/);
    assert.doesNotMatch(item.textContent, /talking/i);
  },

  // A work card's checklist is shown, ticked items marked, as text.
  async view_shows_a_work_cards_checklist() {
    const view = await connected();
    const items = [{ text: 'Write tests', completed: true }, { text: '<b>Deploy</b>', completed: false }];
    view.deliver(toolResult({ card: card({ type: 'work', title: 'Ship it', subtitle: '1/2 items done', metadata: { items, done: 1, total: 2 } }) }));
    const lines = view.root.byClass('checklist')[0].children;
    assert.deepEqual(lines.map(line => line.textContent), ['☑ Write tests', '☐ <b>Deploy</b>']);
    assert.deepEqual(lines.map(line => line.getAttribute('data-done')), ['true', 'false']);

    const many = Array.from({ length: 12 }, (_, i) => ({ text: `Step ${i + 1}` }));
    view.deliver(toolResult({ card: card({ type: 'work', title: 'Long', metadata: { items: many } }) }));
    const long = view.root.byClass('checklist')[0].children;
    assert.equal(long.length, 9);
    assert.equal(long[8].textContent, '…and 4 more');

    view.deliver(toolResult({ card: card({ type: 'reminder', metadata: { items } }) }));
    assert.equal(view.root.byClass('checklist').length, 0, 'only work cards have a checklist');
  },

  // AC 5: card text is text. A hostile GitHub issue title runs nothing.
  async view_treats_card_text_as_text() {
    const view = await connected();
    const hostile = '<img src=x onerror="parent.postMessage(1,\'*\')">';
    view.deliver(toolResult({ cards: [card({ title: hostile, subtitle: '<b>sub</b>', body: '<script>alert(1)</script>' })], next_cursor: null, view: 'active', integrations: [], stats: {} }));
    const item = view.root.byClass('card')[0];
    assert.equal(item.byClass('title')[0].textContent, hostile);
    assert.equal(item.byClass('body')[0].textContent, '<script>alert(1)</script>');
    assert.ok(view.root.findAll(node => node.tagName === 'IMG' || node.tagName === 'SCRIPT').length === 0);

    const html = CARDS_VIEW_HTML;
    assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  },

  // AC 6: links open through the host, and only plain web links.
  async view_opens_only_web_links_through_the_host() {
    const view = await connected();
    view.deliver(toolResult({ cards: [
      card({ id: 'web', type: 'bookmark', title: 'Docs', metadata: { url: 'https://example.test/docs' } }),
      card({ id: 'issue', type: 'kanban', title: 'Bug', metadata: { external_url: 'https://github.com/a/b/issues/1' } }),
      card({ id: 'bad', type: 'bookmark', title: 'Sneaky', metadata: { url: 'javascript:alert(1)' } }),
      card({ id: 'data', type: 'bookmark', title: 'Data', metadata: { url: 'data:text/html,hi' } }),
    ], next_cursor: null, view: 'active', integrations: [], stats: {} }));
    const items = view.root.byClass('card');
    const openIn = item => item.byClass('open');
    assert.equal(openIn(items[0]).length, 1);
    assert.equal(openIn(items[1]).length, 1);
    assert.equal(openIn(items[2]).length, 0, 'no link for javascript:');
    assert.equal(openIn(items[3]).length, 0, 'no link for data:');

    openIn(items[0])[0].click();
    openIn(items[1])[0].click();
    const opened = view.sent.filter(m => m.method === 'ui/open-link').map(m => m.params.url);
    assert.deepEqual(opened, ['https://example.test/docs', 'https://github.com/a/b/issues/1']);
    assert.ok(view.sent.every(m => !JSON.stringify(m).includes('javascript:')));

    view.root.byClass('footer')[0].byClass('open')[0].click();
    assert.equal(view.sent.filter(m => m.method === 'ui/open-link').at(-1).params.url, 'https://cardlake.example/');
  },

  // Only the host can drive the view, and it answers the host's requests.
  async view_ignores_other_senders_and_answers_teardown() {
    const view = await connected();
    view.deliver(toolResult({ cards: [card({ title: 'From elsewhere' })] }), { postMessage() {} });
    assert.doesNotMatch(view.root.textContent, /From elsewhere/);
    view.deliver({ not: 'json-rpc' });

    view.deliver({ jsonrpc: '2.0', id: 77, method: 'ui/resource-teardown', params: { reason: 'closed' } });
    assert.deepEqual(view.sent.at(-1), { jsonrpc: '2.0', id: 77, result: {} });
    view.deliver({ jsonrpc: '2.0', id: 78, method: 'ping' });
    assert.deepEqual(view.sent.at(-1), { jsonrpc: '2.0', id: 78, result: {} });
  },
  // Pin and like need the host to run tools for the view (serverTools). A
  // host that can't shows the same cards, read-only.
  async view_offers_pin_and_like_only_when_the_host_can_run_tools() {
    const page = { cards: [card({ id: 'a' }), card({ id: 'b', pinned_at: '2026-09-01T00:00:00Z', liked_at: '2026-09-02T00:00:00Z' })], next_cursor: null, view: 'active', integrations: [], stats: {} };
    const readOnly = await connected();
    readOnly.deliver(toolResult(page));
    assert.equal(readOnly.root.byClass('action').length, 0, 'no buttons without serverTools');

    const view = await connected({}, { serverTools: {} });
    view.deliver(toolResult(page));
    const [first, second] = view.root.byClass('card');
    const labels = item => item.byClass('action').map(button => [button.textContent, button.getAttribute('aria-pressed')]);
    assert.deepEqual(labels(first), [['Pin', 'false'], ['Like', 'false'], ['Remind later', null], ['Delete', null]]);
    assert.deepEqual(labels(second), [['Unpin', 'true'], ['Unlike', 'true'], ['Remind later', null], ['Delete', null]]);
  },

  // Remind later and Delete follow what Cardlake allows for each card: a
  // snoozed card can be brought back, a finished one can't be snoozed, and
  // GitHub issues and files have no delete tool.
  async view_offers_remind_later_and_delete_by_card_state() {
    const view = await connected({}, { serverTools: {} });
    view.deliver(toolResult({ cards: [
      card({ id: 'snoozed', remind_later_until: '2999-01-01T00:00:00Z' }),
      card({ id: 'done', metadata: { completed: true } }),
      card({ id: 'issue', type: 'kanban', title: 'Bug' }),
      card({ id: 'file', type: 'file', title: 'Scan.pdf' }),
      card({ id: 'over', remind_later_until: '2000-01-01T00:00:00Z' }),
    ], next_cursor: null, view: 'active', integrations: [], stats: {} }));
    const labels = item => item.byClass('action').map(button => button.textContent);
    const [snoozed, done, issue, file, over] = view.root.byClass('card');
    assert.deepEqual(labels(snoozed), ['Pin', 'Like', 'Bring back now', 'Delete']);
    assert.deepEqual(labels(done), ['Pin', 'Like', 'Delete']);
    assert.deepEqual(labels(issue), ['Pin', 'Like', 'Remind later']);
    assert.deepEqual(labels(file), ['Pin', 'Like', 'Remind later']);
    assert.deepEqual(labels(over), ['Pin', 'Like', 'Remind later', 'Delete'], 'a snooze that has ended no longer counts');
  },

  // Remind later offers a few lengths, snoozes for the one picked, and the
  // card can be brought back.
  async view_snoozes_and_brings_back_through_the_host() {
    const view = await connected({}, { serverTools: {}, updateModelContext: { text: {} } });
    view.deliver(toolResult({ card: card({ id: 'a', title: 'Call the dentist', pinned_at: '2026-09-01T00:00:00Z' }) }));
    const item = () => view.root.byClass('card')[0];
    const button = label => item().byClass('action').find(b => b.textContent === label);
    const calls = () => view.sent.filter(m => m.method === 'tools/call');

    button('Remind later').click();
    assert.match(item().byClass('choice')[0].textContent, /Remind me in/);
    assert.deepEqual(item().byClass('action').map(b => b.textContent), ['1 day', '3 days', '1 week', 'Cancel']);
    button('Cancel').click();
    assert.equal(item().byClass('choice').length, 0);
    assert.ok(button('Remind later'), 'Cancel puts the card back');
    assert.equal(calls().length, 0, 'nothing runs until a length is picked');

    button('Remind later').click();
    button('3 days').click();
    const snooze = calls().at(-1);
    assert.deepEqual(snooze.params, { name: 'snooze_card', arguments: { card_type: 'reminder', card_id: 'a', days: 3 } });
    assert.ok(item().byClass('action').every(b => b.disabled), 'buttons wait for the answer');
    // Snoozing unpins, and the card shows what Cardlake reports.
    view.deliver({ jsonrpc: '2.0', id: snooze.id, result: { content: [], structuredContent: { card_type: 'reminder', card_id: 'a', pinned_at: null, liked_at: null, snoozed_until: '2999-01-01T00:00:00Z' } } });
    await view.settle();
    assert.match(item().textContent, /Snoozed/);
    assert.doesNotMatch(item().textContent, /Pinned/);

    button('Bring back now').click();
    const unsnooze = calls().at(-1);
    assert.deepEqual(unsnooze.params, { name: 'unsnooze_card', arguments: { card_type: 'reminder', card_id: 'a' } });
    view.deliver({ jsonrpc: '2.0', id: unsnooze.id, result: { content: [], structuredContent: { card_type: 'reminder', card_id: 'a', pinned_at: null, liked_at: null, snoozed_until: null } } });
    await view.settle();
    assert.doesNotMatch(item().textContent, /Snoozed/);
    assert.ok(button('Remind later'));

    const text = view.sent.filter(m => m.method === 'ui/update-model-context').at(-1).params.content[0].text;
    assert.match(text, /snoozed the reminder "Call the dentist" \(reminder a\) for 3 days/);
    assert.match(text, /brought back the reminder "Call the dentist"/);
  },

  // Delete asks on the card first: a deleted card can't be restored from the
  // app, and the model is told to confirm before deleting too.
  async view_deletes_only_after_confirming() {
    const view = await connected({}, { serverTools: {}, updateModelContext: { text: {} } });
    view.deliver(toolResult({ cards: [card({ id: 'w', type: 'work', title: 'Ship it' }), card({ id: 'b', type: 'bookmark', title: 'Docs' })], next_cursor: null, view: 'active', integrations: [], stats: {} }));
    const item = index => view.root.byClass('card')[index];
    const button = (index, label) => item(index).byClass('action').find(b => b.textContent === label);
    const calls = () => view.sent.filter(m => m.method === 'tools/call');

    button(0, 'Delete').click();
    assert.equal(calls().length, 0, 'one click only asks');
    assert.match(item(0).byClass('choice')[0].textContent, /Delete this card\? It can't be restored from the app\./);
    assert.deepEqual(item(0).byClass('action').map(b => b.textContent), ['Delete', 'Cancel']);
    button(0, 'Cancel').click();
    assert.equal(calls().length, 0);
    assert.ok(button(0, 'Pin'), 'Cancel puts the card back');

    button(0, 'Delete').click();
    button(0, 'Delete').click();
    const del = calls().at(-1);
    assert.deepEqual(del.params, { name: 'delete_work_item', arguments: { id: 'w' } });
    view.deliver({ jsonrpc: '2.0', id: del.id, result: { content: [], structuredContent: { deleted: true } } });
    await view.settle();
    assert.equal(item(0).textContent, 'Deleted "Ship it".');
    assert.equal(item(0).byClass('action').length, 0, 'nothing on a deleted card can be clicked');
    assert.match(view.sent.filter(m => m.method === 'ui/update-model-context').at(-1).params.content[0].text, /deleted the work item "Ship it" \(work w\)/);

    // A host that refuses the delete leaves the card as it was.
    button(1, 'Delete').click();
    button(1, 'Delete').click();
    const refused = calls().at(-1);
    assert.deepEqual(refused.params, { name: 'delete_bookmark', arguments: { id: 'b' } });
    view.deliver({ jsonrpc: '2.0', id: refused.id, error: { code: -32600, message: 'User declined' } });
    await view.settle();
    assert.equal(item(1).byClass('notice')[0].textContent, "Couldn't delete this card here. Ask the assistant instead.");
    assert.ok(button(1, 'Delete') && !button(1, 'Delete').disabled);
    assert.match(item(1).textContent, /Docs/);
  },

  // A click runs the tool through the host, and the card shows the result.
  async view_pins_and_likes_through_the_host() {
    const view = await connected({}, { serverTools: {}, updateModelContext: { text: {} } });
    view.deliver(toolResult({ cards: [card({ id: 'a', type: 'bookmark', title: 'Docs' })], next_cursor: null, view: 'active', integrations: [], stats: {} }));
    const button = label => view.root.byClass('card')[0].byClass('action').find(b => b.textContent === label);
    const answer = (request, structuredContent) => view.deliver({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent } });
    const lastCall = () => view.sent.filter(m => m.method === 'tools/call').at(-1);

    button('Pin').click();
    const pin = lastCall();
    assert.deepEqual(pin.params, { name: 'pin_card', arguments: { card_type: 'bookmark', card_id: 'a' } });
    assert.ok(view.root.byClass('card')[0].byClass('action').every(b => b.disabled), 'buttons wait for the answer');
    answer(pin, { card_type: 'bookmark', card_id: 'a', pinned_at: '2026-09-27T10:00:00Z', liked_at: null, snoozed_until: null });
    await view.settle();
    assert.match(view.root.byClass('card')[0].textContent, /Pinned/);
    assert.equal(button('Unpin').getAttribute('aria-pressed'), 'true');
    assert.ok(!button('Unpin').disabled);

    button('Like').click();
    assert.equal(lastCall().params.name, 'like_card');
    answer(lastCall(), { card_type: 'bookmark', card_id: 'a', pinned_at: '2026-09-27T10:00:00Z', liked_at: '2026-09-27T10:01:00Z', snoozed_until: null });
    await view.settle();
    assert.match(view.root.byClass('card')[0].textContent, /Pinned.*Liked/);

    button('Unpin').click();
    assert.equal(lastCall().params.name, 'unpin_card');
    answer(lastCall(), { card_type: 'bookmark', card_id: 'a', pinned_at: null, liked_at: '2026-09-27T10:01:00Z', snoozed_until: null });
    await view.settle();
    assert.doesNotMatch(view.root.byClass('card')[0].textContent, /Pinned/);
    assert.ok(button('Pin'));

    // The model is told what the user changed, so it isn't working from a
    // stale picture. Each update carries every change so far.
    const context = view.sent.filter(m => m.method === 'ui/update-model-context').at(-1);
    assert.ok(context, 'model context updated');
    const text = context.params.content.map(c => c.text).join('\n');
    assert.match(text, /pinned the bookmark "Docs"/);
    assert.match(text, /liked the bookmark "Docs"/);
    assert.match(text, /unpinned the bookmark "Docs"/);
  },

  // Without updateModelContext the view doesn't send it.
  async view_only_updates_model_context_when_the_host_supports_it() {
    const view = await connected({}, { serverTools: {} });
    view.deliver(toolResult({ card: card({ id: 'a' }) }));
    view.root.byClass('card')[0].byClass('action')[1].click();
    const call = view.sent.filter(m => m.method === 'tools/call').at(-1);
    assert.equal(call.params.name, 'like_card');
    view.deliver({ jsonrpc: '2.0', id: call.id, result: { content: [], structuredContent: { card_type: 'reminder', card_id: 'a', pinned_at: null, liked_at: '2026-09-27T10:00:00Z', snoozed_until: null } } });
    await view.settle();
    assert.match(view.root.byClass('card')[0].textContent, /Liked/);
    assert.equal(view.sent.filter(m => m.method === 'ui/update-model-context').length, 0);
  },

  // Failures say why on the card and leave its state as it was.
  async view_shows_why_an_action_failed() {
    const view = await connected({}, { serverTools: {} });
    view.deliver(toolResult({ cards: [card({ id: 'a' })], next_cursor: null, view: 'active', integrations: [], stats: {} }));
    const item = () => view.root.byClass('card')[0];
    const pinButton = () => item().byClass('action')[0];

    pinButton().click();
    let call = view.sent.filter(m => m.method === 'tools/call').at(-1);
    view.deliver({ jsonrpc: '2.0', id: call.id, result: { isError: true, content: [{ type: 'text', text: 'Error: You can only pin up to 3 cards. Unpin one first.' }] } });
    await view.settle();
    assert.equal(item().byClass('notice')[0].textContent, 'You can only pin up to 3 cards. Unpin one first.');
    assert.doesNotMatch(item().textContent, /Pinned/);
    assert.equal(pinButton().textContent, 'Pin');
    assert.ok(!pinButton().disabled);

    // The host refusing the call (e.g. a read-only connection without the tool).
    pinButton().click();
    call = view.sent.filter(m => m.method === 'tools/call').at(-1);
    view.deliver({ jsonrpc: '2.0', id: call.id, error: { code: -32602, message: 'Tool pin_card not found' } });
    await view.settle();
    assert.equal(item().byClass('notice')[0].textContent, "Couldn't pin this card here. Ask the assistant instead.");
    assert.ok(!pinButton().disabled);
  },
};

const name = process.argv[2];
if (!scenarios[name]) {
  console.error(`Unknown scenario "${name}". Known: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}
scenarios[name]().then(() => process.exit(0), error => { console.error(error.stack || error); process.exit(1); });
