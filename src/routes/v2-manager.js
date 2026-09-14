'use strict';

const express = require('express');
const config = require('../config');
const graphService = require('../services/graph-service');
const managerAuthService = require('../services/manager-auth-service');
const onboardingService = require('../services/onboarding-v2-service');
const { hashNormalized } = require('../services/verified-subject-service');
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

function dashboardAuthIsActive(auth) {
  return auth?.state &&
    auth?.nonce &&
    auth?.codeVerifier &&
    Date.now() < Date.parse(auth.expiresAt);
}

function dashboardSessionIsActive(session) {
  return session?.managerObjectId &&
    session?.tenantId &&
    Date.now() < Date.parse(session.expiresAt || 0);
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

router.get('/v2/manager/dashboard', async (req, res) => {
  const dashboardSession = req.session.v2ManagerDashboard;
  if (!dashboardSessionIsActive(dashboardSession)) {
    delete req.session.v2ManagerDashboard;
    return res.render('v2-manager-dashboard', {
      title: 'Manager Dashboard',
      csrfToken: getCsrfToken(req, 'manager-dashboard-bootstrap'),
      authenticated: false,
      directReports: [],
      managerDisplayName: null,
      managerUpn: null,
    });
  }

  try {
    const directReports = await graphService.listDirectReports(
      dashboardSession.managerObjectId
    );
    return res.render('v2-manager-dashboard', {
      title: 'Manager Dashboard',
      csrfToken: getCsrfToken(req, 'manager-dashboard'),
      authenticated: true,
      directReports: directReports
        .filter((report) => report.accountEnabled !== false)
        .sort((left, right) =>
          String(left.displayName || left.userPrincipalName)
            .localeCompare(String(right.displayName || right.userPrincipalName))
        ),
      managerDisplayName: dashboardSession.displayName,
      managerUpn: dashboardSession.userPrincipalName,
    });
  } catch (err) {
    console.error('[v2-manager] Dashboard load failed.');
    return res.status(503).render('v2-manager-dashboard', {
      title: 'Manager Dashboard Unavailable',
      csrfToken: getCsrfToken(req, 'manager-dashboard-bootstrap'),
      authenticated: false,
      directReports: [],
      managerDisplayName: null,
      managerUpn: null,
      error: 'Manager dashboard is temporarily unavailable.',
    });
  }
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

router.get('/auth/manager/dashboard/signin', async (req, res) => {
  try {
    const authorization = await managerAuthService.createAuthorizationRequest();
    req.session.v2ManagerDashboardAuth = {
      ...authorization,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    return res.redirect(authorization.url);
  } catch (err) {
    console.error('[v2-manager] Dashboard sign-in initialization failed.');
    return res.status(503).render('v2-manager-dashboard', {
      title: 'Manager Dashboard Unavailable',
      csrfToken: getCsrfToken(req, 'manager-dashboard-bootstrap'),
      authenticated: false,
      directReports: [],
      managerDisplayName: null,
      managerUpn: null,
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

  const dashboardAuth = req.session.v2ManagerDashboardAuth;
  if (dashboardAuthIsActive(dashboardAuth) &&
      timingSafeTextEqual(req.body.state, dashboardAuth.state)) {
    try {
      const authenticatedManager = await managerAuthService.exchangeAuthorizationCode({
        code: req.body.code,
        state: req.body.state,
        expectedState: dashboardAuth.state,
        expectedNonce: dashboardAuth.nonce,
        codeVerifier: dashboardAuth.codeVerifier,
        authorizationPayload: req.body,
      });
      const managerProfile = await graphService.getUserById(authenticatedManager.objectId);
      await regenerateSession(req);
      req.session.v2ManagerDashboard = {
        managerObjectId: authenticatedManager.objectId,
        tenantId: authenticatedManager.tenantId,
        displayName: managerProfile?.displayName || authenticatedManager.displayName,
        userPrincipalName: managerProfile?.userPrincipalName || null,
        authenticatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
      getCsrfToken(req, 'manager-dashboard');
      return res.redirect('/v2/manager/dashboard');
    } catch (err) {
      console.warn(
        `[v2-manager] Dashboard authentication was rejected; code=${err.code || 'manager_dashboard_authentication_failed'}`
      );
      delete req.session.v2ManagerDashboardAuth;
      return res.status(403).render('v2-manager-dashboard', {
        title: 'Manager Dashboard Sign-In Rejected',
        csrfToken: getCsrfToken(req, 'manager-dashboard-bootstrap'),
        authenticated: false,
        directReports: [],
        managerDisplayName: null,
        managerUpn: null,
        error: 'The signed-in account could not access the manager dashboard.',
      });
    }
  }

  let authenticatedManager = null;
  try {
    const flow = await onboardingService.loadManagerAuthFlow(req.body.state);
    authenticatedManager = await managerAuthService.exchangeAuthorizationCode({
      code: req.body.code,
      state: req.body.state,
      expectedState: flow.request.managerAuthState,
      expectedNonce: flow.nonce,
      codeVerifier: flow.codeVerifier,
      authorizationPayload: req.body,
    });
    await onboardingService.redeemManagerToken({
      requestId: flow.request.requestId,
      tokenHash: flow.request.managerTokenHash,
      managerObjectId: authenticatedManager.objectId,
      tenantId: authenticatedManager.tenantId,
    });

    // The manager token is now redeemed (one-shot, already consumed above).
    // Establishing the session is handled in its own try/catch, separate
    // from the authentication-rejection handling below: a failure here is a
    // session-persistence problem, not an authorization rejection, and must
    // not be recorded or reported as one.
    try {
      await regenerateSession(req);
      req.session.v2Manager = {
        requestId: flow.request.requestId,
        managerObjectId: authenticatedManager.objectId,
        tenantId: authenticatedManager.tenantId,
        authenticatedAt: new Date().toISOString(),
      };
      getCsrfToken(req, 'manager');
      await new Promise((resolve, reject) => {
        req.session.save((err) => err ? reject(err) : resolve());
      });
    } catch (sessionErr) {
      console.error(
        '[v2-manager] Manager sign-in succeeded but the session could not be saved.'
      );
      req.session = null;
      return res.status(503).render('v2-manager-approval', {
        title: 'Manager Sign-In Unavailable',
        csrfToken: '',
        activated: false,
        authenticated: false,
        request: null,
        error: 'Sign-in succeeded, but your approval session could not be saved. ' +
          'Please ask for a new approval link and try again.',
      });
    }

    // Do not redirect here. The IdP callback is a genuine cross-site,
    // top-level POST (response_mode=form_post); a SameSite=Strict cookie
    // set while handling it is withheld from the whole chain that request
    // is considered part of, including a same-origin redirect issued from
    // this same handler. Render a same-origin completion page instead so
    // the *next* navigation (the visible link, or the script on that page)
    // starts fresh from an already-loaded same-origin document and carries
    // the new session cookie normally.
    return res.render('v2-manager-callback-complete', {
      title: 'Sign-In Complete',
      heading: 'Sign-in complete',
      message: 'You are signed in. Continue to the approval request.',
      continueHref: '/v2/manager/approval',
      actionLabel: 'Continue to approval',
    });
  } catch (err) {
    if (req.body.state) {
      const flow = await onboardingService.loadManagerAuthFlow(req.body.state)
        .catch(() => null);
      if (flow) {
        if (err.code === 'manager_not_authorized') {
          const graphEmployee = await graphService.getEmployeeWithManager(
            flow.request.employeeUserPrincipalName
          ).catch(() => null);
          logManagerAuthorizationDiagnostics('Manager callback authorization mismatch', {
            requestId: flow.request.requestId,
            correlationId: flow.request.correlationId,
            storedEmployeeObjectId: flow.request.employeeObjectId,
            graphEmployeeObjectId: graphEmployee?.id,
            storedManagerObjectId: flow.request.managerObjectId,
            graphManagerObjectId: graphEmployee?.manager?.id,
            requestTenantId: flow.request.tenantId,
            signedInManagerObjectId: authenticatedManager?.objectId,
            signedInTenantId: authenticatedManager?.tenantId,
          });
        }
        await onboardingService.recordManagerRedemptionFailure(
          flow.request.requestId,
          err.code || 'manager_authentication_failed'
        ).catch(() => {});
      }
    }
    console.warn(
      `[v2-manager] Manager authentication was rejected; code=${err.code || 'manager_authentication_failed'}`
    );
    // Errors the onboarding service already models explicitly (e.g. the
    // sign-in transaction expired, or the token was reused) carry their own
    // safe, user-facing message and status. Surface it instead of a blanket
    // "not authorized" so an expired/replayed link isn't misreported as an
    // authorization mismatch.
    const isKnownStateError = err instanceof onboardingService.V2StateError;
    return res.status(isKnownStateError ? err.status : 403).render('v2-manager-approval', {
      title: 'Manager Sign-In Rejected',
      csrfToken: getCsrfToken(req, 'manager-bootstrap'),
      activated: false,
      authenticated: false,
      request: null,
      error: isKnownStateError
        ? err.message
        : 'The signed-in account is not authorized for this approval.',
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

router.post(
  '/api/v2/manager/invitations',
  requireCsrf('manager-dashboard'),
  async (req, res) => {
    const dashboardSession = req.session.v2ManagerDashboard;
    if (!dashboardSessionIsActive(dashboardSession)) {
      delete req.session.v2ManagerDashboard;
      return res.status(403).json({ error: 'Manager dashboard authorization is required.' });
    }

    try {
      const directReports = await graphService.listDirectReports(
        dashboardSession.managerObjectId
      );
      const employee = directReports.find((report) =>
        timingSafeTextEqual(
          String(report.id).toLowerCase(),
          String(req.body.directReportId || '').trim().toLowerCase()
        )
      );
      if (!employee || !employee.employeeId || employee.accountEnabled === false) {
        return res.status(403).json({
          error: 'The selected employee is not eligible for manager-initiated onboarding.',
        });
      }

      const inviteLimit = await onboardingService.enforceRateLimit(
        'manager-dashboard',
        dashboardSession.managerObjectId,
        config.selfServiceV2.maxDailyManagerInvitations
      );
      if (!inviteLimit.allowed) {
        return res.status(429).json({
          error: 'Daily manager invitation limit reached.',
        });
      }

      await graphService.getEligiblePilotUser(employee.id);
      const created = await onboardingService.createManagerInitiatedRequest({
        tenantId: config.azure.tenantId,
        manager: { id: dashboardSession.managerObjectId },
        employee,
        employeeIdHash: hashNormalized(employee.employeeId),
      });
      return res.status(201).json({
        requestId: created.record.requestId,
        inviteUrl:
          `${config.appBaseUrl}/v2/onboarding/invite#token=` +
          encodeURIComponent(created.employeeInviteToken),
      });
    } catch (err) {
      console.warn(`[v2-manager] Dashboard invitation rejected; code=${err.code || 'invitation_error'}`);
      return res.status(err.status || 409).json({
        error: 'The manager invitation could not be created.',
      });
    }
  }
);

module.exports = router;
module.exports.preAuthIsActive = preAuthIsActive;
module.exports.dashboardAuthIsActive = dashboardAuthIsActive;
module.exports.dashboardSessionIsActive = dashboardSessionIsActive;
