-- Cardlake: additive Postgres schema, safe to re-run.
create extension if not exists pgcrypto;

create table if not exists learning_entries (
  id uuid primary key default gen_random_uuid(),
  user_email text not null default 'default',
  title text not null,
  url text,
  notes text not null default '',
  status text not null check (status in ('saved', 'watched', 'skimmed')),
  category text not null check (category in ('ai', 'others')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);
-- Existing deployments created before user_email was introduced need this
-- additive migration as well as the definition above.
alter table learning_entries add column if not exists user_email text not null default 'default';

create table if not exists kanban_items (
  id uuid primary key default gen_random_uuid(), user_email text not null default 'default',
  asin text, title text not null, status text not null default 'backlog' check (status in ('backlog', 'in_progress', 'done')),
  description text not null default '', source text, sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);
create table if not exists work_items (
  id uuid primary key default gen_random_uuid(), user_email text not null default 'default',
  title text not null, items jsonb not null default '[]'::jsonb, sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);
create table if not exists family_updates (
  id uuid primary key default gen_random_uuid(), user_email text not null default 'default',
  person text not null, content text not null, sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);
create table if not exists bookmarks (
  id uuid primary key default gen_random_uuid(), user_email text not null default 'default',
  title text not null, url text, notes text not null default '', category text not null default 'other' check (category in ('tech', 'business', 'personal', 'other')),
  sort_order integer not null default 0, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);
create table if not exists talking_points (
  id uuid primary key default gen_random_uuid(), user_email text not null default 'default',
  section_title text not null, content text not null, subsection_of uuid references talking_points(id), sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);
-- remind_at is unused: Cardlake sends no notifications, so the code neither
-- reads nor writes it. It stays because this file never drops anything.
create table if not exists reminders (
  id uuid primary key default gen_random_uuid(), user_email text not null default 'default',
  title text not null, due_date timestamptz, completed boolean not null default false, remind_at timestamptz, sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);
create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  user_email text not null default 'default',
  name text not null,
  mime_type text not null,
  byte_size integer not null,
  blob_url text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- Legacy standalone uploads remain in files. Attachments make private
-- blob uploads available as context on every card type.
create table if not exists attachments (
  id uuid primary key default gen_random_uuid(),
  user_email text not null default 'default',
  parent_type text not null,
  parent_id uuid not null,
  name text not null,
  mime_type text not null,
  byte_size integer not null,
  blob_url text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists app_config (
  id uuid primary key default gen_random_uuid(), user_email text not null default 'default',
  key text not null unique, value jsonb not null default '{}'::jsonb, sort_order integer not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz
);
-- Per-user presentation state for the cross-resource dashboard feed. Content
-- remains in its source table. Dismissal only removes it from this timeline.
create table if not exists feed_state (
  id uuid primary key default gen_random_uuid(),
  user_email text not null default 'default',
  item_type text not null,
  item_id uuid not null,
  seen_at timestamptz,
  dismissed_at timestamptz,
  pinned_at timestamptz,
  remind_later_until timestamptz,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists feed_state_item_unique on feed_state (user_email, item_type, item_id);
create index if not exists feed_state_active_idx on feed_state (user_email, sort_order, pinned_at) where dismissed_at is null;

-- Live titles are unique per user without preventing historical soft-deleted duplicates.
create unique index if not exists kanban_items_live_title_unique on kanban_items (user_email, title) where deleted_at is null;
create unique index if not exists work_items_live_title_unique on work_items (user_email, title) where deleted_at is null;
create unique index if not exists bookmarks_live_title_unique on bookmarks (user_email, title) where deleted_at is null;
create unique index if not exists talking_points_live_title_unique on talking_points (user_email, section_title) where deleted_at is null;
create unique index if not exists reminders_live_title_unique on reminders (user_email, title) where deleted_at is null;
create unique index if not exists files_live_name_unique on files (user_email, name) where deleted_at is null;

create index if not exists kanban_items_active_sort_idx on kanban_items (user_email, status, sort_order) where deleted_at is null;
create index if not exists work_items_active_sort_idx on work_items (user_email, sort_order) where deleted_at is null;
create index if not exists family_updates_active_sort_idx on family_updates (user_email, sort_order) where deleted_at is null;
create index if not exists bookmarks_active_sort_idx on bookmarks (user_email, category, sort_order) where deleted_at is null;
create index if not exists talking_points_active_sort_idx on talking_points (user_email, sort_order) where deleted_at is null;
create index if not exists reminders_active_sort_idx on reminders (user_email, completed, due_date, sort_order) where deleted_at is null;
create index if not exists files_active_sort_idx on files (user_email, sort_order) where deleted_at is null;
create index if not exists attachments_parent_active_idx on attachments (user_email, parent_type, parent_id, sort_order) where deleted_at is null;

create or replace function set_row_updated_at() returns trigger as $$ begin new.updated_at = now(); return new; end; $$ language plpgsql;

drop trigger if exists learning_entries_set_updated_at on learning_entries;
create trigger learning_entries_set_updated_at before update on learning_entries for each row execute function set_row_updated_at();
drop trigger if exists kanban_items_set_updated_at on kanban_items;
create trigger kanban_items_set_updated_at before update on kanban_items for each row execute function set_row_updated_at();
drop trigger if exists work_items_set_updated_at on work_items;
create trigger work_items_set_updated_at before update on work_items for each row execute function set_row_updated_at();
drop trigger if exists family_updates_set_updated_at on family_updates;
create trigger family_updates_set_updated_at before update on family_updates for each row execute function set_row_updated_at();
drop trigger if exists bookmarks_set_updated_at on bookmarks;
create trigger bookmarks_set_updated_at before update on bookmarks for each row execute function set_row_updated_at();
drop trigger if exists talking_points_set_updated_at on talking_points;
create trigger talking_points_set_updated_at before update on talking_points for each row execute function set_row_updated_at();
drop trigger if exists reminders_set_updated_at on reminders;
create trigger reminders_set_updated_at before update on reminders for each row execute function set_row_updated_at();
drop trigger if exists files_set_updated_at on files;
create trigger files_set_updated_at before update on files for each row execute function set_row_updated_at();
drop trigger if exists attachments_set_updated_at on attachments;
create trigger attachments_set_updated_at before update on attachments for each row execute function set_row_updated_at();
drop trigger if exists app_config_set_updated_at on app_config;
create trigger app_config_set_updated_at before update on app_config for each row execute function set_row_updated_at();
drop trigger if exists feed_state_set_updated_at on feed_state;
create trigger feed_state_set_updated_at before update on feed_state for each row execute function set_row_updated_at();
-- Feed reactions and remind-later state are per user and use the existing feed_state primary key.
alter table feed_state add column if not exists liked_at timestamptz;
alter table feed_state add column if not exists remind_later_until timestamptz;
-- Review completion is presentation state, separate from source-resource completion.
alter table feed_state add column if not exists reviewed_at timestamptz;
create index if not exists feed_state_remind_later_idx on feed_state (user_email, remind_later_until) where remind_later_until is not null;
create index if not exists feed_state_reviewed_today_idx on feed_state (user_email, reviewed_at) where reviewed_at is not null;

-- One row per vault user/day makes opening the vault idempotent and provides a
-- small, durable basis for the Aurora streak without client-side counters.
create table if not exists vault_daily_activity (
  user_email text not null default 'default',
  activity_date date not null default current_date,
  opened_at timestamptz not null default now(),
  primary key (user_email, activity_date)
);
create index if not exists vault_daily_activity_opened_idx on vault_daily_activity (user_email, activity_date desc);

-- Kanban can be sourced from GitHub Issues instead of managed manually.
-- external_id is namespaced by external_source (e.g. "owner/repo#123") so a
-- sync can upsert idempotently without re-reading everything first.
alter table kanban_items add column if not exists external_source text;
alter table kanban_items add column if not exists external_id text;
alter table kanban_items add column if not exists external_url text;
alter table kanban_items add column if not exists labels jsonb not null default '[]'::jsonb;
create unique index if not exists kanban_items_external_unique on kanban_items (external_source, external_id) where external_id is not null;

-- Third-party connections (currently GitHub, for syncing Kanban from Issues).
create table if not exists integrations (
  id uuid primary key default gen_random_uuid(),
  user_email text not null default 'default',
  provider text not null,
  token text,
  config jsonb not null default '{}'::jsonb,
  status text not null default 'disconnected' check (status in ('disconnected', 'connected', 'error')),
  connected_at timestamptz,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists integrations_provider_unique on integrations (user_email, provider);
drop trigger if exists integrations_set_updated_at on integrations;
create trigger integrations_set_updated_at before update on integrations for each row execute function set_row_updated_at();

-- Integrations are a registry (api/_lib/integration-registry.js) of outside
-- services, each with a one-time onboarding. `provider` holds the integration
-- id ('github_issues'). An integration's cards appear in the feed only once
-- onboarded_at is set. acknowledged_at records that the user has seen the
-- "it's live" cue.
alter table integrations add column if not exists onboarding_step text;
alter table integrations add column if not exists onboarded_at timestamptz;
alter table integrations add column if not exists acknowledged_at timestamptz;

-- GitHub-synced cards are unique per tenant. The old index was global, so two
-- accounts syncing the same repo would have collided on the same issue.
drop index if exists kanban_items_external_unique;
create unique index if not exists kanban_items_external_tenant_unique on kanban_items (user_email, external_source, external_id) where external_id is not null;

-- The GitHub connection has been stored as provider 'github' (before the
-- registry) and as 'kanban' with config.source 'github' (when Kanban itself
-- was the integration). It is the 'github_issues' integration now.
update integrations
set provider = 'github_issues',
    config = config - 'source',
    onboarded_at = coalesce(onboarded_at, connected_at)
where (provider = 'github' or (provider = 'kanban' and config->>'source' = 'github'))
  and not exists (select 1 from integrations g where g.user_email = integrations.user_email and g.provider = 'github_issues');

-- A Cardlake-only ("native") Kanban board is no longer an integration: Kanban
-- cards now come only from GitHub Issues. Those boards' cards stay in
-- kanban_items, hidden from the feed rather than deleted.
delete from integrations where provider = 'kanban' and config->>'source' = 'native';

-- The shared 'default' tenant is public (every signed-out visitor reads it),
-- so it never has integrations: a row there would publish a repository's name
-- and, once synced, its issues. The API refuses to create one; this clears any
-- left from before that rule. Synced issue rows it may have stay hidden.
delete from integrations where user_email = 'default';

-- Accounts: the owner's row (see api/_lib/local-accounts.js). Every other
-- table's user_email column stays free-text with no foreign key.
create table if not exists users (
  email text primary key,
  name text,
  picture_url text,
  created_at timestamptz not null default now(),
  last_login_at timestamptz not null default now()
);
-- First-run onboarding (api/_lib/onboarding.js): when the account finished it,
-- which starter persona it picked, and the {type, id} of the sample cards that
-- persona added, so "Clear sample cards" removes only those.
alter table users add column if not exists onboarded_at timestamptz;
alter table users add column if not exists persona text;
alter table users add column if not exists sample_cards jsonb not null default '[]'::jsonb;
-- Personal access tokens: let a user (or a machine acting on their behalf,
-- e.g. the MCP server) authenticate as their own tenant without a browser
-- session cookie. Only the hash is stored -- the plaintext is shown once
-- at creation and is not retrievable again. Revoking sets revoked_at
-- rather than deleting the row, consistent with every other table's soft delete.
create table if not exists api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  token_hash text not null unique,
  label text not null default '',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists api_tokens_user_active_idx on api_tokens (user_email, created_at) where revoked_at is null;

-- One-time OAuth authorization codes for ChatGPT's MCP OAuth + PKCE flow.
-- Only code hashes are persisted; access tokens are short-lived signed values.
create table if not exists oauth_authorization_codes (
  code_hash text primary key,
  user_email text not null,
  client_id text not null,
  redirect_uri text not null,
  resource text not null,
  scope text not null,
  code_challenge text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists oauth_authorization_codes_active_idx on oauth_authorization_codes (expires_at) where used_at is null;

-- Opaque, rotating refresh tokens keep ChatGPT connected after its short-lived
-- MCP access token expires. Like authorization codes, only hashes are stored;
-- consuming a token marks it used before a replacement is returned.
create table if not exists oauth_refresh_tokens (
  token_hash text primary key,
  user_email text not null,
  client_id text not null,
  resource text not null,
  scope text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists oauth_refresh_tokens_active_idx on oauth_refresh_tokens (expires_at) where used_at is null;

-- Every user action, append-only (see api/_lib/events.js and
-- docs/USER_EVENTS.md). feed_state keeps only each card's latest state -- an
-- unlike erases the like -- so recommendations learn from this history
-- instead. Rows are never updated. item_id has no foreign key: it spans every
-- card table, and an event must outlive the card it was about.
create table if not exists user_events (
  id bigint generated always as identity primary key,
  user_email text not null,
  event_type text not null,
  source text not null default 'web',
  item_type text,
  item_id uuid,
  context jsonb not null default '{}'::jsonb,
  client_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists user_events_user_time_idx on user_events (user_email, created_at desc);
create index if not exists user_events_item_idx on user_events (user_email, item_type, item_id, created_at desc) where item_id is not null;
-- The daily clean-up deletes old events by time.
create index if not exists user_events_time_idx on user_events (created_at desc);

-- Recurring reminders: completing one moves it to its next due date instead of
-- closing it (see api/_lib/recurrence.js). Null means it happens once.
alter table reminders add column if not exists recurrence text check (recurrence in ('daily', 'weekly', 'monthly', 'yearly'));

-- "Deal me 5" (api/_lib/surprise.js). surprise_sources and surprise_pool are
-- a shared public catalog -- the newest videos and articles from the sources
-- in api/_lib/surprise-sources.js -- and hold nobody's data, so unlike every
-- other table they have no user_email. surprise_deals is per account: every
-- card dealt, so nothing is dealt twice and untouched cards can expire.
create table if not exists surprise_sources (
  id text primary key,
  checked_at timestamptz not null default 'epoch',
  ok_at timestamptz,
  last_error text
);
create table if not exists surprise_pool (
  key text primary key,
  source_id text not null,
  topic text not null,
  title text not null,
  url text not null,
  published_at timestamptz not null,
  fetched_at timestamptz not null default now()
);
create index if not exists surprise_pool_topic_idx on surprise_pool (topic, published_at desc);
create table if not exists surprise_deals (
  id bigint generated always as identity primary key,
  user_email text not null,
  deal_id uuid not null,
  item_key text not null,
  item_type text not null,
  item_id uuid not null,
  dealt_at timestamptz not null default now(),
  -- Set once the card is kept, expires, is replaced by a newer deal or was
  -- deleted; null while it is still on trial.
  settled_at timestamptz,
  outcome text
);
create unique index if not exists surprise_deals_user_key_idx on surprise_deals (user_email, item_key);
create index if not exists surprise_deals_open_idx on surprise_deals (user_email, dealt_at) where settled_at is null;
-- The topics picked for "Deal me 5" (null until first picked), and when the
-- account last dealt, which turns a double tap into one deal.
alter table users add column if not exists interests jsonb;
alter table users add column if not exists last_deal_at timestamptz;

-- Secrets a deployment generates for itself when their environment variable
-- isn't set (api/_lib/instance-secrets.js): SESSION_SECRET, SYNC_TOKEN and,
-- without SESSION_SECRET, OAUTH_SIGNING_SECRET and INTEGRATION_ENCRYPTION_KEY.
-- Only the server reads them; Connect AI shows the owner a generated SYNC_TOKEN.
create table if not exists instance_secrets (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);

-- The owner's password (api/_lib/local-accounts.js): only a bcrypt hash is
-- ever stored. The owner is recorded in app_config ('instance_owner').
alter table users add column if not exists password_hash text;
alter table users add column if not exists password_changed_at timestamptz;
-- "Sign out on all devices" (api/_lib/account-routes.js): sessions issued
-- before this time stop working (api/_lib/session-guard.js).
alter table users add column if not exists sessions_revoked_at timestamptz;
