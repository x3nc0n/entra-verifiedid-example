'use strict';

const crypto = require('crypto');
const {
  ConfidentialClientApplication,
  CryptoProvider,
} = require('@azure/msal-node');
const config = require('../config');
const { timingSafeTextEqual } = require('./v2-crypto-service');

function createMsalClient() {
  return new ConfidentialClientApplication({
    auth: {
      clientId: config.selfServiceV2.managerOidc.clientId,
      authority: `https://login.microsoftonline.com/${config.azure.tenantId}`,
      clientSecret: config.selfServiceV2.managerOidc.clientSecret,
    },
    system: {
      loggerOptions: {
        piiLoggingEnabled: false,
        loggerCallback: () => {},
      },
    },
  });
}

function validateIdTokenClaims(claims, expected) {
  if (!claims || typeof claims !== 'object') {
    throw new Error('Manager ID token claims are missing.');
  }
  if (!timingSafeTextEqual(claims.tid, expected.tenantId)) {
    throw new Error('Manager ID token tenant does not match.');
  }
  if (!timingSafeTextEqual(claims.aud, expected.clientId)) {
    throw new Error('Manager ID token audience does not match.');
  }
  if (!timingSafeTextEqual(claims.nonce, expected.nonce)) {
    throw new Error('Manager ID token nonce does not match.');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(String(claims.oid || ''))) {
    throw new Error('Manager ID token object ID is invalid.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) <= now) {
    throw new Error('Manager ID token is expired.');
  }
  if (claims.nbf !== undefined && Number(claims.nbf) > now + 60) {
    throw new Error('Manager ID token is not valid yet.');
  }
  const acceptedIssuers = [
    `https://login.microsoftonline.com/${expected.tenantId}/v2.0`,
    `https://sts.windows.net/${expected.tenantId}/`,
  ];
  if (!acceptedIssuers.some((issuer) => timingSafeTextEqual(claims.iss, issuer))) {
    throw new Error('Manager ID token issuer does not match.');
  }
  const roles = Array.isArray(claims.roles)
    ? claims.roles.filter((role) => typeof role === 'string')
    : [];
  return {
    objectId: claims.oid,
    tenantId: claims.tid,
    displayName: claims.name || null,
    roles,
  };
}

function hasRole(authenticatedPrincipal, roleValue) {
  return Boolean(roleValue) &&
    Array.isArray(authenticatedPrincipal?.roles) &&
    authenticatedPrincipal.roles.some((role) => timingSafeTextEqual(role, roleValue));
}

function requireRole(authenticatedPrincipal, roleValue, message) {
  if (!hasRole(authenticatedPrincipal, roleValue)) {
    const err = new Error(message);
    err.code = 'required_app_role_missing';
    err.status = 403;
    throw err;
  }
}

function createManagerAuthService(options = {}) {
  const client = options.client || createMsalClient();
  const cryptoProvider = options.cryptoProvider || new CryptoProvider();

  async function createAuthorizationRequest() {
    const pkce = await cryptoProvider.generatePkceCodes();
    const state = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(32).toString('base64url');
    const url = await client.getAuthCodeUrl({
      scopes: ['openid', 'profile'],
      redirectUri: config.selfServiceV2.managerOidc.redirectUri,
      responseMode: 'form_post',
      codeChallenge: pkce.challenge,
      codeChallengeMethod: 'S256',
      state,
      nonce,
      prompt: 'select_account',
    });
    return {
      url,
      state,
      nonce,
      codeVerifier: pkce.verifier,
    };
  }

  async function exchangeAuthorizationCode(input) {
    if (!input.code ||
        !timingSafeTextEqual(input.state, input.expectedState)) {
      throw new Error('Manager authorization response state does not match.');
    }
    const result = await client.acquireTokenByCode(
      {
        code: input.code,
        scopes: ['openid', 'profile'],
        redirectUri: config.selfServiceV2.managerOidc.redirectUri,
        codeVerifier: input.codeVerifier,
        state: input.state,
      },
      input.authorizationPayload
    );
    return validateIdTokenClaims(result.idTokenClaims, {
      tenantId: config.azure.tenantId,
      clientId: config.selfServiceV2.managerOidc.clientId,
      nonce: input.expectedNonce,
    });
  }

  return {
    createAuthorizationRequest,
    exchangeAuthorizationCode,
  };
}

let defaultService;
function getDefaultService() {
  if (!defaultService) defaultService = createManagerAuthService();
  return defaultService;
}

module.exports = {
  createManagerAuthService,
  validateIdTokenClaims,
  hasRole,
  requireRole,
  createAuthorizationRequest: (...args) =>
    getDefaultService().createAuthorizationRequest(...args),
  exchangeAuthorizationCode: (...args) =>
    getDefaultService().exchangeAuthorizationCode(...args),
};
