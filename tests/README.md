# Tests

## Structure

```
tests/
  unit/   -- offline: no network, no database
  sit/    -- system integration tests: hits the real deployed API + database
  run_tests.sh
```

**`tests/unit/`**: offline, one `test_*.py` per feature. Python's
`unittest` is the only runner: discovery finds `test_*.py`, and every Node
file here runs only because a `test_*.py` calls it. There are four kinds of
file:

| File | What it is |
|---|---|
| `test_*.py` | The entry points. Source checks against shipped files (markup, wiring, docs), plus a subprocess call per Node case. |
| `*_scenarios.js` | Named cases, one per Node process: `node tests/unit/x_scenarios.js <name>`. Most drive the real API handlers against real Postgres in memory (PGlite, `pg_harness.js`); `security_scenarios.js` tests pure helpers the same way. Each ends with `require('./scenario_runner').runScenario(scenarios);`, which also gives `--list`. |
| `*.test.js`, `owner_journey.js` | One script that runs all its cases in one go: pure front-end or helper functions, or a whole walk through a fresh deployment. |
| `_paths.py`, `pg_harness.js`, `scenario_runner.js`, `vercel_router.js` | Shared helpers, not tests. |

`test_suite_wiring.py` fails if a scenario is never called by name from a
`test_*.py`, if a Node file is never run, or if a Python file is named so
that discovery skips it. Any of these would otherwise "pass" by never
running.

#### Adding a test

- **Behavior of an API handler or anything that touches the database:**
  add a scenario to the feature's `*_scenarios.js` (or a new one modelled
  on `reminder_scenarios.js`), and a `test_<scenario name>` method in its
  `test_*.py` that runs it. A scenario the wrapper doesn't call fails
  `test_suite_wiring.py`.
- **A pure function** (front-end helper, crypto, date math): a case in
  a `*_scenarios.js` or `*.test.js` next to the others for that module.
- **Markup, wiring or docs that must stay in place:** a source check in the
  feature's `test_*.py`. Prefer testing behavior when you can: a regex
  passes whether or not the code works (see the case study below).
- PGlite-backed classes are `@unittest.skipUnless(PGLITE.is_dir(), ...)`,
  so run `npm ci` first or they skip.

**`tests/sit/`**: System Integration Tests. `test_production.py` drives the
real, deployed Cardlake API over HTTPS, which talks to the real Postgres
database. This is the only place in the suite that can catch a bug that's
only wrong once real infrastructure is involved: a query that's syntactically
fine but fails against real Postgres column types, a handler that only
receives requests the way Vercel's rewrites actually shape them, a runtime
error that static analysis can't see. Every row it creates has an
invocation-unique title and is soft-deleted in cleanup, so repeat runs are
safe. Point them at a test deployment of your own, never one with real data. `test_mcp_production.py` does the same for
the MCP server (`/api/mcp`): it mints a personal token for the shared
`default` account with `SYNC_TOKEN`, checks what a client sees (server info,
icons, tool hints, structured results against their output schemas, one card
created and deleted through MCP, 401s), and revokes the token afterwards.

## Tiers

| Tier | Runs | Needs | Speed |
|---|---|---|---|
| `--tier lite` | `tests/unit/` only | nothing | ~2s |
| `--tier full` | `tests/unit/` + `tests/sit/` | `SYNC_TOKEN` in the environment | lite + ~30-60s (real network) |

`SYNC_TOKEN` has no bundled fallback: if it's unset, the whole SIT
class is *skipped* (reported as `skipped`, not silently run unauthenticated
or silently passing). `CARDLE_URL` sets which deployment `--tier full`
targets. It has no default: the tests write to whatever deployment they are
pointed at, so you always choose it, and without it they are skipped.

```bash
npm run test:lite
npm run test:full
```

### Getting `SYNC_TOKEN` locally

The SIT tier reads the same `SYNC_TOKEN` the target deployment checks, under
the same name. A deployment that generated its own (`docs/ENVIRONMENT.md`,
"Generated secrets") shows it to the owner under **Connect AI**, **Claude
Code or a script?**, **Advanced: sync token**. Pass both for the one command,
without echoing the token into your shell history (read it from wherever you
keep it):

```bash
CARDLE_URL=https://<your-test-deployment> \
SYNC_TOKEN="$(cat ~/.config/cardlake/test-sync-token)" \
  bash tests/run_tests.sh --tier full
```

Then confirm the SIT run reports `Ran N tests ... OK` with **no** `skipped`.
A skipped class means the URL or token didn't load, not that the deployment
is healthy.

Everything here acts as the shared `default` account, which the sync token
reaches; it never touches the owner's cards. A fresh deployment has no
sample data, so a check that needs some (Misc cards with sub-sections) skips
itself until there is.

## When to run what

| Situation | Run | Why |
|---|---|---|
| Editing code, inner dev loop | `--tier lite` | instant feedback, no setup, no secrets |
| Before every commit / opening a PR | `--tier lite` | matches what CI runs; catches regressions in seconds |
| CI (`.github/workflows/ci.yml`, the `validate` job) | already wired to `npm run test:lite` | CI has no `SYNC_TOKEN` and shouldn't touch a deployment anyway |
| Before merging a PR that touches `api/`, `schema-v2.sql`, or anything DB-adjacent | `--tier full` | lite proves the JS logic and source shape are right; it never opens a real Postgres connection, so a query that's only broken against real column types will pass lite and fail full (see case study) |
| Right after a deploy | `--tier full` against a test deployment (or a preview) | confirms the live API actually behaves, not just that the source looks right |
| A user reports a bug the test suite doesn't reproduce | `--tier full`, then a one-off diagnostic script against the real DB if full still can't reproduce it | if full can't catch it either, the bug is likely state-dependent (a specific row's shape, a specific tenant) rather than a logic bug lite/full would generalize to |

### Case study: why lite alone isn't enough

Two real production incidents shipped through this exact test suite, both
invisible to `--tier lite`:

- `coalesce(subsection_of, '')` against a `uuid` column threw
  `22P02 invalid input syntax for type uuid` on *every* card-create
  endpoint. The JS was syntactically valid and passed every source check;
  it only fails once it hits a real Postgres connection.
- `listEntries()` referenced a `tenant` variable before it was declared in
  that function's scope (a copy-paste artifact): a `ReferenceError` that
  only happens when the function actually *runs*, not when its source is
  inspected. It broke every unauthenticated `GET /api/learnings` request in
  production.

Both merged with `--tier lite` (and CI) green, because lite has no real
database to run the query against and no way to invoke the broken function
as a live request. `--tier full`, or production traffic itself, was the
only thing that could have caught either one before a user did.
