'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const graphService = require('../services/graph-service');
const notificationService = require('../services/manager-notification-service');
const { V2StateError } = require('../services/onboarding-v2-service');
const recoveryService = require('../services/recovery-v2-service');
const verifiedIdService = require('../services/verified-id-service');
const {
  hashNormalized,
  validateV2PresentedCredential,
} = require('../services/verified-subject-service');
const {
  digestIdentifier,
  timingSafeHashEqual,
  timingSafeTextEqual,
} = require('../services/v2-crypto-service');
const {
  destroySession,
  getCsrfToken,
  regenerateSession,
  requireCsrf,
} = require('../middleware/v2-security');

const router = express.Router();

function normalizeUpn(value) {
  return String(value || '').trim().toLowerCase();
}

function validIntake(upn, employeeId) {
  return upn.length <= 254 &&
    /^[^@\s]+@[^@\s]+$/.test(upn) &&
    employeeId.length > 0 &&
    employeeId.length <= 64;
}

function callbackKeyMatches(received) {
  return timingSafeTextEqual(
    received,
    config.selfServiceV2.verifiedId.callbackApiKey
  );
}

function callbackAuthenticated(req) {
  return callbackKeyMatches(req.get('api-key') || req.get('authorization'));
}

function toExpiryIso(value) {
  if (typeof value === 'number') return new Date(value * 1000).toISOString();
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date(Date.now() + 5 * 60 * 1000).toISOString();
}

function coarseStatus(request) {
  const nextActions = {
    requested: 'await-manager-notification',
    'manager-notified': 'await-manager-decision',
    'manager-approved': 'present-credential',
    'credential-presented': 'verifying',
    verified: 'preparing-access-pass',
    'passkeys-revoked': request.tapStatus === 'error'
      ? 'closed'
      : 'preparing-access-pass',
    'tap-issued': 'display-access-pass',
    'passkey-registered': 'complete',
    complete: 'complete',
    expired: 'closed',
    locked: 'closed',
  };
  return {
    state: request.state,
    nextAction: nextActions[request.state] || 'wait',
    updatedAt: request.updatedAt,
  };
}

async function loadBoundRecoveryRequest(req) {
  const binding = req.session.v2Recovery;
  if (!binding?.requestId || !binding.employeeObjectId) {
    throw new V2StateError(
      'No active recovery session.',
      'recovery_session_required',
      401
    );
  }
  const request = await recoveryService.loadRequest(binding.requestId);
  if (!timingSafeTextEqual(
    String(request.employeeObjectId).toLowerCase(),
    String(binding.employeeObjectId).toLowerCase()
  )) {
    throw new V2StateError(
      'Recovery session binding does not match.',
      'recovery_session_mismatch',
      403
    );
  }
  return request;
}

async function auditRejectedRecovery(req, upn, reasonCode) {
  try {
    await recoveryService.writeAudit({
      correlationId: req.session.v2RecoveryCorrelationId,
      eventType: 'recovery_intake_rejected',
      outcome: reasonCode,
      upnDigest: digestIdentifier(upn),
      ipDigest: digestIdentifier(req.ip),
    });
  } catch (err) {
    console.error(`[v2-recovery] Audit write failed; code=${err.code || 'storage_error'}`);
  }
}

router.get('/v2/recovery', (req, res) => {
  return res.render('v2-recovery', {
    title: 'Self-Service Recovery',
    csrfToken: getCsrfToken(req, 'recovery'),
  });
});

