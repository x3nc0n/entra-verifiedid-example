'use strict';

const { DefaultAzureCredential } = require('@azure/identity');
const axios = require('axios');
const config = require('../config');

let _credential = null;

/**
 * Returns (or creates) a DefaultAzureCredential for the Graph API.
 * In Azure this resolves to managed identity; locally it falls back to
 * developer credentials such as Azure CLI / VS Code.
 * @returns {DefaultAzureCredential}
 */
function getCredential() {
  if (!_credential) {
    _credential = new DefaultAzureCredential({
      managedIdentityClientId: config.azure.clientId || undefined,
    });
  }
  return _credential;
}

/**
 * Acquires an access token for the Microsoft Graph API.
 * @returns {Promise<string>} Bearer token
 */
async function getAccessToken() {
  if (config.demoMode) return 'demo-graph-token';
  const credential = getCredential();
  const tokenResponse = await credential.getToken(config.graph.scope);
  return tokenResponse.token;
}

/**
 * Looks up a user in Entra ID by their email address.
 *
 * @param {string} email - User's email (UPN or mail attribute)
 * @returns {Promise<{id: string, displayName: string, userPrincipalName: string} | null>}
 */
async function getUserByEmail(email) {
  if (config.demoMode) {
    return {
      id: 'demo-user-id-00000000-0000-0000-0000-000000000001',
      displayName: 'Demo User',
      userPrincipalName: email,
    };
  }

  const token = await getAccessToken();
  const response = await axios.get(
    `${config.graph.baseUrl}/v1.0/users`,
    {
      params: {
        $filter: `mail eq '${email}' or userPrincipalName eq '${email}'`,
        $select: 'id,displayName,userPrincipalName,mail',
        $top: 1,
      },
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  const users = response.data.value || [];
  return users.length > 0 ? users[0] : null;
}

/**
 * Registers a FIDO2 security key for a user via the Microsoft Graph beta API.
 * https://learn.microsoft.com/en-us/graph/api/fido2authenticationmethod-list
 *
 * @param {string} userId - Entra user object ID
 * @param {object} attestationResponse - The WebAuthn attestation response from the browser
 * @param {string} [displayName] - Human-readable label for the key
 * @returns {Promise<object>} Graph API response
 */
async function registerFido2Key(userId, attestationResponse, displayName = 'Security Key') {
  if (config.demoMode) {
    console.log(`[graph] DEMO — would register FIDO2 key for user ${userId}`);
    return { id: 'demo-fido2-key-id', displayName, createdDateTime: new Date().toISOString() };
  }

  const token = await getAccessToken();
  const url = `${config.graph.betaUrl}/users/${userId}/authentication/fido2Methods`;

  const payload = {
    displayName,
    publicKeyCredential: {
      // Map from the SimpleWebAuthn response to Graph API format
      id: attestationResponse.id,
      response: {
        clientDataJSON: attestationResponse.response.clientDataJSON,
        attestationObject: attestationResponse.response.attestationObject,
      },
    },
  };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  return response.data;
}

module.exports = {
  getAccessToken,
  getUserByEmail,
  registerFido2Key,
};
