'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const graphService = require('../services/graph-service');
const invitationService = require('../services/invitation-service');

const router = express.Router();

function setPrivateResponseHeaders(res) {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
}

function initializeSession(req, invitation) {
  req.session.user = {
    userPrincipalName: invitation.userPrincipalName,
    displayName: invitation.displayName,
  };
  req.session.onboardingState = {
    step: config.assurance.mode === 'verified-id' ? 'verify' : 'tap',
    assuranceMode: config.assurance.mode,
    correlationId: uuidv4(),
    startedAt: new Date().toISOString(),
    entraUserId: invitation.entraUserId,
    employeeIdHash: invitation.employeeIdHash,
    verificationRequestId: null,
    identityAssured: config.assurance.mode === 'invitation',
    vcVerified: false,
    tapCreated: false,
    passkeyRegistered: false,
  };
}

function renderInvitationPage(res, options = {}) {
  return res.status(options.status || 200).render('onboarding', {
    title: options.title || 'Onboarding Invitation Required',
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
  return renderInvitationPage(res);
});

router.get('/demo', async (req, res) => {
  if (!config.demoMode) return res.status(404).end();
  const invitation = await invitationService.createInvitation({
    entraUserId: 'demo-user-id-00000000-0000-0000-0000-000000000001',
    userPrincipalName: 'demo.user@tenant.example',
    displayName: 'Demo User',
    personalEmail: 'demo.user@personal.example',
    employeeId: 'DEMO-001',
  });
  return res.redirect(`/onboarding/invite#token=${encodeURIComponent(invitation.token)}`);
});

router.post('/invite/activate', async (req, res) => {
  setPrivateResponseHeaders(res);
  try {
    const invitation = await invitationService.activateInvitation(req.body.token);
    if (!invitation.active) {
      return res.status(410).json({
        error: 'This invitation is invalid, expired, or already used.',
      });
    }

    await regenerateSession(req);
    req.session.invitationReference = invitation.reference;
    return res.status(204).end();
  } catch (err) {
    console.error('[onboarding] Invitation activation failed:', err.message);
    return res.status(503).json({
      error: 'Invitation validation is temporarily unavailable.',
    });
  }
});

router.get('/invite', async (req, res) => {
  setPrivateResponseHeaders(res);
  const reference = req.session.invitationReference;
  if (!reference) {
    return renderInvitationPage(res, {
      title: 'Validate Onboarding Invitation',
      activateFromFragment: true,
    });
  }
  let invitation;
  try {
    invitation = await invitationService.inspectInvitation(reference);
  } catch (err) {
    console.error('[onboarding] Invitation lookup failed:', err.message);
    return renderInvitationPage(res, {
      status: 503,
      title: 'Invitation Temporarily Unavailable',
      errors: ['Invitation validation is temporarily unavailable.'],
    });
  }
  if (!invitation.active) {
    delete req.session.invitationReference;
    return renderInvitationPage(res, {
      status: 410,
      title: 'Invitation Unavailable',
      errors: ['This invitation is invalid, expired, or already used.'],
    });
  }
  return renderInvitationPage(res, {
    title: 'Validate Onboarding Invitation',
    invitationActive: true,
    expiresAt: invitation.expiresAt,
  });
});

router.post('/invite', async (req, res) => {
  setPrivateResponseHeaders(res);
  const reference = req.session.invitationReference;
  if (!reference) {
    return renderInvitationPage(res, {
      status: 400,
      title: 'Invitation Unavailable',
      errors: ['Open the manager-approved invitation link before entering details.'],
    });
  }

  let invitation;
  try {
    invitation = await invitationService.consumeInvitation(reference, {
      personalEmail: req.body.personalEmail,
      employeeId: req.body.employeeId,
    });
    delete req.session.invitationReference;
  } catch (err) {
    const status = err instanceof invitationService.InvitationError ? 400 : 500;
    const current = await invitationService.inspectInvitation(reference);
    return renderInvitationPage(res, {
      status,
      title: 'Validate Onboarding Invitation',
      invitationActive: current.active,
      errors: [err.message],
    });
  }

  initializeSession(req, invitation);

  try {
    const existingMethods = config.demoMode
      ? []
      : await graphService.listFido2Methods(invitation.entraUserId);
    req.session.onboardingState.existingPasskeyMethodIds =
      existingMethods.map((method) => method.id);
  } catch (err) {
    console.error('[onboarding] Existing passkey lookup failed after invitation consumption:', err.message);
    return res.status(502).render('onboarding', {
      title: 'Invitation Consumed',
      invitationActive: false,
      activateFromFragment: false,
      errors: [
        'The invitation was consumed, but Microsoft Graph could not establish the existing passkey baseline. An approver must issue a new invitation.',
      ],
    });
  }

  if (config.assurance.mode === 'verified-id') {
    return res.redirect('/onboarding/verify');
  }

  try {
    const { tap } = await graphService.createTemporaryAccessPassForPilotUser(
      invitation.entraUserId
    );
    req.session.onboardingState.tapCreated = true;
    return res.render('tap', {
      title: 'Temporary Access Pass',
      temporaryAccessPass: tap.temporaryAccessPass,
      lifetimeInMinutes: tap.lifetimeInMinutes || config.graph.tapLifetimeMinutes,
      securityInfoUrl: config.graph.securityInfoUrl,
    });
  } catch (err) {
    console.error('[onboarding] TAP creation failed after invitation consumption:', err.message);
    return res.status(502).render('onboarding', {
      title: 'Invitation Consumed',
      invitationActive: false,
      activateFromFragment: false,
      errors: [
        err instanceof graphService.PilotEligibilityError
          ? 'The invitation-bound account is no longer enabled or in the configured pilot group. No Temporary Access Pass was created.'
          : 'The invitation was consumed, but Microsoft Graph could not create the Temporary Access Pass. An approver must issue a new invitation.',
      ],
    });
  }
});

router.get('/verify', (req, res) => {
  setPrivateResponseHeaders(res);
  if (config.assurance.mode !== 'verified-id') {
    return res.redirect('/onboarding');
  }
  if (!req.session.onboardingState || !req.session.user) {
    return res.redirect('/onboarding');
  }
  return res.render('verification', {
    title: 'Present Partner Verified ID',
    user: req.session.user,
  });
});

router.get('/status', (req, res) => res.redirect('/onboarding'));
router.get('/approved', (req, res) => res.redirect('/onboarding'));

module.exports = router;
module.exports.initializeSession = initializeSession;
module.exports.regenerateSession = regenerateSession;
