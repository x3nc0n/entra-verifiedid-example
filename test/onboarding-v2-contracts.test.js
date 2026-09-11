'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const graphService = require('../src/services/graph-service');
const managerAuthService = require('../src/services/manager-auth-service');
const verifiedIdService = require('../src/services/verified-id-service');
const {
  hashNormalized,
  validateV2PresentedCredential,
} = require('../src/services/verified-subject-service');
const {
  protectSecret,
  unprotectSecret,
} = require('../src/services/v2-crypto-service');

let originalV2;
let originalTenantId;
let originalDemoMode;

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test.beforeEach(() => {
  originalV2 = structuredClone(config.selfServiceV2);
  originalTenantId = config.azure.tenantId;
  originalDemoMode = config.demoMode;
  config.demoMode = false;
  config.azure.tenantId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
  config.selfServiceV2.protectionKey = Buffer.alloc(32, 9).toString('base64');
  Object.assign(config.selfServiceV2.verifiedId, {
    authority: 'did:web:verifiedid.tenant.example:authority',
    manifestUrl: 'https://verifiedid.did.msidentity.com/manifest',
    credentialType: 'EmployeeOnboardingV2',
    objectIdClaim: 'employee.objectId',
    employeeIdClaim: 'employee.employeeId',
    linkedDomain: 'tenant.example',
    callbackApiKey: 'callback-key',
  });
  Object.assign(config.selfServiceV2.managerOidc, {
    clientId: 'manager-client-id',
    clientSecret: 'manager-client-secret',
    redirectUri: 'https://portal.example/auth/manager/callback',
  });
});

test.afterEach(() => {
  config.demoMode = originalDemoMode;
  config.azure.tenantId = originalTenantId;
  config.selfServiceV2 = originalV2;
});

test('builds the exact employee and manager expansion query', async () => {
  const source = read('src/services/graph-service.js');
  assert.match(
    source,
    /\$select: 'id,displayName,userPrincipalName,employeeId,accountEnabled'/
  );
  assert.match(
    source,
    /\$expand: 'manager\(\$select=id,displayName,mail,userPrincipalName\)'/
  );
  assert.deepEqual(config.graph.requiredV2ApplicationPermissions, [
    'User.Read.All',
    'GroupMember.Read.All',
    'UserAuthMethod-TAP.ReadWrite.All',
    'UserAuthMethod-Passkey.Read.All',
  ]);
  assert.equal(typeof graphService.getEmployeeWithManager, 'function');
});

test('builds issuance from server-bound object ID and employee ID claims', () => {
  const payload = verifiedIdService.buildV2IssuanceRequestPayload({
    callbackUrl: 'https://portal.example/api/v2/verified-id/issuance/callback',
    callbackState: 'issuance-state',
    employeeObjectId: '11111111-2222-3333-4444-555555555555',
    employeeId: 'EMP-1001',
    pin: '123456',
  });

  assert.equal(payload.authority, config.selfServiceV2.verifiedId.authority);
  assert.equal(payload.manifest, config.selfServiceV2.verifiedId.manifestUrl);
  assert.equal(payload.type, 'EmployeeOnboardingV2');
  assert.equal(payload.callback.state, 'issuance-state');
  assert.equal(payload.claims['employee.objectId'], '11111111-2222-3333-4444-555555555555');
  assert.equal(payload.claims['employee.employeeId'], 'EMP-1001');
  assert.deepEqual(payload.pin, { value: '123456', type: 'numeric', length: 6 });
});

test('constrains presentation to the exact tenant issuer and bound claims', () => {
  const payload = verifiedIdService.buildV2PresentationRequestPayload({
    callbackUrl: 'https://portal.example/api/v2/verified-id/presentation/callback',
    callbackState: 'presentation-state',
    employeeObjectId: '11111111-2222-3333-4444-555555555555',
    employeeId: 'EMP-1001',
  });
  const requested = payload.requestedCredentials[0];

  assert.deepEqual(requested.acceptedIssuers, [
    config.selfServiceV2.verifiedId.authority,
  ]);
  assert.equal(requested.configuration.validation.allowRevoked, false);
  assert.equal(requested.configuration.validation.validateLinkedDomain, true);
  assert.deepEqual(requested.constraints, [
    {
      claimName: 'employee.objectId',
      values: ['11111111-2222-3333-4444-555555555555'],
    },
    {
      claimName: 'employee.employeeId',
      values: ['EMP-1001'],
    },
  ]);
});

test('validates issuer, domain, dates, object ID, employee ID, and revocation', () => {
  const now = Date.parse('2026-09-10T12:00:00Z');
  const credential = {
    issuer: config.selfServiceV2.verifiedId.authority,
    type: ['VerifiableCredential', 'EmployeeOnboardingV2'],
    claims: {
      employee: {
        objectId: '11111111-2222-3333-4444-555555555555',
        employeeId: 'EMP-1001',
      },
    },
    credentialState: { revocationStatus: 'VALID' },
    domainValidation: { url: 'https://tenant.example', status: 'valid' },
    issuanceDate: '2026-09-10T11:00:00Z',
    expirationDate: '2026-10-10T12:00:00Z',
  };
  const audit = validateV2PresentedCredential(
    credential,
    {
      objectId: '11111111-2222-3333-4444-555555555555',
      employeeIdHash: hashNormalized('EMP-1001'),
    },
    {
      issuer: config.selfServiceV2.verifiedId.authority,
      credentialType: config.selfServiceV2.verifiedId.credentialType,
      objectIdClaim: config.selfServiceV2.verifiedId.objectIdClaim,
      employeeIdClaim: config.selfServiceV2.verifiedId.employeeIdClaim,
      linkedDomain: config.selfServiceV2.verifiedId.linkedDomain,
    },
    now
  );
  assert.equal(audit.linkedDomain, 'tenant.example');

  assert.throws(
    () => validateV2PresentedCredential(
      { ...credential, issuer: 'did:web:other.example' },
      {
        objectId: '11111111-2222-3333-4444-555555555555',
        employeeIdHash: hashNormalized('EMP-1001'),
      },
      {
        issuer: config.selfServiceV2.verifiedId.authority,
        credentialType: config.selfServiceV2.verifiedId.credentialType,
        objectIdClaim: config.selfServiceV2.verifiedId.objectIdClaim,
        employeeIdClaim: config.selfServiceV2.verifiedId.employeeIdClaim,
        linkedDomain: config.selfServiceV2.verifiedId.linkedDomain,
      },
      now
    ),
    /issuer/
  );
});

