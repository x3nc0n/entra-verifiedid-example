'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const graphService = require('../src/services/graph-service');
const verifiedIdService = require('../src/services/verified-id-service');
const {
  readClaim,
  hashNormalized,
  validatePresentedCredential,
} = require('../src/services/verified-subject-service');
const {
  readClientData,
  findNewFido2Method,
} = require('../src/routes/passkey');
const { approvalKeyMatches } = require('../src/routes/invitations');
const { callbackKeyMatches } = require('../src/routes/verification');
const { runTapCreationOnce } = require('../src/routes/verification');

test('builds the Graph v1.0 FIDO2 credential submission shape', () => {
  const payload = graphService.buildFido2RegistrationPayload(
    {
      id: 'credential-id',
      response: {
        clientDataJSON: 'client-data',
        attestationObject: 'attestation',
      },
      clientExtensionResults: { credProps: { rk: true } },
    },
    'Pilot passkey'
  );

  assert.equal(payload['@odata.type'], '#microsoft.graph.fido2AuthenticationMethod');
  assert.equal(payload.displayName, 'Pilot passkey');
  assert.equal(payload.publicKeyCredential.id, 'credential-id');
  assert.equal(payload.publicKeyCredential.response.clientDataJSON, 'client-data');
  assert.deepEqual(payload.publicKeyCredential.clientExtensionResults.credProps, { rk: true });
});

test('correlates WebAuthn client data with the Graph challenge', () => {
  const clientData = {
    type: 'webauthn.create',
    challenge: 'graph-challenge',
    origin: 'https://login.microsoftonline.com',
  };
  const encoded = Buffer.from(JSON.stringify(clientData)).toString('base64url');

  assert.deepEqual(
    readClientData({ response: { clientDataJSON: encoded } }),
    clientData
  );
});

test('requires a newly registered FIDO2 method after invitation consumption', () => {
  const methods = [
    { id: 'existing-method' },
    { id: 'new-method' },
  ];

  assert.deepEqual(
    findNewFido2Method(methods, ['existing-method']),
    { id: 'new-method' }
  );
  assert.equal(findNewFido2Method(methods, ['existing-method', 'new-method']), null);
});

test('revokes every existing FIDO2 method for a user recovering a lost authenticator', async () => {
  const methods = [{ id: 'lost-method-one' }, { id: 'lost-method-two' }];
  const deleted = [];

  const revokedMethodIds = await graphService.revokeAllFido2Methods('user-id', {
    listFido2Methods: async () => methods,
    deleteFido2Method: async (userId, methodId) => {
      deleted.push({ userId, methodId });
      return { deleted: true, id: methodId };
    },
  });

  assert.deepEqual(revokedMethodIds, ['lost-method-one', 'lost-method-two']);
  assert.deepEqual(deleted, [
    { userId: 'user-id', methodId: 'lost-method-one' },
    { userId: 'user-id', methodId: 'lost-method-two' },
  ]);
});

test('revoking FIDO2 methods for a user with none registered is a no-op', async () => {
  const revokedMethodIds = await graphService.revokeAllFido2Methods('user-id', {
    listFido2Methods: async () => [],
    deleteFido2Method: async () => {
      throw new Error('deleteFido2Method should not be called when there are no methods.');
    },
  });

  assert.deepEqual(revokedMethodIds, []);
});

test('deduplicates concurrent TAP creation for the same callback entry', async () => {
  const entry = {};
  let calls = 0;
  let release;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const operation = async () => {
    calls += 1;
    await blocker;
  };

  const first = runTapCreationOnce(entry, operation);
  const second = runTapCreationOnce(entry, operation);
  release();
  await Promise.all([first, second]);

  assert.equal(calls, 1);
});

test('uses timing-safe configured keys for approval and Verified ID callbacks', () => {
  const originalApprovalKey = config.assurance.approvalApiKey;
  const originalCallbackKey = config.verifiedId.callbackApiKey;
  config.assurance.approvalApiKey = 'approval-key-configured-at-runtime';
  config.verifiedId.callbackApiKey = 'callback-key-configured-at-runtime';

  try {
    assert.equal(approvalKeyMatches('approval-key-configured-at-runtime'), true);
    assert.equal(approvalKeyMatches('wrong'), false);
    assert.equal(callbackKeyMatches('callback-key-configured-at-runtime'), true);
    assert.equal(callbackKeyMatches('wrong'), false);
  } finally {
    config.assurance.approvalApiKey = originalApprovalKey;
    config.verifiedId.callbackApiKey = originalCallbackKey;
  }
});

test('matches configurable partner credential claims to the bound Entra user', () => {
  const audit = validatePresentedCredential(
    {
      issuer: 'did:web:partner.example',
      type: ['VerifiableCredential', 'PartnerEmployee'],
      claims: {
        identity: {
          upn: 'NEW.USER@tenant.example',
          employeeId: 'EMP-1001',
        },
      },
      credentialState: { revocationStatus: 'VALID' },
    },
    {
      userPrincipalName: 'new.user@tenant.example',
      employeeIdHash: hashNormalized('emp-1001'),
    },
    {
      credentialType: 'PartnerEmployee',
      acceptedIssuers: ['did:web:partner.example'],
      userPrincipalNameClaim: 'identity.upn',
      employeeIdClaim: 'identity.employeeId',
    }
  );

  assert.equal(audit.issuer, 'did:web:partner.example');
  assert.equal(readClaim({ nested: { value: 'ok' } }, 'nested.value'), 'ok');
});

test('rejects a partner credential that does not match the bound user', () => {
  assert.throws(
    () => validatePresentedCredential(
      {
        issuer: 'did:web:partner.example',
        type: ['VerifiableCredential', 'PartnerEmployee'],
        claims: { upn: 'other.user@tenant.example' },
      },
      { userPrincipalName: 'new.user@tenant.example' },
      {
        credentialType: 'PartnerEmployee',
        acceptedIssuers: ['did:web:partner.example'],
        userPrincipalNameClaim: 'upn',
        employeeIdClaim: '',
      }
    ),
    /does not match/
  );
});

test('uses the official top-level Verified ID presentation request contract', () => {
  const original = { ...config.verifiedId };
  Object.assign(config.verifiedId, {
    verifierAuthority: 'did:web:verifier.example',
    credentialType: 'PartnerEmployee',
    acceptedIssuers: ['did:web:partner.example'],
    userPrincipalNameClaim: 'upn',
    callbackApiKey: 'configured-at-runtime',
  });

  try {
    const payload = verifiedIdService.buildPresentationRequestPayload(
      'https://portal.example/api/verification/callback',
      'callback-state'
    );

    assert.equal(payload.authority, 'did:web:verifier.example');
    assert.equal(payload.includeReceipt, false);
    assert.equal(payload.callback.state, 'callback-state');
    assert.equal(payload.requestedCredentials[0].type, 'PartnerEmployee');
    assert.deepEqual(
      payload.requestedCredentials[0].acceptedIssuers,
      ['did:web:partner.example']
    );
    assert.equal(payload.presentation, undefined);
  } finally {
    Object.assign(config.verifiedId, original);
  }
});
