// The small security helpers every endpoint leans on, tested directly:
// secret-box.js (stored third-party credentials) and rate-limit.js (public
// endpoints). Elsewhere they are only reached through one handler each, which
// leaves key rotation, tampering and window resets untested. Run by test_security_helpers.py
// through scenario_runner.js.
'use strict';
const assert = require('assert/strict');
const crypto = require('crypto');

const newKey = () => crypto.randomBytes(32).toString('base64');

// secret-box reads its keys on every call, so each test sets the env it needs.
function withKeys({ current, previous, session = 'security-helpers-secret' }, fn) {
  const saved = { ...process.env };
  process.env.SESSION_SECRET = session;
  if (current) process.env.INTEGRATION_ENCRYPTION_KEY = current; else delete process.env.INTEGRATION_ENCRYPTION_KEY;
  if (previous) process.env.INTEGRATION_ENCRYPTION_KEYS_PREVIOUS = previous; else delete process.env.INTEGRATION_ENCRYPTION_KEYS_PREVIOUS;
  try { return fn(); } finally { process.env = saved; }
}

const box = require('../../api/_lib/secret-box');
const { checkRateLimit, enforceRateLimit, getClientIp } = require('../../api/_lib/rate-limit');

const fromIp = ip => ({ headers: { 'x-forwarded-for': ip } });
let bucketSeq = 0;
const freshBucket = () => `security-helpers-${bucketSeq += 1}`;

function atTime(ms, fn) {
  const realNow = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = realNow; }
}

