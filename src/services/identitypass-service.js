'use strict';

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

// ── Demo-mode approval state store ────────────────────────────────────────────
// In demo mode we auto-approve after a short delay. In production this would
// be driven by a real IdentityPass webhook/polling mechanism.
const _demoStore = new Map();

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

  if (config.demoMode) {
    console.log(`[identitypass] DEMO — created request ${requestId} for ${email}`);
    _demoStore.set(requestId, {
      status: 'pending',
      employeeId,
      email,
      managerEmail,
      createdAt: Date.now(),
      // Auto-approve after 15 seconds in demo mode
      autoApproveAt: Date.now() + 15_000,
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

  return {
    requestId: response.data.requestId || requestId,
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
  if (config.demoMode) {
    const record = _demoStore.get(requestId);
    if (!record) return { status: 'unknown', approved: false };

    // Auto-approve when the demo timer fires
    if (record.status === 'pending' && Date.now() >= record.autoApproveAt) {
      record.status = 'approved';
      _demoStore.set(requestId, record);
    }
    return { status: record.status, approved: record.status === 'approved' };
  }

  const response = await axios.get(
    `${config.identityPass.apiEndpoint}/requests/${requestId}`,
    {
      headers: {
        'Ocp-Apim-Subscription-Key': config.identityPass.subscriptionKey,
      },
    }
  );

  const status = response.data.status || 'pending';
  return { status, approved: status === 'approved' };
}

/**
 * Manually approves an IdentityPass request (demo mode only — for testing).
 * @param {string} requestId
 */
function demoApprove(requestId) {
  const record = _demoStore.get(requestId);
  if (record) {
    record.status = 'approved';
    _demoStore.set(requestId, record);
  }
}

module.exports = {
  initiateIdentityPass,
  checkApprovalStatus,
  demoApprove,
  defaultManagerEmail: config.identityPass.defaultManagerEmail,
};
