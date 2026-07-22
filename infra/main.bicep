targetScope = 'resourceGroup'

// ── Parameters ─────────────────────────────────────────────────────────────────

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Azure region for the Container Apps managed environment and Container App. Defaults to the same region as everything else, but can be overridden independently if that specific region lacks Container Apps capacity.')
param containerAppLocation string = location

@description('Application name prefix used for resource naming.')
@minLength(3)
@maxLength(20)
param appName string = 'entra-vid'

@description('Entra / Azure AD tenant ID.')
param azureTenantId string

@description('Verified ID authority DID.')
param verifiedIdAuthority string = ''

@description('Credential manifest URL.')
param credentialManifestUrl string = ''

@description('Credential type name.')
param credentialType string = 'VerifiedEmployee'

@description('IdentityPass endpoint URL.')
param identityPassEndpoint string = ''

@description('FIDO2 relying party display name.')
param fido2RpName string = 'Entra Verified ID Demo'

@description('FIDO2 relying party ID (domain). Set after deployment via app settings.')
param fido2RpId string = ''

@description('FIDO2 allowed origin. Set after deployment via app settings.')
param fido2Origin string = ''

@description('Enable demo mode (loosened auth for demo purposes).')
param demoMode bool = true

@description('Azure Container Registry SKU for runtime images.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param containerRegistrySku string = 'Basic'

// ── Modules ────────────────────────────────────────────────────────────────────

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    location: location
    appName: appName
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    location: location
    appName: appName
  }
}

module keyVault 'modules/keyvault.bicep' = {
  name: 'keyVault'
  params: {
    location: location
    appName: appName
  }
}

module appRuntimeIdentity 'modules/user-assigned-identity.bicep' = {
  name: 'appRuntimeIdentity'
  params: {
    location: location
    appName: appName
  }
}

module containerApp 'modules/container-app.bicep' = {
  name: 'containerApp'
  params: {
    location: containerAppLocation
    appName: appName
    azureTenantId: azureTenantId
    verifiedIdAuthority: verifiedIdAuthority
    credentialManifestUrl: credentialManifestUrl
    credentialType: credentialType
    identityPassEndpoint: identityPassEndpoint
    fido2RpName: fido2RpName
    fido2RpId: fido2RpId
    fido2Origin: fido2Origin
    demoMode: demoMode
    appInsightsConnectionString: monitoring.outputs.connectionString
    appInsightsInstrumentationKey: monitoring.outputs.instrumentationKey
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsWorkspaceId
    keyVaultUrl: keyVault.outputs.vaultUri
    appRuntimeManagedIdentityResourceId: appRuntimeIdentity.outputs.resourceId
    appRuntimeManagedIdentityClientId: appRuntimeIdentity.outputs.clientId
  }
}

module keyVaultAccess 'modules/keyvault.bicep' = {
  name: 'keyVaultAccess'
  params: {
    location: location
    appName: appName
    appPrincipalId: containerApp.outputs.principalId
  }
}

module containerRegistry 'modules/container-registry.bicep' = {
  name: 'containerRegistry'
  params: {
    location: location
    appName: appName
    sku: containerRegistrySku
    appPrincipalId: containerApp.outputs.principalId
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────

@description('Container App resource name.')
output webAppName string = containerApp.outputs.containerAppName

@description('Container App hostname.')
output webAppHostname string = containerApp.outputs.fqdn

@description('Key Vault URI.')
output keyVaultUri string = keyVault.outputs.vaultUri

@description('Application Insights instrumentation key.')
output appInsightsKey string = monitoring.outputs.instrumentationKey

@description('Storage account name.')
output storageAccountName string = storage.outputs.accountName

@description('Azure Container Registry resource name.')
output containerRegistryName string = containerRegistry.outputs.registryName

@description('Azure Container Registry login server.')
output containerRegistryLoginServer string = containerRegistry.outputs.loginServer

@description('Container App managed identity principal ID.')
output containerAppPrincipalId string = containerApp.outputs.principalId

@description('App runtime user-assigned managed identity resource name.')
output appRuntimeManagedIdentityName string = appRuntimeIdentity.outputs.name

@description('App runtime user-assigned managed identity client ID.')
output appRuntimeManagedIdentityClientId string = appRuntimeIdentity.outputs.clientId

@description('App runtime user-assigned managed identity principal ID.')
output appRuntimeManagedIdentityPrincipalId string = appRuntimeIdentity.outputs.principalId
