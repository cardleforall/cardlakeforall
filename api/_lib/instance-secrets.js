// The secrets a deployment needs, without anyone typing them. Each one comes
// from its environment variable when that is set -- so existing deployments
// keep exactly the values they have -- and is otherwise generated once (32
// random bytes) and kept in the instance_secrets table.
//
// SESSION_SECRET and SYNC_TOKEN are generated whenever their variable is
// unset. OAUTH_SIGNING_SECRET and INTEGRATION_ENCRYPTION_KEY have always
// fallen back to SESSION_SECRET, so they are generated only when
// SESSION_SECRET isn't set either; a deployment that sets SESSION_SECRET keeps
// that fallback unchanged.
//
// A generated INTEGRATION_ENCRYPTION_KEY sits in the same database as the
// credentials it encrypts, so it only protects against a leaked copy of the
// integrations table on its own (docs/ENVIRONMENT.md). Set the variable to
// keep the key out of the database.
//
// Callers read secrets synchronously (signing a cookie happens deep inside
// request handling), so withSessionGuard() loads them once per cold start
// before any handler runs, and instanceSecret() reads that copy.
'use strict';

const crypto = require('crypto');
const db = require('./db');

const SECRETS = {
  SESSION_SECRET: { encoding: 'hex' },
  SYNC_TOKEN: { encoding: 'hex' },
  OAUTH_SIGNING_SECRET: { encoding: 'hex', onlyWithout: 'SESSION_SECRET' },
  // secret-box.js expects 32 bytes, base64-encoded.
  INTEGRATION_ENCRYPTION_KEY: { encoding: 'base64', onlyWithout: 'SESSION_SECRET' },
};

const generated = new Map();
let loading = null;

function isSet(name, env) {
  return Boolean(env[name]);
}

// The secrets this deployment must generate, given its environment.
function secretsToGenerate(env = process.env) {
  return Object.entries(SECRETS)
    .filter(([name, { onlyWithout }]) => !isSet(name, env) && !(onlyWithout && isSet(onlyWithout, env)))
    .map(([name]) => name);
}

function newValue(name) {
  return crypto.randomBytes(32).toString(SECRETS[name].encoding);
}

// Two cold starts can race to generate the same secret; "on conflict do
// nothing" and reading back afterwards make both use whichever was stored
// first.
async function loadFrom(sql, names) {
  if (!names.length) return;
  let rows = await sql`select name, value from instance_secrets where name = any(${names})`;
  const missing = names.filter(name => !rows.some(row => row.name === name));
  if (missing.length) {
    for (const name of missing) {
      await sql`insert into instance_secrets (name, value) values (${name}, ${newValue(name)}) on conflict (name) do nothing`;
    }
    rows = await sql`select name, value from instance_secrets where name = any(${names})`;
  }
  for (const row of rows) generated.set(row.name, row.value);
}

// Resolves once every secret this deployment generates is in memory. A
// failure isn't cached: the next request tries again.
function loadInstanceSecrets() {
  const names = secretsToGenerate();
  if (names.every(name => generated.has(name))) return Promise.resolve();
  if (!loading) {
    loading = loadFrom(db.getSql(), names).finally(() => { loading = null; });
  }
  return loading;
}

// The environment variable when set, else the generated value, else null.
function instanceSecret(name) {
  return process.env[name] || generated.get(name) || null;
}

// Where a secret comes from, for Connect AI: 'environment', 'generated',
// or null when it is neither (not loaded, or never generated here).
function secretSource(name) {
  if (process.env[name]) return 'environment';
  return generated.has(name) ? 'generated' : null;
}

function forgetInstanceSecrets() { generated.clear(); }

module.exports = { SECRETS, forgetInstanceSecrets, instanceSecret, loadInstanceSecrets, secretSource, secretsToGenerate };
