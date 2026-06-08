'use strict';

const express = require('express');
const verifiedIdService = require('../services/verified-id-service');
const config = require('../config');
const router = express.Router();

// In-memory callback store — keyed by requestId
const callbackStore = new Map();

/**
 * POST /api/verification/request
 * Creates a Verified ID presentation request and returns QR code data.
 */
router.post('/request', async (req, res) => {
  const state = req.session.onboardingState;
  const user = req.session.user;

  if (!state || !user) {
    return res.status(401).json({ error: 'Session expired. Please restart onboarding.' });
  }

  try {
    const callbackUrl = `${config.appBaseUrl}/api/verification/callback`;
    const result = await verifiedIdService.createPresentationRequest(callbackUrl);

    req.session.onboardingState.verificationRequestId = result.requestId;
    req.session.onboardingState.step = 'verifying';
    callbackStore.set(result.requestId, { status: 'request_created', requestId: result.requestId });

    res.json({
      requestId: result.requestId,
      url: result.url,
      expiry: result.expiry,
      qrCode: result.qrCode,
    });
  } catch (err) {
    console.error('[verification] Create request failed:', err.message);
    res.status(500).json({ error: 'Failed to create verification request.', details: err.message });
  }
});

/**
 * GET /api/verification/status/:requestId
 * Polled by the browser to check verification status.
 */
router.get('/status/:requestId', (req, res) => {
  const { requestId } = req.params;
  const entry = callbackStore.get(requestId);
  if (!entry) {
    return res.json({ status: 'pending' });
  }

  // On success, advance session state and store verified claims
  if (entry.status === 'presentation_verified' && req.session.onboardingState) {
    req.session.onboardingState.step = 'passkey';
    req.session.onboardingState.vcVerified = true;
    if (entry.claims) {
      req.session.verifiedClaims = entry.claims;
    }
  }

  res.json({ status: entry.status, message: entry.message, claims: entry.claims });
});

/**
 * POST /api/verification/callback
 * Receives status updates from the Verified ID Request Service.
 * Payload follows the Microsoft VC Service presentation callback format.
 * https://learn.microsoft.com/en-us/entra/verified-id/presentation-request-api#callback-type
 */
router.post('/callback', (req, res) => {
  const payload = req.body;
  console.log('[verification] Callback received:', JSON.stringify(payload, null, 2));

  const requestId = payload.requestId;
  if (!requestId) {
    return res.status(400).json({ error: 'Missing requestId in callback' });
  }

  const entry = callbackStore.get(requestId) || { requestId };

  switch (payload.code) {
    case 'request_retrieved':
      entry.status = 'request_retrieved';
      entry.message = 'QR code scanned — waiting for presentation.';
      break;

    case 'presentation_verified': {
      entry.status = 'presentation_verified';
      entry.message = 'Identity verified successfully.';
      // Extract claims from the verified credential
      const vcClaims = payload.verifiedCredentialsData?.[0]?.claims || {};
      // Ensure the credential type matches
      const credentialTypes = payload.verifiedCredentialsData?.[0]?.type || [];
      if (!credentialTypes.includes(config.verifiedId.credentialType)) {
        console.warn('[verification] Unexpected credential type:', credentialTypes);
      }
      entry.claims = vcClaims;
      break;
    }

    case 'presentation_error':
      entry.status = 'presentation_error';
      entry.message = payload.error?.message || 'Verification failed.';
      break;

    default:
      entry.status = payload.code;
      entry.message = payload.message || '';
  }

  callbackStore.set(requestId, entry);
  res.status(200).json({ result: 'accepted' });
});

module.exports = router;
