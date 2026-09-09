'use strict';

const { DefaultAzureCredential } = require('@azure/identity');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

let credential = null;

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

module.exports = {
  getAccessToken,
  getUserByPrincipalName,
  getUserById,
  createTemporaryAccessPass,
  getFido2CreationOptions,
  registerFido2Key,
  listFido2Methods,
  buildFido2RegistrationPayload,
};
