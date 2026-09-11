'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const path = require('path');
const config = require('./config');

const v2OnboardingRouter = require('./routes/v2-onboarding');
const v2VerifiedIdRouter = require('./routes/v2-verified-id');
const v2ManagerRouter = require('./routes/v2-manager');
const v2PasskeyRouter = require('./routes/v2-passkey');
const v2RecoveryRouter = require('./routes/v2-recovery');
const verifiedIdService = require('./services/verified-id-service');
const { createSessionStore } = require('./services/table-session-store');
const { setV2SecurityHeaders } = require('./middleware/v2-security');

function isUnsafeSecret(value) {
  return !value ||
    value === 'insecure-dev-secret-change-me' ||
    value.startsWith('PLACEHOLDER--');
}

config.validateRuntimeConfiguration();

if (config.nodeEnv === 'production') {
  if (isUnsafeSecret(config.sessionSecret)) {
    throw new Error('SESSION_SECRET must be configured before production startup.');
  }
  verifiedIdService.assertV2Configuration();
}

const app = express();

app.set('trust proxy', 1);
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

morgan.token('safe-url', (req) =>
  req.path
);
const logFormat = config.nodeEnv === 'production'
  ? ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version" :status :res[content-length] ":user-agent"'
  : ':method :safe-url :status :response-time ms - :res[content-length]';
app.use(morgan(logFormat));
app.use(setV2SecurityHeaders);
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb', parameterLimit: 10 }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: config.sessionSecret,
    store: createSessionStore(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: config.nodeEnv === 'production',
      httpOnly: true,
      maxAge: 60 * 60 * 1000,
      sameSite: 'strict',
    },
  })
);

app.use((req, res, next) => {
  res.locals.demoMode = config.demoMode;
  res.locals.user = req.session.user || null;
  next();
});

app.use((req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = (view, options, callback) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    options = options || {};
    if (view === 'layout') {
      return originalRender(view, options, callback);
    }
    app.render(view, { ...res.locals, ...options }, (err, html) => {
      if (err) {
        if (callback) return callback(err);
        return next(err);
      }
      originalRender('layout', { ...options, body: html }, callback);
    });
  };
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.redirect('/v2/onboarding');
});
app.use('/', v2OnboardingRouter);
app.use('/', v2VerifiedIdRouter);
app.use('/', v2ManagerRouter);
app.use('/', v2PasskeyRouter);
app.use('/', v2RecoveryRouter);

app.use((req, res) => {
  res.status(404).render('status', {
    title: 'Page Not Found',
    heading: 'Page Not Found',
    message: 'The page you requested does not exist.',
    actionHref: '/v2/onboarding',
    actionLabel: 'Return to onboarding',
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[app] Unhandled error:', err);
  const status = err.status || err.statusCode || 500;
  const errorMessage = config.nodeEnv === 'production'
    ? 'An unexpected error occurred. Please try again.'
    : err.message;
  res.status(status).render('status', {
    title: 'Error',
    heading: 'Something went wrong',
    message: errorMessage,
    actionHref: '/v2/onboarding',
    actionLabel: 'Restart onboarding',
    error: {
      message: errorMessage,
      stack: config.nodeEnv !== 'production' ? err.stack : undefined,
    },
  });
});

const port = config.port;
if (require.main === module) {
  app.listen(port, () => {
    console.log(`
Entra Verified ID Onboarding Portal`);
    console.log(`   Listening on http://localhost:${port}`);
    console.log(`   Demo mode: ${config.demoMode ? 'ON' : 'OFF'}`);
    console.log(`   Environment: ${config.nodeEnv}
`);
  });
}

module.exports = app;
