const { getSql, normalizeEntry } = require('../_lib/db');
const { withSessionGuard } = require('../_lib/session-guard');
const { resolveWriterTenant } = require('../_lib/auth');
const { allowMethods, readJson, sendError } = require('../_lib/http');

module.exports = withSessionGuard(async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  const tenant = resolveWriterTenant(req);
  if (!tenant) { res.status(401).json({ error: 'Authentication required' }); return; }

  try {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids)
      ? body.ids
      : Array.isArray(body.items)
        ? body.items.map(item => item.id)
        : [];

    if (!ids.length) {
      res.status(400).json({ error: 'ids array is required' });
      return;
    }

    const sql = getSql();
    for (let index = 0; index < ids.length; index += 1) {
      await sql`update learning_entries set sort_order = ${index} where id = ${ids[index]} and user_email = ${tenant} and deleted_at is null`;
    }

    const rows = await sql`select * from learning_entries where deleted_at is null and user_email = ${tenant} order by category asc, sort_order asc, created_at asc`;
    req.cardleEvent = { type: 'learning.reorder', context: { ids: ids.slice(0, 100) } };
    res.status(200).json({ entries: rows.map(normalizeEntry) });
  } catch (error) {
    sendError(res, error);
  }
});
