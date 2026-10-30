# Cardlake: functional specification

What Cardlake does, for whom, and the exact rules it follows. This is written so
that someone could rebuild the product from it. How it is built lives in
[technical.md](technical.md).

Each Cardlake is a deployment that belongs to one person, its owner, who signs
in with a password. The code is open source under the
AGPL-3.0; scripts and agents also use Cardlake through its MCP API.

---

## 1. The product in one page

**One line:** a vault for reminders, learnings, work and ideas, reviewed as
one calm daily feed.

**The problem.** The things people mean to come back to (an article to read,
a call to make, a checklist for a project, something a family member said, a
GitHub issue) end up spread over a dozen apps and are never seen again.

**The idea.** Everything goes into one vault as a *card*. You scroll
one feed of those cards and decide, card by card: do it, snooze it, keep it,
or delete it. A streak rewards coming back every day.

**Why a feed, not folders:**

| Principle | What it means for the product |
|---|---|
| An open loop costs attention until it's captured somewhere trustworthy | Capture must be fast, from the web or from an AI assistant |
| One system beats seven | Every kind of thing is a card type in the same feed |
| Unreviewed things fade fast | The feed resurfaces cards; snoozed cards come back by themselves |
| Consistency compounds | Daily streak and "reviewed today" progress |

**Three ways in:**

1. **Use it directly.** The web app is the interface: capture, snooze, pin, delete.
2. **Use it through AI.** Claude, ChatGPT, Gemini or any MCP client can read
   and change your cards, with the same rules.
3. **Script it.** Scripts, jobs and agents call the MCP API with a personal
   token.

**Tone.** Calm, plain, never naggy. No red "danger" buttons on cards, no
dark patterns, no ads, no analytics or advertising trackers.

---

## 2. Who uses it

| Role | Who | What they can do |
|---|---|---|
| **Visitor** | Anyone, signed out | Sign in, or run first-run setup while nobody owns this Cardlake. Read the setup guide, privacy and support pages. |
| **Owner** | The one account, made at `/setup` | Everything in their own vault: capture, review, integrations, AI assistants. Nobody else has an account. |
| **AI assistant** | An MCP client acting for the owner | The owner's cards only, through the MCP tools (section 10). |
| **Machine** | A script holding the sync token | Writes to the separate shared `default` space only, never the owner's cards. |

Data is scoped by account (tenant) in every query: the shared `default`
space and the owner's vault never see each other's cards, files,
integrations or tokens. In this section and below, "member" means the owner.

---

## 3. Pages and surfaces

| Page | URL | Purpose |
|---|---|---|
| The vault (feed) | `/` (`/vault/`) | The app: header with streak, account chip and "Deal me 5"; the feed; capture; search; detail view; integrations; Connect AI. Signed out, it sends you to sign in, or to setup. |
| Setup | `/setup` | First-run setup: name, email, password. Open for an hour after the deployment first starts (section 7). |
| Sign in | `/signin` | Email and password. |
| Get updates | `/updates` | Turns on the Update Cardlake workflow in the owner's copy on GitHub, which the Deploy button can't copy, then links to it. Owner only. The app shows the owner **Update available**, linking here, when a newer Cardlake is out (`/api/auth/update`). |
| Welcome (onboarding) | `/welcome.html` | Pick a starter persona → connect Claude or ChatGPT → go to the feed. |
| MCP setup guide | `/mcp-setup.html` | How to connect each AI client, with this deployment's own address. |
| Privacy | `/privacy.html` | What this Cardlake stores, run by its owner (section 13). |
| Support | `/support.html` | Common problems: a forgotten password, connecting an assistant, getting updates. |
| Live demo | `/vault/sandbox.html` | A fake feed of seven sample cards that responds to delete, snooze, like and pin, entirely in the browser. |

`robots.txt` keeps crawlers out of the whole site.

The site is responsive down to phone width, with touch targets of at least
44px on mobile, visible focus outlines, and reduced motion respected.

---

## 4. Card types

Every card has a type, a title and an optional body, plus per-member *feed
state*: pinned, liked, snoozed until, reviewed at.

