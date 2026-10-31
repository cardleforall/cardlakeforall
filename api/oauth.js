const crypto = require('crypto');
const { withSessionGuard } = require('./_lib/session-guard');
const { getSql } = require('./_lib/db');
const { allowSameOrigin, readJson, sendError } = require('./_lib/http');
const { getSessionPayload, setSessionCookie } = require('./_lib/auth');
const access = require('./_lib/access-control');
const oauth = require('./_lib/oauth');
const { verifyPassword } = require('./_lib/local-accounts');
const { PASSWORD_SIGN_IN_LIMIT } = require('./_lib/account-routes');
const { enforceRateLimit } = require('./_lib/rate-limit');

function sendHtml(res, html) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.status(200).send(html); }
function redirectUrl(uri, params) { const url = new URL(uri); Object.entries(params).forEach(([key, value]) => { if (value) url.searchParams.set(key, value); }); return url.toString(); }
function formBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve, reject) => { let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw)))); req.on('error', reject); });
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
// Styled like welcome.html, since for someone who starts from their assistant
// this is the first Cardlake page they see. The owner signs in with their
// password, or continues with the session they already have; nobody else
// has an account (access-control.js).
const PAGE_STYLE = `:root{--ink:oklch(20% .02 275);--muted:oklch(42% .02 275);--line:oklch(45% .04 280 / .16);--panel:oklch(99% .006 275 / .9);--soft:oklch(95% .012 275);--accent:oklch(52% .16 262)}
body{margin:0;font-family:'Manrope',system-ui,sans-serif;background:oklch(97% .01 280);color:var(--ink);min-height:100vh}
a{color:var(--accent)}
:focus-visible{outline:2px solid oklch(62% .16 260 / .6);outline-offset:2px}
.topbar{padding:20px 24px}
.brand{display:inline-flex;align-items:center;gap:9px;color:var(--ink);font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:16px;text-decoration:none}
.brand-mark{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#4a86e9,#42b3e7)}
.panel{max-width:440px;margin:6vh auto 48px;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:28px;box-sizing:border-box;box-shadow:0 30px 60px -35px oklch(28% .08 285 / .5)}
.eyebrow{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);background:var(--soft);border:1px solid var(--line);padding:5px 12px;border-radius:20px}
h1{font-family:'Space Grotesk',sans-serif;font-size:26px;line-height:1.2;margin:12px 0 8px}
p{margin:0 0 14px;font-size:15px;line-height:1.6;color:var(--muted)}
.can{list-style:none;margin:0 0 20px;padding:0;display:flex;flex-direction:column;gap:6px}
.can li{font-size:14px;line-height:1.4;background:var(--soft);border-radius:9px;padding:8px 12px}
#auth{display:flex;flex-direction:column;align-items:center;gap:12px;min-height:44px;margin:4px 0 6px}
.btn{width:100%;max-width:300px;min-height:44px;border:0;border-radius:999px;background:var(--accent);color:#fff;font:700 15px 'Manrope',system-ui,sans-serif;cursor:pointer}
.btn:disabled{opacity:.5;cursor:default}
.linklike{background:none;border:0;padding:0;color:var(--accent);font:600 13px 'Manrope',system-ui,sans-serif;cursor:pointer}
.linklike:hover{text-decoration:underline}
label{display:flex;gap:10px;align-items:flex-start;margin:0 0 14px;font-size:14px;line-height:1.5;color:var(--ink);cursor:pointer}
label input{margin-top:3px;width:18px;height:18px;flex:0 0 auto}
.fine{font-size:12px;line-height:1.5;margin:14px 0 0}
.error{color:oklch(52% .2 25);font-size:13px;min-height:1em;margin:12px 0 0}
#signin{width:100%;max-width:300px;margin:0 auto}
.field{flex-direction:column;align-items:stretch;gap:5px;font-weight:600;margin:0 0 12px}
.field input{margin:0;width:100%;height:auto;min-height:44px;box-sizing:border-box;font:15px 'Manrope',system-ui,sans-serif;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--soft);color:var(--ink)}
[hidden]{display:none!important}
@media(max-width:640px){.topbar{padding:16px}.panel{margin:2vh 16px 40px;padding:22px 18px}h1{font-size:23px}}`;
const BRAND_MARK = '<svg width="16" height="16" viewBox="-0.5 1.3 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="14" height="18" rx="2" transform="rotate(-8 10 14)"></rect><rect x="7" y="3" width="14" height="18" rx="2"></rect></svg>';

