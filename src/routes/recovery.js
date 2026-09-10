'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const graphService = require('../services/graph-service');
const recoveryService = require('../services/recovery-service');

const router = express.Router();

function setPrivateResponseHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}

function initializeSession(req, recovery) {
  req.session.user = {
    userPrincipalName: recovery.userPrincipalName,
    displayName: recovery.displayName,
  };
  req.session.onboardingState = {
    step: 'tap',
    assuranceMode: 'invitation',
    recoveryMode: true,
    correlationId: uuidv4(),
    startedAt: new Date().toISOString(),
    entraUserId: recovery.entraUserId,
    employeeIdHash: recovery.employeeIdHash,
    verificationRequestId: null,
    identityAssured: true,
    vcVerified: false,
    tapCreated: false,
    passkeyRegistered: false,
  };
}

function renderRecoveryPage(res, options = {}) {
  return res.status(options.status || 200).render('recovery', {
    title: options.title || 'Account Recovery Required',
    invitationActive: options.invitationActive || false,
    activateFromFragment: options.activateFromFragment || false,
    expiresAt: options.expiresAt,
    errors: options.errors || null,
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => err ? reject(err) : resolve());
  });
}

router.get('/', (req, res) => {
  setPrivateResponseHeaders(res);
  return renderRecoveryPage(res);
});

router.get('/demo', async (req, res) => {
  if (!config.demoMode) return res.status(404).end();
  const recovery = await recoveryService.createInvitation({
    entraUserId: 'demo-user-id-00000000-0000-0000-0000-000000000001',
    userPrincipalName: 'demo.user@tenant.example',
    displayName: 'Demo User',
    personalEmail: 'demo.user@personal.example',
    employeeId: 'DEMO-001',
  });
  return res.redirect(`/recovery/invite#token=${encodeURIComponent(recovery.token)}`);
});

router.post('/invite/activate', async (req, res) => {
  setPrivateResponseHeaders(res);
  try {
    const recovery = await recoveryService.activateInvitation(req.body.token);
    if (!recovery.active) {
      return res.status(410).json({
        error: 'This recovery request is invalid, expired, or already used.',
      });
    }

    await regenerateSession(req);
    req.session.invitationReference = recovery.reference;
    return res.status(204).end();
  } catch (err) {
    console.error('[recovery] Recovery request activation failed:', err.message);
    return res.status(503).json({
      error: 'Recovery request validation is temporarily unavailable.',
    });
  }
});

router.get('/invite', async (req, res) => {
  setPrivateResponseHeaders(res);
  const reference = req.session.invitationReference;
  if (!reference) {
    return renderRecoveryPage(res, {
      title: 'Validate Recovery Request',
      activateFromFragment: true,
    });
  }
  let recovery;
  try {
    recovery = await recoveryService.inspectInvitation(reference);
  } catch (err) {
    console.error('[recovery] Recovery request lookup failed:', err.message);
    return renderRecoveryPage(res, {
      status: 503,
      title: 'Recovery Request Temporarily Unavailable',
      errors: ['Recovery request validation is temporarily unavailable.'],
    });
  }
  if (!recovery.active) {
    delete req.session.invitationReference;
    return renderRecoveryPage(res, {
      status: 410,
      title: 'Recovery Request Unavailable',
      errors: ['This recovery request is invalid, expired, or already used.'],
    });
  }
  return renderRecoveryPage(res, {
    title: 'Validate Recovery Request',
    invitationActive: true,
    expiresAt: recovery.expiresAt,
  });
});

router.post('/invite', async (req, res) => {
  setPrivateResponseHeaders(res);
  const reference = req.session.invitationReference;
  if (!reference) {
    return renderRecoveryPage(res, {
      status: 400,
      title: 'Recovery Request Unavailable',
      errors: ['Open the manager-approved recovery link before entering details.'],
    });
  }

  let recovery;
  try {
    recovery = await recoveryService.consumeInvitation(reference, {
      personalEmail: req.body.personalEmail,
      employeeId: req.body.employeeId,
    });
    delete req.session.invitationReference;
  } catch (err) {
    const status = err instanceof recoveryService.RecoveryError ? 400 : 500;
    const current = await recoveryService.inspectInvitation(reference);
    return renderRecoveryPage(res, {
      status,
      title: 'Validate Recovery Request',
      invitationActive: current.active,
      errors: [err.message],
    });
  }

  initializeSession(req, recovery);

  // The account is recovering from losing every authenticator, so every
  // existing tenant passkey is revoked before a replacement is ever issued.
  // This runs after the recovery request's own evidence match (personal
  // email + employee ID) succeeds, so revocation only happens for a
  // manager-approved, matched request.
  let revokedMethodIds;
  try {
    revokedMethodIds = config.demoMode
      ? []
      : await graphService.revokeAllFido2Methods(recovery.entraUserId);
    req.session.onboardingState.existingPasskeyMethodIds = [];
    req.session.onboardingState.revokedPasskeyMethodIds = revokedMethodIds;
  } catch (err) {
    console.error('[recovery] Revoking existing passkeys failed after recovery request consumption:', err.message);
    return res.status(502).render('recovery', {
      title: 'Recovery Request Consumed',
      invitationActive: false,
      activateFromFragment: false,
      errors: [
        'The recovery request was validated, but Microsoft Graph could not revoke the existing tenant passkeys. An approver must issue a new recovery request.',
      ],
    });
  }

  try {
    const { tap } = await graphService.createTemporaryAccessPassForPilotUser(
      recovery.entraUserId
    );
    req.session.onboardingState.tapCreated = true;
    return res.render('tap', {
      title: 'Temporary Access Pass',
      recoveryMode: true,
      temporaryAccessPass: tap.temporaryAccessPass,
      lifetimeInMinutes: tap.lifetimeInMinutes || config.graph.tapLifetimeMinutes,
      securityInfoUrl: config.graph.securityInfoUrl,
    });
  } catch (err) {
    console.error('[recovery] TAP creation failed after revoking existing passkeys:', err.message);
    return res.status(502).render('recovery', {
      title: 'Recovery Request Consumed',
      invitationActive: false,
      activateFromFragment: false,
      errors: [
        err instanceof graphService.PilotEligibilityError
          ? 'The recovery-bound account is no longer enabled or in the configured pilot group. No Temporary Access Pass was created.'
          : 'The existing tenant passkeys were revoked, but Microsoft Graph could not create the Temporary Access Pass. An approver must issue a new recovery request.',
      ],
    });
  }
});

router.get('/status', (req, res) => res.redirect('/recovery'));

module.exports = router;
module.exports.initializeSession = initializeSession;
module.exports.regenerateSession = regenerateSession;
