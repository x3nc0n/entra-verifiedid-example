'use strict';

const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');
const config = require('../config');

let credential = null;

function getCredential() {
  if (!credential) {
    credential = new DefaultAzureCredential({
      managedIdentityClientId: config.azure.clientId || undefined,
    });
  }
  return credential;
}

function createTableClient(tableName) {
  if (!config.storage.tableEndpoint) {
    throw new Error('AZURE_STORAGE_TABLE_ENDPOINT is required for Azure Table state.');
  }
  return new TableClient(
    config.storage.tableEndpoint,
    tableName,
    getCredential()
  );
}

function isTableNotFound(err) {
  return err?.statusCode === 404;
}

function isTableConflict(err) {
  return err?.statusCode === 409 || err?.statusCode === 412;
}

module.exports = {
  createTableClient,
  isTableNotFound,
  isTableConflict,
};
