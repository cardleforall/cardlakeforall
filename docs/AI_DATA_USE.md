# AI data use policy

How Cardlake uses AI today, and what any AI feature added to its code must
respect. The privacy page (`public/privacy.html`) says the same for owners.

## Current state

Cardlake does not currently operate its own model, call a model provider from
the Cardlake server, or use private card content to train a model shared across
accounts. Users may connect an external assistant through MCP. In that flow,
the user selects and directs the assistant, and the assistant's provider
receives the tool arguments and results needed to answer the user.

The feed's **AI** sort (`api/_lib/feed-ranking.js`) is a fixed scoring rule
run on Cardlake's own server over one account's cards: due dates, statuses,
dates added and likes. It calls no model or provider, reads no card text and
does not learn from activity; **Date added** turns it off. Learning its
weights from `user_events` would change that, so it would need a clear notice
and a way to turn it off before it ships.

`user_events` contains interaction signals for feed ranking, kept in the
owner's own database. It excludes card free text except for disclosed
search queries and is deleted after 24 months.

## Never

- Card content is never used to train a model, and Cardlake sends nothing to
  the people who make it.
- Anything added later that sends card content to a model provider must be
  off by default, named on the privacy page and in `docs/SUBPROCESSORS.md`,
  and easy to turn off.
