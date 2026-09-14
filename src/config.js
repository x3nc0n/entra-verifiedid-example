'use strict';

require('dotenv').config();

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

function isEmailAddress(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value || ''));
}

function isAcsConnectionString(value) {
  return /^endpoint=https:\/\/[^;]+;accesskey=[^;\s]+;?$/i
    .test(String(value || ''));
}

function isProtectionKey(value) {
  try {
    return Buffer.from(String(value || ''), 'base64').length === 32;
  } catch (_) {
    return false;
  }
}

const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:3000';

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret-change-me',
  appBaseUrl,
  demoMode: process.env.DEMO_MODE === 'true',

  azure: {
    tenantId: process.env.AZURE_TENANT_ID || '',
    clientId: process.env.AZURE_CLIENT_ID || '',
    clientSecret: process.env.AZURE_CLIENT_SECRET || '',
    authority: process.env.AZURE_AUTHORITY ||
      `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID || 'common'}`,
  },

  verifiedId: {
    serviceScope: process.env.VC_SERVICE_SCOPE ||
      '3db474b9-6a0c-4840-96ac-1fceb342124f/.default',
    requestServiceUrl: 'https://verifiedid.did.msidentity.com/v1.0',
  },

  selfServiceV2: {
    requestLifetimeMinutes: parseInteger(
      process.env.V2_REQUEST_LIFETIME_MINUTES,
      1440
    ),
    managerTokenLifetimeMinutes: parseInteger(
      process.env.V2_MANAGER_TOKEN_LIFETIME_MINUTES,
      1440
    ),
    managerPreAuthLifetimeMinutes: parseInteger(
      process.env.V2_MANAGER_PREAUTH_LIFETIME_MINUTES,
      10
    ),
    maxDailyRequestsPerUpn: parseInteger(
      process.env.V2_MAX_DAILY_REQUESTS_PER_UPN,
      3
    ),
    maxDailyRequestsPerIp: parseInteger(
      process.env.V2_MAX_DAILY_REQUESTS_PER_IP,
      10
    ),
    maxDailyRequestsPerEmployee: parseInteger(
      process.env.V2_MAX_DAILY_REQUESTS_PER_EMPLOYEE,
      3
    ),
    maxDailyManagerInvitations: parseInteger(
      process.env.V2_MAX_DAILY_MANAGER_INVITATIONS,
      20
    ),
    maxEmployeeInviteConfirmAttempts: parseInteger(
      process.env.V2_MAX_EMPLOYEE_INVITE_CONFIRM_ATTEMPTS,
      3
    ),
    maxPasskeyConfirmAttempts: parseInteger(
      process.env.V2_MAX_PASSKEY_CONFIRM_ATTEMPTS,
      30
    ),
    maxIssuanceRetries: parseInteger(process.env.V2_MAX_ISSUANCE_RETRIES, 3),
    maxPresentationRetries: parseInteger(
      process.env.V2_MAX_PRESENTATION_RETRIES,
      3
    ),
    maxVerificationFailures: parseInteger(
      process.env.V2_MAX_VERIFICATION_FAILURES,
      3
    ),
    protectionKey: process.env.V2_TRANSIENT_PROTECTION_KEY || '',
    managerOidc: {
      clientId: process.env.V2_MANAGER_OIDC_CLIENT_ID || '',
      clientSecret: process.env.V2_MANAGER_OIDC_CLIENT_SECRET || '',
      redirectUri: process.env.V2_MANAGER_OIDC_REDIRECT_URI ||
        `${appBaseUrl}/auth/manager/callback`,
    },
    authorization: {
      adminGroupId: process.env.V2_ADMIN_GROUP_ID || '',
      usersGroupId: process.env.V2_USERS_GROUP_ID || '',
    },
    verifiedId: {
      authority: process.env.V2_VERIFIED_ID_AUTHORITY || '',
      manifestUrl: process.env.V2_VERIFIED_ID_MANIFEST_URL || '',
      credentialType: process.env.V2_VERIFIED_ID_CREDENTIAL_TYPE || '',
      objectIdClaim: process.env.V2_VERIFIED_ID_OBJECT_ID_CLAIM || '',
      employeeIdClaim: process.env.V2_VERIFIED_ID_EMPLOYEE_ID_CLAIM || '',
      linkedDomain: process.env.V2_VERIFIED_ID_LINKED_DOMAIN || '',
      callbackApiKey: process.env.V2_VERIFIED_ID_CALLBACK_API_KEY || '',
      issuancePinLength: parseInteger(
        process.env.V2_VERIFIED_ID_ISSUANCE_PIN_LENGTH,
        6
      ),
    },
    notification: {
      provider: process.env.V2_MANAGER_NOTIFICATION_PROVIDER || 'noop',
      acs: {
        endpoint: process.env.V2_ACS_EMAIL_ENDPOINT || '',
        connectionString:
          process.env.V2_ACS_EMAIL_CONNECTION_STRING || '',
        senderAddress: process.env.V2_ACS_EMAIL_SENDER_ADDRESS || '',
      },
    },
    recovery: {
      requestLifetimeMinutes: parseInteger(
        process.env.V2_RECOVERY_REQUEST_LIFETIME_MINUTES,
        60
      ),
      maxDailyRequestsPerIp: parseInteger(
        process.env.V2_RECOVERY_MAX_DAILY_REQUESTS_PER_IP,
        5
      ),
      maxDailyRequestsPerUpn: parseInteger(
        process.env.V2_RECOVERY_MAX_DAILY_REQUESTS_PER_UPN,
        3
      ),
      maxDailyRequestsPerEmployee: parseInteger(
        process.env.V2_RECOVERY_MAX_DAILY_REQUESTS_PER_EMPLOYEE,
        3
      ),
      maxPresentationRetries: parseInteger(
        process.env.V2_RECOVERY_MAX_PRESENTATION_RETRIES,
        3
      ),
      maxVerificationFailures: parseInteger(
        process.env.V2_RECOVERY_MAX_VERIFICATION_FAILURES,
        3
      ),
      maxPasskeyConfirmAttempts: parseInteger(
        process.env.V2_RECOVERY_MAX_PASSKEY_CONFIRM_ATTEMPTS,
        30
      ),
    },
  },

  graph: {
    baseUrl: 'https://graph.microsoft.com',
    scope: 'https://graph.microsoft.com/.default',
    pilotGroupId: process.env.PILOT_GROUP_ID || '',
    tapLifetimeMinutes: parseInteger(process.env.TAP_LIFETIME_MINUTES, 60),
    securityInfoUrl: process.env.ENTRA_SECURITY_INFO_URL ||
      'https://mysignins.microsoft.com/security-info',
    requiredV2ApplicationPermissions: [
      'User.Read.All',
      'GroupMember.Read.All',
      'UserAuthMethod-TAP.ReadWrite.All',
      'UserAuthMethod-Passkey.Read.All',
    ],
  },

  storage: {
    backend: process.env.ONBOARDING_STATE_BACKEND || 'memory',
    tableEndpoint: process.env.AZURE_STORAGE_TABLE_ENDPOINT || '',
    sessionTableName: process.env.ONBOARDING_SESSIONS_TABLE ||
      'onboardingSessions',
    v2RequestTableName: process.env.ONBOARDING_V2_REQUESTS_TABLE ||
      'onboardingV2Requests',
  },

  fido2: {
    rpName: process.env.FIDO2_RP_NAME || 'Entra Verified ID Demo',
    rpId: process.env.FIDO2_RP_ID || 'localhost',
    origin: process.env.FIDO2_ORIGIN || 'http://localhost:3000',
    supportedAlgorithmIDs: [-7, -257],
  },

  keyVault: {
    url: process.env.KEY_VAULT_URL || '',
  },
};

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
    if (!isTableName(config.storage.sessionTableName) ||
        !isTableName(config.storage.v2RequestTableName)) {
      errors.push(
        'Azure Table names must be 3-63 alphanumeric characters and start with a letter.'
      );
    }
  }
  if (production && !isHttpsUrl(config.appBaseUrl)) {
    errors.push('APP_BASE_URL must use HTTPS in production.');
  }

  const v2 = config.selfServiceV2;
  const verifiedId = v2.verifiedId;
  const managerOidc = v2.managerOidc;

  if (!config.demoMode && !isGuid(config.azure.tenantId)) {
    errors.push('AZURE_TENANT_ID must be configured for self-service onboarding.');
  }
  if (!config.demoMode && !managerOidc.clientId) {
    errors.push('V2_MANAGER_OIDC_CLIENT_ID is required.');
  }
  if (!config.demoMode && !managerOidc.clientSecret) {
    errors.push('V2_MANAGER_OIDC_CLIENT_SECRET is required.');
  }
  if (!config.demoMode && !isGuid(v2.authorization.adminGroupId)) {
    errors.push('V2_ADMIN_GROUP_ID must be the immutable portal admin group object ID.');
  }
  if (!config.demoMode && !isGuid(v2.authorization.usersGroupId)) {
    errors.push('V2_USERS_GROUP_ID must be the immutable NativeUsers group object ID.');
  }
  if (!isHttpsUrl(managerOidc.redirectUri) && !config.demoMode) {
    errors.push('V2_MANAGER_OIDC_REDIRECT_URI must use HTTPS.');
  }
  if (!config.demoMode && (
    !verifiedId.authority ||
    !verifiedId.manifestUrl ||
    !verifiedId.credentialType ||
    !verifiedId.objectIdClaim ||
    !verifiedId.employeeIdClaim ||
    !verifiedId.linkedDomain ||
    !verifiedId.callbackApiKey
  )) {
    errors.push(
      'V2 Verified ID authority, manifest, type, claim paths, linked domain, and callback key are required.'
    );
  }
  if (verifiedId.manifestUrl && !isHttpsUrl(verifiedId.manifestUrl)) {
    errors.push('V2_VERIFIED_ID_MANIFEST_URL must use HTTPS.');
  }
  if (!config.demoMode && !isProtectionKey(v2.protectionKey)) {
    errors.push(
      'V2_TRANSIENT_PROTECTION_KEY must be a base64-encoded 32-byte key.'
    );
  }
  if (v2.verifiedId.issuancePinLength < 4 ||
      v2.verifiedId.issuancePinLength > 16) {
    errors.push('V2_VERIFIED_ID_ISSUANCE_PIN_LENGTH must be between 4 and 16.');
  }
  if (!['noop', 'acs'].includes(v2.notification.provider)) {
    errors.push('V2_MANAGER_NOTIFICATION_PROVIDER must be noop or acs.');
  }
  if (v2.notification.provider === 'acs') {
    const acs = v2.notification.acs;
    if (!isEmailAddress(acs.senderAddress)) {
      errors.push(
        'V2_ACS_EMAIL_SENDER_ADDRESS must be a valid verified sender address.'
      );
    }
    if (!isHttpsUrl(acs.endpoint) && !acs.connectionString) {
      errors.push(
        'V2_ACS_EMAIL_ENDPOINT or V2_ACS_EMAIL_CONNECTION_STRING is required for ACS email.'
      );
    }
    if (acs.endpoint && !isHttpsUrl(acs.endpoint)) {
      errors.push('V2_ACS_EMAIL_ENDPOINT must use HTTPS.');
    }
    if (!acs.endpoint &&
        acs.connectionString &&
        !isAcsConnectionString(acs.connectionString)) {
      errors.push(
        'V2_ACS_EMAIL_CONNECTION_STRING must contain an HTTPS endpoint and access key.'
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`Unsafe runtime configuration:\n- ${errors.join('\n- ')}`);
  }
}

config.validateRuntimeConfiguration = validateRuntimeConfiguration;

module.exports = config;
