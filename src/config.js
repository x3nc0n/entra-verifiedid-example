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

function isGuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(String(value || ''));
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function isTableName(value) {
  return /^[A-Za-z][A-Za-z0-9]{2,62}$/.test(String(value || ''));
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
    pilotGroupId: process.env.PILOT_GROUP_ID || '',
    tapLifetimeMinutes: parseInteger(process.env.TAP_LIFETIME_MINUTES, 60),
    securityInfoUrl: process.env.ENTRA_SECURITY_INFO_URL ||
      'https://mysignins.microsoft.com/security-info',
  },

  // ── Durable state ────────────────────────────────────────────────────────────
  storage: {
    backend: process.env.ONBOARDING_STATE_BACKEND || 'memory',
    tableEndpoint: process.env.AZURE_STORAGE_TABLE_ENDPOINT || '',
    invitationTableName: process.env.ONBOARDING_INVITATIONS_TABLE ||
      'onboardingInvitations',
    sessionTableName: process.env.ONBOARDING_SESSIONS_TABLE ||
      'onboardingSessions',
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

function validateRuntimeConfiguration() {
  const errors = [];
  const production = config.nodeEnv === 'production';

  if (!['memory', 'azure-table'].includes(config.storage.backend)) {
    errors.push('ONBOARDING_STATE_BACKEND must be memory or azure-table.');
  }
  if (production && config.demoMode) {
    errors.push('DEMO_MODE must be false in production.');
  }
  if (!config.demoMode) {
    if (!isGuid(config.graph.pilotGroupId)) {
      errors.push('PILOT_GROUP_ID must be the dedicated pilot group object ID.');
    }
    if (config.storage.backend !== 'azure-table') {
      errors.push(
        'Non-demo startup requires ONBOARDING_STATE_BACKEND=azure-table.'
      );
    }
    if (!isHttpsUrl(config.storage.tableEndpoint)) {
      errors.push(
        'AZURE_STORAGE_TABLE_ENDPOINT must be an HTTPS Table service endpoint.'
      );
    }
    if (!isTableName(config.storage.invitationTableName) ||
        !isTableName(config.storage.sessionTableName)) {
      errors.push(
        'Azure Table names must be 3-63 alphanumeric characters and start with a letter.'
      );
    }
  }
  if (production && !isHttpsUrl(config.appBaseUrl)) {
    errors.push('APP_BASE_URL must use HTTPS in production.');
  }
  if (production && config.assurance.mode === 'verified-id') {
    errors.push(
      'ASSURANCE_MODE=verified-id is blocked in production until callback state is durable.'
    );
  }

  if (errors.length > 0) {
    throw new Error(`Unsafe runtime configuration:\n- ${errors.join('\n- ')}`);
  }
}

config.validateRuntimeConfiguration = validateRuntimeConfiguration;

module.exports = config;
