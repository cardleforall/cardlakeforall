"""Structural contracts for schema-v2.sql: tables, columns, indexes, triggers,
and the statement splitter that applies it. Pure text/regex checks against
the SQL file plus one isolated Node snippet -- no database connection."""
from __future__ import annotations

import re
import subprocess
import unittest

from ._paths import API, ROOT, SCHEMA, source


class SchemaTests(unittest.TestCase):
    def test_v2_schema_exists_and_retains_learning_entries(self):
        text = source(SCHEMA)
        self.assertIn("create table if not exists learning_entries", text.lower())

    def test_v2_schema_creates_all_new_tables(self):
        text = source(SCHEMA).lower()
        for table in ("kanban_items", "work_items", "family_updates", "bookmarks",
                      "talking_points", "reminders", "app_config"):
            self.assertRegex(text, rf"create table if not exists {table}\s*\(")

    def test_content_tables_have_lifecycle_and_tenant_columns(self):
        text = source(SCHEMA).lower()
        for table in ("kanban_items", "work_items", "family_updates", "bookmarks",
                      "talking_points", "reminders"):
            block = re.search(rf"create table if not exists {table}\s*\((.*?)\n\);", text, re.S)
            self.assertIsNotNone(block, table)
            for column in ("id uuid primary key", "user_email text", "sort_order integer",
                           "created_at timestamptz", "updated_at timestamptz", "deleted_at timestamptz"):
                self.assertIn(column, block.group(1), f"{table}: {column}")

    def test_feed_state_schema_has_tenant_lifecycle_indexes_and_trigger(self):
        text = source(SCHEMA).lower()
        self.assertRegex(text, r"create table if not exists feed_state\s*\(")
        for column in (
            "user_email text",
            "item_type text",
            "item_id uuid",
            "dismissed_at timestamptz",
            "pinned_at timestamptz",
            "remind_later_until timestamptz",
        ):
            self.assertIn(column, text)
        self.assertIn("feed_state_item_unique", text)
        self.assertIn("feed_state_active_idx", text)
        self.assertIn("feed_state_set_updated_at", text)

    def test_users_schema_tracks_google_signins(self):
        text = source(SCHEMA).lower()
        block = re.search(r"create table if not exists users\s*\((.*?)\n\);", text, re.S)
        self.assertIsNotNone(block)
        for column in ("email text primary key", "name text", "picture_url text",
                       "created_at timestamptz", "last_login_at timestamptz"):
            self.assertIn(column, block.group(1))

    def test_aurora_review_and_open_activity_schema_are_durable_and_idempotent(self):
        text = source(SCHEMA).lower()
        self.assertIn("alter table feed_state add column if not exists reviewed_at timestamptz", text)
        activity = re.search(r"create table if not exists vault_daily_activity\s*\((.*?)\n\);", text, re.S)
        self.assertIsNotNone(activity)
        for column in ("user_email text", "activity_date date", "opened_at timestamptz", "primary key (user_email, activity_date)"):
            self.assertIn(column, activity.group(1))

    def test_schema_enforces_status_category_and_live_title_integrity(self):
        text = source(SCHEMA).lower()
        self.assertIn("status in ('backlog', 'in_progress', 'done')", text)
        self.assertIn("category in ('tech', 'business', 'personal', 'other')", text)
        for table in ("kanban_items", "work_items", "bookmarks", "talking_points", "reminders"):
            self.assertIn(f"{table}_live_title_unique", text)

    def test_schema_has_updated_at_triggers_and_active_indexes(self):
        text = source(SCHEMA).lower()
        for table in ("kanban_items", "work_items", "family_updates", "bookmarks",
                      "talking_points", "reminders"):
            self.assertIn(f"{table}_set_updated_at", text)
            self.assertIn(f"{table}_active_sort_idx", text)

    def test_attachments_schema_and_feed_upload_contract_are_universal(self):
        schema = source(SCHEMA).lower()
        block = re.search(r"create table if not exists attachments\s*\((.*?)\n\);", schema, re.S)
        self.assertIsNotNone(block)
        for column in ("id uuid primary key", "user_email text", "parent_type text not null",
                       "parent_id uuid not null", "name text not null", "mime_type text not null",
                       "byte_size integer not null", "blob_url text not null", "sort_order integer",
                       "created_at timestamptz", "updated_at timestamptz", "deleted_at timestamptz"):
            self.assertIn(column, block.group(1))
        for token in ("attachments_parent_active_idx", "attachments_set_updated_at"):
            self.assertIn(token, schema)

        feed = source(API / "feed.js").lower()
        for token in ("parent_type", "parent_id", "attachment_id", "insert into attachments",
                      "metadata.attachments", "selectattachments", "parsemultipart"):
            self.assertIn(token, feed)

    def test_purge_attachments_is_tenant_scoped(self):
        # purgeAttachments used to hardcode user_email = 'default', so deleting
        # a non-default tenant's card would silently skip cleanup and leak the
        # attachment's Blob storage forever. Both callers must pass tenant.
        attachments = source(API / "_lib" / "attachments.js")
        self.assertIn("async function purgeAttachments(sql, tenant, parentType, parentId)", attachments)
        self.assertEqual(attachments.count("user_email = ${tenant}"), 2)
        self.assertNotIn("'default'", attachments)
        self.assertIn("purgeAttachments(sql, tenant, config.feedType, id)", source(API / "_lib" / "resources.js"))
        self.assertIn("purgeAttachments(sql, tenant, itemType, id)", source(API / "feed.js"))

    def test_schema_statement_splitter_keeps_semicolons_inside_sql_comments(self):
        script = r'''
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const { splitStatements } = require('./api/_lib/schema');
const statements = splitStatements('-- A comment; this is not a statement boundary\ncreate table example (id integer);\n/* Another; comment */\ncreate function example_fn() returns void as $$ begin perform 1; end; $$ language plpgsql;');
assert(statements.length === 2, `expected 2 statements, got ${statements.length}`);
assert(statements[0].includes('create table example'), 'table statement should include its leading comment');
assert(statements[1].includes('perform 1; end;'), 'dollar-quoted function body should remain intact');
'''
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_kanban_github_integration_schema_exists(self):
        text = source(SCHEMA).lower()
        block = re.search(r"create table if not exists integrations\s*\((.*?)\n\);", text, re.S)
        self.assertIsNotNone(block)
        for column in ("provider text not null", "token text", "config jsonb",
                       "status text not null default 'disconnected'", "last_synced_at timestamptz"):
            self.assertIn(column, block.group(1))
        self.assertIn("integrations_provider_unique", text)
        self.assertIn("integrations_set_updated_at", text)
        for column in ("external_source", "external_id", "external_url", "labels"):
            self.assertIn(f"alter table kanban_items add column if not exists {column}", text)
        # Unique per tenant, not globally: two accounts may sync the same repo.
        self.assertIn("drop index if exists kanban_items_external_unique", text)
        self.assertIn("kanban_items_external_tenant_unique on kanban_items (user_email, external_source, external_id)", text)
        for column in ("onboarding_step text", "onboarded_at timestamptz", "acknowledged_at timestamptz"):
            self.assertIn(f"alter table integrations add column if not exists {column}", text)


if __name__ == "__main__":
    unittest.main()
