// Production consolidates the auth routes through this single file (see
// .vercelignore) to stay within the Vercel Hobby serverless-function limit.
// It must not require() the individual api/auth/*.js files -- .vercelignore
// excludes that whole directory from the deployed bundle, so any such
// require() throws at runtime (FUNCTION_INVOCATION_FAILED). Instead this
// file inlines the same logic those files have, depending only on _lib/
// (which is never excluded) -- the same pattern api/vault.js already uses
// for the kanban/work/family/etc. consolidation. The individual
// api/auth/*.js files are kept for local dev (dev_server.js routes to them
// directly by filesystem path) and must be kept in sync with this file.
const { withSessionGuard } = require('./_lib/session-guard');
const { getSql } = require('./_lib/db');
const { allowMethods, readJson, sendError } = require('./_lib/http');
const { clearSessionCookie, getSessionPayload, isAuthenticatedRequest, resolveWriterTenant } = require('./_lib/auth');
const { createApiToken, listApiTokens, revokeApiToken } = require('./_lib/api-tokens');
const { authorizationMetadata } = require('./_lib/oauth');
const { configHandler, instanceHandler, setupHandler, signInHandler, signOutEverywhereHandler, updateHandler } = require('./_lib/account-routes');

async function logout(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  req.cardleEvent = { type: 'auth.sign_out' };
  clearSessionCookie(res);
  res.status(200).json({ authenticated: false });
}

async function session(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  const payload = getSessionPayload(req);
  if (payload?.email) {
    res.status(200).json({ authenticated: true, email: payload.email, name: payload.name || null, picture: payload.picture || null, isDefault: false });
    return;
  }
  res.status(200).json({ authenticated: isAuthenticatedRequest(req), email: null, name: null, picture: null, isDefault: true });
}

async function oauthMetadata(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  res.status(200).json(authorizationMetadata(req));
}

// Personal access tokens for machine clients (e.g. the MCP server) to act as
// the signed-in owner without their session cookie. Requires the same writer
// identity as any other write, since a token is just another way to
// authenticate as one.
async function tokens(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST', 'DELETE'])) return;
  const tenant = resolveWriterTenant(req);
  if (!tenant) { res.status(401).json({ error: 'Authentication required' }); return; }
  const sql = getSql();
  try {
    if (req.method === 'GET') {
      res.status(200).json({ tokens: await listApiTokens(sql, tenant) });
      return;
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      const label = String(body.label || '').trim().slice(0, 100);
      res.status(201).json({ token: await createApiToken(sql, tenant, label) });
      return;
    }
    const id = req.query.id;
    if (!id) { res.status(400).json({ error: 'Token id is required' }); return; }
    const revoked = await revokeApiToken(sql, tenant, id);
    if (!revoked) { res.status(404).json({ error: 'Token not found' }); return; }
    res.status(200).json({ revoked: true });
  } catch (error) {
    sendError(res, error, 400);
  }
}

module.exports = withSessionGuard(async function handler(req, res) {
  const { action } = req.query || {};
  if (action === 'logout') return logout(req, res);
  if (action === 'session') return session(req, res);
  if (action === 'config') return configHandler(req, res);
  if (action === 'setup') return setupHandler(req, res);
  if (action === 'sign-in') return signInHandler(req, res);
  if (action === 'sign-out-everywhere') return signOutEverywhereHandler(req, res);
  if (action === 'instance') return instanceHandler(req, res);
  if (action === 'update') return updateHandler(req, res);
  if (action === 'oauth-metadata') return oauthMetadata(req, res);
  if (action === 'tokens') return tokens(req, res);
  return res.status(404).json({ error: 'Not found' });
});
