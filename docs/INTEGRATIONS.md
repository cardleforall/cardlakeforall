# Integrations

An integration is an outside service whose items become cards in the Cardlake
feed. There is one today, **GitHub Issues**: the open issues of one repository
appear in the feed and in their own filter.

## What a user sees

1. **Integrations chip group.** The feed's filter row ends with a divider,
   an `INTEGRATIONS` label, and one chip per integration. The group is pinned
   (sticky) to the right edge, so it stays visible however far the core chips
   scroll. Before setup the chip is dashed (`+ GitHub Issues`).
2. **One-time onboarding.** Clicking the chip opens a sheet: Intro → Connect
   → Done. Each step is saved on the server, so leaving midway resumes on any
   device. A finished setup is never shown again. After a disconnect, it
   reopens at Connect.
3. **Done cues.** A success screen with what arrived ("7 open issues added to
   your feed", plus an unassigned / assigned / closed breakdown), a toast, and
   a pulsing **New** tag on the chip. The tag stays until the chip is first
   used. Its state is stored server-side (`acknowledged_at`), so it clears on
   every device.
4. **In the feed.** Issue cards read `GitHub issue · acme/app#42 · Assigned`,
   with labels and an **Open on GitHub** link. They mix into the normal feed
   and also filter on their own. Filtering to the integration shows a bar
   with the repository, sync health, **Sync now**, and **Manage** (change
   repository, disconnect).
5. **Freshness.** When the feed loads and a connected integration last synced
   more than 15 minutes ago, it syncs in the background. There is no cron,
   because Vercel's Hobby plan only allows daily ones. The feed only
   re-renders afterwards if the reader is at the top with no dialog open.

## Rules the code enforces

- **Nothing reaches the feed before onboarding.** An integration's cards appear
  only once `integrations.onboarded_at` is set for that account
  (`api/feed.js`).
- **The service owns its cards.** GitHub issues are never created by hand
  (REST answers `409 KANBAN_COMES_FROM_GITHUB`; MCP has no Kanban write tools).
  Editing a synced card is refused while connected. **Dismissing** one hides
  it (`feed_state.dismissed_at`) instead of deleting it, because a sync would
  bring a deleted row straight back. A sync keeps each row's id, so the hide
  survives.
- **Everything is per account.** Each account has its own connection, token,
  cards, and sync. Two accounts can sync the same repository.
- **The shared account never has integrations.** The `default` tenant is
  separate from the owner's: the sync token (scripts, the system tests)
  writes to it. Anything connected there (a private repository's name, then
  its issues) would be shown to everyone. So reads treat it as having no
  integrations (`getIntegrations`), and connect, sync and onboarding refuse it
  with `403 INTEGRATIONS_NEED_PERSONAL_ACCOUNT` ("sign in to connect").
- **Tokens are encrypted at rest** (AES-256-GCM) with a dedicated key,
  `INTEGRATION_ENCRYPTION_KEY`, and never returned by any endpoint. Keys are
  versioned, so rotation works without downtime: tokens move onto the current
  key the next time they are used (see `api/_lib/secret-box.js` and the
  rotation steps in `docs/ENVIRONMENT.md`). Until the dedicated key is set, a
  key derived from `SESSION_SECRET` is used.
- **Users are told what is stored.** The connect step links to
  `/privacy.html`, which lists what Cardlake keeps (the token, the repository
  name, a copy of its issues) and what disconnecting or losing access does.
- **Only fine-grained GitHub tokens** (`github_pat_…`, which can be limited to
  one repository and read-only). Classic and OAuth tokens can reach every repo
  the user can, so connect refuses them with `400 GITHUB_TOKEN_TOO_BROAD`
  before contacting GitHub. A token whose GitHub response carries OAuth scopes
  is refused too.
- **Rate limited:** connect is capped at 10 per 10 minutes per source; sync at
  30.
- **Replacing the owner cleans up.** When a reopened setup makes a different
  email the owner (`docs/ADMIN.md`, `api/_lib/offboarding.js`), the previous
  owner's API/MCP tokens are revoked, their GitHub token is wiped and their
  synced issues are hidden. Their session cookie stops working on the next
  request: every deployed function runs `withSessionGuard`
  (`api/_lib/session-guard.js`), which treats a session that isn't the
  owner's as signed out and clears the cookie. The owner check is cached for
  30 seconds per instance, and the instance that made the change forgets it
  at once. MCP OAuth tokens are re-checked the same way, and integration
  writes refuse with `403 ACCESS_REVOKED`. A test derives the deployed functions from
  `.vercelignore` and fails if one isn't guarded.

## Where the code lives

| Piece | File |
|---|---|
| Registry: the one definition of each integration | `api/_lib/integration-registry.js` |
| Per-account state, credentials, write rules | `api/_lib/integrations.js` |
| HTTP handlers and the GitHub sync (shared by production and local dev) | `api/_lib/integration-handlers.js` |
| GitHub API client | `api/_lib/github.js` |
| Onboarding sheet, Manage panel, sync, status line | `public/vault/assets/integrations.js` / `.css` |
| Chip group, sync bar, issue cards, background sync | `public/vault/assets/aurora-feed.js` |
| MCP tools (`list_integrations`, `sync_github_issues`) | `api/_lib/mcp-tools.js` |

### API

| Route | Method | What |
|---|---|---|
| `/api/integrations` | GET | Every integration and its state for the viewer (public; no credentials) |
| `/api/integrations/github` | GET / POST / DELETE | GitHub Issues state / connect `{token, repo}` / disconnect |
| `/api/integrations/github/sync` | POST | Sync now |
| `/api/integrations/:id/onboarding` | POST | Save the onboarding step `{step}` (ignored once onboarded) |
| `/api/integrations/:id/acknowledge` | POST | The user has seen the "New" cue |

`/api/feed` also returns an `integrations` list, so the feed renders its chips
without a second request.

## Adding an integration

1. Add an entry to `INTEGRATIONS` in `integration-registry.js`: `id`, `name`,
   `cardType`, `externalSource`, and `onboardingSteps`.
2. Write the connector: validate credentials, then an idempotent sync that
   upserts rows with your `external_source` and soft-deletes rows that no
   longer come back. The GitHub sync in `integration-handlers.js` is the
   template, including card and text limits.
3. Add a card counter to `CARD_COUNTERS`, and routes for connect and sync.
4. Add the copy (icon, headline, points, endpoints) to `COPY` in
   `public/vault/assets/integrations.js`.
5. Add scenarios to `tests/unit/integrations_scenarios.js`. These run against
   real Postgres (PGlite): tenant isolation, sync, feed gating.

Everything else is generic: onboarding persistence, the chip group, the "New"
cue, the sync bar, and gating.

## Schema changes

`schema-v2.sql` is idempotent. Apply it on its own after a deploy that changes
it. `POST /api/migrate` (sync token only) also applies it.
