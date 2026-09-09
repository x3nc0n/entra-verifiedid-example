'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const invitationService = require('../src/services/invitation-service');

const invitationInput = {
  entraUserId: '11111111-2222-3333-4444-555555555555',
  userPrincipalName: 'new.user@tenant.example',
  displayName: 'New User',
  personalEmail: 'known.user@personal.example',
  employeeId: 'EMP-1001',
  lifetimeMinutes: 60,
};

test.beforeEach(() => invitationService.resetForTests());

test('creates a high-entropy opaque token and stores only a usable hash lookup', () => {
  const invitation = invitationService.createInvitation(invitationInput);

  assert.match(invitation.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(invitationService.inspectInvitation(invitation.token).active, true);
  assert.equal(
    invitationService.inspectInvitation(`${invitation.token}changed`).active,
    false
  );
});

test('validates known email and employee ID before single atomic consumption', () => {
  const invitation = invitationService.createInvitation(invitationInput);
  const consumed = invitationService.consumeInvitation(invitation.token, {
    personalEmail: 'KNOWN.USER@personal.example',
    employeeId: ' emp-1001 ',
  });

  assert.equal(consumed.entraUserId, invitationInput.entraUserId);
  assert.equal(consumed.userPrincipalName, invitationInput.userPrincipalName);
  assert.throws(
    () => invitationService.consumeInvitation(invitation.token, {
      personalEmail: invitationInput.personalEmail,
      employeeId: invitationInput.employeeId,
    }),
    (err) => err.code === 'consumed'
  );
});

test('locks an invitation after the configured number of mismatches', () => {
  const originalMaxAttempts = config.assurance.invitationMaxAttempts;
  config.assurance.invitationMaxAttempts = 2;
  const invitation = invitationService.createInvitation(invitationInput);

  try {
    assert.throws(
      () => invitationService.consumeInvitation(invitation.token, {
        personalEmail: 'wrong@personal.example',
        employeeId: invitationInput.employeeId,
      }),
      (err) => err.code === 'mismatch'
    );
    assert.throws(
      () => invitationService.consumeInvitation(invitation.token, {
        personalEmail: invitationInput.personalEmail,
        employeeId: 'wrong',
      }),
      (err) => err.code === 'mismatch'
    );
    assert.equal(invitationService.inspectInvitation(invitation.token).reason, 'locked');
  } finally {
    config.assurance.invitationMaxAttempts = originalMaxAttempts;
  }
});

test('expires invitations before validation or consumption', () => {
  const originalNow = Date.now;
  let now = Date.parse('2026-09-09T12:00:00Z');
  Date.now = () => now;

  try {
    const invitation = invitationService.createInvitation({
      ...invitationInput,
      lifetimeMinutes: 5,
    });
    now += 6 * 60 * 1000;

    assert.equal(invitationService.inspectInvitation(invitation.token).reason, 'expired');
    assert.throws(
      () => invitationService.consumeInvitation(invitation.token, {
        personalEmail: invitationInput.personalEmail,
        employeeId: invitationInput.employeeId,
      }),
      (err) => err.code === 'expired'
    );
  } finally {
    Date.now = originalNow;
  }
});
