# Security incident response runbook

What to do if Cardlake has a personal data breach: a security incident that
leads to accidental or unlawful destruction, loss, alteration, unauthorized
disclosure of, or access to, personal data. That's broader than "we got
hacked": it also covers a leaked credential, a bug that shows one tenant's
data to another, an accidental email to the wrong address, or a lost device
with access still signed in.

Written once, while nothing's on fire, so the steps below don't have to be
invented during an actual incident. See also `docs/ROLLBACK.md` for
rolling back a bad deploy, which is often the first containment step.

## 1. Contain it first

Cardlake-specific actions, roughly in order of how disruptive they are:

- **The owner's password or a device is compromised**: use **Sign out on
  all devices** (About & help), set a new password through a reopened setup
  (`docs/ADMIN.md`), and revoke Connect AI tokens. If someone else took the
  Cardlake over, a reopened setup with the owner's email replaces them: their
  sessions, API/MCP tokens and stored GitHub token stop working within ~30
  seconds (`api/_lib/offboarding.js`).
- **Sessions in general are suspect** (e.g. `SESSION_SECRET` may have
  leaked): rotate `SESSION_SECRET`. Every existing session cookie fails to
  verify immediately and everyone is signed out: a blunt but total fix.
- **Stored third-party credentials may be exposed** (e.g.
  `INTEGRATION_ENCRYPTION_KEY` may have leaked): rotate it per
  `docs/INTEGRATIONS.md` / `docs/ENVIRONMENT.md`. Existing encrypted GitHub
  tokens become unreadable, which is the safe failure mode: affected users
  reconnect GitHub afterward.
- **A bad deploy caused it** (e.g. shipped a tenant-isolation bug): follow
  `docs/ROLLBACK.md` to promote the previous deployment, then fix and
  redeploy.
- **A specific token leaked** (API token, OAuth refresh token): revoke it
  directly: `revokeAllApiTokens` for a user's API tokens, or the
  equivalent for OAuth tokens in `api/_lib/oauth.js`.

Containment comes before a full investigation. Do the safe, reversible
thing immediately; figure out exactly what happened next.

## 2. Assess what actually happened

- What table(s) were involved? Check `schema-v2.sql` for what that means in
  practice: e.g. `users` is email/name/picture, `integrations` is an
  encrypted token plus a repo name, `user_events` is activity history
  (never card text).
  `public/privacy.html` is the plain-language description of each table if
  a quick reminder is needed.
- How many accounts, and which ones specifically (query by tenant/email,
  same as every other query in this codebase).
- Was anything actually exposed to someone unauthorized, or just
  vulnerable in theory? Both get logged (see step 4); only the former
  usually triggers notification duties.
- Is this ongoing or already contained? Don't assess "how bad" until step 1
  has actually stopped it from getting worse.

## 3. Decide whether anyone else is affected

A Cardlake holds its owner's own data, so usually nobody else needs to be
told. If it held someone else's personal data too (their name or email in a
card, a shared repository's issues), check whether data-protection law where
you live expects you to report the breach or tell them, and how fast: under
GDPR, for example, it is 72 hours. If the problem is in Cardlake's code
rather than your setup, report it privately as `SECURITY.md` describes, so
other people running Cardlake get the fix.

## 4. Record it, regardless of outcome

Keep a short written note (a personal log is enough at this scale, no
tooling needed) for every incident investigated, including near-misses
and "decided not reportable" cases:

- What happened, when discovered, when it actually occurred (if different).
- What data and how many people.
- What containment steps were taken and when.
- Whether anyone was told, who, when, and if not, why not.
- What fixed the root cause.

Your future self will want it the next time something looks off.

## 5. Fix the root cause and follow up

- Ship the actual fix, same as any other bug, but don't describe the
  exploit mechanics in a public commit message or PR if it's still
  exploitable elsewhere.
- If tokens were revoked as containment, reconnect your assistants and
  GitHub once it's safe.
- Revisit whether this runbook needs updating based on what containment
  step was actually missing or slow.
