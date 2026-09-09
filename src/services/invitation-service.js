'use strict';

const crypto = require('crypto');
const config = require('../config');

const invitations = new Map();

class InvitationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'InvitationError';
    this.code = code;
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmployeeId(value) {
  return String(value || '').trim().toLowerCase();
}

function valuesMatch(actual, expectedHash, normalizer) {
  const actualHash = Buffer.from(hash(normalizer(actual)), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actualHash.length === expected.length &&
    crypto.timingSafeEqual(actualHash, expected);
}

function validateLifetime(lifetimeMinutes) {
  if (!Number.isInteger(lifetimeMinutes) ||
      lifetimeMinutes < 5 ||
      lifetimeMinutes > 1440) {
    throw new InvitationError(
      'Invitation lifetime must be between 5 and 1440 minutes.',
      'invalid_lifetime'
    );
  }
}

function createInvitation(input) {
  const lifetimeMinutes = input.lifetimeMinutes ||
    config.assurance.invitationLifetimeMinutes;
  validateLifetime(lifetimeMinutes);

  if (!input.entraUserId || !input.userPrincipalName ||
      !input.personalEmail || !input.employeeId) {
    throw new InvitationError(
      'Immutable Entra user ID, user principal name, personal email, and employee ID are required.',
      'invalid_input'
    );
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hash(token);
  const now = Date.now();
  const record = {
    tokenHash,
    entraUserId: input.entraUserId,
    userPrincipalName: input.userPrincipalName,
    displayName: input.displayName || input.userPrincipalName,
    personalEmailHash: hash(normalizeEmail(input.personalEmail)),
    employeeIdHash: hash(normalizeEmployeeId(input.employeeId)),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + lifetimeMinutes * 60 * 1000).toISOString(),
    status: 'active',
    failedAttempts: 0,
  };
  invitations.set(tokenHash, record);

  return {
    token,
    expiresAt: record.expiresAt,
    entraUserId: record.entraUserId,
    userPrincipalName: record.userPrincipalName,
  };
}

function inspectInvitation(token) {
  const record = invitations.get(hash(String(token || '')));
  if (!record) return { active: false, reason: 'not_found' };
  if (record.status !== 'active') return { active: false, reason: record.status };
  if (Date.now() >= Date.parse(record.expiresAt)) {
    record.status = 'expired';
    return { active: false, reason: 'expired' };
  }
  return { active: true, expiresAt: record.expiresAt };
}

function consumeInvitation(token, evidence) {
  const tokenHash = hash(String(token || ''));
  const record = invitations.get(tokenHash);
  if (!record) {
    throw new InvitationError('Invitation is invalid or expired.', 'not_found');
  }
  if (record.status !== 'active') {
    throw new InvitationError('Invitation has already been used or is no longer active.', record.status);
  }
  if (Date.now() >= Date.parse(record.expiresAt)) {
    record.status = 'expired';
    throw new InvitationError('Invitation has expired.', 'expired');
  }

  const emailMatches = valuesMatch(
    evidence.personalEmail,
    record.personalEmailHash,
    normalizeEmail
  );
  const employeeMatches = valuesMatch(
    evidence.employeeId,
    record.employeeIdHash,
    normalizeEmployeeId
  );

  if (!emailMatches || !employeeMatches) {
    record.failedAttempts += 1;
    if (record.failedAttempts >= config.assurance.invitationMaxAttempts) {
      record.status = 'locked';
    }
    throw new InvitationError('Invitation details do not match the approved onboarding record.', 'mismatch');
  }

  // Node processes each synchronous section without interleaving, so the
  // active-to-consumed transition is atomic within this single-process store.
  record.status = 'consumed';
  record.consumedAt = new Date().toISOString();

  return {
    entraUserId: record.entraUserId,
    userPrincipalName: record.userPrincipalName,
    displayName: record.displayName,
    employeeIdHash: record.employeeIdHash,
  };
}

function resetForTests() {
  invitations.clear();
}

module.exports = {
  InvitationError,
  createInvitation,
  inspectInvitation,
  consumeInvitation,
  resetForTests,
};
