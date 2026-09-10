'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const invitationService = require('../src/services/invitation-service');
const {
  InMemoryInvitationRepository,
  createInvitationService,
} = invitationService;

const invitationInput = {
  entraUserId: '11111111-2222-3333-4444-555555555555',
  userPrincipalName: 'new.user@tenant.example',
  displayName: 'New User',
  personalEmail: 'known.user@personal.example',
  employeeId: 'EMP-1001',
  lifetimeMinutes: 60,
};

let service;

test.beforeEach(() => {
  service = createInvitationService(new InMemoryInvitationRepository());
});

test('creates a high-entropy opaque token and stores only a usable hash lookup', async () => {
  const invitation = await service.createInvitation(invitationInput);
  const activation = await service.activateInvitation(invitation.token);

  assert.match(invitation.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(activation.active, true);
  assert.equal(
    (await service.activateInvitation(`${invitation.token}changed`)).active,
    false
  );
});

test('validates known email and employee ID before single atomic consumption', async () => {
  const invitation = await service.createInvitation(invitationInput);
  const activation = await service.activateInvitation(invitation.token);
  const consumed = await service.consumeInvitation(activation.reference, {
    personalEmail: 'KNOWN.USER@personal.example',
    employeeId: ' emp-1001 ',
  });

  assert.equal(consumed.entraUserId, invitationInput.entraUserId);
  assert.equal(consumed.userPrincipalName, invitationInput.userPrincipalName);
  await assert.rejects(
    service.consumeInvitation(activation.reference, {
      personalEmail: invitationInput.personalEmail,
      employeeId: invitationInput.employeeId,
    }),
    (err) => err.code === 'consumed'
  );
});

test('locks an invitation after the configured number of mismatches', async () => {
  const originalMaxAttempts = config.assurance.invitationMaxAttempts;
  config.assurance.invitationMaxAttempts = 2;
  const invitation = await service.createInvitation(invitationInput);
  const activation = await service.activateInvitation(invitation.token);

  try {
    await assert.rejects(
      service.consumeInvitation(activation.reference, {
        personalEmail: 'wrong@personal.example',
        employeeId: invitationInput.employeeId,
      }),
      (err) => err.code === 'mismatch'
    );
    await assert.rejects(
      service.consumeInvitation(activation.reference, {
        personalEmail: invitationInput.personalEmail,
        employeeId: 'wrong',
      }),
      (err) => err.code === 'mismatch'
    );
    assert.equal(
      (await service.inspectInvitation(activation.reference)).reason,
      'locked'
    );
  } finally {
    config.assurance.invitationMaxAttempts = originalMaxAttempts;
  }
});

test('expires invitations before validation or consumption', async () => {
  const originalNow = Date.now;
  let now = Date.parse('2026-09-09T12:00:00Z');
  Date.now = () => now;

  try {
    const invitation = await service.createInvitation({
      ...invitationInput,
      lifetimeMinutes: 5,
    });
    const activation = await service.activateInvitation(invitation.token);
    now += 6 * 60 * 1000;

    assert.equal(
      (await service.inspectInvitation(activation.reference)).reason,
      'expired'
    );
    await assert.rejects(
      service.consumeInvitation(activation.reference, {
        personalEmail: invitationInput.personalEmail,
        employeeId: invitationInput.employeeId,
      }),
      (err) => err.code === 'expired'
    );
  } finally {
    Date.now = originalNow;
  }
});

test('allows only one concurrent consumer across repository workers', async () => {
  const repository = new InMemoryInvitationRepository();
  const workerOne = createInvitationService(repository);
  const workerTwo = createInvitationService(repository);
  const invitation = await workerOne.createInvitation(invitationInput);
  const activation = await workerOne.activateInvitation(invitation.token);
  const evidence = {
    personalEmail: invitationInput.personalEmail,
    employeeId: invitationInput.employeeId,
  };

  const results = await Promise.allSettled([
    workerOne.consumeInvitation(activation.reference, evidence),
    workerTwo.consumeInvitation(activation.reference, evidence),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'consumed');
});
