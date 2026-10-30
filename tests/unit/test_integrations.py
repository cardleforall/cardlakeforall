"""The integrations foundation (registry, per-tenant state, encrypted
credentials, feed gating) exercised against real Postgres via PGlite -- see
tests/unit/pg_harness.js. Each scenario lives in integrations_scenarios.js and
runs in its own Node process with a fresh in-memory database, so nothing
touches the network or the shared DATABASE_URL."""
from __future__ import annotations

import fnmatch
import json
import subprocess
import unittest

from ._paths import API, ROOT, source

SCENARIOS = ROOT / "tests" / "unit" / "integrations_scenarios.js"
PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class IntegrationScenarioTests(unittest.TestCase):
    def run_scenario(self, name: str) -> None:
        result = subprocess.run(["node", str(SCENARIOS), name], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_migration_moves_github_connections_to_github_issues(self):
        self.run_scenario("migration_moves_github_connections_to_github_issues")

    def test_github_sync_is_isolated_per_tenant(self):
        self.run_scenario("github_sync_is_isolated_per_tenant")

    def test_github_token_is_encrypted_at_rest_and_never_returned(self):
        self.run_scenario("github_token_is_encrypted_at_rest_and_never_returned")

    def test_github_connect_rejects_malformed_repos_before_calling_github(self):
        self.run_scenario("github_connect_rejects_malformed_repos_before_calling_github")

    def test_feed_shows_github_issues_only_once_connected(self):
        self.run_scenario("feed_shows_github_issues_only_once_connected")

    def test_kanban_write_guard_is_tenant_scoped(self):
        self.run_scenario("kanban_write_guard_is_tenant_scoped")

    def test_dismissing_a_github_issue_hides_it_across_syncs(self):
        self.run_scenario("dismissing_a_github_issue_hides_it_across_syncs")

    def test_feed_actions_do_not_create_orphan_state(self):
        self.run_scenario("feed_actions_do_not_create_orphan_state")

    def test_hand_made_kanban_cards_are_refused_everywhere(self):
        self.run_scenario("hand_made_kanban_cards_are_refused_everywhere")

    def test_mcp_get_account_reports_the_authenticated_identity(self):
        self.run_scenario("mcp_get_account_reports_the_authenticated_identity")

    def test_mcp_tools_respect_oauth_scopes(self):
        self.run_scenario("mcp_tools_respect_oauth_scopes")

    def test_oauth_refresh_tokens_rotate_and_respect_account_access(self):
        self.run_scenario("oauth_refresh_tokens_rotate_and_respect_account_access")

    def test_shared_tenant_never_has_integrations(self):
        self.run_scenario("shared_tenant_never_has_integrations")

    def test_broad_github_tokens_are_refused(self):
        self.run_scenario("broad_github_tokens_are_refused")

    def test_connect_and_sync_are_rate_limited_per_source(self):
        self.run_scenario("connect_and_sync_are_rate_limited_per_source")

    def test_replacing_the_owner_revokes_tokens_and_github(self):
        self.run_scenario("replacing_the_owner_revokes_tokens_and_github")

    def test_a_replaced_owners_session_stops_working_immediately(self):
        self.run_scenario("a_replaced_owners_session_stops_working_immediately")

    def test_session_guard_fails_open_when_the_owner_is_unreadable(self):
        self.run_scenario("session_guard_fails_open_when_the_owner_is_unreadable")

    def test_dedicated_encryption_key_and_rotation(self):
        self.run_scenario("dedicated_encryption_key_and_rotation")

    def test_onboarding_flow_is_resumable_and_one_time(self):
        self.run_scenario("onboarding_flow_is_resumable_and_one_time")


class SessionGuardWiringTests(unittest.TestCase):
    """A removed account's session must stop working everywhere, so every
    function Vercel deploys has to run the revoked-session guard. Deriving the
    list from .vercelignore means a new endpoint can't quietly skip it."""

    # Deployed functions that don't read the session cookie, and why.
    EXEMPT = {
        "api/mcp.js": "bearer credentials only; re-checked with isAccountActive",
    }

    def deployed_functions(self):
        ignored = [line.strip() for line in source(ROOT / ".vercelignore").splitlines()
                   if line.strip() and not line.startswith("#")]
        for path in sorted(API.rglob("*.js")):
            rel = path.relative_to(ROOT).as_posix()
            if "/_lib/" in rel or any(fnmatch.fnmatch(rel, pattern) for pattern in ignored):
                continue
            yield rel, path

    def test_every_deployed_function_drops_revoked_sessions(self):
        deployed = dict(self.deployed_functions())
        self.assertIn("api/feed.js", deployed)
        self.assertNotIn("api/kanban/index.js", deployed)  # .vercelignore'd
        for rel, path in deployed.items():
            text = source(path)
            if rel in self.EXEMPT:
                continue
            self.assertIn("module.exports = withSessionGuard(", text, rel)

    def test_exempt_functions_really_do_not_need_the_cookie_guard(self):
        mcp = source(API / "mcp.js")
        self.assertIn("!(await isAccountActive(tenant))", mcp)

    def test_local_dev_server_applies_the_same_guard_to_every_route(self):
        self.assertIn("withSessionGuard(require(route.file))", source(ROOT / "scripts" / "dev_server.js"))


class IntegrationWiringTests(unittest.TestCase):
    def test_every_entry_point_shares_one_handler_implementation(self):
        # vault.js (production) and api/integrations/** (local dev) used to
        # hold separate copies that had already drifted. Both must now
        # delegate to api/_lib/integration-handlers.js.
        vault = source(API / "vault.js")
        for handler in ("listIntegrations", "githubConnection", "githubSync"):
            self.assertIn(handler, vault)
        for path, handler in ((API / "integrations" / "index.js", "listIntegrations"),
                              (API / "integrations" / "github" / "index.js", "githubConnection"),
                              (API / "integrations" / "github" / "sync.js", "githubSync")):
            text = source(path)
            self.assertIn("integration-handlers", text, path)
            self.assertIn(handler, text, path)
            self.assertNotIn("sql`", text, path)

    def test_list_route_is_wired_into_vercel_rewrites(self):
        rewrites = {r["source"]: r["destination"] for r in json.loads(source(ROOT / "vercel.json"))["rewrites"]}
        self.assertEqual(rewrites["/api/integrations"], "/api/vault?resource=integrations")

    def test_integrations_module_never_uses_the_shared_default_tenant(self):
        for path in (API / "_lib" / "integrations.js", API / "_lib" / "integration-handlers.js"):
            self.assertNotIn("'default'", source(path), path)

    def test_public_view_never_reads_the_token(self):
        text = source(API / "_lib" / "integrations.js")
        view_fn = text.split("function publicIntegrationView", 1)[1].split("\nfunction publicIntegrationList", 1)[0]
        self.assertNotIn("token", view_fn)


if __name__ == "__main__":
    unittest.main()