const scenarios = {
  // --- secret-box.js ---
  a_dedicated_key_seals_v2_and_opens_it() {
    withKeys({ current: newKey() }, () => {
      const sealed = box.seal('ghp_secret');
      assert.match(sealed, /^v2:[0-9a-f]{16}:/);
      assert.ok(!sealed.includes('ghp_secret'));
      assert.equal(box.open(sealed), 'ghp_secret');
      assert.equal(box.needsReseal(sealed), false);
    });
  },
  every_seal_uses_a_fresh_iv() {
    withKeys({ current: newKey() }, () => assert.notEqual(box.seal('same'), box.seal('same')));
  },
  without_a_dedicated_key_it_falls_back_to_v1_from_the_session_secret() {
    withKeys({}, () => {
      const sealed = box.seal('token');
      assert.match(sealed, /^v1:/);
      assert.equal(box.open(sealed), 'token');
      assert.equal(box.needsReseal(sealed), false, 'nothing better to reseal under yet');
    });
  },
  v1_values_still_open_after_a_dedicated_key_is_added_and_ask_to_be_resealed() {
    const sealed = withKeys({}, () => box.seal('legacy'));
    withKeys({ current: newKey() }, () => {
      assert.equal(box.open(sealed), 'legacy');
      assert.equal(box.needsReseal(sealed), true);
    });
  },
  a_rotated_key_still_opens_old_values_and_flags_them_for_reseal() {
    const oldKey = newKey();
    const sealed = withKeys({ current: oldKey }, () => box.seal('rotate-me'));
    withKeys({ current: newKey(), previous: `${newKey()}, ${oldKey}` }, () => {
      assert.equal(box.open(sealed), 'rotate-me');
      assert.equal(box.needsReseal(sealed), true);
    });
  },
  a_value_no_configured_key_opens_is_null_not_an_error() {
    const sealed = withKeys({ current: newKey() }, () => box.seal('lost'));
    withKeys({ current: newKey() }, () => assert.equal(box.open(sealed), null));
    // A v1 value under a different session secret.
    const v1 = withKeys({ session: 'old-secret' }, () => box.seal('lost'));
    withKeys({ session: 'new-secret' }, () => assert.equal(box.open(v1), null));
  },
  tampered_ciphertext_fails_authentication() {
    withKeys({ current: newKey() }, () => {
      const parts = box.seal('integrity').split(':');
      const bytes = Buffer.from(parts[4], 'base64url');
      bytes[0] ^= 1;
      assert.equal(box.open([...parts.slice(0, 4), bytes.toString('base64url')].join(':')), null);
      const tag = Buffer.from(parts[3], 'base64url');
      tag[0] ^= 1;
      assert.equal(box.open([...parts.slice(0, 3), tag.toString('base64url'), parts[4]].join(':')), null);
    });
  },
  unsealed_or_malformed_values_open_to_null() {
    withKeys({ current: newKey() }, () => {
      for (const value of [null, undefined, '', 'ghp_plaintext', 'v2:abc', 'v1:a:b', 'v3:a:b:c:d', 42]) {
        assert.equal(box.open(value), null, String(value));
      }
      // integrations.js reseals only a value open() could read.
      for (const value of [null, '', 'ghp_plaintext', 42]) assert.equal(box.needsReseal(value), false, String(value));
      assert.equal(box.isSealed('ghp_plaintext'), false);
    });
  },
  a_key_that_is_not_32_bytes_is_a_config_error() {
    const short = crypto.randomBytes(16).toString('base64');
    withKeys({ current: short }, () => assert.throws(() => box.seal('x'), box.SecretBoxConfigError));
    withKeys({ current: newKey(), previous: short }, () => assert.throws(() => box.seal('x'), box.SecretBoxConfigError));
  },
  v1_needs_a_session_secret() {
    withKeys({ session: '' }, () => assert.throws(() => box.seal('x'), /SESSION_SECRET/));
  },

  // --- rate-limit.js ---
  the_limit_allows_max_requests_then_refuses_with_retry_after() {
    const opts = { bucket: freshBucket(), max: 3, windowMs: 60e3 };
    atTime(1e9, () => {
      for (let i = 0; i < 3; i += 1) assert.equal(checkRateLimit(fromIp('203.0.113.1'), opts).limited, false, `request ${i + 1}`);
    });
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    atTime(1e9 + 15e3, () => assert.equal(enforceRateLimit(fromIp('203.0.113.1'), res, opts), false));
    assert.equal(res.code, 429);
    assert.equal(res.body.code, 'RATE_LIMITED');
    assert.equal(res.headers['Retry-After'], '45');
  },
  the_window_resets() {
    const opts = { bucket: freshBucket(), max: 1, windowMs: 10e3 };
    atTime(2e9, () => checkRateLimit(fromIp('203.0.113.2'), opts));
    atTime(2e9 + 9999, () => assert.equal(checkRateLimit(fromIp('203.0.113.2'), opts).limited, true));
    atTime(2e9 + 10e3, () => assert.equal(checkRateLimit(fromIp('203.0.113.2'), opts).limited, false));
  },
  buckets_and_addresses_are_counted_separately() {
    const a = { bucket: freshBucket(), max: 1, windowMs: 60e3 };
    const b = { bucket: freshBucket(), max: 1, windowMs: 60e3 };
    atTime(3e9, () => {
      assert.equal(checkRateLimit(fromIp('203.0.113.3'), a).limited, false);
      assert.equal(checkRateLimit(fromIp('203.0.113.3'), b).limited, false, 'another endpoint has its own budget');
      assert.equal(checkRateLimit(fromIp('203.0.113.4'), a).limited, false, 'another address has its own budget');
      assert.equal(checkRateLimit(fromIp('203.0.113.3'), a).limited, true);
    });
  },
  the_client_address_is_the_first_forwarded_hop() {
    assert.equal(getClientIp(fromIp(' 198.51.100.7 , 10.0.0.1')), '198.51.100.7');
    assert.equal(getClientIp({ headers: {}, socket: { remoteAddress: '192.0.2.9' } }), '192.0.2.9');
    assert.equal(getClientIp({ headers: {} }), 'unknown');
  },
};

require('./scenario_runner').runScenario(scenarios);
