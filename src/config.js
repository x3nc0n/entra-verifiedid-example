'use strict';

require('dotenv').config();

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

const config = {
  // ── Application ─────────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  demoMode: process.env.DEMO_MODE === 'true',

  // ── First-release assurance ──────────────────────────────────────────────────
  assurance: {
    mode: process.env.ASSURANCE_MODE || 'invitation',
    approvalApiKey: process.env.ONBOARDING_APPROVAL_API_KEY || '',
    invitationLifetimeMinutes: parseInteger(
      process.env.INVITATION_LIFETIME_MINUTES,
      60
    ),
    invitationMaxAttempts: parseInteger(process.env.INVITATION_MAX_ATTEMPTS, 5),
  },

  // ── Azure AD / Entra ID ──────────────────────────────────────────────────────
  azure: {
    tenantId: process.env.AZURE_TENANT_ID || '',
    // Client ID of the app runtime user-assigned managed identity in Azure.
    // DefaultAzureCredential uses this to disambiguate which identity to use.
    clientId: process.env.AZURE_CLIENT_ID || '',
    // Deprecated for Graph / Verified ID runtime auth now that services prefer
    // DefaultAzureCredential, but left here while infra/bootstrap still emit it.
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
    // DID of this relying-party tenant, used as the presentation authority.
    verifierAuthority: process.env.VC_VERIFIER_AUTHORITY || '',
    // Partner-issued credential contract values. These must come from the
    // approved identity-proofing provider contract.
    credentialType: process.env.VC_CREDENTIAL_TYPE || '',
    acceptedIssuers: parseCsv(process.env.VC_ACCEPTED_ISSUERS),
    userPrincipalNameClaim: process.env.VC_USER_PRINCIPAL_NAME_CLAIM || '',
    employeeIdClaim: process.env.VC_EMPLOYEE_ID_CLAIM || '',
    callbackApiKey: process.env.VC_CALLBACK_API_KEY || '',
  },

  // ── Microsoft Graph API ──────────────────────────────────────────────────────
  graph: {
    baseUrl: 'https://graph.microsoft.com',
    scope: 'https://graph.microsoft.com/.default',
    tapLifetimeMinutes: parseInteger(process.env.TAP_LIFETIME_MINUTES, 60),
    securityInfoUrl: process.env.ENTRA_SECURITY_INFO_URL ||
      'https://mysignins.microsoft.com/security-info',
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

if (!['invitation', 'verified-id'].includes(config.assurance.mode)) {
  throw new Error('ASSURANCE_MODE must be invitation or verified-id.');
}
if (config.assurance.invitationMaxAttempts < 1 ||
    config.assurance.invitationMaxAttempts > 20) {
  throw new Error('INVITATION_MAX_ATTEMPTS must be between 1 and 20.');
}

module.exports = config;
