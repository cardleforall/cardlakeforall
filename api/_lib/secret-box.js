const crypto = require('crypto');
const { instanceSecret } = require('./instance-secrets');

// Encrypts third-party credentials (e.g. a GitHub personal access token) at
// rest with AES-256-GCM.
//
// Keys, and why there are several:
//   INTEGRATION_ENCRYPTION_KEY            the dedicated key (32 random bytes,
//                                         base64). Seals everything new.
//   INTEGRATION_ENCRYPTION_KEYS_PREVIOUS  comma-separated retired dedicated
//                                         keys, still accepted for opening --
//                                         this is how the key is rotated.
//   SESSION_SECRET (via HKDF)             the original key. Still opens values
//                                         sealed before the dedicated key
//                                         existed, and seals new ones only
//                                         until the dedicated key is set.
// A dedicated key keeps a leaked or rotated session secret from also
// exposing (or destroying) every stored token.
//
// Formats: v2:<keyId>:<iv>:<tag>:<ciphertext>  (keyId names which dedicated
// key sealed it), and the original v1:<iv>:<tag>:<ciphertext>. Values sealed
// under anything but the current key are resealed on their next use
// (needsReseal), so a rotation drains old ciphertexts without a batch job.
//
// A value no configured key can open makes open() return null: the
// integration then asks the user to reconnect instead of failing opaquely.
const IV_BYTES = 12;
const V1_HKDF_INFO = 'cardle/integration-credentials/v1';

class SecretBoxConfigError extends Error {}

function decodeKey(value, name) {
  const key = Buffer.from(String(value).trim(), 'base64');
  if (key.length !== 32) throw new SecretBoxConfigError(`${name} must be 32 random bytes, base64-encoded`);
  return key;
}

const keyId = key => crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);

// Read per call, not cached: rotation is an environment change + redeploy,
// and tests swap keys within one process. A deployment that sets neither this
// key nor SESSION_SECRET uses one it generated (instance-secrets.js).
function dedicatedKeys() {
  const configured = instanceSecret('INTEGRATION_ENCRYPTION_KEY');
  const current = configured ? decodeKey(configured, 'INTEGRATION_ENCRYPTION_KEY') : null;
  const previous = String(process.env.INTEGRATION_ENCRYPTION_KEYS_PREVIOUS || '')
    .split(',').map(value => value.trim()).filter(Boolean)
    .map(value => decodeKey(value, 'INTEGRATION_ENCRYPTION_KEYS_PREVIOUS'));
  return { current, byId: new Map([current, ...previous].filter(Boolean).map(key => [keyId(key), key])) };
}

function v1Key() {
  const sessionSecret = instanceSecret('SESSION_SECRET');
  if (!sessionSecret) throw new Error('SESSION_SECRET is not configured');
  return Buffer.from(crypto.hkdfSync('sha256', sessionSecret, Buffer.alloc(0), V1_HKDF_INFO, 32));
}

const b64 = buffer => buffer.toString('base64url');

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [b64(iv), b64(cipher.getAuthTag()), b64(ciphertext)];
}

function decrypt(key, iv, tag, ciphertext) {
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch (_) {
    return null; // wrong key, or tampered with (GCM authentication failed)
  }
}

function seal(plaintext) {
  const { current } = dedicatedKeys();
  if (current) return ['v2', keyId(current), ...encrypt(current, plaintext)].join(':');
  return ['v1', ...encrypt(v1Key(), plaintext)].join(':');
}

function isSealed(value) {
  return typeof value === 'string' && /^v[12]:/.test(value);
}

// Returns the plaintext, or null if the value is missing or no configured key
// opens it.
function open(value) {
  if (!isSealed(value)) return null;
  const parts = value.split(':');
  if (parts[0] === 'v1' && parts.length === 4) return decrypt(v1Key(), parts[1], parts[2], parts[3]);
  if (parts[0] === 'v2' && parts.length === 5) {
    const key = dedicatedKeys().byId.get(parts[1]);
    return key ? decrypt(key, parts[2], parts[3], parts[4]) : null;
  }
  return null;
}

// True when a readable value should be rewritten under the current key: it
// was sealed with a retired dedicated key, or with the v1 key after a
// dedicated key has been configured.
function needsReseal(value) {
  if (!isSealed(value)) return false;
  const { current } = dedicatedKeys();
  if (!current) return false;
  const parts = value.split(':');
  return !(parts[0] === 'v2' && parts[1] === keyId(current));
}

module.exports = { seal, open, isSealed, needsReseal, SecretBoxConfigError };
