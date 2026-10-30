// Per-tenant integration state. One `integrations` row per (tenant,
// integration id); the `provider` column holds the registry id
// ('github_issues').
//
// Every query here is scoped to the caller's tenant. Before this module was
// rewritten it read and wrote one hardcoded shared-tenant row, so every
// account shared one GitHub connection.
const { INTEGRATIONS, getIntegrationDefinition } = require('./integration-registry');
const { seal, open, isSealed, needsReseal } = require('./secret-box');
const { DEFAULT_TENANT } = require('./auth');
// Looked up at call time (access.isOwnerEmail), like session-guard.js.
const access = require('./access-control');

const GITHUB_ISSUES = 'github_issues';

// The shared tenant is public: every signed-out visitor reads it, and the
// sync token (Hermes, the production tests) writes to it. Anything connected there -- a private
// repository's name, its issues -- would be shown to everyone, so the shared
// tenant never has integrations. Reads treat it as having none (see
// getIntegrations); writes refuse it (assertPersonalTenant).
function isSharedTenant(tenant) {
  return tenant === DEFAULT_TENANT;
}

class IntegrationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'IntegrationError';
    this.status = status;
    this.code = code;
  }
}

// Earlier shapes of the same GitHub connection, until schema-v2.sql migrates
// them: provider 'github' (before the registry existed) and provider 'kanban'
// with config.source 'github' (the first registry version). This mapping only
// keeps reads correct between a deploy and that migration. A 'kanban' row
// with a native source was a Cardlake-only board, which is no longer an
// integration, so it maps to nothing.
function integrationIdFor(row) {
  if (row.provider === 'github') return GITHUB_ISSUES;
  if (row.provider === 'kanban') return row.config?.source === 'github' ? GITHUB_ISSUES : null;
  return row.provider;
}

function normalizeRow(row) {
  const legacy = row.provider !== integrationIdFor(row);
  return { ...row, integration: integrationIdFor(row), legacy, onboarded_at: row.onboarded_at || (legacy ? row.connected_at : null) || null };
}

function isMissingRelation(error) {
  return /relation "integrations" does not exist/.test(error?.message || '');
}

// Map of integration id -> normalized row for one tenant. A deployment that has
// not run the migration yet (no table at all) simply has no integrations, and
// neither does the public shared tenant, whatever rows it may hold -- every
// read path (feed, lists, views, credentials, write guards) goes through here.
async function getIntegrations(sql, tenant) {
  if (isSharedTenant(tenant)) return new Map();
  let rows;
  try {
    rows = await sql`select * from integrations where user_email = ${tenant}`;
  } catch (error) {
    if (isMissingRelation(error)) return new Map();
    throw error;
  }
  const byId = new Map();
  for (const row of rows.map(normalizeRow)) {
    if (!getIntegrationDefinition(row.integration)) continue;
    // A migrated row always wins over a stale legacy one.
    if (!byId.has(row.integration) || !row.legacy) byId.set(row.integration, row);
  }
  return byId;
}

async function getIntegration(sql, tenant, id) {
  return (await getIntegrations(sql, tenant)).get(id) || null;
}

// Onboarded and not disconnected. 'error' still counts: the cards from the
// last good sync stay useful while the user fixes the connection.
function isIntegrationActive(row) {
  return !!row && !!row.onboarded_at && (row.status === 'connected' || row.status === 'error');
}

// not_started -> onboarding (a step saved, nothing connected yet) -> connected
// | error; disconnected only ever follows a finished onboarding.
function lifecycleStatus(row) {
  if (!row) return 'not_started';
  if (!row.onboarded_at) return 'onboarding';
  if (row.status === 'disconnected') return 'disconnected';
  return row.status === 'error' ? 'error' : 'connected';
}

// The only shape that ever leaves the server. Built field by field so a new
// column (the token above all) can never leak by accident.
function publicIntegrationView(definition, row, { cardCount = 0 } = {}) {
  const repoOwner = row?.config?.repo_owner;
  const repoName = row?.config?.repo_name;
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    card_type: definition.cardType,
    status: lifecycleStatus(row),
    repo: repoOwner && repoName ? `${repoOwner}/${repoName}` : null,
    onboarding_step: row?.onboarding_step || null,
    onboarded_at: row?.onboarded_at || null,
    acknowledged: !!row?.acknowledged_at,
    connected_at: row?.connected_at || null,
    last_synced_at: row?.last_synced_at || null,
    last_sync_error: row?.last_sync_error || null,
    card_count: isIntegrationActive(row) ? cardCount : 0,
  };
}

// Every registered integration for a tenant, in registry order, including the
// ones not started yet (the client needs those to offer onboarding).
// cardCounts is keyed by integration id.
function publicIntegrationList(rowsById, cardCounts = {}) {
  return Object.values(INTEGRATIONS).map(definition => publicIntegrationView(
    definition, rowsById.get(definition.id) || null, { cardCount: cardCounts[definition.id] || 0 },
  ));
}

async function saveGithubConnection(sql, tenant, { token, owner, repo }) {
  const config = JSON.stringify({ repo_owner: owner, repo_name: repo });
  const rows = await sql`
    insert into integrations (user_email, provider, token, config, status, connected_at, onboarded_at, last_sync_error)
    values (${tenant}, ${GITHUB_ISSUES}, ${seal(token)}, ${config}::jsonb, 'connected', now(), now(), null)
    on conflict (user_email, provider) do update set
      token = excluded.token,
      config = excluded.config,
      status = 'connected',
      connected_at = now(),
      onboarded_at = coalesce(integrations.onboarded_at, excluded.onboarded_at),
      onboarding_step = null,
      last_sync_error = null
    returning *
  `;
  return normalizeRow(rows[0]);
}

