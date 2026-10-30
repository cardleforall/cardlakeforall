"""The Content-Security-Policy, sent in report-only mode (vercel.json), and
the endpoint that logs the violations browsers report (api/_lib/csp-report.js)."""
from __future__ import annotations

import json
import subprocess
import unittest

from ._paths import API, ROOT, source


def site_headers() -> dict:
    config = json.loads(source(ROOT / "vercel.json"))
    rule = next(rule for rule in config["headers"] if rule["source"] == "/(.*)")
    return {header["key"]: header["value"] for header in rule["headers"]}


class CspPolicyTests(unittest.TestCase):
    def test_policy_is_report_only_until_the_reports_are_clean(self):
        # Enforcing it is a separate, deliberate change: report-only can't
        # block anything the pages load.
        headers = site_headers()
        self.assertNotIn("Content-Security-Policy", headers)
        self.assertIn("Content-Security-Policy-Report-Only", headers)

    def test_policy_covers_what_the_pages_load_and_reports_the_rest(self):
        directives = dict(
            (part.split(" ", 1) + [""])[:2]
            for part in (p.strip() for p in site_headers()["Content-Security-Policy-Report-Only"].split(";"))
            if part
        )
        self.assertEqual(directives["default-src"], "'self'")
        # No third-party scripts, styles, frames or connections: sign-in is
        # this site's own form, and there are no analytics.
        for directive in ("script-src", "style-src", "connect-src", "frame-src"):
            self.assertNotRegex(directives[directive], r"https?://", directive)
        self.assertNotIn("unsafe-inline", directives["script-src"])
        self.assertNotIn("unsafe-eval", directives["script-src"])
        self.assertEqual(directives["frame-src"], "'self'")
        self.assertEqual(directives["frame-ancestors"], "'self'")
        self.assertEqual(directives["object-src"], "'none'")
        self.assertEqual(directives["report-uri"], "/api/csp-report")

    def test_report_route_reaches_the_vault_function(self):
        config = json.loads(source(ROOT / "vercel.json"))
        self.assertIn({"source": "/api/csp-report", "destination": "/api/vault?resource=csp-report"}, config["rewrites"])
        self.assertIn("if (resource === 'csp-report') return cspReportHandler(req, res);", source(API / "vault.js"))


class CspReportHandlerTests(unittest.TestCase):
    def test_reports_are_logged_once_without_query_strings(self):
        script = r"""
const assert = require('assert/strict');
const { cspReportHandler } = require('./api/_lib/csp-report');
const logged = [];
console.warn = line => logged.push(line);
const call = async (method, body) => {
  const res = { code: null, headers: {}, status(c) { this.code = c; return this; }, json() { return this; }, end() { return this; }, setHeader(k, v) { this.headers[k] = v; } };
  const req = { method, body, headers: {}, on() {} };
  await cspReportHandler(req, res);
  assert.equal(req.cardleEvent, false, 'reports are not activity');
  return res;
};
(async () => {
  const classic = { 'csp-report': { 'document-uri': 'https://cardlake.example/oauth/authorize?code=SECRET&state=x', 'effective-directive': 'script-src-elem', 'blocked-uri': 'inline', 'line-number': 3 } };
  assert.equal((await call('POST', classic)).code, 204);
  assert.equal((await call('POST', JSON.stringify(classic))).code, 204, 'a raw body is parsed too');
  assert.equal(logged.length, 1, 'a repeated violation is logged once');
  assert.ok(!logged[0].includes('SECRET'), logged[0]);
  assert.ok(logged[0].includes('https://cardlake.example/oauth/authorize'), logged[0]);
  assert.ok(logged[0].includes('script-src-elem'), logged[0]);
  const reportingApi = [{ type: 'csp-violation', body: { documentURL: 'https://cardlake.example/vault/', effectiveDirective: 'img-src', blockedURL: 'https://evil.example/x.png?t=1' } }];
  assert.equal((await call('POST', reportingApi)).code, 204);
  assert.equal(logged.length, 2);
  assert.ok(logged[1].includes('https://evil.example/x.png') && !logged[1].includes('t=1'), logged[1]);
  assert.equal((await call('POST', 'not json')).code, 204, 'garbage is ignored');
  assert.equal(logged.length, 2);
  const get = await call('GET');
  assert.equal(get.code, 405);
  assert.equal(get.headers.Allow, 'POST');
})().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
