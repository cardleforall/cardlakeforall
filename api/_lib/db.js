const { neon } = require('@neondatabase/serverless');

let sqlClient;

// Neon's serverless driver talks SQL-over-HTTP to a Neon-hosted database and
// cannot reach a plain local Postgres. Set LOCAL_DEV_PG=1 yourself in
// .env.local (never in Vercel) to swap in a `pg`-backed client exposing the
// same tagged-template / sql(text, params) call shape, so every route works
// unmodified against a local database. Without this flag, DATABASE_URL is
// used exactly as configured, so local dev must point it at a database of
// its own, never one with real data (docs/ENVIRONMENT.md).
function buildLocalPgSql(databaseUrl) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl });

  return async function sql(first, ...rest) {
    if (Array.isArray(first) && Object.prototype.hasOwnProperty.call(first, 'raw')) {
      let text = first[0];
      for (let i = 0; i < rest.length; i += 1) {
        text += `$${i + 1}` + first[i + 1];
      }
      const result = await pool.query(text, rest);
      return result.rows;
    }
    const result = await pool.query(first, rest[0]);
    return result.rows;
  };
}

function getSql() {
  // Neon/Vercel integrations expose POSTGRES_URL; keep DATABASE_URL as the
  // application-specific override used by existing local deployments.
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL or POSTGRES_URL is not configured');
  }
  if (!sqlClient) {
    sqlClient = process.env.LOCAL_DEV_PG === '1' ? buildLocalPgSql(databaseUrl) : neon(databaseUrl);
  }
  return sqlClient;
}

function normalizeEntry(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url || '',
    notes: row.notes || '',
    status: row.status,
    category: row.category,
    sort_order: Number(row.sort_order || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at || null,
  };
}

module.exports = {
  getSql,
  normalizeEntry,
};