// Remembers where the user is in the one-time flow so it resumes there.
// A row created here is not connected: onboarded_at stays null until the
// service is actually connected, so nothing reaches the feed early.
async function saveOnboardingStep(sql, tenant, id, step) {
  await sql`
    insert into integrations (user_email, provider, status, onboarding_step)
    values (${tenant}, ${id}, 'disconnected', ${step})
    on conflict (user_email, provider) do update set onboarding_step = excluded.onboarding_step
  `;
}

// The user has seen the "it's live" cue. Only meaningful once onboarded, and
// idempotent: the first acknowledgement's timestamp is kept.
async function acknowledgeIntegration(sql, tenant, id) {
  await sql`update integrations set acknowledged_at = coalesce(acknowledged_at, now()) where user_email = ${tenant} and provider = ${id} and onboarded_at is not null`;
}

// Keeps onboarded_at so reconnecting later skips the intro, and keeps the
// cards themselves (they are hidden from the feed, not deleted).
async function disconnectIntegration(sql, tenant, id) {
  await sql`update integrations set status = 'disconnected', token = null where user_email = ${tenant} and provider = ${id}`;
}

async function recordSyncSuccess(sql, tenant, id, syncedAt) {
  await sql`update integrations set status = 'connected', last_synced_at = ${syncedAt}, last_sync_error = null where user_email = ${tenant} and provider = ${id}`;
}

async function recordSyncFailure(sql, tenant, id, message) {
  await sql`update integrations set status = 'error', last_sync_error = ${message} where user_email = ${tenant} and provider = ${id}`;
}

// Decrypted GitHub credentials for the tenant, or null if GitHub Issues is not
// connected. A token that isn't sealed under the current key -- stored before
// encryption existed, or sealed with a retired key -- is resealed on use.
async function getGithubCredentials(sql, tenant) {
  const row = await getIntegration(sql, tenant, GITHUB_ISSUES);
  if (!row || row.status === 'disconnected' || !row.token) return null;
  const legacyPlaintext = !isSealed(row.token);
  const token = legacyPlaintext ? row.token : open(row.token);
  if (token && (legacyPlaintext || needsReseal(row.token))) {
    await sql`update integrations set token = ${seal(token)} where id = ${row.id}`;
  }
  if (!token) {
    const message = 'The saved GitHub token can no longer be read. Reconnect GitHub to resume syncing.';
    await sql`update integrations set status = 'error', last_sync_error = ${message} where id = ${row.id}`;
    throw new IntegrationError(409, 'INTEGRATION_RECONNECT_REQUIRED', message);
  }
  return { token, owner: row.config.repo_owner, repo: row.config.repo_name };
}

// Kanban cards come only from GitHub Issues, so none are created by hand: the
// feed shows only GitHub-sourced rows, and a hand-made card would be stored
// but never seen.
const KANBAN_CREATE_BLOCKED = 'Kanban cards come from GitHub Issues now. Create the issue on GitHub and it will sync into your feed.';

// While GitHub Issues is connected, GitHub is the source of truth for the
// cards it synced: editing or deleting one here is blocked. Returns the
// reason, or null if the write is allowed. Shared by the REST guard
// (resource-configs.js) and anything else that mutates kanban rows.
async function kanbanWriteBlockReason(sql, tenant, cardId) {
  const row = await getIntegration(sql, tenant, GITHUB_ISSUES);
  if (row?.status !== 'connected') return null;
  const cards = await sql`select external_source from kanban_items where id = ${cardId} and user_email = ${tenant} and deleted_at is null`;
  return cards[0]?.external_source === 'github'
    ? 'This card is synced from GitHub. Edit the issue on GitHub, or disconnect the integration to manage cards manually.'
    : null;
}

function assertPersonalTenant(tenant) {
  if (isSharedTenant(tenant)) {
    throw new IntegrationError(403, 'INTEGRATIONS_NEED_PERSONAL_ACCOUNT', 'Sign in to connect GitHub. The shared account is public, so anything connected to it would be visible to every visitor.');
  }
}

// Gate for every integration write (connect, sync, onboarding). OAuth access
// tokens outlive a change of owner, so a replaced owner must also be stopped
// from reconnecting GitHub -- which would otherwise undo the credential wipe
// in purgeIntegrationsFor().
async function assertIntegrationWriter(sql, tenant) {
  assertPersonalTenant(tenant);
  if (!(await access.isOwnerEmail(sql, tenant))) {
    throw new IntegrationError(403, 'ACCESS_REVOKED', 'This account no longer has access to Cardlake.');
  }
}

// Offboarding: when an account loses access, nothing it connected stays usable
// or visible. Credentials are wiped (not merely marked disconnected) and its
// synced issues are soft-deleted like any other removed card.
async function purgeIntegrationsFor(sql, tenant) {
  const credentials = await sql`update integrations set token = null, status = 'disconnected' where user_email = ${tenant} and (token is not null or status <> 'disconnected') returning id`;
  const cards = await sql`update kanban_items set deleted_at = now() where user_email = ${tenant} and external_source is not null and deleted_at is null returning id`;
  return { integration_credentials: credentials.length, synced_cards: cards.length };
}

module.exports = {
  IntegrationError,
  assertPersonalTenant,
  assertIntegrationWriter,
  purgeIntegrationsFor,
  getIntegrations,
  getIntegration,
  isIntegrationActive,
  publicIntegrationView,
  publicIntegrationList,
  saveGithubConnection,
  saveOnboardingStep,
  acknowledgeIntegration,
  disconnectIntegration,
  recordSyncSuccess,
  recordSyncFailure,
  getGithubCredentials,
  kanbanWriteBlockReason,
  KANBAN_CREATE_BLOCKED,
};