router.post(
  '/api/v2/recovery/requests',
  requireCsrf('recovery'),
  async (req, res) => {
    const userPrincipalName = normalizeUpn(req.body.userPrincipalName);
    const employeeId = String(req.body.employeeId || '').trim();
    req.session.v2RecoveryCorrelationId =
      req.session.v2RecoveryCorrelationId || crypto.randomUUID();

    const genericResponse = () => res.status(202).json({
      accepted: true,
      message: 'If the submitted details are eligible, continue in this browser to present your Verified ID.',
      csrfToken: getCsrfToken(req, 'recovery'),
    });

    try {
      const [ipLimit, upnLimit] = await Promise.all([
        recoveryService.enforceRateLimit(
          'recovery-ip',
          req.ip,
          config.selfServiceV2.recovery.maxDailyRequestsPerIp
        ),
        recoveryService.enforceRateLimit(
          'recovery-upn',
          userPrincipalName,
          config.selfServiceV2.recovery.maxDailyRequestsPerUpn
        ),
      ]);
      if (!ipLimit.allowed || !upnLimit.allowed) {
        await auditRejectedRecovery(req, userPrincipalName, 'rate_limited');
        return genericResponse();
      }
      if (!validIntake(userPrincipalName, employeeId)) {
        await auditRejectedRecovery(req, userPrincipalName, 'invalid_input');
        return genericResponse();
      }

      const employee = await graphService.getEmployeeWithManager(userPrincipalName);
      const submittedEmployeeHash = hashNormalized(employeeId);
      const authoritativeEmployeeHash = hashNormalized(employee?.employeeId);
      const manager = employee?.manager;
      const eligible = employee &&
        employee.accountEnabled === true &&
        employee.employeeId &&
        timingSafeHashEqual(submittedEmployeeHash, authoritativeEmployeeHash) &&
        manager?.id &&
        manager.mail &&
        (config.demoMode ||
          await graphService.isUserInGroup(employee.id, config.graph.pilotGroupId));

      if (!eligible) {
        await auditRejectedRecovery(req, userPrincipalName, 'directory_mismatch');
        return genericResponse();
      }

      const employeeLimit = await recoveryService.enforceRateLimit(
        'recovery-employee',
        employee.id,
        config.selfServiceV2.recovery.maxDailyRequestsPerEmployee
      );
      if (!employeeLimit.allowed) {
        await auditRejectedRecovery(req, userPrincipalName, 'employee_rate_limited');
        return genericResponse();
      }
      await graphService.requireNativeUser(employee.id);

      const created = await recoveryService.createRecoveryRequest({
        tenantId: config.azure.tenantId,
        employee,
        manager,
        employeeIdHash: authoritativeEmployeeHash,
      });
      const approvalUrl =
        `${config.appBaseUrl}/v2/manager/approval#token=` +
        encodeURIComponent(created.managerToken);
      const notification = await notificationService.sendApprovalRequest({
        requestId: created.record.requestId,
        correlationId: created.record.correlationId,
        managerEmail: manager.mail,
        approvalUrl,
        employeeDisplayName: created.record.employeeDisplayName,
        requestKind: 'recovery',
      });
      if (notification.accepted) {
        await recoveryService.markManagerNotified(
          created.record.requestId,
          notification.provider
        );
      } else {
        await recoveryService.markNotificationFailed(
          created.record.requestId,
          notification.reasonCode
        );
      }
      await regenerateSession(req);
      req.session.v2Recovery = {
        requestId: created.record.requestId,
        employeeObjectId: created.record.employeeObjectId,
        recoveryMode: true,
      };
      getCsrfToken(req, 'recovery');
      return genericResponse();
    } catch (err) {
      await auditRejectedRecovery(req, userPrincipalName, err.code || 'recovery_request_failed');
      console.error(`[v2-recovery] Request failed; code=${err.code || 'recovery_request_failed'}`);
      return genericResponse();
    }
  }
);

router.get('/api/v2/recovery/status', async (req, res) => {
  const requestId = req.session.v2Recovery?.requestId;
  if (!requestId) {
    return res.status(401).json({ error: 'No active recovery session.' });
  }
  try {
    const request = await recoveryService.loadRequest(requestId);
    return res.json(coarseStatus(request));
  } catch (err) {
    return res.status(err.status || 503).json({
      error: 'Recovery status is temporarily unavailable.',
    });
  }
});

