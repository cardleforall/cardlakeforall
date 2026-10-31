"""Contract tests for MCP OAuth discovery and PKCE (ChatGPT, Claude, Claude Code, Codex, Gemini)."""
from pathlib import Path
import json
import re
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[2]


class McpOAuthTests(unittest.TestCase):
    def test_oauth_routes_schema_and_mcp_challenge_are_present(self):
        config = json.loads((ROOT / 'vercel.json').read_text(encoding='utf-8'))
        routes = {entry['source']: entry['destination'] for entry in config['rewrites']}
        self.assertEqual(routes['/.well-known/oauth-protected-resource'], '/api/mcp?metadata=1')
        self.assertEqual(routes['/.well-known/oauth-authorization-server'], '/api/auth?action=oauth-metadata')
        self.assertEqual(routes['/oauth/authorize'], '/api/oauth?action=authorize')
        self.assertEqual(routes['/oauth/token'], '/api/oauth?action=token')
        self.assertEqual(routes['/oauth/register'], '/api/oauth?action=register')
        self.assertIn('oauth_authorization_codes', (ROOT / 'schema-v2.sql').read_text(encoding='utf-8'))
        self.assertIn('oauth_refresh_tokens', (ROOT / 'schema-v2.sql').read_text(encoding='utf-8'))
        mcp = (ROOT / 'api/mcp.js').read_text(encoding='utf-8')
        self.assertIn('WWW-Authenticate', mcp)
        self.assertIn('protectedResourceMetadata', mcp)
        self.assertIn('resolveOAuthAuthorization', mcp)

    def test_oauth_token_and_pkce_helpers_enforce_resource_and_expiry(self):
        script = r'''
process.env.SESSION_SECRET = 'test-secret';
const crypto = require('crypto');
const oauth = require('./api/_lib/oauth');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const verifier = 'a'.repeat(43);
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const request = oauth.validateAuthorizationRequest({
  response_type: 'code', client_id: oauth.CHATGPT_CLIENT_ID,
  redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
  resource: oauth.RESOURCE, code_challenge: challenge, code_challenge_method: 'S256',
  scope: 'cardle.read cardle.write', state: 'state',
});
assert(request.scopes.length === 2, 'expected both Cardlake scopes');
const claude = oauth.validateAuthorizationRequest({
  response_type: 'code', client_id: oauth.CLAUDE_CLIENT_ID,
  redirect_uri: 'https://claude.ai/api/mcp/auth_callback', resource: oauth.RESOURCE,
  code_challenge: challenge, code_challenge_method: 'S256', scope: 'cardle.read cardle.write',
});
assert(claude.clientId === oauth.CLAUDE_CLIENT_ID, 'Claude client metadata was rejected');
const codexClientId = 'https://chatgpt.com/oauth/codex/cardle-9fT_3/client.json';
const codex = oauth.validateAuthorizationRequest({
  response_type: 'code', client_id: codexClientId,
  redirect_uri: 'http://127.0.0.1:38473/callback/cardle-9fT_3', resource: oauth.RESOURCE,
  code_challenge: challenge, code_challenge_method: 'S256', scope: 'cardle.read cardle.write',
});
assert(codex.clientId === codexClientId, 'Codex client metadata was rejected');
assert(!oauth.isCodexCimdClient(codexClientId, 'http://evil.example/callback/cardle-9fT_3'), 'non-loopback Codex redirect accepted');
assert(!oauth.isCodexCimdClient('https://attacker.example/oauth/codex/cardle-9fT_3/client.json', 'http://127.0.0.1:38473/callback/cardle-9fT_3'), 'untrusted client metadata host accepted');
assert(!oauth.isCodexCimdClient(codexClientId, 'http://127.0.0.1:38473/callback/other'), 'mismatched callback id accepted');
const sharedCodex = oauth.validateAuthorizationRequest({
  response_type: 'code', client_id: oauth.CODEX_SHARED_CLIENT_ID,
  redirect_uri: 'http://127.0.0.1:38473/callback', resource: oauth.RESOURCE,
  code_challenge: challenge, code_challenge_method: 'S256', scope: 'cardle.read cardle.write',
});
assert(sharedCodex.clientId === oauth.CODEX_SHARED_CLIENT_ID, 'Codex shared client metadata was rejected');
assert(!oauth.isCodexSharedClient(oauth.CODEX_SHARED_CLIENT_ID, 'http://127.0.0.1:38473/callback/other'), 'shared client accepted a non-shared callback path');
const claudeCodeRequest = redirect_uri => ({
  response_type: 'code', client_id: oauth.CLAUDE_CODE_CLIENT_ID, redirect_uri, resource: oauth.RESOURCE,
  code_challenge: challenge, code_challenge_method: 'S256', scope: 'cardle.read cardle.write',
});
for (const uri of ['http://localhost:3118/callback', 'http://127.0.0.1:54321/callback', 'http://localhost/callback']) {
  assert(oauth.validateAuthorizationRequest(claudeCodeRequest(uri)).clientId === oauth.CLAUDE_CODE_CLIENT_ID, `Claude Code redirect ${uri} was rejected`);
}
for (const uri of ['http://localhost:3118/other', 'http://localhost:3118/callback?x=1', 'http://evil.example:3118/callback', 'https://localhost:3118/callback', 'http://localhost.evil.example/callback', 'http://user@localhost:3118/callback', 'http://localhost:99999/callback']) {
  assert(!oauth.isClaudeCodeClient(oauth.CLAUDE_CODE_CLIENT_ID, uri), `Claude Code accepted ${uri}`);
}
assert(!oauth.isClaudeCodeClient('https://attacker.example/claude-code-client-metadata', 'http://localhost:3118/callback'), 'untrusted client id accepted for a loopback redirect');
assert(!oauth.isClaudeCodeClient(oauth.CLAUDE_CLIENT_ID, 'http://localhost:3118/callback'), 'hosted Claude client accepted a loopback redirect');
assert(oauth.clientDisplayName(oauth.CLAUDE_CLIENT_ID) === 'Claude', 'wrong consent name for Claude');
assert(oauth.clientDisplayName(oauth.CLAUDE_CODE_CLIENT_ID) === 'Claude Code', 'wrong consent name for Claude Code');
assert(oauth.clientDisplayName(oauth.CHATGPT_CLIENT_ID) === 'ChatGPT', 'wrong consent name for ChatGPT');
assert(oauth.clientDisplayName(codexClientId) === 'Codex', 'wrong consent name for Codex');
assert(oauth.verifyPkce(verifier, request.codeChallenge), 'valid PKCE verifier rejected');
assert(!oauth.verifyPkce('b'.repeat(43), request.codeChallenge), 'invalid PKCE verifier accepted');
const token = oauth.createAccessToken('member@example.test', request.scopes);
assert(oauth.resolveOAuthTenant({ headers: { authorization: `Bearer ${token}` } }) === 'member@example.test', 'valid OAuth token rejected');
const readOnlyToken = oauth.createAccessToken('member@example.test', ['cardle.read']);
const readOnly = oauth.resolveOAuthAuthorization({ headers: { authorization: `Bearer ${readOnlyToken}` } });
assert(readOnly?.tenant === 'member@example.test', 'read-only OAuth token rejected');
assert(readOnly.scopes.length === 1 && readOnly.scopes[0] === 'cardle.read', 'read-only OAuth scope was altered');
assert(oauth.resolveOAuthTenant({ headers: { authorization: 'Bearer invalid' } }) === null, 'invalid token accepted');
assert(oauth.authorizationMetadata().code_challenge_methods_supported.includes('S256'), 'metadata must advertise PKCE S256');
assert(oauth.authorizationMetadata().grant_types_supported.includes('refresh_token'), 'metadata must advertise refresh-token support');
assert(oauth.protectedResourceMetadata().authorization_servers.includes(oauth.ISSUER), 'metadata issuer mismatch');
'''
        result = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_server_is_its_own_deployment_whatever_the_host_header_says(self):
        # One address (public-origin.js): a token is valid only for it, and a
        # spoofed Host header never becomes the issuer.
        script = r'''
process.env.SESSION_SECRET = 'test-secret';
process.env.CARDLE_PUBLIC_ORIGIN = 'https://notes.example';
const oauth = require('./api/_lib/oauth');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const on = (host, token) => ({ headers: { host, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
assert(oauth.ISSUER === 'https://notes.example' && oauth.RESOURCE === 'https://notes.example/api/mcp', 'issuer and resource');
for (const host of ['notes.example', 'attacker.example', 'my-cardlake.vercel.app']) {
  assert(oauth.protectedResourceMetadata(on(host)).resource === oauth.RESOURCE, `${host} became the issuer`);
  assert(oauth.authorizationMetadata(on(host)).issuer === oauth.ISSUER, `${host} server metadata`);
}
const token = oauth.createAccessToken('alice@example.test', ['cardle.read']);
assert(oauth.resolveOAuthTenant(on('notes.example', token)) === 'alice@example.test', 'its own token');
const elsewhere = oauth.createAccessToken('alice@example.test', ['cardle.read'], 'https://other.example/api/mcp');
assert(oauth.resolveOAuthTenant(on('notes.example', elsewhere)) === null, 'a token for another server');
'''
        result = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_gemini_registers_itself_but_registration_admits_no_new_app(self):
        # Gemini can't use client-id metadata documents, so it registers.
        # Registration only names clients Cardlake already trusts, and only
        # Gemini callbacks named after this deployment's own host.
        script = r'''
process.env.SESSION_SECRET = 'test-secret';
process.env.CARDLE_PUBLIC_ORIGIN = 'https://notes.example';
const crypto = require('crypto');
const oauth = require('./api/_lib/oauth');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const gemini = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-108197236448847442911-notes_example';
assert(oauth.authorizationMetadata().registration_endpoint === 'https://notes.example/oauth/register', 'metadata must advertise registration');
const registered = oauth.registerClient({ redirect_uris: [gemini], client_name: 'Gemini', token_endpoint_auth_method: 'client_secret_basic' });
assert(registered.client_id === oauth.GEMINI_CLIENT_ID, 'Gemini got the wrong client id');
assert(registered.token_endpoint_auth_method === 'none' && !('client_secret' in registered), 'registration issued a secret');
const challenge = crypto.createHash('sha256').update('a'.repeat(43)).digest('base64url');
const request = oauth.validateAuthorizationRequest({
  response_type: 'code', client_id: registered.client_id, redirect_uri: gemini, resource: oauth.RESOURCE,
  code_challenge: challenge, code_challenge_method: 'S256', scope: 'cardle.read cardle.write',
});
assert(request.clientId === oauth.GEMINI_CLIENT_ID, 'Gemini authorization was rejected');
assert(oauth.clientDisplayName(oauth.GEMINI_CLIENT_ID) === 'Gemini', 'wrong consent name for Gemini');
for (const uri of [
  'https://oauth-redirect.googleusercontent.com/r/my-gcp-project',
  gemini.replace('notes_example', 'other_example'),
  'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-1081972-evil_example',
  `${gemini}?next=https://evil.example`, `${gemini}/more`, gemini.replace('https:', 'http:'),
  gemini.replace('oauth-redirect.googleusercontent.com', 'oauth-redirect.googleusercontent.com.evil.example'),
  'https://evil.example/callback',
]) {
  assert(!oauth.isGeminiClient(oauth.GEMINI_CLIENT_ID, uri), `Gemini accepted ${uri}`);
  let refused = false;
  try { oauth.registerClient({ redirect_uris: [uri] }); } catch (error) { refused = error.oauth === 'invalid_redirect_uri'; }
  assert(refused, `registration accepted ${uri}`);
}
assert(!oauth.isGeminiClient(oauth.CLAUDE_CLIENT_ID, gemini), 'another client id accepted for a Gemini callback');
for (const metadata of [{}, { redirect_uris: [] }, { redirect_uris: 'x' }, { redirect_uris: [gemini, oauth.CLAUDE_REDIRECT_URI] }, { redirect_uris: [gemini, 'https://evil.example/cb'] }]) {
  let refused = false;
  try { oauth.registerClient(metadata); } catch (error) { refused = error.oauth === 'invalid_redirect_uri'; }
  assert(refused, `registration accepted ${JSON.stringify(metadata)}`);
}
// Should Claude or ChatGPT ever register instead of using their metadata
// documents, they keep the ids the rest of the flow expects.
assert(oauth.registerClient({ redirect_uris: [oauth.CLAUDE_REDIRECT_URI] }).client_id === oauth.CLAUDE_CLIENT_ID, 'Claude registration');
assert(oauth.registerClient({ redirect_uris: [oauth.CHATGPT_REDIRECT_URI] }).client_id === oauth.CHATGPT_CLIENT_ID, 'ChatGPT registration');
'''
        result = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_gemini_callback_names_this_deployments_host_with_or_without_hyphens(self):
        # Gemini writes the host's dots as underscores; how it writes a hyphen
        # isn't documented, so a Vercel address is accepted either way.
        script = r'''
process.env.CARDLE_PUBLIC_ORIGIN = 'https://my-cardlake.vercel.app';
const oauth = require('./api/_lib/oauth');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const callback = host => `https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-42-${host}`;
assert(oauth.isGeminiClient(oauth.GEMINI_CLIENT_ID, callback('my-cardlake_vercel_app')), 'hyphen kept');
assert(oauth.isGeminiClient(oauth.GEMINI_CLIENT_ID, callback('my_cardlake_vercel_app')), 'hyphen as underscore');
assert(!oauth.isGeminiClient(oauth.GEMINI_CLIENT_ID, callback('your-cardlake_vercel_app')), 'another deployment');
assert(!oauth.isGeminiClient(oauth.GEMINI_CLIENT_ID, callback('my-cardlake_vercel_app_evil')), 'a longer host');
'''
        result = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_register_endpoint_and_token_exchange_with_basic_client_auth(self):
        # Gemini may name itself with HTTP Basic at the token endpoint rather
        # than client_id in the body; the secret it sends is ignored.
        script = r'''
process.env.SESSION_SECRET = 'test-secret';
process.env.CARDLE_PUBLIC_ORIGIN = 'https://notes.example';
const crypto = require('crypto');
const { createTestDb } = require('./tests/unit/pg_harness');
const db = require('./api/_lib/db');
const oauthLib = require('./api/_lib/oauth');
const gemini = 'https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-42-notes_example';
const verifier = 'v'.repeat(43);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
(async () => {
  const { sql } = await createTestDb();
  db.getSql = () => sql;
  require('./tests/unit/pg_harness').allowAccounts('alice@example.test');
  const handler = require('./api/oauth');
  const call = req => new Promise(resolve => {
    const res = { headers: {}, statusCode: 200, setHeader(k, v) { this.headers[k] = v; }, getHeader(k) { return this.headers[k]; }, status(code) { this.statusCode = code; return this; }, json(body) { resolve({ status: this.statusCode, body }); return this; }, send(body) { resolve({ status: this.statusCode, body }); return this; }, end() { resolve({ status: this.statusCode }); return this; } };
    handler({ headers: {}, ...req }, res);
  });
  const newCode = async () => {
    const code = crypto.randomBytes(16).toString('hex');
    await sql`insert into oauth_authorization_codes (code_hash, user_email, client_id, redirect_uri, resource, scope, code_challenge, expires_at)
      values (${oauthLib.hashToken(code)}, 'alice@example.test', ${oauthLib.GEMINI_CLIENT_ID}, ${gemini}, ${oauthLib.RESOURCE}, 'cardle.read cardle.write', ${crypto.createHash('sha256').update(verifier).digest('base64url')}, now() + interval '5 minutes')`;
    return code;
  };
  const ok = await call({ method: 'POST', query: { action: 'register' }, body: { redirect_uris: [gemini] } });
  assert(ok.status === 201 && ok.body.client_id === oauthLib.GEMINI_CLIENT_ID, `register: ${JSON.stringify(ok)}`);
  const bad = await call({ method: 'POST', query: { action: 'register' }, body: { redirect_uris: ['https://evil.example/cb'] } });
  assert(bad.status === 400 && bad.body.error === 'invalid_redirect_uri', `bad register: ${JSON.stringify(bad)}`);
  const form = async () => ({ grant_type: 'authorization_code', code: await newCode(), redirect_uri: gemini, resource: oauthLib.RESOURCE, code_verifier: verifier });
  const basic = 'Basic ' + Buffer.from(`${oauthLib.GEMINI_CLIENT_ID}:anything`).toString('base64');
  const tokens = await call({ method: 'POST', query: { action: 'token' }, headers: { authorization: basic }, body: await form() });
  assert(tokens.status === 200 && tokens.body.access_token, `basic token: ${JSON.stringify(tokens)}`);
  const other = 'Basic ' + Buffer.from(`${oauthLib.CLAUDE_CLIENT_ID}:x`).toString('base64');
  const wrong = await call({ method: 'POST', query: { action: 'token' }, headers: { authorization: other }, body: await form() });
  assert(wrong.status === 400 && wrong.body.error === 'invalid_grant', `wrong client: ${JSON.stringify(wrong)}`);
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
'''
        result = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_consent_page_names_the_connecting_app_not_a_fixed_one(self):
        page = (ROOT / 'api/oauth.js').read_text(encoding='utf-8')
        self.assertNotIn('Connect Cardlake to ChatGPT', page)
        self.assertNotIn('Start again from ChatGPT', page)
        self.assertIn('clientDisplayName(request.clientId)', page)


    def test_consent_page_is_for_the_owner_only(self):
        page = (ROOT / 'api/oauth.js').read_text(encoding='utf-8')
        # Nobody but the owner has an account, so the page signs in and never
        # offers to create one, ask anyone's age or put them on a waitlist.
        self.assertIn('Sign in to your Cardlake to continue.', page)
        for gone in ('creates your free account', 'ACCESS_REQUESTED', 'AGE_CONFIRMATION_REQUIRED', 'gsi/client'):
            self.assertNotIn(gone, page)
        self.assertIn('verifyPassword(sql, body)', page)

if __name__ == '__main__':
    unittest.main()
