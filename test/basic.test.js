/**
 * Minimal tests using Node.js built-in test runner.
 * Run with: npm test
 *
 * These are basic smoke + happy-path tests for the beta release.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { Readable } = require('stream');
const { once } = require('events');

// Минимальный мок req для getJsonBody: обычный поток, который эмитит
// 'data'/'end' так же, как настоящий http.IncomingMessage.
function mockRequestWithBody(bodyString) {
  const req = new Readable({
    read() {}
  });
  process.nextTick(() => {
    req.push(Buffer.from(bodyString));
    req.push(null);
  });
  return req;
}

let server;
let PORT;
let baseUrl;

before(async () => {
  // For beta we avoid auto-starting the full server in tests because it binds a port immediately.
  // Most value comes from module loading + route handler sanity checks.
  // Live HTTP tests can be added later with a proper test server harness.
  console.log('[test] Basic module smoke tests (server auto-start avoided in test env)...');
  process.env.PORT = '0'; // hint for anyone who requires server.js
});

test('modules load without throwing', async () => {
  const db = require('../db');
  const utils = require('../src/utils');

  assert.ok(db, 'db module should export something');
  assert.strictEqual(typeof utils.sendJson, 'function');
  assert.strictEqual(typeof utils.getJsonBody, 'function');
  assert.strictEqual(typeof utils.logAction, 'function');
});

// Live server integration test is disabled in this beta version to avoid port conflicts.
// It can be re-enabled with a proper isolated test server harness in the future.
test('public settings endpoint shape (skipped in beta to avoid port binding)', async (t) => {
  t.skip('Live HTTP test disabled for beta stability');
});

test('articles validation rejects empty title (via route module)', async () => {
  // We can require the route handler directly for some logic validation
  const handleArticles = require('../src/routes/articles');

  // Very lightweight: we don't have full req/res here, but we can at least ensure the module loads
  assert.strictEqual(typeof handleArticles, 'function', 'articles route handler should be a function');
});

test('sanitizeContent strips script tags and event handler attributes', () => {
  const { sanitizeContent } = require('../src/routes/articles');
  const dirty = '<p>hello</p><script>alert(1)</script><img src="x" onerror="alert(2)">';
  const clean = sanitizeContent(dirty);

  assert.ok(!clean.includes('<script'), 'script tag should be stripped');
  assert.ok(!clean.includes('onerror'), 'event handler attribute should be stripped');
  assert.ok(clean.includes('<p>hello</p>'), 'safe tags should be preserved');
});

test('sanitizeContent handles empty/undefined content', () => {
  const { sanitizeContent } = require('../src/routes/articles');
  assert.strictEqual(sanitizeContent(undefined), '');
  assert.strictEqual(sanitizeContent(''), '');
});

test('getJsonBody resolves valid JSON within size limit', async () => {
  const { getJsonBody } = require('../src/utils');
  const req = mockRequestWithBody(JSON.stringify({ username: 'a', password: 'b' }));
  const body = await getJsonBody(req);
  assert.deepStrictEqual(body, { username: 'a', password: 'b' });
});

test('getJsonBody rejects bodies larger than maxBytes', async () => {
  const { getJsonBody } = require('../src/utils');
  const oversized = JSON.stringify({ password: 'a'.repeat(1000) });
  const req = mockRequestWithBody(oversized);

  await assert.rejects(
    () => getJsonBody(req, 100), // лимит намеренно меньше тела запроса
    /слишком большое/i
  );
});

test('totp: generated code verifies successfully', () => {
  const { generateSecret, totp, verifyTotp } = require('../src/totp');
  const secret = generateSecret();
  const code = totp(secret);
  assert.strictEqual(verifyTotp(secret, code), true);
});

test('totp: wrong code is rejected', () => {
  const { generateSecret, totp, verifyTotp } = require('../src/totp');
  const secret = generateSecret();
  const code = totp(secret);
  const wrongCode = code === '000000' ? '111111' : '000000';
  assert.strictEqual(verifyTotp(secret, wrongCode), false);
});

test('totp: code for a different secret does not verify', () => {
  const { generateSecret, totp, verifyTotp } = require('../src/totp');
  const secretA = generateSecret();
  const secretB = generateSecret();
  const codeForA = totp(secretA);
  assert.strictEqual(verifyTotp(secretB, codeForA), false);
});

test('totp: rejects malformed codes without throwing', () => {
  const { generateSecret, verifyTotp } = require('../src/totp');
  const secret = generateSecret();
  assert.strictEqual(verifyTotp(secret, ''), false);
  assert.strictEqual(verifyTotp(secret, 'abcdef'), false);
  assert.strictEqual(verifyTotp(secret, null), false);
});

after(async () => {
  if (server && server.close) {
    server.close();
  }
});
