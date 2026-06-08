'use strict';

const express = require('express');
const { ensureVerified } = require('../middleware/auth');
const fido2Service = require('../services/fido2-service');
const graphService = require('../services/graph-service');
const router = express.Router();

// GET /passkey — render passkey registration page (requires verified identity)
router.get('/', ensureVerified, (req, res) => {
  const state = req.session.onboardingState || {};
  res.render('passkey', {
    title: 'Register Passkeys',
    passkeyPhone: state.passkeyPhone || false,
    passkeyYubikey: state.passkeyYubikey || false,
  });
});

/**
 * POST /api/passkey/register/options
 * Generate WebAuthn registration options.
 * Body: { authenticatorType: 'platform' | 'cross-platform' }
 */
router.post('/register/options', ensureVerified, async (req, res) => {
  const { authenticatorType } = req.body;
  const user = req.session.user;

  if (!authenticatorType || !['platform', 'cross-platform'].includes(authenticatorType)) {
    return res.status(400).json({ error: 'authenticatorType must be platform or cross-platform' });
  }

  try {
    const options = await fido2Service.generateRegistrationOptions(user, authenticatorType);

    // Store the challenge in session for verification
    if (!req.session.challenges) req.session.challenges = {};
    req.session.challenges[authenticatorType] = options.challenge;

    res.json(options);
  } catch (err) {
    console.error('[passkey] Generate options failed:', err.message);
    res.status(500).json({ error: 'Failed to generate registration options.' });
  }
});

/**
 * POST /api/passkey/register/verify
 * Verify and store the WebAuthn registration response.
 * Body: { authenticatorType, registrationResponse }
 */
router.post('/register/verify', ensureVerified, async (req, res) => {
  const { authenticatorType, registrationResponse } = req.body;
  const user = req.session.user;

  if (!authenticatorType || !registrationResponse) {
    return res.status(400).json({ error: 'Missing authenticatorType or registrationResponse' });
  }

  const expectedChallenge = req.session.challenges?.[authenticatorType];
  if (!expectedChallenge) {
    return res.status(400).json({ error: 'No challenge found for this authenticator type. Request options first.' });
  }

  try {
    const verification = await fido2Service.verifyRegistration(
      expectedChallenge,
      registrationResponse
    );

    if (!verification.verified) {
      return res.status(400).json({ error: 'WebAuthn verification failed.' });
    }

    // Attempt to register the key in Entra ID via Graph API
    let graphResult = null;
    try {
      const graphUser = await graphService.getUserByEmail(user.email);
      if (graphUser) {
        graphResult = await graphService.registerFido2Key(
          graphUser.id,
          registrationResponse,
          authenticatorType === 'platform' ? 'Phone Passkey' : 'YubiKey'
        );
      }
    } catch (graphErr) {
      // Graph registration is best-effort in demo mode
      console.warn('[passkey] Graph FIDO2 registration warning:', graphErr.message);
    }

    // Update session state
    if (!req.session.onboardingState) req.session.onboardingState = {};
    if (authenticatorType === 'platform') {
      req.session.onboardingState.passkeyPhone = true;
    } else {
      req.session.onboardingState.passkeyYubikey = true;
    }

    // Clear used challenge
    delete req.session.challenges[authenticatorType];

    res.json({
      verified: true,
      authenticatorType,
      graphRegistered: !!graphResult,
    });
  } catch (err) {
    console.error('[passkey] Verify registration failed:', err.message);
    res.status(500).json({ error: 'Registration verification failed.', details: err.message });
  }
});

// GET /passkey/complete — onboarding complete page
router.get('/complete', (req, res) => {
  const state = req.session.onboardingState || {};
  res.render('complete', {
    title: 'Onboarding Complete',
    user: req.session.user,
    passkeyPhone: state.passkeyPhone || false,
    passkeyYubikey: state.passkeyYubikey || false,
    verifiedClaims: req.session.verifiedClaims || {},
  });
});

module.exports = router;