| Type (internal id) | Shown as | Fields | Primary button | Counts as "finished" (leaves the feed) when |
|---|---|---|---|---|
| Reminder (`reminder`) | "Reminder" | title, due date (optional), completed, repeats (never / daily / weekly / monthly / yearly) | **Complete** | completed (one-time reminders) |
| Learning (`learning`) | "Learning" | title, URL, notes, status (saved / watched / skimmed), category (ai / others) | **Mark watched** | status is watched or skimmed |
| Work (`work`) | "Work" | title, checklist of items (text + done) | Snooze | every checklist item is done (and there is at least one) |
| Family (`family`) | "Family" | person (shown as the title), update text | Snooze | never |
| Bookmark (`bookmark`) | "Bookmark" | title, URL, notes, category (tech / business / personal / other) | **Open** | never |
| Misc (`talking_point`) | "Misc" | title, notes, optional parent Misc card | Snooze | never |
| File (`file`) | "File" | an uploaded file (name, size, type) | **Open** | never |
| GitHub issue (`kanban`) | "GitHub issue" | title, body, `owner/repo#N`, status (Open / Assigned / Closed), labels, link | **Open** (on GitHub) | the issue is closed |

Rules:

- **Titles are unique per member per type** among live cards (a duplicate is
  refused with "An item with those values already exists").
- **Misc** was once called "Talking points". Nothing a person reads may say
  "talking points" any more; the internal id stays `talking_point`.
- **GitHub issues are read-only** in Cardlake. They cannot be created or edited
  by hand; they come only from the GitHub Issues integration (section 11).
- **Any card can have up to 5 file attachments** (section 6).
- Finished cards leave the feed but stay findable by search.

---

## 5. The feed

### 5.1 What is in it

The **main feed** shows every live card that is not finished, not snoozed
(or whose snooze has passed), and not hidden. Cards from an integration show
only once that integration is set up and connected.

### 5.2 Order

1. **Pinned cards first**, in a "Pinned" section that can be collapsed (the
   collapsed state is remembered in the browser). At most **3** pinned cards.
2. Then every other card, in the order the **Sort** control picks (remembered
   in the browser):
   - **AI** (the default) scores each card from its own fields and puts the
     highest first: **due and overdue reminders** most, then work under way
     (an assigned issue, a half-done checklist, a card back from snooze),
     liked cards, cards just added, and old cards worth rediscovering, plus a
     small shuffle that changes each day. Types are **mixed** so the feed
     doesn't show ten bookmarks in a row: repeating the last card's type
     costs score, and never three in a row while another type is left. Code:
     `api/_lib/feed-ranking.js`.
   - **Date added**: newest first. This is also how to turn the AI order off.
   Snoozed cards always list by when they come back.
3. Cards just added by "Deal me 5" jump to the top so they land where the
   reader is looking.

The feed loads 20 cards at a time and loads more as you scroll (infinite
scroll).

### 5.3 Views and filters

| Control | Behaviour |
|---|---|
| **Type chips** | All, then one chip per type with a count. Filters the feed to one type. |
| **Integrations chip group** | After a divider and an "INTEGRATIONS" label, one chip per integration, pinned to the right edge so it stays visible while the core chips scroll. Before setup the chip is dashed (`+ GitHub Issues`) and opens setup. |
| **Favorites** (♥ with count) | Only liked cards in the feed. |
| **Snoozed** (⏰ with count) | Only snoozed cards, soonest to return first, each with "Change" (how many days from now it comes back) and "Bring back" actions. |
| **Media** toggle | Shows or hides video/link preview images. Remembered in the browser. |
| **Search** | Every word of the query must appear (title, subtitle, body, URL, issue id, labels). Searches before paging, so older cards are found. Max 100 characters. |

### 5.4 Card actions

