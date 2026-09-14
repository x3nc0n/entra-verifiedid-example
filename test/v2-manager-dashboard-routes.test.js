'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const session = require('express-session');

const config = require('../src/config');
const graphService = require('../src/services/graph-service');
const onboardingService = require('../src/services/onboarding-v2-service');
const router = require('../src/routes/v2-manager');

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

test('manager dashboard renders sign-in when no dashboard session exists', async () => {
  const app = createApp();
  const server = app.listen(0);
  try {
    const response = await send(server, 'GET', '/v2/manager/dashboard');
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.view, 'v2-manager-dashboard');
    assert.equal(body.model.authenticated, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('manager invitation rejects employees outside the manager direct reports', async () => {
  const originals = {
    listDirectReports: graphService.listDirectReports,
    requireNativeUser: graphService.requireNativeUser,
    enforceRateLimit: onboardingService.enforceRateLimit,
  };
  graphService.listDirectReports = async () => [{
    id: 'direct-report-1',
    userPrincipalName: 'report@tenant.example',
    displayName: 'Direct Report',
    employeeId: 'EMP-1001',
    accountEnabled: true,
  }];
  graphService.requireNativeUser = async () => true;
  onboardingService.enforceRateLimit = async () => ({ allowed: true, count: 1 });

  const app = createApp((sessionState) => {
    sessionState.v2ManagerDashboard = {
      managerObjectId: 'manager-oid',
      tenantId: 'tenant-id',
      displayName: 'Manager',
      roles: [config.selfServiceV2.authorization.userRoleValue],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    sessionState.v2Csrf = { 'manager-dashboard': 'csrf-token' };
  });
  const server = app.listen(0);

  try {
    const response = await send(server, 'POST', '/api/v2/manager/invitations', {
      headers: { 'x-csrf-token': 'csrf-token' },
      body: { directReportId: 'someone-else' },
    });
    assert.equal(response.statusCode, 403);
    assert.match(response.body, /selected employee is not eligible/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(graphService, {
      listDirectReports: originals.listDirectReports,
      requireNativeUser: originals.requireNativeUser,
    });
    Object.assign(onboardingService, {
      enforceRateLimit: originals.enforceRateLimit,
    });
  }
});

test('manager invitation returns an employee invite link for a direct report', async () => {
  const originals = {
    listDirectReports: graphService.listDirectReports,
    getEligiblePilotUser: graphService.getEligiblePilotUser,
    requireNativeUser: graphService.requireNativeUser,
    enforceRateLimit: onboardingService.enforceRateLimit,
    createManagerInitiatedRequest: onboardingService.createManagerInitiatedRequest,
  };
  graphService.listDirectReports = async () => [{
    id: 'direct-report-1',
    userPrincipalName: 'report@tenant.example',
    displayName: 'Direct Report',
    employeeId: 'EMP-1001',
    accountEnabled: true,
  }];
  graphService.requireNativeUser = async () => true;
  graphService.getEligiblePilotUser = async () => ({ id: 'direct-report-1' });
  onboardingService.enforceRateLimit = async () => ({ allowed: true, count: 1 });
  onboardingService.createManagerInitiatedRequest = async () => ({
    employeeInviteToken: 'employee-token',
    record: { requestId: 'request-1' },
  });

  const app = createApp((sessionState) => {
    sessionState.v2ManagerDashboard = {
      managerObjectId: 'manager-oid',
      tenantId: 'tenant-id',
      displayName: 'Manager',
      roles: [config.selfServiceV2.authorization.userRoleValue],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    sessionState.v2Csrf = { 'manager-dashboard': 'csrf-token' };
  });
  const server = app.listen(0);

  try {
    const response = await send(server, 'POST', '/api/v2/manager/invitations', {
      headers: { 'x-csrf-token': 'csrf-token' },
      body: { directReportId: 'direct-report-1' },
    });
    assert.equal(response.statusCode, 201);
    const body = JSON.parse(response.body);
    assert.equal(body.requestId, 'request-1');
    assert.match(body.inviteUrl, /\/v2\/onboarding\/invite#token=employee-token/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(graphService, {
      listDirectReports: originals.listDirectReports,
      getEligiblePilotUser: originals.getEligiblePilotUser,
      requireNativeUser: originals.requireNativeUser,
    });
    Object.assign(onboardingService, {
      enforceRateLimit: originals.enforceRateLimit,
      createManagerInitiatedRequest: originals.createManagerInitiatedRequest,
    });
  }
});

test('bootstrap eligibility checks use configured direct security group IDs', async () => {
  const originals = {
    adminGroupId: config.selfServiceV2.authorization.adminGroupId,
    usersGroupId: config.selfServiceV2.authorization.usersGroupId,
  };
  config.selfServiceV2.authorization.adminGroupId =
    '11111111-1111-1111-1111-111111111111';
  config.selfServiceV2.authorization.usersGroupId =
    '22222222-2222-2222-2222-222222222222';

  const checks = [];
  try {
    await graphService.requirePortalAdmin('admin-oid', {
      isUserDirectMemberOfGroup: async (userId, groupId) => {
        checks.push({ userId, groupId });
        return true;
      },
    });
    await graphService.requireNativeUser('user-oid', {
      isUserDirectMemberOfGroup: async (userId, groupId) => {
        checks.push({ userId, groupId });
        return true;
      },
    });

    assert.deepEqual(checks, [
      {
        userId: 'admin-oid',
        groupId: '11111111-1111-1111-1111-111111111111',
      },
      {
        userId: 'user-oid',
        groupId: '22222222-2222-2222-2222-222222222222',
      },
    ]);
  } finally {
    config.selfServiceV2.authorization.adminGroupId = originals.adminGroupId;
    config.selfServiceV2.authorization.usersGroupId = originals.usersGroupId;
  }
});

test('admin reset uses portal admin app role session and forwards scoped ETag reset', async () => {
  const originals = {
    adminResetRequest: onboardingService.adminResetRequest,
  };
  let resetInput = null;
  onboardingService.adminResetRequest = async (requestId, input) => {
    resetInput = { requestId, input };
    return {
      requestId,
      state: 'requested',
      updatedAt: '2026-09-14T12:54:49.352-05:00',
    };
  };

  const app = createApp((sessionState) => {
    sessionState.v2PortalAdmin = {
      adminObjectId: 'admin-oid',
      tenantId: 'tenant-id',
      roles: [config.selfServiceV2.authorization.adminRoleValue],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    sessionState.v2Csrf = { 'portal-admin': 'csrf-token' };
  });
  const server = app.listen(0);

  try {
    const response = await send(
      server,
      'POST',
      '/api/v2/admin/requests/onboarding/request-1/reset',
      {
        headers: {
          'x-csrf-token': 'csrf-token',
          'if-match': 'etag-1',
        },
        body: {
          action: 'unblock',
          reason: 'approval session stuck after callback completion',
        },
      }
    );
    assert.equal(response.statusCode, 200);
    assert.deepEqual(resetInput, {
      requestId: 'request-1',
      input: {
        action: 'unblock',
        reason: 'approval session stuck after callback completion',
        etag: 'etag-1',
        adminObjectId: 'admin-oid',
      },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(onboardingService, {
      adminResetRequest: originals.adminResetRequest,
    });
  }
});
