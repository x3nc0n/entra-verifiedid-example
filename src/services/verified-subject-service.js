'use strict';

const crypto = require('crypto');

function readClaim(claims, claimName) {
  if (!claimName) return undefined;
  if (Object.prototype.hasOwnProperty.call(claims, claimName)) {
    return claims[claimName];
  }

  return claimName.split('.').reduce((value, segment) => {
    if (!value || typeof value !== 'object') return undefined;
    return value[segment];
  }, claims);
}

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function hashNormalized(value) {
  return crypto.createHash('sha256').update(normalize(value)).digest('hex');
}

function hashesMatch(actualHash, expectedHash) {
  const actual = Buffer.from(actualHash, 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function timingSafeTextMatch(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''), 'utf8');
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8');
  return actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function canonicalGuid(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    .test(normalized)) {
    throw new Error('The credential object ID claim is not a valid GUID.');
  }
  return normalized;
}

function validateV2PresentedCredential(credential, expectedUser, settings, now = Date.now()) {
  if (!credential) {
    throw new Error('The presentation did not contain the requested credential.');
  }
  const types = Array.isArray(credential.type) ? credential.type : [];
  if (!types.some((type) => timingSafeTextMatch(type, settings.credentialType))) {
    throw new Error('The presented credential type is not accepted.');
  }
  if (!timingSafeTextMatch(credential.issuer, settings.issuer)) {
    throw new Error('The presented credential issuer is not accepted.');
  }
  if (credential.credentialState?.revocationStatus !== 'VALID') {
    throw new Error('The presented credential revocation state is not valid.');
  }

  const domainUrl = credential.domainValidation?.url;
  let domainHost;
  try {
    domainHost = new URL(domainUrl).hostname.toLowerCase();
  } catch (_) {
    throw new Error('The presented credential linked domain is not valid.');
  }
  if (!timingSafeTextMatch(domainHost, normalize(settings.linkedDomain))) {
    throw new Error('The presented credential linked domain is not accepted.');
  }
  const domainStatus = credential.domainValidation?.status;
  if (domainStatus &&
      !['valid', 'validated'].includes(normalize(domainStatus))) {
    throw new Error('The presented credential linked domain was not validated.');
  }

  const issuedAt = Date.parse(credential.issuanceDate);
  const expiresAt = Date.parse(credential.expirationDate);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
      issuedAt > now + 60 * 1000 || expiresAt <= now) {
    throw new Error('The presented credential is outside its validity period.');
  }

  const claims = credential.claims || {};
  const objectId = canonicalGuid(readClaim(claims, settings.objectIdClaim));
  if (!timingSafeTextMatch(objectId, canonicalGuid(expectedUser.objectId))) {
    throw new Error('The verified object ID does not match the onboarding request.');
  }

  const employeeId = readClaim(claims, settings.employeeIdClaim);
  if (!employeeId ||
      !hashesMatch(hashNormalized(employeeId), expectedUser.employeeIdHash)) {
    throw new Error('The verified employee ID does not match the onboarding request.');
  }

  return {
    issuer: credential.issuer,
    credentialType: settings.credentialType,
    linkedDomain: domainHost,
    subject: credential.subject || null,
    issuanceDate: credential.issuanceDate,
    expirationDate: credential.expirationDate,
  };
}

function validatePresentedCredential(credential, expectedUser, settings) {
  if (!credential) {
    throw new Error('The presentation did not contain the requested credential.');
  }

  const types = Array.isArray(credential.type) ? credential.type : [];
  if (!types.includes(settings.credentialType)) {
    throw new Error('The presented credential type is not accepted.');
  }

  if (!settings.acceptedIssuers.includes(credential.issuer)) {
    throw new Error('The presented credential issuer is not accepted.');
  }

  if (credential.credentialState?.revocationStatus === 'REVOKED') {
    throw new Error('The presented credential has been revoked.');
  }

  const claims = credential.claims || {};
  const presentedPrincipalName = readClaim(claims, settings.userPrincipalNameClaim);
  if (!presentedPrincipalName ||
      normalize(presentedPrincipalName) !== normalize(expectedUser.userPrincipalName)) {
    throw new Error('The verified subject does not match the pre-created Entra user.');
  }

  if (settings.employeeIdClaim) {
    if (!expectedUser.employeeIdHash) {
      throw new Error('The onboarding record is missing its employee identifier binding.');
    }
    const presentedEmployeeId = readClaim(claims, settings.employeeIdClaim);
    if (!presentedEmployeeId ||
        !hashesMatch(hashNormalized(presentedEmployeeId), expectedUser.employeeIdHash)) {
      throw new Error('The verified employee identifier does not match the onboarding record.');
    }
  }

  return {
    issuer: credential.issuer,
    credentialType: settings.credentialType,
    subject: credential.subject || null,
    issuanceDate: credential.issuanceDate || null,
    expirationDate: credential.expirationDate || null,
  };
}

module.exports = {
  readClaim,
  hashNormalized,
  validatePresentedCredential,
  canonicalGuid,
  validateV2PresentedCredential,
};
