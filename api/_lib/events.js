// Every user action, recorded append-only in user_events, so recommendations
// can learn from what people actually do. feed_state keeps only each card's
// latest state (an unlike erases the like there); here both remain, in order.
//
// Three sources feed it (docs/USER_EVENTS.md lists every event type):
//   - every API request that changes something, plus each feed page served:
//     withEventLog(), which withSessionGuard() applies to every function;
//   - every MCP tool call (mcp-tools.js) -- AI clients act for the user too;
//   - what only the browser sees -- cards shown and opened, links followed,
//     searches, filters -- posted in batches to /api/events by aurora-feed.js.
//
// A handler names its action by setting req.cardleEvent = { type, item_type,
// item_id, context }; a write it doesn't name is still recorded generically
// (method, route, status). Request bodies are never copied in: they can carry
// credentials (GitHub tokens, OAuth codes). Recording never fails the user's
// action -- errors are logged and swallowed.
'use strict';

const { getSessionPayload, isSyncTokenValid, DEFAULT_TENANT } = require('./auth');
const { readJson } = require('./http');
// Looked up at call time, like session-guard.js: tests and tools swap getSql.
const db = require('./db');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ROUTE_QUERY_KEYS = ['resource', 'action', 'provider', 'integration', 'id'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CONTEXT_BYTES = 4096;
const MAX_CLIENT_BATCH = 50;
const CARD_TYPES = new Set(['reminder', 'learning', 'kanban', 'work', 'family', 'bookmark', 'talking_point', 'file']);

// What the browser may report. Everything else a browser does that changes
// data already reaches the server as its own request and is recorded there.
const CLIENT_EVENT_TYPES = new Set([
  'card.impression',   // a card was at least half on screen for a second
  'card.open',         // detail view opened
  'card.close',        // detail view closed; context.dwell_ms
  'card.link_click',   // a link on a card or in its detail view
  'feed.search',
  'feed.filter',
  'feed.view',         // favorites / snoozed / back to the main feed
  'feed.sort',         // AI or date added
  'capture.open',      // the new-card sheet was opened
  'capture.quick_add', // a card saved from quick add; the guessed and saved types
  'settings.change',
]);

// Same DDL as schema-v2.sql (a test keeps them identical). Used only when an
// insert finds the table missing, i.e. before /api/migrate has been run.
const USER_EVENTS_DDL = [
  `create table if not exists user_events (
  id bigint generated always as identity primary key,
  user_email text not null,
  event_type text not null,
  source text not null default 'web',
  item_type text,
  item_id uuid,
  context jsonb not null default '{}'::jsonb,
  client_at timestamptz,
  created_at timestamptz not null default now()
)`,
  'create index if not exists user_events_user_time_idx on user_events (user_email, created_at desc)',
  'create index if not exists user_events_item_idx on user_events (user_email, item_type, item_id, created_at desc) where item_id is not null',
];

function boundedContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return {};
  const text = JSON.stringify(context);
  return Buffer.byteLength(text, 'utf8') <= MAX_CONTEXT_BYTES ? context : { truncated: true };
}

function eventRow(event) {
  return {
    user_email: event.user_email,
    event_type: String(event.event_type).slice(0, 100),
    source: event.source || 'web',
    item_type: CARD_TYPES.has(event.item_type) ? event.item_type : null,
    item_id: UUID_RE.test(event.item_id || '') ? event.item_id : null,
    context: boundedContext(event.context),
    client_at: event.client_at || null,
  };
}

async function insertEvents(sql, rows) {
  // One round trip for any number of events.
  await sql`
    insert into user_events (user_email, event_type, source, item_type, item_id, context, client_at)
    select user_email, event_type, source, item_type, item_id, coalesce(context, '{}'::jsonb), client_at
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
      as x(user_email text, event_type text, source text, item_type text, item_id uuid, context jsonb, client_at timestamptz)
  `;
}

