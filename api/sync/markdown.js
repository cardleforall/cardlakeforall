const { getSql, normalizeEntry } = require('../_lib/db');
const { withSessionGuard } = require('../_lib/session-guard');
const { isAuthenticatedRequest, resolveViewerTenant } = require('../_lib/auth');
const { allowMethods, sendError } = require('../_lib/http');
const { renderMarkdown } = require('../_lib/markdown');

module.exports = withSessionGuard(async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  if (!isAuthenticatedRequest(req)) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const sql = getSql();
    const tenant = resolveViewerTenant(req);
    const rows = await sql`select * from learning_entries where deleted_at is null and user_email = ${tenant} order by category asc, sort_order asc, created_at asc`;
    const markdown = renderMarkdown(rows.map(normalizeEntry));
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.status(200).send(markdown);
  } catch (error) {
    sendError(res, error);
  }
});
