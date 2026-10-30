// A minimal fixed-window rate limiter, scoped per warm serverless instance.
//
// This does NOT span cold starts or multiple concurrently-scaled instances
// -- it is not a substitute for a distributed limiter (e.g. Upstash Redis)
// if this endpoint ever needs to withstand a distributed attack. What it
// does do, for zero added infrastructure, is hard-cap the rate at which a
// single source can hammer an unauthenticated endpoint (password login,
// public signup) from within one instance's lifetime, which is the common
// case for both a lone attacker and a runaway/misbehaving client.
const buckets = new Map();

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

// Reclaims memory from expired buckets so a long-lived warm instance
// doesn't accumulate one entry per distinct IP forever.
function sweep(now) {
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) buckets.delete(key);
  }
}

function checkRateLimit(req, { bucket, max, windowMs }) {
  const now = Date.now();
  if (buckets.size > 5000) sweep(now);

  const key = `${bucket}:${getClientIp(req)}`;
  const entry = buckets.get(key);
  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { limited: false };
  }
  entry.count += 1;
  if (entry.count > max) {
    return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }
  return { limited: false };
}

function enforceRateLimit(req, res, options) {
  const result = checkRateLimit(req, options);
  if (result.limited) {
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    res.status(429).json({ error: 'Too many requests. Please try again later.', code: 'RATE_LIMITED' });
    return false;
  }
  return true;
}

module.exports = { checkRateLimit, enforceRateLimit, getClientIp };
