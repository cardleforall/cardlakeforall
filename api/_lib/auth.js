const crypto = require('crypto');
const { instanceSecret } = require('./instance-secrets');

const SESSION_COOKIE = 'lh_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

// The environment variable, or the value this deployment generated for
// itself (instance-secrets.js).
function getSessionSecret() {
  const secret = instanceSecret('SESSION_SECRET');
  if (!secret) throw new Error('SESSION_SECRET is not configured');
  return secret;
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return raw.split(';').reduce((acc, part) => {
    const [key, ...rest] = part.trim().split('=');
    if (!key) return acc;
    acc[key] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function base64url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function sign(value) {
  return crypto.createHmac('sha256', getSessionSecret()).update(value).digest('base64url');
}

// Every session is the owner's, signed in with their password, so every
// session carries an email. Refusing to create one without keeps an
// email-less session, which would act for the shared 'default' tenant,
// from ever existing.
// iat (issued at, ms) lets "sign out on all devices" reject sessions issued
// before it; ttl (seconds) lets session-guard.js renew a session for the same
// span it was issued for.
function createSessionValue(identity, maxAgeSeconds = SESSION_MAX_AGE_SECONDS) {
  if (!identity?.email) throw new Error('A session needs a signed-in account');
  const now = Date.now();
  const payload = JSON.stringify({
    authenticated: true,
    iat: now,
    ttl: maxAgeSeconds,
    exp: now + maxAgeSeconds * 1000,
    email: identity.email,
    name: identity.name || null,
    picture: identity.picture || null,
  });
  const encoded = base64url(payload);
  return `${encoded}.${sign(encoded)}`;
}

// Returns the verified session payload ({ authenticated, exp, email, ... }),
// or null if the cookie is missing, malformed, tampered with, expired -- or
// has no email. A session without an email would act for the shared
// 'default' tenant, so even a correctly signed one is refused.
function readSessionValue(value) {
  if (!value || !value.includes('.')) return null;
  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) return null;
  const expected = sign(encoded);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.authenticated || !payload.exp || payload.exp <= Date.now() || !payload.email) return null;
    return payload;
  } catch (error) {
    return null;
  }
}

function verifySessionValue(value) {
  return readSessionValue(value) !== null;
}

function getSyncTokenFromRequest(req) {
  return req.headers['x-sync-token'] || req.headers['sync-token'] || null;
}

function isSyncTokenValid(req) {
  const configured = instanceSecret('SYNC_TOKEN');
  if (!configured) return false;
  const provided = getSyncTokenFromRequest(req);
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided);
  const configuredBuffer = Buffer.from(configured);
  if (providedBuffer.length != configuredBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, configuredBuffer);
}

function isMcpTokenValid(req) {
  const configured = process.env.MCP_TOKEN;
  if (!configured) return false;
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const provided = match ? match[1].trim() : '';
  if (!provided) return false;
  const providedBuffer = Buffer.from(provided);
  const configuredBuffer = Buffer.from(configured);
  if (providedBuffer.length !== configuredBuffer.length) return false;
  return crypto.timingSafeEqual(providedBuffer, configuredBuffer);
}

function isAuthenticatedRequest(req) {
  const cookies = parseCookies(req);
  return verifySessionValue(cookies[SESSION_COOKIE]) || isSyncTokenValid(req);
}

function requireAuth(req, res) {
  if (!isAuthenticatedRequest(req)) {
    res.status(401).json({ error: 'Authentication required' });
    return false;
  }
  return true;
}

const DEFAULT_TENANT = 'default';

function getSessionPayload(req) {
  const cookies = parseCookies(req);
  return readSessionValue(cookies[SESSION_COOKIE]);
}

// For reads: the owner's session sees only its own tenant; an anonymous visitor
// sees the public 'default' tenant (the demo). Always returns a tenant
// string, never null -- reads are never rejected.
function resolveViewerTenant(req) {
  const payload = getSessionPayload(req);
  return payload?.email || DEFAULT_TENANT;
}

// For writes: the owner's session writes to its own tenant; only the SYNC_TOKEN
// (machine/Hermes, and the production tests) writes to the shared 'default'
// tenant. Returns null when there is no valid writer identity at all.
function resolveWriterTenant(req) {
  const payload = getSessionPayload(req);
  if (payload?.email) return payload.email;
  if (isSyncTokenValid(req)) return DEFAULT_TENANT;
  return null;
}

function setSessionCookie(res, identity) {
  const maxAgeSeconds = SESSION_MAX_AGE_SECONDS;
  const value = createSessionValue(identity, maxAgeSeconds);
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  // No Domain attribute: this makes it a host-only cookie, scoped to whatever
  // host actually served the response (a custom domain, the deployment's
  // own *.vercel.app URL, or a preview). A hardcoded `Domain=.vercel.app`
  // silently breaks sign-in on any other host -- browsers refuse to store a
  // cookie whose Domain doesn't match the current page's host, so every
  // request would look signed out, even right after a successful sign-in.
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds};${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0;${secure}`);
}

module.exports = {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  DEFAULT_TENANT,
  clearSessionCookie,
  getSessionPayload,
  isAuthenticatedRequest,
  isMcpTokenValid,
  isSyncTokenValid,
  parseCookies,
  requireAuth,
  resolveViewerTenant,
  resolveWriterTenant,
  setSessionCookie,
};
