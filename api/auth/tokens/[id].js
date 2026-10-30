const { getSql } = require('../../_lib/db');
const { allowMethods, sendError } = require('../../_lib/http');
const { resolveWriterTenant } = require('../../_lib/auth');
const { revokeApiToken } = require('../../_lib/api-tokens');

module.exports = async function handler(req, res) {
  if (!allowMethods(req, res, ['DELETE'])) return;
  const tenant = resolveWriterTenant(req);
  if (!tenant) { res.status(401).json({ error: 'Authentication required' }); return; }
  const id = req.query.id;
  if (!id) { res.status(400).json({ error: 'Token id is required' }); return; }
  try {
    const revoked = await revokeApiToken(getSql(), tenant, id);
    if (!revoked) { res.status(404).json({ error: 'Token not found' }); return; }
    res.status(200).json({ revoked: true });
  } catch (error) {
    sendError(res, error, 400);
  }
};
