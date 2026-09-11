'use strict';

const express = require('express');
const config = require('../config');
const graphService = require('../services/graph-service');
const onboardingService = require('../services/onboarding-v2-service');
const { timingSafeTextEqual } = require('../services/v2-crypto-service');
const {
  destroySession,
  getCsrfToken,
  requireCsrf,
} = require('../middleware/v2-security');

const router = express.Router();

async function loadBoundRequest(req) {
  const binding = req.session.v2Employee;
  if (!binding?.requestId || !binding.employeeObjectId) {
    throw new onboardingService.V2StateError(
      'No active employee onboarding session.',
      'employee_session_required',
      401
    );
  }
  const request = await onboardingService.loadRequest(binding.requestId);
  if (!timingSafeTextEqual(
    request.employeeObjectId.toLowerCase(),
    binding.employeeObjectId.toLowerCase()
  )) {
    throw new onboardingService.V2StateError(
      'Employee session binding does not match.',
      'employee_session_mismatch',
      403
    );
  }
  return request;
}

router.get('/v2/passkey', async (req, res) => {
  try {
    const request = await loadBoundRequest(req);
    if (request.state !== 'tap-issued') {
      return res.redirect('/v2/onboarding');
    }
    const tap = await onboardingService.takeTapForDisplay(request.requestId);
    return res.render('v2-passkey', {
      title: 'Register Your Tenant Passkey',
      csrfToken: getCsrfToken(req, 'employee'),
      temporaryAccessPass: tap.tap,
      lifetimeInMinutes: tap.lifetimeInMinutes,
      securityInfoUrl: config.graph.securityInfoUrl,
    });
  } catch (err) {
    return res.status(err.status || 410).render('v2-passkey', {
      title: 'Temporary Access Pass Unavailable',
      csrfToken: getCsrfToken(req, 'employee'),
      temporaryAccessPass: null,
      lifetimeInMinutes: null,
      securityInfoUrl: config.graph.securityInfoUrl,
      error: err.code === 'tap_already_displayed'
        ? 'The Temporary Access Pass was already displayed. If it was lost, start a new manager-approved onboarding request.'
        : 'The Temporary Access Pass is not available.',
    });
  }
});

router.post(
  '/api/v2/passkey/confirm',
  requireCsrf('employee'),
  async (req, res) => {
    try {
      const request = await loadBoundRequest(req);
      if (request.state !== 'tap-issued') {
        throw new onboardingService.V2StateError(
          'Passkey confirmation is not available in this state.',
          'invalid_state'
        );
      }
      const limit = await onboardingService.enforceRateLimit(
        'passkey-confirm',
        request.requestId,
        config.selfServiceV2.maxPasskeyConfirmAttempts,
        Date.now(),
        10 * 60 * 1000
      );
      if (!limit.allowed) {
        return res.status(429).json({
          error: 'Passkey confirmation is temporarily rate-limited.',
        });
      }
      const methods = await graphService.listFido2Methods(
        request.employeeObjectId
      );
      const updated = await onboardingService.confirmPasskey(
        request.requestId,
        methods
      );
      return res.json({
        registered: true,
        methodId: updated.passkeyMethodId,
      });
    } catch (err) {
      return res.status(err.status || 502).json({
        error: err.code === 'passkey_not_found'
          ? 'No new tenant passkey was found yet.'
          : 'Tenant passkey confirmation failed.',
      });
    }
  }
);

router.get('/v2/complete', async (req, res) => {
  try {
    const request = await loadBoundRequest(req);
    const completed = request.state === 'complete'
      ? request
      : await onboardingService.complete(request.requestId);
    const viewModel = {
      title: 'Onboarding Complete',
      employeeDisplayName: completed.employeeDisplayName,
      completedAt: completed.completedAt,
    };
    await destroySession(req);
    return res.render('v2-complete', viewModel);
  } catch (err) {
    return res.redirect('/v2/onboarding');
  }
});

module.exports = router;
module.exports.loadBoundRequest = loadBoundRequest;
