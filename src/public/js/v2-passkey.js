'use strict';

(function () {
  const button = document.getElementById('v2ConfirmPasskey');
  if (!button) return;
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  const status = document.getElementById('v2PasskeyStatus');

  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = 'Checking Microsoft Graph for a new passkey...';
    const response = await fetch('/api/v2/passkey/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: '{}',
    });
    const body = await response.json();
    if (response.ok) {
      window.location.assign('/v2/complete');
      return;
    }
    status.textContent = body.error;
    button.disabled = false;
  });
})();
