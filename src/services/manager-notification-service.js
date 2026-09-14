'use strict';

const { EmailClient } = require('@azure/communication-email');
const { DefaultAzureCredential } = require('@azure/identity');
const config = require('../config');

function normalizeLogCode(value, fallback) {
  const code = String(value || fallback)
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 100);
  return code || fallback;
}

function singleLineText(value, fallback) {
  const text = String(value || fallback)
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 200);
  return text || fallback;
}

class NoopManagerNotificationProvider {
  async sendApprovalRequest(message) {
    console.warn(
      `[v2-notification] Manager notification is not configured; ` +
      `request=${message.requestId} correlation=${message.correlationId}`
    );
    return {
      accepted: false,
      provider: 'noop',
      reasonCode: 'notification_provider_not_configured',
    };
  }
}

function createAcsEmailClient(
  settings = config.selfServiceV2.notification.acs,
  dependencies = {}
) {
  const EmailClientClass = dependencies.EmailClient || EmailClient;
  const CredentialClass =
    dependencies.DefaultAzureCredential || DefaultAzureCredential;
  if (settings.endpoint) {
    const credential = new CredentialClass({
      managedIdentityClientId: config.azure.clientId || undefined,
    });
    return new EmailClientClass(settings.endpoint, credential);
  }
  return new EmailClientClass(settings.connectionString);
}

class AcsEmailManagerNotificationProvider {
  constructor(options = {}) {
    this.senderAddress = options.senderAddress ||
      config.selfServiceV2.notification.acs.senderAddress;
    this.client = options.client || null;
    this.clientFactory = options.clientFactory || createAcsEmailClient;
  }

  getClient() {
    if (!this.client) this.client = this.clientFactory();
    return this.client;
  }

  buildMessage(message) {
    const employeeDisplayName = singleLineText(
      message.employeeDisplayName,
      'an employee'
    );
    const isRecovery = message.requestKind === 'recovery';
    return {
      senderAddress: this.senderAddress,
      content: {
        subject: isRecovery
          ? 'Action required: approve employee account recovery'
          : 'Action required: approve employee onboarding',
        plainText:
          `A self-service ${isRecovery ? 'account recovery' : 'onboarding'} ` +
          `request for ${employeeDisplayName} ` +
          `requires your approval.\n\n` +
          `Open this one-time approval link:\n${message.approvalUrl}\n\n` +
          `Sign in with your tenant manager account. Do not forward this link. ` +
          `If you did not expect this request, do not approve it.`,
      },
      recipients: {
        to: [{ address: message.recipient }],
      },
      disableUserEngagementTracking: true,
    };
  }

  async sendApprovalRequest(message) {
    try {
      const poller = await this.getClient().beginSend(
        this.buildMessage(message)
      );
      const result = await poller.pollUntilDone();
      if (result.status !== 'Succeeded') {
        const reasonCode = normalizeLogCode(
          result.error?.code || result.status,
          'acs_send_failed'
        );
        console.error(
          `[v2-notification] ACS send failed; ` +
          `request=${message.requestId} correlation=${message.correlationId} ` +
          `code=${reasonCode}`
        );
        return {
          accepted: false,
          provider: 'acs',
          reasonCode,
        };
      }
      console.info(
        `[v2-notification] ACS accepted manager notification; ` +
        `request=${message.requestId} correlation=${message.correlationId} ` +
        `operation=${result.id}`
      );
      return {
        accepted: true,
        provider: 'acs',
        operationId: result.id,
      };
    } catch (err) {
      const reasonCode = normalizeLogCode(err.code, 'acs_send_error');
      console.error(
        `[v2-notification] ACS send failed; ` +
        `request=${message.requestId} correlation=${message.correlationId} ` +
        `code=${reasonCode}`
      );
      return {
        accepted: false,
        provider: 'acs',
        reasonCode,
      };
    }
  }
}

function createManagerNotificationService(provider) {
  const selectedProvider = provider || new NoopManagerNotificationProvider();

  async function sendApprovalRequest(input) {
    if (!input.managerEmail) {
      return {
        accepted: false,
        provider: 'none',
        reasonCode: 'manager_email_missing',
      };
    }
    return selectedProvider.sendApprovalRequest({
      requestId: input.requestId,
      correlationId: input.correlationId,
      recipient: input.managerEmail,
      approvalUrl: input.approvalUrl,
      employeeDisplayName: input.employeeDisplayName,
      requestKind: input.requestKind,
    });
  }

  return { sendApprovalRequest };
}

function getDefaultProvider() {
  if (config.selfServiceV2.notification.provider === 'noop') {
    return new NoopManagerNotificationProvider();
  }
  if (config.selfServiceV2.notification.provider === 'acs') {
    return new AcsEmailManagerNotificationProvider();
  }
  throw new Error(
    `Unsupported V2_MANAGER_NOTIFICATION_PROVIDER: ` +
    `${config.selfServiceV2.notification.provider}`
  );
}

const defaultService = createManagerNotificationService(getDefaultProvider());

module.exports = {
  AcsEmailManagerNotificationProvider,
  NoopManagerNotificationProvider,
  createAcsEmailClient,
  createManagerNotificationService,
  getDefaultProvider,
  ...defaultService,
};
