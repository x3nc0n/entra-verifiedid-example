'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InMemoryV2Repository,
  createOnboardingV2Service,
} = require('../src/services/onboarding-v2-service');
const {
  InMemoryRecoveryV2Repository,
  createRecoveryV2Service,
} = require('../src/services/recovery-v2-service');

for (const [kind, Repository, createService, createMethod] of [
  ['onboarding', InMemoryV2Repository, createOnboardingV2Service, 'createRequest'],
  ['recovery', InMemoryRecoveryV2Repository, createRecoveryV2Service, 'createRecoveryRequest'],
]) {
  test(`${kind} admin reset requires an exact current request version`, async () => {
    const repository = new Repository();
    const service = createService(repository);
    const created = await service[createMethod]({
      tenantId: 'test-tenant',
      employee: {
        id: 'test-employee',
        userPrincipalName: 'employee@tenant.example',
        displayName: 'Test Employee',
        employeeId: 'TEST-1',
      },
      manager: { id: 'test-manager', mail: 'manager@tenant.example' },
      employeeIdHash: 'test-employee-hash',
    });
    const requestId = created.record.requestId;
    const before = await repository.getRequest(requestId);
    const input = {
      action: 'cancel',
      reason: 'User requested a test reset',
      adminObjectId: 'test-admin',
    };
    for (const etag of [undefined, null, '', '   ', '*', ' * ']) {
      await assert.rejects(
        service.adminResetRequest(requestId, { ...input, etag }),
        { status: 428, code: 'precondition_required' }
      );
      assert.deepEqual(await repository.getRequest(requestId), before);
    }
    await assert.rejects(
      service.adminResetRequest(requestId, { ...input, etag: 'stale-version' }),
      { status: 412 }
    );
    assert.deepEqual(await repository.getRequest(requestId), before);
    const updated = await service.adminResetRequest(requestId, {
      ...input, etag: String(before.etag),
    });
    assert.equal(updated.state, 'admin-cancelled');
  });
}
