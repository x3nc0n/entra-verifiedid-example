'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const graphService = require('../src/services/graph-service');
const {
  AzureTableSessionStore,
  sessionRowKey,
} = require('../src/services/table-session-store');
const {
  extractInvitationToken,
  activateFromCurrentFragment,
} = require('../src/public/js/invitation');

function callStore(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (err, value) => err ? reject(err) : resolve(value));
  });
}

test('extracts and clears fragment token before posting it in a JSON body', async () => {
  const requests = [];
  const location = {
    hash: '#token=opaque-secret',
    pathname: '/onboarding/invite',
    search: '',
    replace(value) {
      this.replacedWith = value;
    },
  };
  const history = {
    replaceState(_state, _title, value) {
      location.hash = '';
      location.clearedTo = value;
    },
  };

  const result = await activateFromCurrentFragment({
    location,
    history,
    fetch: async (url, options) => {
      requests.push({ url, options, fragmentAtRequest: location.hash });
      return { ok: true };
    },
  });

  assert.equal(extractInvitationToken('#token=opaque-secret'), 'opaque-secret');
  assert.equal(requests[0].url, '/onboarding/invite/activate');
  assert.equal(requests[0].fragmentAtRequest, '');
  assert.deepEqual(JSON.parse(requests[0].options.body), { token: 'opaque-secret' });
  assert.equal(location.clearedTo, '/onboarding/invite');
  assert.equal(location.replacedWith, '/onboarding/invite');
  assert.equal(result.activated, true);
});

test('contains no token-bearing invitation path or query contract', () => {
  const onboardingRoute = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'onboarding.js'),
    'utf8'
  );
  const invitationRoute = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'invitations.js'),
    'utf8'
  );

  assert.doesNotMatch(onboardingRoute, /invite\/:token/);
  assert.match(invitationRoute, /\/onboarding\/invite#token=/);
  assert.doesNotMatch(invitationRoute, /\/onboarding\/invite\/\$\{/);
});

test('reloads eligibility before creating a TAP and never accepts a browser-selected user', async () => {
  const calls = [];
  const result = await graphService.createTemporaryAccessPassForPilotUser(
    '11111111-2222-3333-4444-555555555555',
    {
      getEligiblePilotUser: async (userId) => {
        calls.push(['reload-eligibility', userId]);
        return { id: userId, accountEnabled: true };
      },
      createTemporaryAccessPass: async (userId) => {
        calls.push(['create-tap', userId]);
        return { temporaryAccessPass: 'test-only' };
      },
    }
  );

  assert.deepEqual(calls.map(([name]) => name), [
    'reload-eligibility',
    'create-tap',
  ]);
  assert.equal(result.user.id, '11111111-2222-3333-4444-555555555555');
});

test('requires enabled account and current pilot group membership', async () => {
  await assert.rejects(
    graphService.getEligiblePilotUser('user-id', {
      pilotGroupId: 'group-id',
      getUserById: async () => ({ id: 'user-id', accountEnabled: false }),
      isUserInGroup: async () => true,
    }),
    (err) => err.code === 'account_disabled'
  );

  await assert.rejects(
    graphService.getEligiblePilotUser('user-id', {
      pilotGroupId: 'group-id',
      getUserById: async () => ({ id: 'user-id', accountEnabled: true }),
      isUserInGroup: async () => false,
    }),
    (err) => err.code === 'pilot_group_required'
  );
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
    onboardingState: { step: 'tap' },
  };

  await callStore(store, 'set', 'raw-session-id', value);
  assert.equal(entities.has(`session:${sessionRowKey('raw-session-id')}`), true);
  assert.deepEqual(await callStore(store, 'get', 'raw-session-id'), value);
  await callStore(store, 'touch', 'raw-session-id', {
    cookie: { originalMaxAge: 120_000 },
    onboardingState: { step: 'stale' },
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
  }
});

test('keeps cloud defaults non-demo and provisions durable table state', () => {
  const mainBicep = fs.readFileSync(
    path.join(__dirname, '..', 'infra', 'main.bicep'),
    'utf8'
  );
  const storageBicep = fs.readFileSync(
    path.join(__dirname, '..', 'infra', 'modules', 'storage.bicep'),
    'utf8'
  );
  const deployWorkflow = fs.readFileSync(
    path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml'),
    'utf8'
  );
  const arm = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'azuredeploy.json'),
    'utf8'
  ));

  assert.match(mainBicep, /param demoMode bool = false/);
  assert.equal(arm.parameters.demoMode.defaultValue, false);
  assert.match(deployWorkflow, /DEMO_MODE=false/g);
  assert.match(storageBicep, /onboardingInvitations/);
  assert.match(storageBicep, /onboardingSessions/);
  assert.match(
    storageBicep,
    /0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3/
  );
  assert.match(storageBicep, /scope: invitationTable/);
  assert.match(storageBicep, /scope: sessionTable/);
  assert.doesNotMatch(storageBicep, /scope: storageAccount/);
  const tableRoleAssignments = arm.resources.filter(
    (resource) =>
      resource.type === 'Microsoft.Authorization/roleAssignments' &&
      resource.properties.roleDefinitionId.includes(
        '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
      )
  );
  assert.equal(tableRoleAssignments.length, 2);
  assert.ok(tableRoleAssignments.some(
    (resource) => resource.scope.includes('onboardingInvitations')
  ));
  assert.ok(tableRoleAssignments.some(
    (resource) => resource.scope.includes('onboardingSessions')
  ));
  assert.doesNotMatch(storageBicep, /listKeys\(\)/);
});
