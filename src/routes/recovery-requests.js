'use strict';

const express = require('express');
const config = require('../config');
const graphService = require('../services/graph-service');
const recoveryService = require('../services/recovery-service');
const { approvalKeyMatches } = require('./invitations');

const router = express.Router();

router.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!config.assurance.approvalApiKey) {
    return res.status(503).json({ error: 'Recovery approval integration is not configured.' });
  }
  if (!approvalKeyMatches(req.get('x-onboarding-approval-key'))) {
    return res.status(401).json({ error: 'Invalid recovery approval authentication.' });
  }

  const { entraUserId, personalEmail, employeeId, lifetimeMinutes } = req.body;
  if (!entraUserId || !personalEmail || !employeeId) {
    return res.status(400).json({
      error: 'entraUserId, personalEmail, and employeeId are required.',
    });
  }

  try {
    const user = await graphService.getEligiblePilotUser(entraUserId);

    const recoveryRequest = await recoveryService.createInvitation({
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
      recoveryUrl: `${config.appBaseUrl}/recovery/invite#token=${encodeURIComponent(recoveryRequest.token)}`,
      expiresAt: recoveryRequest.expiresAt,
      user: {
        id: recoveryRequest.entraUserId,
        userPrincipalName: recoveryRequest.userPrincipalName,
      },
      deliveryRequired: true,
    });
  } catch (err) {
    const status = err instanceof recoveryService.RecoveryError
      ? 400
      : err instanceof graphService.PilotEligibilityError
        ? 409
        : 502;
    console.error('[recovery-requests] Recovery request creation failed:', err.message);
    return res.status(status).json({
      error: err instanceof graphService.PilotEligibilityError
        ? 'The selected Entra user is not currently eligible for the pilot.'
        : 'Failed to create recovery request.',
    });
  }
});

module.exports = router;
