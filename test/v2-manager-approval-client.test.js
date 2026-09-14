'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(
  path.join(__dirname, '../src/public/js/v2-manager-approval.js'), 'utf8'
);

async function run({ hash = '', statusPresent = true, fetchImpl } = {}) {
  const status = { textContent: 'Validating the approval link...' };
  const calls = [];
  const redirects = [];
  let scrubbed = false;
  let timeout;
  let timeoutMs;
  let cleared = false;
  const listeners = {};
  const location = { hash, pathname: '/v2/manager/approval',
    replace: (url) => redirects.push(url) };
  vm.runInNewContext(script, {
    document: {
      getElementById: (id) => id === 'managerApprovalPanel'
        ? { dataset: {} }
        : id === 'managerActivationStatus' && statusPresent ? status : null,
      querySelector: () => ({ content: 'csrf-test' }),
    },
    window: {
      location,
      history: { replaceState: () => { scrubbed = true; location.hash = ''; } },
      addEventListener: (event, callback) => { listeners[event] = callback; },
    },
    URLSearchParams,
    AbortController,
    setTimeout: (callback, ms) => { timeout = callback; timeoutMs = ms; return 1; },
    clearTimeout: () => { cleared = true; },
    fetch: async (url, options) => {
      calls.push({ url, options, scrubbed });
      return fetchImpl ? fetchImpl(options) : { ok: true };
    },
  });
  await new Promise(setImmediate);
  return { status, calls, redirects, timeout, timeoutMs, isCleared: () => cleared,
    changeHash: (hash) => { location.hash = hash; listeners.hashchange(); } };
}

test('bare approval URL exits loading without making a request', async () => {
  const result = await run();
  assert.match(result.status.textContent, /No approval link/);
  assert.equal(result.calls.length, 0);
});

test('activated/authenticated page without activation status is left alone', async () => {
  const result = await run({ statusPresent: false, hash: '#token=unused' });
  assert.equal(result.calls.length, 0);
  assert.equal(result.redirects.length, 0);
});

test('valid activation scrubs fragment, sends CSRF, and redirects', async () => {
  const result = await run({ hash: '#token=test-token' });
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].scrubbed, true);
  assert.equal(result.calls[0].options.headers['x-csrf-token'], 'csrf-test');
  assert.equal(JSON.parse(result.calls[0].options.body).token, 'test-token');
  assert.deepEqual(result.redirects, ['/auth/manager/signin']);
  assert.equal(result.isCleared(), true);
});

test('expired and server-error responses stop loading without redirecting', async () => {
  for (const status of [410, 403, 500]) {
    const result = await run({
      hash: '#token=test-token', fetchImpl: async () => ({ ok: false, status }),
    });
    assert.doesNotMatch(result.status.textContent, /Validating/);
    assert.match(result.status.textContent, status === 410 ? /already used/ : /could not be validated/);
    assert.equal(result.redirects.length, 0);
    assert.equal(result.isCleared(), true);
  }
});

test('network failure gives a recoverable message without replaying token', async () => {
  const result = await run({
    hash: '#token=test-token', fetchImpl: async () => { throw new TypeError('offline'); },
  });
  assert.match(result.status.textContent, /could not connect/);
  assert.equal(result.calls.length, 1);
  assert.equal(result.isCleared(), true);
});

test('hung activation aborts after 15 seconds and stops loading', async () => {
  const result = await run({
    hash: '#token=test-token',
    fetchImpl: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  assert.equal(result.timeoutMs, 15000);
  result.timeout();
  await new Promise(setImmediate);
  assert.match(result.status.textContent, /timed out/);
  assert.equal(result.calls.length, 1);
  assert.equal(result.redirects.length, 0);
  assert.equal(result.isCleared(), true);
});

test('token-bearing same-document navigation starts activation', async () => {
  const result = await run();
  assert.equal(result.calls.length, 0);
  result.changeHash('#token=new-link');
  await new Promise(setImmediate);
  assert.equal(result.calls.length, 1);
  assert.equal(JSON.parse(result.calls[0].options.body).token, 'new-link');
  assert.deepEqual(result.redirects, ['/auth/manager/signin']);
});

test('hash changes do not duplicate an in-flight activation', async () => {
  let finish;
  const result = await run({
    hash: '#token=first-link',
    fetchImpl: () => new Promise((resolve) => { finish = resolve; }),
  });
  result.changeHash('#token=first-link');
  result.changeHash('#token=first-link');
  assert.equal(result.calls.length, 1);
  finish({ ok: true });
  await new Promise(setImmediate);
  assert.deepEqual(result.redirects, ['/auth/manager/signin']);
});
