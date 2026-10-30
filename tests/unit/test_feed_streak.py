"""The Aurora streak and daily review counter exercised against real Postgres
via PGlite -- see tests/unit/pg_harness.js. Each scenario lives in
streak_scenarios.js and runs in its own Node process with a fresh in-memory
database. The process runs in America/Los_Angeles on purpose: the viewer's
timezone, not the server's or the database's, must decide what "today" is."""
from __future__ import annotations

import os
import subprocess
import unittest

from ._paths import ROOT

SCENARIOS = ROOT / "tests" / "unit" / "streak_scenarios.js"
PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class FeedStreakScenarioTests(unittest.TestCase):
    def run_scenario(self, name: str) -> None:
        env = {**os.environ, "TZ": "America/Los_Angeles"}
        result = subprocess.run(["node", str(SCENARIOS), name], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_streak_and_review_date_follow_the_viewers_timezone(self):
        self.run_scenario("streak_and_review_date_follow_the_viewers_timezone")

    def test_missing_or_unknown_timezone_falls_back_to_utc(self):
        self.run_scenario("missing_or_unknown_timezone_falls_back_to_utc")

    def test_streak_is_alive_until_the_day_ends_and_breaks_after_a_gap(self):
        self.run_scenario("streak_is_alive_until_the_day_ends_and_breaks_after_a_gap")

    def test_reviewed_today_counts_in_the_viewers_timezone(self):
        self.run_scenario("reviewed_today_counts_in_the_viewers_timezone")

    def test_only_signed_in_page_opens_record_a_streak_day(self):
        self.run_scenario("only_signed_in_page_opens_record_a_streak_day")


if __name__ == "__main__":
    unittest.main()
