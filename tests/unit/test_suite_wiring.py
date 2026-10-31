"""The test suite's own wiring. unittest discovery only finds test_*.py, and
the Node files here run only when a test_*.py invokes them, so a scenario
nobody calls, or a file named so discovery skips it, passes CI by never
running. These checks make that a failure instead. Also pins what CI runs
(.github/workflows/ci.yml)."""
from __future__ import annotations

import re
import subprocess
import unittest

from ._paths import ROOT, source

UNIT = ROOT / "tests" / "unit"
SIT = ROOT / "tests" / "sit"
CI = ROOT / ".github" / "workflows" / "ci.yml"

# Shared by the Node files, not tests themselves.
NODE_HELPERS = {"pg_harness.js", "scenario_runner.js", "vercel_router.js"}
# One script a test_*.py runs whole, named for what it walks through.
NODE_SCRIPTS = {"owner_journey.js"}
PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"


def python_tests() -> str:
    return "\n".join(source(path) for directory in (UNIT, SIT) for path in sorted(directory.glob("test_*.py")))


class SuiteWiringTests(unittest.TestCase):
    def test_every_python_file_is_discovered_or_is_a_helper(self):
        for directory in (UNIT, SIT):
            self.assertTrue((directory / "__init__.py").is_file(), f"{directory} needs __init__.py for `-t .` discovery")
            for path in directory.glob("*.py"):
                name = path.name
                self.assertTrue(
                    name.startswith("test_") or name.startswith("_"),
                    f"{path.relative_to(ROOT)}: discovery (-p test_*.py) never runs it; name it test_*.py, or _*.py for a helper",
                )

    def test_every_node_test_file_is_run_by_a_python_test(self):
        tests = python_tests()
        for path in sorted(UNIT.glob("*.js")):
            if path.name not in NODE_HELPERS:
                self.assertTrue(path.name in tests, f"tests/unit/{path.name} is never run: call it from a test_*.py")

    def test_node_files_are_scenarios_whole_file_tests_or_helpers(self):
        for path in UNIT.glob("*.js"):
            if path.name in NODE_HELPERS or path.name in NODE_SCRIPTS:
                continue
            if path.name.endswith("_scenarios.js"):
                self.assertIn("require('./scenario_runner').runScenario(scenarios);", source(path),
                              f"{path.name}: end it with the shared runner so --list works")
            else:
                self.assertTrue(path.name.endswith(".test.js"),
                                f"{path.name}: name it *_scenarios.js (named cases) or *.test.js (one script); see tests/README.md")

    @unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
    def test_every_scenario_is_run_by_a_python_test(self):
        called = set(re.findall(r"""['"]([a-z][a-z0-9_]*)['"]""", python_tests()))
        for path in sorted(UNIT.glob("*_scenarios.js")):
            with self.subTest(path.name):
                listed = subprocess.run(["node", str(path), "--list"], cwd=ROOT, capture_output=True, text=True, timeout=60)
                self.assertEqual(listed.returncode, 0, listed.stderr)
                names = listed.stdout.split()
                self.assertTrue(names, f"{path.name} lists no scenarios")
                for name in names:
                    self.assertTrue(name in called, f"{path.name}: scenario {name} is never run by a test_*.py")

    def test_ci_installs_dependencies_then_builds_validates_and_runs_lite(self):
        ci = source(CI)
        self.assertIn("pull_request:", ci)
        steps = ["run: npm ci", "run: npm run build:vault", "run: npm run validate:vault", "run: npm run test:lite"]
        positions = [ci.find(step) for step in steps]
        self.assertNotIn(-1, positions, f"ci.yml is missing one of {steps}")
        # Without npm ci first, the PGlite-backed tests skip rather than run.
        self.assertEqual(positions, sorted(positions), "ci.yml must run these steps in this order")

    def test_ci_never_runs_the_system_tests(self):
        # The validate job has no SYNC_TOKEN and no deployment of its own;
        # system tests are run by hand against a test deployment.
        ci = source(CI)
        self.assertNotIn("tests/sit", ci)
        self.assertNotIn("test:full", ci)
        self.assertNotIn("SYNC_TOKEN", ci)


if __name__ == "__main__":
    unittest.main()
