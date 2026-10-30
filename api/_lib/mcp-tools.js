const { z } = require('zod');
const { getSql } = require('./db');
const { normalizeEntry } = require('./db');
const { validate, checkLinkUrl } = require('./resources');
const configs = require('./resource-configs');
const { getIntegrations, publicIntegrationList } = require('./integrations');
const { cardCounts, runGithubSync } = require('./integration-handlers');
const feed = require('../feed');
const vault = require('../vault');
const { assertCardCreateAllowed, assertCardUpdateAllowed } = require('./limits');
const { DEFAULT_TENANT } = require('./auth');
const { recordEvents } = require('./events');
const { CARDS_VIEW_META } = require('./mcp-app');
const { RECURRENCES } = require('./recurrence');
const { SORTS } = require('./feed-ranking');

const RECURRENCE = z.enum([...RECURRENCES, 'none']).nullable();
// See parseDateInput in resources.js for why a time needs its zone.
const DATE_HELP = 'A day as "2026-09-20", or a time with the person\'s UTC offset, e.g. "2026-09-20T09:00:00+05:30" (a time without an offset is refused, since Cardlake can\'t know the person\'s zone).';
const FEED_TYPES = feed.TYPES; // ['reminder','learning','kanban','work','family','bookmark','talking_point','file']
const FEED_TYPE_ENUM = z.enum(FEED_TYPES);
const LEARNING_STATUS = ['saved', 'watched', 'skimmed'];
const LEARNING_CATEGORY = ['ai', 'others'];

// Tool annotations: hints clients use to decide when to ask the user before a
// call (e.g. confirm a delete, run a read without asking). Every tool sets all
// four so none falls back to the spec's "may be destructive" default.
const READS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const CREATES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
// Applying the same update or feed action twice leaves the card as once would.
const REPEATABLE_WRITES = { ...CREATES, idempotentHint: true };
// An update overwrites what the card held (and can clear a field), with no undo
// in the app, so it is marked destructive, as OpenAI's tool scan requires.
const UPDATES = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const DELETES = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// Output schemas: the shape of a tool's structuredContent. The SDK turns a
// result that doesn't match into an error, and clients check it too, so each
// schema requires only fields that are always present and uses looseObject:
// a plain z.object becomes "additionalProperties: false", and any new field
// would then break the tool.
const when = z.string().nullable();
const CARD = z.looseObject({
  id: z.string(),
  type: FEED_TYPE_ENUM,
  title: z.string().nullable(),
  subtitle: z.string().nullable(),
  body: z.string().nullable(),
  metadata: z.looseObject({}).describe('Type-specific fields, e.g. url, status, due_date, checklist items.'),
  created_at: when,
  pinned_at: when,
  liked_at: when,
  remind_later_until: when.describe('Set while the card is snoozed.'),
});
const INTEGRATION = z.looseObject({
  id: z.string(),
  name: z.string(),
  status: z.string().describe('not_started, onboarding, connected, error or disconnected.'),
  repo: z.string().nullable(),
  last_synced_at: when,
  last_sync_error: z.string().nullable(),
  card_count: z.number(),
});
const COUNTS = {
  learning_entries: z.number(), kanban_items: z.number(), work_items: z.number(),
  family_updates: z.number(), bookmarks: z.number(), talking_points: z.number(), reminders: z.number(),
};
const FEED_PAGE = z.looseObject({
  cards: z.array(CARD),
  next_cursor: z.string().nullable().describe('Pass as cursor to get the next page; null on the last page.'),
  view: z.string(),
  sort: z.enum(SORTS).describe('The order the cards are in: "ai" or "newest".'),
  integrations: z.array(INTEGRATION),
  stats: z.looseObject({ ...COUNTS, pinned_cards: z.number(), max_pinned: z.number(), snoozed_count: z.number(), streak_days: z.number() }),
});
const SEARCH_RESULT = z.looseObject({
  cards: z.array(CARD),
  next_cursor: z.string().nullable().describe('Pass as cursor to get the next page; null on the last page.'),
  total: z.number().describe('How many cards match in all.'),
});
const ACCOUNT = z.looseObject({ account_id: z.string(), email: z.string().nullable(), display_name: z.string().nullable() });
const FEED_ACTION_RESULT = z.looseObject({
  card_type: FEED_TYPE_ENUM,
  card_id: z.string(),
  pinned_at: when,
  liked_at: when,
  snoozed_until: when.describe('Set while the card is snoozed.'),
});
const DELETE_RESULT = z.looseObject({ deleted: z.boolean() });
const SYNC_RESULT = z.looseObject({ synced: z.number(), last_synced_at: when });

