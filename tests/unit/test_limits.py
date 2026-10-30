"""Usage-limit enforcement: config wiring plus the pure limits.js helpers,
exercised in isolation via a Node subprocess (no server, no database), and
the upload limits against real Postgres (PGlite, upload_cap_scenarios.js)."""
from __future__ import annotations

import subprocess
import unittest

from ._paths import API, ROOT, source


class LimitsTests(unittest.TestCase):
    def test_limits_are_configured_and_server_authoritative(self):
        env = source(ROOT / ".env.example")
        for name in (
            "CARDLE_MAX_CARDS_PER_USER", "CARDLE_MAX_TEXT_BYTES_PER_USER",
            "CARDLE_MAX_ATTACHMENTS_PER_CARD", "CARDLE_MAX_FILE_BYTES",
            "CARDLE_MAX_FILE_BYTES_PER_USER", "CARDLE_MAX_UPLOADS_PER_DAY",
            "CARDLE_MAX_FILENAME_CHARS", "CARDLE_MAX_TITLE_CHARS",
            "CARDLE_MAX_CONTENT_CHARS", "CARDLE_MAX_WORK_ITEMS",
            "CARDLE_MAX_JSON_BODY_BYTES", "CARDLE_BLOB_STORAGE_ALERT_BYTES",
            "CARDLE_BLOB_STORAGE_HARD_LIMIT_BYTES",
        ):
            self.assertIn(name, env)

        limits = source(API / "_lib" / "limits.js")
        resources = source(API / "_lib" / "resources.js")
        feed = source(API / "feed.js")
        mcp = source(API / "_lib" / "mcp-tools.js")
        self.assertIn("assertCardCreateAllowed", limits)
        self.assertIn("assertUploadAllowed", limits)
        self.assertIn("assertCardCreateAllowed(sql, tenant, config.feedType, values)", resources)
        self.assertIn("assertCardUpdateAllowed(sql, tenant, config.feedType, id, values)", resources)
        self.assertIn("assertUploadAllowed(sql, tenant", feed)
        self.assertIn("assertCardCreateAllowed(sql, tenant, config.feedType, values)", mcp)

    def test_limit_helpers_and_error_responses_have_a_stable_contract(self):
        script = r'''
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const { limits, LimitError, assertInputLimits, textBytesForCard } = require('./api/_lib/limits');
const { sendError } = require('./api/_lib/http');
assert(limits.maxCardsPerUser === 500, 'default card limit should be 500');
assert(textBytesForCard('learning', { title: 'a', url: 'b', notes: 'c' }) === 3, 'text accounting should include learning fields');
let titleError;
try { assertInputLimits('reminder', { title: 'x'.repeat(limits.maxTitleChars + 1) }); } catch (error) { titleError = error; }
assert(titleError instanceof LimitError && titleError.status === 413 && titleError.code === 'TITLE_TOO_LONG', 'title cap should be a structured 413');
let workError;
try { assertInputLimits('work', { items: Array.from({ length: limits.maxWorkItems + 1 }, () => ({})) }); } catch (error) { workError = error; }
assert(workError instanceof LimitError && workError.code === 'TOO_MANY_WORK_ITEMS', 'checklist cap should be enforced');
const response = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
sendError(response, titleError);
assert(response.code === 413 && response.body.code === 'TITLE_TOO_LONG' && response.body.details.limit === limits.maxTitleChars, 'limit response should preserve safe details');
const internal = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
sendError(internal, new Error('database password leaked'));
assert(internal.code === 500 && internal.body.code === 'INTERNAL_ERROR' && !internal.body.error.includes('password'), '500 response must not leak internals');
'''
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_card_usage_query_casts_uuid_columns_before_coalescing_with_text(self):
        # Regression: talking_points.subsection_of is a uuid column (schema-v2.sql).
        # coalesce(subsection_of, '') makes Postgres unify types against the uuid
        # column and try to parse '' as a uuid, throwing
        # "invalid input syntax for type uuid: \"\"" (22P02) on every card create --
        # this broke assertCardCreateAllowed (and therefore every create endpoint)
        # in production, invisibly to the offline test suite since it never runs
        # this query against a real Postgres connection.
        limits = source(API / "_lib" / "limits.js")
        self.assertIn("coalesce(subsection_of::text, '')", limits)
        self.assertNotIn("coalesce(subsection_of, '')", limits)


if __name__ == "__main__":
    unittest.main()


PGLITE = ROOT / "node_modules" / "@electric-sql" / "pglite"


@unittest.skipUnless(PGLITE.is_dir(), "run `npm ci` to install the PGlite dev dependency")
class UploadCapScenarioTests(unittest.TestCase):
    def run_scenario(self, name: str) -> None:
        result = subprocess.run(["node", "tests/unit/upload_cap_scenarios.js", name], cwd=ROOT, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)

    def test_deleted_uploads_still_count_toward_the_daily_cap(self):
        self.run_scenario("deleted_uploads_still_count_toward_the_daily_cap")

    def test_deleted_uploads_free_their_storage(self):
        self.run_scenario("deleted_uploads_free_their_storage")
