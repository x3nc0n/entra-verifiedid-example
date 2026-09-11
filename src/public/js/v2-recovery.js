'use strict';

(function () {
  const form = document.getElementById('v2RecoveryForm');
  if (!form) return;
  let csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  const intakePanel = document.getElementById('v2RecoveryIntakePanel');
  const statusPanel = document.getElementById('v2RecoveryStatusPanel');
  const statusMessage = document.getElementById('v2RecoveryStatusMessage');
  const actionPanel = document.getElementById('v2RecoveryActionPanel');
  const credentialPanel = document.getElementById('v2RecoveryCredentialPanel');

  function showCredential(result) {
    const qrContainer = document.getElementById('v2RecoveryQrContainer');
    qrContainer.replaceChildren();
    if (result.qrCode) {
      const image = document.createElement('img');
      image.src = result.qrCode.startsWith('data:') ? result.qrCode : `data:image/png;base64,${result.qrCode}`;
      image.alt = 'Present your Verified ID';
      qrContainer.appendChild(image);
    }
    document.getElementById('v2RecoveryDeepLink').href = result.url;
    credentialPanel.classList.remove('hidden');
  }

  async function requestPresentation() {
    const response = await fetch('/api/v2/recovery/verified-id/presentation/requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: '{}',
    });
    const body = await response.json();
    if (!response.ok) {
      statusMessage.textContent = body.error;
      return;
    }
    statusMessage.textContent = 'Present your existing Verified ID in Microsoft Authenticator.';
    showCredential(body);
    actionPanel.replaceChildren();
  }

  function setAction(label, handler) {
    actionPanel.replaceChildren();
    const button = document.createElement('button');
    button.className = 'btn btn-primary';
    button.textContent = label;
    button.addEventListener('click', handler);
    actionPanel.appendChild(button);
  }

  async function refreshStatus() {
    const response = await fetch('/api/v2/recovery/status', {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;
    const status = await response.json();
    const messages = {
      'present-credential': 'Confirm the recovery request by presenting your existing Verified ID.',
      verifying: 'The presented credential is being verified.',
      'preparing-access-pass': 'Identity verified. Revoking existing passkeys and preparing a replacement access pass.',
      'display-access-pass': 'Your one-time recovery Temporary Access Pass is ready.',
      complete: 'Recovery is complete.',
      closed: 'This recovery request is closed.',
      wait: 'The recovery request is still processing.',
    };
    statusMessage.textContent = messages[status.nextAction] || messages.wait;
    if (status.nextAction === 'present-credential') {
      setAction('Present Verified ID', requestPresentation);
    } else if (status.nextAction === 'display-access-pass') {
      window.location.assign('/v2/recovery/passkey');
      return;
    } else if (status.nextAction === 'complete') {
      window.location.assign('/v2/recovery/complete');
      return;
    } else {
      actionPanel.replaceChildren();
    }
    window.setTimeout(refreshStatus, 5000);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const response = await fetch('/api/v2/recovery/requests', {
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
    if (body.csrfToken) csrfToken = body.csrfToken;
    statusMessage.textContent = body.message || 'If eligible, continue with recovery in this browser.';
    intakePanel.classList.add('hidden');
    statusPanel.classList.remove('hidden');
    window.setTimeout(refreshStatus, 1000);
  });

  refreshStatus().then(() => {
    if (statusMessage.textContent !== 'Checking your recovery request...') {
      intakePanel.classList.add('hidden');
      statusPanel.classList.remove('hidden');
    }
  }).catch(() => {});
})();
