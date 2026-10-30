function allowMethods(req, res, methods) {
  if (!methods.includes(req.method)) {
    res.setHeader('Allow', methods.join(', '));
    res.status(405).json({ error: `Method ${req.method} not allowed` });
    return false;
  }
  return true;
}

// Sign-in requests must come from a page on the host they're sent to;
// otherwise another site could sign a visitor into the attacker's account
// ("login CSRF"). Browsers always send Origin with a POST, so a foreign or
// opaque ("null") one is refused. A request with no Origin isn't from a
// browser page (scripts, tests) and can't carry a visitor's browser, so it
// goes through. Comparing with the request's own host keeps every domain
// working (a custom domain, *.vercel.app, previews, localhost) without a list.
function isSameOriginRequest(req) {
  const origin = req.headers?.origin;
  if (origin === undefined || origin === '') return true;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  try {
    return !!host && new URL(origin).host.toLowerCase() === host;
  } catch (_) {
    return false;
  }
}

// Answers 403 and returns false for a cross-site request.
function allowSameOrigin(req, res) {
  if (isSameOriginRequest(req)) return true;
  res.status(403).json({ error: 'Sign-in has to start on this site. Reload the page and try again.', code: 'CROSS_ORIGIN_REQUEST' });
  return false;
}

const { limits, LimitError } = require('./limits');

function readJson(req) {
  if (req.body && typeof req.body === 'object') {
    const bytes = Buffer.byteLength(JSON.stringify(req.body), 'utf8');
    if (bytes > limits.maxJsonBodyBytes) {
      throw new LimitError(413, 'JSON_BODY_TOO_LARGE', `Request data must be ${Math.floor(limits.maxJsonBodyBytes / 1024)} KB or smaller.`, { used: bytes, limit: limits.maxJsonBodyBytes });
    }
    return req.body;
  }

  return new Promise((resolve, reject) => {
    let raw = '';
    let bytes = 0;
    let rejected = false;
    req.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limits.maxJsonBodyBytes) {
        rejected = true;
        reject(new LimitError(413, 'JSON_BODY_TOO_LARGE', `Request data must be ${Math.floor(limits.maxJsonBodyBytes / 1024)} KB or smaller.`, { used: bytes, limit: limits.maxJsonBodyBytes }));
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (rejected) return;
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new LimitError(400, 'INVALID_JSON', 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendError(res, error, status = null) {
  const resolvedStatus = status || error.status || 500;
  const isExpected = error instanceof LimitError || (error.status >= 400 && error.status < 500);
  const message = isExpected ? (error.message || 'The request could not be completed.') : 'Something went wrong. Please try again.';
  const body = { error: message, code: error.code || (resolvedStatus >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR') };
  if (error.details) body.details = error.details;
  res.status(resolvedStatus).json(body);
}

module.exports = {
  allowMethods,
  allowSameOrigin,
  isSameOriginRequest,
  readJson,
  sendError,
};
