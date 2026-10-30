# Connecting an AI assistant to Cardlake

Cardlake has a built-in [MCP](https://modelcontextprotocol.io) server that lets an AI assistant
(Claude, ChatGPT, Gemini, or anything else that speaks MCP) read and manage your cards directly.
Ask it to add a reminder, check what's in your feed, or pull in your latest GitHub issues, and
it can just do it.

This guide is for anyone using Cardlake. If you're deploying or maintaining Cardlake itself, see
[Technical details](#technical-details) at the bottom.

## Step 1: Sign in, and generate a token if your client needs one

Claude.ai/Desktop and ChatGPT sign you in directly during Step 2. If that's what you're
connecting, skip the token and go straight there. Claude Code, Gemini, and other clients that
take a custom header need a token from here first.

1. Open your Cardlake and sign in.
2. Click **Connect AI** next to your name.
3. Give the token a name so you remember what it's for (e.g. "Claude Code") and click
   **Generate token**.
4. Copy the token immediately. It's shown to you exactly once; if you navigate away before
   copying it, you'll need to generate a new one.

Keep it as secret as a password: anyone with it can read and change your Cardlake data.

## Step 2: Connect it to your assistant

Most clients need two things:
- The server address: your Cardlake's address followed by `/api/mcp`, for example
  `https://my-cardlake.vercel.app/api/mcp` (Connect AI in the app shows yours)
- The token you just copied

Claude.ai / Claude Desktop and ChatGPT are the exception: they sign in
through your Cardlake's own OAuth screen instead, so skip the token for those
two (see below).

**Claude Code**
```bash
claude mcp add --transport http cardlake https://<your-cardlake>/api/mcp \
  --header "Authorization: Bearer YOUR_TOKEN_HERE"
```

**Claude.ai / Claude Desktop**
Settings → Connectors → Add custom connector → paste `https://<your-cardlake>/api/mcp`.
Claude opens your Cardlake's sign-in page; sign in with your email and password
and authorize access. No personal token is needed for this flow.

**ChatGPT**
Settings → Connectors (turn on Developer mode if needed) → Add connector → paste
`https://<your-cardlake>/api/mcp`. Do **not** paste a Cardlake personal token: ChatGPT
uses the OAuth sign-in screen instead. Sign in with your email and password and
authorize access. ChatGPT stores the resulting short-lived OAuth token itself.

**Gemini (CLI or app)**
Add an MCP server entry pointing at the server address, with an `Authorization: Bearer
YOUR_TOKEN_HERE` header. The exact settings screen varies by Gemini client version; check its
MCP configuration docs if you don't see this option.

## Step 3: Try it

Ask your assistant something like:
- "What's in my Cardlake feed today?"
- "Add a reminder to call the dentist tomorrow"
- "Show me my bookmarks tagged as tech"
- "Find that article about React hooks I watched last month"
- "Sync my GitHub issues and tell me what's assigned to me"

It only sees and changes *your* Cardlake data, nobody else's.

## Managing your tokens

Back in the **Connect AI** panel you can see every token you've created (name, when it was
created, when it was last used) and revoke any of them. Revoking is immediate: whatever was
using that token stops working right away, no waiting required. If you're not sure whether a
token is still needed, revoking it is safe: you (or whoever set it up) can always generate a
new one.

## Cards in the chat

In assistants that support MCP Apps (Claude and ChatGPT among them), feed listings, search
results and single cards show up as Cardlake cards, with their type, title, and pinned, liked,
snoozed or done badges, instead of plain text. Each card has **Pin**, **Like**, **Remind later**
and **Delete** buttons, and its link opens in your browser. Remind later asks how long (1 day,
3 days or 1 week), and a snoozed card offers **Bring back now** instead. Delete asks you to
confirm on the card first, because a deleted card can't be restored from the app. GitHub issues
and files have no Delete button, and finished cards can't be snoozed. For anything else, like
editing, ask the assistant. Assistants without MCP Apps show the same results as text, and assistants that
can't run actions from a view show the cards without buttons.

## Ready-made prompts

Assistants that support MCP prompts (Claude Desktop, Claude Code and others) show three
commands you can pick instead of typing a request:

- **Daily review**: what's pinned, due and new today, and a short plan for the day.
- **Weekly recap**: what you added and finished this past week.
- **Find a card**: tell it what the card is about, and it finds and shows it.

They only read your cards; the assistant changes something only if you then ask it to.

## What it can't do yet

- Attaching files to a card isn't available through an AI assistant yet; do that in the web UI.
- GitHub issues are read-only in Cardlake: an assistant can list, sync, snooze, pin, and like
  them, but creating or editing an issue happens on GitHub. Connecting GitHub Issues in the first
  place is done in the web app (it needs a GitHub token).

## Scripting your Cardlake

A personal access token works from any MCP client, including your own scripts and agents. The
REST endpoints under `/api/` are the web app's own and take a session cookie, not a token, so
script against the MCP server.

### Stability

Connected assistants call these tools by name, and clients like claude.ai and ChatGPT cache the
tool list, so changes to them must not break existing callers:

- **Additive only.** New tools, new optional arguments and new result fields are fine.
- **Don't rename or remove a tool, or remove a result field,** without a deprecation first: keep
  the old one working, say in its description what replaces it, and remove it only after a notice
  period.
- **Don't make an existing tool require a new argument.** Make it optional with a sensible default.

`public_tools_keep_their_names_and_required_arguments` in `tests/unit/mcp_scenarios.js` pins
every tool's name and required arguments and fails on a breaking change. When you add a tool,
add it there too.

---

## Technical details

For whoever runs or develops this deployment.

### How it works

- **Transport**: Streamable HTTP, stateless (`sessionIdGenerator: undefined`). Each request is
  handled independently, matching how a Vercel serverless function actually runs; there's no
  warm session to reconnect to.
- **Auth**: every call, read or write, requires `Authorization: Bearer <token>`. The token is
  looked up against the `api_tokens` table (hashed, never stored in plaintext); the row's
  `user_email` becomes the tenant for that request, so every tool call is scoped to that one
  user's data. This is deliberately stricter than the rest of the API (whose `GET` endpoints are
  public), because this endpoint is reachable by third-party AI platforms, not just the app's
  own logged-in UI.
