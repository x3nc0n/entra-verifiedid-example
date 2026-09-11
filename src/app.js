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
const invitationsRouter = require('./routes/invitations');
const verificationRouter = require('./routes/verification');
const passkeyRouter = require('./routes/passkey');
const v2OnboardingRouter = require('./routes/v2-onboarding');
const v2VerifiedIdRouter = require('./routes/v2-verified-id');
const v2ManagerRouter = require('./routes/v2-manager');
const v2PasskeyRouter = require('./routes/v2-passkey');
const verifiedIdService = require('./services/verified-id-service');
const { createSessionStore } = require('./services/table-session-store');
const {
  requireV2Enabled,
  setV2SecurityHeaders,
} = require('./middleware/v2-security');

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
  if (config.assurance.mode !== 'self-service-verified-id-v2' &&
      isUnsafeSecret(config.assurance.approvalApiKey)) {
    throw new Error(
      'ONBOARDING_APPROVAL_API_KEY must be configured before production startup.'
    );
  }
  if (config.assurance.mode === 'verified-id') {
    verifiedIdService.assertPresentationConfiguration();
  }
  if (config.selfServiceV2.enabled) {
    verifiedIdService.assertV2Configuration();
  }
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
  res.locals.onboardingState = req.session.onboardingState || null;
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/v2', requireV2Enabled, setV2SecurityHeaders);
app.use('/api/v2', requireV2Enabled, setV2SecurityHeaders);
app.use('/auth/manager', requireV2Enabled, setV2SecurityHeaders);
app.use('/', v2OnboardingRouter);
app.use('/', v2VerifiedIdRouter);
app.use('/', v2ManagerRouter);
app.use('/', v2PasskeyRouter);

app.get('/', (req, res, next) => {
  if (config.assurance.mode === 'self-service-verified-id-v2') {
    return res.redirect('/v2/onboarding');
  }
  return next();
});
app.use('/', indexRouter);
app.use('/onboarding', onboardingRouter);
app.use('/api/invitations', invitationsRouter);
app.use('/api/verification', verificationRouter);
app.use('/passkey', passkeyRouter);

app.use((req, res) => {
  res.status(404).render('index', {
    title: 'Page Not Found',
    error: { message: 'The page you requested does not exist.' },
  });
});

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

const port = config.port;
if (require.main === module) {
  app.listen(port, () => {
    console.log(`\nEntra Verified ID Onboarding Portal`);
    console.log(`   Listening on http://localhost:${port}`);
    console.log(`   Demo mode: ${config.demoMode ? 'ON' : 'OFF'}`);
    console.log(`   Environment: ${config.nodeEnv}\n`);
  });
}

module.exports = app;
