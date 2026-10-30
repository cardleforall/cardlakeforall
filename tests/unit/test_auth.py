"""Authentication, sessions, tenant resolution, and who may sign in.
Includes isolated Node subprocesses that exercise real cookie sign/verify
and the owner check in-process -- still no server, no database, no network.
Password sign-in and setup are tested against a database in
test_password_accounts.py."""
from __future__ import annotations

import json
import subprocess
import unittest

from ._paths import API, ROOT, SCHEMA, source


class AuthTests(unittest.TestCase):
    def test_post_writes_are_runtime_auth_gated(self):
        script = r'''
const endpoints = [
  './api/kanban', './api/work', './api/family', './api/bookmarks',
  './api/reminders', './api/talking-points',
  './api/kanban/[id]', './api/work/[id]', './api/family/[id]',
  './api/bookmarks/[id]', './api/reminders/[id]', './api/talking-points/[id]',
  './api/integrations/github', './api/integrations/github/sync',
  './api/feed', './api/learnings', './api/learnings/[id]', './api/learnings/reorder'
];
const invoke = async path => {
  const handler = require(path);
  const res = { code: null, status(code) { this.code = code; return this; }, json() { return this; }, setHeader() {} };
  await handler({ method: path.endsWith('[id]') ? 'PATCH' : 'POST', headers: {}, query: { id: 'x' } }, res);
  if (res.code !== 401) throw new Error(`${path} returned ${res.code}, expected 401`);
};
Promise.all(endpoints.map(invoke)).catch(error => { console.error(error); process.exit(1); });
'''
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_tenant_resolution_routes_default_account_and_sync_sessions_correctly(self):
        # Exercises the real session cookie round-trip (sign -> parse -> verify),
        # not just source text, since this is the boundary that decides whose
        # data a request can read or write.
        script = r'''
process.env.SESSION_SECRET = 'test-secret';
process.env.SYNC_TOKEN = 'test-sync-token';
const { resolveViewerTenant, resolveWriterTenant, setSessionCookie } = require('./api/_lib/auth');
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const fakeRes = () => { const headers = {}; return { setHeader: (k, v) => { headers[k] = v; }, headers }; };
const cookieOf = res => res.headers['Set-Cookie'].split(';')[0];
const reqWithCookie = cookie => ({ headers: { cookie } });

// Anonymous: viewer falls back to the public 'default' tenant, writer is rejected.
let req = { headers: {} };
assert(resolveViewerTenant(req) === 'default', 'anonymous viewer should default');
assert(resolveWriterTenant(req) === null, 'anonymous writer should be null');

// A session cookie that is correctly signed and unexpired, but has no
// email. It must not be honored -- not as a writer to the shared 'default'
// tenant, and not as "authenticated" at all.
const crypto = require('crypto');
const { isAuthenticatedRequest } = require('./api/_lib/auth');
const legacyPayload = Buffer.from(JSON.stringify({ authenticated: true, exp: Date.now() + 86400000 })).toString('base64url');
const legacySignature = crypto.createHmac('sha256', 'test-secret').update(legacyPayload).digest('base64url');
req = reqWithCookie(`lh_session=${legacyPayload}.${legacySignature}`);
assert(resolveViewerTenant(req) === 'default', 'legacy session viewer falls back to the public view');
assert(resolveWriterTenant(req) === null, 'legacy password session must not write to default');
assert(isAuthenticatedRequest(req) === false, 'legacy password session is not authenticated');

// And no code path can mint an email-less session any more.
let threw = false;
try { setSessionCookie(fakeRes()); } catch (_) { threw = true; }
assert(threw, 'setSessionCookie without an account must refuse');

let res;
// The owner's session: both viewer and writer resolve to that account, never 'default'.
res = fakeRes();
setSessionCookie(res, { email: 'alice@example.com', name: 'Alice' });
req = reqWithCookie(cookieOf(res));
assert(resolveViewerTenant(req) === 'alice@example.com', 'viewer should be the signed-in email');
assert(resolveWriterTenant(req) === 'alice@example.com', 'writer should be the signed-in email');

// A tampered cookie (wrong signature) must not be trusted as any tenant.
req = reqWithCookie(cookieOf(res).slice(0, -1) + (cookieOf(res).endsWith('a') ? 'b' : 'a'));
assert(resolveViewerTenant(req) === 'default', 'tampered cookie viewer should fall back to default, not leak an email');
assert(resolveWriterTenant(req) === null, 'tampered cookie writer should be rejected');

// A bare machine SYNC_TOKEN (Hermes) can write as 'default' but is not a "viewer" session.
req = { headers: { 'x-sync-token': 'test-sync-token' } };
assert(resolveWriterTenant(req) === 'default', 'valid sync token should write as default');
'''
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_session_cookie_has_no_hardcoded_domain(self):
        # Regression: setSessionCookie/clearSessionCookie hardcoded
        # `Domain=.vercel.app`. Browsers refuse to store a cookie whose
        # Domain doesn't match the page's actual host, so on a custom domain
        # the cookie from a successful sign-in was silently dropped -- every
        # request still looked signed out (isDefault: true), even right after
        # signing in. A host-only cookie (no Domain attribute) works on a
        # custom domain, a *.vercel.app preview, or any future domain.
        auth = source(API / "_lib" / "auth.js")
        set_cookie_lines = [line for line in auth.splitlines() if "res.setHeader('Set-Cookie'" in line]
        self.assertEqual(len(set_cookie_lines), 2)
        for line in set_cookie_lines:
            self.assertNotIn("Domain=", line)

    def test_only_the_owner_is_ever_allowed(self):
        # One account and nobody else: no allowlist, no administrators, no
        # Google sign-in. The owner is whoever app_config records.
        access = source(API / "_lib" / "access-control.js")
        # The configuration names that went with them are guarded in
        # test_repo_hygiene.py.
        for gone in ("CARDLE_ALLOWED_EMAILS", "isAdminEmail",
                     "admitGoogleAccount", "allowed_users", "access_requests"):
            self.assertNotIn(gone, access)
        self.assertFalse((API / "auth" / "google.js").exists())
        self.assertFalse((API / "admin.js").exists())
        script = r"""
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const { assertValidEmail, isOwnerEmail, ownerEmail } = require('./api/_lib/access-control');
(async () => {
  const owned = async () => [{ value: { email: 'olive@example.test' } }];
  const unowned = async () => [];
  assert(await isOwnerEmail(owned, 'Olive@Example.test'), 'the owner, case-insensitively');
  assert(!(await isOwnerEmail(owned, 'someone@example.test')), 'nobody else');
  assert(!(await isOwnerEmail(owned, '')), 'never an empty email');
  assert(!(await isOwnerEmail(unowned, 'olive@example.test')), 'nobody before setup');
  assert((await ownerEmail(unowned)) === null);
  const missing = async () => { throw new Error('relation "app_config" does not exist'); };
  assert((await ownerEmail(missing)) === null, 'before the schema exists there is no owner');
  try { assertValidEmail('not-an-email'); throw new Error('invalid email was accepted'); }
  catch (error) { assert(error.status === 400, 'invalid email should produce a client error'); }
})().catch(error => { console.error(error); process.exit(1); });
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_auth_config_and_session_endpoints(self):
        self.assertIn("configHandler", source(API / "auth" / "config.js"))
        routes = source(API / "_lib" / "account-routes.js")
        self.assertIn("res.status(200).json({ setupNeeded });", routes)
        session = source(API / "auth" / "session.js")
        for token in ("payload.email", "isDefault: false", "isDefault: true", "getSessionPayload"):
            self.assertIn(token, session)
        self.assertNotIn("isAdmin", session)

    def test_tenant_scoped_resources_thread_a_resolved_tenant_not_the_default_literal(self):
        resources = source(API / "_lib" / "resources.js")
        for token in (
            "resolveViewerTenant(req)", "resolveWriterTenant(req)",
            "config.list(sql, tenant)", "config.create(sql, tenant, values)",
            "config.update(sql, tenant, id, values)", "config.remove(sql, tenant, id)",
        ):
            self.assertIn(token, resources)
        self.assertNotIn("requireAuth", resources)

        configs = source(API / "_lib" / "resource-configs.js")
        # Every list/create-sort-order/update/remove query for the six shared
        # resources must filter or order by user_email = tenant -- 6 resources
        # x 4 call sites = 24, plus reminders' pre-migration create and update
        # variants, the recurring roll-forward lookup and its repeat check, the
        # Misc card parent check and the work checklist's tick lookup = 30.
        self.assertEqual(configs.count("user_email = ${tenant}"), 30)
        self.assertNotIn("'default'", configs)

        # feed.js keeps exactly one 'default' literal: the vault_daily_activity
        # column's own DDL default (`user_email text not null default 'default'`),
        # which is schema shorthand, not a query parameter. The GitHub
        # integration used to be the one deliberate exception (a single shared
        # connection); it is per-tenant now, so vault.js has none either.
        allowed_default_literals = {API / "feed.js": 1}
        for path in (API / "feed.js", API / "learnings.js", API / "learnings" / "[id].js",
                     API / "learnings" / "reorder.js", API / "dashboard" / "stats.js",
                     API / "sync" / "markdown.js", API / "vault.js"):
            text = source(path)
            self.assertTrue("resolveViewerTenant" in text or "resolveWriterTenant" in text, path)
            # None of these may still hand a bare 'default' literal to a query --
            # only api/migrate.js is wholly excluded from this retrofit.
            self.assertEqual(text.count("'default'"), allowed_default_literals.get(path, 0), path)

    def test_consolidated_auth_handler_dispatches_and_is_wired_into_vercel_routing(self):
        # api/auth/*.js are excluded from deployment the same way
        # kanban/work/family/etc. are -- api/auth.js is the single deployed
        # function Vercel's rewrites route /api/auth/<action> through.
        vercelignore = source(ROOT / ".vercelignore")
        self.assertIn("api/auth/**", vercelignore)
        vercel_config = json.loads(source(ROOT / "vercel.json"))
        rewrite_sources = {r["source"] for r in vercel_config["rewrites"]}
        for action in ("logout", "session", "config", "setup", "sign-in", "sign-out-everywhere", "instance", "tokens"):
            self.assertIn(f"/api/auth/{action}", rewrite_sources)
            rewrite = next(r for r in vercel_config["rewrites"] if r["source"] == f"/api/auth/{action}")
            self.assertEqual(rewrite["destination"], f"/api/auth?action={action}")

        script = r'''
const handler = require('./api/auth.js');
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
function fakeRes() { const r = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(){} }; return r; }
(async () => {
  let res = fakeRes();
  await handler({ method: 'GET', query: { action: 'session' }, headers: {} }, res);
  assert(res.code === 200 && 'authenticated' in res.body, 'session action should dispatch to session handler');

  res = fakeRes();
  await handler({ method: 'GET', query: { action: 'config' }, headers: {} }, res);
  assert(res.code === 200 && 'setupNeeded' in res.body, 'config action should dispatch to config handler');

  res = fakeRes();
  await handler({ method: 'GET', query: { action: 'instance' }, headers: {} }, res);
  assert(res.code === 401, 'the sync token is never shown to a signed-out visitor');

  res = fakeRes();
  await handler({ method: 'GET', query: { action: 'google' }, headers: {} }, res);
  assert(res.code === 404, 'there is no Google sign-in');

  res = fakeRes();
  await handler({ method: 'GET', query: { action: 'not-a-real-action' }, headers: {} }, res);
  assert(res.code === 404, 'unknown action should 404, not silently succeed');
})().catch(e => { console.error(e); process.exit(1); });
'''
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_consolidated_auth_handler_does_not_depend_on_the_ignored_directory(self):
        # Regression test for a real production outage: api/auth.js originally
        # did require('./auth/login') etc. to dispatch, but .vercelignore
        # excludes the whole api/auth/ directory from the deployed bundle, so
        # every one of those require() calls threw at runtime -- 500ing login,
        # logout, session, config, and sign-in simultaneously. Vercel's
        # rewrites were never exercised by local dev (dev_server.js routes
        # directly to file paths, ignoring vercel.json), so this only surfaced
        # once it hit real production traffic. api/vault.js avoids the same
        # trap by depending only on _lib/ (never ignored); api/auth.js must too.
        text = source(API / "auth.js")
        self.assertNotIn("require('./auth/", text)
        self.assertNotIn('require("./auth/', text)

        # Prove it end-to-end: physically hide api/auth/ (simulating the
        # deployed bundle) and confirm api/auth.js still dispatches correctly.
        auth_dir = API / "auth"
        hidden_dir = API / "auth_HIDDEN_FOR_TEST"
        self.assertTrue(auth_dir.is_dir())
        auth_dir.rename(hidden_dir)
        try:
            script = r'''
const handler = require('./api/auth.js');
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
function fakeRes() { return { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(){} }; }
(async () => {
  let res = fakeRes();
  await handler({ method: 'GET', query: { action: 'session' }, headers: {} }, res);
  assert(res.code === 200 && 'authenticated' in res.body, `session should work without api/auth/ present, got ${res.code}`);

  res = fakeRes();
  await handler({ method: 'GET', query: { action: 'config' }, headers: {} }, res);
  assert(res.code === 200 && 'setupNeeded' in res.body, `config should work without api/auth/ present, got ${res.code}`);
})().catch(e => { console.error(e); process.exit(1); });
'''
            result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        finally:
            hidden_dir.rename(auth_dir)


if __name__ == "__main__":
    unittest.main()
