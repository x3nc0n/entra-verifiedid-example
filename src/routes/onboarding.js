'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const identityPassService = require('../services/identitypass-service');
const router = express.Router();

// GET /onboarding — render the onboarding form
router.get('/', (req, res) => {
  res.render('onboarding', {
    title: 'Start Onboarding',
    errors: null,
    formData: {},
  });
});

// POST /onboarding/start — validate inputs and initiate IdentityPass request
router.post('/start', async (req, res) => {
  const { email, employeeId, managerEmail } = req.body;
  const errors = [];

  // ── Input validation ───────────────────────────────────────────────────────
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push('A valid personal email address is required.');
  }
  if (!employeeId || employeeId.trim().length < 3) {
    errors.push('Employee ID must be at least 3 characters.');
  }
  if (managerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(managerEmail)) {
    errors.push('If provided, manager email must be valid.');
  }

  if (errors.length > 0) {
    return res.render('onboarding', {
      title: 'Start Onboarding',
      errors,
      formData: { email, employeeId, managerEmail },
    });
  }

  try {
    const result = await identityPassService.initiateIdentityPass(
      employeeId.trim(),
      email.trim().toLowerCase(),
      managerEmail || identityPassService.defaultManagerEmail
    );

    // Store onboarding state in session
    req.session.user = {
      email: email.trim().toLowerCase(),
      employeeId: employeeId.trim(),
    };
    req.session.onboardingState = {
      step: 'pending-approval',
      identityPassRequestId: result.requestId,
      correlationId: uuidv4(),
      startedAt: new Date().toISOString(),
      issuanceRequestId: null,
      verificationRequestId: null,
      vcVerified: false,
      passkeyPhone: false,
      passkeyYubikey: false,
    };

    res.redirect('/onboarding/status');
  } catch (err) {
    console.error('[onboarding] IdentityPass initiation failed:', err.message);
    res.render('onboarding', {
      title: 'Start Onboarding',
      errors: ['Failed to initiate identity verification. Please try again.'],
      formData: { email, employeeId, managerEmail },
    });
  }
});

// GET /onboarding/status — waiting for manager approval page
router.get('/status', (req, res) => {
  if (!req.session.onboardingState) {
    return res.redirect('/onboarding');
  }
  res.render('status', {
    title: 'Awaiting Manager Approval',
    requestId: req.session.onboardingState.identityPassRequestId,
  });
});

// GET /onboarding/approval-status — polled by the status page (JSON)
router.get('/approval-status', async (req, res) => {
  const state = req.session.onboardingState;
  if (!state || !state.identityPassRequestId) {
    return res.json({ status: 'unknown' });
  }

  try {
    const result = await identityPassService.checkApprovalStatus(
      state.identityPassRequestId
    );
    if (result.approved) {
      req.session.onboardingState.step = 'approved';
    }
    res.json({
      status: result.status,
      approved: result.approved,
      simulatedApproval: !!result.simulated,
      message: config.demoMode
        ? (result.approved
          ? 'Demo Mode: approval was simulated automatically for this walkthrough.'
          : 'Demo Mode: approval will be simulated automatically after a short delay.')
        : undefined,
    });
  } catch (err) {
    console.error('[onboarding] Approval status check failed:', err.message);
    res.json({ status: 'error', message: err.message });
  }
});

// GET /onboarding/approved — show credential issuance page after manager approval
router.get('/approved', (req, res) => {
  if (!req.session.onboardingState) {
    return res.redirect('/onboarding');
  }
  if (req.session.onboardingState.step === 'pending-approval') {
    return res.redirect('/onboarding/status');
  }
  res.render('issuance', {
    title: 'Get Your Verified ID Credential',
    user: req.session.user,
  });
});

module.exports = router;
