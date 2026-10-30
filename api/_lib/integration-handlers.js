// HTTP handlers for /api/integrations/*. Production reaches them through
// api/vault.js (the Vercel function-count consolidation, see .vercelignore);
// local dev reaches them through the thin files under api/integrations/. Both
// entry points call these exact functions, so there is no copy to keep in sync
// -- the previous copies had already drifted (only one enforced card limits).
const { getSql } = require('./db');
const { resolveViewerTenant, resolveWriterTenant } = require('./auth');
const { allowMethods, readJson, sendError } = require('./http');
const { getIntegrationDefinition } = require('./integration-registry');
const {
  getIntegrations, getIntegration, publicIntegrationView, publicIntegrationList,
  saveGithubConnection, saveOnboardingStep, acknowledgeIntegration,
  disconnectIntegration, recordSyncSuccess, recordSyncFailure, getGithubCredentials, IntegrationError,
  assertIntegrationWriter,
} = require('./integrations');
const { enforceRateLimit } = require('./rate-limit');

// Connect tries a token against GitHub, so it gets the same budget as a
// password login; sync is cheaper but still spends the user's GitHub quota.
const CONNECT_RATE_LIMIT = { bucket: 'integration-connect', max: 10, windowMs: 10 * 60 * 1000 };
const SYNC_RATE_LIMIT = { bucket: 'integration-sync', max: 30, windowMs: 10 * 60 * 1000 };
const { validateGithubAccess, fetchIssues } = require('./github');
const { limits, LimitError, assertInputLimits, getCardUsage, textBytesForCard } = require('./limits');

const GITHUB_ISSUES = getIntegrationDefinition('github_issues');
// GitHub's own rules: owners are alphanumeric plus hyphens; repo names also
// allow '.' and '_'. Anything else would be interpolated into an API path.
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

async function githubIssueCount(sql, tenant) {
  const rows = await sql`select count(*)::int as count from kanban_items where user_email = ${tenant} and external_source = 'github' and deleted_at is null`;
  return rows[0].count;
}

// One counter per integration id. Table names cannot be query parameters, so
// each integration gets its own static query rather than an interpolated one.
const CARD_COUNTERS = { github_issues: githubIssueCount };

async function cardCounts(sql, tenant) {
  const entries = await Promise.all(Object.entries(CARD_COUNTERS).map(async ([id, count]) => [id, await count(sql, tenant)]));
  return Object.fromEntries(entries);
}

async function integrationView(sql, tenant, definition) {
  const row = await getIntegration(sql, tenant, definition.id);
  return publicIntegrationView(definition, row, { cardCount: await CARD_COUNTERS[definition.id](sql, tenant) });
}

const githubIssuesView = (sql, tenant) => integrationView(sql, tenant, GITHUB_ISSUES);

// GET /api/integrations -- every registered integration and its state for the
// viewer. Public like every other list endpoint (an anonymous visitor sees the
// demo tenant's); never includes credentials.
async function listIntegrations(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const sql = getSql();
    const tenant = resolveViewerTenant(req);
    const rows = await getIntegrations(sql, tenant);
    return res.status(200).json({ integrations: publicIntegrationList(rows, await cardCounts(sql, tenant)) });
  } catch (error) { return sendError(res, error); }
}

// GitHub has no backlog/in-progress/done concept. A closed issue is done; an
// open, assigned issue is in progress; anything else sits in the backlog.
function mapGithubIssueStatus(issue) {
  if (issue.state === 'closed') return 'done';
  return issue.assignees && issue.assignees.length ? 'in_progress' : 'backlog';
}

