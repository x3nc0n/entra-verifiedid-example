'use strict';

const config = require('../config');

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
    });
  }

  return { sendApprovalRequest };
}

function getDefaultProvider() {
  if (config.selfServiceV2.notification.provider === 'noop') {
    return new NoopManagerNotificationProvider();
  }
  throw new Error(
    `Unsupported V2_MANAGER_NOTIFICATION_PROVIDER: ` +
    `${config.selfServiceV2.notification.provider}`
  );
}

const defaultService = createManagerNotificationService(getDefaultProvider());

module.exports = {
  NoopManagerNotificationProvider,
  createManagerNotificationService,
  ...defaultService,
};
