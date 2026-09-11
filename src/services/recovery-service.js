'use strict';

// Account recovery reuses the invitation engine (token issuance, tamper-safe
// concurrency control, evidence matching) instead of re-implementing it.
// Recovery requests are stored in the same underlying table as onboarding
// invitations but under a distinct partition key, so no additional Azure
// infrastructure is required to support this second use case.

const config = require('../config');
const {
  InvitationError: RecoveryError,
  InvitationConcurrencyError: RecoveryConcurrencyError,
  InMemoryInvitationRepository,
  AzureTableInvitationRepository,
  createInvitationService,
} = require('./invitation-service');

const defaultRepository = config.storage.backend === 'azure-table'
  ? new AzureTableInvitationRepository({
      tableName: config.storage.invitationTableName,
      partitionKey: 'recovery',
    })
  : new InMemoryInvitationRepository();

const defaultService = createInvitationService(defaultRepository, {
  entityLabel: 'Recovery request',
});

module.exports = {
  RecoveryError,
  RecoveryConcurrencyError,
  InMemoryInvitationRepository,
  AzureTableInvitationRepository,
  createInvitationService,
  ...defaultService,
  resetForTests: () => defaultRepository.reset?.(),
};
