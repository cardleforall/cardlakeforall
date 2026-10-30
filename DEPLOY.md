# Deployment notes

The README's "Run your own" section walks through a first deploy: the
"Deploy with Vercel" button adds a Neon database and a Blob store, the app
generates its own secrets, and the owner sets a password at `/setup`. No
environment variable has to be typed. Everything you can set is optional
(`docs/ENVIRONMENT.md`); never record values in this repository.

## Deploy flow

GitHub is the deployment source. Connect your copy of this repository to a
Vercel project, configure `main` as the production branch, and let pushes
create deployments. Vercel runs `npm run build` (`vercel.json`), which builds
and checks the vault page. Run `npm test` before pushing.

`python3 scripts/deploy_vercel.py` remains an explicit *optional local*
helper only. It requires `VERCEL_TOKEN` (or `--token`) and never reads a
token file.

## Database migration

The database sets itself up. On the first request after a deploy, the app
compares a hash of `schema-v2.sql` with the one stored in `app_config`
(`schema_hash`) and, when they differ, applies the file statement by
statement (`api/_lib/schema.js`). Every statement is additive (`create table
if not exists` / `add column if not exists`), so applying it again is safe.
Each warm function remembers that the check passed, so later requests skip
it. No sample data is ever added.

`POST /api/migrate` stays as a manual fallback, for example to see the error
if automatic application keeps failing (the function logs show
`[schema] could not apply schema-v2.sql`). It writes no data. It needs a
valid `SYNC_TOKEN` header (Connect AI, Advanced shows a generated one); a
signed-in session is refused:

```bash
curl -X POST https://<your-cardlake>/api/migrate -H "X-Sync-Token: <SYNC_TOKEN>"
```

## Local utilities

- Build the vault artifact: `python3 scripts/build_vault_public.py`
- Validate it: `python3 scripts/validate_vault_build.py`
