"""Pins and snoozes exercised against real Postgres via PGlite -- see
tests/unit/pg_harness.js. Each scenario lives in feed_pin_scenarios.js and
runs in its own Node process with a fresh in-memory database."""
from __future__ import annotations

import subprocess
import unittest

from ._paths import ROOT

SCENARIOS = ROOT / "tests" / "unit" / "feed_pin_scenarios.js"
PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class FeedPinScenarioTests(unittest.TestCase):
    def run_scenario(self, name: str) -> None:
        result = subprocess.run(["node", str(SCENARIOS), name], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_snoozing_a_pinned_card_frees_its_pin_slot(self):
        self.run_scenario("snoozing_a_pinned_card_frees_its_pin_slot")

    def test_pins_stay_first_under_either_sort(self):
        self.run_scenario("pins_stay_first_under_either_sort")

    def test_a_snoozed_card_still_marked_pinned_does_not_use_a_slot(self):
        self.run_scenario("a_snoozed_card_still_marked_pinned_does_not_use_a_slot")


if __name__ == "__main__":
    unittest.main()
