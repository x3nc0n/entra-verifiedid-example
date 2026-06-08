'use strict';

const {
  generateRegistrationOptions: _generateRegistrationOptions,
  verifyRegistrationResponse,
} = require('@simplewebauthn/server');
const config = require('../config');

/**
 * Generates WebAuthn registration options for a user.
 *
 * @param {object} user - The user object from session { email, employeeId }
 * @param {'platform'|'cross-platform'} authenticatorType
 *   'platform' = phone/TouchID/FaceID (bound to device)
 *   'cross-platform' = roaming key like YubiKey
 * @returns {Promise<PublicKeyCredentialCreationOptionsJSON>}
 */
async function generateRegistrationOptions(user, authenticatorType) {
  const userIdBuffer = Buffer.from(user.email);

  const options = await _generateRegistrationOptions({
    rpName: config.fido2.rpName,
    rpID: config.fido2.rpId,
    userID: userIdBuffer,
    userName: user.email,
    userDisplayName: user.employeeId || user.email,
    timeout: 60_000,
    attestationType: 'direct',
    authenticatorSelection: {
      // 'platform' binds to the device; 'cross-platform' allows roaming keys
      authenticatorAttachment: authenticatorType,
      residentKey: 'preferred',
      requireResidentKey: false,
      userVerification: 'preferred',
    },
    supportedAlgorithmIDs: config.fido2.supportedAlgorithmIDs,
    // Prevent re-registration of the same authenticator
    excludeCredentials: [],
  });

  return options;
}

/**
 * Verifies a WebAuthn registration response from the browser.
 *
 * @param {string} expectedChallenge - The challenge stored in session
 * @param {object} registrationResponse - The response from navigator.credentials.create()
 * @returns {Promise<{verified: boolean, registrationInfo?: object}>}
 */
async function verifyRegistration(expectedChallenge, registrationResponse) {
  const verification = await verifyRegistrationResponse({
    response: registrationResponse,
    expectedChallenge,
    expectedOrigin: config.fido2.origin,
    expectedRPID: config.fido2.rpId,
    requireUserVerification: false,
  });

  return verification;
}

module.exports = {
  generateRegistrationOptions,
  verifyRegistration,
};
