'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const graphService = require('../services/graph-service');
const invitationService = require('../services/invitation-service');

const router = express.Router();

function approvalKeyMatches(received) {
  const expected = config.assurance.approvalApiKey;
  if (!received || !expected) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

router.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!config.assurance.approvalApiKey) {
    return res.status(503).json({ error: 'Invitation approval integration is not configured.' });
  }
  if (!approvalKeyMatches(req.get('x-onboarding-approval-key'))) {
    return res.status(401).json({ error: 'Invalid invitation approval authentication.' });
  }

  const { entraUserId, personalEmail, employeeId, lifetimeMinutes } = req.body;
  if (!entraUserId || !personalEmail || !employeeId) {
    return res.status(400).json({
      error: 'entraUserId, personalEmail, and employeeId are required.',
    });
  }

  try {
    const user = await graphService.getEligiblePilotUser(entraUserId);

    const invitation = await invitationService.createInvitation({
      entraUserId: user.id,
      userPrincipalName: user.userPrincipalName,
      displayName: user.displayName,
      personalEmail,
      employeeId,
      lifetimeMinutes: lifetimeMinutes === undefined
        ? undefined
        : Number.parseInt(lifetimeMinutes, 10),
    });

    return res.status(201).json({
      invitationUrl: `${config.appBaseUrl}/onboarding/invite#token=${encodeURIComponent(invitation.token)}`,
      expiresAt: invitation.expiresAt,
      user: {
        id: invitation.entraUserId,
        userPrincipalName: invitation.userPrincipalName,
      },
      deliveryRequired: true,
    });
  } catch (err) {
    const status = err instanceof invitationService.InvitationError
      ? 400
      : err instanceof graphService.PilotEligibilityError
        ? 409
        : 502;
    console.error('[invitations] Invitation creation failed:', err.message);
    return res.status(status).json({
      error: err instanceof graphService.PilotEligibilityError
        ? 'The selected Entra user is not currently eligible for the pilot.'
        : 'Failed to create onboarding invitation.',
    });
  }
});

module.exports = router;
module.exports.approvalKeyMatches = approvalKeyMatches;
