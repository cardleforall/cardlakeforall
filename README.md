# Cardlake

**A self-hostable feed that Claude and ChatGPT can save to.** Reminders,
learnings, bookmarks and work follow-ups in one place you own: open source
(AGPL), on your own Vercel and Neon accounts.

[![CI](https://github.com/cardleforall/cardlakeforall/actions/workflows/ci.yml/badge.svg)](https://github.com/cardleforall/cardlakeforall/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![MCP: Claude, ChatGPT](https://img.shields.io/badge/MCP-Claude%20%C2%B7%20ChatGPT-8A2BE2)](docs/MCP_SERVER.md)

**[Get started](#get-started)** · [What it does](#what-it-does) · [Looking after your Cardlake](#looking-after-your-cardlake) · [For developers](#for-developers)

Why it exists: [I wanted one place every AI could write to. So I built it.](https://builderjon.medium.com/i-wanted-one-place-every-ai-could-write-to-so-i-built-it-315cd88da4de) (on Medium)

## Get started

Don't want to host it yourself? Use Cardlake at [cardlake.app](https://cardlake.app).

To run your own: free on Vercel's and Neon's free plans, about 10 minutes, no
terminal.

1. **Sign up at Vercel** at [vercel.com/signup](https://vercel.com/signup) with
   **Continue with GitHub**. No GitHub account? GitHub's sign-in page has
   **Create an account** ([github.com/signup](https://github.com/signup)).
   Finish Vercel's sign-up, including its code, until you see its dashboard.
2. **Click Deploy**, then **Create**, add **Neon** (your database) and
   **Blob** (your attachments) on their free plans, and **Deploy**:

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcardleforall%2Fcardlakeforall&project-name=cardlake-self-hosted&repository-name=cardlake-self-hosted&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22neon%22%2C%22productSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22blob%22%2C%22access%22%3A%22private%22%7D%5D)

   If Vercel shows its dashboard instead, come back and click the button again.
3. **Open your site and set your password** right away: for your security,
   setup is open for one hour after your site first starts, then it locks so
   nobody else can claim it. (Missed it? The setup page explains how to reopen
   it.)
4. **Optional: connect Claude or ChatGPT.** In Cardlake, click **Connect AI**.

**New to Vercel or GitHub?** The [step-by-step guide](docs/SETUP_GUIDE.md) has
a picture for every step.

The whole deploy, from the button to a first card, in 37 seconds:

https://github.com/user-attachments/assets/8834c580-ecd8-4ebc-847b-f73f6f40099c

## What it does

![A Cardlake feed on a Monday morning: two work follow-ups pinned at the top, with filters for favorites and snoozed cards.](docs/media/cardlake-feed.webp)

Cardlake turns everything you don't want to forget (reminders, articles to
read, family updates, bookmarks, notes, and your GitHub issues) into a single
feed, instead of a dozen apps you never open.

https://github.com/user-attachments/assets/10d1ce6c-f12a-42bf-aed6-dba16530b934

- **Talk to it from your AI.** Tell Claude or ChatGPT "remind me Wednesday at
  10" or "what's on today?" and it reads and writes your feed over
  [MCP](docs/MCP_SERVER.md). Every card type and action works from chat.
- **In Telegram, with Hermes Agent.** The
  [Cardlake plugin for Hermes](https://github.com/cardleforall/cardlake-hermes)
  shows your cards in your Telegram chat with Done, Tomorrow and Undo buttons.
  Connect Hermes to your own Cardlake from **Connect AI**, and the plugin's
  links follow it.
- **One feed for everything.** Reminders, learnings, work items, family
  updates, bookmarks and misc notes, with a progress bar and a streak.
- **Snooze, pin, favorite.** Not today? Snooze a card and it comes back
  when it should. Pin what matters this week.
- **Your GitHub issues as cards**, brought in with one click.
- **Save from any app.** Install it on your phone and share a link or text
  to Cardlake; it becomes a card.
- **Search and attachments.** Find any card; attach photos and files.
- **Yours.** Your own database, your own deployment, one account: yours.
  Open source under AGPL-3.0.

### Why Cardlake

Notes apps, task apps and read-later apps each hold a piece of what you meant
to come back to, and you check none of them. Cardlake is the one place it all
lands, and the place your AI writes to when you ask it to remember something.
Because your own copy runs on your own Vercel and Neon accounts, what you and
your AI save stays with you.

### Why a feed, not folders

Something you mean to come back to keeps nagging at you until it's written
down somewhere you trust. One feed is easier to keep up with than seven apps,
and it brings things back to the top before you forget them.

## Looking after your Cardlake

### It's yours alone

Your Cardlake has one account, yours. There's nobody to
administer: no sign-up, no user list, no invites. Sign in with the same
email and password on your phone and other computers.

### Forgot your password?

In Vercel, open your project, then **Settings** and
**Environment Variables**. Add `CARDLE_SETUP_OPEN` with the value `1`, save,
and redeploy (**Deployments**, **⋯**, **Redeploy**). Open `/setup` on your
site and set a new password with the same email: you keep all your cards.
Then delete `CARDLE_SETUP_OPEN` and redeploy again.

### Getting updates

Your copy doesn't update by itself. When a new version
is out, Cardlake shows **Update available** at the top; it leads to your
Cardlake's `/updates` page. The first time, click **Turn on
updates** there: GitHub opens with the update file filled in, ready to commit. After
that, to get the latest Cardlake, open your copy on GitHub, then **Actions**,
**Update Cardlake** and **Run workflow**. Vercel deploys the new version a
minute or two later, and you keep all your cards. If you've changed the code
yourself, it stops rather than erase your changes. To also hear about new
versions by email, open [Cardlake on GitHub](https://github.com/cardleforall/cardlakeforall) and
choose **Watch**, **Custom**, **Releases**.

### Settings

Everything else is optional. Cardlake makes its own secret keys and sets
up its own database. [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) lists the
settings you can add later, such as a custom domain, and
[docs/ADMIN.md](docs/ADMIN.md) covers running it.

## For developers

### Quick start (local development)

```bash
git clone https://github.com/cardleforall/cardlakeforall.git
cd cardlakeforall
npm ci
cp .env.example .env.local   # fill in the values -- see docs/ENVIRONMENT.md
npm run dev
```

This starts a local dev server at `http://localhost:3000` that serves `public/` statically and routes `/api/*` to the same handler files Vercel uses in production; no separate build step, no `vercel dev` required. Point `DATABASE_URL` at a database of your own, never one with real data.

### Development

```bash
npm ci
npm test
```

`npm run build:vault` validates the committed shell and accepts `--target` for tests. Outside services that feed cards in (currently GitHub Issues) are integrations; [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) covers how they work and how to add one. See [.env.example](.env.example) and [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) for what each environment variable does.

`npm test` covers the build; the actual test suite (`tests/unit/` offline unit tests, `tests/sit/` system integration tests against a deployment) is run separately via `npm run test:lite` / `npm run test:full`; see [tests/README.md](tests/README.md) for the unit/SIT split and when to run which tier.

### Architecture

- **Frontend**: `public/vault/index.html` is a committed, hand-maintained shell (not generated from markdown or any other source), progressively enhanced with plain JS in `public/vault/assets/`.
- **Backend**: Vercel serverless functions in `api/`, consolidated per resource area to stay within Vercel's Hobby function-count limit (see `.vercelignore` and the comments in `api/vault.js` / `api/auth.js`).
- **Sign-in**: one owner with a password, set at `/setup` (see [docs/ADMIN.md](docs/ADMIN.md)).
- **Uploads**: Server-side format checks and an explicit allowlist apply to files and attachments; see [supported formats and limits](docs/UPLOADS.md).
- **Database**: Neon Postgres. Schema lives in `schema-v2.sql` and applies itself on the first request after a deploy.
- **MCP server**: `api/mcp.js` + `api/_lib/mcp-tools.js` expose every card type and feed action (snooze, pin, favorite) to any MCP-compatible AI assistant. See [docs/MCP_SERVER.md](docs/MCP_SERVER.md).

### Deployment

Deployment is GitHub-to-Vercel: pushes to the connected `main` branch create production deployments; pull requests create previews. See [DEPLOY.md](DEPLOY.md).

## Contributing

Issues are welcome; pull requests aren't accepted. See [CONTRIBUTING.md](CONTRIBUTING.md) for why, and for setting up and testing your own copy. Please also read the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Cardlake is free software under the [GNU AGPL-3.0](LICENSE). You can use, change and run it freely. If you run a modified version as a service for other people, you must offer them its source under the same license.

Cardlake™ is a trademark of the project's maintainer. The license covers the code, not the name: run your own copy as you like, but please don't offer a service to other people under the name Cardlake.

Security issues: please report them privately, see [SECURITY.md](SECURITY.md).
