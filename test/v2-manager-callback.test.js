'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const session = require('express-session');

const config = require('../src/config');
const graphService = require('../src/services/graph-service');
const managerAuthService = require('../src/services/manager-auth-service');
const onboardingService = require('../src/services/onboarding-v2-service');
const router = require('../src/routes/v2-manager');

function createApp(seedSession, store) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(session({
    secret: 'test-session-secret',
    resave: false,
    saveUninitialized: true,
    store,
  }));
  app.use((req, res, next) => {
    if (typeof seedSession === 'function') {
      seedSession(req.session, req);
    }
    res.render = (view, model) => res.json({ view, model });
    next();
  });
  app.use(router);
  return app;
}

function sendForm(server, pathname, formData) {
  const body = new URLSearchParams(formData).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseBody = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseBody,
        }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

test('manager callback redeems when live Graph manager matches the signed-in oid', async () => {
  const originals = {
    loadManagerAuthFlow: onboardingService.loadManagerAuthFlow,
    redeemManagerToken: onboardingService.redeemManagerToken,
    recordManagerRedemptionFailure: onboardingService.recordManagerRedemptionFailure,
    exchangeAuthorizationCode: managerAuthService.exchangeAuthorizationCode,
    getEmployeeWithManager: graphService.getEmployeeWithManager,
    requireNativeUser: graphService.requireNativeUser,
  };

  let redeemInput = null;
  let redemptionFailure = null;
  onboardingService.loadManagerAuthFlow = async () => ({
    nonce: 'expected-nonce',
    codeVerifier: 'expected-verifier',
    request: {
      requestId: '11111111-2222-3333-4444-555555555555',
      correlationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      employeeObjectId: '12345678-1234-1234-1234-1234567890ab',
      employeeUserPrincipalName: 'employee@tenant.example',
      managerObjectId: '99999999-9999-9999-9999-999999999999',
      managerTokenHash: 'a'.repeat(64),
      managerAuthState: 'expected-state',
    },
  });
  managerAuthService.exchangeAuthorizationCode = async () => ({
    objectId: '99999999-9999-9999-9999-999999999999',
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    displayName: 'Manager',
    roles: [config.selfServiceV2.authorization.userRoleValue],
  });
  graphService.getEmployeeWithManager = async () => ({
    id: '12345678-1234-1234-1234-1234567890ab',
    manager: { id: '99999999-9999-9999-9999-999999999999' },
  });
  graphService.requireNativeUser = async () => true;
  onboardingService.redeemManagerToken = async (input) => {
    redeemInput = input;
  };
  onboardingService.recordManagerRedemptionFailure = async (requestId, code) => {
    redemptionFailure = { requestId, code };
  };

  const app = createApp();
  const server = app.listen(0);

  try {
    const response = await sendForm(server, '/auth/manager/callback', {
      state: 'state-from-idp',
      code: 'authorization-code',
    });

    // The IdP callback is a genuine cross-site, top-level POST
    // (response_mode=form_post); a same-origin redirect issued from this
    // same response would still be treated as part of that cross-site
    // chain, so a SameSite=Strict session cookie would be withheld. The
    // handler instead ends the chain here with a same-origin 200
    // completion page whose own follow-up navigation (script or link)
    // carries the cookie normally.
    assert.equal(response.statusCode, 200);
    const parsed = JSON.parse(response.body);
    assert.equal(parsed.view, 'v2-manager-callback-complete');
    assert.equal(parsed.model.continueHref, '/v2/manager/approval');
    assert.match(response.headers['set-cookie'].join('\n'), /connect\.sid=/);
    assert.deepEqual(redemptionFailure, null);
    assert.equal(redeemInput.requestId, '11111111-2222-3333-4444-555555555555');
    assert.equal(
      redeemInput.managerObjectId,
      '99999999-9999-9999-9999-999999999999'
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(onboardingService, {
      loadManagerAuthFlow: originals.loadManagerAuthFlow,
      redeemManagerToken: originals.redeemManagerToken,
      recordManagerRedemptionFailure: originals.recordManagerRedemptionFailure,
    });
    Object.assign(managerAuthService, {
      exchangeAuthorizationCode: originals.exchangeAuthorizationCode,
    });
    Object.assign(graphService, {
      getEmployeeWithManager: originals.getEmployeeWithManager,
      requireNativeUser: originals.requireNativeUser,
    });
  }
});

test('manager callback treats a session-persistence failure as distinct from an authorization rejection', async () => {
  const originals = {
    loadManagerAuthFlow: onboardingService.loadManagerAuthFlow,
    redeemManagerToken: onboardingService.redeemManagerToken,
    recordManagerRedemptionFailure: onboardingService.recordManagerRedemptionFailure,
    exchangeAuthorizationCode: managerAuthService.exchangeAuthorizationCode,
    getEmployeeWithManager: graphService.getEmployeeWithManager,
    requireNativeUser: graphService.requireNativeUser,
  };

  let redeemInput = null;
  let redemptionFailureCalled = false;
  onboardingService.loadManagerAuthFlow = async () => ({
    nonce: 'expected-nonce',
    codeVerifier: 'expected-verifier',
    request: {
      requestId: '11111111-2222-3333-4444-555555555555',
      correlationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      employeeObjectId: '12345678-1234-1234-1234-1234567890ab',
      employeeUserPrincipalName: 'employee@tenant.example',
      managerObjectId: '99999999-9999-9999-9999-999999999999',
      managerTokenHash: 'a'.repeat(64),
      managerAuthState: 'expected-state',
    },
  });
  managerAuthService.exchangeAuthorizationCode = async () => ({
    objectId: '99999999-9999-9999-9999-999999999999',
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    displayName: 'Manager',
    roles: [config.selfServiceV2.authorization.userRoleValue],
  });
  graphService.getEmployeeWithManager = async () => ({
    id: '12345678-1234-1234-1234-1234567890ab',
    manager: { id: '99999999-9999-9999-9999-999999999999' },
  });
  graphService.requireNativeUser = async () => true;
  onboardingService.redeemManagerToken = async (input) => {
    redeemInput = input;
  };
  onboardingService.recordManagerRedemptionFailure = async () => {
    redemptionFailureCalled = true;
  };

  let attemptedSession = null;
  class FailingManagerStore extends session.MemoryStore {
    set(sid, value, callback) {
      if (value.v2Manager) {
        attemptedSession = value;
        return callback(new Error('session store unavailable'));
      }
      return super.set(sid, value, callback);
    }
  }
  const app = createApp(null, new FailingManagerStore());
  const server = app.listen(0);

  try {
    const response = await sendForm(server, '/auth/manager/callback', {
      state: 'state-from-idp',
      code: 'authorization-code',
    });

    // The one-shot token was already redeemed successfully; a failure to
    // persist the resulting session must not be reported as (or recorded
    // as) an authorization rejection, and must not be a silent/ambiguous
    // "no token" state either.
    assert.equal(response.statusCode, 503);
    assert.equal(redeemInput.requestId, '11111111-2222-3333-4444-555555555555');
    assert.equal(redemptionFailureCalled, false);
    assert.equal(attemptedSession.v2Manager.requestId, redeemInput.requestId);
    assert.ok(attemptedSession.v2Csrf.manager);
    assert.equal(response.headers['set-cookie'], undefined);
    const parsed = JSON.parse(response.body);
    assert.equal(parsed.view, 'v2-manager-approval');
    assert.match(parsed.model.error, /session could not be saved/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(onboardingService, {
      loadManagerAuthFlow: originals.loadManagerAuthFlow,
      redeemManagerToken: originals.redeemManagerToken,
      recordManagerRedemptionFailure: originals.recordManagerRedemptionFailure,
    });
    Object.assign(managerAuthService, {
      exchangeAuthorizationCode: originals.exchangeAuthorizationCode,
    });
    Object.assign(graphService, {
      getEmployeeWithManager: originals.getEmployeeWithManager,
      requireNativeUser: originals.requireNativeUser,
    });
  }
});

test('manager callback records mismatch diagnostics after a genuine authorization failure', async () => {
  const originals = {
    loadManagerAuthFlow: onboardingService.loadManagerAuthFlow,
    redeemManagerToken: onboardingService.redeemManagerToken,
    recordManagerRedemptionFailure: onboardingService.recordManagerRedemptionFailure,
    exchangeAuthorizationCode: managerAuthService.exchangeAuthorizationCode,
    getEmployeeWithManager: graphService.getEmployeeWithManager,
    warn: console.warn,
  };

  let recordedFailure = null;
  const warnings = [];
  onboardingService.loadManagerAuthFlow = async () => ({
    nonce: 'expected-nonce',
    codeVerifier: 'expected-verifier',
    request: {
      requestId: '11111111-2222-3333-4444-555555555555',
      correlationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
      employeeObjectId: '12345678-1234-1234-1234-1234567890ab',
      employeeUserPrincipalName: 'employee@tenant.example',
      managerObjectId: '99999999-9999-9999-9999-999999999999',
      managerTokenHash: 'a'.repeat(64),
      managerAuthState: 'expected-state',
    },
  });
  managerAuthService.exchangeAuthorizationCode = async () => ({
    objectId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    roles: [config.selfServiceV2.authorization.userRoleValue],
  });
  onboardingService.redeemManagerToken = async () => {
    throw new onboardingService.V2StateError(
      'The signed-in manager is not authorized for this request.',
      'manager_not_authorized',
      403
    );
  };
  onboardingService.recordManagerRedemptionFailure = async (requestId, code) => {
    recordedFailure = { requestId, code };
  };
  graphService.getEmployeeWithManager = async () => ({
    id: '12345678-1234-1234-1234-1234567890ab',
    manager: {
      id: 'cccccccc-1111-2222-3333-dddddddddddd',
    },
  });
  console.warn = (message) => warnings.push(message);

  const app = createApp();
  const server = app.listen(0);

  try {
    const response = await sendForm(server, '/auth/manager/callback', {
      state: 'state-from-idp',
      code: 'authorization-code',
    });

    assert.equal(response.statusCode, 403);
    assert.deepEqual(recordedFailure, {
      requestId: '11111111-2222-3333-4444-555555555555',
      code: 'manager_not_authorized',
    });
    assert.match(warnings.join('\n'), /Manager callback authorization mismatch/);
    assert.doesNotMatch(warnings.join('\n'), /aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb/);
    assert.doesNotMatch(warnings.join('\n'), /cccccccc-1111-2222-3333-dddddddddddd/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(onboardingService, {
      loadManagerAuthFlow: originals.loadManagerAuthFlow,
      redeemManagerToken: originals.redeemManagerToken,
      recordManagerRedemptionFailure: originals.recordManagerRedemptionFailure,
    });
    Object.assign(managerAuthService, {
      exchangeAuthorizationCode: originals.exchangeAuthorizationCode,
    });
    Object.assign(graphService, {
      getEmployeeWithManager: originals.getEmployeeWithManager,
    });
    console.warn = originals.warn;
  }
});

test('manager dashboard callback creates an authenticated dashboard session', async () => {
  const originals = {
    exchangeAuthorizationCode: managerAuthService.exchangeAuthorizationCode,
    getUserById: graphService.getUserById,
    requireNativeUser: graphService.requireNativeUser,
    protectionKey: config.selfServiceV2.protectionKey,
  };
  config.selfServiceV2.protectionKey = Buffer.alloc(32, 9).toString('base64');

  managerAuthService.exchangeAuthorizationCode = async () => ({
    objectId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    displayName: 'Manager',
    roles: [config.selfServiceV2.authorization.userRoleValue],
  });
  graphService.getUserById = async () => ({
    id: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    displayName: 'Manager',
    userPrincipalName: 'manager@tenant.example',
  });
  graphService.requireNativeUser = async () => true;
  await onboardingService.createDashboardAuthTransaction({
    state: 'dashboard-state',
    nonce: 'expected-nonce',
    codeVerifier: 'expected-verifier',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, 'dashboard');

  const app = createApp();
  const server = app.listen(0);

  try {
    const response = await sendForm(server, '/auth/manager/callback', {
      state: 'dashboard-state',
      code: 'authorization-code',
    });

    assert.equal(response.statusCode, 200);
    const parsed = JSON.parse(response.body);
    assert.equal(parsed.view, 'v2-manager-callback-complete');
    assert.equal(parsed.model.continueHref, '/v2/manager/dashboard');
    assert.match(response.headers['set-cookie'].join('\n'), /connect\.sid=/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(managerAuthService, {
      exchangeAuthorizationCode: originals.exchangeAuthorizationCode,
    });
    Object.assign(graphService, {
      getUserById: originals.getUserById,
      requireNativeUser: originals.requireNativeUser,
    });
    config.selfServiceV2.protectionKey = originals.protectionKey;
  }
});

test('admin dashboard callback requires the portal admin app role', async () => {
  const originals = {
    exchangeAuthorizationCode: managerAuthService.exchangeAuthorizationCode,
    getUserById: graphService.getUserById,
    protectionKey: config.selfServiceV2.protectionKey,
  };
  config.selfServiceV2.protectionKey = Buffer.alloc(32, 9).toString('base64');

  managerAuthService.exchangeAuthorizationCode = async () => ({
    objectId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    displayName: 'Portal Admin',
    roles: [config.selfServiceV2.authorization.adminRoleValue],
  });
  graphService.getUserById = async () => ({
    id: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    displayName: 'Portal Admin',
    userPrincipalName: 'admin@tenant.example',
  });
  await onboardingService.createDashboardAuthTransaction({
    state: 'admin-state',
    nonce: 'expected-nonce',
    codeVerifier: 'expected-verifier',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }, 'admin');

  const app = createApp();
  const server = app.listen(0);

  try {
    const response = await sendForm(server, '/auth/manager/callback', {
      state: 'admin-state',
      code: 'authorization-code',
    });

    assert.equal(response.statusCode, 200);
    const parsed = JSON.parse(response.body);
    assert.equal(parsed.view, 'v2-manager-callback-complete');
    assert.equal(parsed.model.continueHref, '/v2/admin');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(managerAuthService, {
      exchangeAuthorizationCode: originals.exchangeAuthorizationCode,
    });
    Object.assign(graphService, {
      getUserById: originals.getUserById,
    });
    config.selfServiceV2.protectionKey = originals.protectionKey;
  }
});
