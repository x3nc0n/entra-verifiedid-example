'use strict';

(function () {
  const panel = document.getElementById('employeeInvitePanel');
  if (!panel) return;
  let csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  const activated = panel.dataset.activated === 'true';
  const activationStatus = document.getElementById('employeeInviteActivationStatus');
  const form = document.getElementById('employeeInviteForm');
  const status = document.getElementById('employeeInviteStatus');

  async function activateToken() {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get('token');
    if (!token) {
      if (activationStatus) activationStatus.textContent = 'This employee invitation link is missing a token.';
      return;
    }
    window.history.replaceState(null, '', window.location.pathname);
    const response = await fetch('/api/v2/onboarding/invitations/activate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ token }),
    });
    if (response.ok) {
      window.location.reload();
      return;
    }
    if (activationStatus) activationStatus.textContent = 'This employee invitation link is invalid or expired.';
  }

  if (!activated) {
    activateToken().catch(() => {
      if (activationStatus) activationStatus.textContent = 'The employee invitation link could not be validated.';
    });
    return;
  }

  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = 'Confirming employee identity...';
    const response = await fetch('/api/v2/onboarding/invitations/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({
        userPrincipalName: form.userPrincipalName.value,
        employeeId: form.employeeId.value,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      window.location.assign('/v2/onboarding');
      return;
    }
    status.textContent = body.error || 'Employee verification failed.';
  });
})();
