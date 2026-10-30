const { getSql, normalizeEntry } = require('./_lib/db');
const { withSessionGuard } = require('./_lib/session-guard');
const { resolveViewerTenant, resolveWriterTenant } = require('./_lib/auth');
const { allowMethods, readJson, sendError } = require('./_lib/http');
const { LimitError, assertCardCreateAllowed } = require('./_lib/limits');
const { checkLinkUrl } = require('./_lib/resources');

const VALID_STATUS = new Set(['saved', 'watched', 'skimmed']);
const VALID_CATEGORY = new Set(['ai', 'others']);

function sanitizeString(value, fallback = '') {
  return String(value ?? fallback).trim();
}

async function listEntries(req, res) {
  const sql = getSql();
  const tenant = resolveViewerTenant(req);
  const category = sanitizeString(req.query.category || '');
  if (category && !VALID_CATEGORY.has(category)) {
    res.status(400).json({ error: 'Invalid category filter' });
    return;
  }

  const rows = category
    ? await sql`select * from learning_entries where deleted_at is null and user_email = ${tenant} and category = ${category} order by category asc, sort_order asc, created_at asc`
    : await sql`select * from learning_entries where deleted_at is null and user_email = ${tenant} order by category asc, sort_order asc, created_at asc`;

  res.status(200).json({ entries: rows.map(normalizeEntry) });
}

async function createEntry(req, res) {
  const tenant = resolveWriterTenant(req);
  if (!tenant) { res.status(401).json({ error: 'Authentication required' }); return; }
  const body = await readJson(req);
  const title = sanitizeString(body.title);
  let url;
  try { url = checkLinkUrl(body.url); } catch (error) { res.status(400).json({ error: error.message }); return; }
  const notes = sanitizeString(body.notes);
  const status = sanitizeString(body.status);
  const category = sanitizeString(body.category);

  if (!title) {
    res.status(400).json({ error: 'Title is required' });
    return;
  }
  if (!VALID_STATUS.has(status)) {
    res.status(400).json({ error: 'Invalid status' });
    return;
  }
  if (!VALID_CATEGORY.has(category)) {
    res.status(400).json({ error: 'Invalid category' });
    return;
  }

  const sql = getSql();
  await assertCardCreateAllowed(sql, tenant, 'learning', { title, url, notes });
  const existing = await sql`select coalesce(max(sort_order), -1) as max_sort_order from learning_entries where deleted_at is null and user_email = ${tenant} and category = ${category}`;
  const nextSortOrder = Number(existing[0]?.max_sort_order ?? -1) + 1;

  const rows = await sql`
    insert into learning_entries (user_email, title, url, notes, status, category, sort_order)
    values (${tenant}, ${title}, ${url || null}, ${notes}, ${status}, ${category}, ${nextSortOrder})
    returning *
  `;

  req.cardleEvent = { type: 'card.create', item_type: 'learning', item_id: rows[0]?.id, context: { status, category, has_url: !!url } };
  res.status(201).json({ entry: normalizeEntry(rows[0]) });
}

module.exports = withSessionGuard(async function handler(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST'])) return;

  try {
    if (req.method === 'GET') {
      await listEntries(req, res);
      return;
    }
    await createEntry(req, res);
  } catch (error) {
    sendError(res, error, error instanceof LimitError ? error.status : null);
  }
});
