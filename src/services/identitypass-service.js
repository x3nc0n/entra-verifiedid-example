'use strict';

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

// ── Demo-mode approval state store ────────────────────────────────────────────
// In demo mode we auto-approve after a short delay. In production this would
// be driven by a real IdentityPass webhook/polling mechanism.
const _requestStore = new Map();

function _normalizeStatus(status) {
  const normalized = String(status || 'pending').toLowerCase();

  switch (normalized) {
    case 'approved':
    case 'verified':
    case 'verification.completed':
    case 'complete':
    case 'completed':
      return 'approved';
    case 'failed':
    case 'rejected':
    case 'denied':
    case 'verification.failed':
    case 'error':
      return 'failed';
    case 'pending_review':
    case 'verification.pending_review':
      return 'pending_review';
    default:
      return 'pending';
  }
}

function _isApprovedStatus(status) {
  return _normalizeStatus(status) === 'approved';
}

function _upsertRequest(requestId, values) {
  const existing = _requestStore.get(requestId) || { requestId };
  const next = {
    ...existing,
    ...values,
    requestId,
    updatedAt: new Date().toISOString(),
  };
  _requestStore.set(requestId, next);
  return next;
}

/**
 * Initiates an IdentityPass identity-proofing request.
 * Sends a notification to the manager for approval.
 *
 * @param {string} employeeId - The employee's identifier
 * @param {string} email - The employee's personal email
 * @param {string} managerEmail - Manager's email for approval notification
 * @returns {Promise<{requestId: string, status: string}>}
 */
async function initiateIdentityPass(employeeId, email, managerEmail) {
  const requestId = uuidv4();
  _upsertRequest(requestId, {
    status: 'pending',
    employeeId,
    email,
    managerEmail,
    createdAt: new Date().toISOString(),
  });

  if (config.demoMode) {
    console.log(`[identitypass] DEMO — created request ${requestId} for ${email}`);
    _upsertRequest(requestId, {
      status: 'pending',
      // Auto-approve after 15 seconds in demo mode
      autoApproveAt: Date.now() + 15_000,
      simulated: true,
    });
    return { requestId, status: 'pending' };
  }

  // Real IdentityPass API call
  const response = await axios.post(
    `${config.identityPass.apiEndpoint}/requests`,
    {
      requestId,
      employeeId,
      email,
      managerEmail,
      callbackUrl: `${config.appBaseUrl}/api/identitypass/callback`,
      purpose: 'Employee onboarding identity verification',
    },
    {
      headers: {
        'Ocp-Apim-Subscription-Key': config.identityPass.subscriptionKey,
        'Content-Type': 'application/json',
      },
    }
  );

  const providerRequestId = response.data.requestId || response.data.sessionId || requestId;
  if (providerRequestId !== requestId) {
    const record = _requestStore.get(requestId);
    _requestStore.delete(requestId);
    _requestStore.set(providerRequestId, {
      ...(record || {}),
      requestId: providerRequestId,
      providerRequestId,
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    requestId: providerRequestId,
    status: response.data.status || 'pending',
  };
}

/**
 * Checks the approval status of an IdentityPass request.
 *
 * @param {string} requestId - The IdentityPass request ID
 * @returns {Promise<{status: string, approved: boolean}>}
 */
async function checkApprovalStatus(requestId) {
  const record = _requestStore.get(requestId);

  if (config.demoMode) {
    if (!record) return { status: 'unknown', approved: false };

    // Auto-approve when the demo timer fires
    if (record.status === 'pending' && Date.now() >= record.autoApproveAt) {
      record.status = 'approved';
      record.simulated = true;
      _requestStore.set(requestId, record);
    }
    return {
      status: record.status,
      approved: _isApprovedStatus(record.status),
      simulated: true,
    };
  }

  if (record && _normalizeStatus(record.status) !== 'pending') {
    return {
      status: record.status,
      approved: _isApprovedStatus(record.status),
      simulated: false,
    };
  }

  const response = await axios.get(
    `${config.identityPass.apiEndpoint}/requests/${requestId}`,
    {
      headers: {
        'Ocp-Apim-Subscription-Key': config.identityPass.subscriptionKey,
      },
    }
  );

  const status = _normalizeStatus(response.data.status);
  _upsertRequest(requestId, {
    status,
    providerStatus: response.data.status || status,
    source: 'poll',
  });

  return { status, approved: _isApprovedStatus(status), simulated: false };
}

function handleCallback(payload) {
  const requestId = payload.requestId || payload.sessionId;
  if (!requestId) {
    return {
      accepted: false,
      message: 'Missing requestId or sessionId in IdentityPass callback.',
    };
  }

  const status = _normalizeStatus(payload.status || payload.event || payload.code);
  _upsertRequest(requestId, {
    status,
    source: 'webhook',
    providerStatus: payload.status || payload.event || payload.code || 'pending',
    verificationResult: payload.verificationResult || null,
    metadata: payload.metadata || null,
  });

  return {
    accepted: true,
    requestId,
    status,
  };
}

/**
 * Manually approves an IdentityPass request (demo mode only — for testing).
 * @param {string} requestId
 */
function demoApprove(requestId) {
  const record = _requestStore.get(requestId);
  if (record) {
    record.status = 'approved';
    record.simulated = true;
    _requestStore.set(requestId, record);
  }
}

module.exports = {
  initiateIdentityPass,
  checkApprovalStatus,
  handleCallback,
  demoApprove,
  defaultManagerEmail: config.identityPass.defaultManagerEmail,
};
