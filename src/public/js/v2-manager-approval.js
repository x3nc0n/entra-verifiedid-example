'use strict';

(function () {
  const panel = document.getElementById('managerApprovalPanel');
  if (!panel) return;
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

  async function activateToken() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get('token');
    const status = document.getElementById('managerActivationStatus');
    if (!token) {
      if (status) {
        status.textContent =
          'No approval link was provided. Use your original approval email for a pending request, or open the Manager Dashboard to start an invitation.';
      }
      return;
    }
    window.history.replaceState(null, '', window.location.pathname);
    if (!status) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch('/api/v2/manager-approvals/activate', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ token }),
      });
    } catch (err) {
      status.textContent = err.name === 'AbortError'
        ? 'Approval link validation timed out. Reload this page to check whether activation completed. Do not submit the link again automatically.'
        : 'Approval link validation could not connect. Check your connection and reload this page to check whether activation completed.';
      return;
    } finally {
      clearTimeout(timeout);
    }
    if (response.ok) {
      window.location.replace('/auth/manager/signin');
      return;
    }
    status.textContent = response.status === 410
      ? 'This manager approval link is invalid, expired, or already used.'
      : 'The manager approval link could not be validated. Reload this page to check your session before trying again.';
  }

  async function decide(decision) {
    const requestId = panel.dataset.requestId;
    const status = document.getElementById('managerDecisionStatus');
    const response = await fetch(
      `/api/v2/manager-approvals/${encodeURIComponent(requestId)}/decision`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ decision }),
      }
    );
    const body = await response.json();
    status.textContent = response.ok
      ? `The request was ${body.decision}d.`
      : body.error;
    document.getElementById('managerApprove')?.setAttribute('disabled', '');
    document.getElementById('managerReject')?.setAttribute('disabled', '');
  }

  document.getElementById('managerApprove')
    ?.addEventListener('click', () => decide('approve'));
  document.getElementById('managerReject')
    ?.addEventListener('click', () => decide('reject'));

  activateToken().catch(() => {
    const status = document.getElementById('managerActivationStatus');
    if (status) status.textContent = 'The manager approval link could not be validated.';
  });
})();
