const { withSessionGuard } = require('./_lib/session-guard');
const { isSyncTokenValid } = require('./_lib/auth');
const { allowMethods, sendError } = require('./_lib/http');
const { getSql } = require('./_lib/db');
const { applySchema, readSchema } = require('./_lib/schema');

// Only the sync token may run this (scripts and the system tests). The
// request guard already applies the schema by itself (_lib/schema.js); this
// is the manual fallback, and a session is never enough to run DDL.
module.exports = withSessionGuard(async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  if (!isSyncTokenValid(req)) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    // Through getSql() like every other route, so local dev's own database
    // (not whatever DATABASE_URL says) is what a local migrate touches.
    // The manual fallback for automatic application (_lib/schema.js).
    const statementCount = await applySchema(getSql(), readSchema());
    res.status(200).json({ ok: true, message: `Schema v2 applied (${statementCount} statements)` });
  } catch (error) {
    sendError(res, error);
  }
});