- **Tools**: one `create_<type>` / `update_<type>` / `delete_<type>` tool per resource
  (reminders, learnings, work items, family updates, bookmarks, Misc cards), plus
  `list_feed` (in the app's AI order by default, or `sort: "newest"` for date added; see
  `api/_lib/feed-ranking.js`), `search_cards` (every word of a query, over active, snoozed and finished
  cards, newest first), `get_card` (one card with its attachments and pin/like/snooze
  state), `get_dashboard_stats`, `get_account` (which account this session is signed in
  as), and feed actions (`snooze_card` for a number of `days`, 1 by default; `unsnooze_card`,
  `pin_card`, `unpin_card`, `like_card`, `unlike_card`) that apply to any card type. GitHub
  issues (card type `kanban`) come from the GitHub Issues integration, so instead of write tools
  they have `list_integrations` and `sync_github_issues` -- see
  [INTEGRATIONS.md](INTEGRATIONS.md). File attachments are not exposed via MCP yet.
- **What a client sees on connect** (`api/_lib/mcp-server.js`): server info with the title
  "Cardlake", a description, `websiteUrl` and icons served from this deployment's own address
  (`api/_lib/public-origin.js`; `public/favicon.svg`,
  `icon-192.png`, `icon-512.png`; regenerate the PNGs with `scripts/generate_icons.py`), plus
  `instructions` for the model. The instructions are the same for every account and must never
  include account data.
- **Card view (MCP Apps)** (`api/_lib/mcp-app.js`, `api/_lib/mcp-app/cards.html`): one
  resource, `ui://cardle/cards.html` (`text/html;profile=mcp-app`, spec 2026-01-26), that
  `list_feed`, `search_cards` and `get_card` point at via `_meta.ui.resourceUri`. The official
  `@modelcontextprotocol/ext-apps` helpers need MCP SDK v2, so the protocol (JSON-RPC over
  `postMessage`: `ui/initialize`, `ui/notifications/tool-result`, `ui/open-link`,
  `ui/notifications/size-changed`) is implemented directly. The view is one self-contained
  file with no network access. Its contents declare a `ui.csp` that allows no domains
  (`connectDomains` and `resourceDomains` empty), the strictest policy: without a declared CSP
  ChatGPT runs the widget with its CSP off, and its plugin review requires one. ChatGPT gets a
  second copy, `ui://cardle/cards-openai.html` (`text/html+skybridge`), with the same `ui.csp`
  plus ChatGPT's older `openai/widgetCSP` form. Work cards show their checklist.
  Card text only reaches it through `textContent`. It gets its cards from the host, never
  from the server. When the host reports `serverTools`, Pin, Like, Remind later and Delete
  buttons call `pin_card` / `unpin_card` / `like_card` / `unlike_card` / `snooze_card` (with
  `days`) / `unsnooze_card` and the card type's `delete_*` tool through the host (`tools/call`),
  the same tools the model uses (so a read-only grant gets an error on the card, not a write).
  Delete asks for confirmation on the card before it calls anything.
  After each change, if the host supports `updateModelContext`, it tells the model what changed.
  `tests/unit/mcp_view_scenarios.js` drives it as a host would. ChatGPT's Apps SDK keys off its
  own resource MIME type (`text/html+skybridge`) rather than the MCP Apps one above, so the same
  HTML is also registered as a second resource, `ui://cardle/cards-openai.html`. The three tools'
  `_meta` point `openai/outputTemplate` at that second resource, set `openai/widgetAccessible`
  (required for ChatGPT to treat the tool as eligible to render one at all) and
  `openai/toolInvocation/invoking` / `/invoked` status text. Claude keeps reading `ui.resourceUri`
  on the original resource, untouched by any of this.
