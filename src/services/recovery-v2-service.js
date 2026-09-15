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
const { V2StateError, V2ConcurrencyError } = require('./onboarding-v2-service');

const REQUEST_PARTITION = 'recovery-request';
const LOCK_PARTITION = 'recovery-employee-lock';
const RATE_PARTITION = 'recovery-rate-limit';
const AUDIT_PARTITION = 'recovery-audit';
const TERMINAL_STATES = new Set(['complete', 'expired', 'locked', 'admin-cancelled']);

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

class InMemoryRecoveryV2Repository {
  constructor() {
    this.requests = new Map();
    this.employeeLocks = new Map();
    this.rateLimits = new Map();
    this.auditEvents = [];
  }

  async createRequest(record) {
    const lockKey = normalizeIdentifier(record.employeeObjectId);
    const currentLock = this.employeeLocks.get(lockKey);
    if (currentLock && Date.now() < Date.parse(currentLock.expiresAt)) {
      throw new V2StateError(
        'An active recovery request already exists for this employee.',
        'active_recovery_exists'
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

  async findByPresentationCorrelation(requestId, state) {
    return [...this.requests.values()]
      .map(({ version, ...record }) => ({ ...record, etag: String(version) }))
      .find((record) =>
        record.presentationRequestId === requestId &&
        record.presentationState === state
      ) || null;
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

  async findRequestsForEmployee(employeeObjectId) {
    const normalized = normalizeIdentifier(employeeObjectId);
    return [...this.requests.values()]
      .map(({ version, ...record }) => ({ ...record, etag: String(version) }))
      .filter((record) =>
        normalizeIdentifier(record.employeeObjectId) === normalized
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
    this.auditEvents.length = 0;
  }
}

class AzureTableRecoveryV2Repository {
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
          'An active recovery request already exists for this employee.',
          'active_recovery_exists'
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
          await this.getClient().deleteEntity(LOCK_PARTITION, rowKey, { etag: lock.etag });
        }
      } catch (err) {
        if (!isTableNotFound(err) && !isTableConflict(err)) throw err;
      }
    }
  }

  async findOne(filter) {
    const entities = this.getClient().listEntities({ queryOptions: { filter } });
    for await (const entity of entities) return withoutMetadata(entity);
    return null;
  }

  findByPresentationCorrelation(requestId, state) {
    return this.findOne(
      `PartitionKey eq '${REQUEST_PARTITION}' and presentationRequestId eq '${escapeOData(requestId)}' and presentationState eq '${escapeOData(state)}'`
    );
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

  async findRequestsForEmployee(employeeObjectId) {
    const results = [];
    const entities = this.getClient().listEntities({
      queryOptions: {
        filter:
          `PartitionKey eq '${REQUEST_PARTITION}' and ` +
          `employeeObjectId eq '${escapeOData(employeeObjectId)}'`,
      },
    });
    for await (const entity of entities) {
      results.push(withoutMetadata(entity));
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

function createRecoveryV2Service(repository) {
  async function loadRequest(requestId) {
    const request = await repository.getRequest(requestId);
    if (!request) {
      throw new V2StateError('Recovery request was not found.', 'not_found', 404);
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
        throw new V2StateError('Recovery request was not found.', 'not_found', 404);
      }
      if (allowedStates && !allowedStates.includes(current.state)) {
        throw new V2StateError(
          `Recovery request cannot transition from ${current.state}.`,
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
          }).catch(() => {});
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

  async function createRecoveryRequest(input) {
    const now = Date.now();
    const requestId = uuidv4();
    const managerToken = randomOpaqueToken();
    const expiresAt = new Date(
      now + config.selfServiceV2.recovery.requestLifetimeMinutes * 60 * 1000
    ).toISOString();
    const record = {
      requestId,
      correlationId: uuidv4(),
      requestKind: 'recovery',
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
      managerTokenExpiresAt: expiresAt,
      managerTokenAttemptCount: 0,
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
        'The recovery approval link is invalid or expired.',
        'invalid_manager_token',
        410
      );
    }
    return {
      requestId: request.requestId,
      tokenHash,
      requestKind: 'recovery',
      expiresAt: new Date(
        Math.min(
          Date.parse(request.expiresAt),
          Date.now() + config.selfServiceV2.managerPreAuthLifetimeMinutes * 60 * 1000
        )
      ).toISOString(),
    };
  }

  async function beginManagerSignIn(requestId, tokenHash, authorization) {
    return updateRequest(requestId, ['manager-notified'], (current) => {
      if (current.managerTokenStatus !== 'active' ||
          (
            !timingSafeHashEqual(tokenHash, current.managerTokenHash) &&
            !timingSafeHashEqual(tokenHash, current.skipManagerTokenHash)
          )) {
        throw new V2StateError(
          'The recovery approval token is no longer active.',
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

  async function loadManagerAuthFlow(state) {
    const request = await repository.findByManagerAuthState(state);
    if (!request ||
        request.state !== 'manager-notified' ||
        request.managerTokenStatus !== 'active' ||
        Date.now() >= Date.parse(request.managerAuthExpiresAt)) {
      throw new V2StateError(
        'The recovery manager sign-in transaction is invalid or expired.',
        'manager_auth_expired',
        400
      );
    }
    return {
      request,
      requestKind: 'recovery',
      nonce: unprotectSecret(request.managerAuthNonceProtected),
      codeVerifier: unprotectSecret(request.managerAuthVerifierProtected),
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
          'The signed-in manager is not authorized for this recovery request.',
          'manager_not_authorized',
          403
        );
      }
      return {
        ...current,
        managerTokenStatus: 'redeemed',
        managerTokenRedeemedAt: new Date().toISOString(),
        managerTokenAttemptCount: current.managerTokenAttemptCount + 1,
        managerAuthState: undefined,
        managerAuthTokenHash: undefined,
        managerAuthNonceProtected: undefined,
        managerAuthVerifierProtected: undefined,
        managerAuthExpiresAt: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
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
          'The manager session is not authorized for this recovery request.',
          'manager_not_authorized',
          403
        );
      }
      return {
        ...current,
        state: decision === 'approve' ? 'manager-approved' : 'locked',
        managerDecision: decision,
        managerDecisionByObjectId: managerObjectId,
        managerDecisionByRole: role,
        managerDecisionAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
  }

  async function escalateToSkipManager(requestId, skipManager) {
    const managerToken = randomOpaqueToken();
    const updated = await updateRequest(requestId, ['manager-notified'], (current) => {
      if (!skipManager?.id || !skipManager.mail ||
          normalizeIdentifier(skipManager.id) ===
            normalizeIdentifier(current.managerObjectId)) {
        throw new V2StateError(
          'Skip-level manager is not available for this recovery request.',
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
        managerAuthState: undefined,
        managerAuthTokenHash: undefined,
        managerAuthNonceProtected: undefined,
        managerAuthVerifierProtected: undefined,
        managerAuthExpiresAt: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
    await repository.writeAudit({
      requestId,
      correlationId: updated.correlationId,
      eventType: 'approval_escalated',
      outcome: 'skip_manager_notified',
    });
    return { record: updated, managerToken };
  }

  async function beginPresentation(requestId, details) {
    return updateRequest(
      requestId,
      ['manager-approved', 'credential-presented'],
      (current) => {
        const presentationActive = ['creating', 'active', 'retrieved']
          .includes(current.presentationStatus) &&
          Date.now() < Date.parse(current.presentationExpiresAt || current.expiresAt);
        if (presentationActive ||
            current.presentationRetryCount >=
              config.selfServiceV2.recovery.maxPresentationRetries) {
          throw new V2StateError(
            'Recovery credential presentation is already active or its retry limit was reached.',
            'presentation_not_available'
          );
        }
        return {
          ...current,
          state: 'manager-approved',
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
    return updateRequest(requestId, ['manager-approved'], (current) => {
      if (current.presentationStatus !== 'creating' ||
          current.presentationState !== details.state) {
        throw new V2StateError(
          'Recovery presentation request creation lost ownership.',
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
    return updateRequest(requestId, ['manager-approved'], (current) => {
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
    return updateRequest(requestId, ['manager-approved'], (current) => ({
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
      ['manager-approved', 'credential-presented'],
      (current) => ({
        ...current,
        state: 'manager-approved',
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
          state: failures >= config.selfServiceV2.recovery.maxVerificationFailures
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

  async function revokePasskeysAndIssueTap(requestId, operation) {
    const operationId = uuidv4();
    const current = await updateRequest(requestId, ['verified'], (record) => {
      if (record.tapStatus === 'issued') return null;
      if (record.tapStatus === 'creating') return null;
      return {
        ...record,
        state: 'passkeys-revoked',
        tapStatus: 'creating',
        tapOperationId: operationId,
        passkeysRevokedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    });
    if (current.tapOperationId !== operationId || current.tapStatus !== 'creating') {
      return { request: current, created: false };
    }

    try {
      const result = await operation(current);
      const updated = await updateRequest(requestId, ['passkeys-revoked'], (record) => {
        if (record.tapOperationId !== operationId || record.tapStatus !== 'creating') {
          throw new V2ConcurrencyError();
        }
        return {
          ...record,
          state: 'tap-issued',
          tapStatus: 'issued',
          revokedMethodIdsJson: JSON.stringify(result.revokedMethodIds || []),
          passkeyBaselineJson: JSON.stringify(result.revokedMethodIds || []),
          tapProtected: protectSecret(result.tap.temporaryAccessPass),
          tapLifetimeInMinutes: result.tap.lifetimeInMinutes,
          tapMethodId: result.tap.id,
          tapCreatedAt: result.tap.createdDateTime || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      });
      return { request: updated, created: true };
    } catch (err) {
      await updateRequest(requestId, ['passkeys-revoked'], (record) => {
        if (record.tapOperationId !== operationId) return null;
        return {
          ...record,
          tapStatus: 'error',
          tapFailureCode: err.code || 'tap_issue_failed',
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
          'The recovery Temporary Access Pass has already been displayed.',
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
          'No replacement tenant passkey has been registered.',
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
      presentationState: undefined,
      passkeyBaselineJson: undefined,
      updatedAt: new Date().toISOString(),
    }));
  }

  async function adminResetRequest(requestId, input) {
    if (typeof input.etag !== 'string' || !input.etag.trim() || input.etag.trim() === '*') {
      throw new V2StateError(
        'A specific request version is required for an admin reset.',
        'precondition_required',
        428
      );
    }
    if (!['cancel', 'restart', 'unblock'].includes(input.action)) {
      throw new V2StateError('Unsupported admin reset action.', 'invalid_admin_action', 400);
    }
    if (!input.reason || String(input.reason).trim().length < 8) {
      throw new V2StateError('A reset reason is required.', 'reason_required', 400);
    }
    return updateRequest(requestId, null, (current) => {
      if (String(current.etag) !== input.etag) {
        throw new V2StateError(
          'The request changed. Reload it before resetting.',
          'precondition_failed',
          412
        );
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
        managerAuthState: undefined,
        managerAuthTokenHash: undefined,
        managerAuthNonceProtected: undefined,
        managerAuthVerifierProtected: undefined,
        managerAuthExpiresAt: undefined,
        presentationState: undefined,
        presentationRequestId: undefined,
        presentationStatus: undefined,
        tapProtected: undefined,
        tapStatus: undefined,
        tapOperationId: undefined,
        updatedAt: now,
      };
      if (input.action === 'cancel') {
        return { ...base, state: 'admin-cancelled', cancelledAt: now };
      }
      return {
        ...base,
        state: 'manager-notified',
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

  return {
    enforceRateLimit,
    createRecoveryRequest,
    loadRequest,
    markManagerNotified,
    markNotificationFailed,
    activateManagerToken,
    beginManagerSignIn,
    loadManagerAuthFlow,
    redeemManagerToken,
    recordManagerRedemptionFailure,
    decide,
    escalateToSkipManager,
    listRequestsForApprover: (approverObjectId) =>
      repository.findRequestsForApprover(approverObjectId),
    findRequestsForEmployee: (employeeObjectId) =>
      repository.findRequestsForEmployee(employeeObjectId)
        .then((requests) => requests.sort((left, right) => {
          const leftTerminal = TERMINAL_STATES.has(left.state);
          const rightTerminal = TERMINAL_STATES.has(right.state);
          if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
          return Date.parse(right.updatedAt || right.createdAt || 0) -
            Date.parse(left.updatedAt || left.createdAt || 0);
        })),
    beginPresentation,
    attachPresentationRequest,
    failPresentationRequest,
    handlePresentationRetrieved,
    handlePresentationError,
    recordVerificationFailure,
    markVerified,
    revokePasskeysAndIssueTap,
    takeTapForDisplay,
    confirmPasskey,
    complete,
    adminResetRequest,
    writeAudit: (event) => repository.writeAudit(event),
    findByPresentationCorrelation: (requestId, state) =>
      repository.findByPresentationCorrelation(requestId, state),
  };
}

const defaultRepository = config.storage.backend === 'azure-table'
  ? new AzureTableRecoveryV2Repository()
  : new InMemoryRecoveryV2Repository();
const defaultService = createRecoveryV2Service(defaultRepository);

module.exports = {
  InMemoryRecoveryV2Repository,
  AzureTableRecoveryV2Repository,
  createRecoveryV2Service,
  ...defaultService,
  resetForTests: () => defaultRepository.reset?.(),
};