// The same data twice: as text for clients that predate structured results
// (the spec asks for both), and as structuredContent. The JSON round trip
// turns Dates into the ISO strings the text shows, so the two always match.
function ok(data) {
  const text = JSON.stringify(data, null, 2);
  const result = { content: [{ type: 'text', text }] };
  if (data && typeof data === 'object' && !Array.isArray(data)) result.structuredContent = JSON.parse(text);
  return result;
}
// Results carry only what the assistant asked about. Stored rows also hold
// the account email and bookkeeping (row order, update and delete stamps);
// the assistant has no use for them, and app directories ask that tools not
// return them. A reminder's remind_at column is retired: Cardlake sends no
// notifications, so a reminder time would promise something that never comes.
const BOOKKEEPING = ['user_email', 'sort_order', 'updated_at', 'deleted_at', 'remind_at'];
function publicCard(row) {
  if (!row || typeof row !== 'object') return row;
  const card = { ...row };
  for (const field of BOOKKEEPING) delete card[field];
  return card;
}

// Cards read from the feed carry row order and a dismissed stamp that exist
// for the app's own sorting and hiding. The assistant has no use for either
// (a dismissed card is never returned), so they are dropped here, not in
// api/feed.js, which the web app reads as is.
function feedCard(card) {
  if (!card || typeof card !== 'object') return card;
  const { sort_order, dismissed_at, ...rest } = card;
  return rest;
}

// A feed action reports the card and its pin / like / snooze state now, not
// the feed_state row behind it (its own id, the account email, timestamps).
function feedActionResult(cardType, cardId, { feed_state: state }) {
  return {
    card_type: cardType,
    card_id: cardId,
    pinned_at: state?.pinned_at ?? null,
    liked_at: state?.liked_at ?? null,
    snoozed_until: state?.remind_later_until ?? null,
  };
}

function fail(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}
// The tools that return many cards at once. Like feed.served on the web,
// their event keeps which cards, in order, so a later like or snooze from the
// assistant can be measured against what it was given. Returned to the
// assistant is weaker than seen: it may show the person only some of them.
// The filter values kept are the enum-like ones; search text is not.
const CARD_LIST_TOOLS = new Set(['list_feed', 'search_cards']);
const LISTED_FILTERS = ['types', 'category', 'status', 'liked_only', 'sort', 'cursor'];

function cardsReturned(name, args, result) {
  const page = result?.structuredContent;
  if (!CARD_LIST_TOOLS.has(name) || result?.isError || !Array.isArray(page?.cards)) return {};
  const context = { cards: page.cards.map(card => [card.type, card.id]) };
  if (page.view) context.view = page.view;
  for (const key of LISTED_FILTERS) if (args[key] !== undefined) context[key] = args[key];
  return context;
}

