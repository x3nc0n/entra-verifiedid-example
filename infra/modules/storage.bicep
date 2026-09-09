// ── Parameters ─────────────────────────────────────────────────────────────────

@description('Azure region.')
param location string

@description('Application name prefix.')
param appName string

@description('Principal ID of the application runtime managed identity.')
param appPrincipalId string

// ── Variables ──────────────────────────────────────────────────────────────────

// Storage account names: 3–24 chars, lowercase alphanumeric only
var saName = take(toLower('${replace(appName, '-', '')}${uniqueString(resourceGroup().id)}'), 24)

var containerName = 'artifacts'
var invitationTableName = 'onboardingInvitations'
var sessionTableName = 'onboardingSessions'
var storageTableDataContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
)

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

// ── Durable application state ──────────────────────────────────────────────────

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

resource invitationTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: invitationTableName
}

resource sessionTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: sessionTableName
}

resource invitationTableDataAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(invitationTable.id, appPrincipalId, storageTableDataContributorRoleId)
  scope: invitationTable
  properties: {
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageTableDataContributorRoleId
  }
}

resource sessionTableDataAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sessionTable.id, appPrincipalId, storageTableDataContributorRoleId)
  scope: sessionTable
  properties: {
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageTableDataContributorRoleId
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────

@description('Storage account name.')
output accountName string = storageAccount.name

@description('Azure Table service endpoint.')
output tableEndpoint string = storageAccount.properties.primaryEndpoints.table

@description('Invitation table name.')
output invitationTableName string = invitationTable.name

@description('Express session table name.')
output sessionTableName string = sessionTable.name
