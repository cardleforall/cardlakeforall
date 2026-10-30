"""The daily retention purge that keeps privacy.html's retention promises.
Behaviour runs against real Postgres via PGlite (see tests/unit/pg_harness.js);
each scenario lives in retention_scenarios.js and runs in its own Node process
with a fresh in-memory database."""
from __future__ import annotations

import json
import subprocess
import unittest

from ._paths import API, ROOT, source

SCENARIOS = ROOT / "tests" / "unit" / "retention_scenarios.js"
PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class RetentionScenarioTests(unittest.TestCase):
    def run_scenario(self, name: str) -> None:
        result = subprocess.run(["node", str(SCENARIOS), name], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_purge_deletes_only_what_is_past_its_retention_period(self):
        self.run_scenario("purge_deletes_only_what_is_past_its_retention_period")

    def test_failed_storage_deletes_are_retried_not_orphaned(self):
        self.run_scenario("failed_storage_deletes_are_retried_not_orphaned")

    def test_the_cron_endpoint_requires_the_cron_secret(self):
        self.run_scenario("the_cron_endpoint_requires_the_cron_secret")

    def test_daily_purge_runs_after_requests_without_the_cron_secret(self):
        self.run_scenario("daily_purge_runs_after_requests_without_the_cron_secret")

    def test_daily_purge_never_fails_a_request_and_defers_to_the_cron(self):
        self.run_scenario("daily_purge_never_fails_a_request_and_defers_to_the_cron")


class RetentionWiringTests(unittest.TestCase):
    def test_vercel_runs_the_purge_daily_through_the_vault_function(self):
        config = json.loads(source(ROOT / "vercel.json"))
        self.assertIn({"path": "/api/cron/purge-retention", "schedule": "0 3 * * *"}, config.get("crons", []))
        self.assertIn({"source": "/api/cron/purge-retention", "destination": "/api/vault?resource=retention"}, config["rewrites"])
        self.assertIn("if (resource === 'retention') return retentionHandler(req, res);", source(API / "vault.js"))

    def test_privacy_page_and_env_docs_describe_the_purge(self):
        privacy = source(ROOT / "public" / "privacy.html")
        self.assertNotIn("There is no automatic deletion yet", privacy)
        self.assertIn("A daily job deletes data once it's past these periods", privacy)
        self.assertIn("CRON_SECRET", source(ROOT / "docs" / "ENVIRONMENT.md"))


if __name__ == "__main__":
    unittest.main()
