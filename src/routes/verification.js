'use strict';

const crypto = require('crypto');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const graphService = require('../services/graph-service');
const verifiedIdService = require('../services/verified-id-service');
const { validatePresentedCredential } = require('../services/verified-subject-service');

const router = express.Router();
const callbackStore = new Map();

function callbackKeyMatches(received) {
  const expected = config.verifiedId.callbackApiKey;
  if (!received || !expected) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

function getValidationSettings() {
  return {
    credentialType: config.verifiedId.credentialType || 'DemoPartnerCredential',
    acceptedIssuers: config.verifiedId.acceptedIssuers.length > 0
      ? config.verifiedId.acceptedIssuers
      : ['did:web:identity-partner.example'],
    userPrincipalNameClaim: config.verifiedId.userPrincipalNameClaim || 'userPrincipalName',
    employeeIdClaim: config.verifiedId.employeeIdClaim || 'employeeId',
  };
}

function buildDemoCredential(entry) {
  const settings = getValidationSettings();
  return {
    issuer: settings.acceptedIssuers[0],
    type: ['VerifiableCredential', settings.credentialType],
    subject: 'did:example:demo-subject',
    claims: {
      [settings.userPrincipalNameClaim]: entry.expectedUser.userPrincipalName,
      [settings.employeeIdClaim]: 'DEMO-001',
    },
    credentialState: { revocationStatus: 'VALID' },
    issuanceDate: new Date().toISOString(),
    expirationDate: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

function runTapCreationOnce(entry, operation) {
  if (entry.tapCreationPromise) return entry.tapCreationPromise;
  entry.status = 'tap_creating';
  entry.tapCreationPromise = Promise.resolve()
    .then(operation)
    .finally(() => {
      delete entry.tapCreationPromise;
    });
  return entry.tapCreationPromise;
}

async function completePresentation(entry, credential) {
  return runTapCreationOnce(entry, async () => {
    const auditResult = validatePresentedCredential(
      credential,
      entry.expectedUser,
      getValidationSettings()
    );
    const tap = await graphService.createTemporaryAccessPass(entry.expectedUser.id);

    entry.status = 'tap_created';
    entry.message = 'Identity matched and a one-time Temporary Access Pass was created.';
    entry.auditResult = auditResult;
    entry.temporaryAccessPass = tap.temporaryAccessPass;
    entry.tapMethodId = tap.id;
    entry.tapCreatedAt = tap.createdDateTime || new Date().toISOString();
    entry.tapLifetimeMinutes = tap.lifetimeInMinutes || config.graph.tapLifetimeMinutes;
  });
}

router.post('/request', async (req, res) => {
  const state = req.session.onboardingState;
  const user = req.session.user;
  if (!state || !user || !state.entraUserId) {
    return res.status(401).json({ error: 'Session expired. Please restart onboarding.' });
  }

  try {
    const callbackState = uuidv4();
    const callbackUrl = `${config.appBaseUrl}/api/verification/callback`;
    const result = await verifiedIdService.createPresentationRequest(
      callbackUrl,
      callbackState
    );

    state.verificationRequestId = result.requestId;
    state.step = 'verifying';
    callbackStore.set(result.requestId, {
      status: 'request_created',
      requestId: result.requestId,
      callbackState,
      expectedUser: {
        id: state.entraUserId,
        userPrincipalName: user.userPrincipalName,
        employeeIdHash: state.employeeIdHash,
      },
      autoCompleteAt: config.demoMode ? Date.now() + 1500 : null,
    });

    return res.json({
      requestId: result.requestId,
      url: result.url,
      expiry: result.expiry,
      qrCode: result.qrCode,
    });
  } catch (err) {
    console.error('[verification] Create request failed:', err.message);
    return res.status(500).json({ error: 'Failed to create verification request.' });
  }
});

router.get('/status/:requestId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  const state = req.session.onboardingState;
  if (!state || state.verificationRequestId !== req.params.requestId) {
    return res.status(404).json({ error: 'Verification request not found for this session.' });
  }

  const entry = callbackStore.get(req.params.requestId);
  if (!entry) return res.json({ status: 'pending' });

  try {
    if (config.demoMode &&
        entry.status === 'request_created' &&
        Date.now() >= entry.autoCompleteAt) {
      await completePresentation(entry, buildDemoCredential(entry));
    }

    if (entry.status === 'tap_created') {
      const temporaryAccessPass = entry.temporaryAccessPass;
      delete entry.temporaryAccessPass;
      entry.status = 'tap_delivered';
      entry.tapDeliveredAt = new Date().toISOString();

      state.step = 'tap';
      state.identityAssured = true;
      state.vcVerified = true;
      state.tapCreated = true;
      state.verifiedSubject = entry.auditResult;

      return res.json({
        status: 'tap_created',
        message: entry.message,
        temporaryAccessPass,
        lifetimeInMinutes: entry.tapLifetimeMinutes,
        signInUrl: config.graph.securityInfoUrl,
      });
    }

    if (entry.status === 'tap_delivered') {
      return res.json({
        status: 'tap_delivered',
        message: 'The Temporary Access Pass was already displayed and cannot be retrieved again.',
        signInUrl: config.graph.securityInfoUrl,
      });
    }

    return res.json({ status: entry.status, message: entry.message });
  } catch (err) {
    entry.status = 'tap_error';
    entry.message = err.message;
    console.error('[verification] Demo completion failed:', err.message);
    return res.status(500).json({ status: entry.status, message: entry.message });
  }
});

router.post('/callback', async (req, res) => {
  if (!config.verifiedId.callbackApiKey) {
    return res.status(503).json({ error: 'Verified ID callback authentication is not configured.' });
  }
  if (!callbackKeyMatches(req.get('api-key'))) {
    return res.status(401).json({ error: 'Invalid Verified ID callback authentication.' });
  }

  const payload = req.body || {};
  const requestId = payload.requestId;
  const requestStatus = payload.requestStatus || payload.code;
  const entry = callbackStore.get(requestId);

  if (!requestId || !entry) {
    return res.status(400).json({ error: 'Unknown verification request.' });
  }
  if (!payload.state || payload.state !== entry.callbackState) {
    return res.status(401).json({ error: 'Invalid Verified ID callback state.' });
  }

  try {
    if (requestStatus === 'request_retrieved') {
      entry.status = 'request_retrieved';
      entry.message = 'Credential request retrieved; waiting for presentation.';
    } else if (requestStatus === 'presentation_verified') {
      if (!['tap_creating', 'tap_created', 'tap_delivered'].includes(entry.status)) {
        const credentials = payload.verifiedCredentialsData || [];
        const requestedType = getValidationSettings().credentialType;
        const credential = credentials.find((item) =>
          Array.isArray(item.type) && item.type.includes(requestedType)
        );
        await completePresentation(entry, credential);
      }
    } else if (requestStatus === 'presentation_error') {
      entry.status = 'presentation_error';
      entry.message = payload.error?.message || 'Verified ID presentation failed.';
    } else {
      return res.status(400).json({ error: 'Unsupported Verified ID callback status.' });
    }

    return res.status(200).json({ result: 'accepted' });
  } catch (err) {
    entry.status = 'presentation_error';
    entry.message = err.message;
    console.error('[verification] Presentation processing failed:', err.message);
    return res.status(200).json({ result: 'rejected' });
  }
});

module.exports = router;
module.exports.callbackKeyMatches = callbackKeyMatches;
module.exports.runTapCreationOnce = runTapCreationOnce;