router.post(
  '/api/v2/recovery/verified-id/presentation/requests',
  requireCsrf('recovery'),
  async (req, res) => {
    let request;
    let callbackState;
    try {
      request = await loadBoundRecoveryRequest(req);
      if (!['manager-approved', 'credential-presented'].includes(request.state)) {
        throw new V2StateError(
          'Manager approval is required before recovery credential presentation.',
          'invalid_state'
        );
      }
      callbackState = crypto.randomBytes(32).toString('base64url');
      await recoveryService.beginPresentation(request.requestId, {
        state: callbackState,
      });
      const employee = await graphService.getEmployeeWithManager(
        request.employeeUserPrincipalName
      );
      const response = await verifiedIdService.createV2PresentationRequest({
        callbackUrl:
          `${config.appBaseUrl}/api/v2/recovery/verified-id/presentation/callback`,
        callbackState,
        employeeObjectId: request.employeeObjectId,
        employeeId: employee.employeeId,
      });
      await recoveryService.attachPresentationRequest(request.requestId, {
        state: callbackState,
        requestId: response.requestId,
        expiresAt: toExpiryIso(response.expiry),
      });
      return res.status(201).json({
        requestId: response.requestId,
        url: response.url,
        qrCode: response.qrCode,
        expiry: response.expiry,
      });
    } catch (err) {
      if (request && callbackState) {
        await recoveryService.failPresentationRequest(
          request.requestId,
          callbackState,
          err.code || 'request_service_error'
        ).catch(() => {});
      }
      console.error(`[v2-recovery] Presentation request failed; code=${err.code || 'request_service_error'}`);
      return res.status(err.status || 502).json({
        error: 'Recovery credential presentation could not be started.',
      });
    }
  }
);

router.post('/api/v2/recovery/verified-id/presentation/callback', async (req, res) => {
  if (!callbackAuthenticated(req)) return res.status(401).end();
  const { requestId, requestStatus, state } = req.body || {};
  if (!requestId || !state ||
      !['request_retrieved', 'presentation_verified', 'presentation_error']
        .includes(requestStatus)) {
    return res.status(400).end();
  }

  try {
    const request = await recoveryService.findByPresentationCorrelation(requestId, state);
    if (!request) {
      throw new V2StateError(
        'Recovery callback correlation failed.',
        'callback_mismatch',
        404
      );
    }
    if (requestStatus === 'request_retrieved') {
      if (['credential-presented', 'verified', 'passkeys-revoked', 'tap-issued']
        .includes(request.state)) {
        return res.status(204).end();
      }
      await recoveryService.handlePresentationRetrieved(request.requestId);
      return res.status(204).end();
    }
    if (requestStatus === 'presentation_error') {
      if (['verified', 'passkeys-revoked', 'tap-issued'].includes(request.state)) {
        return res.status(204).end();
      }
      await recoveryService.handlePresentationError(
        request.requestId,
        req.body.error?.code
      );
      return res.status(204).end();
    }

    const credentials = req.body.verifiedCredentialsData;
    if (!Array.isArray(credentials) || credentials.length !== 1) {
      await recoveryService.recordVerificationFailure(
        request.requestId,
        'credential_count'
      );
      return res.status(400).end();
    }

    let audit;
    try {
      audit = validateV2PresentedCredential(
        credentials[0],
        {
          objectId: request.employeeObjectId,
          employeeIdHash: request.employeeIdHash,
        },
        {
          issuer: config.selfServiceV2.verifiedId.authority,
          credentialType: config.selfServiceV2.verifiedId.credentialType,
          objectIdClaim: config.selfServiceV2.verifiedId.objectIdClaim,
          employeeIdClaim: config.selfServiceV2.verifiedId.employeeIdClaim,
          linkedDomain: config.selfServiceV2.verifiedId.linkedDomain,
        }
      );
    } catch (err) {
      await recoveryService.recordVerificationFailure(
        request.requestId,
        'credential_validation'
      );
      return res.status(400).end();
    }

    if (request.state === 'credential-presented') {
      await recoveryService.markVerified(request.requestId, audit);
    } else if (['passkeys-revoked', 'tap-issued', 'passkey-registered', 'complete']
      .includes(request.state)) {
      return res.status(204).end();
    } else if (request.state !== 'verified') {
      throw new V2StateError(
        'Recovery callback is not valid in this state.',
        'invalid_state'
      );
    }

    await recoveryService.revokePasskeysAndIssueTap(request.requestId, async (current) => {
      await graphService.getEligiblePilotUser(current.employeeObjectId);
      const revokedMethodIds = await graphService.revokeAllFido2Methods(
        current.employeeObjectId
      );
      const tap = await graphService.createTemporaryAccessPass(
        current.employeeObjectId
      );
      return { revokedMethodIds, tap };
    });
    return res.status(204).end();
  } catch (err) {
    console.error(`[v2-recovery] Presentation callback failed; code=${err.code || 'callback_error'}`);
    return res.status(err.status || 502).end();
  }
});

