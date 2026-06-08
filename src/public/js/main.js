'use strict';

// =============================================================================
// Entra Verified ID Onboarding Portal — Client-side utilities
// =============================================================================

// ── Base64URL utilities (for WebAuthn) ───────────────────────────────────────

/**
 * Decode a base64url string to an ArrayBuffer.
 * @param {string} base64url
 * @returns {ArrayBuffer}
 */
function base64UrlToBuffer(base64url) {
  var base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  var remainder = base64.length % 4;
  if (remainder === 2) base64 += '==';
  else if (remainder === 3) base64 += '=';
  var binary = atob(base64);
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/**
 * Encode an ArrayBuffer (or TypedArray) to a base64url string.
 * @param {ArrayBuffer|TypedArray} buffer
 * @returns {string}
 */
function bufferToBase64Url(buffer) {
  var bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
  var binary = '';
  for (var i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// ── WebAuthn helpers ─────────────────────────────────────────────────────────

/**
 * Convert a PublicKeyCredentialCreationOptionsJSON (from @simplewebauthn/server)
 * to a format acceptable by navigator.credentials.create().
 * The server sends base64url-encoded binary fields; WebAuthn expects ArrayBuffers.
 *
 * @param {object} options — JSON from /passkey/register/options
 * @returns {PublicKeyCredentialCreationOptions}
 */
function prepareCreationOptions(options) {
  var prepared = Object.assign({}, options);

  prepared.challenge = base64UrlToBuffer(options.challenge);

  prepared.user = Object.assign({}, options.user, {
    id: base64UrlToBuffer(options.user.id),
  });

  if (Array.isArray(options.excludeCredentials)) {
    prepared.excludeCredentials = options.excludeCredentials.map(function (cred) {
      return Object.assign({}, cred, { id: base64UrlToBuffer(cred.id) });
    });
  }

  if (options.pubKeyCredParams) {
    prepared.pubKeyCredParams = options.pubKeyCredParams;
  }

  return prepared;
}

/**
 * Convert a PublicKeyCredential (from navigator.credentials.create) to
 * a plain JSON object that @simplewebauthn/server can verify.
 *
 * @param {PublicKeyCredential} credential
 * @returns {RegistrationResponseJSON}
 */
function credentialToJson(credential) {
  var response = credential.response;
  var json = {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
    },
    clientExtensionResults: credential.getClientExtensionResults
      ? credential.getClientExtensionResults()
      : {},
  };
  if (typeof response.getTransports === 'function') {
    json.response.transports = response.getTransports();
  }
  return json;
}

// ── Passkey Registration ─────────────────────────────────────────────────────

/**
 * Run the full WebAuthn passkey registration ceremony.
 *
 * Steps:
 *  1. POST /passkey/register/options  → get PublicKeyCredentialCreationOptionsJSON
 *  2. navigator.credentials.create()  → browser prompt
 *  3. POST /passkey/register/verify   → server verifies and stores credential
 *  4. Call _onPasskeySuccess(type) if defined on the page
 *
 * @param {'platform'|'cross-platform'} type
 */
async function registerPasskey(type) {
  var btnId = type === 'platform' ? 'registerPlatformBtn' : 'registerCrossPlatformBtn';
  var btn = document.getElementById(btnId);
  var errorEl = document.getElementById('globalError');

  if (errorEl) errorEl.classList.add('hidden');

  if (!btn) {
    console.error('[passkey] Button not found for type: ' + type);
    return;
  }

  var originalText = btn.textContent;

  try {
    btn.disabled = true;
    btn.textContent = 'Requesting options…';

    // ── Step 1: Get registration options ──────────────────────────────────
    var optResp = await fetch('/passkey/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authenticatorType: type }),
      credentials: 'same-origin',
    });

    if (!optResp.ok) {
      var optErr = await optResp.json().catch(function () { return {}; });
      throw new Error(optErr.error || 'Failed to get registration options (HTTP ' + optResp.status + ').');
    }

    var options = await optResp.json();

    // ── Step 2: Call WebAuthn API ──────────────────────────────────────────
    btn.textContent = type === 'platform'
      ? 'Waiting for biometric prompt…'
      : 'Insert YubiKey and tap it…';

    var creationOptions = prepareCreationOptions(options);
    var credential = await navigator.credentials.create({ publicKey: creationOptions });

    if (!credential) {
      throw new Error('Credential creation was cancelled or returned null.');
    }

    btn.textContent = 'Verifying with server…';

    // ── Step 3: Verify with server ─────────────────────────────────────────
    var credJson = credentialToJson(credential);
    var verResp = await fetch('/passkey/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authenticatorType: type,
        registrationResponse: credJson,
      }),
      credentials: 'same-origin',
    });

    if (!verResp.ok) {
      var verErr = await verResp.json().catch(function () { return {}; });
      throw new Error(verErr.error || 'Server verification failed (HTTP ' + verResp.status + ').');
    }

    var result = await verResp.json();
    if (!result.verified) {
      throw new Error('The server could not verify the registration. Please try again.');
    }

    // ── Step 4: Notify the page ────────────────────────────────────────────
    if (typeof _onPasskeySuccess === 'function') {
      _onPasskeySuccess(type);
    }

  } catch (err) {
    // Restore button for retry
    btn.disabled = false;
    btn.textContent = originalText;

    var message = err.message || 'Registration failed. Please try again.';

    // DOMException from WebAuthn (user cancelled, not allowed, etc.)
    if (err.name === 'NotAllowedError') {
      message = 'Registration was cancelled or timed out. Please try again.';
    } else if (err.name === 'SecurityError') {
      message = 'Security error: ensure you are on the correct domain (' + window.location.hostname + ').';
    } else if (err.name === 'NotSupportedError') {
      message = 'This device or browser does not support passkeys.';
    }

    if (errorEl) {
      errorEl.textContent = message;
      errorEl.classList.remove('hidden');
      setTimeout(function () { errorEl.classList.add('hidden'); }, 10000);
    } else {
      alert('Passkey registration failed: ' + message);
    }

    console.error('[passkey] registerPasskey(' + type + ') error:', err);
  }
}