| Action | How | What happens |
|---|---|---|
| **Snooze** | Swipe right (on touch or mouse, threshold 90px), or a button | Card leaves the feed for **1 day**, then returns. The card's detail view sets how many days (1–365, as can an AI assistant), and the Snoozed view changes it later. Counts as reviewed today. **Unpins** the card. Finished cards can't be snoozed. |
| **Delete** | Swipe left, or a button | Card is deleted, with its likes, pin, snooze and attachments. **Undo** in the toast for 5 seconds; after that it can't be undone from the app (it is kept 90 days in case support needs to recover it, then erased). |
| **Complete** | Same gesture on a reminder | The reminder is marked completed and leaves the feed. It is kept, so an AI assistant can still find and reopen it. |
| **Remove from Cardlake** | Same gesture on a GitHub issue | The card is *hidden* from Cardlake, not deleted; the issue on GitHub is untouched and stays hidden across syncs. |
| **Done** | Same gesture on a *repeating* reminder | The reminder moves to its next occurrence and is snoozed until then (section 5.6). |
| **Undo** | The toast after Snooze, Complete, Done, Delete or Remove | Every action that takes a card out of the feed says what happened (a snooze says when the card returns) and offers Undo for 5 seconds. The change reaches the server only after that, or when another such action starts or the page is left. |
| **Like** (heart) | Tap | Toggles favorite. |
| **Pin** | Tap the pin | Pins to the top; refused with "You can only pin up to 3 cards. Unpin one first." when full. Only pins on cards in the active feed count. **Clears a snooze.** Finished cards can't be pinned. |
| **Primary** | The card's main button | Complete (reminder), Mark watched (learning), Open (bookmark, file, issue), otherwise Snooze. |
| **Open detail** | Tap the card | Full card in a dialog: body, attachments, links, and Delete / Snooze / Pin / Like (plus "Stop repeating" for repeating reminders), with a "Snooze for N days" field. |
| **Edit** | **Edit** in the detail view | The new-card fields for the card's type, filled with what it says now (title, notes, link, due date, repeat, checklist, person). Only changed fields are saved, so a reminder's time of day survives an edit that leaves the date alone, and a checklist keeps its ticks. GitHub issues (edited on GitHub) and files have no Edit. Attachments are added only when creating a card. |
| **Change** | In Snoozed | Sets how many days from now (1–365) the card comes back. |
| **Bring back** | In Snoozed | Un-snoozes now. |

All actions are **optimistic**: the card moves instantly and is put back with
a message ("Could not update card") if the server refuses. Small toasts
confirm actions ("Card added to your feed", "Back in your feed").

### 5.5 Review progress and streak

- **Reviewed today**: a progress bar of cards reviewed today (snoozed today)
  out of today's total.
- **Streak**: consecutive days on which the member opened their vault,
  counted in **their own time zone** (the browser sends it). Today counts as
  soon as the vault opens; if today has no visit yet the streak still stands
  until midnight. The streak badge (flame) shows in the header from 1 day.
  Signed-out visitors have no streak.
- **Empty feed:** "All caught up. Streak day N is locked in. Come back
  tomorrow for more." plus a "Deal me 5" offer.

### 5.6 Repeating reminders

- A reminder can repeat daily, weekly, monthly or yearly.
- Completing it (button, swipe or AI) **does not close it**: its due date
  moves to the **next occurrence after now**. Missed occurrences
  are skipped, not stacked. Jan 31 + 1 month = Feb 28/29.
- It is then snoozed until that next occurrence, so it leaves the feed until
  due again, and loses its pin.
- Completing twice in a row (a double tap, an AI retry) does not skip a second
  occurrence.
- "Stop repeating" in the detail view deletes it.
- The card subtitle reads e.g. "Due 10/04/2026 · Repeats weekly".

### 5.7 Media previews

Learnings and bookmarks with a YouTube URL show the video thumbnail with a play
badge; other links show a gradient cover with the host name. Only `https`
URLs are used. The Media toggle hides them all.

### 5.8 Quota and nudges

- When a member reaches 80% of a limit (cards, text, files): "You are nearing
  your card limit. Delete older cards or files to make room."

### 5.9 Signed-out vault

A signed-out visitor opening `/` or `/vault/` is sent to `/signin` (or to
`/setup` while nobody owns this Cardlake), which brings them back afterwards.
A session that runs out mid-action does the same.

### 5.10 Add to Google Calendar

- Cardlake sends no alerts. A reminder with a due date offers **Add to Google
  Calendar ↗**, a small faint link on its feed card and a link in its detail
  view. It opens Google Calendar's own
  new-event page in a new tab with the reminder filled in. Google sends the
  alert once the member saves the event there.
- A due date with no time becomes an all-day event; one with a time becomes a
  30-minute event at that time. A repeating reminder repeats there too
  (daily, weekly, monthly or yearly). The event's description links back to
  Cardlake.
- It's a copy, not a sync: completing, editing or deleting the reminder in
  Cardlake doesn't change the event. Cardlake never contacts Google for it and
  holds no Google calendar access (`public/vault/assets/calendar-link.js`).
- Not offered for a completed reminder, a one-time reminder already past due,
  or in the public demo.
