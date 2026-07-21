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

// ── Outputs ────────────────────────────────────────────────────────────────────

@description('Azure Container Registry resource ID.')
output registryId string = containerRegistry.id

@description('Azure Container Registry resource name.')
output registryName string = containerRegistry.name

@description('Azure Container Registry login server.')
output loginServer string = containerRegistry.properties.loginServer