function page(sessionEmail, request) {
  const app = escapeHtml(oauth.clientDisplayName(request.clientId));
  const returnsTo = escapeHtml(new URL(request.redirectUri).hostname);
  const account = sessionEmail ? escapeHtml(sessionEmail) : '';
  const lead = account
    ? `You're signed in to Cardlake as <strong>${account}</strong>.`
    : 'Sign in to your Cardlake to continue.';
  const auth = account
    ? `<button type="button" class="btn" id="continue">Continue as ${account}</button><button type="button" class="linklike" id="switch">Sign in with your password instead</button>`
    : '';
  const signIn = `<div id="signin"${account ? ' hidden' : ''}><form id="password-form"><label class="field">Email <input type="email" name="email" autocomplete="email" required></label><label class="field">Password <input type="password" name="password" autocomplete="current-password" required></label><button type="submit" class="btn">Sign in</button></form></div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Connect Cardlake to ${app}</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/fonts/fonts.css"><style>${PAGE_STYLE}</style></head><body>
<header class="topbar"><a class="brand" href="/" target="_blank" rel="noopener"><span class="brand-mark">${BRAND_MARK}</span>Cardlake</a></header>
<main class="panel">
<section id="start">
<h1 style="margin-top:0">Connect Cardlake to ${app}</h1>
<p>${lead}</p>
<p style="margin:0 0 8px;color:var(--ink);font-weight:600;font-size:14px">${app} will be able to:</p>
<ul class="can"><li>See your reminders, learnings, work and other cards</li><li>Add and update cards for you</li><li>Snooze, pin and like cards in your feed</li></ul>
<div id="auth">${auth}${signIn}</div>
<p class="fine">You can disconnect Cardlake in ${app}'s settings at any time. After you continue, you'll go back to <strong>${returnsTo}</strong>.</p>
</section>
<p id="error" class="error" aria-live="polite"></p>
</main>
<script>
const $=id=>document.getElementById(id);
const send=async body=>{$('error').textContent='';const r=await fetch('/oauth/authorize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json().catch(()=>({}));if(j.redirect)location.href=j.redirect;else $('error').textContent=j.error||'Could not complete sign-in.'};
const form=$('password-form');form.onsubmit=e=>{e.preventDefault();const f=new FormData(form);send({email:f.get('email'),password:f.get('password')})};
${account ? "$('continue').onclick=()=>send({session:true});$('switch').onclick=()=>{$('switch').hidden=true;$('signin').hidden=false};" : ''}
</script></body></html>`;
}
async function authorize(req, res) {
  if (req.method === 'GET') {
    let request;
    // OAuth clients (ChatGPT, Claude, Codex) parse `error` as a fixed spec code, not
    // prose -- match the shape token() below already uses instead of error.message.
    try { request = oauth.validateAuthorizationRequest(req.query || {}, req); } catch (error) { return res.status(400).json({ error: error.oauth || 'invalid_request', error_description: error.message }); }
    res.setHeader('Set-Cookie', oauth.transactionCookie(oauth.createTransaction(request)));
    return sendHtml(res, page(getSessionPayload(req)?.email, request));
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  // The consent page posts here itself; the token endpoint is called by the
  // AI platforms' own servers and browsers, so it has no such check.
  if (!allowSameOrigin(req, res)) return;
  const transaction = oauth.readTransaction(req);
  if (!transaction) return res.status(400).json({ error: 'Authorization request expired. Start again from your AI assistant.' });
  try {
    const body = await readJson(req); let email; let name; let picture;
    const session = getSessionPayload(req);
    const sql = getSql();
    // A session reaching here is the owner's: the request guard drops any
    // other (session-guard.js).
    if (body.session && session?.email) ({ email, name, picture } = session);
    else {
      if (!enforceRateLimit(req, res, PASSWORD_SIGN_IN_LIMIT)) return;
      ({ email, name, picture } = await verifyPassword(sql, body));
      await sql`update users set last_login_at = now() where email = ${email}`;
    }
    const code = crypto.randomBytes(32).toString('base64url');
    await sql`insert into oauth_authorization_codes (code_hash, user_email, client_id, redirect_uri, resource, scope, code_challenge, expires_at) values (${oauth.hashToken(code)}, ${email}, ${transaction.clientId}, ${transaction.redirectUri}, ${transaction.resource}, ${transaction.scopes.join(' ')}, ${transaction.codeChallenge}, now() + interval '10 minutes')`;
    setSessionCookie(res, { email, name, picture });
    return res.status(200).json({ redirect: redirectUrl(transaction.redirectUri, { code, state: transaction.state, iss: oauth.originFor(req) }) });
  } catch (error) { return sendError(res, error, error.status || 400); }
}

async function issueTokenPair(sql, authorization) {
  const scopes = oauth.normalizeScopes(authorization.scope);
  if (!scopes) throw new Error('Invalid stored OAuth scope');
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await sql`insert into oauth_refresh_tokens (token_hash, user_email, client_id, resource, scope, expires_at) values (${oauth.hashToken(refreshToken)}, ${authorization.user_email}, ${authorization.client_id}, ${authorization.resource}, ${scopes.join(' ')}, now() + (${oauth.REFRESH_TTL_SECONDS} * interval '1 second'))`;
  return {
    access_token: oauth.createAccessToken(authorization.user_email, scopes, authorization.resource),
    token_type: 'Bearer',
    expires_in: oauth.ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    refresh_token_expires_in: oauth.REFRESH_TTL_SECONDS,
    scope: scopes.join(' '),
  };
}

async function exchangeAuthorizationCode(sql, body) {
  const rows = await sql`select * from oauth_authorization_codes where code_hash = ${oauth.hashToken(String(body.code || ''))} and used_at is null and expires_at > now()`;
  const code = rows[0];
  if (!code || code.client_id !== body.client_id || code.redirect_uri !== body.redirect_uri || body.resource !== code.resource || !oauth.verifyPkce(body.code_verifier, code.code_challenge)) return null;
  const used = await sql`update oauth_authorization_codes set used_at = now() where code_hash = ${code.code_hash} and used_at is null returning code_hash`;
  if (!used.length) return null;
  return issueTokenPair(sql, code);
}

async function exchangeRefreshToken(sql, body) {
  const rows = await sql`select * from oauth_refresh_tokens where token_hash = ${oauth.hashToken(String(body.refresh_token || ''))} and used_at is null and expires_at > now()`;
  const refresh = rows[0];
  // The resource parameter is optional when refreshing, but it may never be
  // changed. Public clients still identify themselves, as they do in the
  // authorization-code exchange.
  if (!refresh || refresh.client_id !== body.client_id || (body.resource && body.resource !== refresh.resource)) return null;
  const used = await sql`update oauth_refresh_tokens set used_at = now() where token_hash = ${refresh.token_hash} and used_at is null returning token_hash`;
  if (!used.length || !(await access.isOwnerEmail(sql, refresh.user_email))) return null;
  return issueTokenPair(sql, refresh);
}

// Public clients name themselves in the body; one that uses HTTP Basic (as
// Gemini may) names itself there instead. Cardlake issues no client secrets,
// so any secret sent along is ignored.
function clientIdOf(req, body) {
  if (body.client_id) return String(body.client_id);
  const match = /^Basic\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!match) return '';
  try { return decodeURIComponent(Buffer.from(match[1], 'base64').toString('utf8').split(':')[0].replace(/\+/g, ' ')); } catch (_) { return ''; }
}