// ── Generic Status Poller ─────────────────────────────────────────────────────

/**
 * Poll a URL at a regular interval and call a callback on a terminal status.
 *
 * @param {object} opts
 * @param {string}   opts.url           — URL to GET on each tick
 * @param {number}   [opts.interval=3000] — milliseconds between polls
 * @param {number}   [opts.timeout=300000] — max ms before giving up (default 5 min)
 * @param {Function} opts.onSuccess     — called with response JSON when complete
 * @param {Function} [opts.onError]     — called with error message string
 * @param {Function} [opts.onTick]      — called with response JSON on every tick
 * @returns {{ stop: Function }} — object with a stop() method
 */
function pollStatus(opts) {
  var url = opts.url;
  var interval = opts.interval || 3000;
  var timeout = opts.timeout || 300000;
  var onSuccess = opts.onSuccess;
  var onError = opts.onError || null;
  var onTick = opts.onTick || null;

  var timer = null;
  var expired = false;

  var expireTimer = setTimeout(function () {
    expired = true;
    clearInterval(timer);
    if (onError) onError('Request timed out. Please refresh the page.');
  }, timeout);

  timer = setInterval(async function () {
    if (expired) return;
    try {
      var resp = await fetch(url, { credentials: 'same-origin' });
      if (!resp.ok) return;
      var data = await resp.json();

      if (onTick) onTick(data);

      if (data.error || data.status === 'error') {
        clearInterval(timer);
        clearTimeout(expireTimer);
        if (onError) onError(data.message || data.error || 'An error occurred.');
        return;
      }

      if (data.status === 'complete' || data.status === 'approved' || data.verified) {
        clearInterval(timer);
        clearTimeout(expireTimer);
        if (onSuccess) onSuccess(data);
      }
    } catch (_) {
      // Ignore transient network errors; keep polling
    }
  }, interval);

  return {
    stop: function () {
      clearInterval(timer);
      clearTimeout(expireTimer);
    },
  };
}

