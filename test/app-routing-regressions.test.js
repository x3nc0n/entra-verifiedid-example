'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');

function purgeProjectModules() {
  const projectSrc = `${projectRoot}${path.sep}src${path.sep}`;
  for (const modulePath of Object.keys(require.cache)) {
    if (modulePath.startsWith(projectSrc)) {
      delete require.cache[modulePath];
    }
  }
}

function loadFreshApp() {
  const originalEnv = { ...process.env };
  process.env.DEMO_MODE = 'true';
  process.env.NODE_ENV = 'development';
  process.env.SESSION_SECRET = 'test-session-secret';
  process.env.V2_TRANSIENT_PROTECTION_KEY =
    Buffer.alloc(32, 7).toString('base64');
  purgeProjectModules();
  const app = require('../src/app');
  return {
    app,
    restore() {
      purgeProjectModules();
      process.env = originalEnv;
    },
  };
}

function request(server, pathname) {
  return new Promise((resolve, reject) => {
    http.get(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: pathname,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          body,
        }));
      }
    ).on('error', reject);
  });
}

test('removed v1 routes return the dedicated 404 page instead of 500', async () => {
  const { app, restore } = loadFreshApp();
  const server = app.listen(0);
  try {
    for (const pathname of [
      '/onboarding',
      '/onboarding/invite',
      '/recovery',
      '/recovery/invite',
    ]) {
      const response = await request(server, pathname);
      assert.equal(response.statusCode, 404, pathname);
      assert.match(response.body, /Page Not Found/);
      assert.match(response.body, /Return to onboarding/);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restore();
  }
});
