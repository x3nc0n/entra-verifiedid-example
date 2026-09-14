'use strict';

const { v4: uuidv4 } = require('uuid');
const config = require('../config');
const {
  createTableClient,
  isTableNotFound,
  isTableConflict,
} = require('./table-client');
const {
  digestIdentifier,
  normalizeIdentifier,
  protectSecret,
  randomOpaqueToken,
  sha256,
  timingSafeHashEqual,
  timingSafeTextEqual,
  unprotectSecret,
} = require('./v2-crypto-service');

const REQUEST_PARTITION = 'request';
const LOCK_PARTITION = 'employee-lock';
const RATE_PARTITION = 'rate-limit';
const AUDIT_PARTITION = 'audit';
const DASHBOARD_AUTH_PARTITION = 'manager-dashboard-auth';
const TERMINAL_STATES = new Set([
  'manager-rejected',
  'admin-cancelled',
  'complete',
  'expired',
  'locked',
]);

class V2StateError extends Error {
  constructor(message, code, status = 409) {
    super(message);
    this.name = 'V2StateError';
    this.code = code;
    this.status = status;
  }
}

class V2ConcurrencyError extends Error {
  constructor() {
    super('The onboarding request changed concurrently.');
    this.name = 'V2ConcurrencyError';
    this.code = 'concurrency';
  }
}

function withoutMetadata(entity) {
  const {
    etag,
    partitionKey,
    rowKey,
    timestamp,
    ...record
  } = entity;
  return { ...record, requestId: rowKey, etag };
}

function sanitizeEntity(entity) {
  return Object.fromEntries(
    Object.entries(entity).filter(([, value]) => value !== undefined && value !== null)
  );
}

