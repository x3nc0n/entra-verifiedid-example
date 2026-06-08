'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const verifiedIdService = require('../services/verified-id-service');
const config = require('../config');
const router = express.Router();

// In-memory callback store — keyed by requestId.
// In production use Redis or a database.
const callbackStore = new Map();

/**
 * POST /api/issuance/request
 * Creates a Verified ID issuance request and returns QR code data.
 */
router.post('/request', async (req, res) => {
  const state = req.session.onboardingState;
  const user = req.session.user;

  if (!state || !user) {
    return res.status(401).json({ error: 'Session expired. Please restart onboarding.' });
  }

  try {
    const callbackUrl = `${config.appBaseUrl}/api/issuance/callback`;
    const claims = {
      employeeId: user.employeeId,
      email: user.email,
      onboardingDate: new Date().toISOString().split('T')[0],
    };

    const result = await verifiedIdService.createIssuanceRequest(claims, callbackUrl);

    // Track the request in session
    req.session.onboardingState.issuanceRequestId = result.requestId;
    req.session.onboardingState.step = 'issuing';
    callbackStore.set(result.requestId, { status: 'request_created', requestId: result.requestId });

    res.json({
      requestId: result.requestId,
      url: result.url,
      expiry: result.expiry,
      qrCode: result.qrCode,
    });
  } catch (err) {
    console.error('[issuance] Create request failed:', err.message);
    res.status(500).json({ error: 'Failed to create issuance request.', details: err.message });
  }
});

/**
 * GET /api/issuance/status/:requestId
 * Polled by the browser to check issuance status.
 */
router.get('/status/:requestId', (req, res) => {
  const { requestId } = req.params;
  const entry = callbackStore.get(requestId);
  if (!entry) {
    return res.json({ status: 'pending' });
  }

  // If issued, advance session state
  if (entry.status === 'issuance_successful' && req.session.onboardingState) {
    req.session.onboardingState.step = 'verify';
  }

  res.json({ status: entry.status, message: entry.message });
});

/**
 * POST /api/issuance/callback
 * Receives status updates from the Verified ID Request Service.
 * Payload follows the Microsoft VC Service callback format.
 * https://learn.microsoft.com/en-us/entra/verified-id/issuance-request-api#callback-type
 */
router.post('/callback', (req, res) => {
  const payload = req.body;
  console.log('[issuance] Callback received:', JSON.stringify(payload, null, 2));

  const requestId = payload.requestId;
  if (!requestId) {
    return res.status(400).json({ error: 'Missing requestId in callback' });
  }

  const entry = callbackStore.get(requestId) || { requestId };

  switch (payload.code) {
    case 'request_retrieved':
      entry.status = 'request_retrieved';
      entry.message = 'QR code scanned — waiting for issuance.';
      break;
    case 'issuance_successful':
      entry.status = 'issuance_successful';
      entry.message = 'Credential issued successfully.';
      break;
    case 'issuance_error':
      entry.status = 'issuance_error';
      entry.message = payload.error?.message || 'Issuance failed.';
      break;
    default:
      entry.status = payload.code;
      entry.message = payload.message || '';
  }

  callbackStore.set(requestId, entry);
  res.status(200).json({ result: 'accepted' });
});

module.exports = router;
