# Environment

**Nothing here is required.** A Cardlake made with the README's "Deploy with
Vercel" button gets its database and file storage from the Neon and Blob
stores Vercel adds, makes its own secrets, and is set up by its owner at
`/setup`. Everything below is optional: each entry says what happens without
it. Set them in Vercel (Settings, Environment Variables) for Production and
Preview as appropriate, then redeploy.

- `DATABASE_URL`: the Postgres connection string. Set for you by the Neon
  store, which also sets `POSTGRES_URL`; that one is used when
  `DATABASE_URL` isn't set (`api/_lib/db.js`). Without either, nothing works.
- `BLOB_READ_WRITE_TOKEN`: set for you by the Blob store. Without a Blob
  store, cards work but files can't be attached (`docs/UPLOADS.md`).
- `SESSION_SECRET`: long random session secret. **Optional:** without it the
  deployment generates one on its first request and keeps it in the
  `instance_secrets` table (see "Generated secrets" below). Rotating it signs
  the owner out everywhere. Until `INTEGRATION_ENCRYPTION_KEY` is set, it is
  also the root key (via HKDF) for encrypting integration credentials, so
  rotating it then also makes stored GitHub tokens unreadable (the owner is
  asked to reconnect).
- `INTEGRATION_ENCRYPTION_KEY`: dedicated key for integration credentials
  (e.g. GitHub tokens), 32 random bytes, base64. Generate one with
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
  Once set, new tokens are sealed with it and tokens sealed under
  `SESSION_SECRET` move onto it the next time they are used, so the two
  secrets stop being tied together. A malformed value fails loudly rather
  than falling back. **Optional:** when neither it nor `SESSION_SECRET` is
  set, the deployment generates one and stores it (see "Generated secrets"
  below for what that does and doesn't protect against).
- `INTEGRATION_ENCRYPTION_KEYS_PREVIOUS`: optional comma-separated retired values of
  `INTEGRATION_ENCRYPTION_KEY`, still accepted for decrypting. To rotate:
  (1) move the current key here and set a new `INTEGRATION_ENCRYPTION_KEY`;
  (2) redeploy -- each stored token is resealed under the new key on its next
  sync (background sync runs whenever the owner opens Cardlake);
  (3) once every token has been used, remove the old key from this list. A
  token still sealed under a removed key asks the owner to reconnect.
- `OAUTH_SIGNING_SECRET`: optional separate long random signing secret for
  MCP OAuth access tokens (used by the Claude.ai and ChatGPT connector flows,
  not by personal access tokens -- see `docs/MCP_SERVER.md`). If unset,
  `SESSION_SECRET` is used; when that isn't set either, the deployment
  generates one and stores it.
- `SYNC_TOKEN`: bearer token for markdown synchronization, `POST
  /api/migrate` and the system tests. **Optional:** without it the deployment
  generates one; the owner finds it under Connect AI, Advanced. A token set
  here is never shown there.
- `CRON_SECRET`: optional. Lets Vercel Cron run the daily retention purge
  (`/api/cron/purge-retention`, `api/_lib/retention.js`); Vercel Cron sends
  it as `Authorization: Bearer <CRON_SECRET>`. Without it, the purge still
  runs: the app runs it itself at most once a day, after a request it has
  already answered (`docs/ADMIN.md`). It can't be generated: Vercel has to
  know it too.
- `CARDLE_SETUP_OPEN`: optional, normally unset. `1` reopens first-run setup
  at `/setup` so the owner can replace a forgotten password, or take the
  Cardlake back from someone who set it up first (`docs/ADMIN.md`). Redeploy
  after setting it, and delete it (and redeploy) right after: while it is
  set, anyone who opens `/setup` can do the same.
- `CARDLE_PUBLIC_ORIGIN`: optional. The address this deployment is served at,
  e.g. `https://notes.example.com`, used in OAuth metadata for AI assistants
  and in links the MCP server returns. Defaults to the Vercel project's
  production domain, or `http://localhost:3000` outside Vercel
  (`api/_lib/public-origin.js`). Set it when you use a custom domain.
- `CARDLE_MAX_*`, `CARDLE_BLOB_STORAGE_*`: optional limits; see
  `docs/LIMITS.md` and `api/_lib/limits.js` for the names and defaults.
- `MCP_TOKEN`: optional legacy bearer token for `/api/mcp`, scoped to the
  separate `'default'` tenant only. The owner generates their own tokens from
  the app's "Connect AI" panel instead; no variable is needed for that. See
  `docs/MCP_SERVER.md`.

## Generated secrets

A deployment that doesn't set `SESSION_SECRET`, `SYNC_TOKEN`,
`OAUTH_SIGNING_SECRET` or `INTEGRATION_ENCRYPTION_KEY` makes its own: 32
random bytes each, generated on the first request and stored in the
`instance_secrets` table (`api/_lib/instance-secrets.js`). Every later
request and cold start reads the same values back. An environment variable,
when set, always wins and nothing is stored for it. `OAUTH_SIGNING_SECRET`
and `INTEGRATION_ENCRYPTION_KEY` are generated only when `SESSION_SECRET`
isn't set either; with `SESSION_SECRET` set they fall back to it.

**The trade-off for integration credentials.** A generated
`INTEGRATION_ENCRYPTION_KEY` lives in the same database as the GitHub tokens
it encrypts. It still protects a leaked export or backup of the
`integrations` table on its own, but not a copy of the whole database, which
would hold the key too. If that matters to you, set `INTEGRATION_ENCRYPTION_KEY`
in Vercel yourself, so the key never reaches the database. GitHub
connections made under the generated key then ask to be reconnected once.

The other generated secrets sit in the database too, so anyone who can read
it could sign sessions. They could already read every card there, so this
adds little.

`MCP_TOKEN` is never generated: it stays unset unless you set it.

## Preview deployments

Vercel builds a preview for every pull request. Give previews their own
database and Blob store (Preview-only `DATABASE_URL` and
`BLOB_READ_WRITE_TOKEN`), never production's: a preview runs unmerged code,
and deleting a card deletes its files. Start the preview database empty;
its first request applies `schema-v2.sql` (`DEPLOY.md`, "Database
migration"), and `/setup` makes a test owner. Then run the system tests
against it (`tests/README.md`).

## Running the app locally

`npm run dev` starts `scripts/dev_server.js`, a small stand-in for `vercel dev`
that serves `public/` and routes `/api/*` to the same handler files Vercel
uses. It reads `.env.local` (gitignored -- copy `.env.example` and fill in
local values).

**Use a database of its own for local development.** `DATABASE_URL` is used
exactly as configured, so whatever database `.env.local` points at is the one
`npm run dev` reads and writes. Never point it at a database that holds real
data; see the options below.

- `DATABASE_URL`: used exactly as configured (see above). The first request
  applies `schema-v2.sql` to it.
- Everything else as in production, and just as optional. On an empty
  database, open `http://localhost:3000/setup` to create the owner.

### Isolating local development from production data

Two ways to give `npm run dev` its own database, in increasing order of
effort:

1. **Point `DATABASE_URL` at a separate Neon database** -- a different Neon
   project, or an empty branch. Nothing else changes: the Neon HTTP driver
   doesn't care which database it's pointed at, so this is the smallest
   possible change.
2. **Run a real local Postgres and set `LOCAL_DEV_PG=1`** in `.env.local`.
   `@neondatabase/serverless` only speaks SQL-over-HTTP to a Neon-hosted
   database and cannot reach a plain local Postgres, so this flag swaps
   `api/_lib/db.js` to a `pg`-backed client exposing the same
   tagged-template call shape, so every route works unmodified against a
   local database. Never set this in Vercel -- production keeps using the
   Neon driver unconditionally.
