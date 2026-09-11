'use strict';

function ensureOnboarded(req, res, next) {
  if (!req.session.user || !req.session.onboardingState) {
    return res.redirect('/onboarding');
  }
  next();
}

function ensureVerified(req, res, next) {
  const state = req.session.onboardingState;
  if (!state || !state.vcVerified) {
    return res.redirect(state?.recoveryMode ? '/recovery/verify' : '/onboarding/verify');
  }
  next();
}

function ensureTapCreated(req, res, next) {
  const state = req.session.onboardingState;
  if (!state || !state.identityAssured || !state.tapCreated) {
    return res.redirect(state?.recoveryMode ? '/recovery' : '/onboarding');
  }
  next();
}

function getCurrentStep(state) {
  if (!state) return 'start';
  const map = {
    verify: 'verification',
    verifying: 'verification',
    tap: 'tap',
    passkey: 'passkey',
    complete: 'complete',
  };
  return map[state.step] || 'start';
}

function markComplete(req) {
  if (req.session.onboardingState) {
    req.session.onboardingState.step = 'complete';
    req.session.onboardingState.completedAt = new Date().toISOString();
  }
}

module.exports = {
  ensureOnboarded,
  ensureVerified,
  ensureTapCreated,
  getCurrentStep,
  markComplete,
};
