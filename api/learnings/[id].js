const { getSql, normalizeEntry } = require('../_lib/db');
const { withSessionGuard } = require('../_lib/session-guard');
const { resolveWriterTenant } = require('../_lib/auth');
const { allowMethods, readJson, sendError } = require('../_lib/http');
const { purgeAttachments } = require('../_lib/attachments');
const { LimitError, assertCardUpdateAllowed } = require('../_lib/limits');
const { checkLinkUrl } = require('../_lib/resources');

const VALID_STATUS = new Set(['saved', 'watched', 'skimmed']);
const VALID_CATEGORY = new Set(['ai', 'others']);

function clean(value) {
  return String(value ?? '').trim();
}

module.exports = withSessionGuard(async function handler(req, res) {
  if (!allowMethods(req, res, ['PATCH', 'DELETE'])) return;
  const tenant = resolveWriterTenant(req);
  if (!tenant) { res.status(401).json({ error: 'Authentication required' }); return; }

  const id = req.query.id;
  if (!id) {
    res.status(400).json({ error: 'Entry id is required' });
    return;
  }

  const sql = getSql();

  try {
    if (req.method === 'DELETE') {
      const rows = await sql`update learning_entries set deleted_at = now() where id = ${id} and user_email = ${tenant} and deleted_at is null returning *`;
      if (!rows.length) {
        res.status(404).json({ error: 'Entry not found' });
        return;
      }
      await purgeAttachments(sql, tenant, 'learning', id);
      req.cardleEvent = { type: 'card.delete', item_type: 'learning', item_id: id };
      res.status(200).json({ entry: normalizeEntry(rows[0]) });
      return;
    }

    const body = await readJson(req);
    const updates = {};

    if ('title' in body) {
      updates.title = clean(body.title);
      if (!updates.title) {
        res.status(400).json({ error: 'Title is required' });
        return;
      }
    }
    if ('url' in body) {
      try { updates.url = checkLinkUrl(body.url); } catch (error) { res.status(400).json({ error: error.message }); return; }
    }
    if ('notes' in body) updates.notes = clean(body.notes);
    if ('status' in body) {
      updates.status = clean(body.status);
      if (!VALID_STATUS.has(updates.status)) {
        res.status(400).json({ error: 'Invalid status' });
        return;
      }
    }
    if ('category' in body) {
      updates.category = clean(body.category);
      if (!VALID_CATEGORY.has(updates.category)) {
        res.status(400).json({ error: 'Invalid category' });
        return;
      }
    }
    if ('sort_order' in body) {
      updates.sort_order = Number(body.sort_order);
      if (!Number.isInteger(updates.sort_order)) {
        res.status(400).json({ error: 'sort_order must be an integer' });
        return;
      }
    }

    const current = await sql`select * from learning_entries where id = ${id} and user_email = ${tenant} and deleted_at is null`;
    if (!current.length) {
      res.status(404).json({ error: 'Entry not found' });
      return;
    }
    const entry = current[0];
    await assertCardUpdateAllowed(sql, tenant, 'learning', id, updates);

    const rows = await sql`
      update learning_entries
      set
        title = ${updates.title ?? entry.title},
        url = ${Object.prototype.hasOwnProperty.call(updates, 'url') ? updates.url : entry.url},
        notes = ${Object.prototype.hasOwnProperty.call(updates, 'notes') ? updates.notes : entry.notes},
        status = ${updates.status ?? entry.status},
        category = ${updates.category ?? entry.category},
        sort_order = ${Object.prototype.hasOwnProperty.call(updates, 'sort_order') ? updates.sort_order : entry.sort_order}
      where id = ${id} and user_email = ${tenant}
      returning *
    `;

    const { status, category } = updates;
    req.cardleEvent = { type: 'card.update', item_type: 'learning', item_id: id, context: { fields: Object.keys(updates), status, category } };
    res.status(200).json({ entry: normalizeEntry(rows[0]) });
  } catch (error) {
    sendError(res, error, error instanceof LimitError ? error.status : null);
  }
});
