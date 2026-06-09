// ── Parameters ─────────────────────────────────────────────────────────────────

@description('Azure region.')
param location string

@description('Application name prefix.')
param appName string

@description('Principal ID of the application managed identity.')
param appPrincipalId string = ''

// ── Variables ──────────────────────────────────────────────────────────────────

var kvName = '${appName}-kv-${uniqueString(resourceGroup().id)}'

// Key Vault name must be 3–24 chars, alphanumeric + hyphens
var kvNameSafe = length(kvName) > 24 ? substring(kvName, 0, 24) : kvName

// ── Key Vault ──────────────────────────────────────────────────────────────────

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvNameSafe
  location: location
  tags: {
    project: 'entra-verifiedid-example'
    environment: 'demo'
  }
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    softDeleteRetentionInDays: 7
    enableSoftDelete: true
    enablePurgeProtection: true
    enableRbacAuthorization: true
  }
}

// Grant the app's managed identity Key Vault Secrets User role.
resource kvSecretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(appPrincipalId)) {
  name: guid(keyVault.id, appPrincipalId, 'Key Vault Secrets User')
  scope: keyVault
  properties: {
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6') // Key Vault Secrets User
  }
}

// ── Placeholder Secrets ────────────────────────────────────────────────────────
// Created as placeholders so Key Vault-backed app secrets resolve consistently.
// The bootstrap script (scripts/bootstrap.ps1) populates these with real values.

resource clientSecretKvEntry 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'azure-client-secret'
  properties: {
    value: 'PLACEHOLDER--run-bootstrap-to-set'
    attributes: {
      enabled: true
    }
  }
}

resource identityPassKeyEntry 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'identitypass-key'
  properties: {
    value: 'PLACEHOLDER--run-bootstrap-to-set'
    attributes: {
      enabled: true
    }
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────

@description('Key Vault URI.')
output vaultUri string = keyVault.properties.vaultUri

@description('Key Vault resource name.')
output vaultName string = keyVault.name
