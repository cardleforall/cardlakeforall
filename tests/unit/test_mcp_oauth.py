"""Contract tests for MCP OAuth discovery and PKCE (ChatGPT, Claude, Claude Code, Codex)."""
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
