'use strict';

const { TableClient } = require('@azure/data-tables');
const { DefaultAzureCredential } = require('@azure/identity');
const config = require('../src/config');
const graphService = require('../src/services/graph-service');
const onboardingService = require('../src/services/onboarding-v2-service');
const recoveryService = require('../src/services/recovery-v2-service');
const {
  normalizeIdentifier,
  sha256,
} = require('../src/services/v2-crypto-service');

const REQUEST_PARTITIONS = {
  onboarding: 'request',
  recovery: 'recovery-request',
};
const LOCK_PARTITIONS = {
  onboarding: 'employee-lock',
  recovery: 'recovery-employee-lock',
};

function printUsage() {
  console.log(
    'Usage: node scripts/clear-v2-stuck-request.js ' +
    '--upn <user@domain> [--kind onboarding|recovery|all] ' +
    '[--request-id <id>] [--apply] [--action cancel|restart|unblock] ' +
    '[--reason <text>] [--actor <identifier>] [--delete-orphan-lock]'
  );
}

function parseArgs(argv) {
  const options = {
    kind: 'onboarding',
    action: 'cancel',
    apply: false,
    deleteOrphanLock: false,
    actor: 'manual-admin-script',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--upn':
        options.upn = argv[++index];
        break;
      case '--employee-id':
        options.employeeId = argv[++index];
        break;
      case '--kind':
        options.kind = argv[++index];
        break;
      case '--request-id':
        options.requestId = argv[++index];
        break;
      case '--action':
        options.action = argv[++index];
        break;
      case '--reason':
        options.reason = argv[++index];
        break;
      case '--actor':
        options.actor = argv[++index];
        break;
      case '--apply':
        options.apply = true;
        break;
      case '--delete-orphan-lock':
        options.deleteOrphanLock = true;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function createTableClient() {
  if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
    return TableClient.fromConnectionString(
      process.env.AZURE_STORAGE_CONNECTION_STRING,
      config.storage.v2RequestTableName
    );
  }
  if (!config.storage.tableEndpoint) {
    throw new Error(
      'Set AZURE_STORAGE_CONNECTION_STRING for Azurite/dev storage or ' +
      'AZURE_STORAGE_TABLE_ENDPOINT for managed-identity-backed table access.'
    );
  }
  return new TableClient(
    config.storage.tableEndpoint,
    config.storage.v2RequestTableName,
    new DefaultAzureCredential({
      managedIdentityClientId: config.azure.clientId || undefined,
    })
  );
}

function sortRequests(left, right) {
  const terminalStates = new Set([
    'manager-rejected',
    'admin-cancelled',
    'complete',
    'expired',
    'locked',
  ]);
  const leftTerminal = terminalStates.has(left.state);
  const rightTerminal = terminalStates.has(right.state);
  if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
  return Date.parse(right.updatedAt || right.createdAt || 0) -
    Date.parse(left.updatedAt || left.createdAt || 0);
}

async function resolveEmployee(options) {
  if (options.upn) {
    return graphService.getUserByPrincipalName(options.upn);
  }
  if (options.employeeId) {
    return graphService.getUserByEmployeeId(options.employeeId);
  }
  throw new Error('Provide --upn or --employee-id.');
}

async function getLock(client, kind, employeeObjectId) {
  const lockPartition = LOCK_PARTITIONS[kind];
  const lockRowKey = sha256(normalizeIdentifier(employeeObjectId));
  try {
    return await client.getEntity(lockPartition, lockRowKey);
  } catch (err) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

function summarizeRequest(kind, request) {
  return {
    requestKind: kind,
    requestId: request.requestId,
    state: request.state,
    etag: request.etag,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    initiationMode: request.initiationMode,
  };
}

function chooseTargets(options, requests) {
  const filtered = options.kind === 'all'
    ? requests
    : requests.filter((request) => request.requestKind === options.kind);
  if (!filtered.length) {
    throw new Error(`No ${options.kind} request was found for the resolved employee.`);
  }
  if (options.requestId) {
    const match = filtered.find((request) => request.requestId === options.requestId);
    if (!match) {
      throw new Error(`Request ${options.requestId} was not found in the lookup results.`);
    }
    return [match];
  }
  if (filtered.length > 1) {
    throw new Error(
      `Multiple ${options.kind} requests were found. Re-run with --request-id to target one explicitly.`
    );
  }
  return filtered;
}

async function maybeDeleteOrphanLock(client, kind, employeeObjectId, requests, options) {
  const lock = await getLock(client, kind, employeeObjectId);
  if (!lock) return;

  console.log(
    JSON.stringify({
      lock: {
        requestKind: kind,
        requestId: lock.requestId,
        expiresAt: lock.expiresAt,
        etag: lock.etag,
      },
    }, null, 2)
  );

  if (!options.deleteOrphanLock) return;
  const referencedRequest = requests.find((request) =>
    request.requestKind === kind && request.requestId === lock.requestId
  );
  if (referencedRequest) return;
  await client.deleteEntity(lock.partitionKey, lock.rowKey, { etag: lock.etag });
  console.log(`Deleted orphaned ${kind} employee lock ${lock.rowKey}.`);
}

async function applyReset(target, options) {
  const service = target.requestKind === 'recovery'
    ? recoveryService
    : onboardingService;
  await service.adminResetRequest(target.requestId, {
    action: options.action,
    reason: options.reason,
    etag: target.etag,
    adminObjectId: options.actor,
  });
  const refreshed = await service.loadRequest(target.requestId);
  console.log(
    JSON.stringify({
      resetApplied: {
        requestKind: target.requestKind,
        requestId: refreshed.requestId,
        state: refreshed.state,
        etag: refreshed.etag,
        updatedAt: refreshed.updatedAt,
      },
    }, null, 2)
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (!options.upn && !options.employeeId) {
    printUsage();
    throw new Error('Provide --upn or --employee-id.');
  }
  if (options.upn && options.employeeId) {
    throw new Error('Provide only one of --upn or --employee-id.');
  }
  if (!['onboarding', 'recovery', 'all'].includes(options.kind)) {
    throw new Error('Use --kind onboarding, recovery, or all.');
  }
  if (options.apply && (!options.reason || String(options.reason).trim().length < 8)) {
    throw new Error('Provide --reason with at least 8 characters when using --apply.');
  }

  const employee = await resolveEmployee(options);
  if (!employee?.id) {
    throw new Error('No employee matched the supplied identifier.');
  }

  console.log(JSON.stringify({
    employee: {
      id: employee.id,
      displayName: employee.displayName || null,
      userPrincipalName: employee.userPrincipalName || null,
    },
  }, null, 2));

  const [onboardingRequests, recoveryRequests] = await Promise.all([
    onboardingService.findRequestsForEmployee(employee.id),
    recoveryService.findRequestsForEmployee(employee.id),
  ]);
  const requests = [
    ...onboardingRequests.map((request) => summarizeRequest('onboarding', request)),
    ...recoveryRequests.map((request) => summarizeRequest('recovery', request)),
  ].sort(sortRequests);

  console.log(JSON.stringify({ requests }, null, 2));

  const client = createTableClient();
  await maybeDeleteOrphanLock(client, 'onboarding', employee.id, requests, options);
  await maybeDeleteOrphanLock(client, 'recovery', employee.id, requests, options);

  if (!options.apply) {
    console.log('Dry run only. Re-run with --apply to perform the reset.');
    return;
  }

  const targets = chooseTargets(options, requests);
  for (const target of targets) {
    // eslint-disable-next-line no-await-in-loop
    await applyReset(target, options);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
