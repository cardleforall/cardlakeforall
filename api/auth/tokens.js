const { getSql } = require('../_lib/db');
const { allowMethods, readJson, sendError } = require('../_lib/http');
const { resolveWriterTenant } = require('../_lib/auth');
const { createApiToken, listApiTokens } = require('../_lib/api-tokens');

module.exports = async function handler(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST'])) return;
  const tenant = resolveWriterTenant(req);
  if (!tenant) { res.status(401).json({ error: 'Authentication required' }); return; }
  const sql = getSql();
  try {
    if (req.method === 'GET') {
      res.status(200).json({ tokens: await listApiTokens(sql, tenant) });
      return;
    }
    const body = await readJson(req);
    const label = String(body.label || '').trim().slice(0, 100);
    res.status(201).json({ token: await createApiToken(sql, tenant, label) });
  } catch (error) {
    sendError(res, error, 400);
  }
};
