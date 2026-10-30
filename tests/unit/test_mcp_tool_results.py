"""What MCP tool calls return: structured results alongside the text, and
output schemas that accept real data. Each scenario lives in
mcp_scenarios.js and runs in its own Node process with a fresh in-memory
database (PGlite), through the real MCP server and SDK client -- nothing
touches the network or the shared DATABASE_URL."""
from __future__ import annotations

import subprocess
import unittest

from ._paths import ROOT

SCENARIOS = ROOT / "tests" / "unit" / "mcp_scenarios.js"
PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class McpToolResultTests(unittest.TestCase):
    def run_scenario(self, name: str) -> None:
        result = subprocess.run(["node", str(SCENARIOS), name], cwd=ROOT, capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_public_tools_keep_their_names_and_required_arguments(self):
        self.run_scenario("public_tools_keep_their_names_and_required_arguments")

    def test_every_successful_result_carries_matching_structured_content(self):
        self.run_scenario("every_successful_result_carries_matching_structured_content")

    def test_list_feed_sorts_by_ai_unless_asked_for_newest(self):
        self.run_scenario("list_feed_sorts_by_ai_unless_asked_for_newest")

    def test_failed_results_have_no_structured_content(self):
        self.run_scenario("failed_results_have_no_structured_content")

    def test_output_schemas_accept_real_results(self):
        self.run_scenario("output_schemas_accept_real_results")

    def test_search_cards_finds_cards_by_their_words(self):
        self.run_scenario("search_cards_finds_cards_by_their_words")

    def test_search_cards_filters_pages_and_validates(self):
        self.run_scenario("search_cards_filters_pages_and_validates")

    def test_search_and_get_card_never_show_hidden_cards(self):
        self.run_scenario("search_and_get_card_never_show_hidden_cards")

    def test_get_card_returns_one_card_with_its_state(self):
        self.run_scenario("get_card_returns_one_card_with_its_state")

    def test_file_cards_never_expose_the_storage_url(self):
        self.run_scenario("file_cards_never_expose_the_storage_url")

    def test_results_carry_no_account_email_or_bookkeeping(self):
        self.run_scenario("results_carry_no_account_email_or_bookkeeping")

    def test_reminder_tools_support_recurrence(self):
        self.run_scenario("reminder_tools_support_recurrence")