- **Prompts** (`api/_lib/mcp-prompts.js`): `daily_review`, `weekly_recap`, `find_card`. They're
  plain instructions that name read tools, the same for every account (never account data),
  and are registered for every grant, read-only included.
- **What results contain**: only what the assistant asked about. `create_*` / `update_*`
  return the card without `user_email`, `sort_order`, `updated_at` or `deleted_at`; feed
  actions return `{ card_type, card_id, pinned_at, liked_at, snoozed_until }` rather than the
  `feed_state` row. `list_feed`, `search_cards` and `get_card` return cards without `sort_order` or
  `dismissed_at`, which are the web app's own sorting and hiding state. `get_account` is the one tool that reports the account email.
- **Tool annotations**: every tool sets `readOnlyHint`, `destructiveHint`, `idempotentHint` and
  `openWorldHint` (constants at the top of `api/_lib/mcp-tools.js`). Clients use them to decide
  when to confirm with the user -- `update_*` and `delete_*` are destructive (an update
  overwrites what the card held), reads are read-only. New tools
  must set them too.
- **Structured results**: every successful call returns its data twice, as JSON text (for
  older clients) and as `structuredContent`; errors stay text only. The reads,
  `sync_github_issues`, the feed actions and `delete_*` also declare an `outputSchema`
  (`create_*` / `update_*` don't yet: their rows differ per card type). The SDK and clients
  reject a result that doesn't match, so schemas require only fields that are always present
  and use `z.looseObject` -- a plain `z.object` forbids extra fields, and adding one would
  break the tool. `tests/unit/mcp_scenarios.js` runs each schema against real results.
- `search_cards` and `get_card` read through `loadVisibleCards` in `api/feed.js`, the same
  loader the feed uses, so they see exactly the cards the feed can (never another account's,
  a deleted card, or a hidden GitHub issue). `get_card` answers "Card not found" for every
  miss, so an id can't be probed.
- `delete_<type>` routes through the same "dismiss" logic the feed UI uses (clears
  likes/pins/snoozes and purges any attachments), not a bare row delete.

### Two auth mechanisms, on purpose

`/api/mcp` accepts either a personal access token or an OAuth access token
(`api/mcp.js` tries `resolveOAuthAuthorization` first, then falls back to the
`api_tokens` lookup). This isn't a legacy/primary split -- each mechanism is
the right fit for a different class of client, which is also why other
remote MCP servers (Linear, Notion, Sentry, ...) support the same two paths
rather than picking one:

- **Personal access tokens** are the default, and the only option needed by
  any client that can send a custom `Authorization` header: Claude Code,
  Gemini, scripts, `curl`, and most other MCP clients. Simpler to reason
  about, no browser redirect, works everywhere.
- **OAuth 2.1 + PKCE** exists only for connector-style clients that render
  their own "Connect" UI and cannot accept a user-supplied header at all.
  Today that's Claude.ai / Claude Desktop and ChatGPT (`api/_lib/oauth.js`
  registers both client IDs, plus Codex's loopback flow). Cardlake exposes
  OAuth 2.1 protected-resource and authorization-server metadata, uses
  authorization-code + PKCE, and signs the resulting short-lived (one-hour)
  access token; the token endpoint also issues an opaque rotating refresh
  token, so a compliant client can renew without asking the user to
  reconnect. The authorization page takes the owner's password (or their
  signed-in session), so the connecting client receives access only to the
  owner's tenant.

Neither path is a fallback for the other -- a client uses whichever one its
transport actually supports. Both resolve to the same per-tenant scoping:
personal tokens via the `api_tokens` table, OAuth tokens via the signed
grant `resolveOAuthAuthorization` decodes (`api/mcp.js`).

### Personal access tokens vs. `MCP_TOKEN`

Per-user tokens (`api_tokens` table) are the primary mechanism, generated from the "Connect AI"
panel by the signed-in owner and scoped to their own tenant automatically. `MCP_TOKEN` is a
separate, single env var that maps to the `'default'` tenant only (same role as
`SYNC_TOKEN`); it exists for backward compatibility and for machine clients that predate
per-user tokens. It's not something you'd hand out to other people; give them their own token
instead.

To rotate or remove `MCP_TOKEN` itself, update the Vercel env var (it's a **Sensitive** variable,
so generate a fresh value rather than trying to read the old one back):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Local testing

`npm run dev` serves `/api/mcp` on `http://localhost:3000/api/mcp`. Apply `schema-v2.sql` first
so the `api_tokens` table exists. You can mint a token locally with:

```bash
curl -X POST http://localhost:3000/api/auth/tokens \
  -H "X-Sync-Token: $SYNC_TOKEN" -H "Content-Type: application/json" \
  -d '{"label":"local test"}'
```

(or sign in in the browser and use the Connect AI panel), then drive the MCP
endpoint with `curl` (see the tool list via `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`)
or with [`@modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector).