- Clicks are recorded as `card.link_click` with `kind: add_to_calendar` (and
  `in_detail` saying which of the two links was used), to judge whether a full calendar sync is worth building.

---

## 6. Capture (New card)

The **New card** sheet (header button) offers the types a member can create:
Reminder, Learning, Work, Family, Bookmark, Misc, File (not GitHub issues).

| Type | Form fields |
|---|---|
| Reminder | What to remember; due date (optional); Repeats (Never/Daily/Weekly/Monthly/Yearly) |
| Learning | What to remember; URL (optional); notes (optional). Saved as status "saved", category "others". |
| Work | Title; checklist, one item per line |
| Family | Person; update |
| Bookmark | Title; URL (optional) |
| Misc | Title; notes |
| File | The file itself |

- **Quick add** at the top of the sheet takes plain text and fills in the
  type and fields as the member types (`public/vault/assets/smart-capture.js`):
  a link becomes a Bookmark (a Learning for video and course sites); a date
  ("tomorrow", "on 3 Nov", "in 2 weeks", "on Friday", "the 1st") or a repeat
  ("every Sunday", "monthly") becomes a Reminder with that due date and
  repeat; several short lines become a Work card with a checklist; a longer
  note becomes Misc; "Read …" or "Watch …" becomes a Learning; anything else
  becomes a Reminder. A line under the box says what it guessed. Picking a
  type keeps it, whatever is typed after. Nothing is saved until **Save card**
  (or Ctrl/Cmd+Enter). It runs on fixed rules in the browser: the text goes
  to no model or provider.
- Every type except File has an optional **attachment** field (up to 4 MB).
- **Links** must be web links (or bare addresses, made https); script and
  data links are refused. **Dates** are a calendar day or a time with its
  time-zone offset. Titles of only spaces are refused; blank checklist lines
  are dropped. Misc cards can nest only under the same member's Misc cards.
- **Switching type keeps what was typed** in fields of the same name, and keeps
  a chosen attachment.
- Field lengths follow the limits (section 12): title 200 characters, text
  50,000.
- Errors show inside the sheet ("Could not add card. Please try again.", or
  the limit message). If the card saves but the attachment fails: "Card saved,
  but the attachment was not uploaded: …".
- The sheet also offers "Not sure what to add? Deal me 5".

**Sharing from Android:** the app installed through Chrome can receive text and
web links from other apps. A link opens a pre-filled Bookmark; text without a
link opens Misc. The member reviews it and presses **Save card**; sharing alone
does not save it. Direct sharing of images, documents, audio or video is not
supported. Supported files can instead be uploaded through **New card → File**
or attached when creating another card. Guidance for the owner is on
`/support.html#android-sharing`.

**Attachments and files:** private storage; opening one streams it through the
app (never a public link). Allowed: images (JPEG, PNG, GIF, WebP), PDF, plain
text (TXT), Markdown (MD), Word (DOCX), Excel (XLSX), JSON. Audio, video and
generic binary uploads are not supported. Uploads accept one file at a time.
Default limits: 4 MiB each (shown as 4 MB in the app), 5 per card,
50 MB per member, 20 uploads per rolling 24 hours.

---

## 7. Signing in and access

- **One owner, one password.** A new deployment has no account. Until it has
  one, every page sends visitors to `/setup`, where the first person to give
  a name, email and password (10 to 72 bytes) becomes the owner. Setup is
  open for **one hour** after the database is first set up, then locks; the
  setup page says so. The owner is recorded atomically, so two people racing
  can't both win.
- **Nobody else can get an account.** There is no sign-up, invitation,
  allowlist, waitlist or admin page. A second setup is refused.
- **Signing in** is email and password at `/signin`. A wrong email and a
  wrong password get the same answer in the same time. Sign-in and setup
  are each limited to 10 tries per 15 minutes from one address.
- **Reopening setup.** `CARDLE_SETUP_OPEN=1` in Vercel reopens `/setup`. With
  the same email it replaces a forgotten password and keeps every card. With
  a different email that email becomes the owner; the previous owner's
  sessions, Connect AI tokens, assistant connections and GitHub connection
  stop working, and their cards stay in the database, out of reach.
- **Sessions** last 30 days from the last time a device used Cardlake,
  renewed at most once a day. Signing out clears the session. **Sign out on
  all devices** (About & help, two clicks) ends every session at once.
- No third-party sign-in: no page loads a script from another site to sign
  in.

---

## 8. First-run onboarding