// ── QR Code Rendering ─────────────────────────────────────────────────────────

/**
 * Render a QR code into an element by appending an <img> that uses the
 * qrserver.com public API. No library dependency required.
 *
 * @param {string} elementId — DOM element ID to append the image into
 * @param {string} data       — text/URL to encode
 * @param {number} [size=256] — pixel size (square)
 */
function initQrCode(elementId, data, size) {
  var el = document.getElementById(elementId);
  if (!el) {
    console.warn('[qr] Element not found: ' + elementId);
    return;
  }
  var px = size || 256;
  var encoded = encodeURIComponent(data);
  var img = document.createElement('img');
  img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=' + px + 'x' + px + '&data=' + encoded;
  img.alt = 'QR Code';
  img.width = px;
  img.height = px;
  img.style.display = 'block';
  el.appendChild(img);
}

// ── Form helpers ──────────────────────────────────────────────────────────────

/**
 * Show an inline error on a form input.
 * @param {string} inputId
 * @param {string} message
 */
function showFieldError(inputId, message) {
  var input = document.getElementById(inputId);
  if (!input) return;
  input.classList.add('input-error');
  var existing = document.getElementById(inputId + '-error');
  if (!existing) {
    var err = document.createElement('p');
    err.id = inputId + '-error';
    err.className = 'form-hint form-hint-error';
    err.setAttribute('role', 'alert');
    err.textContent = message;
    input.insertAdjacentElement('afterend', err);
  } else {
    existing.textContent = message;
  }
}

/**
 * Clear any inline error on a form input.
 * @param {string} inputId
 */
function clearFieldError(inputId) {
  var input = document.getElementById(inputId);
  if (input) input.classList.remove('input-error');
  var err = document.getElementById(inputId + '-error');
  if (err) err.remove();
}

// ── Error display ─────────────────────────────────────────────────────────────

/**
 * Show a dismissible error banner.
 * @param {string} elementId — ID of the alert element
 * @param {string} message
 * @param {number} [autoHideMs] — optional auto-hide delay in ms
 */
function showError(elementId, message, autoHideMs) {
  var el = document.getElementById(elementId);
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
  if (autoHideMs) {
    setTimeout(function () { el.classList.add('hidden'); }, autoHideMs);
  }
}

/**
 * Hide an alert element.
 * @param {string} elementId
 */
function hideAlert(elementId) {
  var el = document.getElementById(elementId);
  if (el) el.classList.add('hidden');
}

// ── Step indicator ────────────────────────────────────────────────────────────

/**
 * Update a step indicator to mark steps done/active/pending.
 * @param {number} activeStep — 1-based index of the current active step
 */
function updateStepIndicator(activeStep) {
  var steps = document.querySelectorAll('.step-indicator .step');
  steps.forEach(function (el, idx) {
    el.classList.remove('active', 'done');
    var stepNum = idx + 1;
    if (stepNum < activeStep) el.classList.add('done');
    else if (stepNum === activeStep) el.classList.add('active');
  });
}

// ── DOMContentLoaded initialisation ──────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
  // Auto-submit spinner on forms with data-spinner-form attribute
  document.querySelectorAll('form[data-spinner-form]').forEach(function (form) {
    form.addEventListener('submit', function () {
      var btn = form.querySelector('[type="submit"]');
      if (!btn) return;
      btn.disabled = true;
      var textEl = btn.querySelector('.btn-text');
      var spinEl = btn.querySelector('.btn-spinner');
      if (textEl) textEl.textContent = 'Submitting…';
      if (spinEl) spinEl.classList.remove('hidden');
    });
  });

  // Dismiss alerts on click
  document.querySelectorAll('.alert[data-dismissible]').forEach(function (alert) {
    alert.style.cursor = 'pointer';
    alert.addEventListener('click', function () {
      alert.classList.add('hidden');
    });
  });
});
