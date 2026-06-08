// ── Parameters ─────────────────────────────────────────────────────────────────

@description('Azure region.')
param location string

@description('Application name prefix.')
param appName string

@description('Principal ID of the web app managed identity.')
param webAppPrincipalId string

@description('Azure AD client secret to seed.')
@secure()
param azureClientSecret string

@description('IdentityPass subscription key to seed.')
@secure()
param identityPassSubscriptionKey string

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
    accessPolicies: [
      {
        tenantId: subscription().tenantId
        objectId: webAppPrincipalId
        permissions: {
          secrets: ['get', 'list']
        }
      }
    ]
  }
}

// ── Secrets ────────────────────────────────────────────────────────────────────

resource clientSecretKvEntry 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'azure-client-secret'
  properties: {
    value: azureClientSecret
    attributes: {
      enabled: true
    }
  }
}

resource identityPassKeyEntry 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: keyVault
  name: 'identitypass-key'
  properties: {
    value: identityPassSubscriptionKey
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
