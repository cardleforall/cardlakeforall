"""What Claude and ChatGPT ran into driving Cardlake's MCP tools: dates,
links, checklists, Misc card nesting, pins and snoozes on finished cards,
list_feed's filters and cursors, tool titles and the ChatGPT widget's CSP.
Each scenario lives in card_input_scenarios.js and runs in its own Node
process with a fresh in-memory database (PGlite)."""
from __future__ import annotations

import subprocess
import unittest

from ._paths import ROOT

SCENARIOS = ROOT / "tests" / "unit" / "card_input_scenarios.js"
PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class CardInputTests(unittest.TestCase):
    def run_scenario(self, name: str) -> None:
        result = subprocess.run(["node", str(SCENARIOS), name], cwd=ROOT, capture_output=True, text=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_dates_are_unambiguous_or_refused(self):
        self.run_scenario("dates_are_unambiguous_or_refused")

    def test_reminder_dates_can_be_cleared_and_are_shown_plainly(self):
        self.run_scenario("reminder_dates_can_be_cleared_and_are_shown_plainly")

    def test_learning_titles_and_links_are_checked(self):
        self.run_scenario("learning_titles_and_links_are_checked")

    def test_link_subtitles_name_the_site_not_the_url(self):
        self.run_scenario("link_subtitles_name_the_site_not_the_url")

    def test_checklists_hold_real_entries_and_keep_their_ticks(self):
        self.run_scenario("checklists_hold_real_entries_and_keep_their_ticks")

    def test_misc_cards_nest_only_under_their_own_cards(self):
        self.run_scenario("misc_cards_nest_only_under_their_own_cards")

    def test_finished_cards_hold_no_pin_slot_and_cannot_be_pinned_or_snoozed(self):
        self.run_scenario("finished_cards_hold_no_pin_slot_and_cannot_be_pinned_or_snoozed")

    def test_snooze_takes_a_number_of_days(self):
        self.run_scenario("snooze_takes_a_number_of_days")

    def test_a_repeating_reminder_created_done_moves_to_its_next_occurrence(self):
        self.run_scenario("a_repeating_reminder_created_done_moves_to_its_next_occurrence")

    def test_list_feed_filters_ignore_case_and_refuse_unknown_values(self):
        self.run_scenario("list_feed_filters_ignore_case_and_refuse_unknown_values")

    def test_made_up_cursors_are_refused(self):
        self.run_scenario("made_up_cursors_are_refused")

    def test_tool_titles_and_descriptions_match_the_results(self):
        self.run_scenario("tool_titles_and_descriptions_match_the_results")

    def test_duplicate_titles_are_explained(self):
        self.run_scenario("duplicate_titles_are_explained")

    def test_chatgpt_widget_declares_a_locked_down_csp(self):
        self.run_scenario("chatgpt_widget_declares_a_locked_down_csp")


if __name__ == "__main__":
    unittest.main()
