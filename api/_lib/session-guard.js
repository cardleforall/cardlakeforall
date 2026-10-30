// Session cookies are HMAC-signed and valid for 30 days from the last time
// they were used (renewSession below), and every resolver in auth.js trusts
// the signature alone. So a session would otherwise keep working after its
// owner was replaced (local-accounts.js) or signed out everywhere.
// withSessionGuard() closes that: before a handler runs, a session that
// isn't the current owner's is stripped from the request -- every
// downstream check then sees a signed-out visitor -- and the browser is told
// to drop the cookie.
//
// "Sign out on all devices" (account-routes.js) stores when it happened as
// users.sessions_revoked_at; a session issued before then is dropped here
// the same way.
//
// The lookup is cached per warm instance for ACCESS_CACHE_MS, so a change
// takes effect within that window on instances that already cached a "yes",
// and immediately on the instance that made it (forgetSessionAccess). Every
// session carries the owner's email (see auth.js); the shared tenant is
// reached only by the sync token, which is not a session.
const { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, DEFAULT_TENANT, getSessionPayload, clearSessionCookie, setSessionCookie } = require('./auth');
// isOwnerEmail is looked up at call time, like db.getSql below.
const access = require('./access-control');
const { isMissingSchema, normalizeEmail } = access;
// Looked up at call time, not destructured: this module is loaded early (via
// migrate.js), and the database client must be whatever db.js provides when
// the request actually runs.
const db = require('./db');
const { withEventLog } = require('./events');
const { ensureSchema } = require('./schema');
const { loadInstanceSecrets } = require('./instance-secrets');
const { waitUntil } = require('@vercel/functions');

const ACCESS_CACHE_MS = 30 * 1000;
// A session in use is reissued at most once a day, for another full span.
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
const accessCache = new Map();

async function sessionsRevokedAt(sql, email) {
  try {
    const rows = await sql`select sessions_revoked_at from users where email = ${email} limit 1`;
    const at = rows[0]?.sessions_revoked_at;
    return at ? new Date(at).getTime() : null;
  } catch (error) {
    if (isMissingSchema(error, 'sessions_revoked_at')) return null;
    throw error;
  }
}

// { allowed, revokedAt } for an email, cached per warm instance. allowed:
// it is the current owner's.
async function accountState(email) {
  const key = normalizeEmail(email);
  const cached = accessCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const sql = db.getSql();
  const allowed = await access.isOwnerEmail(sql, key);
  const revokedAt = allowed ? await sessionsRevokedAt(sql, key) : null;
  if (accessCache.size > 5000) accessCache.clear();
  const state = { allowed, revokedAt, expiresAt: Date.now() + ACCESS_CACHE_MS };
  accessCache.set(key, state);
  return state;
}

async function isEmailStillAllowed(email) {
  return (await accountState(email)).allowed;
}

function forgetSessionAccess(email) {
  accessCache.delete(normalizeEmail(email));
}

function stripSessionCookie(req) {
  const kept = String(req.headers.cookie || '')
    .split(';')
    .filter(part => part.trim() && !part.trim().startsWith(`${SESSION_COOKIE}=`));
  if (kept.length) req.headers.cookie = kept.join(';');
  else delete req.headers.cookie;
}

// Resolves once the request carries only a session that is still valid.
// If the owner can't be read (database unavailable), the request goes
// through unchanged: the handler needs that same database and will fail on
// its own, and failing closed here would sign the owner out on a blip.
async function dropRevokedSession(req, res) {
  const payload = getSessionPayload(req);
  if (!payload?.email) return;
  let state;
  try {
    state = await accountState(payload.email);
  } catch (_) {
    return;
  }
  const signedOutEverywhere = state.revokedAt !== null && (payload.iat || 0) <= state.revokedAt;
  if (state.allowed && !signedOutEverywhere) {
    renewSession(res, payload);
    return;
  }
  stripSessionCookie(req);
  clearSessionCookie(res);
}

// Rolling sessions: a device that keeps using Cardlake stays signed in, and
// one left unused for SESSION_MAX_AGE_SECONDS signs out by itself. Sessions
// issued before iat/ttl existed simply run out. A handler that sets its own
// cookie (signing in or out) replaces this one.
function renewSession(res, payload) {
  if (payload.ttl !== SESSION_MAX_AGE_SECONDS) return;
  if (Date.now() - payload.iat < SESSION_RENEW_AFTER_MS) return;
  setSessionCookie(res, { email: payload.email, name: payload.name, picture: payload.picture });
}

// For credentials other than the session cookie that carry an account email
// (MCP OAuth access tokens live an hour; API tokens are revoked when the
// owner is replaced, see offboarding.js). The shared tenant is not an
// account. Fails open, like the cookie guard, for the same reason.
async function isAccountActive(tenant) {
  if (!tenant || tenant === DEFAULT_TENANT) return true;
  try {
    return await isEmailStillAllowed(tenant);
  } catch (_) {
    return true;
  }
}

// The daily retention purge for a deployment without CRON_SECRET
// (retention.js). It starts once the handler has answered, so it never slows
// a request down, and waitUntil keeps the function alive until it is done
// (outside Vercel the promise simply runs). A failure is logged and dropped.
function purgeAfterResponse() {
  const purge = Promise.resolve()
    .then(() => require('./retention').runDailyPurgeIfDue(db.getSql()))
    .then(purged => { if (purged) console.log('[retention] daily purge', JSON.stringify(purged)); })
    .catch(error => { console.error('[retention] daily purge failed -', error?.message || error); });
  try { waitUntil(purge); } catch (_) { /* not on Vercel */ }
  return purge;
}

// What every request needs before its handler runs: a fresh deployment sets
// up its own database on its first request, and the secrets it generated
// are loaded for the synchronous readers in auth.js, oauth.js and
// secret-box.js. Each step logs and carries on if it fails; the handler then
// reports the error itself. Never logs a value. api/mcp.js, which takes only
// bearer credentials, calls this directly.
async function prepareRequest() {
  try { await ensureSchema(); } catch (error) { console.error('[schema] could not apply schema-v2.sql -', error?.message || error); }
  try { await loadInstanceSecrets(); } catch (error) { console.error('[secrets] could not load generated secrets -', error?.message || error); }
}

// Every deployed function is wrapped in this (a test enforces it), so it is
// also where every request's action gets recorded: see events.js.
function withSessionGuard(handler) {
  const logged = withEventLog(handler);
  return async function guarded(req, res) {
    await prepareRequest();
    await dropRevokedSession(req, res);
    const result = await logged(req, res);
    if (!process.env.CRON_SECRET) purgeAfterResponse();
    return result;
  };
}

module.exports = { withSessionGuard, prepareRequest, purgeAfterResponse, dropRevokedSession, isAccountActive, isEmailStillAllowed, forgetSessionAccess, ACCESS_CACHE_MS, SESSION_RENEW_AFTER_MS };
