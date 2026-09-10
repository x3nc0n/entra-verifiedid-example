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
};
