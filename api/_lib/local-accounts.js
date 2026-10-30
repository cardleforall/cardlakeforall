// The owner's password account: this Cardlake's only account, so it needs
// no Google Cloud project and nobody to administer.
//
//   First-run setup: the first person to finish /setup becomes the owner.
//   Setup is open only for SETUP_WINDOW_MS after the database was first set
//   up, so a stranger who finds a forgotten deployment can't claim it.
//   CARDLE_SETUP_OPEN=1 reopens it: the owner sets their password again
//   (the same email keeps its cards), or a different email replaces the
//   owner. It is also how a forgotten password is replaced (docs/ADMIN.md).
//
// The email address isn't verified: it is what the owner signs in with.
'use strict';

const bcrypt = require('bcryptjs');
const { INSTANCE_CREATED_KEY } = require('./schema');
const { OWNER_KEY, assertValidEmail, isMissingSchema, normalizeEmail, ownerEmail } = require('./access-control');

const SETUP_WINDOW_MS = 60 * 60 * 1000;
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 10;
// bcrypt ignores everything after 72 bytes; refuse longer passwords rather
// than silently accept a different one.
const MAX_PASSWORD_BYTES = 72;
const MAX_NAME_LENGTH = 100;
// Compared against when an email has no password, so a wrong email takes as
// long as a wrong password and doesn't reveal which email is the owner's.
const DUMMY_HASH = bcrypt.hashSync('cardlake-no-such-account', BCRYPT_ROUNDS);

function accountError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function setupReopened(env = process.env) {
  return env.CARDLE_SETUP_OPEN === '1';
}

function assertPassword(password) {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD_LENGTH) throw accountError(400, 'PASSWORD_TOO_SHORT', `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_BYTES) throw accountError(400, 'PASSWORD_TOO_LONG', 'That password is too long. Use at most 72 characters.');
  return value;
}

function cleanName(name) {
  return String(name ?? '').trim().slice(0, MAX_NAME_LENGTH) || null;
}

async function readConfig(sql, key) {
  try {
    const rows = await sql`select value from app_config where key = ${key}`;
    return rows[0]?.value || null;
  } catch (error) {
    if (isMissingSchema(error, 'app_config')) return null;
    throw error;
  }
}

// { needed, open, reason, closes_at }. needed: there is no owner yet, so the
// app sends people to /setup. reason: 'new' (open, first run), 'reopened'
// (CARDLE_SETUP_OPEN=1), 'expired' (the window passed with nobody set up),
// 'done' (there is an owner).
async function setupStatus(sql, now = Date.now()) {
  const needed = !(await ownerEmail(sql));
  if (setupReopened()) return { needed, open: true, reason: 'reopened', closes_at: null };
  if (!needed) return { needed, open: false, reason: 'done', closes_at: null };
  const created = Date.parse((await readConfig(sql, INSTANCE_CREATED_KEY))?.at || '');
  // No record means the schema hasn't been applied by this code: stay closed.
  if (!Number.isFinite(created)) return { needed, open: false, reason: 'expired', closes_at: null };
  const closesAt = created + SETUP_WINDOW_MS;
  return { needed, open: now < closesAt, reason: now < closesAt ? 'new' : 'expired', closes_at: new Date(closesAt).toISOString() };
}

// When this Cardlake first started (schema.js records it), as an ISO string.
async function instanceStartedAt(sql) {
  return (await readConfig(sql, INSTANCE_CREATED_KEY))?.at || null;
}

async function upsertOwnerAccount(sql, { email, name, passwordHash }) {
  await sql`
    insert into users (email, name, password_hash, password_changed_at, last_login_at)
    values (${email}, ${name}, ${passwordHash}, now(), now())
    on conflict (email) do update set
      name = coalesce(excluded.name, users.name),
      password_hash = excluded.password_hash,
      password_changed_at = now(),
      last_login_at = now()
  `;
}

// Makes the person the owner. Two people racing on a fresh instance can't
// both win: the owner record's unique key lets exactly one insert through.
async function completeSetup(sql, { name, email, password } = {}) {
  const status = await setupStatus(sql);
  if (!status.open) {
    throw accountError(403, 'SETUP_CLOSED', status.reason === 'done'
      ? 'This Cardlake is already set up. Sign in instead.'
      : 'Setup has closed. See the instructions on this page to reopen it.');
  }
  const owner = assertValidEmail(email);
  const ownerName = cleanName(name);
  const passwordHash = await bcrypt.hash(assertPassword(password), BCRYPT_ROUNDS);
  const record = JSON.stringify({ email: owner, at: new Date().toISOString() });
  const previousOwner = status.reason === 'reopened' ? await ownerEmail(sql) : null;
  if (status.reason === 'reopened') {
    await sql`insert into app_config (key, value) values (${OWNER_KEY}, ${record}::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()`;
  } else {
    const claimed = await sql`insert into app_config (key, value) values (${OWNER_KEY}, ${record}::jsonb) on conflict (key) do nothing returning key`;
    if (!claimed.length) throw accountError(409, 'SETUP_TAKEN', 'Someone else finished setup first. If that wasn\'t you, see the instructions on this page.');
  }
  await upsertOwnerAccount(sql, { email: owner, name: ownerName, passwordHash });
  // A different email taking the instance back: the previous owner's
  // sessions stop on their next request (they are no longer the owner), and
  // what they connected stops too. Their cards stay, out of reach.
  if (previousOwner && previousOwner !== owner) {
    const { removeUserAccess } = require('./offboarding');
    await removeUserAccess(sql, previousOwner);
  }
  return { email: owner, name: ownerName, picture: null };
}

// Returns the identity to sign in, or throws a 401 that doesn't say which of
// email or password was wrong. Only the current owner can sign in: a
// replaced owner's password is refused the same way as a wrong one.
async function verifyPassword(sql, { email, password } = {}) {
  const normalized = normalizeEmail(email);
  const owner = await ownerEmail(sql);
  // The same queries either way, then bcrypt either way.
  const rows = normalized ? await sql`select email, name, picture_url, password_hash from users where email = ${normalized} limit 1` : [];
  const account = normalized === owner ? rows[0] : null;
  const matches = await bcrypt.compare(String(password ?? ''), account?.password_hash || DUMMY_HASH);
  if (!account?.password_hash || !matches) throw accountError(401, 'WRONG_PASSWORD', 'That email and password don\'t match.');
  return { email: account.email, name: account.name || null, picture: account.picture_url || null };
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  SETUP_WINDOW_MS,
  completeSetup,
  instanceStartedAt,
  setupReopened,
  setupStatus,
  verifyPassword,
};