// Upserts the repo's issues as the tenant's Kanban cards and soft-deletes
// cards for issues that no longer come back. Card and text limits apply the
// same as any other way of creating cards.
async function syncGithubKanban(sql, tenant, { token, owner, repo }) {
  const issues = await fetchIssues(token, owner, repo);
  const usage = await getCardUsage(sql, tenant);
  const seenIds = [];
  for (let index = 0; index < issues.length; index += 1) {
    const issue = issues[index];
    const externalId = `${owner}/${repo}#${issue.number}`;
    seenIds.push(externalId);
    const source = `GitHub: ${owner}/${repo}`;
    const nextCard = { title: issue.title, description: issue.body || '', source };
    assertInputLimits('kanban', nextCard);
    const currentRows = await sql`select title, asin, description, source, deleted_at from kanban_items where user_email = ${tenant} and external_source = 'github' and external_id = ${externalId} limit 1`;
    const current = currentRows[0] || null;
    const isLive = !!current && !current.deleted_at;
    const textDelta = textBytesForCard('kanban', nextCard) - (isLive ? textBytesForCard('kanban', current) : 0);
    if (!isLive && usage.cards >= limits.maxCardsPerUser) {
      throw new LimitError(409, 'CARD_LIMIT_REACHED', `GitHub sync would exceed the ${limits.maxCardsPerUser}-card limit. Remove cards or reduce the imported issues.`, { used: usage.cards, limit: limits.maxCardsPerUser, resource: 'cards' });
    }
    if (usage.textBytes + Math.max(0, textDelta) > limits.maxTextBytesPerUser) {
      throw new LimitError(409, 'TEXT_STORAGE_LIMIT_REACHED', 'GitHub sync would exceed the text storage limit. Shorten issue content or remove older cards.', { used: usage.textBytes, limit: limits.maxTextBytesPerUser, resource: 'text_storage' });
    }
    const labels = JSON.stringify((issue.labels || []).map(label => (typeof label === 'string' ? label : label.name)).filter(Boolean));
    // The conflict target must repeat the partial index's predicate, or
    // Postgres cannot match it to kanban_items_external_tenant_unique.
    await sql`
      insert into kanban_items (user_email, title, description, status, source, external_source, external_id, external_url, labels, sort_order)
      values (${tenant}, ${issue.title}, ${issue.body || ''}, ${mapGithubIssueStatus(issue)}, ${source}, 'github', ${externalId}, ${issue.html_url}, ${labels}::jsonb, ${index})
      on conflict (user_email, external_source, external_id) where external_id is not null do update set
        title = excluded.title, description = excluded.description, status = excluded.status,
        external_url = excluded.external_url, labels = excluded.labels, sort_order = excluded.sort_order,
        deleted_at = null
    `;
    if (!isLive) usage.cards += 1;
    usage.textBytes += textDelta;
  }
  // Anything previously synced that no longer comes back (the repo changed,
  // an issue was deleted or transferred) is soft-deleted -- for this tenant only.
  await sql`update kanban_items set deleted_at = now() where user_email = ${tenant} and external_source = 'github' and deleted_at is null and not (external_id = any(${seenIds}))`;
  return seenIds.length;
}

// GET: the viewer's GitHub Issues integration state. POST {token, repo}: validate the
// token against GitHub, then save it encrypted. DELETE: disconnect.
async function githubConnection(req, res) {
  if (!allowMethods(req, res, ['GET', 'POST', 'DELETE'])) return;
  try {
    if (req.method === 'GET') {
      const sql = getSql();
      return res.status(200).json(await githubIssuesView(sql, resolveViewerTenant(req)));
    }
    const tenant = resolveWriterTenant(req);
    if (!tenant) return res.status(401).json({ error: 'Authentication required' });
    const sql = getSql();
    if (req.method === 'DELETE') {
      await disconnectIntegration(sql, tenant, GITHUB_ISSUES.id);
      return res.status(200).json(await githubIssuesView(sql, tenant));
    }
    if (!enforceRateLimit(req, res, CONNECT_RATE_LIMIT)) return;
    await assertIntegrationWriter(sql, tenant);
    const body = await readJson(req);
    const token = String(body.token || '').trim();
    const [owner, repo, ...extra] = String(body.repo || '').trim().split('/').map(part => part.trim());
    if (!token || !GITHUB_OWNER_RE.test(owner || '') || !GITHUB_REPO_RE.test(repo || '') || extra.length) {
      return res.status(400).json({ error: 'A token and repo in "owner/repo" format are required', code: 'INVALID_GITHUB_REPO' });
    }
    await validateGithubAccess(token, owner, repo);
    await saveGithubConnection(sql, tenant, { token, owner, repo });
    return res.status(200).json(await githubIssuesView(sql, tenant));
  } catch (error) { return sendError(res, error); }
}

