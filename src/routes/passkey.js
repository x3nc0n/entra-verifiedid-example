'use strict';

const express = require('express');
const config = require('../config');
const { ensureTapCreated } = require('../middleware/auth');
const graphService = require('../services/graph-service');

const router = express.Router();

function readClientData(publicKeyCredential) {
  const encoded = publicKeyCredential?.response?.clientDataJSON;
  if (!encoded) throw new Error('Missing WebAuthn clientDataJSON.');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

function findNewFido2Method(methods, existingMethodIds) {
  const baselineIds = new Set(existingMethodIds || []);
  return methods.find((method) => !baselineIds.has(method.id)) || null;
}

router.get('/', ensureTapCreated, (req, res) => {
  const state = req.session.onboardingState;
  return res.render('passkey', {
    title: 'Register Tenant Passkey',
    passkeyRegistered: state.passkeyRegistered || false,
    securityInfoUrl: config.graph.securityInfoUrl,
    assuranceMode: state.assuranceMode || config.assurance.mode,
  });
});

router.post('/register/options', ensureTapCreated, async (req, res) => {
  const state = req.session.onboardingState;
  const user = req.session.user;

  try {
    const options = await graphService.getFido2CreationOptions(
      state.entraUserId,
      user.userPrincipalName
    );
    state.passkeyChallenge = options.publicKey?.challenge;
    const graphExpiry = Date.parse(options.challengeTimeoutDateTime);
    state.passkeyChallengeExpiresAt = Number.isFinite(graphExpiry)
      ? new Date(graphExpiry).toISOString()
      : new Date(Date.now() + 5 * 60 * 1000).toISOString();
    return res.json(options);
  } catch (err) {
    console.error('[passkey] Graph creationOptions failed:', err.message);
    return res.status(502).json({
      error: 'Microsoft Graph could not create tenant passkey registration options.',
    });
  }
});

router.post('/register/verify', ensureTapCreated, async (req, res) => {
  const state = req.session.onboardingState;
  const { publicKeyCredential, displayName } = req.body;

  if (!publicKeyCredential) {
    return res.status(400).json({ error: 'Missing publicKeyCredential.' });
  }
  if (!state.passkeyChallenge || !state.passkeyChallengeExpiresAt) {
    return res.status(400).json({ error: 'Request Graph creation options first.' });
  }
  const challengeExpiry = Date.parse(state.passkeyChallengeExpiresAt);
  if (!Number.isFinite(challengeExpiry) || Date.now() >= challengeExpiry) {
    return res.status(400).json({ error: 'The Graph passkey challenge has expired.' });
  }

  try {
    const clientData = readClientData(publicKeyCredential);
    if (clientData.type !== 'webauthn.create' ||
        clientData.challenge !== state.passkeyChallenge) {
      return res.status(400).json({ error: 'The WebAuthn response does not match this session.' });
    }

    const graphResult = await graphService.registerFido2Key(
      state.entraUserId,
      publicKeyCredential,
      String(displayName || 'Onboarding passkey').slice(0, 64)
    );
    const methods = await graphService.listFido2Methods(state.entraUserId);
    const baselineIds = new Set(state.existingPasskeyMethodIds || []);
    if (baselineIds.has(graphResult.id) ||
        !methods.some((method) => method.id === graphResult.id)) {
      throw new Error('Graph did not return the created passkey in the user method list.');
    }

    delete state.passkeyChallenge;
    delete state.passkeyChallengeExpiresAt;
    state.passkeyRegistered = true;
    state.passkeyMethodId = graphResult.id;
    state.step = 'passkey';

    return res.json({ registered: true, methodId: graphResult.id });
  } catch (err) {
    console.error('[passkey] Graph FIDO2 registration failed:', err.message);
    return res.status(502).json({ error: 'Tenant passkey registration failed.' });
  }
});

router.post('/register/confirm', ensureTapCreated, async (req, res) => {
  const state = req.session.onboardingState;
  try {
    const methods = await graphService.listFido2Methods(state.entraUserId);
    const newMethod = findNewFido2Method(methods, state.existingPasskeyMethodIds);
    if (!newMethod) {
      return res.status(404).json({
        error: 'No new tenant passkey has been registered since this invitation was consumed.',
      });
    }
    state.passkeyRegistered = true;
    state.passkeyMethodId = newMethod.id;
    state.step = 'passkey';
    return res.json({ registered: true, methodId: newMethod.id });
  } catch (err) {
    console.error('[passkey] Graph FIDO2 confirmation failed:', err.message);
    return res.status(502).json({ error: 'Could not confirm the tenant passkey.' });
  }
});

router.get('/complete', ensureTapCreated, (req, res) => {
  const state = req.session.onboardingState;
  if (!state.passkeyRegistered) return res.redirect('/passkey');
  state.step = 'complete';
  state.completedAt = new Date().toISOString();
  return res.render('complete', {
    title: 'Onboarding Complete',
    user: req.session.user,
    verifiedSubject: state.verifiedSubject || {},
    assuranceMode: state.assuranceMode || config.assurance.mode,
  });
});

module.exports = router;
module.exports.readClientData = readClientData;
module.exports.findNewFido2Method = findNewFido2Method;
