const { getSql } = require('./_lib/db');
const { resolveMcpTenant } = require('./_lib/api-tokens');
const { createMcpServer } = require('./_lib/mcp-server');
const { authChallenge, protectedResourceMetadata, resolveOAuthAuthorization } = require('./_lib/oauth');
const { isAccountActive, prepareRequest } = require('./_lib/session-guard');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET' && req.query?.metadata === '1') return res.status(200).json(protectedResourceMetadata(req));
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'This is a stateless MCP endpoint; use POST.' });
  }

  // Every MCP call, read or write, is treated as private: this endpoint is
  // reachable by third-party AI platforms (Claude, ChatGPT, Gemini, ...), not
  // just this app's own logged-in UI, so it does not inherit the public-GET
  // convention the rest of the API uses. The resolved tenant also scopes
  // every tool call to that one user's data.
  // Bearer credentials only, so no cookie guard -- but an OAuth token is
  // checked against this deployment's generated signing secret, which has to
  // be loaded on this instance first (session-guard.js prepareRequest).
  await prepareRequest();
  const sql = getSql();
  let oauthAuthorization = null;
  try {
    oauthAuthorization = resolveOAuthAuthorization(req);
  } catch (error) {
    // No signing secret available (database unreachable): no OAuth token can
    // be verified, so treat the request as unauthenticated rather than crash.
    console.error('[mcp] could not verify an OAuth token -', error?.message || error);
  }
  const tenant = oauthAuthorization?.tenant || await resolveMcpTenant(sql, req);
  // A signed OAuth access token stays valid for an hour; an account whose
  // access was removed in the meantime is treated as unauthenticated.
  if (!tenant || !(await isAccountActive(tenant))) {
    res.setHeader('WWW-Authenticate', authChallenge(req));
    res.status(401).json({ error: 'A valid Authorization: Bearer <token> header is required (see /api/auth/tokens)' });
    return;
  }

  try {
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

    const server = await createMcpServer(tenant, oauthAuthorization?.scopes);

    // Fresh server + transport per request: this function has no persistent
    // state between invocations, so there is no session to reuse or reconnect.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body && typeof req.body === 'object' ? req.body : undefined);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error.message || String(error) });
  }
};
