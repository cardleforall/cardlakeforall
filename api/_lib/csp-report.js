// Content-Security-Policy violation reports. vercel.json sends the policy in
// report-only mode, so nothing is blocked yet; browsers post what the policy
// would have blocked here, and it goes to the function logs. That shows what
// the pages really load, so the policy can be corrected before it's enforced.
// Nothing is stored, and each distinct violation is logged once per warm
// instance so one busy page can't flood the logs.
const MAX_BODY_BYTES = 16 * 1024;
const MAX_REMEMBERED = 1000;
const seen = new Set();

// Query strings and fragments can carry codes and tokens (an OAuth redirect,
// say), so only the origin and path of a URL are kept.
function withoutQuery(value) {
  const text = String(value || '');
  try {
    const url = new URL(text);
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return text.split(/[?#]/)[0].slice(0, 200);
  }
}

// Accepts both shapes browsers send: the classic report-uri body
// ({"csp-report": {...}}) and the Reporting API's ([{ type, body: {...} }]).
function violations(payload) {
  const entries = Array.isArray(payload) ? payload.map(entry => entry?.body) : [payload?.['csp-report']];
  return entries.filter(entry => entry && typeof entry === 'object').map(entry => ({
    page: withoutQuery(entry['document-uri'] || entry.documentURL),
    directive: String(entry['effective-directive'] || entry.effectiveDirective || entry['violated-directive'] || '').slice(0, 100),
    blocked: withoutQuery(entry['blocked-uri'] || entry.blockedURL),
    source: withoutQuery(entry['source-file'] || entry.sourceFile),
    line: Number(entry['line-number'] || entry.lineNumber) || null,
  }));
}

function readBody(req) {
  let parsed;
  try { parsed = req.body; } catch (_) { return Promise.resolve(null); }
  if (Buffer.isBuffer(parsed)) parsed = parsed.toString('utf8');
  if (typeof parsed === 'string') return Promise.resolve(parseJson(parsed));
  if (parsed && typeof parsed === 'object') return Promise.resolve(parsed);
  return new Promise(resolve => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; if (raw.length > MAX_BODY_BYTES) { raw = ''; req.destroy(); resolve(null); } });
    req.on('end', () => resolve(parseJson(raw)));
    req.on('error', () => resolve(null));
  });
}

function parseJson(text) {
  if (!text || text.length > MAX_BODY_BYTES) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

async function cspReportHandler(req, res) {
  req.cardleEvent = false;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: `Method ${req.method} not allowed` });
  }
  for (const violation of violations(await readBody(req))) {
    const key = JSON.stringify(violation);
    if (seen.has(key)) continue;
    if (seen.size >= MAX_REMEMBERED) seen.clear();
    seen.add(key);
    console.warn(`[csp] ${key}`);
  }
  return res.status(204).end();
}

module.exports = { cspReportHandler, violations };
