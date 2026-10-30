"""An owner's whole path through a fresh deployment, over real HTTP and
through vercel.json's routing: setup, cards, Connect AI, Claude's OAuth,
the sync token, sign out everywhere. The scenario is owner_journey.js; the
routing stand-in is vercel_router.js."""
from __future__ import annotations

import subprocess
import unittest

from ._paths import ROOT

PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"
SCENARIO = ROOT / "tests" / "unit" / "owner_journey.js"

ROUTER_CHECK = r"""
const assert = require('assert/strict');
const { deployedFunctions, rewrites, sourceToRegExp } = require('./tests/unit/vercel_router');
const fs = require('fs');
const functions = deployedFunctions();
// Every rewrite lands on a deployed function or a real public file, and the
// local-dev copies under .vercelignore'd folders are not deployed.
for (const { destination } of rewrites()) {
  const pathname = new URL(destination.replace(/:(\w+)/g, 'x'), 'http://h').pathname;
  const ok = functions.has(pathname) || fs.existsSync(`public${pathname}`);
  assert.ok(ok, `${destination} reaches nothing`);
}
assert.ok(!functions.has('/api/auth/setup'), 'api/auth/** is local-dev only');
assert.ok(functions.has('/api/auth'));
const id = sourceToRegExp('/api/:resource(bookmarks|work)/:id');
assert.deepEqual({ ...id.exec('/api/work/42').groups }, { resource: 'work', id: '42' });
assert.equal(id.exec('/api/admin/42'), null);
"""


class OwnerJourneyTests(unittest.TestCase):
    def test_every_rewrite_reaches_something_deployed(self):
        result = subprocess.run(["node", "-e", ROUTER_CHECK], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    @unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
    def test_an_owner_uses_a_fresh_deployment_end_to_end(self):
        result = subprocess.run(["node", str(SCENARIO)], cwd=ROOT, capture_output=True, text=True, timeout=240)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)


if __name__ == "__main__":
    unittest.main()
