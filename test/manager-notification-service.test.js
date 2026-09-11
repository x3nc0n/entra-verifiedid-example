'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const {
  AcsEmailManagerNotificationProvider,
  createAcsEmailClient,
  createManagerNotificationService,
  getDefaultProvider,
} = require('../src/services/manager-notification-service');

function approvalInput() {
  return {
    requestId: '11111111-2222-3333-4444-555555555555',
    correlationId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    managerEmail: 'manager@tenant.example',
    approvalUrl:
      'https://portal.example/v2/manager/approval#token=opaque-token',
    employeeDisplayName: 'Example Employee',
  };
}

test('sends the ACS approval email to the Graph-resolved manager address', async () => {
  let sentMessage;
  const client = {
    async beginSend(message) {
      sentMessage = message;
      return {
        async pollUntilDone() {
          return { id: 'acs-operation-id', status: 'Succeeded' };
        },
      };
    },
  };
  const provider = new AcsEmailManagerNotificationProvider({
    client,
    senderAddress: 'onboarding@notifications.example',
  });
  const service = createManagerNotificationService(provider);

  const result = await service.sendApprovalRequest(approvalInput());

  assert.deepEqual(result, {
    accepted: true,
    provider: 'acs',
    operationId: 'acs-operation-id',
  });
  assert.equal(
    sentMessage.recipients.to[0].address,
    'manager@tenant.example'
  );
  assert.equal(
    sentMessage.senderAddress,
    'onboarding@notifications.example'
  );
  assert.match(sentMessage.content.plainText, /opaque-token/);
  assert.equal(sentMessage.disableUserEngagementTracking, true);
});

test('prefers the ACS endpoint and managed identity over a connection string', () => {
  const calls = [];
  class TestCredential {
    constructor(options) {
      this.options = options;
      calls.push(['credential', options]);
    }
  }
  class TestEmailClient {
    constructor(...args) {
      this.args = args;
      calls.push(['client', args]);
    }
  }

  const client = createAcsEmailClient(
    {
      endpoint: 'https://communication.example',
      connectionString: 'endpoint=https://fallback.example;accesskey=fallback',
    },
    {
      EmailClient: TestEmailClient,
      DefaultAzureCredential: TestCredential,
    }
  );

  assert.equal(client.args[0], 'https://communication.example');
  assert.ok(client.args[1] instanceof TestCredential);
  assert.equal(calls.filter(([kind]) => kind === 'credential').length, 1);
});

test('uses the ACS connection string only when no endpoint is configured', () => {
  class TestEmailClient {
    constructor(...args) {
      this.args = args;
    }
  }

  const client = createAcsEmailClient(
    {
      endpoint: '',
      connectionString:
        'endpoint=https://communication.example;accesskey=fallback',
    },
    { EmailClient: TestEmailClient }
  );

  assert.deepEqual(client.args, [
    'endpoint=https://communication.example;accesskey=fallback',
  ]);
});

test('fails closed when ACS returns a non-success terminal status', async () => {
  const provider = new AcsEmailManagerNotificationProvider({
    senderAddress: 'onboarding@notifications.example',
    client: {
      async beginSend() {
        return {
          async pollUntilDone() {
            return {
              id: 'acs-operation-id',
              status: 'Failed',
              error: { code: 'MailboxUnavailable' },
            };
          },
        };
      },
    },
  });

  const result = await provider.sendApprovalRequest({
    ...approvalInput(),
    recipient: approvalInput().managerEmail,
  });

  assert.deepEqual(result, {
    accepted: false,
    provider: 'acs',
    reasonCode: 'MailboxUnavailable',
  });
});

test('fails closed when the ACS client throws without logging recipient data', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (message) => logs.push(message);
  try {
    const provider = new AcsEmailManagerNotificationProvider({
      senderAddress: 'onboarding@notifications.example',
      client: {
        async beginSend() {
          const error = new Error('sensitive SDK details');
          error.code = 'AuthenticationFailed';
          throw error;
        },
      },
    });

    const result = await provider.sendApprovalRequest({
      ...approvalInput(),
      recipient: approvalInput().managerEmail,
    });

    assert.equal(result.accepted, false);
    assert.equal(result.reasonCode, 'AuthenticationFailed');
    assert.equal(logs.length, 1);
    assert.doesNotMatch(logs[0], /manager@tenant\.example/);
    assert.doesNotMatch(logs[0], /opaque-token/);
    assert.doesNotMatch(logs[0], /sensitive SDK details/);
  } finally {
    console.error = originalError;
  }
});

test('requires the ACS deployment contract when ACS is selected', () => {
  const original = {
    enabled: config.selfServiceV2.enabled,
    provider: config.selfServiceV2.notification.provider,
    acs: { ...config.selfServiceV2.notification.acs },
  };
  try {
    config.selfServiceV2.enabled = true;
    config.selfServiceV2.notification.provider = 'acs';
    Object.assign(config.selfServiceV2.notification.acs, {
      endpoint: '',
      connectionString: '',
      senderAddress: '',
    });
    assert.throws(
      () => config.validateRuntimeConfiguration(),
      /V2_ACS_EMAIL_SENDER_ADDRESS/
    );
    assert.throws(
      () => config.validateRuntimeConfiguration(),
      /V2_ACS_EMAIL_ENDPOINT or V2_ACS_EMAIL_CONNECTION_STRING/
    );
  } finally {
    config.selfServiceV2.enabled = original.enabled;
    config.selfServiceV2.notification.provider = original.provider;
    Object.assign(config.selfServiceV2.notification.acs, original.acs);
  }
});

test('selects ACS as a supported notification provider', () => {
  const original = config.selfServiceV2.notification.provider;
  try {
    config.selfServiceV2.notification.provider = 'acs';
    assert.ok(getDefaultProvider() instanceof AcsEmailManagerNotificationProvider);
  } finally {
    config.selfServiceV2.notification.provider = original;
  }
});

test('documents every v2 environment variable read by runtime configuration', () => {
  const root = path.join(__dirname, '..');
  const configSource = fs.readFileSync(
    path.join(root, 'src', 'config.js'),
    'utf8'
  );
  const envExample = fs.readFileSync(
    path.join(root, '.env.example'),
    'utf8'
  );
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const coreV2Variables = new Set([
    'APP_BASE_URL',
    'ASSURANCE_MODE',
    'AZURE_CLIENT_ID',
    'AZURE_STORAGE_TABLE_ENDPOINT',
    'AZURE_TENANT_ID',
    'DEMO_MODE',
    'ENTRA_SECURITY_INFO_URL',
    'NODE_ENV',
    'ONBOARDING_INVITATIONS_TABLE',
    'ONBOARDING_SESSIONS_TABLE',
    'ONBOARDING_STATE_BACKEND',
    'ONBOARDING_V2_REQUESTS_TABLE',
    'PILOT_GROUP_ID',
    'SELF_SERVICE_V2_ENABLED',
    'SESSION_SECRET',
    'TAP_LIFETIME_MINUTES',
    'VC_SERVICE_SCOPE',
  ]);
  const configuredVariables = [
    ...configSource.matchAll(/process\.env\.([A-Z0-9_]+)/g),
  ].map((match) => match[1]);
  const v2Variables = new Set(
    configuredVariables.filter((name) =>
      name.startsWith('V2_') || coreV2Variables.has(name)
    )
  );

  for (const variable of v2Variables) {
    assert.match(
      envExample,
      new RegExp(`^${variable}=`, 'm'),
      `${variable} is missing from .env.example`
    );
    assert.match(
      readme,
      new RegExp('`' + variable + '`'),
      `${variable} is missing from README.md`
    );
  }
});
