'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const {
  AzureTableSessionStore,
  sessionRowKey,
} = require('../src/services/table-session-store');
const { setV2SecurityHeaders } = require('../src/middleware/v2-security');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function callStore(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (err, value) => err ? reject(err) : resolve(value));
  });
}

test('sets no-store and CSP security headers globally', () => {
  const headers = new Map();
  setV2SecurityHeaders(
    {},
    { set(name, value) { headers.set(name, value); } },
    () => {}
  );

  assert.equal(headers.get('Cache-Control'), 'no-store');
  assert.equal(headers.get('Pragma'), 'no-cache');
  assert.equal(headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(headers.get('X-Frame-Options'), 'DENY');
});

test('persists shared Express sessions through the table client', async () => {
  const entities = new Map();
  const client = {
    async getEntity(partitionKey, rowKey) {
      const entity = entities.get(`${partitionKey}:${rowKey}`);
      if (!entity) throw Object.assign(new Error('not found'), { statusCode: 404 });
      return entity;
    },
    async upsertEntity(entity) {
      entities.set(`${entity.partitionKey}:${entity.rowKey}`, entity);
    },
    async updateEntity(entity) {
      const key = `${entity.partitionKey}:${entity.rowKey}`;
      const current = entities.get(key);
      if (!current) throw Object.assign(new Error('not found'), { statusCode: 404 });
      entities.set(key, { ...current, ...entity });
    },
    async deleteEntity(partitionKey, rowKey) {
      entities.delete(`${partitionKey}:${rowKey}`);
    },
  };
  const store = new AzureTableSessionStore({ client });
  const value = {
    cookie: {
      expires: new Date(Date.now() + 60_000).toISOString(),
      originalMaxAge: 60_000,
    },
    v2Employee: { requestId: 'request-id' },
  };

  await callStore(store, 'set', 'raw-session-id', value);
  assert.equal(entities.has(`session:${sessionRowKey('raw-session-id')}`), true);
  assert.deepEqual(await callStore(store, 'get', 'raw-session-id'), value);
  await callStore(store, 'touch', 'raw-session-id', {
    cookie: { originalMaxAge: 120_000 },
    v2Employee: { requestId: 'stale' },
  });
  assert.deepEqual(await callStore(store, 'get', 'raw-session-id'), value);
  await callStore(store, 'destroy', 'raw-session-id');
  assert.equal(await callStore(store, 'get', 'raw-session-id'), null);
});

test('blocks unsafe production and non-demo in-memory startup modes', () => {
  const original = {
    nodeEnv: config.nodeEnv,
    demoMode: config.demoMode,
    appBaseUrl: config.appBaseUrl,
    backend: config.storage.backend,
    tableEndpoint: config.storage.tableEndpoint,
    pilotGroupId: config.graph.pilotGroupId,
    sessionTableName: config.storage.sessionTableName,
    v2RequestTableName: config.storage.v2RequestTableName,
    tenantId: config.azure.tenantId,
    managerClientId: config.selfServiceV2.managerOidc.clientId,
    managerClientSecret: config.selfServiceV2.managerOidc.clientSecret,
    managerRedirectUri: config.selfServiceV2.managerOidc.redirectUri,
    verifiedId: structuredClone(config.selfServiceV2.verifiedId),
    protectionKey: config.selfServiceV2.protectionKey,
  };

  try {
    config.nodeEnv = 'production';
    config.demoMode = true;
    config.appBaseUrl = 'https://portal.example';
    assert.throws(
      () => config.validateRuntimeConfiguration(),
      /DEMO_MODE must be false/
    );

    config.nodeEnv = 'development';
    config.demoMode = false;
    config.storage.backend = 'memory';
    config.graph.pilotGroupId = '11111111-2222-3333-4444-555555555555';
    config.storage.tableEndpoint = 'https://storage.example.table.core.windows.net';
    config.storage.sessionTableName = 'onboardingSessions';
    config.storage.v2RequestTableName = 'onboardingV2Requests';
    config.azure.tenantId = '11111111-2222-3333-4444-555555555555';
    config.selfServiceV2.managerOidc.clientId = 'manager-client-id';
    config.selfServiceV2.managerOidc.clientSecret = 'manager-secret';
    config.selfServiceV2.managerOidc.redirectUri = 'https://portal.example/auth/manager/callback';
    Object.assign(config.selfServiceV2.verifiedId, {
      authority: 'did:web:verifiedid.tenant.example:authority',
      manifestUrl: 'https://verifiedid.did.msidentity.com/manifest',
      credentialType: 'EmployeeOnboardingV2',
      objectIdClaim: 'employee.objectId',
      employeeIdClaim: 'employee.employeeId',
      linkedDomain: 'tenant.example',
      callbackApiKey: 'callback-key',
    });
    config.selfServiceV2.protectionKey = Buffer.alloc(32, 1).toString('base64');
    assert.throws(
      () => config.validateRuntimeConfiguration(),
      /ONBOARDING_STATE_BACKEND=azure-table/
    );
  } finally {
    config.nodeEnv = original.nodeEnv;
    config.demoMode = original.demoMode;
    config.appBaseUrl = original.appBaseUrl;
    config.storage.backend = original.backend;
    config.storage.tableEndpoint = original.tableEndpoint;
    config.graph.pilotGroupId = original.pilotGroupId;
    config.storage.sessionTableName = original.sessionTableName;
    config.storage.v2RequestTableName = original.v2RequestTableName;
    config.azure.tenantId = original.tenantId;
    config.selfServiceV2.managerOidc.clientId = original.managerClientId;
    config.selfServiceV2.managerOidc.clientSecret = original.managerClientSecret;
    config.selfServiceV2.managerOidc.redirectUri = original.managerRedirectUri;
    config.selfServiceV2.verifiedId = original.verifiedId;
    config.selfServiceV2.protectionKey = original.protectionKey;
  }
});

test('renders 404 and error handlers from the dedicated status view', () => {
  const appSource = read('src/app.js');
  const statusView = read('src/views/status.ejs');

  assert.match(appSource, /render\('status'/);
  assert.doesNotMatch(appSource, /render\('index'/);
  assert.match(statusView, /typeof error !== 'undefined'/);
  assert.match(appSource, /Return to onboarding/);
  assert.match(appSource, /Restart onboarding/);
});