A brand-new account with no cards is sent to `/welcome.html` after sign-in.

**Step 1: Sign in** ("Everything between your calendar and your to-do list").

**Step 2: Pick a starter feed** ("What does your week look like?"). Four
personas, each with 14–15 realistic starter cards, plus "Start empty":

| Persona | Tagline | Mix |
|---|---|---|
| The Agentic Exec | Leads a team and is all-in on GenAI. | AI talks to watch, team talking points, an AI roadmap checklist, a prompt library bookmark, gym/focus/weekly-review reminders, family plans |
| The AI Builder | Engineer shipping with agents and MCP. | Evals, agent and MCP videos, prompt caching, "Ship my first MCP server" checklist, Claude Code docs, health reminders |
| The Product Leader | PM or design lead bringing AI into the product. | AI UX videos, 1:1 talking points, discovery sprint checklist, teardown bookmarks, routines |
| The Curious Learner | Learning AI, maybe switching careers. | Beginner LLM videos, course bookmarks, portfolio project checklist, study reminders |

Each persona card shows three preview cards and a card count. Each persona also
carries three example prompts for the AI step.

Rules for starter content: nothing may read like someone else's life (no
names, weekdays, dates or one-off appointments). Reminders with a time fall due
at the next occurrence of that time **in the member's own time zone** ("Gym
7am" picked at 9am is due tomorrow at 7am). Picking is idempotent: a double
click or retry seeds once. Starter cards respect the card limit (as many as fit).

**Step 3: Connect your AI** ("Talk to your feed from Claude or ChatGPT").
Instructions per client, with the persona's example prompts. The page polls
every 4 seconds (for up to 15 minutes) and moves on when it sees the member's
assistant connect.

**Step 4: The feed**, with a banner: "Your starter feed is ready. N of these
cards are samples. Like or pin the ones you want to keep; the rest clear
themselves after two weeks, or you can clear them now." [Clear sample cards].

**Sample cards are on a 14-day trial.** A sample card the member has made their
own (edited, liked, pinned or attached a file to) is kept. The rest are removed
after 14 days, or immediately via "Clear sample cards". Existing accounts that
already have cards never see onboarding.

