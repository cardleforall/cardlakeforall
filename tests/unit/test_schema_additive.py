"""schema-v2.sql stays additive and safe to re-run. Every deployment applies
it by itself whenever it changes (api/_lib/schema.js), on databases full of
someone's cards, with nobody watching, so it must never drop or rename
anything and re-running it must keep every row."""
from __future__ import annotations

import re
import subprocess
import unittest

from ._paths import ROOT, SCHEMA, source

PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"

# The data fix-ups the schema already runs, each guarded to touch only rows
# that are wrong (or, for the update, only rows from an older layout). A new
# one is a deliberate change to this list.
ALLOWED_FIXUPS = {
    "update integrations set provider = 'github_issues', config = config - 'source', onboarded_at = coalesce(onboarded_at, connected_at) where (provider = 'github' or (provider = 'kanban' and config->>'source' = 'github')) and not exists (select 1 from integrations g where g.user_email = integrations.user_email and g.provider = 'github_issues')",
    "delete from integrations where provider = 'kanban' and config->>'source' = 'native'",
    "delete from integrations where user_email = 'default'",
}
# Replaced by a tenant-scoped index created right after it.
ALLOWED_INDEX_DROPS = {"kanban_items_external_unique"}


def statements() -> list[str]:
    text = re.sub(r"--[^\n]*", "", source(SCHEMA))
    return [" ".join(part.split()) for part in text.split(";") if part.strip()]


class SchemaIsAdditiveTests(unittest.TestCase):
    def test_creates_exactly_the_tables_cardlake_uses(self):
        # A new table is a deliberate change: add it here in the same commit.
        created = set(re.findall(r"create table if not exists (\w+)", source(SCHEMA)))
        self.assertEqual(created, {
            "api_tokens", "app_config", "attachments", "bookmarks", "family_updates", "feed_state",
            "files", "instance_secrets", "integrations", "kanban_items", "learning_entries",
            "oauth_authorization_codes", "oauth_refresh_tokens", "reminders", "surprise_deals",
            "surprise_pool", "surprise_sources", "talking_points", "user_events", "users",
            "vault_daily_activity", "work_items",
        })

    def test_nothing_is_dropped_renamed_or_retyped(self):
        destructive = re.compile(
            r"\bdrop\s+(table|column|schema|view|function|type|sequence|constraint)\b"
            r"|\brename\b|\btruncate\b|\balter\s+column\b.*\b(type|drop)\b|\bdrop\s+(not\s+null|default)\b",
            re.IGNORECASE)
        offenders = [s for s in statements() if destructive.search(s)]
        self.assertEqual(offenders, [])

    def test_every_create_and_add_is_safe_to_repeat(self):
        for statement in statements():
            lowered = statement.lower()
            with self.subTest(statement=statement[:80]):
                if re.match(r"create (unique )?index", lowered):
                    self.assertIn("if not exists", lowered)
                elif lowered.startswith("create table"):
                    self.assertIn("if not exists", lowered)
                elif lowered.startswith("alter table") and " add " in lowered:
                    self.assertRegex(lowered, r"add (column|constraint)? ?if not exists|add column if not exists")
                elif lowered.startswith("drop trigger"):
                    self.assertIn("if exists", lowered)
                elif lowered.startswith("drop index"):
                    name = re.search(r"drop index if exists (\w+)", lowered)
                    self.assertTrue(name and name.group(1) in ALLOWED_INDEX_DROPS, statement)

    def test_data_fixups_are_the_known_guarded_ones(self):
        fixups = {s for s in statements() if s.lower().startswith(("delete ", "truncate", "update "))}
        self.assertEqual(fixups, ALLOWED_FIXUPS)

    @unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
    def test_reapplying_keeps_the_owner_and_their_cards(self):
        script = r"""
const assert = require('assert/strict');
const { createTestDb } = require('./tests/unit/pg_harness');
const schema = require('./api/_lib/schema');
(async () => {
  const { sql } = await createTestDb();
  await sql("insert into app_config (key, value) values ('instance_owner', '{\"email\": \"olive@example.test\"}'::jsonb)");
  await sql("insert into users (email, name, password_hash) values ('olive@example.test', 'Olive', '$2a$10$hash')");
  await sql("insert into reminders (user_email, title) values ('olive@example.test', 'Keep me')");
  await sql("insert into bookmarks (user_email, title, url) values ('olive@example.test', 'Keep me too', 'https://example.test')");
  await sql("insert into api_tokens (user_email, token_hash, label) values ('olive@example.test', 'hash', 'Claude')");
  const before = await sql("select (select count(*) from reminders)::int r, (select count(*) from bookmarks)::int b, (select count(*) from api_tokens)::int t, (select password_hash from users) p, (select value->>'email' from app_config where key = 'instance_owner') o");
  await schema.applySchema(sql);
  await schema.applySchema(sql);
  const after = await sql("select (select count(*) from reminders)::int r, (select count(*) from bookmarks)::int b, (select count(*) from api_tokens)::int t, (select password_hash from users) p, (select value->>'email' from app_config where key = 'instance_owner') o");
  assert.deepEqual(after, before);
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)


if __name__ == "__main__":
    unittest.main()
