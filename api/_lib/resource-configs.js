const { kanbanWriteBlockReason, KANBAN_CREATE_BLOCKED } = require('./integrations');
const { RECURRENCES, nextOccurrence } = require('./recurrence');

const fields = {
  kanban: [
    { name: 'title', kind: 'string', required: true }, { name: 'asin', kind: 'nullableString' },
    { name: 'status', kind: 'string', values: ['backlog', 'in_progress', 'done'], default: 'backlog' },
    { name: 'description', kind: 'string', default: '' }, { name: 'source', kind: 'nullableString' },
  ],
  work: [{ name: 'title', kind: 'string', required: true }, { name: 'items', kind: 'json', default: [], checklist: true }],
  family: [{ name: 'person', kind: 'string', required: true }, { name: 'content', kind: 'string', required: true }],
  bookmarks: [
    { name: 'title', kind: 'string', required: true }, { name: 'url', kind: 'nullableString', link: true },
    { name: 'notes', kind: 'string', default: '' },
    { name: 'category', kind: 'string', values: ['tech', 'business', 'personal', 'other'], default: 'other' },
  ],
  reminders: [
    { name: 'title', kind: 'string', required: true }, { name: 'due_date', kind: 'date', default: null },
    { name: 'completed', kind: 'boolean', default: false },
    { name: 'recurrence', kind: 'nullableString', values: [...RECURRENCES, null], nullAliases: ['none'], default: null },
  ],
  talkingPoints: [
    { name: 'section_title', kind: 'string', required: true }, { name: 'content', kind: 'string', required: true },
    { name: 'subsection_of', kind: 'nullableString' },
  ],
};
const standard = (singular, plural, fieldList, list, create, update, remove) => ({ singular, plural, fields: fieldList, list, create, update, remove });
const has = (values, field) => Object.prototype.hasOwnProperty.call(values, field);

// The recurrence column arrives with a migration that runs after the deploy.
// Until then plain reminders are written without it, and asking for a
// recurring one says why it can't be done rather than failing with a 500.
const missingRecurrence = error => /column "recurrence"( of relation "reminders")? does not exist/.test(error?.message || '');
function recurrenceUnavailable() {
  const error = new Error('Recurring reminders are not available yet. Try again after the next update.');
  error.status = 409;
  error.code = 'RECURRENCE_UNAVAILABLE';
  return error;
}
async function withoutRecurrenceBeforeMigration(v, query, legacyQuery) {
  try {
    return await query();
  } catch (error) {
    if (!missingRecurrence(error)) throw error;
    if (v.recurrence) throw recurrenceUnavailable();
    return legacyQuery();
  }
}
async function createReminder(sql, tenant, values) {
  // Created already done but repeating ("I paid rent, remind me next month"):
  // like completing it later, that rolls it to the next occurrence. Saved as
  // completed it would leave the feed for good and never repeat.
  const rolled = values.completed === true && values.recurrence;
  const next = rolled ? nextOccurrence(values) : null;
  const v = rolled ? { ...values, completed: false, ...next } : values;
  const rows = await withoutRecurrenceBeforeMigration(v,
    () => sql`insert into reminders (user_email, title, due_date, completed, recurrence, sort_order) values (${tenant}, ${v.title}, ${v.due_date}, ${v.completed}, ${v.recurrence}, (select coalesce(max(sort_order), -1) + 1 from reminders where deleted_at is null and user_email = ${tenant})) returning *`,
    () => sql`insert into reminders (user_email, title, due_date, completed, sort_order) values (${tenant}, ${v.title}, ${v.due_date}, ${v.completed}, (select coalesce(max(sort_order), -1) + 1 from reminders where deleted_at is null and user_email = ${tenant})) returning *`);
  if (rolled && rows.length) {
    const until = next.due_date;
    await sql`insert into feed_state (user_email, item_type, item_id, remind_later_until) values (${tenant}, 'reminder', ${rows[0].id}, ${until}) on conflict (user_email, item_type, item_id) do update set remind_later_until = ${until}`;
  }
  return rows;
}
// Completing a recurring reminder doesn't close it: it moves to the next
// occurrence and is snoozed until then, so it leaves the feed until it's due
// again. Every client (feed, MCP, API) gets this because it happens here.
// Returns the values to write and, if it rolled forward, when to snooze until.
async function rollForward(sql, tenant, id, v) {
  if (v.completed !== true) return { values: v };
  const [row] = await sql`select * from reminders where id = ${id} and user_email = ${tenant} and deleted_at is null`;
  const recurrence = has(v, 'recurrence') ? v.recurrence : row?.recurrence;
  if (!row || !recurrence) return { values: v };
  if (await alreadyRolledForward(sql, tenant, id, row)) return { values: { ...v, completed: false } };
  const next = nextOccurrence({ due_date: has(v, 'due_date') ? v.due_date : row.due_date, recurrence });
  return { values: { ...v, completed: false, ...next }, snoozeUntil: next.due_date };
}
// A repeat completion (an MCP retry -- update_reminder is marked idempotent --
// or a double click) must not skip an occurrence. After a roll-forward the
// card is snoozed until exactly its next occurrence; while that snooze
// stands, this occurrence is already done. Bringing the card back clears it.
async function alreadyRolledForward(sql, tenant, id, row) {
  const nextAt = row.due_date;
  if (!nextAt || new Date(nextAt) <= new Date()) return false;
  const [state] = await sql`select remind_later_until from feed_state where user_email = ${tenant} and item_type = 'reminder' and item_id = ${id}`;
  return !!state?.remind_later_until && new Date(state.remind_later_until).getTime() === new Date(nextAt).getTime();
}
async function updateReminder(sql, tenant, id, values) {
  const { values: v, snoozeUntil } = await rollForward(sql, tenant, id, values);
  const rows = await withoutRecurrenceBeforeMigration(v,
    () => sql`update reminders set title = case when ${has(v, 'title')} then ${v.title} else title end, due_date = case when ${has(v, 'due_date')} then ${v.due_date} else due_date end, completed = case when ${has(v, 'completed')} then ${v.completed} else completed end, recurrence = case when ${has(v, 'recurrence')} then ${v.recurrence} else recurrence end where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`,
    () => sql`update reminders set title = case when ${has(v, 'title')} then ${v.title} else title end, due_date = case when ${has(v, 'due_date')} then ${v.due_date} else due_date end, completed = case when ${has(v, 'completed')} then ${v.completed} else completed end where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`);
  if (rows.length && snoozeUntil) {
    // Snoozed until the next occurrence, which also clears a pin, as a
    // snooze from the feed does (see applyFeedAction in feed.js).
    await sql`insert into feed_state (user_email, item_type, item_id, remind_later_until) values (${tenant}, 'reminder', ${id}, ${snoozeUntil}) on conflict (user_email, item_type, item_id) do update set remind_later_until = ${snoozeUntil}, dismissed_at = null, pinned_at = null`;
  }
  return rows;
}
const kanban = standard('item', 'items', fields.kanban,
  (sql, tenant) => sql`select * from kanban_items where deleted_at is null and user_email = ${tenant} order by status, sort_order, created_at`,
  (sql, tenant, v) => sql`insert into kanban_items (user_email, title, asin, status, description, source, sort_order) values (${tenant}, ${v.title}, ${v.asin}, ${v.status}, ${v.description}, ${v.source}, (select coalesce(max(sort_order), -1) + 1 from kanban_items where deleted_at is null and user_email = ${tenant} and status = ${v.status})) returning *`,
  (sql, tenant, id, v) => sql`update kanban_items set title = case when ${has(v, 'title')} then ${v.title} else title end, asin = case when ${has(v, 'asin')} then ${v.asin} else asin end, status = case when ${has(v, 'status')} then ${v.status} else status end, description = case when ${has(v, 'description')} then ${v.description} else description end, source = case when ${has(v, 'source')} then ${v.source} else source end where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`,
  (sql, tenant, id) => sql`update kanban_items set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`);
