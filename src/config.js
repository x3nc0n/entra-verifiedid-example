'use strict';

require('dotenv').config();

const config = {
  // ── Application ─────────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  demoMode: process.env.DEMO_MODE === 'true',

  // ── Azure AD / Entra ID ──────────────────────────────────────────────────────
  azure: {
    tenantId: process.env.AZURE_TENANT_ID || '',
    clientId: process.env.AZURE_CLIENT_ID || '',
    clientSecret: process.env.AZURE_CLIENT_SECRET || '',
    authority: process.env.AZURE_AUTHORITY ||
      `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID || 'common'}`,
  },

  // ── Entra Verified ID ────────────────────────────────────────────────────────
  verifiedId: {
    // Audience / scope for the Request Service REST API
    serviceScope: process.env.VC_SERVICE_SCOPE ||
      '3db474b9-6a0c-4840-96ac-1fceb342124f/.default',
    // Request Service base URL
    requestServiceUrl: 'https://verifiedid.did.msidentity.com/v1.0',
    // Your credential contract manifest URL
    credentialManifestUrl: process.env.VC_CREDENTIAL_MANIFEST_URL || '',
    // Credential type name as defined in your contract
    credentialType: process.env.VC_CREDENTIAL_TYPE || 'VerifiedEmployee',
    // Your tenant's DID (issuer authority)
    issuerAuthority: process.env.VC_ISSUER_AUTHORITY || '',
  },

  // ── IdentityPass ─────────────────────────────────────────────────────────────
  identityPass: {
    apiEndpoint: process.env.IDENTITYPASS_API_ENDPOINT ||
      'https://identitypass.microsoft.com/api/v1',
    subscriptionKey: process.env.IDENTITYPASS_SUBSCRIPTION_KEY || '',
    defaultManagerEmail: process.env.IDENTITYPASS_MANAGER_EMAIL || '',
  },

  // ── Microsoft Graph API ──────────────────────────────────────────────────────
  graph: {
    baseUrl: 'https://graph.microsoft.com',
    scope: 'https://graph.microsoft.com/.default',
    betaUrl: 'https://graph.microsoft.com/beta',
  },

  // ── FIDO2 / WebAuthn ─────────────────────────────────────────────────────────
  fido2: {
    rpName: process.env.FIDO2_RP_NAME || 'Entra Verified ID Demo',
    rpId: process.env.FIDO2_RP_ID || 'localhost',
    origin: process.env.FIDO2_ORIGIN || 'http://localhost:3000',
    // Supported algorithms: ES256 (-7), RS256 (-257)
    supportedAlgorithmIDs: [-7, -257],
  },

  // ── Azure Key Vault ──────────────────────────────────────────────────────────
  keyVault: {
    url: process.env.KEY_VAULT_URL || '',
  },
};

module.exports = config;