// One full sync for a tenant, shared by the HTTP route and the MCP tool.
// Resolves to { synced, last_synced_at }. Rejects with an error carrying an
// HTTP status: 409 when GitHub is not connected, the limit error's own status
// when a card/text limit would be exceeded, 502 when GitHub (or the network)
// fails. Every failure is recorded, so the integration shows a "needs
// attention" state instead of silently going stale.
async function runGithubSync(sql, tenant) {
  await assertIntegrationWriter(sql, tenant);
  const creds = await getGithubCredentials(sql, tenant);
  if (!creds) throw new IntegrationError(409, 'INTEGRATION_NOT_CONNECTED', 'GitHub is not connected');
  let synced;
  try {
    synced = await syncGithubKanban(sql, tenant, creds);
  } catch (error) {
    await recordSyncFailure(sql, tenant, GITHUB_ISSUES.id, error.message);
    if (!(error instanceof LimitError)) error.status = 502;
    throw error;
  }
  const syncedAt = new Date().toISOString();
  await recordSyncSuccess(sql, tenant, GITHUB_ISSUES.id, syncedAt);
  return { synced, last_synced_at: syncedAt };
}

async function githubSync(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  const tenant = resolveWriterTenant(req);
  if (!tenant) return res.status(401).json({ error: 'Authentication required' });
  if (!enforceRateLimit(req, res, SYNC_RATE_LIMIT)) return;
  try {
    return res.status(200).json(await runGithubSync(getSql(), tenant));
  } catch (error) { return sendError(res, error); }
}

// POST /api/integrations/:integration/:action -- the service-agnostic steps
// of the one-time onboarding flow:
//   onboarding  {step}  remember the step the user reached, to resume there
//   acknowledge         the user has seen the "it's live" cue
// Connecting the service itself (GitHub) has its own route, because it needs
// credentials validated against that service.
const INTEGRATION_ACTIONS = new Set(['onboarding', 'acknowledge']);

async function integrationAction(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  const definition = getIntegrationDefinition(req.query.integration);
  const { action } = req.query;
  if (!definition || !INTEGRATION_ACTIONS.has(action)) return res.status(404).json({ error: 'Not found' });
  const tenant = resolveWriterTenant(req);
  if (!tenant) return res.status(401).json({ error: 'Authentication required' });
  try {
    const sql = getSql();
    await assertIntegrationWriter(sql, tenant);
    if (action === 'onboarding') {
      const { step } = await readJson(req);
      if (!definition.onboardingSteps.includes(step)) {
        return res.status(400).json({ error: `step must be one of: ${definition.onboardingSteps.join(', ')}`, code: 'INVALID_ONBOARDING_STEP' });
      }
      const current = await getIntegration(sql, tenant, definition.id);
      // Resuming only matters before the first connection; afterwards the
      // flow is never shown again, so there is nothing to remember.
      if (!current?.onboarded_at) await saveOnboardingStep(sql, tenant, definition.id, step);
    } else {
      await acknowledgeIntegration(sql, tenant, definition.id);
    }
    return res.status(200).json(await integrationView(sql, tenant, definition));
  } catch (error) { return sendError(res, error); }
}

module.exports = { listIntegrations, githubConnection, githubSync, integrationAction, cardCounts, runGithubSync, syncGithubKanban, mapGithubIssueStatus };
