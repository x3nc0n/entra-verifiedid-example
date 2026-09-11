'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const graphService = require('../services/graph-service');
const onboardingService = require('../services/onboarding-v2-service');
const verifiedIdService = require('../services/verified-id-service');
const {
  hashNormalized,
  validateV2PresentedCredential,
} = require('../services/verified-subject-service');
const {
  randomNumericPin,
  timingSafeHashEqual,
  timingSafeTextEqual,
} = require('../services/v2-crypto-service');
const { requireCsrf } = require('../middleware/v2-security');

const router = express.Router();

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

async function loadBoundEmployeeRequest(req) {
  const binding = req.session.v2Employee;
  if (!binding?.requestId || !binding.employeeObjectId) {
    throw new onboardingService.V2StateError(
      'No active employee onboarding session.',
      'employee_session_required',
      401
    );
  }
  const request = await onboardingService.loadRequest(binding.requestId);
  if (!timingSafeTextEqual(
    request.employeeObjectId.toLowerCase(),
    binding.employeeObjectId.toLowerCase()
  )) {
    throw new onboardingService.V2StateError(
      'Employee session binding does not match.',
      'employee_session_mismatch',
      403
    );
  }
  return request;
}

async function reloadBoundEmployee(request) {
  const employee = await graphService.getEmployeeWithManager(
    request.employeeUserPrincipalName
  );
  if (!employee ||
      employee.accountEnabled !== true ||
      !timingSafeTextEqual(
        String(employee.id).toLowerCase(),
        String(request.employeeObjectId).toLowerCase()
      ) ||
      !timingSafeHashEqual(
        hashNormalized(employee.employeeId),
        request.employeeIdHash
      )) {
    throw new onboardingService.V2StateError(
      'The bound employee record no longer matches.',
      'employee_binding_changed',
      409
    );
  }
  return employee;
}

router.post(
  '/api/v2/verified-id/issuance/requests',
  requireCsrf('employee'),
  async (req, res) => {
    let request;
    let callbackState;
    try {
      request = await loadBoundEmployeeRequest(req);
      if (request.state !== 'manager-approved') {
        throw new onboardingService.V2StateError(
          'Manager approval is required before credential issuance.',
          'invalid_state'
        );
      }
      const employee = await reloadBoundEmployee(request);
      callbackState = crypto.randomBytes(32).toString('base64url');
      const pin = randomNumericPin(
        config.selfServiceV2.verifiedId.issuancePinLength
      );
      await onboardingService.beginIssuance(request.requestId, {
        state: callbackState,
        pin,
      });
      const response = await verifiedIdService.createV2IssuanceRequest({
        callbackUrl:
          `${config.appBaseUrl}/api/v2/verified-id/issuance/callback`,
        callbackState,
        employeeObjectId: request.employeeObjectId,
        employeeId: employee.employeeId,
        pin,
      });
      await onboardingService.attachIssuanceRequest(request.requestId, {
        state: callbackState,
        requestId: response.requestId,
        expiresAt: toExpiryIso(response.expiry),
      });
      return res.status(201).json({
        requestId: response.requestId,
        url: response.url,
        qrCode: response.qrCode,
        expiry: response.expiry,
        pin,
      });
    } catch (err) {
      if (request && callbackState) {
        await onboardingService.failIssuanceRequest(
          request.requestId,
          callbackState,
          err.code || 'request_service_error'
        ).catch(() => {});
      }
      console.error(
        `[v2-issuance] Request failed; code=${err.code || 'request_service_error'}`
      );
      return res.status(err.status || 502).json({
        error: 'Credential issuance could not be started.',
      });
    }
  }
);

router.post('/api/v2/verified-id/issuance/callback', async (req, res) => {
  if (!callbackAuthenticated(req)) return res.status(401).end();
  const { requestId, requestStatus, state } = req.body || {};
  if (!requestId || !state ||
      !['request_retrieved', 'issuance_successful', 'issuance_error']
        .includes(requestStatus)) {
    return res.status(400).end();
  }
  try {
    await onboardingService.handleIssuanceCallback({
      requestId,
      requestStatus,
      state,
      error: req.body.error,
    });
    return res.status(204).end();
  } catch (err) {
    console.error(`[v2-issuance] Callback rejected; code=${err.code || 'callback_error'}`);
    return res.status(err.status || 409).end();
  }
});

