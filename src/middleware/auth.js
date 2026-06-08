'use strict';

/**
 * Middleware: ensures the user has completed the onboarding form.
 * Redirects to /onboarding if not started.
 */
function ensureOnboarded(req, res, next) {
  if (!req.session.user || !req.session.onboardingState) {
    return res.redirect('/onboarding');
  }
  next();
}

/**
 * Middleware: ensures the user has successfully presented their Verified ID.
 * Redirects to the verification page if not yet verified.
 */
function ensureVerified(req, res, next) {
  const state = req.session.onboardingState;
  if (!state || !state.vcVerified) {
    return res.redirect('/onboarding/approved');
  }
  next();
}

/**
 * Returns the current onboarding step name for progress display.
 * @param {object} state - req.session.onboardingState
 * @returns {string}
 */
function getCurrentStep(state) {
  if (!state) return 'start';
  const { step } = state;
  const map = {
    'pending-approval': 'approval',
    approved: 'issuance',
    issuing: 'issuance',
    verify: 'verification',
    verifying: 'verification',
    passkey: 'passkey',
    complete: 'complete',
  };
  return map[step] || 'start';
}

/**
 * Marks the onboarding as complete in the session.
 * @param {object} req - Express request
 */
function markComplete(req) {
  if (req.session.onboardingState) {
    req.session.onboardingState.step = 'complete';
    req.session.onboardingState.completedAt = new Date().toISOString();
  }
}

module.exports = {
  ensureOnboarded,
  ensureVerified,
  getCurrentStep,
  markComplete,
};
