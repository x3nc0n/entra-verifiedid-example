'use strict';

const { DefaultAzureCredential } = require('@azure/identity');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

let credential = null;

class PilotEligibilityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PilotEligibilityError';
    this.code = code;
  }
}

function getCredential() {
  if (!credential) {
    credential = new DefaultAzureCredential({
      managedIdentityClientId: config.azure.clientId || undefined,
    });
  }
  return credential;
}

async function getAccessToken() {
  if (config.demoMode) return 'demo-graph-token';
  const tokenResponse = await getCredential().getToken(config.graph.scope);
  return tokenResponse.token;
}

function authorizationHeaders(accessToken) {
  return { Authorization: ['Bearer', accessToken].join(' ') };
}

async function getUserByPrincipalName(userPrincipalName) {
  if (config.demoMode) {
    return {
      id: 'demo-user-id-00000000-0000-0000-0000-000000000001',
      displayName: 'Demo User',
      userPrincipalName,
    };
  }

  const token = await getAccessToken();
  const encodedUser = encodeURIComponent(userPrincipalName);
  try {
    const response = await axios.get(
      `${config.graph.baseUrl}/v1.0/users/${encodedUser}`,
      {
        params: { $select: 'id,displayName,userPrincipalName' },
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return response.data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function getUserById(userId) {
  if (config.demoMode) {
    return {
      id: userId,
      displayName: 'Demo User',
      userPrincipalName: 'demo.user@tenant.example',
      accountEnabled: true,
    };
  }

  const token = await getAccessToken();
  const encodedUser = encodeURIComponent(userId);
  try {
    const response = await axios.get(
      `${config.graph.baseUrl}/v1.0/users/${encodedUser}`,
      {
        params: { $select: 'id,displayName,userPrincipalName,accountEnabled' },
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return response.data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function isUserInGroup(userId, groupId) {
  if (config.demoMode) return true;

  const token = await getAccessToken();
  const encodedUser = encodeURIComponent(userId);
  const response = await axios.post(
    `${config.graph.baseUrl}/v1.0/users/${encodedUser}/checkMemberGroups`,
    { groupIds: [groupId] },
    {
      headers: {
        ...authorizationHeaders(token),
        'Content-Type': 'application/json',
      },
    }
  );
  return (response.data.value || [])
    .some((value) => String(value).toLowerCase() === String(groupId).toLowerCase());
}

async function getEligiblePilotUser(userId, dependencies = {}) {
  const loadUser = dependencies.getUserById || getUserById;
  const checkMembership = dependencies.isUserInGroup || isUserInGroup;
  const groupId = dependencies.pilotGroupId || config.graph.pilotGroupId;
  const user = await loadUser(userId);

  if (!user || String(user.id).toLowerCase() !== String(userId).toLowerCase()) {
    throw new PilotEligibilityError(
      'The invitation-bound Entra account no longer exists.',
      'user_not_found'
    );
  }
  if (user.accountEnabled !== true) {
    throw new PilotEligibilityError(
      'The invitation-bound Entra account is disabled.',
      'account_disabled'
    );
  }
  if (!config.demoMode && (!groupId || !await checkMembership(user.id, groupId))) {
    throw new PilotEligibilityError(
      'The invitation-bound Entra account is not a current member of the configured pilot group.',
      'pilot_group_required'
    );
  }
  return user;
}

async function createTemporaryAccessPass(userId) {
  const lifetimeInMinutes = config.graph.tapLifetimeMinutes;
  if (lifetimeInMinutes < 10 || lifetimeInMinutes > 43200) {
    throw new Error('TAP_LIFETIME_MINUTES must be between 10 and 43200.');
  }

  if (config.demoMode) {
    return {
      id: 'demo-tap-method-id',
      temporaryAccessPass: 'DEMO-ONLY-NOT-A-VALID-TAP',
      lifetimeInMinutes,
      isUsableOnce: true,
      createdDateTime: new Date().toISOString(),
    };
  }

  const token = await getAccessToken();
  const encodedUser = encodeURIComponent(userId);
  const response = await axios.post(
    `${config.graph.baseUrl}/v1.0/users/${encodedUser}/authentication/temporaryAccessPassMethods`,
    {
      lifetimeInMinutes,
      isUsableOnce: true,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data;
}

async function createTemporaryAccessPassForPilotUser(userId, dependencies = {}) {
  const validateUser = dependencies.getEligiblePilotUser || getEligiblePilotUser;
  const createTap = dependencies.createTemporaryAccessPass ||
    createTemporaryAccessPass;

  const user = await validateUser(userId);
  const tap = await createTap(user.id);
  return { user, tap };
}

async function getFido2CreationOptions(userId, userPrincipalName) {
  if (config.demoMode) {
    return {
      challengeTimeoutDateTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      publicKey: {
        rp: { id: config.fido2.rpId, name: config.fido2.rpName },
        user: {
          id: Buffer.from(userPrincipalName).toString('base64url'),
          name: userPrincipalName,
          displayName: userPrincipalName,
        },
        challenge: crypto.randomBytes(32).toString('base64url'),
        pubKeyCredParams: config.fido2.supportedAlgorithmIDs.map((alg) => ({
          type: 'public-key',
          alg,
        })),
        timeout: 60000,
        excludeCredentials: [],
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
        attestation: 'direct',
      },
    };
  }

  const token = await getAccessToken();
  const encodedUser = encodeURIComponent(userId);
  const response = await axios.get(
    `${config.graph.baseUrl}/v1.0/users/${encodedUser}/authentication/fido2Methods/creationOptions`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data;
}

function buildFido2RegistrationPayload(publicKeyCredential, displayName) {
  return {
    '@odata.type': '#microsoft.graph.fido2AuthenticationMethod',
    displayName,
    publicKeyCredential: {
      '@odata.type': '#microsoft.graph.webauthnPublicKeyCredential',
      id: publicKeyCredential.id,
      response: {
        '@odata.type': '#microsoft.graph.webauthnAuthenticatorAttestationResponse',
        clientDataJSON: publicKeyCredential.response.clientDataJSON,
        attestationObject: publicKeyCredential.response.attestationObject,
      },
      clientExtensionResults: {
        '@odata.type': '#microsoft.graph.webauthnAuthenticationExtensionsClientOutputs',
        ...(publicKeyCredential.clientExtensionResults || {}),
      },
    },
  };
}

async function registerFido2Key(userId, publicKeyCredential, displayName) {
  if (config.demoMode) {
    return {
      id: 'demo-fido2-key-id',
      displayName,
      createdDateTime: new Date().toISOString(),
    };
  }

  const token = await getAccessToken();
  const encodedUser = encodeURIComponent(userId);
  const response = await axios.post(
    `${config.graph.baseUrl}/v1.0/users/${encodedUser}/authentication/fido2Methods`,
    buildFido2RegistrationPayload(publicKeyCredential, displayName),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data;
}

async function listFido2Methods(userId) {
  if (config.demoMode) {
    return [{ id: 'demo-fido2-key-id', displayName: 'Demo onboarding passkey' }];
  }

  const token = await getAccessToken();
  const encodedUser = encodeURIComponent(userId);
  const response = await axios.get(
    `${config.graph.baseUrl}/v1.0/users/${encodedUser}/authentication/fido2Methods`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data.value || [];
}

async function deleteFido2Method(userId, methodId) {
  if (config.demoMode) {
    return { deleted: true, id: methodId };
  }

  const token = await getAccessToken();
  const encodedUser = encodeURIComponent(userId);
  const encodedMethod = encodeURIComponent(methodId);
  await axios.delete(
    `${config.graph.baseUrl}/v1.0/users/${encodedUser}/authentication/fido2Methods/${encodedMethod}`,
    { headers: authorizationHeaders(token) }
  );
  return { deleted: true, id: methodId };
}

// Revokes every existing tenant passkey for a user who reports losing all of
// their authenticators, so a stale or potentially compromised credential can
// never be used again once account recovery has issued a new one.
async function revokeAllFido2Methods(userId, dependencies = {}) {
  const listMethods = dependencies.listFido2Methods || listFido2Methods;
  const deleteMethod = dependencies.deleteFido2Method || deleteFido2Method;

  const methods = await listMethods(userId);
  const revokedMethodIds = [];
  for (const method of methods) {
    // eslint-disable-next-line no-await-in-loop
    await deleteMethod(userId, method.id);
    revokedMethodIds.push(method.id);
  }
  return revokedMethodIds;
}

module.exports = {
  getAccessToken,
  getUserByPrincipalName,
  getUserById,
  isUserInGroup,
  getEligiblePilotUser,
  createTemporaryAccessPass,
  createTemporaryAccessPassForPilotUser,
  getFido2CreationOptions,
  registerFido2Key,
  listFido2Methods,
  deleteFido2Method,
  revokeAllFido2Methods,
  buildFido2RegistrationPayload,
  PilotEligibilityError,
};