router.post(
  '/api/v2/verified-id/presentation/requests',
  requireCsrf('employee'),
  async (req, res) => {
    let request;
    let callbackState;
    try {
      request = await loadBoundEmployeeRequest(req);
      if (!['credential-issued', 'credential-presented'].includes(request.state)) {
        throw new onboardingService.V2StateError(
          'Credential issuance must complete before presentation.',
          'invalid_state'
        );
      }
      const employee = await reloadBoundEmployee(request);
      callbackState = crypto.randomBytes(32).toString('base64url');
      await onboardingService.beginPresentation(request.requestId, {
        state: callbackState,
      });
      const response = await verifiedIdService.createV2PresentationRequest({
        callbackUrl:
          `${config.appBaseUrl}/api/v2/verified-id/presentation/callback`,
        callbackState,
        employeeObjectId: request.employeeObjectId,
        employeeId: employee.employeeId,
      });
      await onboardingService.attachPresentationRequest(request.requestId, {
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
        await onboardingService.failPresentationRequest(
          request.requestId,
          callbackState,
          err.code || 'request_service_error'
        ).catch(() => {});
      }
      console.error(
        `[v2-presentation] Request failed; code=${err.code || 'request_service_error'}`
      );
      return res.status(err.status || 502).json({
        error: 'Credential presentation could not be started.',
      });
    }
  }
);

router.post('/api/v2/verified-id/presentation/callback', async (req, res) => {
  if (!callbackAuthenticated(req)) return res.status(401).end();
  const { requestId, requestStatus, state } = req.body || {};
  if (!requestId || !state ||
      !['request_retrieved', 'presentation_verified', 'presentation_error']
        .includes(requestStatus)) {
    return res.status(400).end();
  }

  try {
    const request = await onboardingService.findByPresentationCorrelation(
      requestId,
      state
    );
    if (!request) {
      throw new onboardingService.V2StateError(
        'Presentation callback correlation failed.',
        'callback_mismatch',
        404
      );
    }
    if (requestStatus === 'request_retrieved') {
      if (['credential-presented', 'verified', 'tap-issued']
        .includes(request.state)) {
        return res.status(204).end();
      }
      await onboardingService.handlePresentationRetrieved(request.requestId);
      return res.status(204).end();
    }
    if (requestStatus === 'presentation_error') {
      if (['verified', 'tap-issued'].includes(request.state)) {
        return res.status(204).end();
      }
      await onboardingService.handlePresentationError(
        request.requestId,
        req.body.error?.code
      );
      return res.status(204).end();
    }

    const credentials = req.body.verifiedCredentialsData;
    if (!Array.isArray(credentials) || credentials.length !== 1) {
      await onboardingService.recordVerificationFailure(
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
      await onboardingService.recordVerificationFailure(
        request.requestId,
        'credential_validation'
      );
      console.warn(
        `[v2-presentation] Credential rejected; request=${request.requestId}`
      );
      return res.status(400).end();
    }

    if (request.state === 'credential-presented') {
      await onboardingService.markVerified(request.requestId, audit);
    } else if (!['verified', 'tap-issued'].includes(request.state)) {
      throw new onboardingService.V2StateError(
        'Presentation callback is not valid in this state.',
        'invalid_state'
      );
    }

    await onboardingService.issueTapOnce(request.requestId, async (current) => {
      await graphService.getEligiblePilotUser(current.employeeObjectId);
      const baselineMethods = await graphService.listFido2Methods(
        current.employeeObjectId
      );
      const tap = await graphService.createTemporaryAccessPass(
        current.employeeObjectId
      );
      return { tap, baselineMethods };
    });
    return res.status(204).end();
  } catch (err) {
    console.error(
      `[v2-presentation] Callback failed; code=${err.code || 'callback_error'}`
    );
    return res.status(err.status || 502).end();
  }
});

module.exports = router;
module.exports.callbackKeyMatches = callbackKeyMatches;
module.exports.toExpiryIso = toExpiryIso;
module.exports.loadBoundEmployeeRequest = loadBoundEmployeeRequest;
