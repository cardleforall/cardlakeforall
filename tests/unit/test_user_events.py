"""The user-action log (api/_lib/events.js): every action is recorded,
append-only, for recommendations. Behavior runs against real Postgres via
PGlite (see tests/unit/pg_harness.js); each scenario lives in
events_scenarios.js and runs in its own Node process with a fresh in-memory
database."""
from __future__ import annotations

import json
import re
import subprocess
import unittest

from ._paths import API, ROOT, source

SCENARIOS = ROOT / "tests" / "unit" / "events_scenarios.js"
PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"
AURORA_FEED_JS = ROOT / "public" / "vault" / "assets" / "aurora-feed.js"


def node_json(script: str):
    result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout)


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class UserEventScenarioTests(unittest.TestCase):
    def run_scenario(self, name: str) -> None:
        result = subprocess.run(["node", str(SCENARIOS), name], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_feed_actions_keep_their_full_history(self):
        self.run_scenario("feed_actions_keep_their_full_history")

    def test_refused_actions_are_recorded_with_their_status(self):
        self.run_scenario("refused_actions_are_recorded_with_their_status")

    def test_feed_pages_served_record_what_was_shown(self):
        self.run_scenario("feed_pages_served_record_what_was_shown")

    def test_anonymous_writes_record_nothing(self):
        self.run_scenario("anonymous_writes_record_nothing")

    def test_undescribed_writes_are_recorded_without_their_body(self):
        self.run_scenario("undescribed_writes_are_recorded_without_their_body")

    def test_client_events_are_validated(self):
        self.run_scenario("client_events_are_validated")

    def test_a_failing_log_never_fails_the_action(self):
        self.run_scenario("a_failing_log_never_fails_the_action")

    def test_the_table_is_created_on_first_use(self):
        self.run_scenario("the_table_is_created_on_first_use")

    def test_mcp_tool_calls_are_recorded(self):
        self.run_scenario("mcp_tool_calls_are_recorded")

    def test_mcp_card_lists_record_the_cards_returned(self):
        self.run_scenario("mcp_card_lists_record_the_cards_returned")

    def test_stacked_wrappers_record_once(self):
        self.run_scenario("stacked_wrappers_record_once")

    def test_signing_out_is_recorded(self):
        self.run_scenario("signing_out_is_recorded")


class UserEventWiringTests(unittest.TestCase):
    def test_every_request_is_logged_through_the_session_guard(self):
        # test_integrations.py requires withSessionGuard on every deployed
        # function (and dev_server.js applies it to every route), so this one
        # line is what makes the log cover every route, including new ones.
        guard = source(API / "_lib" / "session-guard.js")
        self.assertIn("const logged = withEventLog(handler);", guard)
        self.assertIn("const result = await logged(req, res);", guard)

    def test_lazy_table_creation_matches_the_schema(self):
        ddl = node_json("console.log(JSON.stringify(require('./api/_lib/events').USER_EVENTS_DDL))")
        schema = re.sub(r"\s+", " ", source(ROOT / "schema-v2.sql"))
        for statement in ddl:
            self.assertIn(re.sub(r"\s+", " ", statement), schema)

    def test_events_endpoint_reaches_production_without_a_new_function(self):
        # Hobby allows 12 functions; the endpoint rides on api/vault.js.
        rewrites = json.loads(source(ROOT / "vercel.json"))["rewrites"]
        self.assertIn({"source": "/api/events", "destination": "/api/vault?resource=events"}, rewrites)
        self.assertIn("if (resource === 'events') return clientEventsHandler(req, res);", source(API / "vault.js"))
        self.assertIn("api/events/**", source(ROOT / ".vercelignore"))

    def test_the_demo_feed_records_nothing(self):
        js = source(AURORA_FEED_JS)
        tracker = js.split("const track = (() => {", 1)[1].split("})();", 1)[0]
        self.assertIn("if (SANDBOX) return;", tracker)

    def test_every_browser_event_type_is_sent_and_documented(self):
        types = node_json("console.log(JSON.stringify([...require('./api/_lib/events').CLIENT_EVENT_TYPES]))")
        js = source(AURORA_FEED_JS)
        docs = source(ROOT / "docs" / "USER_EVENTS.md")
        for event_type in types:
            self.assertIn(f"track('{event_type}'", js, event_type)
            self.assertIn(f"`{event_type}`", docs, event_type)


if __name__ == "__main__":
    unittest.main()
