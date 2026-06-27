const crypto = require('crypto');

/**
 * Minimal TOTP (RFC 6238) / HOTP (RFC 4226) implementation using only
 * Node's built-in crypto module — no extra dependency for something this
 * small and security-sensitive (less surface to audit/trust).
 * Compatible with standard authenticator apps (Google Authenticator, Authy, etc).
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buffer) {
  let bits = '';
  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, '0');
  }
  let output = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder > 0) {
    const lastChunk = bits.slice(bits.length - remainder).padEnd(5, '0');
    output += BASE32_ALPHABET[parseInt(lastChunk, 2)];
  }
  return output;
}

function base32Decode(str) {
  const clean = str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binCode % 10 ** DIGITS;
  return otp.toString().padStart(DIGITS, '0');
}

function totp(secretBase32, time = Date.now()) {
  const counter = Math.floor(time / 1000 / STEP_SECONDS);
  return hotp(secretBase32, counter);
}

/**
 * Verifies a code allowing +/- 1 time step (90s window total) to tolerate
 * clock drift between server and the user's authenticator app.
 */
function verifyTotp(secretBase32, code, window = 1) {
  if (!secretBase32 || !code || !/^\d{6}$/.test(String(code))) return false;
  const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
  for (let errorWindow = -window; errorWindow <= window; errorWindow++) {
    if (hotp(secretBase32, counter + errorWindow) === String(code)) return true;
  }
  return false;
}

function buildOtpAuthUri(secretBase32, accountName, issuer = 'VanillaAdmin') {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { generateSecret, totp, verifyTotp, buildOtpAuthUri };
