// ── Parameters ─────────────────────────────────────────────────────────────────

@description('Azure region.')
param location string

@description('Application name prefix.')
param appName string

@description('Azure Container Registry SKU.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param sku string = 'Basic'

@description('Principal ID of the application managed identity.')
param appPrincipalId string = ''

// ── Variables ──────────────────────────────────────────────────────────────────

var registryName = take(toLower('${replace(appName, '-', '')}${uniqueString(resourceGroup().id, appName, 'acr')}'), 50)

// ── Azure Container Registry ───────────────────────────────────────────────────

resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: {
    project: 'entra-verifiedid-example'
    environment: 'demo'
  }
  sku: {
    name: sku
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(appPrincipalId)) {
  name: guid(containerRegistry.id, appPrincipalId, 'AcrPull')
  scope: containerRegistry
  properties: {
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────

@description('Azure Container Registry resource ID.')
output registryId string = containerRegistry.id

@description('Azure Container Registry resource name.')
output registryName string = containerRegistry.name

@description('Azure Container Registry login server.')
output loginServer string = containerRegistry.properties.loginServer
