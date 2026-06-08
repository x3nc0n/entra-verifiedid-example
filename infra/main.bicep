targetScope = 'resourceGroup'

// ── Parameters ─────────────────────────────────────────────────────────────────

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Application name prefix used for resource naming.')
@minLength(3)
@maxLength(20)
param appName string = 'entra-vid'

@description('Entra / Azure AD tenant ID.')
param azureTenantId string

@description('App registration client ID.')
param azureClientId string

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

module appService 'modules/app-service.bicep' = {
  name: 'appService'
  params: {
    location: location
    appName: appName
    azureTenantId: azureTenantId
    azureClientId: azureClientId
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
  }
}

module keyVault 'modules/keyvault.bicep' = {
  name: 'keyVault'
  params: {
    location: location
    appName: appName
    webAppPrincipalId: appService.outputs.principalId
  }
}

// ── Update web app with Key Vault URI (requires keyvault to exist first) ───────
// Second pass adds the Key Vault URL so app settings can use KV references
// for secrets (AZURE_CLIENT_SECRET, IDENTITYPASS_SUBSCRIPTION_KEY).
module appServiceKeyVaultUpdate 'modules/app-service.bicep' = {
  name: 'appServiceKeyVaultUpdate'
  params: {
    location: location
    appName: appName
    azureTenantId: azureTenantId
    azureClientId: azureClientId
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
    keyVaultUrl: keyVault.outputs.vaultUri
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────

@description('Web application name.')
output webAppName string = appService.outputs.webAppName

@description('Web application default hostname.')
output webAppHostname string = appService.outputs.defaultHostname

@description('Key Vault URI.')
output keyVaultUri string = keyVault.outputs.vaultUri

@description('Application Insights instrumentation key.')
output appInsightsKey string = monitoring.outputs.instrumentationKey

@description('Storage account name.')
output storageAccountName string = storage.outputs.accountName