// Returns whether the events were stored. Never throws.
async function recordEvents(events, sql = null) {
  const rows = events.filter(event => event && event.user_email && event.event_type).map(eventRow);
  if (!rows.length) return true;
  try {
    const client = sql || db.getSql();
    try {
      await insertEvents(client, rows);
    } catch (error) {
      if (!String(error?.message || '').includes('user_events')) throw error;
      for (const statement of USER_EVENTS_DDL) await client(statement);
      await insertEvents(client, rows);
    }
    return true;
  } catch (error) {
    console.error('[events] could not record', rows.map(row => row.event_type).join(', '), '-', error?.message || error);
    return false;
  }
}

// Who is acting: the owner's session is the person; the sync token is a machine
// writing to the shared tenant. Anonymous requests aren't anyone's actions.
function actorFor(req) {
  const email = getSessionPayload(req)?.email;
  if (email) return { user_email: email, source: 'web' };
  if (isSyncTokenValid(req)) return { user_email: DEFAULT_TENANT, source: 'sync' };
  return null;
}

function routeFor(req) {
  const path = String(req.url || '').split('?')[0];
  const query = {};
  for (const key of ROUTE_QUERY_KEYS) if (req.query?.[key]) query[key] = String(req.query[key]).slice(0, 100);
  return { path, query };
}

function requestEvent(req, res) {
  const described = req.cardleEvent;
  if (described === false) return null;
  if (!described && !MUTATING_METHODS.has(req.method)) return null;
  const actor = described?.user_email ? { user_email: described.user_email, source: 'web' } : actorFor(req);
  if (!actor) return null;
  const { path, query } = routeFor(req);
  return {
    ...actor,
    event_type: described?.type || 'api.request',
    item_type: described?.item_type,
    item_id: described?.item_id,
    context: { method: req.method, path, ...(Object.keys(query).length ? { query } : {}), status: res.statusCode, ...(described?.context || {}) },
  };
}

// Holds the response until its event is stored: once a serverless function
// has answered, the platform may freeze it, so recording afterwards could be
// lost. Only requests that produce an event wait (tens of milliseconds);
// every other response goes out untouched.
// Wrappers can stack (dev_server.js guards route files that already guard
// themselves); only the outermost one records.
const LOGGED = Symbol('cardle.eventLogged');

function withEventLog(handler) {
  return async function logged(req, res) {
    if (req[LOGGED]) return handler(req, res);
    req[LOGGED] = true;
    let pending = null;
    const hold = method => {
      const original = res[method];
      if (typeof original !== 'function') return;
      res[method] = function heldResponse(...args) {
        if (pending) return original.apply(res, args);
        const event = requestEvent(req, res);
        if (!event) { pending = Promise.resolve(); return original.apply(res, args); }
        pending = recordEvents([event]).then(() => original.apply(res, args));
        return res;
      };
    };
    hold('json');
    hold('end');
    await handler(req, res);
    await pending;
  };
}

// POST /api/events: a batch of browser-side events for the signed-in person.
// Signed-out visitors (and the demo feed, which never calls the API) get a
// quiet 204 -- a 401 here would only prompt a sign-in over a view count.
async function clientEventsHandler(req, res) {
  req.cardleEvent = false;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
  const email = getSessionPayload(req)?.email;
  if (!email) return res.status(204).end();
  let body;
  try { body = await readJson(req); } catch (_) { return res.status(400).json({ error: 'Invalid JSON body' }); }
  const incoming = Array.isArray(body?.events) ? body.events : [];
  if (incoming.length > MAX_CLIENT_BATCH) return res.status(413).json({ error: `Send at most ${MAX_CLIENT_BATCH} events at a time` });
  const now = Date.now();
  const events = incoming
    .filter(event => event && CLIENT_EVENT_TYPES.has(event.type))
    .map(event => {
      const at = Date.parse(event.at);
      return {
        user_email: email,
        source: 'web',
        event_type: event.type,
        item_type: event.item_type,
        item_id: event.item_id,
        context: event.context,
        // A client clock more than a day off is not worth keeping.
        client_at: Number.isFinite(at) && Math.abs(now - at) < 86400e3 ? new Date(at).toISOString() : null,
      };
    });
  await recordEvents(events);
  return res.status(204).end();
}

module.exports = { withEventLog, recordEvents, clientEventsHandler, CLIENT_EVENT_TYPES, USER_EVENTS_DDL };
