"""Recurring reminders exercised against real Postgres via PGlite -- see
tests/unit/pg_harness.js. Each scenario lives in reminder_scenarios.js and
runs in its own Node process with a fresh in-memory database. The process
runs in a non-UTC timezone so date math can only pass if it's done in UTC."""
from __future__ import annotations

import os
import subprocess
import unittest

from ._paths import ROOT

SCENARIOS = ROOT / "tests" / "unit" / "reminder_scenarios.js"
PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class RecurringReminderScenarioTests(unittest.TestCase):
    def run_scenario(self, name: str) -> None:
        env = {**os.environ, "TZ": "Pacific/Auckland"}
        result = subprocess.run(["node", str(SCENARIOS), name], cwd=ROOT, env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_completing_a_pinned_recurring_reminder_unpins_it(self):
        self.run_scenario("completing_a_pinned_recurring_reminder_unpins_it")

    def test_recurrence_is_stored_on_create_and_defaults_to_null(self):
        self.run_scenario("recurrence_is_stored_on_create_and_defaults_to_null")

    def test_unknown_recurrence_is_rejected_and_none_clears_it(self):
        self.run_scenario("unknown_recurrence_is_rejected_and_none_clears_it")

    def test_completing_a_recurring_reminder_moves_due_forward(self):
        self.run_scenario("completing_a_recurring_reminder_moves_due_forward")

    def test_overdue_recurring_reminder_skips_missed_occurrences(self):
        self.run_scenario("overdue_recurring_reminder_skips_missed_occurrences")

    def test_monthly_and_yearly_clamp_to_the_last_day_of_the_month(self):
        self.run_scenario("monthly_and_yearly_clamp_to_the_last_day_of_the_month")

    def test_recurring_reminder_without_a_due_date_gets_one_interval_from_now(self):
        self.run_scenario("recurring_reminder_without_a_due_date_gets_one_interval_from_now")

    def test_completing_a_one_off_reminder_is_unchanged(self):
        self.run_scenario("completing_a_one_off_reminder_is_unchanged")

    def test_uncompleting_never_advances(self):
        self.run_scenario("uncompleting_never_advances")

    def test_rolled_forward_reminder_is_snoozed_until_next_due_and_says_it_repeats(self):
        self.run_scenario("rolled_forward_reminder_is_snoozed_until_next_due_and_says_it_repeats")

    def test_completing_twice_does_not_skip_an_occurrence(self):
        self.run_scenario("completing_twice_does_not_skip_an_occurrence")

    def test_a_stored_remind_at_is_ignored(self):
        self.run_scenario("a_stored_remind_at_is_ignored")

    def test_plain_reminders_work_before_the_migration(self):
        self.run_scenario("plain_reminders_work_before_the_migration")

    def test_another_account_cannot_complete_or_roll_forward_a_reminder(self):
        self.run_scenario("another_account_cannot_complete_or_roll_forward_a_reminder")

    def test_schema_adds_recurrence_and_is_safe_to_rerun(self):
        self.run_scenario("schema_adds_recurrence_and_is_safe_to_rerun")


if __name__ == "__main__":
    unittest.main()