function escapeOData(value) {
  return String(value).replace(/'/g, "''");
}

class InMemoryV2Repository {
  constructor() {
    this.requests = new Map();
    this.employeeLocks = new Map();
    this.rateLimits = new Map();
    this.dashboardAuthTransactions = new Map();
    this.auditEvents = [];
  }

  async createRequest(record) {
    const lockKey = normalizeIdentifier(record.employeeObjectId);
    const currentLock = this.employeeLocks.get(lockKey);
    if (currentLock && Date.now() < Date.parse(currentLock.expiresAt)) {
      throw new V2StateError(
        'An active onboarding request already exists for this employee.',
        'active_request_exists'
      );
    }
    this.employeeLocks.set(lockKey, {
      requestId: record.requestId,
      expiresAt: record.expiresAt,
    });
    this.requests.set(record.requestId, { ...record, version: 1 });
  }

  async getRequest(requestId) {
    const record = this.requests.get(requestId);
    if (!record) return null;
    const { version, ...value } = record;
    return { ...value, etag: String(version) };
  }

  async replaceRequest(record, etag) {
    const current = this.requests.get(record.requestId);
    if (!current || String(current.version) !== String(etag)) {
      throw new V2ConcurrencyError();
    }
    const { etag: ignoredEtag, ...stored } = record;
    this.requests.set(record.requestId, {
      ...stored,
      version: current.version + 1,
    });
    if (TERMINAL_STATES.has(record.state)) {
      const lockKey = normalizeIdentifier(record.employeeObjectId);
      const lock = this.employeeLocks.get(lockKey);
      if (lock?.requestId === record.requestId) {
        this.employeeLocks.delete(lockKey);
      }
    }
  }

  async findByManagerTokenHash(tokenHash) {
    return [...this.requests.values()]
      .map(({ version, ...record }) => ({ ...record, etag: String(version) }))
      .find((record) =>
        record.managerTokenHash === tokenHash ||
        record.skipManagerTokenHash === tokenHash
      ) || null;
  }

  async findByManagerAuthState(state) {
    return [...this.requests.values()]
      .map(({ version, ...record }) => ({ ...record, etag: String(version) }))
      .find((record) => record.managerAuthState === state) || null;
  }

  async findByEmployeeInviteTokenHash(tokenHash) {
    return [...this.requests.values()]
      .map(({ version, ...record }) => ({ ...record, etag: String(version) }))
      .find((record) => record.employeeInviteTokenHash === tokenHash) || null;
  }

  async findByIssuanceCorrelation(requestId, state) {
    return [...this.requests.values()]
      .map(({ version, ...record }) => ({ ...record, etag: String(version) }))
      .find((record) =>
        record.issuanceRequestId === requestId &&
        record.issuanceState === state
      ) || null;
  }

  async findByPresentationCorrelation(requestId, state) {
    return [...this.requests.values()]
      .map(({ version, ...record }) => ({ ...record, etag: String(version) }))
      .find((record) =>
        record.presentationRequestId === requestId &&
        record.presentationState === state
      ) || null;
  }

  async createDashboardAuthTransaction(record) {
    this.dashboardAuthTransactions.set(record.state, { ...record, version: 1 });
  }

  async getDashboardAuthTransaction(state) {
    const record = this.dashboardAuthTransactions.get(state);
    if (!record) return null;
    const { version, ...value } = record;
    return { ...value, etag: String(version) };
  }

  async deleteDashboardAuthTransaction(state) {
    this.dashboardAuthTransactions.delete(state);
  }

  async findRequestsForApprover(approverObjectId) {
    const normalized = normalizeIdentifier(approverObjectId);
    return [...this.requests.values()]
      .map(({ version, ...record }) => ({ ...record, etag: String(version) }))
      .filter((record) => !TERMINAL_STATES.has(record.state))
      .filter((record) =>
        normalizeIdentifier(record.managerObjectId) === normalized ||
        normalizeIdentifier(record.skipManagerObjectId) === normalized
      );
  }

  async incrementRateLimit(key, limit, expiresAt) {
    const current = this.rateLimits.get(key);
    if (!current || Date.now() >= Date.parse(current.expiresAt)) {
      this.rateLimits.set(key, { count: 1, expiresAt });
      return { allowed: true, count: 1 };
    }
    current.count += 1;
    return { allowed: current.count <= limit, count: current.count };
  }

  async writeAudit(event) {
    this.auditEvents.push({ ...event });
  }

  reset() {
    this.requests.clear();
    this.employeeLocks.clear();
    this.rateLimits.clear();
    this.dashboardAuthTransactions.clear();
    this.auditEvents.length = 0;
  }
}

class AzureTableV2Repository {
  constructor(options = {}) {
    this.client = options.client || null;
  }

  getClient() {
    if (!this.client) {
      this.client = createTableClient(config.storage.v2RequestTableName);
    }
    return this.client;
  }

  async createRequest(record) {
    const client = this.getClient();
    const lockRowKey = sha256(normalizeIdentifier(record.employeeObjectId));
    const lock = {
      partitionKey: LOCK_PARTITION,
      rowKey: lockRowKey,
      requestId: record.requestId,
      expiresAt: record.expiresAt,
    };

    try {
      await client.createEntity(lock);
    } catch (err) {
      if (!isTableConflict(err)) throw err;
      const current = await client.getEntity(LOCK_PARTITION, lockRowKey);
      if (Date.now() < Date.parse(current.expiresAt)) {
        throw new V2StateError(
          'An active onboarding request already exists for this employee.',
          'active_request_exists'
        );
      }
      try {
        await client.updateEntity(lock, 'Replace', { etag: current.etag });
      } catch (updateError) {
        if (isTableConflict(updateError)) throw new V2ConcurrencyError();
        throw updateError;
      }
    }

    try {
      await client.createEntity(sanitizeEntity({
        partitionKey: REQUEST_PARTITION,
        rowKey: record.requestId,
        ...record,
      }));
    } catch (err) {
      await client.deleteEntity(LOCK_PARTITION, lockRowKey, { etag: '*' })
        .catch(() => {});
      throw err;
    }
  }

  async getRequest(requestId) {
    try {
      return withoutMetadata(
        await this.getClient().getEntity(REQUEST_PARTITION, requestId)
      );
    } catch (err) {
      if (isTableNotFound(err)) return null;
      throw err;
    }
  }

  async replaceRequest(record, etag) {
    try {
      const { etag: ignoredEtag, ...stored } = record;
      await this.getClient().updateEntity(
        sanitizeEntity({
          partitionKey: REQUEST_PARTITION,
          rowKey: record.requestId,
          ...stored,
        }),
        'Replace',
        { etag }
      );
    } catch (err) {
      if (isTableConflict(err)) throw new V2ConcurrencyError();
      throw err;
    }

    if (TERMINAL_STATES.has(record.state)) {
      const rowKey = sha256(normalizeIdentifier(record.employeeObjectId));
      try {
        const lock = await this.getClient().getEntity(LOCK_PARTITION, rowKey);
        if (lock.requestId === record.requestId) {
          await this.getClient().deleteEntity(
            LOCK_PARTITION,
            rowKey,
            { etag: lock.etag }
          );
        }
      } catch (err) {
        if (!isTableNotFound(err) && !isTableConflict(err)) throw err;
      }
    }
  }

  async findOne(filter) {
    const entities = this.getClient().listEntities({
      queryOptions: { filter },
    });
    for await (const entity of entities) return withoutMetadata(entity);
    return null;
  }

  findByManagerTokenHash(tokenHash) {
    return this.findOne(
      `PartitionKey eq '${REQUEST_PARTITION}' and ` +
      `(managerTokenHash eq '${escapeOData(tokenHash)}' or ` +
      `skipManagerTokenHash eq '${escapeOData(tokenHash)}')`
    );
  }

  findByManagerAuthState(state) {
    return this.findOne(
      `PartitionKey eq '${REQUEST_PARTITION}' and managerAuthState eq '${escapeOData(state)}'`
    );
  }

  findByEmployeeInviteTokenHash(tokenHash) {
    return this.findOne(
      `PartitionKey eq '${REQUEST_PARTITION}' and employeeInviteTokenHash eq '${escapeOData(tokenHash)}'`
    );
  }

  findByIssuanceCorrelation(requestId, state) {
    return this.findOne(
      `PartitionKey eq '${REQUEST_PARTITION}' and issuanceRequestId eq '${escapeOData(requestId)}' and issuanceState eq '${escapeOData(state)}'`
    );
  }

  findByPresentationCorrelation(requestId, state) {
    return this.findOne(
      `PartitionKey eq '${REQUEST_PARTITION}' and presentationRequestId eq '${escapeOData(requestId)}' and presentationState eq '${escapeOData(state)}'`
    );
  }

  async createDashboardAuthTransaction(record) {
    await this.getClient().createEntity(sanitizeEntity({
      partitionKey: DASHBOARD_AUTH_PARTITION,
      rowKey: record.state,
      ...record,
    }));
  }

  async getDashboardAuthTransaction(state) {
    try {
      return withoutMetadata(
        await this.getClient().getEntity(DASHBOARD_AUTH_PARTITION, state)
      );
    } catch (err) {
      if (isTableNotFound(err)) return null;
      throw err;
    }
  }

  async deleteDashboardAuthTransaction(state) {
    await this.getClient().deleteEntity(
      DASHBOARD_AUTH_PARTITION,
      state,
      { etag: '*' }
    ).catch((err) => {
      if (!isTableNotFound(err)) throw err;
    });
  }

  async findRequestsForApprover(approverObjectId) {
    const escaped = escapeOData(approverObjectId);
    const seen = new Set();
    const results = [];
    for (const field of ['managerObjectId', 'skipManagerObjectId']) {
      const entities = this.getClient().listEntities({
        queryOptions: {
          filter:
            `PartitionKey eq '${REQUEST_PARTITION}' and ${field} eq '${escaped}'`,
        },
      });
      // eslint-disable-next-line no-await-in-loop
      for await (const entity of entities) {
        const record = withoutMetadata(entity);
        if (!seen.has(record.requestId) && !TERMINAL_STATES.has(record.state)) {
          seen.add(record.requestId);
          results.push(record);
        }
      }
    }
    return results;
  }

  async incrementRateLimit(key, limit, expiresAt) {
    const client = this.getClient();
    const rowKey = sha256(key);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const current = await client.getEntity(RATE_PARTITION, rowKey);
        const expired = Date.now() >= Date.parse(current.expiresAt);
        const count = expired ? 1 : current.count + 1;
        await client.updateEntity(
          {
            partitionKey: RATE_PARTITION,
            rowKey,
            count,
            expiresAt: expired ? expiresAt : current.expiresAt,
          },
          'Replace',
          { etag: current.etag }
        );
        return { allowed: count <= limit, count };
      } catch (err) {
        if (isTableNotFound(err)) {
          try {
            await client.createEntity({
              partitionKey: RATE_PARTITION,
              rowKey,
              count: 1,
              expiresAt,
            });
            return { allowed: true, count: 1 };
          } catch (createError) {
            if (!isTableConflict(createError)) throw createError;
          }
        } else if (!isTableConflict(err)) {
          throw err;
        }
      }
    }
    throw new V2ConcurrencyError();
  }

  async writeAudit(event) {
    await this.getClient().createEntity(sanitizeEntity({
      partitionKey: AUDIT_PARTITION,
      rowKey: uuidv4(),
      occurredAt: new Date().toISOString(),
      ...event,
    }));
  }
}

