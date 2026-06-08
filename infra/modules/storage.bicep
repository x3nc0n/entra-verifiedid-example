// ── Parameters ─────────────────────────────────────────────────────────────────

@description('Azure region.')
param location string

@description('Application name prefix.')
param appName string

// ── Variables ──────────────────────────────────────────────────────────────────

// Storage account names: 3–24 chars, lowercase alphanumeric only
var saName = take(toLower('${replace(appName, '-', '')}${uniqueString(resourceGroup().id)}'), 24)

var containerName = 'artifacts'

// ── Storage Account ────────────────────────────────────────────────────────────

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: saName
  location: location
  tags: {
    project: 'entra-verifiedid-example'
    environment: 'demo'
  }
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    accessTier: 'Hot'
  }
}

// ── Blob Container ─────────────────────────────────────────────────────────────

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource artifactsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────

@description('Storage account name.')
output accountName string = storageAccount.name

@description('Storage account primary connection string.')
output connectionString string = 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
