'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const identityPassService = require('../services/identitypass-service');

const router = express.Router();

function getSignatureHeader(req) {
  return req.get('x-identitypass-signature') ||
    req.get('x-signature') ||
    req.get('x-hub-signature-256') ||
    req.get('x-signature-hmac-sha256') ||
    '';
}

function getCandidateSignatures(rawBody, secret) {
  const hexDigest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const base64Digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

  return [
    hexDigest,
    `sha256=${hexDigest}`,
    base64Digest,
    `sha256=${base64Digest}`,
  ];
}

function signaturesMatch(receivedSignature, candidateSignatures) {
  const signatureBuffer = Buffer.from(receivedSignature, 'utf8');

  return candidateSignatures.some((candidate) => {
    const candidateBuffer = Buffer.from(candidate, 'utf8');
    return signatureBuffer.length === candidateBuffer.length &&
      crypto.timingSafeEqual(signatureBuffer, candidateBuffer);
  });
}

router.post(
  '/callback',
  express.raw({ type: () => true, limit: '1mb' }),
  (req, res) => {
    if (!config.identityPass.webhookSecret) {
      console.error('[identitypass] Missing IDENTITYPASS_WEBHOOK_SECRET; refusing callback');
      return res.status(503).json({ error: 'IdentityPass webhook secret is not configured.' });
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    const receivedSignature = getSignatureHeader(req).trim();

    if (!receivedSignature) {
      return res.status(401).json({ error: 'Missing IdentityPass webhook signature.' });
    }

    const candidateSignatures = getCandidateSignatures(rawBody, config.identityPass.webhookSecret);
    if (!signaturesMatch(receivedSignature, candidateSignatures)) {
      return res.status(401).json({ error: 'Invalid IdentityPass webhook signature.' });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      return res.status(400).json({ error: 'IdentityPass webhook body must be valid JSON.' });
    }

    const result = identityPassService.handleCallback(payload);
    if (!result.accepted) {
      return res.status(400).json({ error: result.message });
    }

    res.status(200).json({
      result: 'accepted',
      requestId: result.requestId,
      status: result.status,
    });
  }
);

module.exports = router;
