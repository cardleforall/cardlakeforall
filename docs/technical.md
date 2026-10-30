# Cardlake: technical specification

How Cardlake is built, deployed, tested and operated, in enough detail to build
another project like it. What it does for users is in
[functional.md](functional.md); the reasoning behind each rule is in the
code comments, which this document points to.

Each Cardlake is one deployment for one person, its owner, who signs in with
a password.

---

## 1. Architecture at a glance

```text
 Browser (plain JS, no framework)          AI clients (Claude, ChatGPT, Gemini, Codex, scripts)
   public/*.html, public/vault/assets/*       │ MCP over Streamable HTTP, Bearer token or OAuth
            │ same-origin fetch, cookie        │
            ▼                                  ▼
 ┌──────────────────────── Vercel (your project, Hobby is enough) ──────────────────────┐
 │ static: public/          serverless functions: api/*.js (Node 22, 12 functions)       │
 │                                                                                       │
 │  every function = withSessionGuard( withEventLog( handler ) )                         │
 │     │ apply schema, load secrets, drop non-owner sessions │ record writes             │
 │     ▼                                                                                 │
 │  tenant resolution (api/_lib/auth.js, api-tokens.js, oauth.js)                        │
 │     ▼                                                                                 │
 │  domain modules api/_lib/*  (resources, feed, limits, integrations, onboarding, …)    │
 └───────────────┬──────────────────────────┬──────────────────────────┬────────────────┘
                 │ SQL over HTTPS            │ private blobs            │ HTTPS
                 ▼                           ▼                          ▼
        Neon Postgres                 Vercel Blob (private)     GitHub API, YouTube/RSS feeds
```

Key properties:

- **One database, many tenants.** Every row carries `user_email`; every query
  filters by it. There is no ORM.
- **Stateless functions.** Nothing lives in memory between requests except
  small caches (owner checks for 30 s, rate-limit buckets, generated secrets).
- **Additive schema, applied by itself.** The first request after a deploy
  applies `schema-v2.sql` when its hash changed; code must still work if that
  fails or hasn't happened yet.
- **No build step.** The front end is hand-written HTML/CSS/JS served as is.
- **Same rules for every client.** Web, REST, MCP and tests all go through the
  same server-side functions (validation, limits, tenancy, events).

---

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Hosting | Vercel (Hobby or Pro), GitHub-connected | push to `main` = production; PR = preview deployment |
| Runtime | Node.js 22, CommonJS | `vercel.json`: `api/**/*.js` `maxDuration: 10` |
| Database | Neon Postgres via `@neondatabase/serverless` (SQL over HTTPS) | tagged-template queries: ``sql`select … ${value}` `` |
| Files | Vercel Blob, **private** access, `@vercel/blob` 2.x | streamed back through the API, never public URLs |
| Auth | The owner's password, `bcryptjs` | HMAC-signed session cookie, no auth vendor |
| AI | `@modelcontextprotocol/sdk` 1.x (Streamable HTTP), `zod` 4 for schemas | own OAuth 2.1 server for connectors |
| Uploads | `busboy` multipart parsing | |
| Front end | Plain JS IIFEs, CSS with `oklch()` tokens, self-hosted fonts | no framework, no bundler |
| Tests | Python 3.11 `unittest` driving Node subprocesses; `@electric-sql/pglite` (Postgres in WASM) | `pg` for optional local Postgres |
| CI | GitHub Actions (`.github/workflows/ci.yml`) | Node 22 + Python 3.11: `npm ci`, build, validate, `test:lite` |
| Fonts | Space Grotesk (display), Manrope (body), WOFF2 in `public/fonts` | a test forbids Google Fonts |
| License | GNU AGPL-3.0 (`AGPL-3.0-only`) | open source and self-hostable; a test checks consistency |

---

## 3. Repository layout

```text
api/
  vault.js            consolidated router: cards, dashboard, events, onboarding,
                      surprise, integrations, retention cron
  feed.js             feed list/search, feed actions, uploads/downloads
  learnings.js        learnings list/create  (+ learnings/[id].js PATCH/DELETE, learnings/reorder.js)
  auth.js             consolidated auth: session, config, setup, sign-in, sign-out-everywhere,
                      instance, logout, tokens
  mcp.js              MCP endpoint (+ protected-resource metadata)
  oauth.js            OAuth authorize + token endpoints
  migrate.js          POST: apply schema-v2.sql (sync token only)
  sync/markdown.js    learnings exported as Markdown
  _lib/               all domain logic (never deployed as functions)
  auth/, kanban/, work/, … per-route files used only by local dev (excluded by .vercelignore)
public/               setup, sign-in, welcome, privacy, support, MCP guide, vault shell + assets, fonts, icons
schema-v2.sql         the whole schema, idempotent and additive
scripts/              dev_server.js, build/validate vault shell, migrate helper, icon generator
tests/unit/           offline tests (*.py) + PGlite scenario runners (*_scenarios.js)
tests/sit/            system tests against a deployed URL
docs/                 operating docs (ENVIRONMENT, MCP_SERVER, INTEGRATIONS, LIMITS, USER_EVENTS, ADMIN, …)
```

---

## 4. Hosting and routing

### 4.1 The 12-function budget

Vercel Hobby allows 12 serverless functions per deployment, so routes are
consolidated: many URLs, few functions. A new route is an action of an
existing function plus a rewrite.

Deployed functions (everything not in `.vercelignore`): `auth.js`, `feed.js`,
`learnings.js`, `learnings/[id].js`, `learnings/reorder.js`, `mcp.js`,
`migrate.js`, `oauth.js`, `sync/markdown.js`, `vault.js`.

`vercel.json` **rewrites** map public URLs onto them, e.g.

```json
{ "source": "/api/reminders", "destination": "/api/vault?resource=reminders" },
{ "source": "/api/:resource(bookmarks|family|kanban|reminders|talking-points|work)/:id",
  "destination": "/api/vault?resource=:resource&id=:id" },
{ "source": "/api/auth/sign-in", "destination": "/api/auth?action=sign-in" },
{ "source": "/.well-known/oauth-protected-resource", "destination": "/api/mcp?metadata=1" },
{ "source": "/.well-known/oauth-authorization-server", "destination": "/api/auth?action=oauth-metadata" },
{ "source": "/oauth/authorize", "destination": "/api/oauth?action=authorize" },
{ "source": "/api/cron/purge-retention", "destination": "/api/vault?resource=retention" }
```

Also in `vercel.json`: `/` → `/vault/index.html`, `/setup` and `/signin`, a daily cron (`0 3 * * *` → `/api/cron/purge-retention`)
and security headers on every path (`X-Content-Type-Options: nosniff`,
`X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy` denying camera/mic/geolocation, HSTS 2 years).

**Hard rule (learned from an outage):** a consolidated function must not
`require()` a file in an excluded directory. `api/auth.js` once required
`./auth/login` etc.; `.vercelignore` dropped `api/auth/**` from the bundle, and
every auth route 500'd in production while local dev worked. A unit test now
hides `api/auth/` and runs the handler.

### 4.2 Local dev server

