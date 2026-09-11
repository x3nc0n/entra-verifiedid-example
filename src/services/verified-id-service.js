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

function assertV2Configuration() {
  const v2 = config.selfServiceV2.verifiedId;
  const missing = [];
  if (!v2.authority) missing.push('V2_VERIFIED_ID_AUTHORITY');
  if (!v2.manifestUrl) missing.push('V2_VERIFIED_ID_MANIFEST_URL');
  if (!v2.credentialType) missing.push('V2_VERIFIED_ID_CREDENTIAL_TYPE');
  if (!v2.objectIdClaim) missing.push('V2_VERIFIED_ID_OBJECT_ID_CLAIM');
  if (!v2.employeeIdClaim) missing.push('V2_VERIFIED_ID_EMPLOYEE_ID_CLAIM');
  if (!v2.linkedDomain) missing.push('V2_VERIFIED_ID_LINKED_DOMAIN');
  if (!v2.callbackApiKey) missing.push('V2_VERIFIED_ID_CALLBACK_API_KEY');
  if (missing.length > 0) {
    throw new Error(`Verified ID v2 is missing configuration: ${missing.join(', ')}`);
  }
}

function v2Callback(callbackUrl, callbackState) {
  return {
    url: callbackUrl,
    state: callbackState,
    headers: {
      'api-key': config.selfServiceV2.verifiedId.callbackApiKey,
    },
  };
}

function buildV2IssuanceRequestPayload(input) {
  const v2 = config.selfServiceV2.verifiedId;
  return {
    includeQRCode: true,
    authority: v2.authority,
    registration: {
      clientName: 'Entra Verified ID Employee Onboarding',
    },
    type: v2.credentialType,
    manifest: v2.manifestUrl,
    callback: v2Callback(input.callbackUrl, input.callbackState),
    claims: {
      [v2.objectIdClaim]: input.employeeObjectId,
      [v2.employeeIdClaim]: input.employeeId,
    },
    pin: {
      value: input.pin,
      type: 'numeric',
      length: input.pin.length,
    },
  };
}

function buildV2PresentationRequestPayload(input) {
  const v2 = config.selfServiceV2.verifiedId;
  return {
    includeQRCode: true,
    includeReceipt: false,
    authority: v2.authority,
    registration: {
      clientName: 'Entra Verified ID Employee Onboarding',
    },
    callback: v2Callback(input.callbackUrl, input.callbackState),
    requestedCredentials: [
      {
        type: v2.credentialType,
        purpose: 'Complete approved employee onboarding',
        acceptedIssuers: [v2.authority],
        configuration: {
          validation: {
            allowRevoked: false,
            validateLinkedDomain: true,
          },
        },
        constraints: [
          {
            claimName: v2.objectIdClaim,
            values: [input.employeeObjectId],
          },
          {
            claimName: v2.employeeIdClaim,
            values: [input.employeeId],
          },
        ],
      },
    ],
  };
}

async function postV2Request(path, payload) {
  assertV2Configuration();
  const accessToken = await getAccessToken();
  const clientRequestId = uuidv4();
  const response = await axios.post(
    `${config.verifiedId.requestServiceUrl}/verifiableCredentials/${path}`,
    payload,
    {
      headers: {
        Authorization: ['Bearer', accessToken].join(' '),
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

async function createV2IssuanceRequest(input) {
  if (config.demoMode) {
    const requestId = uuidv4();
    return {
      requestId,
      url: `openid-vc://vc/issuance?requestId=${requestId}`,
      expiry: Math.floor(Date.now() / 1000) + 300,
      qrCode: null,
    };
  }
  return postV2Request(
    'createIssuanceRequest',
    buildV2IssuanceRequestPayload(input)
  );
}

async function createV2PresentationRequest(input) {
  if (config.demoMode) {
    const requestId = uuidv4();
    return {
      requestId,
      url: `openid-vc://vc/presentation?requestId=${requestId}`,
      expiry: Math.floor(Date.now() / 1000) + 300,
      qrCode: null,
    };
  }
  return postV2Request(
    'createPresentationRequest',
    buildV2PresentationRequestPayload(input)
  );
}

module.exports = {
  getAccessToken,
  assertV2Configuration,
  buildV2IssuanceRequestPayload,
  buildV2PresentationRequestPayload,
  createV2IssuanceRequest,
  createV2PresentationRequest,
};
