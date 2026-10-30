const { getSql } = require('./_lib/db');
const { withSessionGuard } = require('./_lib/session-guard');
const { resolveViewerTenant, resolveWriterTenant, DEFAULT_TENANT } = require('./_lib/auth');
const { readJson, sendError } = require('./_lib/http');
const Busboy = require('busboy');
const { put, get, del } = require('@vercel/blob');
const { purgeAttachments } = require('./_lib/attachments');
const { limits, LimitError, assertCardCreateAllowed, assertUploadAllowed, quotaSummaryFromSources } = require('./_lib/limits');
const { integrationForCardType } = require('./_lib/integration-registry');
const { getIntegrations, isIntegrationActive, publicIntegrationList } = require('./_lib/integrations');
const { sweepTrials } = require('./_lib/surprise');
const { sortCards, resolveSort } = require('./_lib/feed-ranking');
const { validateUpload } = require('./_lib/upload-validation');

const MAX_PINNED = 3;
const TYPES = ['reminder', 'learning', 'kanban', 'work', 'family', 'bookmark', 'talking_point', 'file'];
const TYPE_SET = new Set(TYPES);
const ATTACHABLE_TYPES = new Set(TYPES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asArray = value => {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch (_) { return []; }
};

const workComplete = items => {
  const list = asArray(items);
  return list.length > 0 && list.every(x => typeof x === 'object' && (x.completed || x.done || x.checked));
};

function archived(card) {
  return (
    (card.type === 'reminder' && card.metadata.completed) ||
    (card.type === 'kanban' && card.metadata.status === 'done') ||
    (card.type === 'learning' && ['watched', 'skimmed'].includes(card.metadata.status)) ||
    (card.type === 'work' && workComplete(card.metadata.items))
  );
}

// The text a card is found by, in the feed's search box and in search_cards.
function cardSearchText(card) {
  return [
    card.title, card.subtitle, card.body, card.metadata?.url, card.metadata?.external_url,
    card.metadata?.external_id, ...(Array.isArray(card.metadata?.labels) ? card.metadata.labels : []),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
}

function visibleInFeed(card) {
  const now = new Date();
  return !card.dismissed_at && (!card.remind_later_until || new Date(card.remind_later_until) <= now) && !archived(card);
}

function snoozedInFeed(card) {
  const now = new Date();
  return !card.dismissed_at && !!card.remind_later_until && new Date(card.remind_later_until) > now && !archived(card);
}

// Dismissing a card permanently deletes the underlying item (see deleteItem
// below), so there is no "dismissed" state to list or recall.
const DELETE_QUERIES = {
  learning: (sql, tenant, id) => sql`update learning_entries set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning id`,
  kanban: (sql, tenant, id) => sql`update kanban_items set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning id`,
  work: (sql, tenant, id) => sql`update work_items set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning id`,
  family: (sql, tenant, id) => sql`update family_updates set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning id`,
  bookmark: (sql, tenant, id) => sql`update bookmarks set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning id`,
  talking_point: (sql, tenant, id) => sql`update talking_points set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning id`,
  reminder: (sql, tenant, id) => sql`update reminders set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning id`,
  file: (sql, tenant, id) => sql`update files set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning id, blob_url`,
};

async function deleteItem(sql, tenant, itemType, id) {
  const query = DELETE_QUERIES[itemType];
  if (!query) return false;
  const rows = await query(sql, tenant, id);
  if (!rows.length) return false;
  // A dismissed item no longer needs any feed_state (likes/pins/etc. on a
  // deleted item are meaningless), so drop it rather than leave it behind.
  await sql`delete from feed_state where user_email = ${tenant} and item_type = ${itemType} and item_id = ${id}`;
  // Otherwise the item's own Blob (or its attachments') would keep consuming
  // storage forever with no remaining reference to reach it.
  if (itemType === 'file') {
    if (rows[0].blob_url) await del(rows[0].blob_url).catch(() => {});
  } else {
    await purgeAttachments(sql, tenant, itemType, id);
  }
  return true;
}

// Kanban rows in the feed are GitHub issues (see integration-registry.js), so
// they read in GitHub's terms -- "acme/app#42, Assigned" -- not board columns.
const GITHUB_STATUS_LABEL = { backlog: 'Open', in_progress: 'Assigned', done: 'Closed' };
function kanbanSubtitle(row) {
  if (row.external_source !== 'github') return row.status.replace('_', ' ');
  return [row.external_id, GITHUB_STATUS_LABEL[row.status]].filter(Boolean).join(', ');
}

// A linked card's subtitle names the site ("youtube.com"), not the raw URL:
// the full address is unreadable as a subtitle, and the card's link chip
// already opens it. Links may be saved without a scheme ("example.test/a").
function siteLabel(url) {
  if (!url) return '';
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^(www|m)\./, '');
  } catch (_) { return ''; }
}

