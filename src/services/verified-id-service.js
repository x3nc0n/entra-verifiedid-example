'use strict';

const { ClientSecretCredential } = require('@azure/identity');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

let _credential = null;

/**
 * Returns (or creates) a ClientSecretCredential for the Verified ID service.
 * @returns {ClientSecretCredential}
 */
function getCredential() {
  if (!_credential) {
    _credential = new ClientSecretCredential(
      config.azure.tenantId,
      config.azure.clientId,
      config.azure.clientSecret
    );
  }
  return _credential;
}

/**
 * Acquires an access token for the Verified ID Request Service API.
 * @returns {Promise<string>} Bearer token
 */
async function getAccessToken() {
  if (config.demoMode) return 'demo-access-token';
  const credential = getCredential();
  const tokenResponse = await credential.getToken(config.verifiedId.serviceScope);
  return tokenResponse.token;
}

/**
 * Creates an issuance request using the Microsoft Entra Verified ID
 * Request Service REST API (id_token_hint flow).
 *
 * @param {object} claims - Employee claims to embed in the credential
 * @param {string} callbackUrl - Public URL for status callbacks
 * @returns {Promise<{requestId: string, url: string, expiry: string, qrCode: string}>}
 */
async function createIssuanceRequest(claims, callbackUrl) {
  const requestId = uuidv4();

  if (config.demoMode) {
    return _mockIssuanceResponse(requestId);
  }

  const accessToken = await getAccessToken();
  const url = `${config.verifiedId.requestServiceUrl}/verifiableCredentials/createIssuanceRequest`;

  const payload = {
    includeQRCode: true,
    authority: config.verifiedId.issuerAuthority,
    registration: {
      clientName: 'Entra Verified ID Onboarding Portal',
    },
    callback: {
      url: callbackUrl,
      state: requestId,
      headers: {
        'api-key': 'callback-api-key', // Validate this in your callback handler
      },
    },
    type: config.verifiedId.credentialType,
    manifest: config.verifiedId.credentialManifestUrl,
    pin: null,
    claims,
  };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'request-id': requestId,
    },
  });

  const data = response.data;
  return {
    requestId: data.requestId || requestId,
    url: data.url,
    expiry: data.expiry,
    qrCode: data.qrCode, // Base64-encoded PNG
  };
}

/**
 * Creates a presentation/verification request using the Verified ID
 * Request Service REST API.
 *
 * @param {string} callbackUrl - Public URL for status callbacks
 * @returns {Promise<{requestId: string, url: string, expiry: string, qrCode: string}>}
 */
async function createPresentationRequest(callbackUrl) {
  const requestId = uuidv4();

  if (config.demoMode) {
    return _mockPresentationResponse(requestId);
  }

  const accessToken = await getAccessToken();
  const url = `${config.verifiedId.requestServiceUrl}/verifiableCredentials/createPresentationRequest`;

  const payload = {
    includeQRCode: true,
    authority: config.verifiedId.issuerAuthority,
    registration: {
      clientName: 'Entra Verified ID Onboarding Portal',
    },
    callback: {
      url: callbackUrl,
      state: requestId,
      headers: {
        'api-key': 'callback-api-key',
      },
    },
    presentation: {
      includeReceipt: true,
      requestedCredentials: [
        {
          type: config.verifiedId.credentialType,
          purpose: 'Identity verification for employee onboarding',
          acceptedIssuers: [config.verifiedId.issuerAuthority],
          configuration: {
            validation: {
              allowRevoked: false,
              validateLinkedDomain: true,
            },
          },
        },
      ],
    },
  };

  const response = await axios.post(url, payload, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'request-id': requestId,
    },
  });

  const data = response.data;
  return {
    requestId: data.requestId || requestId,
    url: data.url,
    expiry: data.expiry,
    qrCode: data.qrCode,
  };
}

// ── Demo/mock helpers ──────────────────────────────────────────────────────────

function _mockIssuanceResponse(requestId) {
  // Returns a placeholder deep-link that Authenticator would handle
  const mockUrl = `openid-vc://vc/issuance?requestId=${requestId}`;
  return {
    requestId,
    url: mockUrl,
    expiry: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    qrCode: null, // Client will generate from url
    _demo: true,
  };
}

function _mockPresentationResponse(requestId) {
  const mockUrl = `openid-vc://vc/presentation?requestId=${requestId}`;
  return {
    requestId,
    url: mockUrl,
    expiry: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    qrCode: null,
    _demo: true,
  };
}

module.exports = {
  getAccessToken,
  createIssuanceRequest,
  createPresentationRequest,
};
