'use strict';

const { DefaultAzureCredential } = require('@azure/identity');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
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
  if (config.demoMode) return 'demo-access-token';
  const tokenResponse = await getCredential().getToken(config.verifiedId.serviceScope);
  return tokenResponse.token;
}

function assertPresentationConfiguration() {
  const missing = [];
  if (!config.verifiedId.verifierAuthority) missing.push('VC_VERIFIER_AUTHORITY');
  if (!config.verifiedId.credentialType) missing.push('VC_CREDENTIAL_TYPE');
  if (config.verifiedId.acceptedIssuers.length === 0) missing.push('VC_ACCEPTED_ISSUERS');
  if (!config.verifiedId.userPrincipalNameClaim) {
    missing.push('VC_USER_PRINCIPAL_NAME_CLAIM');
  }
  if (!config.verifiedId.callbackApiKey) missing.push('VC_CALLBACK_API_KEY');

  if (missing.length > 0) {
    throw new Error(`Verified ID presentation is missing configuration: ${missing.join(', ')}`);
  }
}

function buildPresentationRequestPayload(callbackUrl, callbackState) {
  return {
    includeQRCode: true,
    includeReceipt: false,
    authority: config.verifiedId.verifierAuthority,
    registration: {
      clientName: 'Entra Verified ID Onboarding Portal',
    },
    callback: {
      url: callbackUrl,
      state: callbackState,
      headers: {
        'api-key': config.verifiedId.callbackApiKey,
      },
    },
    requestedCredentials: [
      {
        type: config.verifiedId.credentialType,
        purpose: 'Identity verification for employee onboarding',
        acceptedIssuers: config.verifiedId.acceptedIssuers,
        configuration: {
          validation: {
            allowRevoked: false,
            validateLinkedDomain: true,
          },
        },
      },
    ],
  };
}

async function createPresentationRequest(callbackUrl, callbackState) {
  const clientRequestId = uuidv4();

  if (config.demoMode) {
    return {
      requestId: clientRequestId,
      url: `openid-vc://vc/presentation?requestId=${clientRequestId}`,
      expiry: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      qrCode: null,
      demo: true,
    };
  }

  assertPresentationConfiguration();
  const accessToken = await getAccessToken();
  const url = `${config.verifiedId.requestServiceUrl}/verifiableCredentials/createPresentationRequest`;
  const response = await axios.post(
    url,
    buildPresentationRequestPayload(callbackUrl, callbackState),
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'request-id': clientRequestId,
      },
    }
  );

  return {
    requestId: response.data.requestId || clientRequestId,
    url: response.data.url,
    expiry: response.data.expiry,
    qrCode: response.data.qrCode,
  };
}

module.exports = {
  getAccessToken,
  createPresentationRequest,
  assertPresentationConfiguration,
  buildPresentationRequestPayload,
};