// Every tool call is the user acting through an AI client, so each one goes
// into the event log (events.js) before its result is returned -- the
// function may be frozen once it has answered. Arguments are recorded by
// name only; the ids of the card involved are kept.
function withToolEvent(tenant, name, handler) {
  return async (input, extra) => {
    const result = await handler(input, extra);
    const args = input && typeof input === 'object' ? input : {};
    const createdId = !result?.isError && name.startsWith('create_') ? result.structuredContent?.id || null : null;
    await recordEvents([{
      user_email: tenant,
      source: 'mcp',
      event_type: `mcp.${name}`,
      item_type: args.card_type,
      item_id: args.card_id || args.id || createdId,
      context: { ok: !result?.isError, args: Object.keys(args), ...cardsReturned(name, args, result) },
    }]);
    return result;
  };
}

// Database errors are for Cardlake, not for the assistant: a duplicate title
// reads as what happened and what to do, not as a Postgres constraint name.
function messageFor(error) {
  if (error?.code === '23505') return 'A card with that title already exists. Use a different title, or find the existing card with search_cards and update it.';
  return error?.message || String(error);
}

function wrap(fn) {
  return async input => {
    try {
      return ok(await fn(input || {}));
    } catch (error) {
      return fail(messageFor(error));
    }
  };
}

// Registers create/update/delete tools for a resource-configs.js-backed type,
// scoped to one tenant. Delete goes through the feed's dismiss action rather
// than config.remove() directly so it also clears feed_state (likes/pins/
// snoozes) and purges any attachments, matching what swiping "Delete" in
// the feed does.
function registerResourceTools(server, tenant, config, opts) {
  const { name, title, createSchema, updateSchema, guardCreate, guardMutate } = opts;

  server.registerTool(`create_${name}`, {
    title: `Create ${title}`,
    description: opts.createDescription,
    annotations: CREATES,
    inputSchema: createSchema,
  }, wrap(async input => {
    const sql = getSql();
    if (guardCreate) await guardCreate(sql, tenant);
    const values = validate(input, config, true);
    await assertCardCreateAllowed(sql, tenant, config.feedType, values);
    const rows = await config.create(sql, tenant, values);
    return publicCard(rows[0]);
  }));

  server.registerTool(`update_${name}`, {
    title: `Update ${title}`,
    description: opts.updateDescription,
    annotations: UPDATES,
    inputSchema: updateSchema,
  }, wrap(async ({ id, ...rest }) => {
    const sql = getSql();
    if (guardMutate) await guardMutate(sql, tenant, id);
    const values = validate(rest, config, false);
    await assertCardUpdateAllowed(sql, tenant, config.feedType, id, values);
    const rows = await config.update(sql, tenant, id, values);
    if (!rows.length) throw new Error(`${title} not found`);
    return publicCard(rows[0]);
  }));

  server.registerTool(`delete_${name}`, {
    title: `Delete ${title}`,
    description: deleteDescription(title.toLowerCase()),
    annotations: DELETES,
    inputSchema: z.object({ id: z.string().uuid().describe(`The ${title.toLowerCase()}'s id`) }),
    outputSchema: DELETE_RESULT,
  }, wrap(async ({ id }) => {
    const sql = getSql();
    if (guardMutate) await guardMutate(sql, tenant, id);
    return await feed.applyFeedAction(sql, tenant, 'dismiss', config.feedType, id);
  }));
}

// Delete is the feed's dismiss: the row is marked deleted, not erased, so the
// description says what the user sees rather than promising "permanently".
function deleteDescription(noun) {
  return `Delete a ${noun} by id. It disappears from Cardlake along with its pins, likes and attachments, and can't be restored from the app. Use list_feed first if you don't already have the id.`;
}

// "snooze_card" -> "Snooze Card", matching the other tools' titles in the
// clients' tool lists and permission settings.
const titleCase = name => name.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

function registerFeedActionTool(server, tenant, name, action, description, extraInput = {}) {
  server.registerTool(name, {
    title: titleCase(name),
    description,
    annotations: REPEATABLE_WRITES,
    inputSchema: z.object({
      card_type: FEED_TYPE_ENUM.describe("The card's type, as returned by list_feed."),
      card_id: z.string().uuid().describe("The card's id, as returned by list_feed."),
      ...extraInput,
    }),
    outputSchema: FEED_ACTION_RESULT,
  }, wrap(async ({ card_type, card_id, ...options }) => {
    const sql = getSql();
    return feedActionResult(card_type, card_id, await feed.applyFeedAction(sql, tenant, action, card_type, card_id, options));
  }));
}

