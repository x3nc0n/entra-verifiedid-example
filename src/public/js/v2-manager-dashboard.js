'use strict';

(function () {
  const form = document.getElementById('managerDashboardForm');
  if (!form) return;
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  const status = document.getElementById('managerDashboardStatus');
  const resultPanel = document.getElementById('managerInviteResult');
  const resultUrl = document.getElementById('managerInviteUrl');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    status.textContent = 'Generating invitation...';
    resultPanel.classList.add('hidden');
    const response = await fetch('/api/v2/manager/invitations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ directReportId: form.directReportId.value }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      status.textContent = body.error || 'Invitation generation failed.';
      return;
    }
    status.textContent = 'Invitation generated.';
    resultUrl.textContent = body.inviteUrl;
    resultPanel.classList.remove('hidden');
  });
})();