// Kanban cards come only from GitHub Issues (see integrations.js): creates are
// always refused, and edits/deletes of GitHub-synced cards are refused while
// GitHub is connected.
kanban.guardCreate = (req, res) => {
  res.status(409).json({ error: KANBAN_CREATE_BLOCKED, code: 'KANBAN_COMES_FROM_GITHUB' });
  return false;
};
kanban.guardMutate = async (req, res, id, sql, tenant) => {
  const reason = await kanbanWriteBlockReason(sql, tenant, id);
  if (!reason) return true;
  res.status(409).json({ error: reason, code: 'KANBAN_SYNCED_FROM_GITHUB' });
  return false;
};
// The Work tab edits a checklist as plain lines of text, which carry no tick.
// A line that matches one already on the card keeps that item's tick, so
// editing a card's title there doesn't untick everything.
async function keepTicks(sql, tenant, id, items) {
  if (!Array.isArray(items) || !items.some(item => item.fromLine)) return items;
  const [row] = await sql`select items from work_items where id = ${id} and user_email = ${tenant} and deleted_at is null`;
  const current = Array.isArray(row?.items) ? row.items : [];
  const ticked = new Map(current.filter(item => item && typeof item === 'object').map(item => [String(item.text ?? '').trim(), !!(item.completed || item.done || item.checked)]));
  return items.map(item => (item.fromLine && ticked.has(item.text) ? { ...item, completed: ticked.get(item.text) } : item));
}
async function updateWork(sql, tenant, id, values) {
  const v = has(values, 'items') ? { ...values, items: await keepTicks(sql, tenant, id, values.items) } : values;
  return sql`update work_items set title = case when ${has(v, 'title')} then ${v.title} else title end, items = case when ${has(v, 'items')} then ${JSON.stringify(v.items)}::jsonb else items end where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`;
}
const work = standard('item', 'work', fields.work,
  (sql, tenant) => sql`select * from work_items where deleted_at is null and user_email = ${tenant} order by sort_order, created_at`,
  (sql, tenant, v) => sql`insert into work_items (user_email, title, items, sort_order) values (${tenant}, ${v.title}, ${JSON.stringify(v.items)}, (select coalesce(max(sort_order), -1) + 1 from work_items where deleted_at is null and user_email = ${tenant})) returning *`,
  updateWork,
  (sql, tenant, id) => sql`update work_items set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`);
