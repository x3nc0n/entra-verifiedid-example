'use strict';

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

function stripOData(value) {
  if (Array.isArray(value)) return value.map(stripOData);
  if (!value || typeof value !== 'object') return value;

  var result = {};
  Object.keys(value).forEach(function (key) {
    if (!key.startsWith('@odata.')) result[key] = stripOData(value[key]);
  });
  return result;
}

function prepareCreationOptions(graphOptions) {
  var options = stripOData(graphOptions.publicKey || graphOptions);
  options.challenge = base64UrlToBuffer(options.challenge);
  options.user.id = base64UrlToBuffer(options.user.id);
  options.excludeCredentials = (options.excludeCredentials || []).map(function (credential) {
    return Object.assign({}, credential, { id: base64UrlToBuffer(credential.id) });
  });
  return options;
}

function credentialToJson(credential) {
  return {
    id: credential.id,
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(credential.response.clientDataJSON),
      attestationObject: bufferToBase64Url(credential.response.attestationObject),
    },
    clientExtensionResults: credential.getClientExtensionResults
      ? credential.getClientExtensionResults()
      : {},
  };
}

function isRpAllowedForCurrentOrigin(rpId) {
  var hostname = window.location.hostname.toLowerCase();
  var normalizedRpId = String(rpId || '').toLowerCase();
  return hostname === normalizedRpId || hostname.endsWith('.' + normalizedRpId);
}

async function registerPasskey() {
  var button = document.getElementById('registerPasskeyBtn');
  var error = document.getElementById('globalError');
  var displayName = document.getElementById('displayName').value.trim() ||
    'Onboarding passkey';
  error.classList.add('hidden');
  button.disabled = true;

  try {
    button.textContent = 'Requesting Microsoft Graph options...';
    var optionsResponse = await fetch('/passkey/register/options', {
      method: 'POST',
      credentials: 'same-origin',
    });
    var graphOptions = await optionsResponse.json();
    if (!optionsResponse.ok) {
      throw new Error(graphOptions.error || 'Graph creationOptions failed.');
    }

    var options = prepareCreationOptions(graphOptions);
    if (!isRpAllowedForCurrentOrigin(options.rp.id)) {
      throw new Error(
        'Microsoft Entra returned relying party "' + options.rp.id +
        '", which this site origin cannot use. Register at Microsoft Security info, then use Check registration.'
      );
    }

    button.textContent = 'Waiting for authenticator...';
    var credential = await navigator.credentials.create({ publicKey: options });
    if (!credential) throw new Error('Credential creation returned no result.');

    button.textContent = 'Submitting credential to Microsoft Graph...';
    var verifyResponse = await fetch('/passkey/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        displayName: displayName,
        publicKeyCredential: credentialToJson(credential),
      }),
    });
    var result = await verifyResponse.json();
    if (!verifyResponse.ok) throw new Error(result.error || 'Graph registration failed.');
    onPasskeyRegistered();
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Register using Graph options';
    error.textContent = err.message || 'Passkey registration failed.';
    error.classList.remove('hidden');
  }
}

async function confirmPasskey() {
  var button = document.getElementById('confirmPasskeyBtn');
  var error = document.getElementById('globalError');
  error.classList.add('hidden');
  button.disabled = true;
  button.textContent = 'Checking Microsoft Graph...';

  try {
    var response = await fetch('/passkey/register/confirm', {
      method: 'POST',
      credentials: 'same-origin',
    });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Passkey confirmation failed.');
    onPasskeyRegistered();
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Check registration';
    error.textContent = err.message || 'Passkey confirmation failed.';
    error.classList.remove('hidden');
  }
}

function onPasskeyRegistered() {
  document.getElementById('registrationStatus').innerHTML =
    '<span class="status-registered">&#10003; Tenant passkey confirmed</span>';
  document.getElementById('registerPasskeyBtn').disabled = true;
  document.getElementById('confirmPasskeyBtn').disabled = true;
  document.getElementById('completeSection').innerHTML =
    '<a href="/passkey/complete" class="btn btn-success btn-large">Complete Onboarding &rarr;</a>';
}