**Connecting from an assistant first.** The owner can connect an assistant
on the Claude/ChatGPT connect page (`/oauth/authorize`, "Connect Cardlake to
Claude"), which lists what the assistant will be able to do and signs in with
the owner's password. They may save cards from the assistant before ever
opening the vault, so the owner is offered the starter-feed step on their
first visit even if they already have cards. The step
then says "You already have N cards", offers "Go to my feed" instead of
"Start with an empty feed", and skips the connect step, since the assistant
is already connected.

---

## 9. "Deal me 5"

For a thin feed: one tap adds five fresh cards.

- **What's dealt:** four learnings (videos or articles) from the member's chosen
  topics, plus one small "thing to try" reminder.
- **Topics:** AI, Work & productivity, Science, Money, Health, History & ideas.
  The first deal asks "What are you curious about?" (pick several, or "Skip,
  surprise me" = all topics). "Change topics" is always available. Persona
  choice suggests topics.
- **Sources:** a curated list of trusted YouTube channels and blogs per topic
  (e.g. Two Minute Papers, Anthropic, Andrej Karpathy, Simon Willison;
  Veritasium, Kurzgesagt, Quanta; TED-Ed, Our World in Data…). Their newest
  items (last 90 days, no YouTube Shorts) are pulled in at most every 12 hours.
  A small evergreen list fills gaps.
- **Variety:** spread across topics, at most one item per source per deal.
- **Never the same card twice** for a member.
- **3 deals per day.** The button shows "N deals left today"; when out:
  "Come back tomorrow for more"; when every item has been seen: "You've seen
  them all. New cards soon".
- **Double-tap safe:** a second tap within 15 seconds deals nothing ("Already
  dealing your cards").
- **14-day trial**, exactly like sample cards: untouched dealt cards remove
  themselves; liked, pinned, edited or attached ones stay. A new deal adds to
  earlier deals; it never removes cards you haven't read yet.
- Respects the card limit ("Your feed is at its card limit. Delete a few cards
  to make room.").
- Shown in the header, in a "Feed feeling quiet?" prompt at the end of the
  main feed, in the empty state, and in the capture sheet.

---

## 10. AI assistants ("Connect AI")

### 10.1 Connecting

| Client | How |
|---|---|
| Claude.ai / Claude Desktop | Add custom connector `https://<your-cardlake>/api/mcp` → Cardlake's sign-in page → the owner's password → authorize. No token. |
| ChatGPT | Settings → Connectors (Developer mode) → add the same URL → same sign-in. No token. |
| Claude Code, Gemini, scripts, others | Generate a **personal access token** in the Connect AI panel, then pass it as `Authorization: Bearer …`. |

**Connect AI panel** (button next to your name): explains the above; label and
generate a token (shown **once**, with Copy buttons for the token and the server
address); list of tokens with created and last-used dates; **Revoke** (inline
confirm, effective immediately).

### 10.2 What an assistant can do

Everything a member can do in the feed, on their own cards only:

- **Read:** list the feed (with the same filters and views), search cards
  (including snoozed and finished ones, newest first), get one card, counts by
  type, which account it's signed in as, list integrations.
- **Write:** create, update and delete reminders, learnings, work items,
  family updates, bookmarks and Misc cards; snooze/unsnooze, pin/unpin,
  like/unlike any card; sync GitHub issues.
- **Can't:** attach files; create or edit GitHub issues; connect GitHub.

Rules the assistant is told: confirm with the user before deleting; at most 3
pins; resolve "tomorrow" in the user's time zone; GitHub issues are read-only.

**Ready-made prompts** (in clients that show MCP prompts): *Daily review*
(pinned, due and new today, and a short plan), *Weekly recap* (added and
finished this week by type), *Find a card* (by what it's about). They only
read; they change nothing unless asked.

**Cards in the chat:** in Claude and ChatGPT, feed, search and single-card
results render as Cardlake cards (type, title, badges for pinned/liked/snoozed/
done) with **Pin** and **Like** buttons and an "Open" link.

**Permissions:** OAuth connections can be granted read-only (`cardle.read`) or
read-write (`cardle.write`); a read-only grant simply doesn't get the write
tools. Personal tokens are full access.

---

## 11. Integrations: GitHub Issues

One integration exists; the design supports more (Linear, Jira, …).

**What the member sees:**

1. A dashed `+ GitHub Issues` chip in the Integrations group.
2. A setup sheet with progress **Intro → Connect → Done**:
   - *Intro:* "Bring your GitHub issues into your feed", three points, Get started.
   - *Connect:* repository (`owner/repo`) and a **fine-grained** personal
     access token (`github_pat_…`) scoped to that repository with
     *Issues: read-only* and *Metadata: read-only*. Link to create one, and to
     what Cardlake stores. Classic or OAuth tokens are refused ("Use a
     fine-grained personal access token… Classic tokens can reach every
     repository you have access to").
   - *Done:* "GitHub Issues is live. 7 open issues added to your feed." plus an
     unassigned / assigned / closed breakdown, "See your issues" / "Back to feed".
3. Each step is saved on the server, so leaving midway **resumes on any
   device**. Once finished, setup never shows again; after a disconnect it
   reopens at Connect.
4. A pulsing **New** tag on the chip until first used (cleared on every device).
5. **Issue cards:** "GitHub issue · acme/app#42 · Assigned", labels, and
   "Open on GitHub". Open = open and unassigned; Assigned = open with an
   assignee; Closed = closed (leaves the feed).
6. **Filtering to the integration** shows a bar with the repository, sync
   health ("Synced 4 min ago" or a needs-attention message), **Sync now**, and
   **Manage** (change repository, disconnect with inline confirm).
7. **Freshness:** when the feed loads and the last sync is over 15 minutes old,
   it syncs in the background (no scheduled job). The feed only re-renders
   afterwards if the reader is at the top with no dialog open.

**Rules:** issues sync up to 300 most recently updated (pull requests excluded);
issues that disappear from the repository are removed from the feed; synced
issues count towards card and text limits; the token is encrypted and never
shown again; connecting is limited to 10 tries per 10 minutes and syncing to 30;
the shared `default` space can never have integrations ("Sign in to connect
GitHub…").

---

## 12. Limits

Enforced by the server for every client (web, API, AI); the browser only
pre-checks for convenience. Each can be changed by configuration.

| Limit | Default | Message on hitting it |
|---|---:|---|
| Cards per member (incl. files and synced issues) | 500 | "You have reached the 500-card limit. Delete a card before adding another." |
| Stored text per member | 2 MiB | "Adding this card would exceed your text storage limit…" |
| Title / person / section title | 200 chars | "Title must be 200 characters or fewer." |
| Long text | 50,000 chars | "Text must be 50,000 characters or fewer." |
| URL and short references | 2,048 chars | |
| Work checklist items | 100 | |
| File size | 4 MiB | "Each file must be 4 MB or smaller." |
| Attachments per card | 5 | |
| File storage per member | 50 MiB | |
| Uploads per rolling 24h | 20 | |
| Request body | 256 KiB | |
| Service-wide file storage | warn at 20 GiB, stop at 30 GiB | "File uploads are temporarily unavailable while storage capacity is expanded." |
| Pins | 3 | "You can only pin up to 3 cards. Unpin one first." |
| Deals per day | 3 | |

Every limit error carries a stable code and safe usage details
(used / limit / remaining).

---

## 13. Privacy commitments (what the privacy page promises)

- **Run by its owner.** Everything stays in the owner's own Vercel and Neon
  accounts; nothing is sent to the people who make Cardlake.
- **Retention:** cards are kept until deleted; a deleted card keeps a
  deleted marker for **90 days**, then is erased with its files. Activity
  history: **24 months**. A daily job enforces this (Vercel Cron with
  `CRON_SECRET`, otherwise the app itself, at most once a day).
- **Activity history** records what the owner does (created a card, snoozed,
  liked, opened a card, followed a link, searched) to order the feed. It
  never records card text, notes or request bodies, except search text.
- **Passwords** are stored only as a bcrypt hash.
- **GitHub:** Cardlake keeps the token (encrypted), the repository name, and a
  copy of its issues. Disconnecting wipes the token.
- **AI assistants** see only what they read or write for the owner. Cardlake
  itself runs no AI model and trains nothing on the owner's cards.
- **The public demo** is a fake feed in the browser; nothing typed in it is saved.
- **Other services:** Vercel (hosting, files), Neon (database), GitHub (only
  if connected), Google Calendar only when the owner opens "Add to Google
  Calendar", and the owner's chosen AI provider.
- **Fonts are self-hosted**; no page loads Google Fonts.

---

## 14. Copy and naming rules

| Say | Don't say |
|---|---|
| Misc | Talking points |
| Delete (cards) | Dismiss |
| Remove from Cardlake (GitHub issues) | Delete (for issues) |
| Complete (reminders), Done (repeating reminders) | Delete |
| Snooze / Bring back | Remind later |
| Connect AI | API tokens |
| GitHub issue · owner/repo#N · Open/Assigned/Closed | Kanban, backlog, in progress |
| Favorites | Likes |

Plain, short sentences. Errors say what happened and what to do next.

---

## 15. Out of scope today

- Native mobile apps (the web app is mobile-friendly).
- Push or email notifications for reminders (a reminder can be copied into
  Google Calendar, which alerts; see 5.10).
- More than one account; sharing cards; teams or workspaces.
- Attachments through AI assistants.
- Integrations other than GitHub Issues.
- Undo after the 5-second toast (a deleted card stays in the database for 90 days).

---

## 16. Acceptance checklist for a rebuild

A rebuild matches Cardlake when:

1. A fresh deployment sends everyone to `/setup` for an hour; the first to
   finish it is the owner, and nobody else can make an account or sign in.
3. A new account is offered a persona; its starter cards expire in 14 days
   unless kept.
4. All seven creatable types can be captured from the web and from an AI
   assistant, with attachments from the web.
5. The feed shows pinned (≤3) first, then a type-interleaved mix, 20 at a
   time, with search, filters, favorites and snoozed views.
6. Swipe right snoozes a day; swipe left deletes (completes reminders,
   hides issues, advances repeating reminders), each with a 5-second Undo.
7. The streak counts days in the member's own time zone.
8. "Deal me 5" adds 4 learnings + 1 challenge from chosen topics, 3 times a
   day, never repeating an item.
9. GitHub Issues can be connected with a fine-grained token, syncs on demand
   and when stale, and issues are read-only.
10. Claude.ai and ChatGPT connect via OAuth; other clients via personal
    tokens; results render as cards with Pin/Like.
11. Every limit in section 12 is enforced server-side with the stated codes.
12. Replacing the owner stops the previous owner's sessions, tokens and
    integrations within 30 seconds.
13. No account can ever read or change another account's data, by any route.