function normalize(type, row) {
  const base = {
    id: row.id,
    type,
    created_at: row.created_at,
    dismissed_at: row.dismissed_at || null,
    remind_later_until: row.remind_later_until || null,
    liked_at: row.liked_at || null,
    pinned_at: row.pinned_at || null,
    sort_order: Number(row.feed_sort_order || 0),
  };
  if (type === 'learning') return { ...base, title: row.title, subtitle: siteLabel(row.url), body: row.notes || '', metadata: { status: row.status, category: row.category, url: row.url || '' }, actions: ['open', 'watched', 'skimmed', 'remind_later', 'pin', 'dismiss'] };
  if (type === 'kanban') return { ...base, title: row.title, subtitle: kanbanSubtitle(row), body: row.description || '', metadata: { status: row.status, source: row.external_source || 'native', external_id: row.external_id || '', external_url: row.external_url || '', labels: asArray(row.labels) }, actions: ['open', 'remind_later', 'pin', 'dismiss'] };
  if (type === 'work') { const items = asArray(row.items); const done = items.filter(x => typeof x === 'object' && (x.completed || x.done || x.checked)).length; return { ...base, title: row.title, subtitle: `${done}/${items.length} items done`, body: '', metadata: { items, done, total: items.length }, actions: ['toggle_items', 'remind_later', 'pin', 'dismiss'] }; }
  if (type === 'family') return { ...base, title: row.person, subtitle: 'Family update', body: row.content || '', metadata: {}, actions: ['remind_later', 'pin', 'dismiss'] };
  if (type === 'bookmark') return { ...base, title: row.title, subtitle: siteLabel(row.url), body: row.notes || '', metadata: { category: row.category, url: row.url || '' }, actions: ['open', 'remind_later', 'pin', 'dismiss'] };
  if (type === 'talking_point') return { ...base, title: row.section_title, subtitle: '', body: row.content || '', metadata: { subsection_of: row.subsection_of }, actions: ['expand', 'remind_later', 'pin', 'dismiss'] };
  if (type === 'file') return { ...base, title: row.name, subtitle: `${Math.round(row.byte_size / 1024)} KB, ${row.mime_type}`, body: '', metadata: { name: row.name, mime_type: row.mime_type, byte_size: row.byte_size, blob_url: `/api/feed?file_id=${row.id}` }, actions: ['open', 'remind_later', 'pin', 'dismiss'] };
  const due = row.due_date ? `Due ${dueLabel(row.due_date)}` : 'No due date';
  const subtitle = row.recurrence ? `${due}, repeats ${row.recurrence}` : due;
  return { ...base, title: row.title, subtitle, body: '', metadata: { completed: row.completed, due_date: row.due_date, recurrence: row.recurrence || null }, actions: ['toggle_complete', 'remind_later', 'pin', 'dismiss'] };
}

// The server can't know the reader's locale or zone, so the label is one no
// reader can misread: "3 Oct 2026", not "10/3/2026" (3 Oct or 10 Mar?), and a
// time is marked UTC rather than shown in whatever zone the server runs in.
// Day-only due dates are stored as UTC midnight and show as just the day.
function dueLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const day = date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const time = date.toISOString().slice(11, 16);
  return time === '00:00' ? day : `${day}, ${time} UTC`;
}

const encode = offset => Buffer.from(JSON.stringify({ offset })).toString('base64url');

function offsetFor(cursor, cards) {
  try { return Math.max(0, Number(JSON.parse(Buffer.from(cursor, 'base64url').toString()).offset) || 0); } catch (_) { const i = cards.findIndex(x => x.id === cursor); return i < 0 ? 0 : i + 1; }
}

// Whether a cursor is one this server handed out as next_cursor. The feed
// page also accepts a card id (older clients), and anything unreadable starts
// from the top; an assistant passing a made-up cursor should hear so instead
// of silently getting page one again.
function isPageCursor(cursor) {
  try {
    const { offset } = JSON.parse(Buffer.from(String(cursor), 'base64url').toString());
    return Number.isSafeInteger(offset) && offset >= 0 && encode(offset) === String(cursor);
  } catch (_) { return false; }
}