`npm run dev` → `node --env-file=.env.local scripts/dev_server.js` (port 3000):
serves `public/`, maps `/` to the vault and `/setup`, `/signin` to their pages, and routes `/api/*` by
**filesystem** (`index.js`, `[id].js`, nested `[param]/child.js`), not by
`vercel.json` rewrites. That is why the per-route files under `api/auth/`,
`api/kanban/`, … exist: thin local-only entry points that call the same
`_lib` code. It clears `require` cache per request (hot reload) and wraps
every route in `withSessionGuard`.

**Local dev uses whatever database `.env.local` names**; see 6.3.

---

## 5. Data model (`schema-v2.sql`)

### 5.1 Conventions

| Convention | Detail |
|---|---|
| Tenant column | `user_email text not null default 'default'` on every user-owned table. `'default'` is the shared public demo tenant. No foreign keys to `users`. |
| Ids | `uuid default gen_random_uuid()` (pgcrypto); events use `bigint identity`. |
| Soft delete | `deleted_at timestamptz`; every read filters `deleted_at is null`. Hard delete only by the retention job after 90 days. |
| Ordering | `sort_order integer`, new rows get `max(sort_order)+1` within their group. |
| Timestamps | `created_at`, `updated_at`; trigger `set_row_updated_at()` on every table. (Onboarding uses `updated_at > created_at` to tell edited sample cards.) |
| Uniqueness | Partial unique indexes on live rows only: `(user_email, title) where deleted_at is null`. |
| Hot paths | Partial indexes `… where deleted_at is null`, `… where dismissed_at is null`. |

### 5.2 Tables

**Card tables** (one per type):

| Table | Key columns |
|---|---|
| `learning_entries` | title, url, notes, status (`saved/watched/skimmed`), category (`ai/others`) |
| `reminders` | title, due_date, completed, recurrence (`daily/weekly/monthly/yearly`/null). `remind_at` is retired: unused, kept only because the schema is additive |
| `work_items` | title, items `jsonb` array of `{text, completed}` |
| `family_updates` | person, content |
| `bookmarks` | title, url, notes, category (`tech/business/personal/other`) |
| `talking_points` (Misc) | section_title, content, subsection_of → `talking_points(id)` |
| `kanban_items` (GitHub issues) | title, description, status (`backlog/in_progress/done`), external_source, external_id (`owner/repo#N`), external_url, labels `jsonb`; unique `(user_email, external_source, external_id) where external_id is not null` |
| `files` | standalone uploads: name, mime_type, byte_size, blob_url |
| `attachments` | parent_type, parent_id, name, mime_type, byte_size, blob_url |

**Feed state and activity:**

| Table | Purpose |
|---|---|
| `feed_state` | Per tenant per card `(user_email, item_type, item_id)` unique: `pinned_at`, `liked_at`, `remind_later_until` (snooze), `dismissed_at` (hidden GitHub issues), `reviewed_at`, `seen_at`, `sort_order`. Spans all card tables, so no FK. |
| `vault_daily_activity` | PK `(user_email, activity_date)`; one row per day the vault was opened → streak. |
| `user_events` | Append-only activity log (section 13). |

**Accounts and access:**

| Table | Purpose |
|---|---|
| `users` | email PK, name, picture_url, last_login_at; the owner's `password_hash` (bcrypt), `password_changed_at`, `sessions_revoked_at`; onboarding: `onboarded_at`, `persona`, `sample_cards jsonb [{type,id}]`; Deal me 5: `interests jsonb`, `last_deal_at` |
| `app_config` | key/value jsonb: `instance_owner` (the owner's email), `instance_created_at` (opens setup's hour), `schema_hash` |
| `instance_secrets` | secrets the deployment generated for itself (`instance-secrets.js`) |
| `api_tokens` | personal access tokens: `token_hash` (sha256) unique, label, last_used_at, revoked_at |
| `oauth_authorization_codes` | code_hash PK, client_id, redirect_uri, resource, scope, code_challenge, expires_at, used_at |
| `oauth_refresh_tokens` | token_hash PK, client_id, resource, scope, expires_at, used_at |

**Everything else:** `integrations` (per tenant per provider: sealed token,
config jsonb, status, onboarding_step, onboarded_at, acknowledged_at,
last_synced_at, last_sync_error), `surprise_sources` / `surprise_pool`
(shared public catalog, no tenant) / `surprise_deals` (per tenant, unique
`(user_email, item_key)`).

Only the tables Cardlake uses are created.

### 5.3 Migrations

- `schema-v2.sql` is the **only** schema file and is **re-runnable**:
  `create … if not exists`, `alter table … add column if not exists`,
  `drop trigger if exists` + `create trigger`. Never drop or rename anything
  user-visible. Data fix-ups are written as idempotent `update`/`delete`
  statements guarded by `where` clauses (e.g. moving legacy integration rows).
- **Applied by itself** (`_lib/schema.js`): the request guard compares a hash
  of `schema-v2.sql` with `app_config.schema_hash` once per warm instance and
  applies the file when they differ, splitting it with a small parser
  (`splitStatements`, aware of `--`, `/* */` and `$$` blocks); one in-flight
  application per instance, one retry across instances. `POST /api/migrate`
  with `X-Sync-Token` does the same by hand (sessions are refused). Neither
  writes data.
- **Code must tolerate the gap** before the schema is applied. Patterns used:
  - catch `column "x" does not exist` / `relation "x" does not exist` and fall
    back to an older query (`feed.js selectState`, reminders without
    `recurrence`);
  - feature switches itself off (`onboarding`, `surprise` return
    `available: false`);
  - self-healing DDL for tiny tables (`events.js` creates `user_events` if the
    insert finds it missing; `feed.js ensureAuroraReviewSchema`).
- Tests: `tests/unit/test_schema.py` checks the schema statically and the
  PGlite harness applies the real file before every scenario.

---

## 6. Environments and configuration

### 6.1 Environments

