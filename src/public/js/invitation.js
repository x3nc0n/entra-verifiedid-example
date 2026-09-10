'use strict';

(function exposeInvitationActivation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InvitationActivation = api;
})(typeof window !== 'undefined' ? window : null, function buildApi() {
  function extractInvitationToken(fragment) {
    const value = String(fragment || '').replace(/^#/, '');
    if (!value) return '';
    return new URLSearchParams(value).get('token') || '';
  }

  async function activateFromCurrentFragment(options = {}) {
    const location = options.location || window.location;
    const history = options.history || window.history;
    const fetchImpl = options.fetch || window.fetch.bind(window);
    const basePath = options.basePath || '/onboarding';
    const token = extractInvitationToken(location.hash);

    history.replaceState(null, '', `${location.pathname}${location.search}`);
    if (!token) return { activated: false, reason: 'missing' };

    const response = await fetchImpl(`${basePath}/invite/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Invitation activation failed.');
    }

    location.replace(`${basePath}/invite`);
    return { activated: true };
  }

  return {
    extractInvitationToken,
    activateFromCurrentFragment,
  };
});
