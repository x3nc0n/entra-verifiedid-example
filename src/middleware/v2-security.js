'use strict';

const crypto = require('crypto');
const { timingSafeTextEqual } = require('../services/v2-crypto-service');

function setV2SecurityHeaders(req, res, next) {
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.set('Referrer-Policy', 'no-referrer');
  res.set(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
    "base-uri 'none'; form-action 'self'"
  );
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  next();
}

function getCsrfToken(req, namespace = 'employee') {
  req.session.v2Csrf = req.session.v2Csrf || {};
  if (!req.session.v2Csrf[namespace]) {
    req.session.v2Csrf[namespace] = crypto.randomBytes(32).toString('base64url');
  }
  return req.session.v2Csrf[namespace];
}

function requireCsrf(namespace = 'employee') {
  return (req, res, next) => {
    const expected = req.session.v2Csrf?.[namespace];
    const received = req.get('x-csrf-token') || req.body?._csrf;
    if (!expected || !timingSafeTextEqual(received, expected)) {
      return res.status(403).json({ error: 'The request could not be validated.' });
    }
    next();
  };
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => err ? reject(err) : resolve());
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((err) => err ? reject(err) : resolve());
  });
}

module.exports = {
  setV2SecurityHeaders,
  getCsrfToken,
  requireCsrf,
  regenerateSession,
  destroySession,
};
