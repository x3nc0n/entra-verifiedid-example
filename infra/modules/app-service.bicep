// ── Parameters ─────────────────────────────────────────────────────────────────

@description('Azure region.')
param location string

@description('Application name prefix.')
param appName string

@description('Azure AD tenant ID.')
param azureTenantId string

@description('App registration client ID.')
param azureClientId string

@description('Verified ID authority DID.')
param verifiedIdAuthority string

@description('Credential manifest URL.')
param credentialManifestUrl string

@description('Credential type name.')
param credentialType string

@description('IdentityPass endpoint URL.')
param identityPassEndpoint string

@description('FIDO2 relying party display name.')
param fido2RpName string

@description('FIDO2 relying party ID.')
param fido2RpId string

@description('FIDO2 allowed origin.')
param fido2Origin string

@description('Enable demo mode.')
param demoMode bool = true

@description('Application Insights connection string.')
param appInsightsConnectionString string = ''

@description('Application Insights instrumentation key.')
param appInsightsInstrumentationKey string = ''

@description('Key Vault URI (set after Key Vault module runs).')
param keyVaultUrl string = ''

@description('Key Vault secret name for the app credential.')
param kvNameAppCredential string = 'azure-client-secret'

@description('Key Vault secret name for the IdentityPass key.')
param kvNameIdentityPass string = 'identitypass-key'

// ── Variables ──────────────────────────────────────────────────────────────────

var planName = '${appName}-plan'
var webAppName = '${appName}-app'

// ── App Service Plan ───────────────────────────────────────────────────────────

resource appServicePlan 'Microsoft.Web/serverfarms@2023-01-01' = {
  name: planName
  location: location
  tags: {
    project: 'entra-verifiedid-example'
    environment: 'demo'
  }
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

// ── Web App ────────────────────────────────────────────────────────────────────

resource webApp 'Microsoft.Web/sites@2023-01-01' = {
  name: webAppName
  location: location
  tags: {
    project: 'entra-verifiedid-example'
    environment: 'demo'
  }
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: appServicePlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/health'
      appSettings: [
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
        { name: 'NODE_ENV', value: 'production' }
        { name: 'AZURE_TENANT_ID', value: azureTenantId }
        { name: 'AZURE_CLIENT_ID', value: azureClientId }
        // Secrets loaded from Key Vault via managed identity — never stored as plaintext app settings.
        // The bootstrap script (scripts/bootstrap.ps1) seeds these secrets into Key Vault.
        // Key Vault reference format: @Microsoft.KeyVault(SecretUri=https://<vault>.vault.azure.net/secrets/<name>/)
        { name: 'AZURE_CLIENT_SECRET', value: keyVaultUrl != '' ? '@Microsoft.KeyVault(SecretUri=${keyVaultUrl}secrets/${kvNameAppCredential}/)' : '' }
        { name: 'VERIFIED_ID_AUTHORITY', value: verifiedIdAuthority }
        { name: 'CREDENTIAL_MANIFEST_URL', value: credentialManifestUrl }
        { name: 'CREDENTIAL_TYPE', value: credentialType }
        { name: 'IDENTITYPASS_ENDPOINT', value: identityPassEndpoint }
        { name: 'IDENTITYPASS_SUBSCRIPTION_KEY', value: keyVaultUrl != '' ? '@Microsoft.KeyVault(SecretUri=${keyVaultUrl}secrets/${kvNameIdentityPass}/)' : '' }
        { name: 'FIDO2_RP_NAME', value: fido2RpName }
        { name: 'FIDO2_RP_ID', value: fido2RpId }
        { name: 'FIDO2_ORIGIN', value: fido2Origin }
        { name: 'KEY_VAULT_URL', value: keyVaultUrl }
        { name: 'DEMO_MODE', value: string(demoMode) }
        { name: 'APPINSIGHTS_INSTRUMENTATIONKEY', value: appInsightsInstrumentationKey }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
        { name: 'ApplicationInsightsAgent_EXTENSION_VERSION', value: '~3' }
      ]
    }
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────

@description('Web app resource name.')
output webAppName string = webApp.name

@description('Default hostname for the web app.')
output defaultHostname string = webApp.properties.defaultHostName

@description('System-assigned managed identity principal ID.')
output principalId string = webApp.identity.principalId