function createOnboardingV2Service(repository) {
  async function loadRequest(requestId) {
    const request = await repository.getRequest(requestId);
    if (!request) {
      throw new V2StateError('Onboarding request was not found.', 'not_found', 404);
    }
    if (!TERMINAL_STATES.has(request.state) &&
        Date.now() >= Date.parse(request.expiresAt)) {
      return updateRequest(requestId, null, (current) => ({
        ...current,
        state: 'expired',
        expiredAt: new Date().toISOString(),
      }));
    }
    return request;
  }

  async function updateRequest(requestId, allowedStates, update) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const current = await repository.getRequest(requestId);
      if (!current) {
        throw new V2StateError('Onboarding request was not found.', 'not_found', 404);
      }
      if (allowedStates && !allowedStates.includes(current.state)) {
        throw new V2StateError(
          `Onboarding request cannot transition from ${current.state}.`,
          'invalid_state'
        );
      }
      const next = update({ ...current });
      if (!next) return current;
      try {
        await repository.replaceRequest(next, current.etag);
        if (next.state !== current.state) {
          await repository.writeAudit({
            requestId,
            correlationId: next.correlationId,
            eventType: 'state_transition',
            outcome: next.state,
            fromState: current.state,
          }).catch((err) => {
            console.error(
              `[v2-state] Audit write failed; request=${requestId} ` +
              `code=${err.code || 'storage_error'}`
            );
          });
        }
        return { ...next, etag: undefined };
      } catch (err) {
        if (!(err instanceof V2ConcurrencyError)) throw err;
      }
    }
    throw new V2ConcurrencyError();
  }

  async function enforceRateLimit(
    scope,
    value,
    limit,
    now = Date.now(),
    windowMs = 24 * 60 * 60 * 1000
  ) {
    const bucketStart = Math.floor(now / windowMs) * windowMs;
    const bucket = new Date(bucketStart).toISOString();
    const key = `${scope}:${digestIdentifier(value)}:${bucket}`;
    const expiresAt = new Date(bucketStart + windowMs * 2).toISOString();
    return repository.incrementRateLimit(key, limit, expiresAt);
  }

  async function createRequest(input) {
    const now = Date.now();
    const requestId = uuidv4();
    const managerToken = randomOpaqueToken();
    const expiresAt = new Date(
      now + config.selfServiceV2.requestLifetimeMinutes * 60 * 1000
    ).toISOString();
    const tokenExpiresAt = new Date(
      Math.min(
        Date.parse(expiresAt),
        now + config.selfServiceV2.managerTokenLifetimeMinutes * 60 * 1000
      )
    ).toISOString();
    const record = {
      requestId,
      correlationId: uuidv4(),
      initiationMode: 'employee-self-service',
      tenantId: input.tenantId,
      employeeObjectId: input.employee.id,
      employeeUserPrincipalName: input.employee.userPrincipalName,
      employeeDisplayName: input.employee.displayName ||
        input.employee.userPrincipalName,
      employeeIdHash: input.employeeIdHash,
      managerObjectId: input.manager.id,
      skipManagerObjectId: undefined,
      escalationStatus: 'none',
      state: 'requested',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt,
      managerTokenHash: sha256(managerToken),
      managerTokenStatus: 'active',
      managerTokenCreatedAt: new Date(now).toISOString(),
      managerTokenExpiresAt: tokenExpiresAt,
      managerTokenAttemptCount: 0,
      issuanceRetryCount: 0,
      presentationRetryCount: 0,
      verificationFailureCount: 0,
    };
    await repository.createRequest(record);
    await repository.writeAudit({
      requestId,
      correlationId: record.correlationId,
      eventType: 'request_created',
      outcome: 'success',
    });
    return { record, managerToken };
  }

  async function createManagerInitiatedRequest(input) {
    const now = Date.now();
    const requestId = uuidv4();
    const employeeInviteToken = randomOpaqueToken();
    const expiresAt = new Date(
      now + config.selfServiceV2.requestLifetimeMinutes * 60 * 1000
    ).toISOString();
    const tokenExpiresAt = new Date(
      Math.min(
        Date.parse(expiresAt),
        now + config.selfServiceV2.managerTokenLifetimeMinutes * 60 * 1000
      )
    ).toISOString();
    const record = {
      requestId,
      correlationId: uuidv4(),
      initiationMode: 'manager-initiated',
      tenantId: input.tenantId,
      employeeObjectId: input.employee.id,
      employeeUserPrincipalName: input.employee.userPrincipalName,
      employeeDisplayName: input.employee.displayName ||
        input.employee.userPrincipalName,
      employeeIdHash: input.employeeIdHash,
      managerObjectId: input.manager.id,
      state: 'employee-invited',
      managerDecision: 'approve',
      managerDecisionAt: new Date(now).toISOString(),
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt,
      employeeInviteTokenHash: sha256(employeeInviteToken),
      employeeInviteTokenStatus: 'active',
      employeeInviteTokenCreatedAt: new Date(now).toISOString(),
      employeeInviteTokenExpiresAt: tokenExpiresAt,
      employeeInviteTokenAttemptCount: 0,
      issuanceRetryCount: 0,
      presentationRetryCount: 0,
      verificationFailureCount: 0,
    };
    await repository.createRequest(record);
    await repository.writeAudit({
      requestId,
      correlationId: record.correlationId,
      eventType: 'request_created',
      outcome: 'manager_initiated',
    });
    return { record, employeeInviteToken };
  }

  async function markManagerNotified(requestId, provider) {
    return updateRequest(requestId, ['requested'], (current) => ({
      ...current,
      state: 'manager-notified',
      notificationProvider: provider,
      managerNotifiedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }

  async function markNotificationFailed(requestId, reasonCode) {
    const updated = await updateRequest(requestId, ['requested'], (current) => ({
      ...current,
      notificationStatus: 'failed',
      notificationFailureCode: reasonCode,
      updatedAt: new Date().toISOString(),
    }));
    await repository.writeAudit({
      requestId,
      correlationId: updated.correlationId,
      eventType: 'manager_notification',
      outcome: reasonCode,
    });
    return updated;
  }

  async function activateManagerToken(token) {
    const tokenHash = sha256(token);
    const request = await repository.findByManagerTokenHash(tokenHash);
    if (!request ||
        request.state !== 'manager-notified' ||
        request.managerTokenStatus !== 'active' ||
        Date.now() >= Date.parse(request.managerTokenExpiresAt) ||
        !timingSafeHashEqual(tokenHash, request.managerTokenHash)) {
      throw new V2StateError(
        'The manager approval link is invalid or expired.',
        'invalid_manager_token',
        410
      );
    }
    return {
      requestId: request.requestId,
      tokenHash,
      expiresAt: new Date(
        Date.now() + config.selfServiceV2.managerPreAuthLifetimeMinutes * 60 * 1000
      ).toISOString(),
    };
  }

  async function activateEmployeeInviteToken(token) {
    const tokenHash = sha256(token);
    const request = await repository.findByEmployeeInviteTokenHash(tokenHash);
    if (!request ||
        request.state !== 'employee-invited' ||
        request.employeeInviteTokenStatus !== 'active' ||
        Date.now() >= Date.parse(request.employeeInviteTokenExpiresAt) ||
        !timingSafeHashEqual(tokenHash, request.employeeInviteTokenHash)) {
      throw new V2StateError(
        'The employee invite link is invalid or expired.',
        'invalid_employee_invite_token',
        410
      );
    }
    return {
      requestId: request.requestId,
      tokenHash,
      employeeObjectId: request.employeeObjectId,
      expiresAt: new Date(
        Math.min(
          Date.parse(request.expiresAt),
          Date.now() + config.selfServiceV2.managerPreAuthLifetimeMinutes * 60 * 1000
        )
      ).toISOString(),
    };
  }

  async function redeemManagerToken(input) {
    return updateRequest(input.requestId, ['manager-notified'], (current) => {
      const normalizedApprover = normalizeIdentifier(input.managerObjectId);
      const eligibleApprover =
        timingSafeTextEqual(
          normalizedApprover,
          normalizeIdentifier(current.managerObjectId)
        ) ||
        timingSafeTextEqual(
          normalizedApprover,
          normalizeIdentifier(current.skipManagerObjectId)
        );
      if (current.managerTokenStatus !== 'active' ||
          Date.now() >= Date.parse(current.managerTokenExpiresAt) ||
          (
            !timingSafeHashEqual(input.tokenHash, current.managerTokenHash) &&
            !timingSafeHashEqual(input.tokenHash, current.skipManagerTokenHash)
          ) ||
          !eligibleApprover ||
          !timingSafeTextEqual(
            normalizeIdentifier(input.tenantId),
            normalizeIdentifier(current.tenantId)
          )) {
        throw new V2StateError(
          'The signed-in manager is not authorized for this request.',
          'manager_not_authorized',
          403
        );
      }
      return {
        ...current,
        managerTokenStatus: 'redeemed',
        managerTokenRedeemedAt: new Date().toISOString(),
        managerTokenAttemptCount: current.managerTokenAttemptCount + 1,
        lastManagerAuthFailureCode: undefined,
        lastManagerAuthFailureAt: undefined,
        managerAuthState: undefined,
        managerAuthTokenHash: undefined,
        managerAuthNonceProtected: undefined,
        managerAuthVerifierProtected: undefined,
        managerAuthExpiresAt: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function beginManagerSignIn(requestId, tokenHash, authorization) {
    return updateRequest(requestId, ['manager-notified'], (current) => {
      if (current.managerTokenStatus !== 'active' ||
          (
            !timingSafeHashEqual(tokenHash, current.managerTokenHash) &&
            !timingSafeHashEqual(tokenHash, current.skipManagerTokenHash)
          )) {
        throw new V2StateError(
          'The manager approval token is no longer active.',
          'invalid_manager_token',
          410
        );
      }

      return {
        ...current,
        managerAuthState: authorization.state,
        managerAuthTokenHash: tokenHash,
        managerAuthNonceProtected: protectSecret(authorization.nonce),
        managerAuthVerifierProtected: protectSecret(authorization.codeVerifier),
        managerAuthExpiresAt: authorization.expiresAt,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function createDashboardAuthTransaction(authorization, purpose = 'dashboard') {
    const record = {
      state: authorization.state,
      purpose,
      nonceProtected: protectSecret(authorization.nonce),
      verifierProtected: protectSecret(authorization.codeVerifier),
      createdAt: new Date().toISOString(),
      expiresAt: authorization.expiresAt,
    };
    await repository.createDashboardAuthTransaction(record);
    return record;
  }

  async function loadDashboardAuthTransaction(state, purpose = 'dashboard') {
    const record = await repository.getDashboardAuthTransaction(state);
    if (!record ||
        record.purpose !== purpose ||
        Date.now() >= Date.parse(record.expiresAt)) {
      throw new V2StateError(
        'The manager sign-in transaction is invalid or expired.',
        'manager_auth_expired',
        400
      );
    }
    return {
      state: record.state,
      nonce: unprotectSecret(record.nonceProtected),
      codeVerifier: unprotectSecret(record.verifierProtected),
      expiresAt: record.expiresAt,
    };
  }

  async function deleteDashboardAuthTransaction(state) {
    await repository.deleteDashboardAuthTransaction(state);
  }

  async function loadManagerAuthFlow(state) {
    const request = await repository.findByManagerAuthState(state);
    if (!request ||
        request.state !== 'manager-notified' ||
        request.managerTokenStatus !== 'active' ||
        Date.now() >= Date.parse(request.managerAuthExpiresAt)) {
      throw new V2StateError(
        'The manager sign-in transaction is invalid or expired.',
        'manager_auth_expired',
        400
      );
    }
    return {
      request,
      nonce: unprotectSecret(request.managerAuthNonceProtected),
      codeVerifier: unprotectSecret(request.managerAuthVerifierProtected),
    };
  }

  async function recordManagerRedemptionFailure(requestId, code) {
    const updated = await updateRequest(requestId, ['manager-notified'], (current) => ({
      ...current,
      managerTokenAttemptCount: current.managerTokenAttemptCount + 1,
      lastManagerAuthFailureCode: code,
      lastManagerAuthFailureAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    await repository.writeAudit({
      requestId,
      correlationId: updated.correlationId,
      eventType: 'manager_authentication',
      outcome: code,
    });
    return updated;
  }

  async function recordEmployeeInviteFailure(requestId, tokenHash, code) {
    const updated = await updateRequest(requestId, ['employee-invited'], (current) => {
      if (current.employeeInviteTokenStatus !== 'active' ||
          Date.now() >= Date.parse(current.employeeInviteTokenExpiresAt) ||
          !timingSafeHashEqual(tokenHash, current.employeeInviteTokenHash)) {
        throw new V2StateError(
          'The employee invite link is invalid or expired.',
          'invalid_employee_invite_token',
          410
        );
      }
      const attempts = (current.employeeInviteTokenAttemptCount || 0) + 1;
      return {
        ...current,
        state: attempts >= config.selfServiceV2.maxEmployeeInviteConfirmAttempts
          ? 'locked'
          : 'employee-invited',
        employeeInviteTokenAttemptCount: attempts,
        lastEmployeeInviteFailureCode: code,
        lastEmployeeInviteFailureAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    await repository.writeAudit({
      requestId,
      correlationId: updated.correlationId,
      eventType: 'employee_invite_confirmation',
      outcome: code,
    });
    return updated;
  }

  async function confirmEmployeeInvite(input) {
    return updateRequest(input.requestId, ['employee-invited'], (current) => {
      if (current.employeeInviteTokenStatus !== 'active' ||
          Date.now() >= Date.parse(current.employeeInviteTokenExpiresAt) ||
          !timingSafeHashEqual(input.tokenHash, current.employeeInviteTokenHash) ||
          !timingSafeTextEqual(
            normalizeIdentifier(input.employeeObjectId),
            normalizeIdentifier(current.employeeObjectId)
          ) ||
          !timingSafeTextEqual(
            normalizeIdentifier(input.userPrincipalName),
            normalizeIdentifier(current.employeeUserPrincipalName)
          ) ||
          !timingSafeHashEqual(input.employeeIdHash, current.employeeIdHash)) {
        throw new V2StateError(
          'The employee invite confirmation did not match the bound employee.',
          'employee_confirmation_failed',
          403
        );
      }
      return {
        ...current,
        state: 'manager-approved',
        employeeInviteTokenStatus: 'redeemed',
        employeeInviteTokenRedeemedAt: new Date().toISOString(),
        employeeInviteTokenAttemptCount:
          (current.employeeInviteTokenAttemptCount || 0) + 1,
        employeeConfirmedAt: new Date().toISOString(),
        lastEmployeeInviteFailureCode: undefined,
        lastEmployeeInviteFailureAt: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function decide(requestId, managerObjectId, decision) {
    if (!['approve', 'reject'].includes(decision)) {
      throw new V2StateError('Decision must be approve or reject.', 'invalid_decision', 400);
    }
    return updateRequest(requestId, ['manager-notified'], (current) => {
      const normalizedApprover = normalizeIdentifier(managerObjectId);
      const role = timingSafeTextEqual(
        normalizedApprover,
        normalizeIdentifier(current.managerObjectId)
      )
        ? 'direct-manager'
        : timingSafeTextEqual(
          normalizedApprover,
          normalizeIdentifier(current.skipManagerObjectId)
        )
          ? 'skip-manager'
          : null;
      if (current.managerTokenStatus !== 'redeemed' || !role) {
        throw new V2StateError(
          'The manager session is not authorized for this request.',
          'manager_not_authorized',
          403
        );
      }
      const approved = decision === 'approve';
      return {
        ...current,
        state: approved ? 'manager-approved' : 'manager-rejected',
        managerDecision: decision,
        managerDecisionByObjectId: managerObjectId,
        managerDecisionByRole: role,
        managerDecisionAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function listRequestsForApprover(approverObjectId) {
    return repository.findRequestsForApprover(approverObjectId);
  }

  async function escalateToSkipManager(requestId, skipManager) {
    const managerToken = randomOpaqueToken();
    const updated = await updateRequest(
      requestId,
      ['manager-notified'],
      (current) => {
        if (!skipManager?.id || !skipManager.mail ||
            normalizeIdentifier(skipManager.id) ===
              normalizeIdentifier(current.managerObjectId)) {
          throw new V2StateError(
            'Skip-level manager is not available for this request.',
            'skip_manager_unavailable',
            409
          );
        }
        return {
          ...current,
          skipManagerObjectId: skipManager.id,
          skipManagerDisplayName: skipManager.displayName,
          skipManagerUserPrincipalName: skipManager.userPrincipalName,
          escalationStatus: 'requested',
          escalatedAt: new Date().toISOString(),
          skipManagerTokenHash: sha256(managerToken),
          managerTokenStatus: 'active',
          skipManagerTokenCreatedAt: new Date().toISOString(),
          managerTokenExpiresAt: current.managerTokenExpiresAt,
          managerAuthState: undefined,
          managerAuthTokenHash: undefined,
          managerAuthNonceProtected: undefined,
          managerAuthVerifierProtected: undefined,
          managerAuthExpiresAt: undefined,
          updatedAt: new Date().toISOString(),
        };
      }
    );
    await repository.writeAudit({
      requestId,
      correlationId: updated.correlationId,
      eventType: 'approval_escalated',
      outcome: 'skip_manager_notified',
    });
    return { record: updated, managerToken };
  }

  async function adminResetRequest(requestId, input) {
    if (!['cancel', 'restart', 'unblock'].includes(input.action)) {
      throw new V2StateError('Unsupported admin reset action.', 'invalid_admin_action', 400);
    }
    if (!input.reason || String(input.reason).trim().length < 8) {
      throw new V2StateError('A reset reason is required.', 'reason_required', 400);
    }
    return updateRequest(requestId, null, (current) => {
      if (input.etag && String(current.etag) !== String(input.etag)) {
        throw new V2ConcurrencyError();
      }
      if (TERMINAL_STATES.has(current.state)) {
        throw new V2StateError(
          'Terminal requests cannot be reset.',
          'terminal_request',
          409
        );
      }
      const now = new Date().toISOString();
      const base = {
        ...current,
        adminResetAction: input.action,
        adminResetReason: String(input.reason).trim().slice(0, 512),
        adminResetByObjectId: input.adminObjectId,
        adminResetAt: now,
        managerTokenStatus: current.managerTokenStatus ? 'revoked' : undefined,
        employeeInviteTokenStatus: current.employeeInviteTokenStatus
          ? 'revoked'
          : undefined,
        managerAuthState: undefined,
        managerAuthTokenHash: undefined,
        managerAuthNonceProtected: undefined,
        managerAuthVerifierProtected: undefined,
        managerAuthExpiresAt: undefined,
        issuanceState: undefined,
        issuanceRequestId: undefined,
        issuanceStatus: undefined,
        issuancePinProtected: undefined,
        presentationState: undefined,
        presentationRequestId: undefined,
        presentationStatus: undefined,
        tapProtected: undefined,
        tapStatus: undefined,
        tapOperationId: undefined,
        updatedAt: now,
      };
      if (input.action === 'cancel') {
        return {
          ...base,
          state: 'admin-cancelled',
          cancelledAt: now,
        };
      }
      return {
        ...base,
        state: 'requested',
        notificationStatus: 'admin-reset',
        issuanceRetryCount: 0,
        presentationRetryCount: 0,
        verificationFailureCount: 0,
      };
    }).then(async (updated) => {
      await repository.writeAudit({
        requestId,
        correlationId: updated.correlationId,
        eventType: 'admin_reset',
        outcome: input.action,
        adminObjectIdHash: sha256(normalizeIdentifier(input.adminObjectId)),
      });
      return updated;
    });
  }

  async function beginIssuance(requestId, details) {
    return updateRequest(requestId, ['manager-approved'], (current) => {
      const issuanceActive = ['creating', 'active', 'retrieved']
        .includes(current.issuanceStatus) &&
        Date.now() < Date.parse(current.issuanceExpiresAt || current.expiresAt);
      if (issuanceActive ||
          current.issuanceRetryCount >= config.selfServiceV2.maxIssuanceRetries) {
        throw new V2StateError(
          'Verified ID issuance is already active or its retry limit was reached.',
          'issuance_not_available'
        );
      }
      return {
        ...current,
        issuanceStatus: 'creating',
        issuanceState: details.state,
        issuanceExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        issuancePinProtected: protectSecret(details.pin),
        issuanceRetryCount: current.issuanceRetryCount + 1,
        issuanceErrorCode: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function attachIssuanceRequest(requestId, details) {
    return updateRequest(requestId, ['manager-approved'], (current) => {
      if (current.issuanceStatus !== 'creating' ||
          current.issuanceState !== details.state) {
        throw new V2StateError('Issuance request creation lost ownership.', 'concurrency');
      }
      return {
        ...current,
        issuanceStatus: 'active',
        issuanceRequestId: details.requestId,
        issuanceExpiresAt: details.expiresAt,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function failIssuanceRequest(requestId, state, errorCode) {
    return updateRequest(requestId, ['manager-approved'], (current) => {
      if (current.issuanceState !== state) return null;
      return {
        ...current,
        issuanceStatus: 'error',
        issuanceErrorCode: errorCode,
        issuancePinProtected: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function handleIssuanceCallback(callback) {
    const request = await repository.findByIssuanceCorrelation(
      callback.requestId,
      callback.state
    );
    if (!request) {
      throw new V2StateError('Issuance callback correlation failed.', 'callback_mismatch', 404);
    }
    if (request.state === 'credential-issued') {
      return request;
    }
    if (request.state !== 'manager-approved' ||
        !['active', 'retrieved'].includes(request.issuanceStatus)) {
      throw new V2StateError('Issuance callback is not valid in this state.', 'invalid_state');
    }
    if (callback.requestStatus === 'request_retrieved') {
      return updateRequest(request.requestId, ['manager-approved'], (current) => ({
        ...current,
        issuanceStatus: 'retrieved',
        issuanceRetrievedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
    }
    if (callback.requestStatus === 'issuance_error') {
      return updateRequest(request.requestId, ['manager-approved'], (current) => ({
        ...current,
        issuanceStatus: 'error',
        issuanceErrorCode: callback.error?.code || 'issuance_error',
        issuancePinProtected: undefined,
        updatedAt: new Date().toISOString(),
      }));
    }
    if (callback.requestStatus !== 'issuance_successful') {
      throw new V2StateError('Unsupported issuance callback status.', 'invalid_callback', 400);
    }
    return updateRequest(request.requestId, ['manager-approved'], (current) => ({
      ...current,
      state: 'credential-issued',
      issuanceStatus: 'successful',
      credentialIssuedAt: new Date().toISOString(),
      issuancePinProtected: undefined,
      updatedAt: new Date().toISOString(),
    }));
  }

  async function beginPresentation(requestId, details) {
    return updateRequest(
      requestId,
      ['credential-issued', 'credential-presented'],
      (current) => {
      const presentationActive = ['creating', 'active', 'retrieved']
        .includes(current.presentationStatus) &&
        Date.now() < Date.parse(
          current.presentationExpiresAt || current.expiresAt
        );
      if (presentationActive ||
          current.presentationRetryCount >=
            config.selfServiceV2.maxPresentationRetries) {
        throw new V2StateError(
          'Verified ID presentation is already active or its retry limit was reached.',
          'presentation_not_available'
        );
      }
      return {
        ...current,
        state: 'credential-issued',
        presentationStatus: 'creating',
        presentationState: details.state,
        presentationExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        presentationRetryCount: current.presentationRetryCount + 1,
        presentationErrorCode: undefined,
        updatedAt: new Date().toISOString(),
      };
      }
    );
  }

  async function attachPresentationRequest(requestId, details) {
    return updateRequest(requestId, ['credential-issued'], (current) => {
      if (current.presentationStatus !== 'creating' ||
          current.presentationState !== details.state) {
        throw new V2StateError(
          'Presentation request creation lost ownership.',
          'concurrency'
        );
      }
      return {
        ...current,
        presentationStatus: 'active',
        presentationRequestId: details.requestId,
        presentationExpiresAt: details.expiresAt,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function failPresentationRequest(requestId, state, errorCode) {
    return updateRequest(requestId, ['credential-issued'], (current) => {
      if (current.presentationState !== state) return null;
      return {
        ...current,
        presentationStatus: 'error',
        presentationErrorCode: errorCode,
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function handlePresentationRetrieved(requestId) {
    return updateRequest(requestId, ['credential-issued'], (current) => ({
      ...current,
      state: 'credential-presented',
      presentationStatus: 'retrieved',
      presentationRetrievedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
  }

  async function handlePresentationError(requestId, errorCode) {
    return updateRequest(
      requestId,
      ['credential-issued', 'credential-presented'],
      (current) => ({
        ...current,
        state: 'credential-issued',
        presentationStatus: 'error',
        presentationErrorCode: errorCode || 'presentation_error',
        updatedAt: new Date().toISOString(),
      })
    );
  }

  async function recordVerificationFailure(requestId, code) {
    const updated = await updateRequest(
      requestId,
      ['credential-presented'],
      (current) => {
        const failures = current.verificationFailureCount + 1;
        return {
          ...current,
          state: failures >= config.selfServiceV2.maxVerificationFailures
            ? 'locked'
            : 'credential-presented',
          verificationFailureCount: failures,
          lastVerificationFailureCode: code,
          updatedAt: new Date().toISOString(),
        };
      }
    );
    await repository.writeAudit({
      requestId,
      correlationId: updated.correlationId,
      eventType: 'presentation_validation',
      outcome: code,
    });
    return updated;
  }

  async function markVerified(requestId, audit) {
    return updateRequest(requestId, ['credential-presented'], (current) => ({
      ...current,
      state: 'verified',
      presentationStatus: 'verified',
      verifiedAt: new Date().toISOString(),
      verifiedIssuer: audit.issuer,
      verifiedCredentialType: audit.credentialType,
      verifiedLinkedDomain: audit.linkedDomain,
      updatedAt: new Date().toISOString(),
    }));
  }

  async function issueTapOnce(requestId, operation) {
    const operationId = uuidv4();
    const current = await updateRequest(requestId, null, (record) => {
      if (record.state === 'tap-issued') return null;
      if (record.state !== 'verified') {
        throw new V2StateError('TAP cannot be created in this state.', 'invalid_state');
      }
      if (record.tapStatus === 'creating') return null;
      return {
        ...record,
        tapStatus: 'creating',
        tapOperationId: operationId,
        tapOperationStartedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    if (current.tapOperationId !== operationId ||
        current.tapStatus !== 'creating') {
      return { request: current, created: false };
    }

    try {
      const result = await operation(current);
      const updated = await updateRequest(requestId, ['verified'], (record) => {
        if (record.tapOperationId !== operationId ||
            record.tapStatus !== 'creating') {
          throw new V2ConcurrencyError();
        }
        return {
          ...record,
          state: 'tap-issued',
          tapStatus: 'issued',
          tapProtected: protectSecret(result.tap.temporaryAccessPass),
          tapLifetimeInMinutes: result.tap.lifetimeInMinutes,
          tapMethodId: result.tap.id,
          tapCreatedAt: result.tap.createdDateTime || new Date().toISOString(),
          passkeyBaselineJson: JSON.stringify(
            result.baselineMethods.map((method) => method.id)
          ),
          updatedAt: new Date().toISOString(),
        };
      });
      return { request: updated, created: true };
    } catch (err) {
      await updateRequest(requestId, ['verified'], (record) => {
        if (record.tapOperationId !== operationId) return null;
        return {
          ...record,
          tapStatus: 'error',
          tapFailureAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }).catch(() => {});
      throw err;
    }
  }

  async function takeTapForDisplay(requestId) {
    let tap = null;
    const request = await updateRequest(requestId, ['tap-issued'], (current) => {
      if (!current.tapProtected) {
        throw new V2StateError(
          'The Temporary Access Pass has already been displayed.',
          'tap_already_displayed',
          410
        );
      }
      tap = unprotectSecret(current.tapProtected);
      return {
        ...current,
        tapProtected: undefined,
        tapDisplayedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    return {
      tap,
      lifetimeInMinutes: request.tapLifetimeInMinutes,
    };
  }

  async function confirmPasskey(requestId, methods) {
    return updateRequest(requestId, ['tap-issued'], (current) => {
      const baseline = new Set(JSON.parse(current.passkeyBaselineJson || '[]'));
      const newMethod = methods.find((method) => !baseline.has(method.id));
      if (!newMethod) {
        throw new V2StateError(
          'No new tenant passkey has been registered.',
          'passkey_not_found',
          404
        );
      }
      return {
        ...current,
        state: 'passkey-registered',
        passkeyMethodId: newMethod.id,
        passkeyRegisteredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function complete(requestId) {
    return updateRequest(requestId, ['passkey-registered'], (current) => ({
      ...current,
      state: 'complete',
      completedAt: new Date().toISOString(),
      managerTokenHash: undefined,
      issuanceState: undefined,
      presentationState: undefined,
      passkeyBaselineJson: undefined,
      updatedAt: new Date().toISOString(),
    }));
  }

  return {
    enforceRateLimit,
    createRequest,
    createManagerInitiatedRequest,
    loadRequest,
    markManagerNotified,
    markNotificationFailed,
    activateManagerToken,
    activateEmployeeInviteToken,
    beginManagerSignIn,
    loadManagerAuthFlow,
    createDashboardAuthTransaction,
    loadDashboardAuthTransaction,
    deleteDashboardAuthTransaction,
    redeemManagerToken,
    recordManagerRedemptionFailure,
    recordEmployeeInviteFailure,
    confirmEmployeeInvite,
    decide,
    listRequestsForApprover,
    escalateToSkipManager,
    adminResetRequest,
    beginIssuance,
    attachIssuanceRequest,
    failIssuanceRequest,
    handleIssuanceCallback,
    beginPresentation,
    attachPresentationRequest,
    failPresentationRequest,
    handlePresentationRetrieved,
    handlePresentationError,
    recordVerificationFailure,
    markVerified,
    issueTapOnce,
    takeTapForDisplay,
    confirmPasskey,
    complete,
    writeAudit: (event) => repository.writeAudit(event),
    findByIssuanceCorrelation: (requestId, state) =>
      repository.findByIssuanceCorrelation(requestId, state),
    findByPresentationCorrelation: (requestId, state) =>
      repository.findByPresentationCorrelation(requestId, state),
  };
}

const defaultRepository = config.storage.backend === 'azure-table'
  ? new AzureTableV2Repository()
  : new InMemoryV2Repository();
const defaultService = createOnboardingV2Service(defaultRepository);

module.exports = {
  V2StateError,
  V2ConcurrencyError,
  InMemoryV2Repository,
  AzureTableV2Repository,
  createOnboardingV2Service,
  ...defaultService,
  resetForTests: () => defaultRepository.reset?.(),
};
