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

router.get('/', (req, res) => {
  setPrivateResponseHeaders(res);
  return res.render('onboarding', {
    title: 'Onboarding Invitation Required',
    token: null,
    invitationActive: false,
    errors: null,
  });
});

router.get('/demo', (req, res) => {
  if (!config.demoMode) return res.status(404).end();
  const invitation = invitationService.createInvitation({
    entraUserId: 'demo-user-id-00000000-0000-0000-0000-000000000001',
    userPrincipalName: 'demo.user@tenant.example',
    displayName: 'Demo User',
    personalEmail: 'demo.user@personal.example',
    employeeId: 'DEMO-001',
  });
  return res.redirect(`/onboarding/invite/${invitation.token}`);
});

router.get('/invite/:token', (req, res) => {
  setPrivateResponseHeaders(res);
  const invitation = invitationService.inspectInvitation(req.params.token);
  return res.status(invitation.active ? 200 : 410).render('onboarding', {
    title: invitation.active ? 'Validate Onboarding Invitation' : 'Invitation Unavailable',
    token: req.params.token,
    invitationActive: invitation.active,
    expiresAt: invitation.expiresAt,
    errors: invitation.active ? null : ['This invitation is invalid, expired, or already used.'],
  });
});

router.post('/invite/:token', async (req, res) => {
  setPrivateResponseHeaders(res);

  let invitation;
  try {
    invitation = invitationService.consumeInvitation(req.params.token, {
      personalEmail: req.body.personalEmail,
      employeeId: req.body.employeeId,
    });
  } catch (err) {
    const status = err instanceof invitationService.InvitationError ? 400 : 500;
    return res.status(status).render('onboarding', {
      title: 'Validate Onboarding Invitation',
      token: req.params.token,
      invitationActive: true,
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
      token: null,
      invitationActive: false,
      errors: [
        'The invitation was consumed, but Microsoft Graph could not establish the existing passkey baseline. An approver must issue a new invitation.',
      ],
    });
  }

  if (config.assurance.mode === 'verified-id') {
    return res.redirect('/onboarding/verify');
  }

  try {
    const tap = await graphService.createTemporaryAccessPass(invitation.entraUserId);
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
      token: null,
      invitationActive: false,
      errors: [
        'The invitation was consumed, but Microsoft Graph could not create the Temporary Access Pass. An approver must issue a new invitation.',
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
