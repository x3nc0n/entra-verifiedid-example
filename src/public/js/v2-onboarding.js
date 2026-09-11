'use strict';

(function () {
  const form = document.getElementById('v2IntakeForm');
  if (!form) return;
  let csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  const intakePanel = document.getElementById('v2IntakePanel');
  const statusPanel = document.getElementById('v2StatusPanel');
  const statusMessage = document.getElementById('v2StatusMessage');
  const actionPanel = document.getElementById('v2ActionPanel');
  const credentialPanel = document.getElementById('v2CredentialPanel');

  function showCredential(title, result) {
    document.getElementById('v2CredentialTitle').textContent = title;
    const qrContainer = document.getElementById('v2QrContainer');
    qrContainer.replaceChildren();
    if (result.qrCode) {
      const image = document.createElement('img');
      image.src = result.qrCode.startsWith('data:')
        ? result.qrCode
        : `data:image/png;base64,${result.qrCode}`;
      image.alt = title;
      qrContainer.appendChild(image);
    }
    const deepLink = document.getElementById('v2DeepLink');
    deepLink.href = result.url;
    const pinPanel = document.getElementById('v2PinPanel');
    if (result.pin) {
      document.getElementById('v2PinValue').textContent = result.pin;
      pinPanel.classList.remove('hidden');
    } else {
      pinPanel.classList.add('hidden');
    }
    credentialPanel.classList.remove('hidden');
  }

  async function startVerifiedId(path, title) {
    const response = await fetch(path, {
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
    showCredential(title, body);
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
    const response = await fetch('/api/v2/onboarding/status', {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;
    const status = await response.json();
    const messages = {
      'await-manager-notification': 'The request is waiting for manager notification.',
      'await-manager-decision': 'The manager approval decision is pending.',
      'request-credential': 'Manager approval is complete. Request your Verified ID.',
      'present-credential': 'Credential issuance completed. Present it back to this portal.',
      verifying: 'The credential presentation is being verified.',
      'preparing-access-pass': 'Identity verified. Preparing the Temporary Access Pass.',
      'display-access-pass': 'Your one-time Temporary Access Pass is ready.',
      complete: 'Passkey registration is complete.',
      closed: 'This onboarding request is closed.',
      wait: 'The request is still processing.',
    };
    statusMessage.textContent = messages[status.nextAction] || messages.wait;
    if (status.nextAction === 'request-credential') {
      setAction('Request Verified ID', () =>
        startVerifiedId(
          '/api/v2/verified-id/issuance/requests',
          'Issue your Verified ID'
        )
      );
    } else if (status.nextAction === 'present-credential') {
      setAction('Present Verified ID', () =>
        startVerifiedId(
          '/api/v2/verified-id/presentation/requests',
          'Present your Verified ID'
        )
      );
    } else if (status.nextAction === 'display-access-pass') {
      window.location.assign('/v2/passkey');
      return;
    } else if (status.nextAction === 'complete') {
      window.location.assign('/v2/complete');
      return;
    } else {
      actionPanel.replaceChildren();
    }
    window.setTimeout(refreshStatus, 5000);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = {
      userPrincipalName: form.userPrincipalName.value,
      employeeId: form.employeeId.value,
    };
    const response = await fetch('/api/v2/onboarding/requests', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (result.csrfToken) csrfToken = result.csrfToken;
    if (response.status !== 202) {
      statusMessage.textContent = 'The request could not be submitted.';
    } else {
      statusMessage.textContent =
        'If the submitted details are eligible, the manager will receive an approval request.';
    }
    intakePanel.classList.add('hidden');
    statusPanel.classList.remove('hidden');
    window.setTimeout(refreshStatus, 1000);
  });

  refreshStatus().then(() => {
    if (statusMessage.textContent !== 'Checking your request...') {
      intakePanel.classList.add('hidden');
      statusPanel.classList.remove('hidden');
    }
  }).catch(() => {});
})();
