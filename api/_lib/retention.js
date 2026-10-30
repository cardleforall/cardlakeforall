// Deletes data once it's past the retention periods privacy.html#retention
// publishes. With CRON_SECRET set, Vercel Cron calls it daily (vercel.json
// "crons", routed through api/vault.js to stay within the Hobby function
// limit), authorised by the secret, which Vercel sends as
// "Authorization: Bearer <CRON_SECRET>". A self-hosted Cardlake usually has
// no CRON_SECRET, so then the request guard runs the same purge itself, at
// most once a day, after a request it has already answered
// (runDailyPurgeIfDue); deleted files would otherwise use Blob storage
// forever.
const crypto = require('crypto');
// Looked up at call time (blob.del), so tests can stand in for storage.
const blob = require('@vercel/blob');
const { getSql } = require('./db');
const { allowMethods, sendError } = require('./http');

const DAY_MS = 24 * 60 * 60 * 1000;
const DELETED_CARD_DAYS = 90;
const EVENT_MONTHS = 24;

function monthsBefore(now, months) {
  const date = new Date(now);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date;
}

const BLOB_BATCH = 100;

// Deleting a file or a card tries to remove its stored objects at once
// (feed.js deleteItem, attachments.js) but doesn't retry if storage fails,
// and the row is the only reference left to that object. So before a row
// goes, its object is deleted again -- a no-op if it's already gone -- and a
// row whose object can't be deleted is kept for the next run rather than
// leaving the object stored forever. `table` is one of two fixed names.
async function purgeWithStoredObjects(sql, table, cutoff, retry) {
  const rows = await sql(`select id, blob_url from ${table} where deleted_at < $1`, [cutoff]);
  const done = [];
  for (let i = 0; i < rows.length; i += BLOB_BATCH) {
    const batch = rows.slice(i, i + BLOB_BATCH);
    const urls = batch.map(row => row.blob_url).filter(Boolean);
    try {
      if (urls.length) await blob.del(urls);
      done.push(...batch.map(row => row.id));
    } catch (error) {
      retry.count += batch.length;
      console.error(`[retention] could not delete ${urls.length} stored ${table} object(s); will retry -`, error?.message || error);
    }
  }
  if (!done.length) return [];
  return sql(`delete from ${table} where id = any($1::uuid[]) returning id`, [done]);
}

// Each card table and its feed item type. Table names can't be query
// parameters, hence one statement per table.
const CARD_TABLES = [
  ['learning_entries', 'learning', (sql, cutoff) => sql`delete from learning_entries where deleted_at < ${cutoff} returning id`],
  ['kanban_items', 'kanban', (sql, cutoff) => sql`delete from kanban_items where deleted_at < ${cutoff} returning id`],
  ['work_items', 'work', (sql, cutoff) => sql`delete from work_items where deleted_at < ${cutoff} returning id`],
  ['family_updates', 'family', (sql, cutoff) => sql`delete from family_updates where deleted_at < ${cutoff} returning id`],
  ['bookmarks', 'bookmark', (sql, cutoff) => sql`delete from bookmarks where deleted_at < ${cutoff} returning id`],
  ['talking_points', 'talking_point', (sql, cutoff) => sql`delete from talking_points where deleted_at < ${cutoff} returning id`],
  ['reminders', 'reminder', (sql, cutoff) => sql`delete from reminders where deleted_at < ${cutoff} returning id`],
  ['files', 'file', (sql, cutoff, retry) => purgeWithStoredObjects(sql, 'files', cutoff, retry)],
];

// Returns how many rows each table lost. Safe to run any number of times.
async function purgeExpired(sql, now = new Date()) {
  const cardCutoff = new Date(now.getTime() - DELETED_CARD_DAYS * DAY_MS).toISOString();
  const purged = {};
  const retry = { count: 0 };
  for (const [table, itemType, remove] of CARD_TABLES) {
    const ids = (await remove(sql, cardCutoff, retry)).map(row => row.id);
    purged[table] = ids.length;
    // A card's likes, pins and snoozes mean nothing once the card is gone.
    if (ids.length) await sql`delete from feed_state where item_type = ${itemType} and item_id = any(${ids}::uuid[])`;
  }
  purged.attachments = (await purgeWithStoredObjects(sql, 'attachments', cardCutoff, retry)).length;
  purged.stored_objects_kept_for_retry = retry.count;
  purged.user_events = (await sql`delete from user_events where created_at < ${monthsBefore(now, EVENT_MONTHS).toISOString()} returning id`).length;
  return purged;
}

const LAST_RUN_KEY = 'retention_last_run';
// How often a warm instance asks the database whether the day's run is due,
// so an ordinary request doesn't pay for that query.
const CHECK_EVERY_MS = 60 * 60 * 1000;
let nextCheckAt = 0;

// Claims today's run: true for exactly one caller per day, however many
// instances ask at once (the update's where clause is the claim).
async function claimDailyRun(sql, now = new Date()) {
  const value = JSON.stringify({ at: now.toISOString() });
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  const rows = await sql`
    insert into app_config (key, value) values (${LAST_RUN_KEY}, ${value}::jsonb)
    on conflict (key) do update set value = excluded.value
      where (app_config.value->>'at')::timestamptz <= ${dayAgo}::timestamptz
    returning key
  `;
  return rows.length > 0;
}

// The purge without Vercel Cron: runs when a day has passed since the last
// run, and returns what it purged, or null when it didn't run.
async function runDailyPurgeIfDue(sql, { env = process.env, now = new Date() } = {}) {
  if (env.CRON_SECRET) return null; // Vercel Cron runs it instead.
  if (now.getTime() < nextCheckAt) return null;
  nextCheckAt = now.getTime() + CHECK_EVERY_MS;
  if (!(await claimDailyRun(sql, now))) return null;
  return purgeExpired(sql, now);
}

function isCronRequest(req, secret) {
  const provided = Buffer.from(String(req.headers?.authorization || ''));
  const expected = Buffer.from(`Bearer ${secret}`);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

async function retentionHandler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  const secret = process.env.CRON_SECRET;
  // Without the secret, anyone could call this; the purge runs anyway,
  // once a day, after requests (runDailyPurgeIfDue).
  if (!secret) return res.status(200).json({ purged: null, runs: 'after requests, at most once a day (CRON_SECRET is not set)' });
  if (!isCronRequest(req, secret)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.status(200).json({ purged: await purgeExpired(getSql()) });
  } catch (error) {
    return sendError(res, error);
  }
}

module.exports = { LAST_RUN_KEY, claimDailyRun, purgeExpired, retentionHandler, runDailyPurgeIfDue, DELETED_CARD_DAYS, EVENT_MONTHS };
