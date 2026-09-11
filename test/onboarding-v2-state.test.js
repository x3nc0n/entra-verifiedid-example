'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const {
  InMemoryV2Repository,
  createOnboardingV2Service,
} = require('../src/services/onboarding-v2-service');
const {
  hashNormalized,
} = require('../src/services/verified-subject-service');

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
    protectionKey: config.selfServiceV2.protectionKey,
    requestLifetimeMinutes: config.selfServiceV2.requestLifetimeMinutes,
    managerTokenLifetimeMinutes:
      config.selfServiceV2.managerTokenLifetimeMinutes,
    maxIssuanceRetries: config.selfServiceV2.maxIssuanceRetries,
    maxPresentationRetries: config.selfServiceV2.maxPresentationRetries,
    maxVerificationFailures: config.selfServiceV2.maxVerificationFailures,
  };
  config.selfServiceV2.protectionKey = Buffer.alloc(32, 7).toString('base64');
  config.selfServiceV2.requestLifetimeMinutes = 60;
  config.selfServiceV2.managerTokenLifetimeMinutes = 60;
  config.selfServiceV2.maxIssuanceRetries = 3;
  config.selfServiceV2.maxPresentationRetries = 3;
  config.selfServiceV2.maxVerificationFailures = 3;
  repository = new InMemoryV2Repository();
  service = createOnboardingV2Service(repository);
});

test.afterEach(() => {
  Object.assign(config.selfServiceV2, original);
});

async function createApprovedRequest() {
  const created = await service.createRequest({
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    employee,
    manager,
    employeeIdHash: hashNormalized(employee.employeeId),
  });
  await service.markManagerNotified(created.record.requestId, 'test');
  const activation = await service.activateManagerToken(created.managerToken);
  await service.redeemManagerToken({
    ...activation,
    managerObjectId: manager.id,
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
  });
  await service.decide(created.record.requestId, manager.id, 'approve');
  return created;
}

