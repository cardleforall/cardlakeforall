// The per-account upload limits in limits.js, run against real Postgres
// (PGlite, see pg_harness.js). Invoked by test_limits.py as
// `node tests/unit/upload_cap_scenarios.js <name>`.
process.env.CARDLE_MAX_UPLOADS_PER_DAY = '3';
const assert = require('assert/strict');
const { createTestDb } = require('./pg_harness');
const { assertUploadAllowed, LimitError, limits } = require('../../api/_lib/limits');

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const addFile = (sql, email, { deleted = false, hoursAgo = 0, size = 1 } = {}) => sql`
  insert into files (user_email, name, mime_type, byte_size, blob_url, created_at, deleted_at)
  values (${email}, 'f.txt', 'text/plain', ${size}, 'https://blob.test/f', now() - make_interval(hours => ${hoursAgo}),
    ${deleted ? new Date().toISOString() : null})`;
const allowed = (sql, email) => assertUploadAllowed(sql, email, { size: 1 });
async function refused(sql, email) {
  await assert.rejects(allowed(sql, email), error => error instanceof LimitError && error.code === 'UPLOAD_RATE_LIMIT_REACHED');
}

const scenarios = {
  // Deleting an upload frees its storage but not its place in the daily cap:
  // otherwise uploading and deleting in a loop would never reach the cap.
  async deleted_uploads_still_count_toward_the_daily_cap() {
    const { sql } = await createTestDb();
    await addFile(sql, ALICE, { deleted: true });
    await addFile(sql, ALICE, { deleted: true });
    await allowed(sql, ALICE);
    await sql`insert into attachments (user_email, parent_type, parent_id, name, mime_type, byte_size, blob_url, deleted_at)
      values (${ALICE}, 'reminder', gen_random_uuid(), 'a', 'text/plain', 1, 'https://blob.test/a', now())`;
    await refused(sql, ALICE);
    // Uploads older than a day, and other accounts' uploads, don't count.
    await addFile(sql, BOB, { hoursAgo: 25 });
    await addFile(sql, BOB, { hoursAgo: 25, deleted: true });
    await addFile(sql, BOB, { hoursAgo: 25, deleted: true });
    await allowed(sql, BOB);
  },
  // Storage still counts only the files that are kept.
  async deleted_uploads_free_their_storage() {
    const { sql } = await createTestDb();
    const max = limits.maxFileBytesPerUser;
    await addFile(sql, ALICE, { size: max, deleted: true, hoursAgo: 30 });
    await allowed(sql, ALICE);
    await addFile(sql, ALICE, { size: max, hoursAgo: 30 });
    await assert.rejects(allowed(sql, ALICE), error => error instanceof LimitError && error.code === 'FILE_STORAGE_LIMIT_REACHED');
  },
};

const name = process.argv[2];
if (!scenarios[name]) {
  console.error(`Unknown scenario "${name}". Known: ${Object.keys(scenarios).join(', ')}`);
  process.exit(2);
}
scenarios[name]().then(() => process.exit(0), error => { console.error(error.stack || error); process.exit(1); });