// A cursor must be a next_cursor this server returned; see feed.isPageCursor.
function checkCursor(cursor) {
  if (cursor !== undefined && !feed.isPageCursor(cursor)) {
    throw new Error("Invalid cursor: pass the next_cursor from the previous call's result, or leave it out for the first page");
  }
}

// list_feed's filters, checked here so a value that can never match (a typo,
// another type's category) is an error that names the real values instead of
// an empty page that looks like "you have no such cards".
const FEED_CATEGORIES = ['ai', 'others', 'tech', 'business', 'personal', 'other'];
const FEED_STATUSES = ['saved', 'watched', 'skimmed', 'backlog', 'in_progress', 'done'];
function checkFilter(name, value, allowed) {
  if (value === undefined) return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.includes(normalized)) throw new Error(`Invalid ${name} "${value}": use one of ${allowed.join(', ')}`);
  return normalized;
}

// Learnings are written here rather than through resource-configs, so their
// title and link get the same checks the other card types get in validate().
function learningTitle(title) {
  const text = String(title ?? '').trim();
  if (!text) throw new Error('title is required');
  return text;
}

// tenant is resolved once per request (see api/mcp.js) from the caller's own
// personal access token (or, for backward compatibility, MCP_TOKEN mapping
// to the 'default' tenant) -- every tool registered here is scoped to it.
function registerTools(server, tenant, scopes = ['cardle.read', 'cardle.write']) {
  // ChatGPT reads tool-level OAuth metadata before invoking a Cardlake tool.
  // A personal API token is full access; OAuth tools are registered only when
  // their individual scope was actually granted. The bearer itself remains
  // verified by api/mcp.js on every request.
  const grantedScopes = new Set(scopes);
  const registerTool = server.registerTool.bind(server);
  const registerScopedTool = (scope, name, config, handler) => {
    if (!grantedScopes.has(scope)) return;
    registerTool(name, {
      ...config,
      // The Claude directory's submission form reads the title from the
      // annotations, so it is repeated there from the tool's own title.
      annotations: { ...config.annotations, title: config.title },
      securitySchemes: [{ type: 'oauth2', scopes: [scope] }],
    }, withToolEvent(tenant, name, handler));
  };
  const registerReadTool = (name, config, handler) => registerScopedTool('cardle.read', name, config, handler);
  server.registerTool = (name, config, handler) => registerScopedTool('cardle.write', name, config, handler);
  // --- Reads ---
  registerReadTool('list_feed', {
    title: 'List Feed Cards',
    annotations: READS,
    description:
      'List cards from the Cardlake feed, with optional filters. Returns reminders, learnings, work items, family updates, bookmarks, Misc cards (card type "talking_point"), standalone files, and GitHub issues (card type "kanban", synced read-only from a connected repository), plus pagination info and stats. Use it to browse; to find a particular card, search_cards is faster. Either gives the card\'s type and id, needed before updating, deleting, or applying a feed action (snooze/pin/like) to it.',
    inputSchema: z.object({
      view: z.enum(['active', 'snoozed']).optional().describe('"active" (default) is the normal feed; "snoozed" lists currently-snoozed cards.'),
      types: z.array(FEED_TYPE_ENUM).optional().describe('Restrict results to these card types. Omit to include all types.'),
      category: z.string().optional().describe(`Filter by category: a learning's (ai, others) or a bookmark's (tech, business, personal, other). One of: ${FEED_CATEGORIES.join(', ')}.`),
      status: z.string().optional().describe('Filter by status: a learning\'s (saved; watched and skimmed are finished, so they show in search_cards, not the feed) or a GitHub issue\'s: backlog (open, unassigned), in_progress (open, assigned), done (closed).'),
      liked_only: z.boolean().optional().describe('Only return cards you have liked.'),
      sort: z.enum(SORTS).optional().describe('"ai" (default) puts due and overdue reminders, work under way and liked cards first, mixed by type, in the order the Cardlake web app shows. "newest" lists by date added, newest first. Pinned cards come first either way; the snoozed view always lists by when cards come back. Pass the same sort with a cursor.'),
      cursor: z.string().optional().describe("Pagination cursor from a previous call's next_cursor."),
      limit: z.number().int().min(1).max(50).optional().describe('Max cards to return (default 20, max 50).'),
    }),
    outputSchema: FEED_PAGE,
    _meta: {
      ...CARDS_VIEW_META,
      'openai/toolInvocation/invoking': 'Loading your feed…',
      'openai/toolInvocation/invoked': 'Loaded your feed.',
    },
  }, wrap(async input => {
    const sql = getSql();
    checkCursor(input.cursor);
    const response = await feed.buildFeedResponse(sql, tenant, {
      view: input.view,
      types: Array.isArray(input.types) ? input.types.join(',') : undefined,
      category: checkFilter('category', input.category, FEED_CATEGORIES),
      status: checkFilter('status', input.status, FEED_STATUSES),
      liked: input.liked_only ? 'true' : undefined,
      sort: input.sort,
      cursor: input.cursor,
      limit: input.limit != null ? String(input.limit) : undefined,
    });
    return { ...response, cards: response.cards.map(feedCard) };
  }));

  registerReadTool('search_cards', {
    title: 'Search Cards',
    annotations: READS,
    description: 'Find cards by text. Every word of the query must appear, in any order and any case, in a card\'s title, text or URL, or a GitHub issue\'s number or labels. Covers active, snoozed and finished cards (completed reminders, watched learnings, closed issues), newest first. Use get_card to read one result in full.',
    inputSchema: z.object({
      query: z.string().trim().min(1).max(100).describe('Words to look for, e.g. "dentist" or "react hooks".'),
      types: z.array(FEED_TYPE_ENUM).optional().describe('Only search these card types. Omit to search all.'),
      limit: z.number().int().min(1).max(50).optional().describe('Max cards to return (default 10, max 50).'),
      cursor: z.string().optional().describe("Pagination cursor from a previous call's next_cursor."),
    }),
    outputSchema: SEARCH_RESULT,
    _meta: {
      ...CARDS_VIEW_META,
      'openai/toolInvocation/invoking': 'Searching your cards…',
      'openai/toolInvocation/invoked': 'Found cards.',
    },
  }, wrap(async ({ query, types, limit, cursor }) => {
    checkCursor(cursor);
    const found = await feed.searchCards(getSql(), tenant, { query, types, limit, cursor });
    return { ...found, cards: found.cards.map(feedCard) };
  }));

  registerReadTool('get_card', {
    title: 'Get Card',
    annotations: READS,
    description: 'Get one card in full by its type and id (from list_feed or search_cards): its text, type-specific fields such as a checklist, URL or due date, its attachments, and whether it is pinned, liked or snoozed.',
    inputSchema: z.object({
      card_type: FEED_TYPE_ENUM.describe("The card's type, as returned by list_feed or search_cards."),
      card_id: z.string().uuid().describe("The card's id, as returned by list_feed or search_cards."),
    }),
    outputSchema: z.looseObject({ card: CARD }),
    _meta: {
      ...CARDS_VIEW_META,
      'openai/toolInvocation/invoking': 'Loading the card…',
      'openai/toolInvocation/invoked': 'Loaded the card.',
    },
  }, wrap(async ({ card_type, card_id }) => {
    // One message for every miss, so an id can't be probed for whether it
    // exists in another account.
    const card = await feed.getCard(getSql(), tenant, card_type, card_id);
    if (!card) throw new Error('Card not found');
    return { card: feedCard(card) };
  }));

  registerReadTool('get_dashboard_stats', {
    title: 'Get Dashboard Stats',
    annotations: READS,
    description: 'Get how many cards of each type are saved: reminders, learnings, kanban items (GitHub issues and any older hand-made cards), work items, family updates, bookmarks and Misc cards (counted as talking_points). The counts include finished cards (completed reminders, watched learnings, ticked-off checklists), which are no longer in the active feed; list_feed returns only cards still in the feed.',
    inputSchema: z.object({}),
    outputSchema: z.looseObject(COUNTS),
  }, wrap(async () => {
    const sql = getSql();
    return await vault.getDashboardStats(sql, tenant);
  }));

  // An account is identified by its email (every table's user_email is the
  // tenant), and Cardlake has no workspaces or orgs, so there is nothing else
  // to report. The shared tenant behind MCP_TOKEN has no email or profile.
  registerReadTool('get_account', {
    title: 'Get Account',
    annotations: READS,
    description: 'Get the Cardlake account this session is authenticated as: its account id, email, and display name. Use to confirm which Cardlake account this session is authenticated as, e.g. for debugging or multi-account setups.',
    inputSchema: z.object({}),
    outputSchema: ACCOUNT,
  }, wrap(async () => {
    if (tenant === DEFAULT_TENANT) return { account_id: tenant, email: null, display_name: null };
    const sql = getSql();
    const rows = await sql`select name from users where email = ${tenant} limit 1`;
    return { account_id: tenant, email: tenant, display_name: rows[0]?.name || null };
  }));

  // --- Feed actions (apply to any card type) ---
  registerFeedActionTool(server, tenant, 'snooze_card', 'remind_later', 'Snooze a card so it drops out of the active feed for a number of days (default 1) and comes back after. A pinned card is unpinned, freeing its pin slot. Finished cards (a completed reminder, a watched learning) are not in the feed and can\'t be snoozed.', {
    days: z.number().int().min(1).max(feed.MAX_SNOOZE_DAYS).optional().describe(`How many days to snooze for, 1 to ${feed.MAX_SNOOZE_DAYS} (default 1). "Snooze for a week" is 7.`),
  });
  registerFeedActionTool(server, tenant, 'unsnooze_card', 'unremind_later', 'Bring a snoozed card back into the active feed immediately.');
  registerFeedActionTool(server, tenant, 'pin_card', 'pin', 'Pin a card to the top of the feed. Up to 3 cards can be pinned at once. Finished cards are not in the feed and can\'t be pinned.');
  registerFeedActionTool(server, tenant, 'unpin_card', 'unpin', 'Unpin a previously pinned card.');
  registerFeedActionTool(server, tenant, 'like_card', 'like', 'Like/favorite a card.');
  registerFeedActionTool(server, tenant, 'unlike_card', 'unlike', 'Remove a card from favorites.');

  // --- Reminders ---
  registerResourceTools(server, tenant, configs.reminders, {
    name: 'reminder',
    title: 'Reminder',
    createDescription: 'Create a new reminder card.',
    updateDescription: 'Update an existing reminder. Only the fields provided are changed. Completing a recurring reminder does not close it: it moves to its next due date and is snoozed until then. Set recurrence to "none" to stop it repeating.',
    createSchema: z.object({
      title: z.string().min(1).describe('The reminder text.'),
      due_date: z.string().optional().describe(DATE_HELP),
      completed: z.boolean().optional().describe('Whether it is already completed (default false). A repeating reminder created as completed moves to its next occurrence.'),
      recurrence: RECURRENCE.optional().describe('How often it repeats. Omit or "none" for a one-off reminder.'),
    }),
    updateSchema: z.object({
      id: z.string().uuid(),
      title: z.string().min(1).optional(),
      due_date: z.string().nullable().optional().describe(`${DATE_HELP} null removes the due date.`),
      completed: z.boolean().optional(),
      recurrence: RECURRENCE.optional().describe('"none" stops it repeating.'),
    }),
  });

  // --- Learnings (bespoke API, not resource-configs-backed) ---
  server.registerTool('create_learning', {
    title: 'Create Learning',
    annotations: CREATES,
    description: 'Create a new learning entry (an article, video, or course to save, watch, or read).',
    inputSchema: z.object({
      title: z.string().min(1),
      url: z.string().optional(),
      notes: z.string().optional(),
      status: z.enum(LEARNING_STATUS).describe('saved = not started, watched/skimmed = finished.'),
      category: z.enum(LEARNING_CATEGORY),
    }),
  }, wrap(async input => {
    const { notes, status, category } = input;
    const title = learningTitle(input.title);
    const url = checkLinkUrl(input.url);
    const sql = getSql();
    await assertCardCreateAllowed(sql, tenant, 'learning', { title, url, notes });
    const existing = await sql`select coalesce(max(sort_order), -1) as max_sort_order from learning_entries where deleted_at is null and user_email = ${tenant} and category = ${category}`;
    const nextSortOrder = Number(existing[0]?.max_sort_order ?? -1) + 1;
    const rows = await sql`
      insert into learning_entries (user_email, title, url, notes, status, category, sort_order)
      values (${tenant}, ${title}, ${url || null}, ${notes || ''}, ${status}, ${category}, ${nextSortOrder})
      returning *
    `;
    return publicCard(normalizeEntry(rows[0]));
  }));

  server.registerTool('update_learning', {
    title: 'Update Learning',
    annotations: UPDATES,
    description: 'Update an existing learning entry. Only the fields provided are changed.',
    inputSchema: z.object({
      id: z.string().uuid(),
      title: z.string().min(1).optional(),
      url: z.string().optional(),
      notes: z.string().optional(),
      status: z.enum(LEARNING_STATUS).optional(),
      category: z.enum(LEARNING_CATEGORY).optional(),
    }),
  }, wrap(async ({ id, ...updates }) => {
    if ('title' in updates) updates.title = learningTitle(updates.title);
    if ('url' in updates) updates.url = checkLinkUrl(updates.url);
    const sql = getSql();
    const current = await sql`select * from learning_entries where id = ${id} and user_email = ${tenant} and deleted_at is null`;
    if (!current.length) throw new Error('Learning entry not found');
    const entry = current[0];
    await assertCardUpdateAllowed(sql, tenant, 'learning', id, updates);
    const rows = await sql`
      update learning_entries
      set
        title = ${updates.title ?? entry.title},
        url = ${'url' in updates ? (updates.url || null) : entry.url},
        notes = ${'notes' in updates ? updates.notes : entry.notes},
        status = ${updates.status ?? entry.status},
        category = ${updates.category ?? entry.category}
      where id = ${id} and user_email = ${tenant}
      returning *
    `;
    return publicCard(normalizeEntry(rows[0]));
  }));

  server.registerTool('delete_learning', {
    title: 'Delete Learning',
    description: deleteDescription('learning entry'),
    annotations: DELETES,
    inputSchema: z.object({ id: z.string().uuid() }),
    outputSchema: DELETE_RESULT,
  }, wrap(async ({ id }) => {
    const sql = getSql();
    return await feed.applyFeedAction(sql, tenant, 'dismiss', 'learning', id);
  }));

  // --- Integrations ---
  // GitHub issues are synced from GitHub, never created or edited here, so
  // there are no create/update/delete tools for them: list_feed reads them,
  // and the feed action tools (snooze/pin/like) work on them like any card.
  registerReadTool('list_integrations', {
    title: 'List Integrations',
    annotations: READS,
    description: 'List the outside services Cardlake can pull cards from (currently GitHub Issues) and their state: not_started, onboarding, connected, error, or disconnected, plus the connected repository, last sync time and error, and how many cards each has synced. Setting one up happens in the Cardlake web app.',
    inputSchema: z.object({}),
    outputSchema: z.looseObject({ integrations: z.array(INTEGRATION) }),
  }, wrap(async () => {
    const sql = getSql();
    return { integrations: publicIntegrationList(await getIntegrations(sql, tenant), await cardCounts(sql, tenant)) };
  }));

  server.registerTool('sync_github_issues', {
    title: 'Sync GitHub Issues',
    // Reaches GitHub, an outside service, on the user's behalf.
    annotations: { ...REPEATABLE_WRITES, openWorldHint: true },
    description: 'Pull the latest issues from the connected GitHub repository into the feed now. Fails if GitHub Issues is not connected (see list_integrations).',
    inputSchema: z.object({}),
    outputSchema: SYNC_RESULT,
  }, wrap(async () => runGithubSync(getSql(), tenant)));

  // --- Work items ---
  const workItemSchema = z.object({ text: z.string(), completed: z.boolean().optional() });
  registerResourceTools(server, tenant, configs.work, {
    name: 'work_item',
    title: 'Work Item',
    createDescription: 'Create a new work item, optionally with a checklist of sub-items.',
    updateDescription: 'Update an existing work item. Only the fields provided are changed; passing items replaces the whole checklist.',
    createSchema: z.object({
      title: z.string().min(1),
      items: z.array(workItemSchema).optional().describe('Checklist entries, each with text and an optional completed flag.'),
    }),
    updateSchema: z.object({
      id: z.string().uuid(),
      title: z.string().min(1).optional(),
      items: z.array(workItemSchema).optional(),
    }),
  });

  // --- Family updates ---
  registerResourceTools(server, tenant, configs.family, {
    name: 'family_update',
    title: 'Family Update',
    createDescription: 'Create a new family update card.',
    updateDescription: 'Update an existing family update. Only the fields provided are changed.',
    createSchema: z.object({
      person: z.string().min(1).describe('Who this update is about.'),
      content: z.string().min(1),
    }),
    updateSchema: z.object({
      id: z.string().uuid(),
      person: z.string().min(1).optional(),
      content: z.string().min(1).optional(),
    }),
  });

  // --- Bookmarks ---
  registerResourceTools(server, tenant, configs.bookmarks, {
    name: 'bookmark',
    title: 'Bookmark',
    createDescription: 'Create a new bookmark.',
    updateDescription: 'Update an existing bookmark. Only the fields provided are changed.',
    createSchema: z.object({
      title: z.string().min(1),
      url: z.string().optional(),
      notes: z.string().optional(),
      category: z.enum(['tech', 'business', 'personal', 'other']).optional().describe('Default: other.'),
    }),
    updateSchema: z.object({
      id: z.string().uuid(),
      title: z.string().min(1).optional(),
      url: z.string().optional(),
      notes: z.string().optional(),
      category: z.enum(['tech', 'business', 'personal', 'other']).optional(),
    }),
  });

  // --- Misc (card type talking_point) ---
  registerResourceTools(server, tenant, configs.talkingPoints, {
    name: 'talking_point',
    title: 'Misc Card',
    createDescription: 'Create a new Misc card (card type "talking_point") for anything that doesn\'t fit another type.',
    updateDescription: 'Update an existing Misc card (card type "talking_point"). Only the fields provided are changed.',
    createSchema: z.object({
      section_title: z.string().min(1),
      content: z.string().min(1),
      subsection_of: z.string().uuid().optional().describe('Id of a parent Misc card, if this is a subsection.'),
    }),
    updateSchema: z.object({
      id: z.string().uuid(),
      section_title: z.string().min(1).optional(),
      content: z.string().min(1).optional(),
      subsection_of: z.string().uuid().nullable().optional().describe('Id of a parent Misc card; null makes it a top-level card again.'),
    }),
  });
}

module.exports = { registerTools };
