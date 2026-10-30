// In-process Postgres for unit tests. PGlite is real Postgres compiled to
// WASM, so queries here fail exactly the way they would against Neon (type
// errors, ON CONFLICT inference, constraint violations) -- the class of bug
// the source-regex tests in this directory cannot see (tests/README.md's
// case study). Nothing touches the network or the shared DATABASE_URL.
const { PGlite } = require('@electric-sql/pglite');
const { pgcrypto } = require('@electric-sql/pglite/contrib/pgcrypto');
const schemaModule = require('../../api/_lib/schema');

// Same call shapes as the Neon client (and db.js's local `pg` shim): a tagged
// template, or sql(text, params).
function neonCompatible(db) {
  return async function sql(first, ...rest) {
    if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw')) {
      let text = first[0];
      for (let i = 0; i < rest.length; i += 1) text += `$${i + 1}${first[i + 1]}`;
      return (await db.query(text, rest)).rows;
    }
    return (await db.query(first, rest[0] || [])).rows;
  };
}

// Records the schema's hash too, like a deployment that has applied it, so
// the request guard's own schema check (api/_lib/schema.js) finds it current
// and leaves alone any pre-migration state a scenario sets up afterwards.
async function applySchema(sql) {
  await schemaModule.applySchema(sql);
}

// Returns a Neon-compatible `sql` backed by a fresh database with the full
// schema applied. Pass { schema: false } to seed legacy state before migrating.
async function createTestDb({ schema = true } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  const sql = neonCompatible(db);
  if (schema) await applySchema(sql);
  return { db, sql, applySchema: () => applySchema(sql) };
}

// Production has one account, its owner (api/_lib/access-control.js).
// Scenarios that need several tenants stand in made-up accounts here, as
// CARDLE_ALLOWED_EMAILS once listed them: their sessions pass the request
// guard as the owner's would. Takes comma-separated emails.
function allowAccounts(...lists) {
  const access = require('../../api/_lib/access-control');
  const allowed = new Set(lists.join(',').split(',').map(access.normalizeEmail).filter(Boolean));
  access.isOwnerEmail = async (_sql, email) => allowed.has(access.normalizeEmail(email));
}

module.exports = { allowAccounts, createTestDb };
