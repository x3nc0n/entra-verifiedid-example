'use strict';

const crypto = require('crypto');
const config = require('../config');
const {
  createTableClient,
  isTableNotFound,
  isTableConflict,
} = require('./table-client');

class InvitationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'InvitationError';
    this.code = code;
  }
}

class InvitationConcurrencyError extends Error {
  constructor() {
    super('Invitation state changed concurrently.');
    this.name = 'InvitationConcurrencyError';
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEmployeeId(value) {
  return String(value || '').trim().toLowerCase();
}

function valuesMatch(actual, expectedHash, normalizer) {
  const actualHash = Buffer.from(hash(normalizer(actual)), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actualHash.length === expected.length &&
    crypto.timingSafeEqual(actualHash, expected);
}

function validateLifetime(lifetimeMinutes, entityLabel) {
  if (!Number.isInteger(lifetimeMinutes) ||
      lifetimeMinutes < 5 ||
      lifetimeMinutes > 1440) {
    throw new InvitationError(
      `${entityLabel} lifetime must be between 5 and 1440 minutes.`,
      'invalid_lifetime'
    );
  }
}

class InMemoryInvitationRepository {
  constructor() {
    this.records = new Map();
  }

  async create(record) {
    if (this.records.has(record.tokenHash)) {
      throw new InvitationConcurrencyError();
    }
    this.records.set(record.tokenHash, { ...record, version: 1 });
  }

  async get(tokenHash) {
    const record = this.records.get(tokenHash);
    if (!record) return null;
    const { version, ...value } = record;
    return { ...value, etag: String(version) };
  }

  async replace(record, etag) {
    const current = this.records.get(record.tokenHash);
    if (!current || String(current.version) !== String(etag)) {
      throw new InvitationConcurrencyError();
    }
    const { etag: ignoredEtag, ...storedRecord } = record;
    this.records.set(record.tokenHash, {
      ...storedRecord,
      version: current.version + 1,
    });
  }

  reset() {
    this.records.clear();
  }
}

class AzureTableInvitationRepository {
  constructor(options = {}) {
    this.client = options.client || null;
    this.tableName = options.tableName || config.storage.invitationTableName;
    this.partitionKey = options.partitionKey || 'invitation';
  }

  getClient() {
    if (!this.client) {
      this.client = createTableClient(this.tableName);
    }
    return this.client;
  }

  async create(record) {
    await this.getClient().createEntity({
      partitionKey: this.partitionKey,
      rowKey: record.tokenHash,
      ...record,
    });
  }

  async get(tokenHash) {
    try {
      const entity = await this.getClient().getEntity(this.partitionKey, tokenHash);
      const {
        etag,
        partitionKey,
        rowKey,
        timestamp,
        ...record
      } = entity;
      return { ...record, tokenHash: rowKey, etag };
    } catch (err) {
      if (isTableNotFound(err)) return null;
      throw err;
    }
  }

  async replace(record, etag) {
    try {
      const { etag: ignoredEtag, ...storedRecord } = record;
      await this.getClient().updateEntity(
        {
          partitionKey: this.partitionKey,
          rowKey: record.tokenHash,
          ...storedRecord,
        },
        'Replace',
        { etag }
      );
    } catch (err) {
      if (isTableConflict(err)) throw new InvitationConcurrencyError();
      throw err;
    }
  }
}

function createInvitationService(repository, options = {}) {
  const entityLabel = options.entityLabel || 'Invitation';

  async function replaceWithRetry(tokenHash, update) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await repository.get(tokenHash);
      const result = update(current);
      if (!result?.record) return result;
      try {
        await repository.replace(result.record, current.etag);
        return result;
      } catch (err) {
        if (!(err instanceof InvitationConcurrencyError)) throw err;
      }
    }
    throw new InvitationError(
      `${entityLabel} could not be updated safely. Please try again.`,
      'concurrency'
    );
  }

  async function createInvitation(input) {
    const lifetimeMinutes = input.lifetimeMinutes ||
      config.assurance.invitationLifetimeMinutes;
    validateLifetime(lifetimeMinutes, entityLabel);

    if (!input.entraUserId || !input.userPrincipalName ||
        !input.personalEmail || !input.employeeId) {
      throw new InvitationError(
        'Immutable Entra user ID, user principal name, personal email, and employee ID are required.',
        'invalid_input'
      );
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hash(token);
    const now = Date.now();
    const record = {
      tokenHash,
      entraUserId: input.entraUserId,
      userPrincipalName: input.userPrincipalName,
      displayName: input.displayName || input.userPrincipalName,
      personalEmailHash: hash(normalizeEmail(input.personalEmail)),
      employeeIdHash: hash(normalizeEmployeeId(input.employeeId)),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + lifetimeMinutes * 60 * 1000).toISOString(),
      status: 'active',
      failedAttempts: 0,
    };
    await repository.create(record);

    return {
      token,
      expiresAt: record.expiresAt,
      entraUserId: record.entraUserId,
      userPrincipalName: record.userPrincipalName,
    };
  }

  async function inspectInvitation(reference) {
    const record = await repository.get(String(reference || ''));
    if (!record) return { active: false, reason: 'not_found' };
    if (record.status !== 'active') {
      return { active: false, reason: record.status };
    }
    if (Date.now() >= Date.parse(record.expiresAt)) {
      await replaceWithRetry(record.tokenHash, (current) => {
        if (!current || current.status !== 'active') {
          return { active: false, reason: current?.status || 'not_found' };
        }
        return {
          active: false,
          reason: 'expired',
          record: { ...current, status: 'expired' },
        };
      });
      return { active: false, reason: 'expired' };
    }
    return { active: true, expiresAt: record.expiresAt };
  }

  async function activateInvitation(token) {
    const reference = hash(String(token || ''));
    const invitation = await inspectInvitation(reference);
    return { ...invitation, reference };
  }

  async function consumeInvitation(reference, evidence) {
    const result = await replaceWithRetry(String(reference || ''), (record) => {
      if (!record) {
        throw new InvitationError(`${entityLabel} is invalid or expired.`, 'not_found');
      }
      if (record.status !== 'active') {
        throw new InvitationError(
          `${entityLabel} has already been used or is no longer active.`,
          record.status
        );
      }
      if (Date.now() >= Date.parse(record.expiresAt)) {
        return {
          error: new InvitationError(`${entityLabel} has expired.`, 'expired'),
          record: { ...record, status: 'expired' },
        };
      }

      const emailMatches = valuesMatch(
        evidence.personalEmail,
        record.personalEmailHash,
        normalizeEmail
      );
      const employeeMatches = valuesMatch(
        evidence.employeeId,
        record.employeeIdHash,
        normalizeEmployeeId
      );

      if (!emailMatches || !employeeMatches) {
        const failedAttempts = record.failedAttempts + 1;
        return {
          error: new InvitationError(
            `${entityLabel} details do not match the approved record.`,
            'mismatch'
          ),
          record: {
            ...record,
            failedAttempts,
            status: failedAttempts >= config.assurance.invitationMaxAttempts
              ? 'locked'
              : 'active',
          },
        };
      }

      return {
        consumed: {
          entraUserId: record.entraUserId,
          userPrincipalName: record.userPrincipalName,
          displayName: record.displayName,
          employeeIdHash: record.employeeIdHash,
        },
        record: {
          ...record,
          status: 'consumed',
          consumedAt: new Date().toISOString(),
        },
      };
    });

    if (result.error) throw result.error;
    return result.consumed;
  }

  return {
    createInvitation,
    activateInvitation,
    inspectInvitation,
    consumeInvitation,
  };
}

const defaultRepository = config.storage.backend === 'azure-table'
  ? new AzureTableInvitationRepository()
  : new InMemoryInvitationRepository();
const defaultService = createInvitationService(defaultRepository);

module.exports = {
  InvitationError,
  InvitationConcurrencyError,
  InMemoryInvitationRepository,
  AzureTableInvitationRepository,
  createInvitationService,
  ...defaultService,
  resetForTests: () => defaultRepository.reset?.(),
};
