# Cardlake cost estimates

_These are planning estimates, not a provider quote. Recheck the linked
pricing pages and your Vercel and Neon usage dashboards._

A Cardlake has one person on it, so it fits the free plans:

- **Vercel Hobby** (free): hosting, the 10 serverless functions Cardlake
  deploys (the plan allows 12), the daily cron, and private Blob storage
  within the Hobby allowance.
- **Neon Free**: a Postgres database that scales to zero when unused. One
  person's cards and activity history take a few megabytes.
- **Files** are the first thing that can grow: each upload is at most 4 MB,
  and the per-person cap is 50 MB (`docs/LIMITS.md`), which stays well within
  the free Blob allowance.

Nothing else is paid for: no sign-in provider, no analytics, no email
service. An AI assistant you connect is billed by its own provider, if at
all.

## Pricing references

- [Vercel pricing](https://vercel.com/pricing)
- [Vercel Blob usage and pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing)
- [Neon pricing](https://neon.tech/pricing)
