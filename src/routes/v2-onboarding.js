'use strict';

const express = require('express');
const config = require('../config');
const graphService = require('../services/graph-service');
const notificationService = require('../services/manager-notification-service');
const onboardingService = require('../services/onboarding-v2-service');
const { hashNormalized } = require('../services/verified-subject-service');
const {
  digestIdentifier,
  timingSafeHashEqual,
} = require('../services/v2-crypto-service');
const {
  getCsrfToken,
  requireCsrf,
  regenerateSession,
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

function coarseStatus(request) {
  const nextActions = {
    requested: 'await-manager-notification',
    'manager-notified': 'await-manager-decision',
    'manager-approved': 'request-credential',
    'manager-rejected': 'closed',
    'credential-issued': 'present-credential',
    'credential-presented': 'verifying',
    verified: 'preparing-access-pass',
    'tap-issued': 'display-access-pass',
    'passkey-registered': 'complete',
    complete: 'complete',
    expired: 'closed',
    locked: 'closed',
  };
  const presentationExpired = request.state === 'credential-presented' &&
    Date.now() >= Date.parse(request.presentationExpiresAt);
  return {
    state: request.state,
    nextAction: presentationExpired
      ? 'present-credential'
      : nextActions[request.state] || 'wait',
    updatedAt: request.updatedAt,
  };
}

async function auditRejectedIntake(req, upn, reasonCode) {
  try {
    await onboardingService.writeAudit({
      correlationId: req.session.v2IntakeCorrelationId,
      eventType: 'intake_rejected',
      outcome: reasonCode,
      upnDigest: digestIdentifier(upn),
      ipDigest: digestIdentifier(req.ip),
    });
  } catch (err) {
    console.error(`[v2-intake] Audit write failed; code=${err.code || 'storage_error'}`);
  }
}

router.get('/v2/onboarding', (req, res) => {
  const csrfToken = getCsrfToken(req, 'employee');
  return res.render('v2-onboarding', {
    title: 'Self-Service Verified ID Onboarding',
    csrfToken,
  });
});

router.post(
  '/api/v2/onboarding/requests',
  requireCsrf('employee'),
  async (req, res) => {
    const userPrincipalName = normalizeUpn(req.body.userPrincipalName);
    const employeeId = String(req.body.employeeId || '').trim();
    req.session.v2IntakeCorrelationId =
      req.session.v2IntakeCorrelationId || require('crypto').randomUUID();

    const genericResponse = () => res.status(202).json({
      accepted: true,
      message: 'If the submitted details are eligible, the manager will receive an approval request.',
      csrfToken: getCsrfToken(req, 'employee'),
    });

    try {
      const [ipLimit, upnLimit] = await Promise.all([
        onboardingService.enforceRateLimit(
          'ip',
          req.ip,
          config.selfServiceV2.maxDailyRequestsPerIp
        ),
        onboardingService.enforceRateLimit(
          'upn',
          userPrincipalName,
          config.selfServiceV2.maxDailyRequestsPerUpn
        ),
      ]);
      if (!ipLimit.allowed || !upnLimit.allowed) {
        await auditRejectedIntake(req, userPrincipalName, 'rate_limited');
        return genericResponse();
      }

      if (!validIntake(userPrincipalName, employeeId)) {
        await auditRejectedIntake(req, userPrincipalName, 'invalid_input');
        return genericResponse();
      }

      const employee = await graphService.getEmployeeWithManager(userPrincipalName);
      const manager = employee?.manager;
      const submittedEmployeeHash = hashNormalized(employeeId);
      const authoritativeEmployeeHash = hashNormalized(employee?.employeeId);
      const eligible = employee &&
        employee.accountEnabled === true &&
        employee.employeeId &&
        timingSafeHashEqual(submittedEmployeeHash, authoritativeEmployeeHash) &&
        manager?.id &&
        manager.mail &&
        (config.demoMode ||
          await graphService.isUserInGroup(employee.id, config.graph.pilotGroupId));

      if (!eligible) {
        await auditRejectedIntake(req, userPrincipalName, 'directory_mismatch');
        return genericResponse();
      }

      const employeeLimit = await onboardingService.enforceRateLimit(
        'employee',
        employee.id,
        config.selfServiceV2.maxDailyRequestsPerEmployee
      );
      if (!employeeLimit.allowed) {
        await auditRejectedIntake(req, userPrincipalName, 'employee_rate_limited');
        return genericResponse();
      }

      const created = await onboardingService.createRequest({
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
      });

      if (notification.accepted) {
        await onboardingService.markManagerNotified(
          created.record.requestId,
          notification.provider
        );
      } else {
        await onboardingService.markNotificationFailed(
          created.record.requestId,
          notification.reasonCode
        );
      }

      await regenerateSession(req);
      req.session.v2Employee = {
        requestId: created.record.requestId,
        employeeObjectId: created.record.employeeObjectId,
      };
      getCsrfToken(req, 'employee');
      return genericResponse();
    } catch (err) {
      const code = err instanceof onboardingService.V2StateError
        ? err.code
        : 'intake_failure';
      await auditRejectedIntake(req, userPrincipalName, code);
      console.error(`[v2-intake] Request failed; code=${code}`);
      return genericResponse();
    }
  }
);

router.get('/api/v2/onboarding/status', async (req, res) => {
  const requestId = req.session.v2Employee?.requestId;
  if (!requestId) return res.status(401).json({ error: 'No active onboarding session.' });
  try {
    const request = await onboardingService.loadRequest(requestId);
    return res.json(coarseStatus(request));
  } catch (err) {
    return res.status(err.status || 503).json({
      error: 'Onboarding status is temporarily unavailable.',
    });
  }
});

module.exports = router;
module.exports.coarseStatus = coarseStatus;
module.exports.normalizeUpn = normalizeUpn;
module.exports.validIntake = validIntake;
