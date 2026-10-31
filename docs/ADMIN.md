# Running your Cardlake

A Cardlake has exactly one account: its owner's. There are no other
accounts, no sign-up form, no invitations and no admin page. This page
covers what the owner may need to do besides using it.

## First-run setup

A new deployment has no owner. Until it has one, the app sends visitors to
`/setup`, where the first person to choose a name, email and password becomes
the owner (`api/_lib/local-accounts.js`). So that a stranger can't claim a
forgotten deployment, setup is open only for **one hour** after the database
was first set up (`app_config.instance_created_at`). The setup page says so,
and the README tells owners to do it right away.

The owner is recorded in `app_config` (`instance_owner`), claimed atomically:
two people racing on a fresh deployment can't both win.

## Forgotten password, or taking it back

Set `CARDLE_SETUP_OPEN=1` in Vercel (**Settings**, **Environment
Variables**) and redeploy. That reopens `/setup`, even after setup.
Finishing it then:

- with **the same email**: replaces the password. All your cards stay.
- with **a different email**: makes that email the owner. The previous
  owner's sessions stop working on their next request, and their Connect AI
  tokens, assistant connections and GitHub connection stop too
  (`api/_lib/offboarding.js`). Their cards stay in the database, out of
  reach. Use this if a stranger got to setup first.

Delete `CARDLE_SETUP_OPEN` and redeploy afterwards: while it is set, anyone
who opens `/setup` can do the same.

## Signing in

The owner signs in at `/signin` with their email and password (bcrypt,
10 to 72 bytes). Sign-in and setup are each limited to 10 attempts per 15
minutes from one address (per warm instance, `api/_lib/rate-limit.js`). A
wrong email and a wrong password get the same answer, in the same time. The
owner's email address isn't verified: it is what they sign in with.

A device stays signed in while it's used: each session lasts 30 days from
the last time that browser used Cardlake, renewed at most once a day
(`api/_lib/session-guard.js`). **About & help** has **Sign out on all
devices**, which ends every session at once, for a lost or shared device.
Assistants you connected keep working; remove them under **Connect AI**.

## The sync token

Scripts and the system tests (`tests/README.md`) use the sync token. If
you didn't set `SYNC_TOKEN` in Vercel, your Cardlake generated one; you find
it under **Connect AI**, **Claude Code, Gemini or a script?**, **Advanced: sync token**.
It works in a separate shared space, never in your own cards. A token set
in Vercel is never shown in the app.

## Daily clean-up

Deleted cards and files are purged after their retention period
(`api/_lib/retention.js`, `docs/LIMITS.md`). With `CRON_SECRET` set,
Vercel Cron runs the purge daily (`vercel.json`). Without it, your Cardlake
runs the same purge itself, at most once a day, after a request it has
already answered (`app_config.retention_last_run`).
