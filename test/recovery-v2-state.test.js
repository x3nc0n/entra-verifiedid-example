'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const {
  InMemoryRecoveryV2Repository,
  createRecoveryV2Service,
} = require('../src/services/recovery-v2-service');

const employee = {
  id: '11111111-2222-3333-4444-555555555555',
  userPrincipalName: 'employee@tenant.example',
  displayName: 'Employee',
  employeeId: 'EMP-1001',
};
const manager = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  mail: 'manager@tenant.example',
};

let original;
let repository;
let service;

test.beforeEach(() => {
  original = {
    recovery: structuredClone(config.selfServiceV2.recovery),
    protectionKey: config.selfServiceV2.protectionKey,
  };
  config.selfServiceV2.protectionKey = Buffer.alloc(32, 5).toString('base64');
  config.selfServiceV2.recovery.requestLifetimeMinutes = 60;
  config.selfServiceV2.recovery.maxPresentationRetries = 3;
  config.selfServiceV2.recovery.maxVerificationFailures = 2;
  config.selfServiceV2.recovery.maxPasskeyConfirmAttempts = 3;
  repository = new InMemoryRecoveryV2Repository();
  service = createRecoveryV2Service(repository);
});

test.afterEach(() => {
  config.selfServiceV2.recovery = original.recovery;
  config.selfServiceV2.protectionKey = original.protectionKey;
});

test('recovery requests revoke existing passkeys before issuing a replacement TAP', async () => {
  const created = await service.createRecoveryRequest({
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    employee,
    manager,
    employeeIdHash: 'employee-id-hash',
  });
  await service.markManagerNotified(created.record.requestId, 'test');
  const activation = await service.activateManagerToken(created.managerToken);
  await service.redeemManagerToken({
    ...activation,
    managerObjectId: manager.id,
    tenantId: created.record.tenantId,
  });
  await service.decide(created.record.requestId, manager.id, 'approve');
  await service.beginPresentation(created.record.requestId, {
    state: 'presentation-state',
  });
  await service.attachPresentationRequest(created.record.requestId, {
    state: 'presentation-state',
    requestId: 'presentation-request',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await service.handlePresentationRetrieved(created.record.requestId);
  await service.markVerified(created.record.requestId, {
    issuer: 'did:web:tenant.example',
    credentialType: 'EmployeeOnboardingV2',
    linkedDomain: 'tenant.example',
  });

  let operationCalls = 0;
  const result = await service.revokePasskeysAndIssueTap(
    created.record.requestId,
    async (request) => {
      operationCalls += 1;
      assert.equal(request.state, 'passkeys-revoked');
      return {
        revokedMethodIds: ['existing-key'],
        tap: {
          id: 'tap-method',
          temporaryAccessPass: 'replacement-tap',
          lifetimeInMinutes: 30,
          createdDateTime: new Date().toISOString(),
        },
      };
    }
  );

  assert.equal(operationCalls, 1);
  assert.equal(result.request.state, 'tap-issued');
  assert.deepEqual(JSON.parse((await repository.getRequest(created.record.requestId)).revokedMethodIdsJson), ['existing-key']);

  const tap = await service.takeTapForDisplay(created.record.requestId);
  assert.equal(tap.tap, 'replacement-tap');
  await assert.rejects(
    service.takeTapForDisplay(created.record.requestId),
    (err) => err.code === 'tap_already_displayed'
  );

  await assert.rejects(
    service.confirmPasskey(created.record.requestId, [{ id: 'existing-key' }]),
    (err) => err.code === 'passkey_not_found'
  );
  const registered = await service.confirmPasskey(created.record.requestId, [
    { id: 'existing-key' },
    { id: 'replacement-key' },
  ]);
  assert.equal(registered.state, 'passkey-registered');
  assert.equal((await service.complete(created.record.requestId)).state, 'complete');
});

test('recovery verification failures lock the request after the configured limit', async () => {
  const created = await service.createRecoveryRequest({
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    employee,
    manager,
    employeeIdHash: 'employee-id-hash',
  });
  await service.markManagerNotified(created.record.requestId, 'test');
  const activation = await service.activateManagerToken(created.managerToken);
  await service.redeemManagerToken({
    ...activation,
    managerObjectId: manager.id,
    tenantId: created.record.tenantId,
  });
  await service.decide(created.record.requestId, manager.id, 'approve');
  await service.beginPresentation(created.record.requestId, {
    state: 'presentation-state',
  });
  await service.attachPresentationRequest(created.record.requestId, {
    state: 'presentation-state',
    requestId: 'presentation-request',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await service.handlePresentationRetrieved(created.record.requestId);

  await service.recordVerificationFailure(created.record.requestId, 'mismatch');
  const locked = await service.recordVerificationFailure(created.record.requestId, 'mismatch');
  assert.equal(locked.state, 'locked');
  assert.equal(locked.verificationFailureCount, 2);
});

test('recovery rate limits are durable per-scope counters', async () => {
  assert.equal(
    (await service.enforceRateLimit('recovery-upn', 'employee@tenant.example', 2)).allowed,
    true
  );
  assert.equal(
    (await service.enforceRateLimit('recovery-upn', 'employee@tenant.example', 2)).allowed,
    true
  );
  assert.equal(
    (await service.enforceRateLimit('recovery-upn', 'employee@tenant.example', 2)).allowed,
    false
  );
});
