const { getSql } = require('../_lib/db');
const { resolveViewerTenant } = require('../_lib/auth');
const { allowMethods, sendError } = require('../_lib/http');

module.exports = async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const sql = getSql();
    const tenant = resolveViewerTenant(req);
    const [learnings, kanban, work, family, bookmarks, talkingPoints, reminders] = await Promise.all([
      sql`select count(*)::int as count from learning_entries where deleted_at is null and user_email = ${tenant}`,
      sql`select count(*)::int as count from kanban_items where deleted_at is null and user_email = ${tenant}`,
      sql`select count(*)::int as count from work_items where deleted_at is null and user_email = ${tenant}`,
      sql`select count(*)::int as count from family_updates where deleted_at is null and user_email = ${tenant}`,
      sql`select count(*)::int as count from bookmarks where deleted_at is null and user_email = ${tenant}`,
      sql`select count(*)::int as count from talking_points where deleted_at is null and user_email = ${tenant}`,
      sql`select count(*)::int as count from reminders where deleted_at is null and user_email = ${tenant}`,
    ]);
    return res.status(200).json({ stats: {
      learning_entries: learnings[0].count, kanban_items: kanban[0].count,
      work_items: work[0].count, family_updates: family[0].count,
      bookmarks: bookmarks[0].count, talking_points: talkingPoints[0].count,
      reminders: reminders[0].count,
    } });
  } catch (error) { return sendError(res, error); }
};