async function selectState(sql, tenant) {
  try {
    return await sql`select item_type, item_id, dismissed_at, pinned_at, liked_at, remind_later_until, reviewed_at, sort_order as feed_sort_order from feed_state where user_email = ${tenant}`;
  } catch (e) {
    // Keep reads working until an additive migration has reached an older deployment.
    if (!e.message?.includes('reviewed_at')) throw e;
    try {
      return await sql`select item_type, item_id, dismissed_at, pinned_at, liked_at, remind_later_until, sort_order as feed_sort_order from feed_state where user_email = ${tenant}`;
    } catch (inner) {
      if (!inner.message?.includes('remind_later_until')) throw inner;
      try {
        return await sql`select item_type, item_id, dismissed_at, pinned_at, liked_at, sort_order as feed_sort_order from feed_state where user_email = ${tenant}`;
      } catch (legacy) {
        if (!legacy.message?.includes('liked_at')) throw legacy;
        return sql`select item_type, item_id, dismissed_at, pinned_at, sort_order as feed_sort_order from feed_state where user_email = ${tenant}`;
      }
    }
  }
}

async function selectFiles(sql, tenant) {
  try {
    return await sql`select id, name, mime_type, byte_size, blob_url, sort_order, created_at from files where deleted_at is null and user_email = ${tenant}`;
  } catch (e) {
    if (e.message?.includes('relation \"files\" does not exist') || e.message?.includes('does not exist')) return [];
    throw e;
  }
}

async function selectAttachments(sql, tenant) {
  try {
    return await sql`select id, parent_type, parent_id, name, mime_type, byte_size, sort_order, created_at from attachments where user_email = ${tenant} and deleted_at is null order by sort_order, created_at`;
  } catch (e) {
    // Allow pre-migration deployments to continue serving feed cards.
    if (e.message?.includes('relation \"attachments\" does not exist') || e.message?.includes('does not exist')) return [];
    throw e;
  }
}

function normalizeAttachment(row) {
  return { id: row.id, name: row.name, mime_type: row.mime_type, byte_size: Number(row.byte_size), url: `/api/feed?attachment_id=${row.id}` };
}

async function loadSources(sql, tenant) {
  const [learnings, kanban, work, family, bookmarks, talking, reminders, files, attachments, states, integrations] = await Promise.all([
    sql`select id, title, url, notes, status, category, sort_order, created_at from learning_entries where deleted_at is null and user_email = ${tenant}`,
    sql`select id, title, description, status, external_source, external_id, external_url, labels, sort_order, created_at from kanban_items where deleted_at is null and user_email = ${tenant}`,
    sql`select id, title, items, sort_order, created_at from work_items where deleted_at is null and user_email = ${tenant}`,
    sql`select id, person, content, sort_order, created_at from family_updates where deleted_at is null and user_email = ${tenant}`,
    sql`select id, title, url, notes, category, sort_order, created_at from bookmarks where deleted_at is null and user_email = ${tenant}`,
    sql`select id, section_title, content, subsection_of, sort_order, created_at from talking_points where deleted_at is null and user_email = ${tenant}`,
    // select * so the feed keeps loading before the recurrence migration has run.
    sql`select * from reminders where deleted_at is null and user_email = ${tenant}`,
    selectFiles(sql, tenant),
    selectAttachments(sql, tenant),
    selectState(sql, tenant),
    getIntegrations(sql, tenant),
  ]);
  return { learnings, kanban, work, family, bookmarks, talking, reminders, files, attachments, states, integrations };
}


