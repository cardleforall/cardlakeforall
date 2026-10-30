const crypto = require('crypto');
const { isMcpTokenValid, DEFAULT_TENANT } = require('./auth');

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createApiToken(sql, userEmail, label) {
  const token = generateToken();
  const rows = await sql`
    insert into api_tokens (user_email, token_hash, label)
    values (${userEmail}, ${hashToken(token)}, ${label || ''})
    returning id, label, created_at
  `;
  // The plaintext exists only in this return value -- callers must hand it
  // to the user immediately, since it can never be looked up again.
  return { ...rows[0], token };
}

async function listApiTokens(sql, userEmail) {
  return sql`
    select id, label, created_at, last_used_at
    from api_tokens
    where user_email = ${userEmail} and revoked_at is null
    order by created_at desc
  `;
}

// Every live token for an account at once (used when the account loses access).
async function revokeAllApiTokens(sql, userEmail) {
  const rows = await sql`update api_tokens set revoked_at = now() where user_email = ${userEmail} and revoked_at is null returning id`;
  return rows.length;
}

async function revokeApiToken(sql, userEmail, id) {
  const rows = await sql`
    update api_tokens set revoked_at = now()
    where id = ${id} and user_email = ${userEmail} and revoked_at is null
    returning id
  `;
  return rows.length > 0;
}

function getBearerToken(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  return match ? match[1].trim() : '';
}

async function resolveApiTokenTenant(sql, req) {
  const provided = getBearerToken(req);
  if (!provided) return null;
  const tokenHash = hashToken(provided);
  const rows = await sql`select user_email from api_tokens where token_hash = ${tokenHash} and revoked_at is null`;
  if (!rows.length) return null;
  // Best-effort; a failed write here should never block the actual request.
  sql`update api_tokens set last_used_at = now() where token_hash = ${tokenHash}`.catch(() => {});
  return rows[0].user_email;
}

// A user's own personal access token takes priority; MCP_TOKEN remains a
// single machine credential scoped to the 'default' tenant only (same role
// as SYNC_TOKEN elsewhere), for callers that predate per-user tokens.
async function resolveMcpTenant(sql, req) {
  const viaToken = await resolveApiTokenTenant(sql, req);
  if (viaToken) return viaToken;
  if (isMcpTokenValid(req)) return DEFAULT_TENANT;
  return null;
}

module.exports = { createApiToken, listApiTokens, revokeAllApiTokens, revokeApiToken, resolveApiTokenTenant, resolveMcpTenant };