test('protects transient PIN and TAP values with authenticated encryption', () => {
  const protectedValue = protectSecret('one-time-secret');
  assert.notEqual(protectedValue, 'one-time-secret');
  assert.equal(unprotectSecret(protectedValue), 'one-time-secret');
  assert.throws(() => unprotectSecret(`${protectedValue}tampered`));
});

test('validates manager OIDC tid, oid, audience, issuer, nonce, and time', () => {
  const now = Math.floor(Date.now() / 1000);
  const manager = managerAuthService.validateIdTokenClaims(
    {
      tid: config.azure.tenantId,
      oid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      aud: config.selfServiceV2.managerOidc.clientId,
      iss: `https://login.microsoftonline.com/${config.azure.tenantId}/v2.0`,
      nonce: 'expected-nonce',
      nbf: now - 60,
      exp: now + 300,
    },
    {
      tenantId: config.azure.tenantId,
      clientId: config.selfServiceV2.managerOidc.clientId,
      nonce: 'expected-nonce',
    }
  );
  assert.equal(manager.objectId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.throws(
    () => managerAuthService.validateIdTokenClaims(
      {
        tid: config.azure.tenantId,
        oid: manager.objectId,
        aud: config.selfServiceV2.managerOidc.clientId,
        iss: `https://login.microsoftonline.com/${config.azure.tenantId}/v2.0`,
        nonce: 'wrong',
        exp: now + 300,
      },
      {
        tenantId: config.azure.tenantId,
        clientId: config.selfServiceV2.managerOidc.clientId,
        nonce: 'expected-nonce',
      }
    ),
    /nonce/
  );
});

test('exposes only the canonical v2 routes and root redirect', () => {
  const appSource = read('src/app.js');
  const configSource = read('src/config.js');
  const onboardingSource = read('src/routes/v2-onboarding.js');
  const managerSource = read('src/routes/v2-manager.js');
  const verifiedIdSource = read('src/routes/v2-verified-id.js');
  const passkeySource = read('src/routes/v2-passkey.js');
  const recoverySource = read('src/routes/v2-recovery.js');
  const routes = [
    onboardingSource,
    managerSource,
    verifiedIdSource,
    passkeySource,
    recoverySource,
  ].join('\n');

  assert.match(appSource, /res\.redirect\('\/v2\/onboarding'\)/);
  assert.match(appSource, /app\.use\('\/', v2OnboardingRouter\)/);
  assert.match(appSource, /app\.use\('\/', v2VerifiedIdRouter\)/);
  assert.match(appSource, /app\.use\('\/', v2ManagerRouter\)/);
  assert.match(appSource, /app\.use\('\/', v2PasskeyRouter\)/);
  assert.match(appSource, /app\.use\('\/', v2RecoveryRouter\)/);
  assert.doesNotMatch(appSource, /requireV2Enabled/);
  assert.doesNotMatch(appSource, /indexRouter|onboardingRouter|invitationsRouter|recoveryRouter|verificationRouter|passkeyRouter/);
  assert.doesNotMatch(configSource, /ASSURANCE_MODE|SELF_SERVICE_V2_ENABLED|ONBOARDING_APPROVAL_API_KEY|INVITATION_LIFETIME_MINUTES|INVITATION_MAX_ATTEMPTS/);

  [
    '/v2/onboarding',
    '/api/v2/onboarding/requests',
    '/api/v2/onboarding/status',
    '/v2/onboarding/invite',
    '/api/v2/onboarding/invitations/activate',
    '/api/v2/onboarding/invitations/confirm',
    '/api/v2/verified-id/issuance/requests',
    '/api/v2/verified-id/issuance/callback',
    '/api/v2/verified-id/presentation/requests',
    '/api/v2/verified-id/presentation/callback',
    '/v2/manager/approval',
    '/v2/manager/dashboard',
    '/api/v2/manager-approvals/activate',
    '/api/v2/manager/invitations',
    '/auth/manager/signin',
    '/auth/manager/dashboard/signin',
    '/auth/manager/callback',
    '/api/v2/manager-approvals/:requestId/decision',
    '/v2/recovery',
    '/api/v2/recovery/requests',
    '/api/v2/recovery/status',
    '/api/v2/recovery/verified-id/presentation/requests',
    '/api/v2/recovery/verified-id/presentation/callback',
    '/v2/recovery/passkey',
    '/api/v2/recovery/passkey/confirm',
    '/v2/recovery/complete',
    '/v2/passkey',
    '/api/v2/passkey/confirm',
    '/v2/complete',
  ].forEach((route) => assert.match(routes, new RegExp(
    route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  )));

  assert.match(onboardingSource, /\/v2\/manager\/approval#token=/);
  assert.match(managerSource, /\/v2\/onboarding\/invite#token=/);
});
