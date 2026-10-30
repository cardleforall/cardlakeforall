# User events

Every action a person takes in Cardlake is recorded, append-only, in the
`user_events` table, so recommendations can learn from what people actually
do. `feed_state` holds only each card's *current* state: an unlike erases the
like there. In `user_events` both remain, in order.

The code is in `api/_lib/events.js`, and `tests/unit/test_user_events.py`
tests it.

## The table

| Column | Meaning |
|---|---|
| `user_email` | Who acted. `default` is the shared tenant, reached only by the sync token. |
| `event_type` | What happened. See the tables below. |
| `source` | `web` (the app), `mcp` (an AI client using the person's token), or `sync` (the sync token). |
| `item_type`, `item_id` | The card involved, if any. There is no foreign key, so the event outlives the card. |
| `context` | Details, at most 4 KB. For requests handled by the server it includes `method`, `path`, `status` and a few routing query keys. |
| `client_at` | When the browser says it happened (browser events only; dropped if more than a day off). |
| `created_at` | When the server stored it. |

Rows are append-only while retained: they are never updated, and the daily
retention job deletes them after 24 months. The job lives in
`api/_lib/retention.js` and matches the promise in
`public/privacy.html#retention`.
It stays in the owner's own database and orders their feed;
`public/privacy.html` ("Your activity history") tells the owner what it
records. Keep that page in step when you add an event type.

## What is never recorded

- **Request bodies.** They can carry credentials (GitHub tokens, OAuth codes).
- **Free text people type**, such as titles, notes or descriptions. Card writes
  record *which* fields changed, plus the values of category-like fields
  (`status`, `category`, `completed`, `recurrence`). The exception is search: the search
  text is recorded, because it is the query.
- **Signed-out visitors.** The demo feed never calls the API.

## Recorded by the server

`withEventLog()` is applied to every function through `withSessionGuard()`.
It records every write (`POST`/`PUT`/`PATCH`/`DELETE`) from someone signed in,
including refused ones, with their status. A handler names its action by
setting `req.cardleEvent`; any write it doesn't name is recorded as
`api.request`. The response waits for the insert, because a serverless
function may be frozen once it has answered. If recording fails, the action
still succeeds.

| Event | When |
|---|---|
| `card.create`, `card.update`, `card.delete` | A card is written from the app (every card type, including learnings and uploaded files). |
| `feed.like`, `feed.unlike`, `feed.pin`, `feed.unpin`, `feed.remind_later`, `feed.unremind_later`, `feed.dismiss` | A feed action. For `feed.dismiss`, `context.deleted` or `context.hidden` says which happened. |
| `feed.served` | A feed page was returned. `context.cards` lists `[type, id]` in the order shown, alongside the view, sort, filters, search and cursor. This records what was shown, which every later action can be compared against. |
| `attachment.add` | A file was attached to a card. |
| `learning.reorder` | Learnings were reordered. |
| `auth.setup` | First-run setup made the owner (or a reopened setup set their password again). |
| `auth.sign_in`, `auth.sign_out` | Password sign-in and sign-out. `context.method` is `password`. |
| `auth.sign_out_everywhere` | The owner signed out on all devices. |
| `onboarding.persona` | A new account picked a starter feed on the welcome page. `context.persona` names it (`empty` for none). |
| `onboarding.clear_samples` | Someone cleared the starter feed's sample cards. |
| `surprise.deal` | Someone tapped "Deal me 5". `context.topics` lists the topics dealt from, `context.topics_saved` says whether they picked new ones, and `context.count` how many cards were added. Events recorded before deals stopped replacing each other also carry `context.replaced`, how many untouched cards from the last deal were removed. |
| `mcp.<tool>` | Any MCP tool call, reads included (`source = mcp`). `context.ok` says whether it succeeded, and `context.args` lists the argument names. A successful `list_feed` or `search_cards` also lists `context.cards` as `[type, id]` in the order returned, like `feed.served`, with `view` and the list-type filters (`types`, `category`, `status`, `liked_only`, `sort`, `cursor`), never the search text. These cards were given to the assistant, which may have shown the person only some of them, so treat it as a weaker signal than `card.impression`. |
| `api.request` | Any other write, such as connecting an integration, syncing, or managing tokens. |

## Recorded by the browser

`aurora-feed.js` batches these and posts them to `POST /api/events`, flushing
every 5 seconds, after 20 events, and when the page is hidden. They cover what
only the browser can see. Anything that changes data already reaches the
server as its own request.

| Event | When | Context |
|---|---|---|
| `card.impression` | A card has been at least half on screen for one second. Once per card for each distinct feed query. | `position`, `pinned`, `view`, `sort`, `filter`, `favorites_only`, `query` |
| `card.open` | The detail view opened. | `position` plus the feed context |
| `card.close` | The detail view closed. | `dwell_ms` |
| `card.link_click` | A link on a card, or in its detail view, was followed. | `host`, `in_detail`, `position`, and `kind` for a link Cardlake adds itself rather than one in the card's content: `add_to_calendar` is a reminder's "Add to Google Calendar" |
| `feed.search` | A search was run or cleared. | `query`, `cleared` |
| `feed.filter` | A type or integration filter changed. | feed context |
| `feed.view` | Switched between the main feed, favorites and snoozed. | feed context |
| `feed.sort` | The feed's sort changed between AI and date added. | feed context (`sort` is the new order) |
| `capture.open` | The new-card sheet was opened. | `type` |
| `capture.quick_add` | A card was saved after typing in quick add. Never the text itself. | `guessed`, `saved` (card types; they differ when the person picked another type) |
| `settings.change` | A display setting was toggled. | `media_visuals` or `pinned_collapsed` |

`/api/events` accepts at most 50 events per request. It drops unknown event
types, clears malformed ids, and replaces an oversized `context` with
`{"truncated": true}`. Signed-out requests get a quiet `204`. In production the
endpoint goes through `api/vault.js` (see `vercel.json`), so it doesn't use up
one of the Hobby plan's 12 function slots.

## Example queries

```sql
-- One person's history with one card
select created_at, event_type, source, context
from user_events
where user_email = $1 and item_type = $2 and item_id = $3
order by created_at;

-- Per card type: how often a card that was shown got liked
with shown as (
  select distinct user_email, item_type, item_id from user_events where event_type = 'card.impression'
), liked as (
  select distinct user_email, item_type, item_id from user_events where event_type = 'feed.like'
)
select s.item_type, count(*) as shown, count(l.item_id) as liked
from shown s left join liked l using (user_email, item_type, item_id)
group by s.item_type;
```
