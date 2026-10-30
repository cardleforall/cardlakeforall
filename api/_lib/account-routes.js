// The HTTP side of the owner's password account (local-accounts.js):
// first-run setup, sign-in and signing out everywhere. Deployed through
// api/auth.js (the Hobby plan's function limit keeps them out of files of
// their own) and in local dev through the matching api/auth/*.js files; both
// call these.
//
//   GET  /api/auth/config     whether the app should send people to /setup
//   GET  /api/auth/setup      whether setup is open, and until when
//   POST /api/auth/setup      { name, email, password } -> the owner, signed in
//   POST /api/auth/sign-in    { email, password }
//   POST /api/auth/sign-out-everywhere   signs every device out, this one too
//   GET  /api/auth/instance   the owner's generated sync token (Connect AI)
//                             and this copy's GitHub repository (/updates)
//   GET  /api/auth/update     { available }: whether a newer Cardlake is out
'use strict';

// Looked up at call time, like session-guard.js: tests and tools swap getSql.
const db = require('./db');
const { allowMethods, allowSameOrigin, readJson, sendError } = require('./http');
const { clearSessionCookie, getSessionPayload, setSessionCookie } = require('./auth');
const { enforceRateLimit } = require('./rate-limit');
const { instanceSecret, secretSource } = require('./instance-secrets');
const accounts = require('./local-accounts');
const updates = require('./updates');

const FIFTEEN_MINUTES = 15 * 60 * 1000;
// Per source address and warm instance (rate-limit.js). Ten guesses per
// quarter hour makes guessing a 10-character password hopeless.
const LIMITS = {
  signIn: { bucket: 'password-sign-in', max: 10, windowMs: FIFTEEN_MINUTES },
  setup: { bucket: 'setup', max: 10, windowMs: FIFTEEN_MINUTES },
};

function signedIn(res, identity, status = 200) {
  setSessionCookie(res, identity);
  res.status(status).json({ authenticated: true, email: identity.email, name: identity.name, picture: identity.picture, isDefault: false });
}

function fail(res, error) {
  if (error.code && error.status) return res.status(error.status).json({ error: error.message, code: error.code });
  // Unexpected: say so in the function logs (the message only, never the body).
  console.error('[accounts]', error?.message || error);
  return sendError(res, error, error.status || 500);
}

async function setupHandler(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST'])) return;
  res.setHeader('Cache-Control', 'no-store');
  try {
    const sql = db.getSql();
    if (req.method === 'GET') {
      req.cardleEvent = false;
      res.status(200).json(await accounts.setupStatus(sql));
      return;
    }
    // Setup signs the browser in as the new owner: login CSRF (http.js).
    if (!allowSameOrigin(req, res)) return;
    if (!enforceRateLimit(req, res, LIMITS.setup)) return;
    const body = await readJson(req);
    const owner = await accounts.completeSetup(sql, body);
    req.cardleEvent = { type: 'auth.setup', user_email: owner.email };
    signedIn(res, owner, 201);
  } catch (error) {
    fail(res, error);
  }
}

async function signInHandler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  if (!allowSameOrigin(req, res)) return;
  if (!enforceRateLimit(req, res, LIMITS.signIn)) return;
  try {
    const body = await readJson(req);
    const sql = db.getSql();
    const identity = await accounts.verifyPassword(sql, body);
    await sql`update users set last_login_at = now() where email = ${identity.email}`;
    req.cardleEvent = { type: 'auth.sign_in', user_email: identity.email, context: { method: 'password' } };
    signedIn(res, identity);
  } catch (error) {
    fail(res, error);
  }
}

// A lost or shared device stays signed in until its session runs out; this
// ends every session the owner has, everywhere, at once (session-guard.js).
// Assistants connected through Connect AI keep their own tokens.
async function signOutEverywhereHandler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  if (!allowSameOrigin(req, res)) return;
  const email = getSessionPayload(req)?.email;
  if (!email) { res.status(401).json({ error: 'Sign in first.', code: 'AUTH_REQUIRED' }); return; }
  try {
    // The app's clock, which also stamps sessions (auth.js), not the
    // database's: a skew between the two could reject the next sign-in.
    await db.getSql()`update users set sessions_revoked_at = ${new Date().toISOString()} where email = ${email}`;
    // Takes effect at once here; other warm instances within ACCESS_CACHE_MS.
    require('./session-guard').forgetSessionAccess(email);
    req.cardleEvent = { type: 'auth.sign_out_everywhere' };
    clearSessionCookie(res);
    res.status(200).json({ signedOut: true });
  } catch (error) {
    fail(res, error);
  }
}

// What the pages need before anyone signs in: only whether to send people
// to /setup, because nobody owns this Cardlake yet.
async function configHandler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  res.setHeader('Cache-Control', 'no-store');
  let setupNeeded = false;
  try { setupNeeded = (await accounts.setupStatus(db.getSql())).needed; } catch (_) { /* database unavailable: send people to sign-in */ }
  res.status(200).json({ setupNeeded });
}

// The sync token, for the owner only, under Connect AI -> Advanced. Only a
// generated one is shown: a token set in Vercel is never echoed back (the
// owner already has it there).
function instanceHandler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (!getSessionPayload(req)?.email) { res.status(401).json({ error: 'Sign in first.', code: 'AUTH_REQUIRED' }); return; }
  req.cardleEvent = false;
  const source = secretSource('SYNC_TOKEN');
  res.status(200).json({
    sync_token: { source, value: source === 'generated' ? instanceSecret('SYNC_TOKEN') : null },
    repository: githubRepository(),
  });
}

// The GitHub repository this copy deploys from, so /updates can link to it.
// Vercel sets these on deployments from Git; anywhere else it's null and the
// page asks the owner instead.
function githubRepository() {
  const { VERCEL_GIT_PROVIDER: provider, VERCEL_GIT_REPO_OWNER: owner, VERCEL_GIT_REPO_SLUG: slug } = process.env;
  if (provider !== 'github' || !owner || !slug) return null;
  return { full_name: `${owner}/${slug}`, branch: process.env.VERCEL_GIT_COMMIT_REF || 'main' };
}

// Whether to show the owner "Update available" (vault.js; updates.js says how). Only a copy that
// deploys from GitHub can update with the Update Cardlake workflow.
async function updateHandler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (!getSessionPayload(req)?.email) { res.status(401).json({ error: 'Sign in first.', code: 'AUTH_REQUIRED' }); return; }
  req.cardleEvent = false;
  if (!githubRepository()) { res.status(200).json({ available: false }); return; }
  let startedAt = null;
  try { startedAt = await accounts.instanceStartedAt(db.getSql()); } catch (_) { /* database unavailable: no date to go by */ }
  const running = updates.runningCardlake(startedAt);
  const available = running ? updates.isNewer(await updates.latestCardlake(), running) : false;
  res.status(200).json({ available });
}

module.exports = { PASSWORD_SIGN_IN_LIMIT: LIMITS.signIn, configHandler, instanceHandler, setupHandler, signInHandler, signOutEverywhereHandler, updateHandler };
