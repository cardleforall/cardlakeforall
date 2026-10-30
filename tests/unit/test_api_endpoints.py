"""REST endpoint contracts: CRUD resources, the feed, kanban, dashboard
stats, and the GitHub-backed kanban integration. Static source checks plus a
couple of isolated Node subprocesses (rotation math, tenant-gating) -- no
server is started and no database is touched."""
from __future__ import annotations

import json
import re
import subprocess
import unittest

from ._paths import API, ROOT, RESOURCE_ENDPOINTS, source


class ApiEndpointTests(unittest.TestCase):
    def test_all_crud_endpoint_files_exist(self):
        for resource, (_, collection, item) in RESOURCE_ENDPOINTS.items():
            self.assertTrue((API / resource / collection).is_file(), resource)
            self.assertTrue((API / resource / item).is_file(), resource)
        self.assertTrue((API / "dashboard" / "stats.js").is_file())

    def test_collection_endpoints_support_public_get_and_authenticated_post(self):
        helper = source(API / "_lib" / "resources.js")
        self.assertIn("['GET', 'POST']", helper)
        self.assertIn("resolveViewerTenant(req)", helper)
        self.assertIn("const tenant = resolveWriterTenant(req);", helper)
        self.assertIn("if (!tenant) return res.status(401)", helper)
        configs = source(API / "_lib" / "resource-configs.js").lower()
        for resource, (table, collection, _) in RESOURCE_ENDPOINTS.items():
            self.assertIn("collection(", source(API / resource / collection), resource)
            self.assertIn(f"insert into {table}", configs, resource)

    def test_feed_endpoint_actions_and_type_mixing(self):
        self.assertTrue((API / "feed.js").is_file())
        text = source(API / "feed.js").lower()
        for token in ("next_cursor", "sortcards", "feed_state", "archived"):
            self.assertIn(token, text)
        self.assertIn("resolvewritertenant", text)
        # The AI sort still mixes card types, as the old weighted rotation did.
        script = r'''const { sortCards } = require('./api/_lib/feed-ranking');
const cards = Array.from({length: 12}, (_, i) => ({id: `r${i}`, type: 'reminder', metadata: {}, created_at: new Date().toISOString()})).concat(['learning','kanban','work'].map((type, i) => ({id: type + i, type, metadata: {}, created_at: new Date().toISOString()})));
const types = sortCards(cards, 'ai').map(x => x.type);
if (new Set(types.slice(0, 5)).size < 3) throw new Error('feed is not diverse: ' + types);
for (let i = 2; i < 5; i += 1) if (types[i] === types[i - 1] && types[i] === types[i - 2]) throw new Error('early three-card streak: ' + types);'''
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_feed_supports_remind_later_action_and_filters_snoozed_cards(self):
        text = source(API / "feed.js").lower()
        for token in (
            "remind_later_until",
            "action === 'remind_later'",
            "action === 'unremind_later'",
            "dismissed_at = null",
            "new date(card.remind_later_until) <= now",
        ):
            self.assertIn(token, text)

    def test_feed_searches_before_pagination_and_bounds_the_query(self):
        text = source(API / "feed.js")
        self.assertIn("const searchQuery =", text)
        self.assertIn("params.query.trim().slice(0, 100)", text)
        # Shared with search_cards (MCP), so both match the same card text.
        self.assertIn("function cardSearchText(card)", text)
        self.assertIn("cardSearchText(card).includes(searchQuery)", text)
        # Filtering must happen before the cursor/limit slice or a matching
        # older card would remain impossible to find.
        self.assertLess(text.index("const filteredCards"), text.index("const offset = offsetFor"))

    def test_feed_returns_backend_review_and_streak_stats_and_marks_review_actions(self):
        text = source(API / "feed.js").lower()
        for token in (
            "insert into vault_daily_activity", "on conflict (user_email, activity_date) do nothing",
            "reviewed_at", "streak_days", "reviewed_today", "total_today",
            "action === 'dismiss'", "action === 'remind_later'",
            "action === 'unremind_later'", "reviewed_at = null",
        ):
            self.assertIn(token, text)
        # dismiss now hard-deletes the item, so there is no dismissed state to undo.
        self.assertNotIn("action === 'undismiss'", text)
        like_block = re.search(r"action === 'like'.*?;", text)
        self.assertIsNotNone(like_block)
        self.assertNotIn("reviewed_at", like_block.group(0))

    def test_feed_pin_action_is_capped_and_exposes_pinned_stats(self):
        text = source(API / "feed.js")
        self.assertIn("const MAX_PINNED = 3;", text)
        pin_block = re.search(r"if \(action === 'pin'\) \{(.*?)\n  \}", text, re.S)
        self.assertIsNotNone(pin_block)
        block = pin_block.group(1)
        self.assertIn("const count = await activePinCount(sql, tenant, item_type, item_id);", block)
        self.assertIn("count >= MAX_PINNED", block)
        self.assertIn(f"You can only pin up to ${{MAX_PINNED}} cards. Unpin one first.", block)
        self.assertIn("insert into feed_state", block)
        # Only pins on cards in the active feed take a slot (the set
        # stats.pinned_cards counts), and re-pinning a pinned card must not
        # count against its own limit.
        counter = re.search(r"async function activePinCount\(.*?\n\}", text, re.S).group(0)
        self.assertIn("card.pinned_at && visibleInFeed(card)", counter)
        self.assertIn("!(card.type === item_type && card.id === item_id)", counter)
        self.assertIn("pinned_cards: pinnedCards.length", text)
        self.assertIn("max_pinned: MAX_PINNED", text)
        self.assertIn("const pinnedCards = activeCards.filter(card => card.pinned_at);", text)

    def test_item_endpoints_support_authenticated_patch_and_soft_delete(self):
        helper = source(API / "_lib" / "resources.js")
        self.assertIn("['PATCH', 'DELETE']", helper)
        self.assertIn("const tenant = resolveWriterTenant(req);", helper)
        self.assertIn("if (!tenant) return res.status(401)", helper)
        configs = source(API / "_lib" / "resource-configs.js").lower()
        for resource, (table, _, item) in RESOURCE_ENDPOINTS.items():
            self.assertIn("item(", source(API / resource / item), resource)
            self.assertIn(f"update {table}", configs, resource)
            self.assertIn("deleted_at = now()", configs, resource)

    def test_read_queries_exclude_soft_deleted_rows(self):
        configs = source(API / "_lib" / "resource-configs.js").lower()
        for _, (table, _, _) in RESOURCE_ENDPOINTS.items():
            self.assertRegex(configs, rf"select \* from {table} where deleted_at is null")

    def test_kanban_reorder_and_restore_endpoints_are_retired(self):
        # Their only client was the Kanban board page. Kanban cards are GitHub
        # issues now: GitHub orders and restores them, not Cardlake.
        self.assertFalse((API / "kanban" / "reorder.js").exists())
        self.assertFalse((API / "kanban" / "[id]" / "restore.js").exists())
        rewrites = {r["source"] for r in json.loads(source(ROOT / "vercel.json"))["rewrites"]}
        self.assertNotIn("/api/kanban/reorder", rewrites)
        self.assertNotIn("/api/kanban/:id/restore", rewrites)
        vault = source(API / "vault.js")
        self.assertNotIn("reorder", vault)
        self.assertNotIn("restore", vault)
        self.assertNotIn("function restore", source(API / "_lib" / "resources.js"))

    def test_dashboard_stats_exposes_aggregate_counts(self):
        text = source(API / "dashboard" / "stats.js").lower()
        self.assertIn("['get']", text)
        for table in ("learning_entries", "kanban_items", "work_items", "family_updates",
                      "bookmarks", "talking_points", "reminders"):
            self.assertIn(table, text)
        self.assertIn("count(*)", text)

    def test_endpoints_use_shared_neon_sql_client_not_raw_database_driver(self):
        helper = source(API / "_lib" / "resources.js")
        configs = source(API / "_lib" / "resource-configs.js")
        self.assertIn("getSql", helper)
        self.assertIn("sql`", configs)
        self.assertNotIn("pg.Client", helper + configs)

    def test_migrate_uses_the_v2_schema_tables(self):
        # /api/migrate applies schema-v2.sql through the same module the
        # request guard uses to apply it by itself.
        self.assertIn("require('./_lib/schema')", source(API / "migrate.js"))
        self.assertIn("'schema-v2.sql'", source(API / "_lib" / "schema.js"))
        text = source(ROOT / "schema-v2.sql").lower()
        for table in ("kanban_items", "work_items", "family_updates", "bookmarks",
                      "talking_points", "reminders", "app_config"):
            self.assertIn(table, text)

    def test_vault_consolidated_handler_scopes_the_production_stats_route(self):
        # api/dashboard/stats.js is excluded from deployment (.vercelignore) --
        # Vercel rewrites that route to this function inside api/vault.js
        # instead, so the tenant-scoping fix has to live here too, not just in
        # the individually-tested source file.
        text = source(API / "vault.js")
        stats_fn_block = text.split("async function getDashboardStats(sql, tenant) {", 1)[1].split("\nasync function stats", 1)[0]
        self.assertEqual(stats_fn_block.count("user_email = ${tenant}"), 7)
        stats_block = text.split("async function stats(req, res) {", 1)[1].split("\nmodule.exports", 1)[0]
        self.assertIn("resolveViewerTenant(req)", stats_block)
        self.assertIn("getDashboardStats(sql, tenant)", stats_block)

    # GitHub-backed Kanban: guided connect flow
    def test_kanban_github_integration_files_exist(self):
        for path in ("_lib/integrations.js", "_lib/github.js", "integrations/github/index.js", "integrations/github/sync.js"):
            self.assertTrue((API / path).is_file(), path)

    def test_github_integration_status_endpoint_is_public_and_never_exposes_credentials(self):
        text = source(API / "_lib" / "integration-handlers.js")
        handler = text.split("async function githubConnection(req, res) {", 1)[1].split("\nasync function githubSync", 1)[0]
        self.assertIn("['GET', 'POST', 'DELETE']", handler)
        # GET must be reachable before the auth check (it lists status, same as every other resource's GET).
        get_branch = handler.split("req.method === 'GET'", 1)[1].split("resolveWriterTenant", 1)[0]
        self.assertIn("githubIssuesView(sql, resolveViewerTenant(req))", get_branch)
        # That the token is never returned is checked behaviorally in test_integrations.py.

    def test_kanban_guard_hooks_block_writes_only_while_github_connected(self):
        configs = source(API / "_lib" / "resource-configs.js")
        self.assertIn("kanban.guardCreate", configs)
        self.assertIn("kanban.guardMutate", configs)
        # Creates are always refused (cards come from GitHub); edits of synced
        # cards go through the shared tenant-scoped rule.
        create_guard = configs.split("kanban.guardCreate = ", 1)[1].split("};", 1)[0]
        self.assertIn("'KANBAN_COMES_FROM_GITHUB'", create_guard)
        self.assertNotIn("await", create_guard)
        self.assertIn("kanbanWriteBlockReason", configs)
        # MCP offers no Kanban write tools at all (the stats count, kanban_items,
        # is fine; test_integrations.py checks the registered tool names).
        mcp = source(API / "_lib" / "mcp-tools.js")
        self.assertNotRegex(mcp, r"name: 'kanban_item'|_kanban_item'")
        for tool in ("'list_integrations'", "'sync_github_issues'"):
            self.assertIn(tool, mcp)
        helper = source(API / "_lib" / "resources.js")
        self.assertIn("config.guardCreate(req, res, sql, tenant)", helper)
        self.assertIn("config.guardMutate(req, res, id, sql, tenant)", helper)
        # The hooks are opt-in: every other resource config must be unaffected.
        for resource in ("work", "family", "bookmarks", "reminders", "talkingPoints"):
            self.assertNotIn(f"{resource}.guardCreate", configs)
            self.assertNotIn(f"{resource}.guardMutate", configs)

    # Explicit backwards-compatibility guardrails
    def test_existing_learnings_api_contract_is_unchanged(self):
        text = source(API / "learnings.js")
        self.assertIn("['GET', 'POST']", text)
        self.assertIn("learning_entries", text)
        self.assertIn("resolveWriterTenant", text)

    def test_learnings_list_handler_does_not_reference_tenant_before_declaration(self):
        # Regression: listEntries() called assertCardCreateAllowed(sql, tenant, ...)
        # using `tenant`, `title`, `url`, `notes` that were either not yet declared
        # (a `const tenant` temporal-dead-zone ReferenceError) or never declared at
        # all in that function -- a copy-paste artifact from createEntry(). This
        # threw on every GET /api/learnings request (public, unauthenticated) in
        # production. The create-time limit check belongs in createEntry(), which
        # actually has title/url/notes/tenant in scope.
        text = source(API / "learnings.js")
        list_fn = text.split("async function listEntries(req, res) {", 1)[1].split("\nasync function createEntry", 1)[0]
        self.assertNotIn("assertCardCreateAllowed", list_fn)
        create_fn = text.split("async function createEntry(req, res) {", 1)[1].split("\nmodule.exports", 1)[0]
        self.assertIn("assertCardCreateAllowed(sql, tenant, 'learning', { title, url, notes })", create_fn)
        # The limit check must run before the insert, not after.
        self.assertLess(
            create_fn.index("assertCardCreateAllowed"),
            create_fn.index("insert into learning_entries"),
        )

    def test_deployed_function_count_stays_within_vercel_hobby_limit(self):
        import fnmatch

        vercelignore = (ROOT / ".vercelignore").read_text(encoding="utf-8")
        patterns = [line.strip() for line in vercelignore.splitlines() if line.strip() and not line.startswith("#")]
        all_functions = [str(path.relative_to(API)) for path in API.rglob("*.js") if "_lib" not in path.parts]
        deployed = [
            path for path in all_functions
            if not any(fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(f"api/{path}", pattern) for pattern in patterns)
        ]
        # The Hobby plan caps a deployment at 12 Serverless Functions; a new
        # api/**/*.js file that isn't routed through vault.js + vercel.json
        # rewrites (and excluded here) breaks production deploys silently.
        self.assertLessEqual(len(deployed), 12, f"Deployed functions ({len(deployed)}) exceed the Hobby limit: {deployed}")


if __name__ == "__main__":
    unittest.main()
