# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security problem. Report it privately
instead, through GitHub's **Report a vulnerability** button on this
repository's Security tab.

Include what you found, how to reproduce it, and what an attacker could do
with it. You'll get an acknowledgement within a few days. Please give us a
reasonable chance to fix it before you disclose it publicly.

## Scope

In scope: this repository's code. Most valuable are findings that let
someone other than the owner read or change a Cardlake's data, bypass
sign-in or first-run setup, or expose stored credentials.

Please test against a copy you deployed yourself. Don't test against
someone else's Cardlake, touch other people's data, or use social
engineering.

## Running your own copy

If you run your own Cardlake, you are responsible for its configuration:
keep `SESSION_SECRET`, `SYNC_TOKEN` and `INTEGRATION_ENCRYPTION_KEY` secret
(whether you set them or the deployment generated them), and keep it updated
for security fixes (see "Getting updates" in the README).
