import subprocess
import unittest
from ._paths import ROOT


class MigrateTests(unittest.TestCase):
    def run_scenario(self, name):
        result = subprocess.run(['node', 'tests/unit/migrate_scenarios.js', name], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_no_session_can_migrate_only_the_sync_token(self):
        # Sign-up is open: a session proves only that someone has a Google
        # account, so it must never be enough to run DDL on production.
        self.run_scenario('sessions_cannot_migrate')

    def test_sync_token_applies_the_schema_and_never_seeds(self):
        self.run_scenario('sync_token_applies_schema_only')