| | Production | Preview (every PR) | Local dev |
|---|---|---|---|
| URL | your project's production domain, or `CARDLE_PUBLIC_ORIGIN` | Vercel's preview URL | localhost:3000 |
| Database | the Neon store the Deploy button added | as configured in Vercel for Preview (give previews their own database) | `.env.local`'s `DATABASE_URL`: a database of its own |
| File store | the private Blob store | as configured for Preview (never production's) | as configured |
| Secrets | generated (`instance_secrets`) or set in Vercel | the same | `.env.local` or generated |

The MCP server and OAuth answer as one address (`publicOrigin()` in
`api/_lib/public-origin.js`): `CARDLE_PUBLIC_ORIGIN`, else Vercel's production
domain, else localhost. A spoofed `Host` header never becomes the issuer.

Isolating local dev: point `DATABASE_URL` at a Neon branch, or run a local
Postgres with `LOCAL_DEV_PG=1` (`db.js` swaps to a `pg` pool with the same
tagged-template shape).

### 6.2 Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` (or `POSTGRES_URL`) | Neon connection string (set by the Neon store) |
| `SESSION_SECRET` | HMAC key for session cookies; fallback root for other keys; generated if unset |
| `OAUTH_SIGNING_SECRET` | optional separate key for OAuth access tokens |
| `INTEGRATION_ENCRYPTION_KEY` | 32 random bytes base64; seals third-party tokens; generated if neither it nor `SESSION_SECRET` is set |
| `INTEGRATION_ENCRYPTION_KEYS_PREVIOUS` | retired keys still accepted for opening (rotation) |
| `SYNC_TOKEN` | machine credential → writes as the `default` tenant; used by tests and migrations; generated if unset |
| `MCP_TOKEN` | legacy single MCP bearer → `default` tenant |
| `CARDLE_SETUP_OPEN` | `1` reopens first-run setup |
| `CRON_SECRET` | Vercel Cron sends `Authorization: Bearer …` to the retention job; without it the app runs the purge itself once a day |
| `BLOB_READ_WRITE_TOKEN` / `BLOB_STORE_ID` | Vercel Blob (OIDC works with just the store id) |
| `CARDLE_PUBLIC_ORIGIN` | this deployment's address, for a custom domain |
| `CARDLE_MAX_*`, `CARDLE_BLOB_STORAGE_*` | limits (section 10) |
| `NODE_ENV=production` | adds `Secure` to cookies |

`.env.example` lists every name with no values (a test enforces it). Secrets
live only in Vercel, the `instance_secrets` table and a gitignored
`.env.local`.

### 6.3 The one sharp edge

`DATABASE_URL` is used exactly as configured: `npm run dev` reads and writes
whatever database `.env.local` names. Use a database of its own for local
development, never one with real data. This is documented in
`docs/ENVIRONMENT.md`, and a hygiene test checks the docs say so.

---

## 7. The request pipeline

```js
module.exports = withSessionGuard(async function handler(req, res) { … });
```

Every deployed function is wrapped (a test derives the deployed list from
`.vercelignore` and fails if one isn't).

1. **`withSessionGuard`** (`_lib/session-guard.js`): applies the schema if
   it changed, loads generated secrets, then, if the request carries a
   session cookie that isn't the current owner's or was issued before their
   last "sign out on all devices", strips the cookie from the request
   (downstream sees a signed-out visitor) and clears it in the response. A
   valid session older than a day is reissued for another 30 days. The owner
   check is cached per warm instance for 30 s; the instance that replaces the
   owner forgets it immediately. Database errors **fail open** here (the
   handler will fail on its own; failing closed would sign the owner out on a
   blip).
2. **`withEventLog`** (`_lib/events.js`): wraps `res.json`/`res.end`. If the
   request is a write (or the handler named an event), it inserts the event
   **before** sending the response, because a serverless function can be
   frozen once it has answered. Recording failures are logged, never surfaced.
3. **Handler**: resolves the tenant, validates, checks limits, runs SQL,
   names its event via `req.cardleEvent = { type, item_type, item_id, context }`.

### 7.1 Who is calling (tenant resolution)

| Credential | Resolves to | Where |
|---|---|---|
| `lh_session` cookie | the owner's email | `auth.js getSessionPayload` |
| `X-Sync-Token` = `SYNC_TOKEN` | `'default'` (writer only) | `isSyncTokenValid` |
| `Authorization: Bearer <api token>` | the token's owner (MCP only) | `api-tokens.js resolveApiTokenTenant` |
| `Authorization: Bearer <MCP_TOKEN>` | `'default'` (MCP only) | `resolveMcpTenant` |
| `Authorization: Bearer <OAuth access token>` | `sub` email, with scopes | `oauth.js resolveOAuthAuthorization` |
| nothing | readers get `'default'`; writers get 401 | |

Two resolvers make the rule explicit:

- `resolveViewerTenant(req)`: session email, else `'default'`. **Reads are
  public**: a signed-out visitor reads the demo tenant.
- `resolveWriterTenant(req)`: session email, else `'default'` if the sync
  token is valid, else `null` → 401.

### 7.2 Session cookie

```text
lh_session = base64url(JSON{authenticated, iat, ttl, exp, email, name, picture}) + "." + HMAC-SHA256(SESSION_SECRET)
Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000 (30 d); Secure in production; no Domain attribute
```

- Verified with `timingSafeEqual`; rejected if expired, tampered, or **without
  an email** (it would act for the shared `default` tenant).
- **No `Domain` attribute** (host-only). A hard-coded `Domain=.vercel.app`
  once made every sign-in on a custom domain silently fail.
- Rotating `SESSION_SECRET` signs everyone out (an incident lever).

### 7.3 Setup and password sign-in (`_lib/local-accounts.js`, `account-routes.js`)

1. `GET /api/auth/config` → `{setupNeeded}`: the pages send visitors to
   `/setup` while there is no owner, otherwise to `/signin`.
2. `POST /api/auth/setup {name, email, password}`: refused unless setup is
   open (within an hour of `instance_created_at`, or `CARDLE_SETUP_OPEN=1`).
   The owner record is claimed with `insert … on conflict do nothing
   returning`, so exactly one racer wins; the password (10 to 72 bytes) is
   stored as a bcrypt hash. Reopened with a different email, the previous
   owner goes through `removeUserAccess`.
3. `POST /api/auth/sign-in {email, password}`: compares against the owner's
   hash, or a dummy hash for any other email, so every refusal takes the
   same time and says the same thing.
4. Both are login-CSRF guarded (`allowSameOrigin`) and rate-limited to 10
   per 15 minutes per address; both set the session cookie.
5. `POST /api/auth/sign-out-everywhere` stamps `users.sessions_revoked_at`
   from the app's clock; the guard drops sessions issued before it.

### 7.4 Personal access tokens

`POST /api/auth/tokens {label}` (session or sync token) → 32 random bytes hex,
stored as sha256 only, plaintext returned once. `GET` lists (no secrets),
`DELETE /api/auth/tokens/:id` revokes (soft). `last_used_at` is updated
best-effort on use. Offboarding revokes them all.

---

## 8. API reference

All JSON. Errors: `{ error, code, details? }` (section 10.3).

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /api/feed?view=&types=&liked=&query=&status=&category=&cursor=&limit=&tz=` | viewer | Feed page + stats + integrations |
| `POST /api/feed {action, item_type, item_id}` | writer | `like/unlike/pin/unpin/remind_later/unremind_later/dismiss` |
| `POST /api/feed` multipart `file[, parent_type, parent_id]` | writer | Upload a standalone file or an attachment |
| `GET /api/feed?file_id=` / `?attachment_id=` | writer (own) | Stream a private blob |
| `GET/POST /api/{reminders,work,family,bookmarks,talking-points,kanban}` | viewer / writer | List / create (kanban create always 409) |
| `PATCH/DELETE /api/{type}/:id` | writer | Partial update / soft delete |
| `GET/POST /api/learnings`, `PATCH/DELETE /api/learnings/:id`, `POST /api/learnings/reorder` | viewer / writer | Learnings |
| `GET /api/dashboard/stats` | viewer | Counts per type |
| `POST /api/events {events:[…]}` | session (else 204) | Browser-side events, ≤ 50 |
| `GET/POST /api/onboarding`, `DELETE /api/onboarding/samples` | session | Onboarding status, pick persona, clear samples |
| `GET/POST /api/surprise {topics?}` | session | Deal me 5 status / deal |
| `GET /api/integrations` | viewer | Integration list (no secrets) |
| `GET/POST/DELETE /api/integrations/github {token, repo}` | writer | State / connect / disconnect |
| `POST /api/integrations/github/sync` | writer | Sync now |
| `POST /api/integrations/:id/onboarding {step}` / `…/acknowledge` | writer | Save setup step / clear "New" |
| `GET /api/auth/session`, `GET /api/auth/config`, `POST /api/auth/logout` | - | Session |
| `GET/POST /api/auth/setup`, `POST /api/auth/sign-in` | - (10/15 min/IP) | First-run setup, password sign-in |
| `POST /api/auth/sign-out-everywhere` | session | End every session |
| `GET /api/auth/instance` | session | The generated sync token, for Connect AI |
| `GET/POST /api/auth/tokens`, `DELETE /api/auth/tokens/:id` | writer | Personal access tokens |
| `POST /api/mcp` | Bearer (token or OAuth) | MCP JSON-RPC |
| `GET /.well-known/oauth-protected-resource`, `…/oauth-authorization-server` | - | OAuth discovery |
| `GET/POST /oauth/authorize`, `POST /oauth/token` | - | OAuth 2.1 + PKCE |
| `POST /api/migrate` | sync token | Apply schema |
| `GET /api/sync/markdown` | authenticated | Learnings as Markdown |
| `GET /api/cron/purge-retention` | `CRON_SECRET` | Retention purge (else run by the app itself once a day) |

---

## 9. Domain logic

### 9.1 Config-driven card resources (`_lib/resource-configs.js`, `_lib/resources.js`)

Each type is a config object:

```js
{ singular: 'reminder', plural: 'reminders', feedType: 'reminder',
  fields: [{ name, kind: 'string'|'nullableString'|'boolean'|'date'|'json',
             required, values (enum), default, nullAliases }],
  list(sql, tenant), create(sql, tenant, v), update(sql, tenant, id, v), remove(sql, tenant, id),
  guardCreate?, guardMutate? }
```

- `collection(config)` handles GET (viewer) / POST (writer); `item(config)`
  handles PATCH / DELETE.
- `validate(body, config, creating)`: on create every field (defaults
  applied before enum checks); on update **only fields present** in the body.
- **Partial updates** in SQL without dynamic SQL:
  `title = case when ${has(v,'title')} then ${v.title} else title end`.
- Every query includes `and user_email = ${tenant} and deleted_at is null`.
- **Input hygiene** (in `resources.js`, shared by REST and MCP): dates accept
  only a calendar day (`YYYY-MM-DD`) or a timestamp **with a UTC offset**
  (`2026-10-03T09:00+05:30`); impossible dates (Feb 30) and bare times are
  refused, and `null` clears a date. URLs on bookmarks and learnings must be
  web links (or bare addresses, upgraded to https); `javascript:` and `data:`
  are refused even when disguised with control characters. Titles that are
  only whitespace are refused. Checklist entries are normalized to
  `{text, completed}` and blanks dropped. A Misc card can only nest under the
  same account's Misc cards, never under itself or a descendant.
- Errors map to statuses in `statusFor`: validation → 400 `VALIDATION_ERROR`,
  unique violation `23505` → 409 `DUPLICATE_ITEM`, limit errors keep theirs.
- Deleting purges the card's attachments (blob + rows).
- The same configs back the REST API, MCP tools, onboarding seeding and Deal me 5.

### 9.2 Recurring reminders (`_lib/recurrence.js`, `updateReminder`)

- `nextOccurrence({due_date, recurrence}, now)`: steps forward from
  the **original** date until after `now` (skips missed ones; month math
  clamps to the last day; always counts from the original date so clamping
  doesn't drift). No due date → one interval from now.
- On `completed: true` for a recurring reminder: write `completed=false`, the
  new dates, and upsert `feed_state.remind_later_until = next` (clearing pin
  and dismissal).
- **Idempotent completion**: if the card is already snoozed until exactly its
  current next occurrence, a repeat completion is a no-op (MCP marks
  `update_reminder` idempotent, so clients may retry).

### 9.3 The feed engine (`api/feed.js`)

1. **`loadSources`**: 11 parallel queries (each card table, files,
   attachments, feed_state, integrations), all tenant-scoped.
2. **`loadVisibleCards`**: merges feed state by `type:id`, attaches
   attachments, **hides integration-owned rows** unless that integration is
   active and the row's `external_source` matches, then `normalize(type,row)` into
   one card shape:
   `{id, type, title, subtitle, body, metadata, actions, created_at, pinned_at, liked_at, remind_later_until, dismissed_at, sort_order, integration?}`.
   Search (`searchCards`), `getCard` and the feed all use this one loader, so
   they always agree on what exists.
3. **Visibility**: `visibleInFeed` = not dismissed, not snoozed into the
   future, not archived. `archived` = completed reminder, done issue,
   watched/skimmed learning, fully checked work list.
4. **Filters** in memory: types, category, status, liked, query (substring of
   a lower-cased search text: title, subtitle, body, url, external url/id, labels).
5. **Order**: pinned (by `sort_order`, then newest pin) + `sortCards(rest, sort)`
   from `api/_lib/feed-ranking.js`; `sort` is `ai` (default) or `newest`, and
   the response echoes it:
   - `ai`: score = weighted sum of 0-1 signals (`urgency` of a reminder's due
     date, `momentum`, `liked`, `freshness`, `rediscovery`, a per-day
     `daily` hash so pages stay stable within a day). Each slot then takes the
     best card of whichever type scores highest after a penalty for extending
     a run of the same type (0.5 after one; never a third while another type
     is left). Personalising it
     means passing per-account `weights`, not changing the ranker.
   - `newest`: `created_at` descending.
   - Snoozed view: by `remind_later_until` ascending, whatever the sort.
6. **Pagination**: opaque cursor = base64url `{offset}`; limit 1–50, default 20.
7. **Stats**: counts per type, liked, pinned, `max_pinned` (3), snoozed,
   quota summary, `review {date, reviewed_today, total_today}`, `streak_days`.
8. **Streak**: the client sends its IANA zone (`tz`), validated with
   `Intl.DateTimeFormat`; `localDate(now, tz)` decides "today"; opening the
   vault (signed-in, first page) inserts `(tenant, today)` into
   `vault_daily_activity` (`on conflict do nothing`); `computeStreak` counts
   consecutive days ending today, or yesterday if today has no visit yet.
   Calendar arithmetic is done on `YYYY-MM-DD` strings in UTC.
9. **Side effects of listing** (signed-in members only, never the demo
   tenant or MCP): record today's visit (every page, idempotent); sweep
   expired trial cards (Deal me 5 / samples) on the first page; record
   `feed.served` with the ordered `[type,id]` list (exposure data for
   recommendations).

**Feed actions** (`applyFeedAction`) are single upserts on `feed_state`:

```sql
-- snooze: 1 day, counts as reviewed, clears pin
insert into feed_state (user_email,item_type,item_id,remind_later_until,reviewed_at)
values ($t,$type,$id, now()+interval '1 day', now())
on conflict (user_email,item_type,item_id) do update
  set remind_later_until = now()+interval '1 day', dismissed_at=null, reviewed_at=now(), pinned_at=null;
```

- **Snooze** takes `days` (1–365, default 1).
- **Pin** counts only pins on cards in the active feed (not snoozed, not
  finished) against `MAX_PINNED=3`; pinning clears snooze.
- **Finished cards** (completed reminder, watched learning, closed issue, full
  checklist) can't be pinned or snoozed: "This card is finished… Reopen it first."
- **Dismiss**: for an externally owned card (GitHub) set `dismissed_at`
  (hide; survives syncs because sync keeps ids); otherwise soft-delete the row,
  delete its `feed_state`, purge blobs.
- **Ownership check first**: `parentExists(tenant, type, id)` or 404, so no
  orphan feed state can be created for someone else's card (it would also eat
  the pin quota).

### 9.4 Files and attachments

- Upload: `busboy` parses multipart; checks MIME allowlist, filename length,
  then `assertUploadAllowed` (size, per-user storage, uploads/24h, per-card
  attachments, global hard limit); `put(filename, buffer, {access: 'private'})`;
  insert row; on DB failure delete the blob again.
- Download: tenant-scoped lookup, `get(blob_url, {access:'private'})`, stream
  with `Content-Disposition: inline; filename="…"`.
- Deleting a card or file deletes its blobs (`attachments.js purgeAttachments`,
  scoped by tenant).

### 9.5 Limits (`_lib/limits.js`)

Frozen config from env with safe defaults (see functional.md §15).
`assertCardCreateAllowed` checks field lengths, then one SQL `union all` over
every card table for count and `octet_length` sum (text bytes), then the
projected total. `assertCardUpdateAllowed` charges only the positive delta.
Synced GitHub issues are charged as they are upserted. The feed returns a
`quota` summary with an 80% `warning` flag.

### 9.6 Onboarding (`_lib/onboarding.js`, `onboarding-personas.js`)

- `GET` → `{available, needsOnboarding (no onboarded_at and 0 cards), persona,
  sampleCount, aiConnected (any refresh token or live api token), personas}`.
- `POST {persona, timeZone}`: **claim first**:
  `update users set onboarded_at=now() … where onboarded_at is null returning`;
  only the request that flips it seeds cards (double-click safe). Inserts
  as many persona cards as fit the card limit through the normal configs,
  records `sample_cards [{type,id}]`.
- Reminder times become the next wall-clock occurrence in the member's zone,
  DST-aware (`zoneOffsetMinutes` re-read at the target moment).
- "Kept" = edited (`updated_at > created_at`), liked, pinned, or has an
  attachment. `clearSampleCards` removes only un-kept samples.

### 9.7 Deal me 5 (`_lib/surprise.js`, `surprise-sources.js`)

- **Pool refresh without a scheduler**: any status/deal request runs
  `refreshPool`: upsert source ids, **claim** stale sources with one
  `update … set checked_at=now() where checked_at < now()-12h returning id`
  (so concurrent requests never fetch the same feed), fetch each with a 4 s
  timeout, parse Atom/RSS with small regex helpers (YouTube `yt:videoId`,
  skip `/shorts/`, https only, entity decoding), keep items < 90 days, bulk
  insert with `unnest(...) on conflict do nothing`; drop items > 180 days.
  One broken feed never blocks the others.
- **Deal**: ≤ 3 distinct `deal_id`s per 24 h (429 `DEAL_LIMIT`); claim
  `last_deal_at` (15 s debounce → 409 `DEAL_IN_PROGRESS`); `pickLearnings`
  round-robins across chosen topics, one per source, then relaxes, then other
  topics, then evergreen; one challenge reminder; settle expired trials first;
  insert through the shared card writers; record each in `surprise_deals`
  (`unique (user_email, item_key)` = never twice).
- **Trials**: `settleDueDeals` marks each open deal `kept/expired/deleted`
  after 14 days using the same "kept" rule as onboarding.

### 9.8 Integrations (`_lib/integration-registry.js`, `integrations.js`, `integration-handlers.js`, `github.js`)

- **Registry** is the single definition: `{id, name, cardType, externalSource,
  onboardingSteps}`. The feed, API, MCP and UI all read it.
- **Lifecycle**: `not_started → onboarding (step saved) → connected | error →
  disconnected` (only after a finished onboarding). Cards appear only when
  `onboarded_at` is set and status is connected or error.
- **Public view** is built field by field (`publicIntegrationView`) so a new
  column, above all the token, can never leak.
- **Shared tenant never has integrations**: reads return none; writes 403
  `INTEGRATIONS_NEED_PERSONAL_ACCOUNT`.
- **Writers re-check the owner** (`assertIntegrationWriter`) so a replaced
  owner can't reconnect and undo the credential wipe.
- **Token storage** (`secret-box.js`): AES-256-GCM, format
  `v2:<keyId>:<iv>:<tag>:<ciphertext>` (keyId = first 16 hex of sha256(key));
  `v1` = key derived from `SESSION_SECRET` via HKDF. `open()` returns null on
  any failure → the integration asks the user to reconnect. Values under a
  retired key are **resealed on next use** (zero-downtime rotation).
- **GitHub**: only fine-grained tokens (`github_pat_` prefix checked before
  any network call; a response with `x-oauth-scopes` is refused too); validate
  repo and issues access; fetch up to 3 pages × 100 issues sorted by updated,
  skipping pull requests.
- **Sync** (`syncGithubKanban`): per issue, enforce text/card limits, then

  ```sql
  insert into kanban_items (…, external_source, external_id, …) values (…, 'github', 'owner/repo#42', …)
  on conflict (user_email, external_source, external_id) where external_id is not null
  do update set title=excluded.title, …, deleted_at=null
  ```

  (the `where` must repeat the partial index predicate or Postgres can't match
  it); then soft-delete this tenant's issues not seen. Status mapping: closed →
  done, assigned → in_progress, else backlog. Failures are recorded on the row
  (`status='error'`, `last_sync_error`) and surface as 502.
- Rate limits: connect 10 / 10 min, sync 30 / 10 min per IP.

### 9.9 The owner (`_lib/access-control.js`, `local-accounts.js`, `offboarding.js`)

- The owner is `app_config.instance_owner`; `isOwnerEmail()` is the only
  access check. There are no administrators, allowlists or other accounts.
- **Replacing the owner** (`removeUserAccess`, run by a reopened setup with a
  different email): forget the cached owner answer → revoke all API tokens
  → wipe integration tokens and soft-delete synced issues → retire OAuth
  refresh tokens. Each step idempotent. Their cards stay, out of reach.

### 9.10 Retention (`_lib/retention.js`)

Daily Vercel Cron, authorized by comparing `Authorization: Bearer
${CRON_SECRET}` with `timingSafeEqual`. Without `CRON_SECRET` the request
guard runs the same purge itself, at most once a day, after a request it has
already answered. Hard-deletes card rows soft-deleted > 90 days (and their
feed state and stored files), attachments rows, events > 24 months.
Idempotent.

### 9.11 Rate limiting (`_lib/rate-limit.js`)

Fixed window per warm instance, keyed by bucket + first `X-Forwarded-For` IP,
with a sweep when the map passes 5,000 entries. Not distributed; it caps a
single noisy source cheaply. Used for setup and password sign-in (10 per
15 min), integration connect/sync. Returns 429 with `Retry-After`.

---

## 10. Errors and limits contract

### 10.1 `sendError(res, error, status)`

- Expected errors (4xx, `LimitError`) return their message and code.
- Anything else returns **"Something went wrong. Please try again."** with
  `INTERNAL_ERROR`, so database or provider internals never leak.

### 10.2 `readJson`

Accepts a pre-parsed `req.body` (Vercel) or streams the body; rejects over
`maxJsonBodyBytes` (413 `JSON_BODY_TOO_LARGE`) and invalid JSON (400 `INVALID_JSON`).

### 10.3 Stable codes (selection)

`VALIDATION_ERROR`, `DUPLICATE_ITEM`, `CARD_LIMIT_REACHED`,
`TEXT_STORAGE_LIMIT_REACHED`, `TITLE_TOO_LONG`, `CONTENT_TOO_LONG`,
`FILE_TOO_LARGE`, `FILE_STORAGE_LIMIT_REACHED`, `UPLOAD_RATE_LIMIT_REACHED`,
`ATTACHMENT_LIMIT_REACHED`, `GLOBAL_FILE_STORAGE_LIMIT_REACHED`,
`RATE_LIMITED`, `ACCESS_REVOKED`, `WRONG_PASSWORD`, `SETUP_CLOSED`, `SETUP_TAKEN`,
`KANBAN_COMES_FROM_GITHUB`, `KANBAN_SYNCED_FROM_GITHUB`,
`INTEGRATIONS_NEED_PERSONAL_ACCOUNT`, `GITHUB_TOKEN_TOO_BROAD`,
`INTEGRATION_RECONNECT_REQUIRED`, `RECURRENCE_UNAVAILABLE`, `DEAL_LIMIT`,
`DEAL_IN_PROGRESS`, `CROSS_ORIGIN_REQUEST`.

Status conventions: caps 409, oversize 413, rate 429, service capacity 503.

---

## 11. MCP server

### 11.1 Endpoint (`api/mcp.js`)

- CORS `*` for `GET, POST, OPTIONS`; `OPTIONS` → 204; `GET ?metadata=1` →
  protected-resource metadata; anything but POST → 405.
- **Every call needs a Bearer**, reads included (unlike the public REST
  reads), because third-party platforms reach this endpoint. OAuth token is
  tried first, then API token / `MCP_TOKEN`. The tenant must still be
  allowed (`isAccountActive`): an OAuth token lives an hour, an account can
  be removed sooner. 401 sends
  `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource", scope="cardle.read cardle.write"`.
- **Stateless Streamable HTTP**: a new `McpServer` + `StreamableHTTPServerTransport({sessionIdGenerator: undefined, enableJsonResponse: true})`
  per request, closed on response end.

### 11.2 Server (`_lib/mcp-server.js`)

`SERVER_INFO` (name, title, version, description, websiteUrl, icons served
from this deployment) and fixed `INSTRUCTIONS` for the model (the same for every
account; never account data): card types, search vs list, GitHub read-only,
date formats, confirm before delete, 3-pin cap, results already render as
cards (don't build your own widget).

### 11.3 Tools (`_lib/mcp-tools.js`)

| Group | Tools |
|---|---|
| Reads (`cardle.read`) | `list_feed`, `search_cards`, `get_card`, `get_dashboard_stats`, `get_account`, `list_integrations` |
| Writes (`cardle.write`) | `create_/update_/delete_` × `reminder`, `learning`, `work_item`, `family_update`, `bookmark`, `talking_point`; `snooze_card`, `unsnooze_card`, `pin_card`, `unpin_card`, `like_card`, `unlike_card`; `sync_github_issues` |

Implementation rules:

- **Scopes**: tools register only if their scope was granted;
  each declares `securitySchemes: [{type:'oauth2', scopes:[…]}]` (ChatGPT reads it).
- **Annotations on every tool** (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`), from five constants (READS, CREATES,
  REPEATABLE_WRITES, UPDATES, DELETES); `update_*` is destructive (OpenAI's
  scan requires it); sync is `openWorldHint: true`.
- **Results twice**: JSON text + `structuredContent`; errors text only with
  `isError`.
- **Output schemas** with `z.looseObject` and only always-present fields (a
  strict object becomes `additionalProperties:false` and any new field would
  break the tool).
- **Minimal results**: strip `user_email`, `sort_order`, `updated_at`,
  `deleted_at`; feed actions return `{card_type, card_id, pinned_at,
  liked_at, snoozed_until}`; only `get_account` returns the email.
- `delete_*` goes through the feed's dismiss (clears state, purges blobs).
- Every call is logged as `mcp.<tool>` with argument **names** only.

### 11.4 Cards view (MCP Apps) (`_lib/mcp-app.js`, `mcp-app/cards.html`)

- Resource `ui://cardle/cards.html`, MIME `text/html;profile=mcp-app` (spec
  2026-01-26); a second copy `ui://cardle/cards-openai.html` with
  `text/html+skybridge` for ChatGPT.
- `list_feed`, `search_cards`, `get_card` carry `_meta`:
  `ui.resourceUri`, legacy `ui/resourceUri`, `openai/outputTemplate`,
  `openai/widgetAccessible: true`, invoking/invoked status text.
- The resources declare an **empty CSP** (no connect or resource domains)
  in both forms: MCP Apps `_meta.ui.csp {connectDomains: [], resourceDomains: []}`
  and ChatGPT's `openai/widgetCSP {connect_domains: [], resource_domains: []}`.
  Without one ChatGPT shows the widget as "CSP off", and plugin review requires it.
- The HTML is self-contained (no network, no external assets), uses `light-dark()` colours and host
  theme variables, renders text only via `textContent`, implements the
  postMessage JSON-RPC directly (`ui/initialize`,
  `ui/notifications/tool-result`, `ui/open-link`,
  `ui/notifications/size-changed`, `tools/call` for Pin/Like when the host
  reports `serverTools`, `updateModelContext` after changes).

### 11.5 Prompts (`_lib/mcp-prompts.js`)

`daily_review`, `weekly_recap`, `find_card {about}`: plain instructions naming
read tools; registered for every grant.

---

## 12. OAuth 2.1 server (`_lib/oauth.js`, `api/oauth.js`)

For connector clients that can't send a custom header (Claude.ai/Desktop,
ChatGPT, Codex).

- **Discovery**: authorization-server metadata (issuer, endpoints,
  `client_id_metadata_document_supported`, `token_endpoint_auth_methods: none`,
  `code` + `refresh_token`, `S256`, scopes) and protected-resource metadata
  (`resource = <this deployment>/api/mcp`).
- **Clients**: an allowlist of known client-id URLs with their exact redirect
  URIs (ChatGPT, Claude) plus Codex's CIMD pattern restricted to
  `http://127.0.0.1:<port>/callback/<id>`. No open dynamic registration.
- **Authorize (GET)**: validate `response_type=code`, client/redirect pair,
  `resource`, PKCE `S256` challenge, scopes ⊆ `cardle.read cardle.write`;
  store the request in a signed, `HttpOnly`, `Path=/oauth` transaction cookie
  (10 min); render a small page: "Continue as <owner>" or the owner's password.
- **Authorize (POST)**: login-CSRF guarded; verify the session or the
  owner's password (rate-limited like sign-in), store **hashed** one-time code (10 min) with the
  challenge, set the session cookie, return `{redirect}` with `code`, `state`,
  `iss`.
- **Token**: form body; `authorization_code` → verify unused, unexpired, client,
  redirect, resource, PKCE; mark used atomically (`update … where used_at is
  null returning`); `refresh_token` → same single-use rotation and an
  owner re-check. Issues a **signed 1-hour access token**
  (`{typ:'cardle-access', iss, sub, aud, scope, iat, exp}` + HMAC with
  `OAUTH_SIGNING_SECRET || SESSION_SECRET`) and an opaque **30-day rotating
  refresh token** stored as a hash. Errors use OAuth error codes
  (`invalid_grant`, `unsupported_grant_type`, …), not prose.

---

## 13. Activity log (`_lib/events.js`, `docs/USER_EVENTS.md`)

- Table `user_events`: user_email, event_type, source (`web/mcp/sync`),
  item_type, item_id (no FK), context jsonb ≤ 4 KB (else `{truncated:true}`),
  client_at, created_at. Append-only.
- **Server events**: every write from a signed-in person or the sync token,
  named by `req.cardleEvent` or generic `api.request`, context = method,
  path, routing query keys, status, plus the handler's context. Card writes
  record changed field names and enum/boolean values only (never free text).
  `feed.served` records what was shown.
- **Browser events** (`POST /api/events`, ≤ 50 per batch, allowlisted types):
  `card.impression` (≥ 50% visible for 1 s, once per card per query),
  `card.open`, `card.close` (`dwell_ms`), `card.link_click` (host only),
  `feed.search`, `feed.filter`, `feed.view`, `capture.open`,
  `capture.quick_add` (guessed and saved types only), `settings.change`.
  Client batches flush every 5 s, at 20 events, and on `visibilitychange`
  hidden / `pagehide` via `sendBeacon`. `client_at` dropped if > 1 day off.
- Insert is one round trip via `jsonb_to_recordset`.
- Purpose: feed_state keeps only the latest state; this keeps the history a
  future recommender needs (exposure → action).

---

## 14. Front end

### 14.1 Structure

- `public/vault/index.html`: a **hand-maintained shell** (no generation).
  `npm test` validates required markers (element ids, asset links).
- Scripts load in order: `connect-ai.js`, `vault.js` (core),
  per-type legacy pages (`learnings.js`, `work.js`, `family.js`,
  `bookmarks.js`, `talking-points.js`), `integrations.js`, `aurora-feed.js`
  (the feed). Cache-busting by `?v=N` query strings.
- Each file is an IIFE; shared API on `window.Cardle` =
  `{api, checkAuth, escapeHtml, showLogin, editor, remove, controls,
  bindControls, simpleResource}`; page loaders register on
  `window.CardleTabs[name]`; `window.showPage(name)` switches pages and
  remembers the tab.

### 14.2 Core client (`vault.js`)

- `api(path, options)`: same-origin fetch, JSON by default, `FormData` passes
  through; throws an `Error` with `status`, `code`, `details`.
- Auth header: session → account chip (name, Connect AI, Sign out) and
  `followOnboarding()` (redirect new accounts to `/welcome.html`,
  sample-cards banner); signed out → `/signin?next=…`, or `/setup` while
  nobody owns this Cardlake.
- `showLogin()`: on any 401, goes to `/signin`, which comes back afterwards.
- Connect AI modal: generate (shown once, copy buttons), list, inline-confirm
  revoke, and under Advanced the generated sync token; focus trap and
  Escape; returns focus to the opener.
- About & help: **Sign out on all devices**, with a two-click confirm.
- **No `window.confirm()`**: webviews silently suppress native dialogs, so all
  confirms are inline.

### 14.3 The feed (`aurora-feed.js`)

- Single `state` object `{cards, stats, integrations, filter, favoritesOnly,
  view, query, cursor, …}`; `render()` rebuilds the shell HTML from state and
  re-binds; all user text escaped.
- **Optimistic actions** with rollback and stat adjustments (snoozed count,
  liked count, pinned count) and a 280 ms leave animation; 401 → login then retry.
- **Swipe**: pointer events with a 90 px threshold and 120 px max drag; right =
  snooze, left = delete / done / remove.
- Infinite scroll with an `IntersectionObserver` sentinel (300 px margin).
- Impressions with a second `IntersectionObserver` (50% for 1 s).
- Capture sheet, detail dialog, search dialog, topic picker: one `modal()`
  helper with focus trap, Escape, restore focus; bottom sheet on mobile.
- Background GitHub sync when the last sync or attempt is over 15 min old
  (attempts remembered in `sessionStorage`); re-renders only if the reader is
  near the top (`scrollY < 120`) with no dialog open.
- **Sandbox mode** (`window.CARDLE_SANDBOX`, `sandbox.html`): seven seeded cards,
  all actions in memory, no network, no events; sign-in links use
  `target="_top"` to escape the iframe; a signed-out tap on "+" opens a
  sign-in gate.
- Preferences in `localStorage` (media visuals, pinned collapsed, sample
  banner dismissed), every access wrapped in try/catch.

### 14.4 Design system

- Tokens in `aurora.css` `:root` with `oklch()` colours: background, surface,
  ink (3 strengths), glass, borders, brand gradient (`--grad-brand`), calm
  blue action gradient (no red on card actions), heart, flame; radii (control
  12, chip 20, card 16, sheet 24).
- Type icons are inline SVG; each type has a gradient badge.
- Fonts self-hosted (`public/fonts`, license shipped).
- Accessibility: roles/labels on chips, radiogroups, dialogs with
  `aria-modal`, `aria-pressed` toggles, live regions for toasts and errors,
  focus moves to new step headings in onboarding, 44 px touch targets,
  `prefers-reduced-motion` disables animations.

### 14.5 Other pages

`setup.html` and `signin.html` (styled by `account.css`), `welcome.html` +
`welcome.js` (onboarding with progress and polling), `mcp-setup.html`
(filled with this deployment's address by `connect-ai.js`), and the
owner-run `privacy.html` and `support.html`. `robots.txt` disallows
everything.

---

## 15. Security model (checklist)

| Threat | Control |
|---|---|
| Cross-tenant access | Every query filters `user_email`; feed actions verify ownership first; `get_card` returns the same "not found" for every miss; PGlite scenarios prove it |
| A second person gets in | One owner, claimed atomically at setup within its hour; no sign-up; sessions valid only for the owner |
| Password guessing | bcrypt, 10-char minimum, 10 tries per 15 min per address, same answer and timing for every refusal |
| Login CSRF | `allowSameOrigin` on setup, sign-in, sign-out everywhere and the MCP consent page |
| Stolen session | HttpOnly, SameSite=Lax, Secure, 30 d rolling; "sign out on all devices"; or rotate the secret |
| Replaced owner keeps access | Session guard, token revocation, integration wipe, MCP/OAuth owner re-check |
| Credential leakage in DB dump | API tokens, OAuth codes and refresh tokens hashed; GitHub tokens AES-GCM with a dedicated rotatable key |
| Over-broad third-party tokens | Fine-grained GitHub tokens only, checked before contacting GitHub |
| Demo tenant leaking private data | `default` never has integrations; signed-out reads hit only it |
| Abuse of public endpoints | Rate limits (setup, sign-in, connect, sync); body size limit; server-side quotas |
| XSS | Server never renders user HTML; client escapes; MCP view uses `textContent`; CSP-default MCP view |
| Error detail leakage | Generic 500 message |
| OAuth misuse | Fixed client/redirect allowlist, PKCE S256 only, single-use hashed codes, rotating refresh, resource binding |
| Event log over-collection | No bodies, no free text (except search), 4 KB cap, 24-month retention |
| Third-party tracking | No third-party scripts, analytics or advertising; fonts self-hosted; a report-only CSP watches for anything else |

Incident steps: `docs/SECURITY_INCIDENT_RESPONSE.md` (contain → assess →
record). Services involved: `docs/SUBPROCESSORS.md`. How Cardlake uses AI, and
what it never does with card content: `docs/AI_DATA_USE.md` (Cardlake runs no
model and trains nothing).

---

## 16. Testing

### 16.1 Tiers

| Tier | Command | What | Runs |
|---|---|---|---|
| Build | `npm test` | Vault shell exists and has its markers | CI, every change |
| Lite | `npm run test:lite` (~370 tests, ~6 min) | `tests/unit/`: offline | CI, every change |
| Full | `npm run test:full` | lite + `tests/sit/` against `CARDLE_URL` (no default) with `SYNC_TOKEN` | before merging API/DB changes; after deploy, against a test deployment of your own |

A SIT run with skipped tests did **not** run (the token didn't load).

### 16.2 Unit test styles (all in Python `unittest`)

1. **Source checks**: read a shipped file and assert on it (routes wired in
   `vercel.json`, every deployed function guarded, no Google Fonts, docs say
   local dev needs its own database, nothing names a hosted deployment, copy
   rules like "never say talking points").
2. **In-process Node**: `subprocess.run(['node','-e', script])` exercising a
   pure function or handler with fake `req`/`res` (cookie signing, tenant
   resolution, rotation math, limits).
3. **PGlite scenarios**: `tests/unit/*_scenarios.js <name>` run one scenario
   per process against a fresh in-memory Postgres with the **real**
   `schema-v2.sql` applied (`pg_harness.js` exposes a Neon-compatible tagged
   template; tests swap `db.getSql`, and `allowAccounts()` stands in several
   tenants). Covers setup and sign-in, sessions, MCP tools and schemas,
   integrations, onboarding, surprise, reminders, streaks, events, pins,
   retention. Skipped with a clear message if `npm ci` wasn't run.

### 16.3 System tests (`tests/sit/`)

Real HTTPS against a deployment: CRUD cycles for every type, soft delete,
auth-gated writes, migrate idempotence, feed pagination, MCP from a client's
view (server info, icons, annotations, structured results against schemas, a
card created and deleted, 401s). Every row uses an invocation-unique title
and is cleaned up, because they write to the deployment they target.

### 16.4 Why the full tier matters

Two bugs once passed lite: a `coalesce(uuid_col, '')` that only fails
against real Postgres types, and a variable used before declaration in one
handler. Both are invisible to source checks; only executing against a real
database catches them. PGlite scenarios were added for exactly this.

---

## 17. Development workflow

- **Branches and PRs only**; one logical change per PR. CI must pass.
- **Tests first** for a fix: one that fails without it. Which tiers to run
  for which change is in `tests/README.md`.
- **After a merge that touches the schema**: the deploy applies it on its
  first request; run `npm run test:full` against a test deployment.
- **ChatGPT caches a connector's tool list**: after changing tools or `_meta`,
  click "Refresh tools" in ChatGPT's connector settings.

---

## 18. Operations

| Task | How |
|---|---|
| Deploy | Merge to `main` (Vercel runs `npm run build`, serves `public/` and `api/`) |
| Migrate | Automatic on the first request; `POST /api/migrate` with `X-Sync-Token` by hand if it keeps failing |
| Verify | Root, `/vault/`, `/api/learnings` respond; `npm run test:full` |
| Roll back | Vercel: promote the previous deployment; then revert on `main` via PR |
| Rotate session secret | Change in Vercel, redeploy: everyone signs out |
| Rotate encryption key | Move current to `…_PREVIOUS`, set new, redeploy; tokens reseal on next use; drop the old key later |
| Forgotten password, or take it back | `CARDLE_SETUP_OPEN=1`, redeploy, finish `/setup`, remove it, redeploy (`docs/ADMIN.md`) |
| Monitor | Vercel logs |

**Cost** (`docs/COST_ESTIMATES.md`): one person fits in Vercel's and Neon's
free plans.

---

## 19. Lessons learned (read before building the next one)

1. **Know your function budget early.** Plan consolidated routers plus
   rewrites from day one; never let a deployed entry point import excluded files.
2. **Never set a cookie `Domain`** unless you must; host-only cookies work on
   every domain and preview.
3. **Additive schema needs code that survives the gap** before it is
   applied. Every new column needs a fallback path or a feature switch.
4. **Test against real Postgres.** In-memory PGlite with the real schema catches
   type errors that mocks and source checks miss.
5. **Serverless freezes after the response.** Await logging/side effects
   before answering.
6. **A public demo tenant is a data-leak magnet.** Forbid integrations and
   anything private on it explicitly.
7. **Make "who is calling" two explicit functions** (viewer vs writer). Most
   tenancy bugs come from guessing.
8. **Build public shapes field by field** (`publicIntegrationView`,
   `publicCard`) so new columns can't leak.
9. **Use claims for idempotency** (`update … where x is null returning`) for
   onboarding, deals, OAuth codes, refresh tokens, pool refresh.
10. **Partial unique indexes need the predicate in `on conflict`.**
11. **Local dev on a production database is convenient and dangerous.**
    Give local dev and tests a database of their own from the start.
12. **Separate preview infrastructure means database, file store and
    secrets.** Sharing the file store alone would let a test delete a real file.
13. **Fine-grained, least-privilege third-party tokens**, validated before use.
14. **Webviews suppress `confirm()`**; use inline confirms.
15. **MCP tool schemas must be loose objects**, annotations on every tool,
    minimal results; ChatGPT needs its own resource MIME type, an explicit
    (empty) widget CSP, and a manual tool refresh.
17. **HTML `pattern` uses the regex `v` flag**: escape `-` in character
    classes or browsers ignore the whole pattern.
18. **Drive your own MCP server through real assistants.** A bug bash through
    claude.ai and ChatGPT found 28 bugs (date parsing, unsafe links, pin
    accounting, error leaks) that direct tests had missed. Validate every input
    an assistant can send as if a stranger wrote it.

---

## 20. Build order for a new project like this

1. Repo, license, CI (lite tests), Vercel project, Neon project, `schema-v2.sql`
   with tenant column + soft delete conventions, `/api/migrate`.
2. `_lib/db.js`, `http.js` (`readJson`, `sendError`), `auth.js` (cookie,
   viewer/writer resolvers), owner setup and password sign-in, `session-guard.js`.
3. Config-driven resources (`resource-configs.js`, `resources.js`) and the
   consolidated router; local `dev_server.js`.
4. Limits module and error codes.
5. Feed engine (`loadVisibleCards`, normalize, rotation, actions, pagination,
   streak) and the feed UI with optimistic actions and swipe.
6. Files/attachments on a private blob store.
7. Events log (server wrapper + browser batcher).
8. PGlite harness and scenarios; system tests with unique titles against a
   test deployment of your own.
9. MCP server (tools with scopes, annotations, schemas; personal tokens),
   then OAuth 2.1 for Claude.ai/ChatGPT, then the MCP Apps card view.
10. Onboarding personas with trial cards; Deal me 5 with a self-refreshing pool.
11. Integration registry + first connector with encrypted credentials.
12. Owner replacement, retention purge, privacy and support pages, incident
    runbook.
