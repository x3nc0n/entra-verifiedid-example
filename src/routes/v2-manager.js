'use strict';

const express = require('express');
const graphService = require('../services/graph-service');
const managerAuthService = require('../services/manager-auth-service');
const onboardingService = require('../services/onboarding-v2-service');
const {
  digestIdentifier,
  timingSafeTextEqual,
} = require('../services/v2-crypto-service');
const {
  getCsrfToken,
  requireCsrf,
  regenerateSession,
} = require('../middleware/v2-security');

const router = express.Router();

function preAuthIsActive(preAuth) {
  return preAuth?.requestId &&
    preAuth.tokenHash &&
    Date.now() < Date.parse(preAuth.expiresAt);
}

function logManagerAuthorizationDiagnostics(message, details = {}) {
  const redact = (key, value) => {
    if (/requestId|correlationId|code$|state$/.test(key)) {
      return value;
    }
    try {
      return digestIdentifier(value);
    } catch (_) {
      return 'digest-unavailable';
    }
  };
  const serialized = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${redact(key, value)}`)
    .join(' ');
  console.warn(`[v2-manager] ${message}${serialized ? `; ${serialized}` : ''}`);
}

router.get('/v2/manager/approval', async (req, res) => {
  const managerSession = req.session.v2Manager;
  if (managerSession?.requestId) {
    try {
      const request = await onboardingService.loadRequest(managerSession.requestId);
      return res.render('v2-manager-approval', {
        title: 'Manager Approval',
        csrfToken: getCsrfToken(req, 'manager'),
        activated: true,
        authenticated: true,
        request: {
          requestId: request.requestId,
          employeeDisplayName: request.employeeDisplayName,
          employeeUserPrincipalName: request.employeeUserPrincipalName,
          state: request.state,
        },
      });
    } catch (_) {
      delete req.session.v2Manager;
    }
  }

  return res.render('v2-manager-approval', {
    title: 'Manager Approval',
    csrfToken: getCsrfToken(req, 'manager-bootstrap'),
    activated: preAuthIsActive(req.session.v2ManagerPreAuth),
    authenticated: false,
    request: null,
  });
});

router.post(
  '/api/v2/manager-approvals/activate',
  requireCsrf('manager-bootstrap'),
  async (req, res) => {
    try {
      const preAuth = await onboardingService.activateManagerToken(req.body.token);
      await regenerateSession(req);
      req.session.v2ManagerPreAuth = preAuth;
      getCsrfToken(req, 'manager-bootstrap');
      return res.status(204).end();
    } catch (err) {
      return res.status(err.status || 410).json({
        error: 'This manager approval link is invalid or expired.',
      });
    }
  }
);

router.get('/auth/manager/signin', async (req, res) => {
  const preAuth = req.session.v2ManagerPreAuth;
  if (!preAuthIsActive(preAuth)) {
    delete req.session.v2ManagerPreAuth;
    return res.redirect('/v2/manager/approval');
  }
  try {
    const authorization = await managerAuthService.createAuthorizationRequest();
    await onboardingService.beginManagerSignIn(
      preAuth.requestId,
      preAuth.tokenHash,
      {
        ...authorization,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      }
    );
    return res.redirect(authorization.url);
  } catch (err) {
    console.error('[v2-manager] Sign-in initialization failed.');
    return res.status(503).render('v2-manager-approval', {
      title: 'Manager Sign-In Unavailable',
      csrfToken: getCsrfToken(req, 'manager-bootstrap'),
      activated: true,
      authenticated: false,
      request: null,
      error: 'Manager sign-in is temporarily unavailable.',
    });
  }
});

router.post('/auth/manager/callback', async (req, res) => {
  if (!req.body.state || !req.body.code) {
    return res.status(400).render('v2-manager-approval', {
      title: 'Manager Sign-In Expired',
      csrfToken: getCsrfToken(req, 'manager-bootstrap'),
      activated: false,
      authenticated: false,
      request: null,
      error: 'The manager sign-in session expired. Open the approval link again.',
    });
  }

  try {
    const flow = await onboardingService.loadManagerAuthFlow(req.body.state);
    const manager = await managerAuthService.exchangeAuthorizationCode({
      code: req.body.code,
      state: req.body.state,
      expectedState: flow.request.managerAuthState,
      expectedNonce: flow.nonce,
      codeVerifier: flow.codeVerifier,
      authorizationPayload: req.body,
    });
    const employee = await graphService.getEmployeeWithManager(
      flow.request.employeeUserPrincipalName
    );
    if (!employee ||
        !timingSafeTextEqual(
          String(employee.id).toLowerCase(),
          String(flow.request.employeeObjectId).toLowerCase()
        ) ||
        !employee.manager?.id) {
      logManagerAuthorizationDiagnostics('Manager callback could not verify employee binding', {
        requestId: flow.request.requestId,
        correlationId: flow.request.correlationId,
        employeeObjectId: flow.request.employeeObjectId,
        graphEmployeeObjectId: employee?.id,
        storedManagerObjectId: flow.request.managerObjectId,
      });
      throw new onboardingService.V2StateError(
        'The current employee-to-manager relationship could not be verified.',
        'manager_relationship_changed',
        409
      );
    }
    if (!timingSafeTextEqual(
      String(manager.objectId).toLowerCase(),
      String(employee.manager.id).toLowerCase()
    )) {
      logManagerAuthorizationDiagnostics('Manager callback object ID mismatch', {
        requestId: flow.request.requestId,
        correlationId: flow.request.correlationId,
        storedManagerObjectId: flow.request.managerObjectId,
        graphManagerObjectId: employee.manager.id,
        signedInManagerObjectId: manager.objectId,
        requestTenantId: flow.request.tenantId,
        signedInTenantId: manager.tenantId,
      });
      throw new onboardingService.V2StateError(
        'The signed-in account is not the current manager for this request.',
        'manager_not_authorized',
        403
      );
    }
    if (!timingSafeTextEqual(
      String(flow.request.managerObjectId).toLowerCase(),
      String(employee.manager.id).toLowerCase()
    )) {
      logManagerAuthorizationDiagnostics('Manager callback repaired stale manager binding', {
        requestId: flow.request.requestId,
        correlationId: flow.request.correlationId,
        storedManagerObjectId: flow.request.managerObjectId,
        graphManagerObjectId: employee.manager.id,
        signedInManagerObjectId: manager.objectId,
      });
    }
    await onboardingService.redeemManagerToken({
      requestId: flow.request.requestId,
      tokenHash: flow.request.managerTokenHash,
      managerObjectId: manager.objectId,
      authorizedManagerObjectId: employee.manager.id,
      tenantId: manager.tenantId,
    });
    await regenerateSession(req);
    req.session.v2Manager = {
      requestId: flow.request.requestId,
      managerObjectId: manager.objectId,
      tenantId: manager.tenantId,
      authenticatedAt: new Date().toISOString(),
    };
    getCsrfToken(req, 'manager');
    return res.redirect('/v2/manager/approval');
  } catch (err) {
    if (req.body.state) {
      const flow = await onboardingService.loadManagerAuthFlow(req.body.state)
        .catch(() => null);
      if (flow) {
        await onboardingService.recordManagerRedemptionFailure(
          flow.request.requestId,
          err.code || 'manager_authentication_failed'
        ).catch(() => {});
      }
    }
    console.warn(
      `[v2-manager] Manager authentication was rejected; code=${err.code || 'manager_authentication_failed'}`
    );
    return res.status(403).render('v2-manager-approval', {
      title: 'Manager Sign-In Rejected',
      csrfToken: getCsrfToken(req, 'manager-bootstrap'),
      activated: false,
      authenticated: false,
      request: null,
      error: 'The signed-in account is not authorized for this approval.',
    });
  }
});

router.post(
  '/api/v2/manager-approvals/:requestId/decision',
  requireCsrf('manager'),
  async (req, res) => {
    const managerSession = req.session.v2Manager;
    if (!managerSession ||
        !timingSafeTextEqual(managerSession.requestId, req.params.requestId)) {
      return res.status(403).json({ error: 'Manager authorization is required.' });
    }
    try {
      const request = await onboardingService.loadRequest(req.params.requestId);
      const employee = await graphService.getEmployeeWithManager(
        request.employeeUserPrincipalName
      );
      if (!employee ||
          !timingSafeTextEqual(
            String(employee.id).toLowerCase(),
            String(request.employeeObjectId).toLowerCase()
          ) ||
          !employee.manager?.id ||
          !timingSafeTextEqual(
            String(employee.manager.id).toLowerCase(),
            String(managerSession.managerObjectId).toLowerCase()
          )) {
        await onboardingService.recordManagerRedemptionFailure(
          request.requestId,
          'manager_relationship_changed'
        );
        return res.status(409).json({
          error: 'The current manager relationship no longer authorizes this decision.',
        });
      }

      const updated = await onboardingService.decide(
        request.requestId,
        managerSession.managerObjectId,
        req.body.decision
      );
      req.session.v2Manager.decision = updated.managerDecision;
      return res.json({ decision: updated.managerDecision });
    } catch (err) {
      console.warn(`[v2-manager] Decision rejected; code=${err.code || 'decision_error'}`);
      return res.status(err.status || 409).json({
        error: 'The manager decision could not be recorded.',
      });
    }
  }
);

module.exports = router;
module.exports.preAuthIsActive = preAuthIsActive;
