// Production consolidates the dashboard/integrations routes through this single
// file (see .vercelignore and api/auth.js's matching comment) to stay within the
// Vercel Hobby serverless-function limit; getDashboardStats() here duplicates
// api/dashboard/stats.js, which is kept for local dev (dev_server.js routes to it
// directly by filesystem path) and must be kept in sync with this file. The
// integrations routes have no copy to keep in sync: both entry points call
// api/_lib/integration-handlers.js.
const { collection, item } = require('./_lib/resources');
const { withSessionGuard } = require('./_lib/session-guard');
const configs = require('./_lib/resource-configs');
const { getSql } = require('./_lib/db');
const { resolveViewerTenant } = require('./_lib/auth');
const { allowMethods, sendError } = require('./_lib/http');
const { listIntegrations, githubConnection, githubSync, integrationAction } = require('./_lib/integration-handlers');
const { clientEventsHandler } = require('./_lib/events');
const { onboardingHandler } = require('./_lib/onboarding');
const { surpriseHandler } = require('./_lib/surprise');
const { retentionHandler } = require('./_lib/retention');
const { cspReportHandler } = require('./_lib/csp-report');

async function getDashboardStats(sql, tenant) {
  const [learnings, kanban, work, family, bookmarks, talkingPoints, reminders] = await Promise.all([
    sql`select count(*)::int as count from learning_entries where deleted_at is null and user_email = ${tenant}`,
    sql`select count(*)::int as count from kanban_items where deleted_at is null and user_email = ${tenant}`,
    sql`select count(*)::int as count from work_items where deleted_at is null and user_email = ${tenant}`,
    sql`select count(*)::int as count from family_updates where deleted_at is null and user_email = ${tenant}`,
    sql`select count(*)::int as count from bookmarks where deleted_at is null and user_email = ${tenant}`,
    sql`select count(*)::int as count from talking_points where deleted_at is null and user_email = ${tenant}`,
    sql`select count(*)::int as count from reminders where deleted_at is null and user_email = ${tenant}`,
  ]);
  return {
    learning_entries: learnings[0].count, kanban_items: kanban[0].count,
    work_items: work[0].count, family_updates: family[0].count,
    bookmarks: bookmarks[0].count, talking_points: talkingPoints[0].count,
    reminders: reminders[0].count,
  };
}

async function stats(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const sql = getSql();
    const tenant = resolveViewerTenant(req);
    return res.status(200).json({ stats: await getDashboardStats(sql, tenant) });
  } catch (error) { return sendError(res, error); }
}

module.exports = withSessionGuard(async function handler(req, res) {
  const { resource, action, id } = req.query;
  if (resource === 'dashboard' && action === 'stats') return stats(req, res);
  // Browsers report what the report-only Content-Security-Policy would block.
  if (resource === 'csp-report') return cspReportHandler(req, res);
  if (resource === 'events') return clientEventsHandler(req, res);
  if (resource === 'onboarding') return onboardingHandler(req, res);
  if (resource === 'surprise') return surpriseHandler(req, res);
  // Vercel Cron, daily (vercel.json); authorised by CRON_SECRET, not a session.
  if (resource === 'retention') return retentionHandler(req, res);
  if (resource === 'integrations' && req.query.provider === 'github' && action === 'sync') return githubSync(req, res);
  if (resource === 'integrations' && req.query.provider === 'github') return githubConnection(req, res);
  if (resource === 'integrations' && req.query.integration) return integrationAction(req, res);
  if (resource === 'integrations' && !req.query.provider) return listIntegrations(req, res);
  const resourceMap = { 'talking-points': 'talkingPoints' };
  const config = configs[resourceMap[resource] || resource];
  if (!config) return res.status(404).json({ error: 'Not found' });
  if (id) {
    req.query.id = id;
    return item(config)(req, res);
  }
  return collection(config)(req, res);
});

module.exports.getDashboardStats = getDashboardStats;