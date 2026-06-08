'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const path = require('path');
const config = require('./config');

const indexRouter = require('./routes/index');
const onboardingRouter = require('./routes/onboarding');
const issuanceRouter = require('./routes/issuance');
const verificationRouter = require('./routes/verification');
const passkeyRouter = require('./routes/passkey');

const app = express();

// ── Trust proxy — required for Azure App Service / reverse proxies ───────────
app.set('trust proxy', 1);

// ── View engine ───────────────────────────────────────────────────────────────
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// ── Request logging ───────────────────────────────────────────────────────────
app.use(morgan(config.nodeEnv === 'production' ? 'combined' : 'dev'));

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Session ───────────────────────────────────────────────────────────────────
app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: config.nodeEnv === 'production',
      httpOnly: true,
      maxAge: 60 * 60 * 1000, // 1 hour
      sameSite: 'lax',
    },
  })
);

// ── Template locals ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.locals.demoMode = config.demoMode;
  res.locals.user = req.session.user || null;
  res.locals.onboardingState = req.session.onboardingState || null;
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/', indexRouter);
app.use('/onboarding', onboardingRouter);
app.use('/api/issuance', issuanceRouter);
app.use('/api/verification', verificationRouter);
app.use('/passkey', passkeyRouter);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('index', {
    title: 'Page Not Found',
    error: { message: 'The page you requested does not exist.' },
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[app] Unhandled error:', err);
  const status = err.status || err.statusCode || 500;
  res.status(status).render('index', {
    title: 'Error',
    error: {
      message: config.nodeEnv === 'production'
        ? 'An unexpected error occurred. Please try again.'
        : err.message,
      stack: config.nodeEnv !== 'production' ? err.stack : undefined,
    },
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`\n🔒 Entra Verified ID Demo Portal`);
  console.log(`   Listening on http://localhost:${PORT}`);
  console.log(`   Demo mode: ${config.demoMode ? 'ON' : 'OFF'}`);
  console.log(`   Environment: ${config.nodeEnv}\n`);
});

module.exports = app;