async function handleDownload(req, res) {
  const tenant = resolveWriterTenant(req);
  if (!tenant) return res.status(401).json({ error: 'Authentication required' });
  const attachmentId = req.query?.attachment_id;
  const fileId = req.query?.file_id;
  const id = attachmentId || fileId;
  if (!UUID_RE.test(id || '')) return res.status(400).json({ error: `Valid ${attachmentId ? 'attachment_id' : 'file_id'} is required` });
  const sql = getSql();
  const rows = attachmentId
    ? await sql`select name, mime_type, blob_url from attachments where id = ${id} and user_email = ${tenant} and deleted_at is null limit 1`
    : await sql`select name, mime_type, blob_url from files where id = ${id} and user_email = ${tenant} and deleted_at is null limit 1`;
  if (!rows.length) return res.status(404).json({ error: attachmentId ? 'Attachment not found' : 'File not found' });
  const { stream } = await get(rows[0].blob_url, { access: 'private' });
  res.setHeader('Content-Type', rows[0].mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${String(rows[0].name).replace(/"/g, '')}"`);
  if (stream && typeof stream.pipe === 'function') return stream.pipe(res);
  if (stream) return require('stream').Readable.fromWeb(stream).pipe(res);
  return res.status(404).json({ error: attachmentId ? 'Attachment not found' : 'File not found' });
}

async function ensureAuroraReviewSchema(sql) {
  await sql`alter table feed_state add column if not exists reviewed_at timestamptz`;
  await sql`create table if not exists vault_daily_activity (
    user_email text not null default 'default',
    activity_date date not null default current_date,
    opened_at timestamptz not null default now(),
    primary key (user_email, activity_date)
  )`;
}

// A streak day is the viewer's calendar day. Neon's current_date and the
// server clock are both UTC in production (and something else again on a
// laptop), so neither can decide "today" for someone opening the vault at
// 1am in their own timezone. The browser sends its IANA zone; anything
// missing or unrecognised falls back to UTC.
function resolveTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return timeZone; } catch (_) { return 'UTC'; }
}

function localDate(instant, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Calendar arithmetic on YYYY-MM-DD strings, done in UTC so no DST shift or
// server timezone can skip or repeat a day.
function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Consecutive active days ending today -- or ending yesterday when today has
// no visit yet, since the streak is still alive until today is over.
function computeStreak(activityDates, today) {
  const days = new Set(activityDates.map(date => String(date).slice(0, 10)));
  let day = days.has(today) ? today : shiftDate(today, -1);
  let streak = 0;
  while (days.has(day)) { streak += 1; day = shiftDate(day, -1); }
  return streak;
}

async function activityRows(sql, tenant, today, record) {
  const run = async () => {
    // A primary key on (user_email, activity_date) means refreshes do not create
    // extra activity and the first open timestamp remains meaningful.
    if (record) await sql`insert into vault_daily_activity (user_email, activity_date) values (${tenant}, ${today}::date) on conflict (user_email, activity_date) do nothing`;
    return await sql`select activity_date::text as activity_date from vault_daily_activity where user_email = ${tenant} order by activity_date desc`;
  };
  try {
    return await run();
  } catch (e) {
    if (!e.message?.includes('vault_daily_activity')) throw e;
    await ensureAuroraReviewSchema(sql);
    return await run();
  }
}

// Every card the tenant has (deleted rows, and rows of an integration that
// isn't active, left out), with its feed state and attachments merged in.
// The feed, search_cards and get_card all read cards through this, so they
// agree on which cards exist.
async function loadVisibleCards(sql, tenant) {
  const loaded = await loadSources(sql, tenant);
  const { learnings, kanban, work, family, bookmarks, talking, reminders, files, attachments, states, integrations } = loaded;
  const state = new Map(states.map(x => [`${x.item_type}:${x.item_id}`, x]));
  const attachmentMap = new Map();
  for (const attachment of attachments) {
    const key = `${attachment.parent_type}:${attachment.parent_id}`;
    attachmentMap.set(key, [...(attachmentMap.get(key) || []), normalizeAttachment(attachment)]);
  }
  // An integration-owned card type shows only that integration's rows (e.g.
  // Kanban rows synced from GitHub), and only once the tenant has onboarded
  // it. Other rows of that type -- Cardlake-only Kanban cards from before
  // Kanban became GitHub Issues -- are kept but no longer shown. Hidden rows
  // still count toward quota: they exist.
  const visibleRows = (type, rows) => {
    const integration = integrationForCardType(type);
    if (!integration) return rows;
    if (!isIntegrationActive(integrations.get(integration.id))) return [];
    return rows.filter(row => row.external_source === integration.externalSource);
  };
  const sources = [['learning', learnings], ['kanban', kanban], ['work', work], ['family', family], ['bookmark', bookmarks], ['talking_point', talking], ['reminder', reminders], ['file', files]]
    .map(([type, rows]) => [type, visibleRows(type, rows)]);
  const visibleKanban = sources.find(([type]) => type === 'kanban')[1];
  const allCards = sources.flatMap(([type, rows]) => rows.map(row => {
    const card = normalize(type, { ...row, ...(state.get(`${type}:${row.id}`) || {}) });
    card.metadata.attachments = attachmentMap.get(`${type}:${row.id}`) || [];
    const integration = integrationForCardType(type);
    if (integration) card.integration = integration.id;
    return card;
  }));
  return { ...loaded, visibleKanban, allCards };
}

// Finds cards by text for search_cards: every word of the query must appear,
// in any order. Unlike the feed it also covers snoozed and finished cards
// (a watched learning, a done issue) -- those are what people search for
// later -- and lists them newest first. Hidden GitHub issues stay hidden.
async function searchCards(sql, tenant, { query, types, limit = 10, cursor } = {}) {
  const words = String(query || '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const typeSet = Array.isArray(types) && types.length ? new Set(types) : null;
  const { allCards } = await loadVisibleCards(sql, tenant);
  const matches = allCards
    .filter(card => !card.dismissed_at && (!typeSet || typeSet.has(card.type)))
    .filter(card => { const text = cardSearchText(card); return words.every(word => text.includes(word)); })
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || String(a.id).localeCompare(String(b.id)));
  const offset = cursor ? offsetFor(cursor, matches) : 0;
  const size = Math.min(50, Math.max(1, Number(limit) || 10));
  const page = matches.slice(offset, offset + size);
  const next = offset + page.length;
  return { cards: page, next_cursor: next < matches.length ? encode(next) : null, total: matches.length };
}

// One card by type and id, from the same set search_cards covers. Returns
// null for anything it can't see -- unknown, deleted, hidden, another
// account's, or the wrong type -- so callers can't tell those apart.
async function getCard(sql, tenant, type, id) {
  const { allCards } = await loadVisibleCards(sql, tenant);
  return allCards.find(card => card.type === type && card.id === id && !card.dismissed_at) || null;
}

// options.recordVisit marks today as a streak day. Only a signed-in person
// opening their own vault should do that -- not an anonymous visitor to the
// shared vault, and not an MCP client listing cards.
async function buildFeedResponse(sql, tenant, params = {}, { recordVisit = false, now = new Date() } = {}) {
  const timeZone = resolveTimeZone(params.tz);
  const today = localDate(now, timeZone);
  const activity = await activityRows(sql, tenant, today, recordVisit);
  const { learnings, kanban, work, family, bookmarks, talking, reminders, files, attachments, states, integrations, visibleKanban, allCards } = await loadVisibleCards(sql, tenant);
  const activeCards = allCards.filter(visibleInFeed);
  const snoozedCards = allCards.filter(snoozedInFeed);
  const view = params.view === 'snoozed' ? 'snoozed' : 'active';
  const cards = view === 'snoozed' ? snoozedCards : activeCards;
  const typeParam = typeof params.types === 'string' ? params.types : '';
  const requestedTypes = typeParam.split(',').map(type => type.trim()).filter(type => TYPE_SET.has(type));
  const hasTypeFilter = typeParam.trim().length > 0;
  // Categories and statuses are stored lower case ("ai", "in_progress");
  // "AI" or "In_Progress" from a person or an assistant means the same thing.
  const category = typeof params.category === 'string' && params.category.trim() ? params.category.trim().toLowerCase() : null;
  const status = typeof params.status === 'string' && params.status.trim() ? params.status.trim().toLowerCase() : null;
  // Search before ordering and pagination so a matching older card can be
  // found even when it is not in the first page of the feed. Keep the query
  // intentionally small: it is only used for in-memory matching here.
  const searchQuery = typeof params.query === 'string' ? params.query.trim().slice(0, 100).toLocaleLowerCase() : '';
  // Likes live in feed_state, so this remains an inexpensive in-memory filter after
  // the feed's existing state merge. Accept only an explicit true/1 value.
  const likedOnly = params.liked === 'true' || params.liked === '1';
  const likedCards = activeCards.filter(card => card.liked_at);
  const pinnedCards = activeCards.filter(card => card.pinned_at);
  const filteredCards = cards.filter(card => (
    (!hasTypeFilter || requestedTypes.includes(card.type)) &&
    (!category || card.metadata?.category === category) &&
    (!status || card.metadata?.status === status) &&
    (!likedOnly || card.liked_at) &&
    (!searchQuery || cardSearchText(card).includes(searchQuery))
  ));
  // Snoozed cards come back in the order they're due; the main feed is
  // sorted by the viewer's choice (feed-ranking.js), with pins always first.
  const sort = resolveSort(params.sort);
  let ordered;
  if (view === 'snoozed') {
    ordered = [...filteredCards].sort((a, b) => new Date(a.remind_later_until) - new Date(b.remind_later_until));
  } else {
    const pinned = filteredCards.filter(x => x.pinned_at).sort((a, b) => a.sort_order - b.sort_order || new Date(b.pinned_at) - new Date(a.pinned_at));
    ordered = [...pinned, ...sortCards(filteredCards.filter(x => !x.pinned_at), sort, { now: now.getTime() })];
  }
  const offset = offsetFor(params.cursor, ordered);
  const limit = Math.min(50, Math.max(1, Number(params.limit) || 20));
  const page = ordered.slice(offset, offset + limit);
  const next = offset + page.length;
  const reviewedToday = states.filter(x => x.reviewed_at && localDate(new Date(x.reviewed_at), timeZone) === today).length;
  const streakDays = computeStreak(activity.map(row => row.activity_date), today);
  return { cards: page, next_cursor: next < ordered.length ? encode(next) : null, view, sort, integrations: publicIntegrationList(integrations, { github_issues: kanban.filter(row => row.external_source === 'github').length }), stats: {
    learning_entries: learnings.length, kanban_items: visibleKanban.length, work_items: work.length,
    family_updates: family.length, bookmarks: bookmarks.length, talking_points: talking.length, reminders: reminders.length, files: files.length,
    liked_cards: likedCards.length,
    pinned_cards: pinnedCards.length,
    max_pinned: MAX_PINNED,
    snoozed_count: snoozedCards.length,
    quota: quotaSummaryFromSources({ learnings, kanban, work, family, bookmarks, talking, reminders, files, attachments }),
    review: { date: today, reviewed_today: reviewedToday, total_today: activeCards.length + reviewedToday },
    streak_days: streakDays,
  } };
}

async function handleList(req, res) {
  const sql = getSql();
  const tenant = resolveViewerTenant(req);
  const recordVisit = tenant !== DEFAULT_TENANT;
  // Opening the feed is when dealt and starter cards past their trial go
  // (surprise.js), so nobody sees one the moment after it expired.
  if (recordVisit && !req.query?.cursor) await sweepTrials(sql, tenant);
  const response = await buildFeedResponse(sql, tenant, req.query || {}, { recordVisit });
  // What was shown, in what order, under which filters: the exposure side of
  // every later like, snooze or dismiss (events.js). Signed-in viewers only.
  if (recordVisit) {
    const q = req.query || {};
    req.cardleEvent = { type: 'feed.served', context: {
      view: response.view, sort: response.sort, types: q.types || null, liked: q.liked || null, query: q.query || null, cursor: q.cursor || null,
      cards: response.cards.map(card => [card.type, card.id]),
    } };
  }
  return res.status(200).json(response);
}


function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    let fileBuffer = null;
    let fileInfo = {};
    const fields = {};
    let size = 0;
    let rejected = false;
    let sawFile = false;

    busboy.on('file', (name, file, info) => {
      if (name !== 'file' || sawFile) {
        if (name === 'file') rejected = true;
        return file.resume();
      }
      sawFile = true;
      fileInfo = { filename: info.filename, mimeType: info.mimeType || 'application/octet-stream' };
      const chunks = [];
      file.on('data', chunk => {
        size += chunk.length;
        if (size > limits.maxFileBytes) {
          rejected = true;
          file.resume();
          return;
        }
        chunks.push(chunk);
      });
      file.on('end', () => { if (!rejected) fileBuffer = Buffer.concat(chunks); });
      file.on('error', reject);
    });
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('finish', () => {
      if (rejected) return reject(new LimitError(413, 'FILE_TOO_LARGE', `Upload one file no larger than ${Math.floor(limits.maxFileBytes / (1024 * 1024))} MB.`));
      resolve({ fileBuffer, fileInfo, fields });
    });
    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

async function parentExists(sql, tenant, type, id) {
  const queries = {
    learning: () => sql`select id from learning_entries where id = ${id} and user_email = ${tenant} and deleted_at is null limit 1`,
    kanban: () => sql`select id from kanban_items where id = ${id} and user_email = ${tenant} and deleted_at is null limit 1`,
    work: () => sql`select id from work_items where id = ${id} and user_email = ${tenant} and deleted_at is null limit 1`,
    family: () => sql`select id from family_updates where id = ${id} and user_email = ${tenant} and deleted_at is null limit 1`,
    bookmark: () => sql`select id from bookmarks where id = ${id} and user_email = ${tenant} and deleted_at is null limit 1`,
    talking_point: () => sql`select id from talking_points where id = ${id} and user_email = ${tenant} and deleted_at is null limit 1`,
    reminder: () => sql`select id from reminders where id = ${id} and user_email = ${tenant} and deleted_at is null limit 1`,
    file: () => sql`select id from files where id = ${id} and user_email = ${tenant} and deleted_at is null limit 1`,
  };
  return !!(await queries[type]())[0];
}

async function handleUpload(req, res) {
  const tenant = resolveWriterTenant(req);
  if (!tenant) return res.status(401).json({ error: 'Authentication required' });
  const { fileBuffer, fileInfo, fields } = await parseMultipart(req);
  const parentType = fields.parent_type?.trim();
  const parentId = fields.parent_id?.trim();
  const hasParent = parentType || parentId;
  if (hasParent && (!ATTACHABLE_TYPES.has(parentType) || !UUID_RE.test(parentId || ''))) {
    return res.status(400).json({ error: 'Valid parent_type and parent_id are required for attachments' });
  }
  if (!fileBuffer) return res.status(400).json({ error: 'No file uploaded' });
  const filename = (fileInfo.filename || 'upload').replace(/[\\/]/g, '-');
  if (filename.length > limits.maxFilenameChars) {
    throw new LimitError(413, 'FILENAME_TOO_LONG', `File names must be ${limits.maxFilenameChars} characters or fewer.`, { used: filename.length, limit: limits.maxFilenameChars });
  }
  const mimeType = await validateUpload(fileBuffer, filename);

  const sql = getSql();
  if (hasParent && !(await parentExists(sql, tenant, parentType, parentId))) return res.status(404).json({ error: 'Parent card not found' });
  if (!hasParent) await assertCardCreateAllowed(sql, tenant, 'file', { name: filename });
  const uploadStatus = await assertUploadAllowed(sql, tenant, { size: fileBuffer.length, parentType, parentId });
  let blob;
  try {
    blob = await put(filename, fileBuffer, { access: 'private', contentType: mimeType });
    if (hasParent) {
      const rows = await sql`
        insert into attachments (user_email, parent_type, parent_id, name, mime_type, byte_size, blob_url)
        values (${tenant}, ${parentType}, ${parentId}, ${filename}, ${mimeType}, ${fileBuffer.length}, ${blob.url})
        returning id, parent_type, parent_id, name, mime_type, byte_size, sort_order, created_at
      `;
      req.cardleEvent = { type: 'attachment.add', item_type: parentType, item_id: parentId, context: { mime_type: mimeType, byte_size: fileBuffer.length } };
      return res.status(201).json({ attachment: normalizeAttachment(rows[0]), parent_type: parentType, parent_id: parentId, warning: uploadStatus.globalStorageAlert ? 'Storage capacity is being monitored.' : undefined });
    }
    const rows = await sql`
      insert into files (user_email, name, mime_type, byte_size, blob_url)
      values (${tenant}, ${filename}, ${mimeType}, ${fileBuffer.length}, ${blob.url})
      returning id, name, mime_type, byte_size, blob_url, sort_order, created_at
    `;
    await sql`
      insert into feed_state (user_email, item_type, item_id)
      values (${tenant}, 'file', ${rows[0].id})
      on conflict (user_email, item_type, item_id) do nothing
    `;
    req.cardleEvent = { type: 'card.create', item_type: 'file', item_id: rows[0].id, context: { mime_type: mimeType, byte_size: fileBuffer.length } };
    return res.status(201).json({ ...normalize('file', rows[0]), warning: uploadStatus.globalStorageAlert ? 'Storage capacity is being monitored.' : undefined });
  } catch (error) {
    if (blob?.url) await del(blob.url).catch(() => {});
    throw error;
  }
}

// Cards that mirror an outside service (GitHub issues) are not Cardlake's to
// delete: a sync would upsert them straight back. Dismissing one hides it
// instead, and because a sync keeps the row's id, the hide survives syncs.
async function isExternallyOwned(sql, tenant, item_type, item_id) {
  if (item_type !== 'kanban') return false;
  const rows = await sql`select 1 from kanban_items where id = ${item_id} and user_email = ${tenant} and external_source is not null and deleted_at is null limit 1`;
  return rows.length > 0;
}

// A finished card (a completed reminder, a watched learning, a closed issue,
// a fully ticked checklist) has left the feed, so pinning or snoozing it would
// do nothing anyone can see -- and a pin would quietly hold one of the slots.
async function refuseIfFinished(sql, tenant, action, item_type, item_id) {
  if (!['pin', 'remind_later'].includes(action)) return;
  const card = await getCard(sql, tenant, item_type, item_id);
  if (!card || !archived(card)) return;
  const err = new Error(`This card is finished, so it isn't in the feed to ${action === 'pin' ? 'pin' : 'snooze'}. Reopen it first.`);
  err.status = 400;
  throw err;
}

// Pins that take up a slot: the ones on cards in the active feed -- the same
// set stats.pinned_cards counts. A pin left on a card that has since been
// finished or hidden doesn't count, or the limit would be reached while the
// feed shows free slots.
async function activePinCount(sql, tenant, item_type, item_id) {
  const { allCards } = await loadVisibleCards(sql, tenant);
  return allCards.filter(card => card.pinned_at && visibleInFeed(card) && !(card.type === item_type && card.id === item_id)).length;
}

const MAX_SNOOZE_DAYS = 365;
function snoozeDays(days) {
  if (days === undefined || days === null) return 1;
  const value = Number(days);
  if (!Number.isInteger(value) || value < 1 || value > MAX_SNOOZE_DAYS) {
    const err = new Error(`Snooze for a whole number of days from 1 to ${MAX_SNOOZE_DAYS}.`);
    err.status = 400;
    throw err;
  }
  return value;
}

async function applyFeedAction(sql, tenant, action, item_type, item_id, options = {}) {
  // Feed state has no database foreign key because it spans several card
  // tables. Never let a malformed or stale client create state for a card
  // that is not owned by this tenant; such orphan rows are invisible in the
  // feed and could otherwise consume the pinned-card quota.
  if (!(await parentExists(sql, tenant, item_type, item_id))) {
    const err = new Error('Item not found');
    err.status = 404;
    throw err;
  }
  if (action === 'dismiss' && await isExternallyOwned(sql, tenant, item_type, item_id)) {
    const rows = await sql`insert into feed_state (user_email, item_type, item_id, dismissed_at, pinned_at, remind_later_until) values (${tenant}, ${item_type}, ${item_id}, now(), null, null) on conflict (user_email, item_type, item_id) do update set dismissed_at = now(), pinned_at = null, remind_later_until = null returning *`;
    return { hidden: true, feed_state: rows[0] };
  }
  if (action === 'dismiss') {
    const deleted = await deleteItem(sql, tenant, item_type, item_id);
    if (!deleted) { const err = new Error('Item not found'); err.status = 404; throw err; }
    return { deleted: true };
  }
  await refuseIfFinished(sql, tenant, action, item_type, item_id);
  const days = action === 'remind_later' ? snoozeDays(options.days) : null;
  if (['remind_later', 'unremind_later'].includes(action)) await ensureAuroraReviewSchema(sql);
  let rows;
  if (action === 'like') rows = await sql`insert into feed_state (user_email, item_type, item_id, liked_at) values (${tenant}, ${item_type}, ${item_id}, now()) on conflict (user_email, item_type, item_id) do update set liked_at = now() returning *`;
  if (action === 'unlike') rows = await sql`insert into feed_state (user_email, item_type, item_id) values (${tenant}, ${item_type}, ${item_id}) on conflict (user_email, item_type, item_id) do update set liked_at = null returning *`;
  // Pinning clears a snooze and snoozing clears a pin: a pin keeps a card at
  // the top of the feed, so a snoozed card mustn't hold a slot out of sight.
  if (action === 'remind_later') rows = await sql`insert into feed_state (user_email, item_type, item_id, remind_later_until, reviewed_at) values (${tenant}, ${item_type}, ${item_id}, now() + make_interval(days => ${days}::int), now()) on conflict (user_email, item_type, item_id) do update set remind_later_until = now() + make_interval(days => ${days}::int), dismissed_at = null, reviewed_at = now(), pinned_at = null returning *`;
  if (action === 'unremind_later') rows = await sql`insert into feed_state (user_email, item_type, item_id) values (${tenant}, ${item_type}, ${item_id}) on conflict (user_email, item_type, item_id) do update set remind_later_until = null, reviewed_at = null returning *`;
  if (action === 'pin') {
    const count = await activePinCount(sql, tenant, item_type, item_id);
    if (count >= MAX_PINNED) { const err = new Error(`You can only pin up to ${MAX_PINNED} cards. Unpin one first.`); err.status = 400; throw err; }
    rows = await sql`insert into feed_state (user_email, item_type, item_id, pinned_at) values (${tenant}, ${item_type}, ${item_id}, now()) on conflict (user_email, item_type, item_id) do update set pinned_at = now(), dismissed_at = null, remind_later_until = null returning *`;
  }
  if (action === 'unpin') rows = await sql`insert into feed_state (user_email, item_type, item_id) values (${tenant}, ${item_type}, ${item_id}) on conflict (user_email, item_type, item_id) do update set pinned_at = null returning *`;
  if (!rows) { const err = new Error('Unsupported feed action'); err.status = 400; throw err; }
  return { feed_state: rows[0] };
}

async function handleAction(req, res) {
  const tenant = resolveWriterTenant(req);
  if (!tenant) return res.status(401).json({ error: 'Authentication required' });
  const { action, item_type, item_id, days } = await readJson(req);
  if (!action || !TYPE_SET.has(item_type) || !UUID_RE.test(item_id || '')) return res.status(400).json({ error: 'Valid action, item_type, and item_id are required' });
  const sql = getSql();
  // Named before running, so a refused action (e.g. the pin limit) is
  // recorded as what was attempted, with its status.
  req.cardleEvent = { type: `feed.${action}`, item_type, item_id };
  try {
    const result = await applyFeedAction(sql, tenant, action, item_type, item_id, { days });
    req.cardleEvent.context = { deleted: !!result.deleted, hidden: !!result.hidden };
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error, error.status || 500);
  }
}

module.exports = withSessionGuard(async function handler(req, res) {
  try {
    if (req.method === 'GET' && (req.query?.file_id || req.query?.attachment_id)) return await handleDownload(req, res);
    if (req.method === 'GET') return await handleList(req, res);
    if (req.method === 'POST' && req.headers['content-type']?.includes('multipart/form-data')) return await handleUpload(req, res);
    if (req.method === 'POST') return await handleAction(req, res);
    return res.status(405).json({ error: 'Method not allowed. Use GET for listing or POST for actions.' });
  } catch (error) { return sendError(res, error); }
});

module.exports.archived = archived;
module.exports.visibleInFeed = visibleInFeed;
module.exports.snoozedInFeed = snoozedInFeed;
module.exports.buildFeedResponse = buildFeedResponse;
module.exports.searchCards = searchCards;
module.exports.getCard = getCard;
module.exports.computeStreak = computeStreak;
module.exports.localDate = localDate;
module.exports.applyFeedAction = applyFeedAction;
module.exports.isPageCursor = isPageCursor;
module.exports.MAX_SNOOZE_DAYS = MAX_SNOOZE_DAYS;
module.exports.TYPES = TYPES;
