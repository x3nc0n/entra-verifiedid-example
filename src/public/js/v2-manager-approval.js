'use strict';

(function () {
  const panel = document.getElementById('managerApprovalPanel');
  if (!panel) return;
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

  async function activateToken() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get('token');
    if (!token) return;
    window.history.replaceState(null, '', window.location.pathname);
    const response = await fetch('/api/v2/manager-approvals/activate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ token }),
    });
    if (response.ok) {
      window.location.replace('/auth/manager/signin');
      return;
    }
    document.getElementById('managerActivationStatus').textContent =
      'This manager approval link is invalid or expired.';
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
