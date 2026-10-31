const crypto = require('crypto');
const { instanceSecret } = require('./instance-secrets');

const { publicOrigin } = require('./public-origin');

const ORIGIN = publicOrigin();
const ISSUER = ORIGIN;
const RESOURCE = `${ORIGIN}/api/mcp`;
// The MCP server answers as this deployment's own address, whatever host a
// request names (public-origin.js): a spoofed Host header never becomes the
// issuer, and tokens are only ever valid here.
function originFor() { return ORIGIN; }
function resourceFor() { return RESOURCE; }
const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const CLAUDE_CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
const CLAUDE_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const CODEX_SHARED_CLIENT_ID = 'https://chatgpt.com/oauth/codex/client.json';
const CLAUDE_CODE_CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
// Gemini has no client-id metadata document, so registration (below) gives it
// this id. Someone can also type it into Gemini's Client ID box by hand.
const GEMINI_CLIENT_ID = 'cardlake-gemini';
const KNOWN_CLIENTS = new Map([
  [CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI],
  [CLAUDE_CLIENT_ID, CLAUDE_REDIRECT_URI],
]);
const SCOPES = ['cardle.read', 'cardle.write'];
const CODE_TTL_SECONDS = 10 * 60;
const ACCESS_TTL_SECONDS = 60 * 60;
// ChatGPT keeps its Cardlake connection usable by exchanging this rotating
// credential when the one-hour access token expires. A longer-lived refresh
// token is opaque, persisted only as a hash, and still cannot revive the
// access of an owner who has since been replaced (local-accounts.js).
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

// Codex registers a client-id metadata document for each MCP endpoint.  Its
// callback id is included in both that trusted ChatGPT URL and the loopback
// redirect URI, so we can support Codex without accepting arbitrary clients
// or arbitrary redirect destinations.
function isCodexLoopbackRedirect(redirectUri, expectedPath) {
  try {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || redirect.username || redirect.password || redirect.search || redirect.hash) return false;
    if (redirect.port && (!/^\d+$/.test(redirect.port) || Number(redirect.port) < 1 || Number(redirect.port) > 65535)) return false;
    return redirect.pathname === expectedPath;
  } catch (_) {
    return false;
  }
}

function isCodexCimdClient(clientId, redirectUri) {
  try {
    const client = new URL(clientId);
    if (client.protocol !== 'https:' || client.hostname !== 'chatgpt.com' || client.port || client.search || client.hash) return false;
    const match = /^\/oauth\/codex\/([A-Za-z0-9_-]+)\/client\.json$/.exec(client.pathname);
    if (!match) return false;
    return isCodexLoopbackRedirect(redirectUri, `/callback/${match[1]}`);
  } catch (_) {
    return false;
  }
}

function isCodexSharedClient(clientId, redirectUri) {
  return clientId === CODEX_SHARED_CLIENT_ID && isCodexLoopbackRedirect(redirectUri, '/callback');
}

// Claude Code is a native client: its metadata document declares
// http://localhost/callback and http://127.0.0.1/callback, and RFC 8252 (7.3)
// says the port is ignored when matching them because it changes per session.
function isClaudeCodeClient(clientId, redirectUri) {
  if (clientId !== CLAUDE_CODE_CLIENT_ID) return false;
  try {
    const redirect = new URL(redirectUri);
    if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(redirect.hostname) || redirect.username || redirect.password || redirect.search || redirect.hash) return false;
    if (redirect.port && (!/^\d+$/.test(redirect.port) || Number(redirect.port) < 1 || Number(redirect.port) > 65535)) return false;
    return redirect.pathname === '/callback';
  } catch (_) {
    return false;
  }
}

