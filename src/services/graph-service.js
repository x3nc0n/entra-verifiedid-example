'use strict';

const { DefaultAzureCredential } = require('@azure/identity');
const axios = require('axios');
const crypto = require('crypto');
const config = require('../config');

let credential = null;

class PilotEligibilityError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PilotEligibilityError';
    this.code = code;
  }
}

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

function authorizationHeaders(accessToken) {
  return { Authorization: ['Bearer', accessToken].join(' ') };
}

function escapeOData(value) {
  return String(value).replace(/'/g, "''");
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

async function getUserByEmployeeId(employeeId, dependencies = {}) {
  if (config.demoMode) {
    return {
      id: 'demo-user-id-00000000-0000-0000-0000-000000000001',
      displayName: 'Demo User',
      userPrincipalName: 'demo.user@tenant.example',
      employeeId,
      accountEnabled: true,
    };
  }

  const token = await (dependencies.getAccessToken || getAccessToken)();
  const get = dependencies.get || axios.get.bind(axios);
  const normalizedEmployeeId = String(employeeId || '').trim();
  const response = await get(
    `${config.graph.baseUrl}/v1.0/users`,
    {
      params: {
        $select: 'id,displayName,userPrincipalName,employeeId,accountEnabled',
        $filter: `employeeId eq '${escapeOData(normalizedEmployeeId)}'`,
        $top: 2,
      },
      headers: authorizationHeaders(token),
    }
  );
  const matches = (response.data.value || []).filter((user) =>
    String(user.employeeId || '').trim().toLowerCase() ===
      normalizedEmployeeId.toLowerCase()
  );
  if (matches.length > 1) {
    const err = new Error('Multiple employees matched the supplied employee ID.');
    err.code = 'employee_id_ambiguous';
    throw err;
  }
  return matches[0] || null;
}

async function getManagerByUserId(userId, dependencies = {}) {
  if (config.demoMode) {
    if (String(userId) === 'demo-user-id-00000000-0000-0000-0000-000000000001') {
      return {
        id: 'demo-manager-id-00000000-0000-0000-0000-000000000002',
        displayName: 'Demo Manager',
        mail: 'demo.manager@tenant.example',
        userPrincipalName: 'demo.manager@tenant.example',
      };
    }
    if (String(userId) === 'demo-manager-id-00000000-0000-0000-0000-000000000002') {
      return {
        id: 'demo-skip-manager-id-0000-0000-0000-000000000004',
        displayName: 'Demo Skip Manager',
        mail: 'demo.skip.manager@tenant.example',
        userPrincipalName: 'demo.skip.manager@tenant.example',
      };
    }
    return null;
  }

  const token = await (dependencies.getAccessToken || getAccessToken)();
  const get = dependencies.get || axios.get.bind(axios);
  const encodedUser = encodeURIComponent(userId);
  try {
    const response = await get(
      `${config.graph.baseUrl}/v1.0/users/${encodedUser}/manager/microsoft.graph.user`,
      {
        params: { $select: 'id,displayName,mail,userPrincipalName' },
        headers: authorizationHeaders(token),
      }
    );
    return response.data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function getEmployeeWithManager(userPrincipalName) {
  if (config.demoMode) {
    return {
      id: 'demo-user-id-00000000-0000-0000-0000-000000000001',
      displayName: 'Demo User',
      userPrincipalName,
      employeeId: 'DEMO-001',
      accountEnabled: true,
      manager: {
        id: 'demo-manager-id-00000000-0000-0000-0000-000000000002',
        displayName: 'Demo Manager',
        mail: 'demo.manager@tenant.example',
        userPrincipalName: 'demo.manager@tenant.example',
      },
    };
  }

  const token = await getAccessToken();
  const encodedUser = encodeURIComponent(userPrincipalName);
  try {
    const response = await axios.get(
      `${config.graph.baseUrl}/v1.0/users/${encodedUser}`,
      {
        params: {
          $select: 'id,displayName,userPrincipalName,employeeId,accountEnabled',
          $expand: 'manager($select=id,displayName,mail,userPrincipalName)',
        },
        headers: authorizationHeaders(token),
      }
    );
    return response.data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function listDirectReports(managerObjectId, dependencies = {}) {
  if (config.demoMode) {
    return [
      {
        id: 'demo-user-id-00000000-0000-0000-0000-000000000001',
        displayName: 'Demo User',
        userPrincipalName: 'demo.user@tenant.example',
        mail: 'demo.user@tenant.example',
        employeeId: 'DEMO-001',
        accountEnabled: true,
      },
      {
        id: 'demo-user-id-00000000-0000-0000-0000-000000000003',
        displayName: 'Second Demo User',
        userPrincipalName: 'second.demo@tenant.example',
        mail: 'second.demo@tenant.example',
        employeeId: 'DEMO-002',
        accountEnabled: true,
      },
    ];
  }

  const token = await (dependencies.getAccessToken || getAccessToken)();
  const get = dependencies.get || axios.get.bind(axios);
  const reports = [];
  let nextUrl =
    `${config.graph.baseUrl}/v1.0/users/${encodeURIComponent(managerObjectId)}` +
    '/directReports/microsoft.graph.user';
  let params = {
    $select: 'id,displayName,userPrincipalName,mail,employeeId,accountEnabled',
  };

  while (nextUrl) {
    // eslint-disable-next-line no-await-in-loop
    const response = await get(nextUrl, {
      params,
      headers: authorizationHeaders(token),
    });
    for (const value of response.data.value || []) {
      if (String(value['@odata.type'] || '#microsoft.graph.user')
        .toLowerCase() === '#microsoft.graph.user') {
        reports.push(value);
      }
    }
    nextUrl = response.data['@odata.nextLink'] || null;
    params = undefined;
  }

  return reports;
}

async function isUserDirectMemberOfGroup(userId, groupId, dependencies = {}) {
  if (config.demoMode) return true;

  const token = await (dependencies.getAccessToken || getAccessToken)();
  const get = dependencies.get || axios.get.bind(axios);
  const encodedGroup = encodeURIComponent(groupId);
  const encodedUser = encodeURIComponent(userId);
  try {
    await get(
      `${config.graph.baseUrl}/v1.0/groups/${encodedGroup}/members/${encodedUser}/$ref`,
      {
        headers: authorizationHeaders(token),
      }
    );
    return true;
  } catch (err) {
    if (err.response?.status === 404) return false;
    throw err;
  }
}

async function requireUserInGroup(userId, groupId, errorCode, dependencies = {}) {
  const checkMembership = dependencies.isUserDirectMemberOfGroup ||
    dependencies.isUserInGroup ||
    isUserDirectMemberOfGroup;
  if (!groupId || !await checkMembership(userId, groupId)) {
    throw new PilotEligibilityError(
      'The Entra account is not a current member of the required configured group.',
      errorCode
    );
  }
  return true;
}

async function requireNativeUser(userId, dependencies = {}) {
  return requireUserInGroup(
    userId,
    dependencies.usersGroupId || config.selfServiceV2.authorization.usersGroupId,
    'native_users_group_required',
    dependencies
  );
}

async function requirePortalAdmin(userId, dependencies = {}) {
  return requireUserInGroup(
    userId,
    dependencies.adminGroupId || config.selfServiceV2.authorization.adminGroupId,
    'admin_group_required',
    dependencies
  );
}

async function getEligiblePilotUser(userId, dependencies = {}) {
  const loadUser = dependencies.getUserById || getUserById;
  const checkMembership = dependencies.isUserInGroup || isUserInGroup;
  const groupId = dependencies.pilotGroupId || config.graph.pilotGroupId;
  const user = await loadUser(userId);

  if (!user || String(user.id).toLowerCase() !== String(userId).toLowerCase()) {
    throw new PilotEligibilityError(
      'The invitation-bound Entra account no longer exists.',
      'user_not_found'
    );
  }
  if (user.accountEnabled !== true) {
    throw new PilotEligibilityError(
      'The invitation-bound Entra account is disabled.',
      'account_disabled'
    );
  }
  await requireNativeUser(user.id, dependencies);
  if (!config.demoMode && (!groupId || !await checkMembership(user.id, groupId))) {
    throw new PilotEligibilityError(
      'The invitation-bound Entra account is not a current member of the configured pilot group.',
      'pilot_group_required'
    );
  }
  return user;
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

async function createTemporaryAccessPassForPilotUser(userId, dependencies = {}) {
  const validateUser = dependencies.getEligiblePilotUser || getEligiblePilotUser;
  const createTap = dependencies.createTemporaryAccessPass ||
    createTemporaryAccessPass;

  const user = await validateUser(userId);
  const tap = await createTap(user.id);
  return { user, tap };
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

async function deleteFido2Method(userId, methodId) {
  if (config.demoMode) {
    return { deleted: true, id: methodId };
  }

  const token = await getAccessToken();
  const encodedUser = encodeURIComponent(userId);
  const encodedMethod = encodeURIComponent(methodId);
  await axios.delete(
    `${config.graph.baseUrl}/v1.0/users/${encodedUser}/authentication/fido2Methods/${encodedMethod}`,
    { headers: authorizationHeaders(token) }
  );
  return { deleted: true, id: methodId };
}

// Revokes every existing tenant passkey for a user who reports losing all of
// their authenticators, so a stale or potentially compromised credential can
// never be used again once account recovery has issued a new one.
async function revokeAllFido2Methods(userId, dependencies = {}) {
  const listMethods = dependencies.listFido2Methods || listFido2Methods;
  const deleteMethod = dependencies.deleteFido2Method || deleteFido2Method;

  const methods = await listMethods(userId);
  const revokedMethodIds = [];
  for (const method of methods) {
    // eslint-disable-next-line no-await-in-loop
    await deleteMethod(userId, method.id);
    revokedMethodIds.push(method.id);
  }
  return revokedMethodIds;
}

module.exports = {
  getAccessToken,
  getUserByPrincipalName,
  getUserById,
  getUserByEmployeeId,
  getManagerByUserId,
  getEmployeeWithManager,
  listDirectReports,
  isUserInGroup: isUserDirectMemberOfGroup,
  isUserDirectMemberOfGroup,
  requireUserInGroup,
  requireNativeUser,
  requirePortalAdmin,
  getEligiblePilotUser,
  createTemporaryAccessPass,
  createTemporaryAccessPassForPilotUser,
  getFido2CreationOptions,
  registerFido2Key,
  listFido2Methods,
  deleteFido2Method,
  revokeAllFido2Methods,
  buildFido2RegistrationPayload,
  PilotEligibilityError,
};
