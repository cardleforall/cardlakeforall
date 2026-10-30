// When a different email takes over this Cardlake (CARDLE_SETUP_OPEN=1,
// local-accounts.js), the previous owner loses access end to end. Recording
// the new owner already stops future sign-ins; everything below stops what
// the previous owner already holds, or already connected, from staying
// usable:
//   - API / MCP tokens are revoked (they authenticate without a session),
//   - stored GitHub credentials are wiped and synced issues hidden,
//   - their session cookie stops working on the next request (see
//     session-guard.js), and integration writes re-check the owner too.
// Their cards stay in the database, out of reach. Each step is idempotent,
// so a partial failure is fixed by running it again.
const { normalizeEmail } = require('./access-control');
const { revokeAllApiTokens } = require('./api-tokens');
const { purgeIntegrationsFor } = require('./integrations');

async function removeUserAccess(sql, email) {
  const previous = normalizeEmail(email);
  // Takes effect at once on this instance; others within ACCESS_CACHE_MS.
  require('./session-guard').forgetSessionAccess(previous);
  const apiTokens = await revokeAllApiTokens(sql, previous);
  const integrations = await purgeIntegrationsFor(sql, previous);
  await sql`update oauth_refresh_tokens set used_at = now() where user_email = ${previous} and used_at is null`;
  return { email: previous, revoked: { api_tokens: apiTokens, ...integrations } };
}

module.exports = { removeUserAccess };