async function token(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    const form = await formBody(req);
    const body = { ...form, client_id: clientIdOf(req, form) };
    const sql = getSql();
    let tokens;
    if (body.grant_type === 'authorization_code') tokens = await exchangeAuthorizationCode(sql, body);
    else if (body.grant_type === 'refresh_token') tokens = await exchangeRefreshToken(sql, body);
    else return res.status(400).json({ error: 'unsupported_grant_type' });
    if (!tokens) return res.status(400).json({ error: 'invalid_grant' });
    return res.status(200).json(tokens);
  } catch (error) { return sendError(res, error, 400); }
}
async function register(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  let metadata;
  try { metadata = await readJson(req); return res.status(201).json(oauth.registerClient(metadata)); } catch (error) {
    // A refused registration is an assistant we don't support yet (or a new
    // callback shape from one we do), so log what it asked for. Long digit
    // runs, such as Google account ids, are masked.
    console.warn('oauth.register refused', JSON.stringify({ redirect_uris: metadata?.redirect_uris, client_name: metadata?.client_name, keys: Object.keys(metadata || {}) }).replace(/\d{6,}/g, 'N').slice(0, 1000));
    return res.status(400).json({ error: error.oauth || 'invalid_client_metadata', error_description: error.message });
  }
}
module.exports = withSessionGuard(async function handler(req, res) { const action = req.query?.action; if (action === 'authorize') return authorize(req, res); if (action === 'token') return token(req, res); if (action === 'register') return register(req, res); return res.status(404).json({ error: 'Not found' }); });
