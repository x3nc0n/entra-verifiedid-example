'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

require('dotenv').config = () => ({ parsed: {} });
process.env.ONBOARDING_STATE_BACKEND = 'memory';
process.env.AZURE_STORAGE_TABLE_ENDPOINT = '';

process.env.NODE_ENV = 'development';
process.env.DEMO_MODE = 'true';
process.env.SESSION_SECRET = 'dev';
process.env.AZURE_TENANT_ID = '33333333-3333-3333-3333-333333333333';
process.env.V2_TRANSIENT_PROTECTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.V2_USER_ROLE_VALUE = process.env.V2_USER_ROLE_VALUE ||
  'VerifiedId.Onboarding.User';
process.env.V2_ADMIN_ROLE_VALUE = process.env.V2_ADMIN_ROLE_VALUE ||
  'VerifiedId.Onboarding.Admin';

const config = require('../src/config');
const managerAuthService = require('../src/services/manager-auth-service');
const graphService = require('../src/services/graph-service');
const app = require('../src/app');

function listen(server, host) {
  return new Promise((resolve) => {
    server.listen(0, host, () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

function findBrowser() {
  const candidates = [
    process.env.BROWSER_BIN,
    process.platform === 'win32' && path.join(
      process.env.LOCALAPPDATA || '',
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    ),
    process.platform === 'win32' && path.join(
      process.env.ProgramFiles || '',
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    ),
    process.platform === 'win32' && path.join(
      process.env['ProgramFiles(x86)'] || '',
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe'
    ),
    process.platform === 'win32' && path.join(
      process.env.ProgramFiles || '',
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    process.platform === 'darwin' &&
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    process.platform === 'darwin' &&
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.platform !== 'win32' && 'microsoft-edge',
    process.platform !== 'win32' && 'google-chrome',
    process.platform !== 'win32' && 'chromium',
    process.platform !== 'win32' && 'chromium-browser',
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && fs.existsSync(candidate)) {
      return candidate;
    }
    if (!candidate.includes(path.sep)) {
      const probe = spawnSync(candidate, ['--version'], {
        encoding: 'utf8',
        stdio: 'ignore',
      });
      if (probe.status === 0) return candidate;
    }
  }
  return null;
}

function fakeIdentityProvider(appOrigin) {
  return http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://localhost');
    if (requestUrl.pathname !== '/authorize') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const state = requestUrl.searchParams.get('state');
    assert.ok(state, 'fake IdP received an authorization request with state');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(`<!doctype html>
<html>
<body>
  <form id="oidcForm" method="post" action="${appOrigin}/auth/manager/callback">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="code" value="fake-authorization-code">
  </form>
  <script>document.getElementById('oidcForm').submit();</script>
</body>
</html>`);
  });
}

async function main() {
  const browser = findBrowser();
  if (!browser) {
    throw new Error(
      'No Chromium-family browser found. Set BROWSER_BIN to Edge/Chrome/Chromium.'
    );
  }

  const evidence = { callbackWithoutCookie: false, callbackCompleted: false, dashboardWithCookie: false };
  const appServer = http.createServer((req, res) => {
    if (req.url === '/auth/manager/callback') {
      evidence.callbackWithoutCookie = !req.headers.cookie;
      res.on('finish', () => { evidence.callbackCompleted = res.statusCode === 200; });
    }
    if (req.url === '/v2/manager/dashboard') {
      evidence.dashboardWithCookie = Boolean(req.headers.cookie);
    }
    app(req, res);
  });
  const appPort = await listen(appServer, '127.0.0.1');
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const idpServer = fakeIdentityProvider(appOrigin);
  const idpPort = await listen(idpServer, 'localhost');
  const idpOrigin = `http://localhost:${idpPort}`;
  graphService.getUserById = async () => ({
    id: '44444444-4444-4444-4444-444444444444',
    displayName: 'Browser Regression Manager',
    userPrincipalName: 'manager@tenant.example',
  });
  graphService.listDirectReports = async () => [];

  managerAuthService.createAuthorizationRequest = async () => {
    const state = crypto.randomBytes(32).toString('base64url');
    return {
      url: `${idpOrigin}/authorize?state=${encodeURIComponent(state)}`,
      state,
      nonce: 'fake-nonce',
      codeVerifier: 'fake-code-verifier',
    };
  };
  managerAuthService.exchangeAuthorizationCode = async (input) => {
    assert.equal(input.code, 'fake-authorization-code');
    assert.equal(input.state, input.expectedState);
    return {
      objectId: '44444444-4444-4444-4444-444444444444',
      tenantId: config.azure.tenantId,
      displayName: 'Browser Regression Manager',
      roles: [config.selfServiceV2.authorization.userRoleValue],
    };
  };

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-browser-'));
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${userDataDir}`,
        '--virtual-time-budget=10000',
        '--dump-dom',
        `${appOrigin}/auth/manager/dashboard/signin`,
      ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Browser regression exceeded 45 seconds.'));
      }, 45000);
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (status) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, status });
      });
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || `Browser exited with ${result.status}`);
    }
    assert.match(result.stdout, /Manager Dashboard/);
    assert.match(result.stdout, /Signed in as/);
    assert.doesNotMatch(result.stdout, /Sign in with your tenant manager account/);
    assert.deepEqual(evidence, {
      callbackWithoutCookie: true,
      callbackCompleted: true,
      dashboardWithCookie: true,
    });
    console.log('Browser cross-site dashboard auth regression passed.');
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    await Promise.all([close(appServer), close(idpServer)]);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