const family = standard('update', 'updates', fields.family,
  (sql, tenant) => sql`select * from family_updates where deleted_at is null and user_email = ${tenant} order by sort_order, created_at`,
  (sql, tenant, v) => sql`insert into family_updates (user_email, person, content, sort_order) values (${tenant}, ${v.person}, ${v.content}, (select coalesce(max(sort_order), -1) + 1 from family_updates where deleted_at is null and user_email = ${tenant})) returning *`,
  (sql, tenant, id, v) => sql`update family_updates set person = case when ${has(v, 'person')} then ${v.person} else person end, content = case when ${has(v, 'content')} then ${v.content} else content end where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`,
  (sql, tenant, id) => sql`update family_updates set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`);
const bookmarks = standard('bookmark', 'bookmarks', fields.bookmarks,
  (sql, tenant) => sql`select * from bookmarks where deleted_at is null and user_email = ${tenant} order by category, sort_order, created_at`,
  (sql, tenant, v) => sql`insert into bookmarks (user_email, title, url, notes, category, sort_order) values (${tenant}, ${v.title}, ${v.url}, ${v.notes}, ${v.category}, (select coalesce(max(sort_order), -1) + 1 from bookmarks where deleted_at is null and user_email = ${tenant} and category = ${v.category})) returning *`,
  (sql, tenant, id, v) => sql`update bookmarks set title = case when ${has(v, 'title')} then ${v.title} else title end, url = case when ${has(v, 'url')} then ${v.url} else url end, notes = case when ${has(v, 'notes')} then ${v.notes} else notes end, category = case when ${has(v, 'category')} then ${v.category} else category end where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`,
  (sql, tenant, id) => sql`update bookmarks set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`);
const reminders = standard('reminder', 'reminders', fields.reminders,
  (sql, tenant) => sql`select * from reminders where deleted_at is null and user_email = ${tenant} order by completed, due_date nulls last, sort_order, created_at`,
  createReminder, updateReminder,
  (sql, tenant, id) => sql`update reminders set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`);
// A Misc card's parent must be another of the same account's Misc cards, and
// following parents up from it must never come back to the card itself. The
// foreign key only checks that some row has that id -- in any account -- so
// without this a caller could nest under (and so probe for) another
// account's card, or make a card its own ancestor.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NESTING = 50;
async function checkParent(sql, tenant, id, parent) {
  if (!parent) return;
  const invalid = () => new Error('Invalid subsection_of: it must be the id of another of your Misc cards, and not one nested under this card');
  if (!UUID.test(parent)) throw invalid();
  let current = parent;
  for (let depth = 0; current && depth < MAX_NESTING; depth += 1) {
    if (id && current === id) throw invalid();
    const [row] = await sql`select subsection_of from talking_points where id = ${current} and user_email = ${tenant} and deleted_at is null`;
    if (!row) throw invalid();
    current = row.subsection_of;
  }
  if (current) throw invalid();
}
const talkingPoints = standard('talking_point', 'talking_points', fields.talkingPoints,
  (sql, tenant) => sql`select * from talking_points where deleted_at is null and user_email = ${tenant} order by sort_order, created_at`,
  async (sql, tenant, v) => {
    await checkParent(sql, tenant, null, v.subsection_of);
    return sql`insert into talking_points (user_email, section_title, content, subsection_of, sort_order) values (${tenant}, ${v.section_title}, ${v.content}, ${v.subsection_of}, (select coalesce(max(sort_order), -1) + 1 from talking_points where deleted_at is null and user_email = ${tenant})) returning *`;
  },
  async (sql, tenant, id, v) => {
    if (has(v, 'subsection_of')) await checkParent(sql, tenant, id, v.subsection_of);
    return sql`update talking_points set section_title = case when ${has(v, 'section_title')} then ${v.section_title} else section_title end, content = case when ${has(v, 'content')} then ${v.content} else content end, subsection_of = case when ${has(v, 'subsection_of')} then ${v.subsection_of} else subsection_of end where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`;
  },
  (sql, tenant, id) => sql`update talking_points set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`);
// Maps each config to the parent_type value attachments were uploaded under
// (see aurora-feed.js's capture flow), so a delete can find and purge them.
kanban.feedType = 'kanban';
work.feedType = 'work';
family.feedType = 'family';
bookmarks.feedType = 'bookmark';
reminders.feedType = 'reminder';
talkingPoints.feedType = 'talking_point';

module.exports = { kanban, work, family, bookmarks, reminders, talkingPoints };
