'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const session = require('express-session');

const graphService = require('../src/services/graph-service');
const managerAuthService = require('../src/services/manager-auth-service');
const onboardingService = require('../src/services/onboarding-v2-service');
const router = require('../src/routes/v2-manager');

function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(session({
    secret: 'test-session-secret',
    resave: false,
    saveUninitialized: true,
  }));
  app.use((req, res, next) => {
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
    objectId: 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb',
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    displayName: 'Manager',
  });
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

    assert.equal(response.statusCode, 302);
    assert.equal(response.headers.location, '/v2/manager/approval');
    assert.deepEqual(redemptionFailure, null);
    assert.equal(redeemInput.requestId, '11111111-2222-3333-4444-555555555555');
    assert.equal(
      redeemInput.managerObjectId,
      'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb'
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
