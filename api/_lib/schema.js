// Applies schema-v2.sql by itself, so a fresh deployment works without
// anyone running POST /api/migrate. The first request on each warm instance
// compares a hash of the schema file with the one stored in app_config and
// applies the file only when they differ. schema-v2.sql is additive and safe
// to re-run, which is what makes applying it unattended acceptable.
//
// Neon's HTTP driver sends every query on its own connection, so a session
// advisory lock would not be held across statements. Concurrency is handled
// instead by one in-flight application per instance, and by retrying once:
// two instances racing on "create table if not exists" can make one fail on
// a catalog conflict, and the second attempt then finds the objects present.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'schema-v2.sql');
const SCHEMA_HASH_KEY = 'schema_hash';
const INSTANCE_CREATED_KEY = 'instance_created_at';

function splitStatements(sql) {
  const statements = [];
  let current = '';
  let dollarQuoted = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const pair = sql.slice(i, i + 2);
    if (lineComment) {
      current += sql[i];
      if (sql[i] === '\n') lineComment = false;
    } else if (blockComment) {
      current += pair === '*/' ? pair : sql[i];
      if (pair === '*/') { blockComment = false; i += 1; }
    } else if (!dollarQuoted && pair === '--') {
      lineComment = true;
      current += pair;
      i += 1;
    } else if (!dollarQuoted && pair === '/*') {
      blockComment = true;
      current += pair;
      i += 1;
    } else if (pair === '$$') {
      dollarQuoted = !dollarQuoted;
      current += '$$';
      i += 1;
    } else if (sql[i] === ';' && !dollarQuoted) {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else {
      current += sql[i];
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function readSchema() {
  const text = fs.readFileSync(SCHEMA_PATH, 'utf8');
  return { text, hash: crypto.createHash('sha256').update(text).digest('hex') };
}

async function storedHash(sql) {
  try {
    const rows = await sql`select value from app_config where key = ${SCHEMA_HASH_KEY}`;
    return rows[0]?.value?.hash || null;
  } catch (error) {
    // A brand-new database has no app_config yet.
    if (/relation "?app_config"? does not exist/.test(String(error?.message || ''))) return null;
    throw error;
  }
}

async function applySchema(sql, { text, hash } = readSchema()) {
  const statements = splitStatements(text);
  for (const statement of statements) await sql(statement);
  await sql`
    insert into app_config (key, value) values (${SCHEMA_HASH_KEY}, ${JSON.stringify({ hash, applied_at: new Date().toISOString() })}::jsonb)
    on conflict (key) do update set value = excluded.value, updated_at = now()
  `;
  // The first application ever starts first-run setup's window
  // (local-accounts.js); later ones leave it alone.
  await sql`
    insert into app_config (key, value) values (${INSTANCE_CREATED_KEY}, ${JSON.stringify({ at: new Date().toISOString() })}::jsonb)
    on conflict (key) do nothing
  `;
  return statements.length;
}

async function applyIfChanged(sql) {
  const schema = readSchema();
  if ((await storedHash(sql)) === schema.hash) return false;
  try {
    await applySchema(sql, schema);
  } catch (error) {
    if ((await storedHash(sql)) === schema.hash) return true; // another instance finished it
    await applySchema(sql, schema);
  }
  return true;
}

let ready = null;

// Resolves once this instance has confirmed the schema is current. A failure
// is not cached, so the next request tries again.
function ensureSchema() {
  if (!ready) {
    ready = applyIfChanged(db.getSql()).catch(error => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

function resetSchemaCache() { ready = null; }

module.exports = { INSTANCE_CREATED_KEY, SCHEMA_HASH_KEY, applySchema, ensureSchema, readSchema, resetSchemaCache, splitStatements };
