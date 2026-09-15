'use strict';

(function () {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
  const lookupForm = document.getElementById('adminLookupForm');
  const lookupStatus = document.getElementById('adminLookupStatus');
  const resultsRoot = document.getElementById('adminLookupResults');

  if (!lookupForm || !lookupStatus || !resultsRoot) return;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      '\'': '&#39;',
    }[character]));
  }

  function requestCardMarkup(request) {
    const employeeLabel = request.employeeDisplayName || request.employeeUserPrincipalName || 'Employee';
    return `
      <section class="card mt-md" data-request-kind="${escapeHtml(request.requestKind)}" data-request-id="${escapeHtml(request.requestId)}">
        <h2 class="card-section-title">${escapeHtml(employeeLabel)}</h2>
        <p><strong>Request kind:</strong> ${escapeHtml(request.requestKind)}</p>
        <p><strong>State:</strong> <span data-field="state">${escapeHtml(request.state)}</span></p>
        <p><strong>Request ID:</strong> <code>${escapeHtml(request.requestId)}</code></p>
        <p><strong>Current ETag:</strong> <code data-field="etag">${escapeHtml(request.etag)}</code></p>
        <p><strong>Updated:</strong> <span data-field="updatedAt">${escapeHtml(request.updatedAt || request.createdAt || 'Unknown')}</span></p>
        ${request.notificationStatus ? `<p><strong>Notification status:</strong> ${escapeHtml(request.notificationStatus)}</p>` : ''}
        <form class="admin-reset-form mt-md">
          <div class="form-group">
            <label class="form-label" for="action-${escapeHtml(request.requestKind)}-${escapeHtml(request.requestId)}">Reset action</label>
            <select
              id="action-${escapeHtml(request.requestKind)}-${escapeHtml(request.requestId)}"
              name="action"
              class="form-input"
              required
            >
              <option value="cancel">Cancel and release lock</option>
              <option value="restart">Restart request state</option>
              <option value="unblock">Unblock request state</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="reason-${escapeHtml(request.requestKind)}-${escapeHtml(request.requestId)}">Reason</label>
            <textarea
              id="reason-${escapeHtml(request.requestKind)}-${escapeHtml(request.requestId)}"
              name="reason"
              class="form-input"
              rows="3"
              minlength="8"
              required
              placeholder="Explain why this reset is needed."
            ></textarea>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Apply reset</button>
          </div>
          <p class="mt-sm" data-field="resetStatus" aria-live="polite"></p>
        </form>
      </section>
    `;
  }

  function renderLookupResults(payload) {
    const employeeName = payload.employee?.displayName || payload.employee?.userPrincipalName || 'Employee';
    if (!payload.requests?.length) {
      resultsRoot.innerHTML = `
        <section class="card">
          <h2 class="card-section-title">${escapeHtml(employeeName)}</h2>
          <p>No onboarding or recovery requests were found for this employee.</p>
        </section>
      `;
      resultsRoot.classList.remove('hidden');
      return;
    }

    resultsRoot.innerHTML = `
      <section class="card">
        <h2 class="card-section-title">Lookup results for ${escapeHtml(employeeName)}</h2>
        <p>${payload.employee?.userPrincipalName
          ? `Resolved user: <strong>${escapeHtml(payload.employee.userPrincipalName)}</strong>`
          : 'Resolved user found.'}
        </p>
      </section>
      ${payload.requests.map(requestCardMarkup).join('')}
    `;
    resultsRoot.classList.remove('hidden');
  }

  async function runLookup() {
    const upn = lookupForm.elements.namedItem('upn')?.value?.trim() || '';
    const employeeId =
      lookupForm.elements.namedItem('employeeId')?.value?.trim() || '';
    if ((upn && employeeId) || (!upn && !employeeId)) {
      lookupStatus.textContent = 'Enter either an employee UPN or an employee ID.';
      resultsRoot.classList.add('hidden');
      resultsRoot.innerHTML = '';
      return;
    }

    lookupStatus.textContent = 'Looking up requests...';
    resultsRoot.classList.add('hidden');
    resultsRoot.innerHTML = '';
    const params = new URLSearchParams();
    if (upn) params.set('upn', upn);
    if (employeeId) params.set('employeeId', employeeId);

    const response = await fetch(`/api/v2/admin/requests/lookup?${params.toString()}`);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      lookupStatus.textContent = body.error || 'Lookup failed.';
      return;
    }

    lookupStatus.textContent = body.requests?.length
      ? 'Lookup complete.'
      : 'Lookup complete. No requests found.';
    renderLookupResults(body);
  }

  lookupForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await runLookup();
  });

  resultsRoot.addEventListener('submit', async (event) => {
    const form = event.target.closest('.admin-reset-form');
    if (!form) return;
    event.preventDefault();

    const requestCard = form.closest('[data-request-kind][data-request-id]');
    const resetStatus = form.querySelector('[data-field="resetStatus"]');
    const requestKind = requestCard?.dataset.requestKind;
    const requestId = requestCard?.dataset.requestId;
    const etag = requestCard?.querySelector('[data-field="etag"]')?.textContent?.trim();
    const action = form.elements.namedItem('action')?.value;
    const reason = form.elements.namedItem('reason')?.value;
    if (!requestKind || !requestId || !etag) {
      resetStatus.textContent = 'The current ETag is missing. Run the lookup again.';
      return;
    }

    resetStatus.textContent = 'Applying reset...';
    const response = await fetch(
      `/api/v2/admin/requests/${encodeURIComponent(requestKind)}/${encodeURIComponent(requestId)}/reset`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken,
          'if-match': etag,
        },
        body: JSON.stringify({
          action,
          reason,
        }),
      }
    );
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      resetStatus.textContent = body.error || 'Reset failed.';
      return;
    }

    resetStatus.textContent = 'Reset applied. Refreshing request state...';
    await runLookup();
  });
})();
