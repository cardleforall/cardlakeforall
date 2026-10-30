// Who may use this Cardlake: its owner, the one account that finished
// first-run setup (local-accounts.js). There are no other accounts, no
// allowlist and no administrators; the owner is recorded in app_config, so
// replacing them (CARDLE_SETUP_OPEN=1) takes effect everywhere at once.
'use strict';

const OWNER_KEY = 'instance_owner';
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function assertValidEmail(email) {
  const normalized = normalizeEmail(email);
  if (!EMAIL_PATTERN.test(normalized) || normalized.length > 254) {
    const error = new Error('Enter a valid email address');
    error.status = 400;
    throw error;
  }
  return normalized;
}

// The schema applies itself on the first request after a deploy
// (schema.js), so for a moment, or if that fails, a new table or column may
// not exist yet.
function isMissingSchema(error, name) {
  const message = String(error?.message || '');
  // Postgres quotes the name ("status") unless it is qualified (f.status).
  return new RegExp(`(relation|column) "?(\\w+\\.)?${name}"? does not exist`).test(message);
}

// The owner's email, or null before setup.
async function ownerEmail(sql) {
  try {
    const rows = await sql`select value from app_config where key = ${OWNER_KEY}`;
    return normalizeEmail(rows[0]?.value?.email) || null;
  } catch (error) {
    if (isMissingSchema(error, 'app_config')) return null;
    throw error;
  }
}

async function isOwnerEmail(sql, email) {
  const normalized = normalizeEmail(email);
  return Boolean(normalized) && normalized === (await ownerEmail(sql));
}

module.exports = { OWNER_KEY, assertValidEmail, isMissingSchema, isOwnerEmail, normalizeEmail, ownerEmail };