test('creates one active request per immutable employee and stores only the token hash', async () => {
  const created = await service.createRequest({
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    employee,
    manager,
    employeeIdHash: hashNormalized(employee.employeeId),
  });
  const stored = await repository.getRequest(created.record.requestId);

  assert.match(created.managerToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(stored.managerTokenHash, created.managerToken);
  assert.equal(stored.managerToken, undefined);
  await assert.rejects(
    service.createRequest({
      tenantId: stored.tenantId,
      employee,
      manager,
      employeeIdHash: stored.employeeIdHash,
    }),
    (err) => err.code === 'active_request_exists'
  );
});

test('an expired request cannot clear a newer employee lock', async () => {
  const first = await service.createRequest({
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    employee,
    manager,
    employeeIdHash: hashNormalized(employee.employeeId),
  });
  const firstStored = repository.requests.get(first.record.requestId);
  firstStored.expiresAt = new Date(Date.now() - 1_000).toISOString();
  repository.employeeLocks.get(employee.id.toLowerCase()).expiresAt =
    firstStored.expiresAt;

  const second = await service.createRequest({
    tenantId: first.record.tenantId,
    employee,
    manager,
    employeeIdHash: first.record.employeeIdHash,
  });
  await service.loadRequest(first.record.requestId);

  assert.equal(
    repository.employeeLocks.get(employee.id.toLowerCase()).requestId,
    second.record.requestId
  );
  await assert.rejects(
    service.createRequest({
      tenantId: first.record.tenantId,
      employee,
      manager,
      employeeIdHash: first.record.employeeIdHash,
    }),
    (err) => err.code === 'active_request_exists'
  );
});

test('redeems a manager token exactly once for the bound oid and tid', async () => {
  const created = await service.createRequest({
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    employee,
    manager,
    employeeIdHash: hashNormalized(employee.employeeId),
  });
  await service.markManagerNotified(created.record.requestId, 'test');
  const activation = await service.activateManagerToken(created.managerToken);

  await assert.rejects(
    service.redeemManagerToken({
      ...activation,
      managerObjectId: '99999999-9999-9999-9999-999999999999',
      tenantId: created.record.tenantId,
    }),
    (err) => err.code === 'manager_not_authorized'
  );

  const results = await Promise.allSettled([
    service.redeemManagerToken({
      ...activation,
      managerObjectId: manager.id,
      tenantId: created.record.tenantId,
    }),
    service.redeemManagerToken({
      ...activation,
      managerObjectId: manager.id,
      tenantId: created.record.tenantId,
    }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('redeem can repair a stale stored manager binding after live Graph verification', async () => {
  const created = await service.createRequest({
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    employee,
    manager,
    employeeIdHash: hashNormalized(employee.employeeId),
  });
  await service.markManagerNotified(created.record.requestId, 'test');
  const activation = await service.activateManagerToken(created.managerToken);
  repository.requests.get(created.record.requestId).managerObjectId =
    '99999999-9999-9999-9999-999999999999';

  const redeemed = await service.redeemManagerToken({
    ...activation,
    managerObjectId: manager.id,
    authorizedManagerObjectId: manager.id,
    tenantId: created.record.tenantId,
  });

  assert.equal(redeemed.managerTokenStatus, 'redeemed');
  assert.equal(redeemed.managerObjectId, manager.id);
});

test('persists manager PKCE correlation encrypted and clears it on redemption', async () => {
  const created = await service.createRequest({
    tenantId: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    employee,
    manager,
    employeeIdHash: hashNormalized(employee.employeeId),
  });
  await service.markManagerNotified(created.record.requestId, 'test');
  const activation = await service.activateManagerToken(created.managerToken);
  await service.beginManagerSignIn(
    created.record.requestId,
    activation.tokenHash,
    {
      state: 'manager-state',
      nonce: 'manager-nonce',
      codeVerifier: 'manager-verifier',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
  );

  const stored = await repository.getRequest(created.record.requestId);
  assert.notEqual(stored.managerAuthNonceProtected, 'manager-nonce');
  assert.notEqual(stored.managerAuthVerifierProtected, 'manager-verifier');
  const flow = await service.loadManagerAuthFlow('manager-state');
  assert.equal(flow.nonce, 'manager-nonce');
  assert.equal(flow.codeVerifier, 'manager-verifier');

  await service.redeemManagerToken({
    requestId: created.record.requestId,
    tokenHash: activation.tokenHash,
    managerObjectId: manager.id,
    tenantId: created.record.tenantId,
  });
  const redeemed = await repository.getRequest(created.record.requestId);
  assert.equal(redeemed.managerAuthNonceProtected, undefined);
  assert.equal(redeemed.managerAuthVerifierProtected, undefined);
});

test('enforces the durable v2 state sequence through credential presentation', async () => {
  const created = await createApprovedRequest();
  await service.beginIssuance(created.record.requestId, {
    state: 'issuance-state',
    pin: '123456',
  });
  await service.attachIssuanceRequest(created.record.requestId, {
    state: 'issuance-state',
    requestId: 'issuance-request',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await service.handleIssuanceCallback({
    requestId: 'issuance-request',
    state: 'issuance-state',
    requestStatus: 'request_retrieved',
  });
  const issued = await service.handleIssuanceCallback({
    requestId: 'issuance-request',
    state: 'issuance-state',
    requestStatus: 'issuance_successful',
  });
  assert.equal(issued.state, 'credential-issued');
  assert.equal(issued.issuancePinProtected, undefined);

  await service.beginPresentation(created.record.requestId, {
    state: 'presentation-state',
  });
  await service.attachPresentationRequest(created.record.requestId, {
    state: 'presentation-state',
    requestId: 'presentation-request',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const presented = await service.handlePresentationRetrieved(
    created.record.requestId
  );
  assert.equal(presented.state, 'credential-presented');
  const verified = await service.markVerified(created.record.requestId, {
    issuer: 'did:web:tenant.example',
    credentialType: 'EmployeeOnboardingV2',
    linkedDomain: 'tenant.example',
  });
  assert.equal(verified.state, 'verified');
});

test('retries an expired retrieved presentation without changing the bound user', async () => {
  const created = await createApprovedRequest();
  await service.beginIssuance(created.record.requestId, {
    state: 'issuance-state',
    pin: '123456',
  });
  await service.attachIssuanceRequest(created.record.requestId, {
    state: 'issuance-state',
    requestId: 'issuance-request',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await service.handleIssuanceCallback({
    requestId: 'issuance-request',
    state: 'issuance-state',
    requestStatus: 'issuance_successful',
  });
  await service.beginPresentation(created.record.requestId, {
    state: 'presentation-state-1',
  });
  await service.attachPresentationRequest(created.record.requestId, {
    state: 'presentation-state-1',
    requestId: 'presentation-request-1',
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  await service.handlePresentationRetrieved(created.record.requestId);

  const retrying = await service.beginPresentation(created.record.requestId, {
    state: 'presentation-state-2',
  });
  assert.equal(retrying.state, 'credential-issued');
  assert.equal(retrying.employeeObjectId, employee.id);
  const retried = await service.attachPresentationRequest(
    created.record.requestId,
    {
      state: 'presentation-state-2',
      requestId: 'presentation-request-2',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
  );
  assert.equal(retried.presentationRequestId, 'presentation-request-2');
});

test('deduplicates TAP creation and displays the protected TAP once', async () => {
  const created = await createApprovedRequest();
  await service.beginIssuance(created.record.requestId, {
    state: 'issuance-state',
    pin: '123456',
  });
  await service.attachIssuanceRequest(created.record.requestId, {
    state: 'issuance-state',
    requestId: 'issuance-request',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  await service.handleIssuanceCallback({
    requestId: 'issuance-request',
    state: 'issuance-state',
    requestStatus: 'issuance_successful',
  });
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

  let calls = 0;
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const operation = async () => {
    calls += 1;
    await blocker;
    return {
      baselineMethods: [{ id: 'existing-key' }],
      tap: {
        id: 'tap-method',
        temporaryAccessPass: 'test-only-tap',
        lifetimeInMinutes: 30,
      },
    };
  };
  const first = service.issueTapOnce(created.record.requestId, operation);
  const second = service.issueTapOnce(created.record.requestId, operation);
  release();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
  const stored = await repository.getRequest(created.record.requestId);
  assert.notEqual(stored.tapProtected, 'test-only-tap');
  assert.equal((await service.takeTapForDisplay(created.record.requestId)).tap, 'test-only-tap');
  await assert.rejects(
    service.takeTapForDisplay(created.record.requestId),
    (err) => err.code === 'tap_already_displayed'
  );
});

test('requires a post-TAP passkey method before completion', async () => {
  const created = await createApprovedRequest();
  const stored = await repository.getRequest(created.record.requestId);
  stored.state = 'tap-issued';
  stored.passkeyBaselineJson = JSON.stringify(['existing-key']);
  stored.tapProtected = 'not-used';
  await repository.replaceRequest(stored, stored.etag);

  await assert.rejects(
    service.confirmPasskey(created.record.requestId, [{ id: 'existing-key' }]),
    (err) => err.code === 'passkey_not_found'
  );
  const registered = await service.confirmPasskey(
    created.record.requestId,
    [{ id: 'existing-key' }, { id: 'new-key' }]
  );
  assert.equal(registered.state, 'passkey-registered');
  assert.equal((await service.complete(created.record.requestId)).state, 'complete');
});

test('rate limits are durable repository counters rather than process globals', async () => {
  assert.equal(
    (await service.enforceRateLimit('upn', 'employee@tenant.example', 2)).allowed,
    true
  );
  assert.equal(
    (await service.enforceRateLimit('upn', 'employee@tenant.example', 2)).allowed,
    true
  );
  assert.equal(
    (await service.enforceRateLimit('upn', 'employee@tenant.example', 2)).allowed,
    false
  );
});
