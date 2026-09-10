'use strict';

const crypto = require('crypto');
const session = require('express-session');
const config = require('../config');
const { createTableClient, isTableNotFound } = require('./table-client');

const PARTITION_KEY = 'session';

function sessionRowKey(sessionId) {
  return crypto.createHash('sha256').update(sessionId).digest('hex');
}

function expiresAtFor(sessionValue) {
  const cookieExpiry = sessionValue?.cookie?.expires;
  const parsedExpiry = cookieExpiry ? Date.parse(cookieExpiry) : NaN;
  if (Number.isFinite(parsedExpiry)) return new Date(parsedExpiry).toISOString();

  const maxAge = Number(sessionValue?.cookie?.originalMaxAge);
  const lifetime = Number.isFinite(maxAge) && maxAge > 0
    ? maxAge
    : 60 * 60 * 1000;
  return new Date(Date.now() + lifetime).toISOString();
}

class AzureTableSessionStore extends session.Store {
  constructor(options = {}) {
    super();
    this.client = options.client ||
      createTableClient(config.storage.sessionTableName);
  }

  get(sessionId, callback) {
    this.client.getEntity(PARTITION_KEY, sessionRowKey(sessionId))
      .then(async (entity) => {
        if (Date.now() >= Date.parse(entity.expiresAt)) {
          await this.client.deleteEntity(PARTITION_KEY, entity.rowKey)
            .catch((err) => {
              if (!isTableNotFound(err)) throw err;
            });
          callback(null, null);
          return;
        }
        callback(null, JSON.parse(entity.payload));
      })
      .catch((err) => {
        if (isTableNotFound(err)) {
          callback(null, null);
          return;
        }
        callback(err);
      });
  }

  set(sessionId, sessionValue, callback = () => {}) {
    const entity = {
      partitionKey: PARTITION_KEY,
      rowKey: sessionRowKey(sessionId),
      payload: JSON.stringify(sessionValue),
      expiresAt: expiresAtFor(sessionValue),
    };
    this.client.upsertEntity(entity, 'Replace')
      .then(() => callback())
      .catch(callback);
  }

  destroy(sessionId, callback = () => {}) {
    this.client.deleteEntity(PARTITION_KEY, sessionRowKey(sessionId))
      .then(() => callback())
      .catch((err) => {
        if (isTableNotFound(err)) {
          callback();
          return;
        }
        callback(err);
      });
  }

  touch(sessionId, sessionValue, callback = () => {}) {
    const entity = {
      partitionKey: PARTITION_KEY,
      rowKey: sessionRowKey(sessionId),
      expiresAt: expiresAtFor(sessionValue),
    };
    this.client.updateEntity(entity, 'Merge', { etag: '*' })
      .then(() => callback())
      .catch((err) => {
        if (isTableNotFound(err)) {
          callback();
          return;
        }
        callback(err);
      });
  }
}

function createSessionStore() {
  if (config.storage.backend === 'azure-table') {
    return new AzureTableSessionStore();
  }
  return new session.MemoryStore();
}

module.exports = {
  AzureTableSessionStore,
  createSessionStore,
  expiresAtFor,
  sessionRowKey,
};
