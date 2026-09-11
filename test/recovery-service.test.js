'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  InMemoryInvitationRepository,
  createInvitationService,
} = require('../src/services/invitation-service');
const recoveryService = require('../src/services/recovery-service');

const recoveryInput = {
  entraUserId: '99999999-8888-7777-6666-555555555555',
  userPrincipalName: 'recovering.user@tenant.example',
  displayName: 'Recovering User',
  personalEmail: 'known.user@personal.example',
  employeeId: 'EMP-2002',
  lifetimeMinutes: 60,
};

test.beforeEach(() => {
  recoveryService.resetForTests();
});

test('recovery requests use a Recovery request entity label distinct from Invitation', async () => {
  const service = createInvitationService(new InMemoryInvitationRepository(), {
    entityLabel: 'Recovery request',
  });

  await assert.rejects(
    service.createInvitation({ ...recoveryInput, lifetimeMinutes: 1 }),
    (err) => err.code === 'invalid_lifetime' && err.message.startsWith('Recovery request lifetime')
  );
});

test('the default recovery service creates, activates, and consumes a recovery request', async () => {
  const recovery = await recoveryService.createInvitation(recoveryInput);
  const activation = await recoveryService.activateInvitation(recovery.token);

  assert.equal(activation.active, true);

  const consumed = await recoveryService.consumeInvitation(activation.reference, {
    personalEmail: recoveryInput.personalEmail,
    employeeId: recoveryInput.employeeId,
  });

  assert.equal(consumed.entraUserId, recoveryInput.entraUserId);
  assert.equal(consumed.userPrincipalName, recoveryInput.userPrincipalName);
});

test('mismatched recovery evidence is rejected with a Recovery request specific message', async () => {
  const recovery = await recoveryService.createInvitation(recoveryInput);
  const activation = await recoveryService.activateInvitation(recovery.token);

  await assert.rejects(
    recoveryService.consumeInvitation(activation.reference, {
      personalEmail: 'wrong@personal.example',
      employeeId: recoveryInput.employeeId,
    }),
    (err) => err.code === 'mismatch' &&
      err.message === 'Recovery request details do not match the approved record.'
  );
});

test('recovery-service reuses the invitation engine classes and reports its own error types', () => {
  assert.equal(recoveryService.RecoveryError.name, 'InvitationError');
  assert.equal(recoveryService.RecoveryConcurrencyError.name, 'InvitationConcurrencyError');
  assert.equal(typeof recoveryService.createInvitationService, 'function');
});
