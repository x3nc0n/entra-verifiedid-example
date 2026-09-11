'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const session = require('express-session');

const graphService = require('../src/services/graph-service');
const onboardingService = require('../src/services/onboarding-v2-service');
const router = require('../src/routes/v2-onboarding');
const { hashNormalized } = require('../src/services/verified-subject-service');

const employee = {
  id: '11111111-2222-3333-4444-555555555555',
  userPrincipalName: 'employee@tenant.example',
  displayName: 'Employee',
  employeeId: 'EMP-1001',
  accountEnabled: true,
};

const manager = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  mail: 'manager@tenant.example',
  userPrincipalName: 'manager@tenant.example',
};

function createApp(seedSession) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(session({
    secret: 'test-session-secret',
    resave: false,
    saveUninitialized: true,
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

function send(server, method, pathname, { headers = {}, body } = {}) {
  const payload = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        path: pathname,
        method,
        headers: {
          ...(body ? {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          } : {}),
          ...headers,
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
    if (payload) req.write(payload);
    req.end();
  });
}

test('employee invite confirmation rejects a wrong employee ID at the HTTP route', async () => {
  onboardingService.resetForTests();
  const originals = {
    getEmployeeWithManager: graphService.getEmployeeWithManager,
    getEligiblePilotUser: graphService.getEligiblePilotUser,
  };

  graphService.getEmployeeWithManager = async (userPrincipalName) => ({
    ...employee,
    userPrincipalName,
    manager,
  });
  graphService.getEligiblePilotUser = async (userId) => ({
    ...employee,
    id: userId,
  });

  const created = await onboardingService.createManagerInitiatedRequest({
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    employee,
    manager,
    employeeIdHash: hashNormalized(employee.employeeId),
  });
  const preAuth = await onboardingService.activateEmployeeInviteToken(
    created.employeeInviteToken
  );

  const app = createApp((sessionState) => {
    sessionState.v2EmployeeInvitePreAuth = preAuth;
    sessionState.v2Csrf = { 'employee-invite': 'csrf-token' };
  });
  const server = app.listen(0);

  try {
    const response = await send(
      server,
      'POST',
      '/api/v2/onboarding/invitations/confirm',
      {
        headers: { 'x-csrf-token': 'csrf-token' },
        body: {
          userPrincipalName: employee.userPrincipalName,
          employeeId: 'WRONG-ID',
        },
      }
    );

    assert.equal(response.statusCode, 403);
    assert.match(response.body, /did not match this invitation/i);
    const request = await onboardingService.loadRequest(created.record.requestId);
    assert.equal(request.state, 'employee-invited');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(graphService, {
      getEmployeeWithManager: originals.getEmployeeWithManager,
      getEligiblePilotUser: originals.getEligiblePilotUser,
    });
    onboardingService.resetForTests();
  }
});