router.get('/v2/recovery/passkey', async (req, res) => {
  try {
    const request = await loadBoundRecoveryRequest(req);
    if (request.state !== 'tap-issued') {
      return res.redirect('/v2/recovery');
    }
    const tap = await recoveryService.takeTapForDisplay(request.requestId);
    return res.render('v2-recovery-passkey', {
      title: 'Register Your Replacement Passkey',
      csrfToken: getCsrfToken(req, 'recovery-passkey'),
      temporaryAccessPass: tap.tap,
      lifetimeInMinutes: tap.lifetimeInMinutes,
      securityInfoUrl: config.graph.securityInfoUrl,
    });
  } catch (err) {
    return res.status(err.status || 410).render('v2-recovery-passkey', {
      title: 'Recovery Temporary Access Pass Unavailable',
      csrfToken: getCsrfToken(req, 'recovery-passkey'),
      temporaryAccessPass: null,
      lifetimeInMinutes: null,
      securityInfoUrl: config.graph.securityInfoUrl,
      error: err.code === 'tap_already_displayed'
        ? 'The recovery Temporary Access Pass was already displayed. Start a new recovery request if needed.'
        : 'The recovery Temporary Access Pass is not available.',
    });
  }
});

router.post(
  '/api/v2/recovery/passkey/confirm',
  requireCsrf('recovery-passkey'),
  async (req, res) => {
    try {
      const request = await loadBoundRecoveryRequest(req);
      if (request.state !== 'tap-issued') {
        throw new V2StateError(
          'Recovery passkey confirmation is not available in this state.',
          'invalid_state'
        );
      }
      const limit = await recoveryService.enforceRateLimit(
        'recovery-passkey-confirm',
        request.requestId,
        config.selfServiceV2.recovery.maxPasskeyConfirmAttempts,
        Date.now(),
        10 * 60 * 1000
      );
      if (!limit.allowed) {
        return res.status(429).json({
          error: 'Recovery passkey confirmation is temporarily rate-limited.',
        });
      }
      const methods = await graphService.listFido2Methods(request.employeeObjectId);
      const updated = await recoveryService.confirmPasskey(request.requestId, methods);
      return res.json({
        registered: true,
        methodId: updated.passkeyMethodId,
      });
    } catch (err) {
      return res.status(err.status || 502).json({
        error: err.code === 'passkey_not_found'
          ? 'No replacement tenant passkey was found yet.'
          : 'Replacement passkey confirmation failed.',
      });
    }
  }
);

router.get('/v2/recovery/complete', async (req, res) => {
  try {
    const request = await loadBoundRecoveryRequest(req);
    const completed = request.state === 'complete'
      ? request
      : await recoveryService.complete(request.requestId);
    const viewModel = {
      title: 'Recovery Complete',
      employeeDisplayName: completed.employeeDisplayName,
      completedAt: completed.completedAt,
    };
    await destroySession(req);
    return res.render('v2-recovery-complete', viewModel);
  } catch (_) {
    return res.redirect('/v2/recovery');
  }
});

module.exports = router;
module.exports.coarseStatus = coarseStatus;
module.exports.normalizeUpn = normalizeUpn;
module.exports.validIntake = validIntake;
module.exports.loadBoundRecoveryRequest = loadBoundRecoveryRequest;