// Gemini gives each person their own callback on Google's OAuth redirect host,
// named after their Google account and the server's host with its dots as
// underscores (cardlake.example becomes cardlake_example). It registers six
// at once: the live host and its -sandbox and -test twins, each under /r/
// and /a/. Other Google products put a Cloud project id there, and those
// can't contain underscores, so only Gemini can own a path of this shape.
// Only callbacks named after this deployment's own host are accepted; how
// Gemini writes a hyphen in a host isn't documented, so both forms count.
const GEMINI_HOSTS = (() => {
  const host = new URL(ORIGIN).hostname.toLowerCase();
  return new Set([host.replace(/\./g, '_'), host.replace(/[^a-z0-9]/g, '_')]);
})();
function isGeminiRedirect(redirectUri) {
  const match = /^https:\/\/oauth-redirect(?:-sandbox|-test)?\.googleusercontent\.com\/[ra]\/user_bound_custom-mcp-\d{1,40}-([a-z0-9_-]{1,253})$/.exec(String(redirectUri));
  return Boolean(match) && GEMINI_HOSTS.has(match[1]);
}

function isGeminiClient(clientId, redirectUri) {
  return clientId === GEMINI_CLIENT_ID && isGeminiRedirect(redirectUri);
}

// Dynamic client registration (RFC 7591), which Gemini needs. It never admits
// a new app: it hands out a fixed id for redirect URIs Cardlake already
// trusts and refuses anything else, so nothing is stored. Claude and ChatGPT
// get their usual ids should they ever register this way instead.
function registerClient(metadata) {
  const redirectUris = Array.isArray(metadata?.redirect_uris) ? metadata.redirect_uris.map(String) : [];
  const ids = new Set(redirectUris.map(uri => (isGeminiRedirect(uri) ? GEMINI_CLIENT_ID : [...KNOWN_CLIENTS].find(([, known]) => known === uri)?.[0])));
  if (!redirectUris.length || ids.has(undefined) || ids.size !== 1) throw Object.assign(new Error('Cardlake does not accept this redirect URI'), { oauth: 'invalid_redirect_uri' });
  const [clientId] = ids;
  return { client_id: clientId, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: clientDisplayName(clientId), redirect_uris: redirectUris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
}

// What the consent page calls the app asking for access. Derived only from the
// client ids accepted above, never from anything the request supplies.
function clientDisplayName(clientId) {
  if (clientId === CLAUDE_CODE_CLIENT_ID) return 'Claude Code';
  if (clientId === CLAUDE_CLIENT_ID) return 'Claude';
  if (clientId === CHATGPT_CLIENT_ID) return 'ChatGPT';
  if (clientId === GEMINI_CLIENT_ID) return 'Gemini';
  if (clientId.startsWith('https://chatgpt.com/oauth/codex/')) return 'Codex';
  return 'your AI assistant';
}

function base64url(value) { return Buffer.from(value).toString('base64url'); }
function unbase64url(value) { return Buffer.from(value, 'base64url'); }
function secret() {
  const value = instanceSecret('OAUTH_SIGNING_SECRET') || instanceSecret('SESSION_SECRET');
  if (!value) throw new Error('OAUTH_SIGNING_SECRET or SESSION_SECRET is not configured');
  return value;
}
function sign(value) { return crypto.createHmac('sha256', secret()).update(value).digest('base64url'); }
function safeEqual(left, right) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function encode(payload) { const body = base64url(JSON.stringify(payload)); return `${body}.${sign(body)}`; }
function decode(value) {
  const [body, signature] = String(value || '').split('.');
  if (!body || !signature || !safeEqual(sign(body), signature)) return null;
  try { return JSON.parse(unbase64url(body).toString('utf8')); } catch (_) { return null; }
}
function normalizeScopes(value) {
  const scopes = String(value || '').split(/\s+/).filter(Boolean);
  if (!scopes.length) return [...SCOPES];
  if (scopes.some(scope => !SCOPES.includes(scope))) return null;
  return [...new Set(scopes)];
}
function validateAuthorizationRequest(query, req) {
  const clientId = String(query.client_id || '');
  const redirectUri = String(query.redirect_uri || '');
  const resource = String(query.resource || '');
  const challenge = String(query.code_challenge || '');
  if (query.response_type !== 'code') throw Object.assign(new Error('Only response_type=code is supported'), { oauth: 'unsupported_response_type' });
  if (KNOWN_CLIENTS.get(clientId) !== redirectUri && !isCodexCimdClient(clientId, redirectUri) && !isCodexSharedClient(clientId, redirectUri) && !isClaudeCodeClient(clientId, redirectUri) && !isGeminiClient(clientId, redirectUri)) throw Object.assign(new Error('Unrecognized OAuth client'), { oauth: 'invalid_client' });
  if (resource !== resourceFor(req)) throw Object.assign(new Error('Invalid resource'), { oauth: 'invalid_target' });
  if (query.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw Object.assign(new Error('PKCE S256 is required'), { oauth: 'invalid_request' });
  const scopes = normalizeScopes(query.scope);
  if (!scopes) throw Object.assign(new Error('Unsupported scope'), { oauth: 'invalid_scope' });
  return { clientId, redirectUri, resource, codeChallenge: challenge, scopes, state: String(query.state || '').slice(0, 2048) };
}
function verifyPkce(verifier, challenge) {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(String(verifier || ''))) return false;
  return safeEqual(crypto.createHash('sha256').update(verifier).digest('base64url'), challenge);
}
// A token belongs to the domain it was issued for and is refused on the other.
function createAccessToken(email, scopes, resource = RESOURCE) {
  const now = Math.floor(Date.now() / 1000);
  return encode({ typ: 'cardle-access', iss: new URL(resource).origin, sub: email, aud: resource, scope: scopes.join(' '), iat: now, exp: now + ACCESS_TTL_SECONDS });
}
function resolveOAuthAuthorization(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  const payload = match && decode(match[1]);
  if (!payload || payload.typ !== 'cardle-access' || payload.iss !== originFor(req) || payload.aud !== resourceFor(req) || payload.exp <= Math.floor(Date.now() / 1000) || !payload.sub) return null;
  const scopes = normalizeScopes(payload.scope);
  return scopes ? { tenant: payload.sub, scopes } : null;
}
function resolveOAuthTenant(req) {
  return resolveOAuthAuthorization(req)?.tenant || null;
}
function transactionCookie(value, maxAge = CODE_TTL_SECONDS) { return `cardle_oauth_tx=${value}; Path=/oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAge};${process.env.NODE_ENV === 'production' ? ' Secure;' : ''}`; }
function readCookie(req, name) {
  const pairs = String(req.headers.cookie || '').split(';').map(value => value.trim().split('='));
  return pairs.find(([key]) => key === name)?.slice(1).join('=') || '';
}
function createTransaction(request) { return encode({ ...request, exp: Math.floor(Date.now() / 1000) + CODE_TTL_SECONDS }); }
function readTransaction(req) { const value = decode(readCookie(req, 'cardle_oauth_tx')); return value?.exp > Math.floor(Date.now() / 1000) ? value : null; }
function authorizationMetadata(req) {
  const origin = originFor(req);
  return { issuer: origin, authorization_response_iss_parameter_supported: true, authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, client_id_metadata_document_supported: true, token_endpoint_auth_methods_supported: ['none'], response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], scopes_supported: SCOPES };
}
function protectedResourceMetadata(req) { const origin = originFor(req); return { resource: `${origin}/api/mcp`, authorization_servers: [origin], scopes_supported: SCOPES, resource_documentation: `${origin}/mcp-setup.html` }; }
function authChallenge(req) { return `Bearer resource_metadata="${originFor(req)}/.well-known/oauth-protected-resource", scope="cardle.read cardle.write"`; }

module.exports = { ACCESS_TTL_SECONDS, CHATGPT_CLIENT_ID, CHATGPT_REDIRECT_URI, CLAUDE_CLIENT_ID, CLAUDE_CODE_CLIENT_ID, CLAUDE_REDIRECT_URI, CODEX_SHARED_CLIENT_ID, GEMINI_CLIENT_ID, ISSUER, ORIGIN, REFRESH_TTL_SECONDS, RESOURCE, SCOPES, authChallenge, authorizationMetadata, clientDisplayName, createAccessToken, createTransaction, hashToken: value => crypto.createHash('sha256').update(value).digest('hex'), isClaudeCodeClient, isCodexCimdClient, isCodexSharedClient, isGeminiClient, normalizeScopes, originFor, protectedResourceMetadata, readTransaction, registerClient, resolveOAuthAuthorization, resolveOAuthTenant, transactionCookie, validateAuthorizationRequest, verifyPkce };
