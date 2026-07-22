// ── Parameters ─────────────────────────────────────────────────────────────────

@description('Azure region.')
param location string

@description('Application name prefix.')
param appName string

@description('Azure AD tenant ID.')
param azureTenantId string

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

@description('Log Analytics workspace resource ID for the Container Apps environment.')
param logAnalyticsWorkspaceId string

@description('Key Vault URI.')
param keyVaultUrl string

@description('Azure Container Registry login server used by the deployed app.')
param containerRegistryLoginServer string

@description('Resource ID of the app runtime user-assigned managed identity.')
param appRuntimeManagedIdentityResourceId string

@description('Client ID of the app runtime user-assigned managed identity.')
param appRuntimeManagedIdentityClientId string

@description('Key Vault secret name for the IdentityPass key.')
param kvNameIdentityPass string = 'identitypass-key'

// ── Variables ──────────────────────────────────────────────────────────────────

var containerAppEnvironmentName = '${appName}-cae'
var containerAppName = '${appName}-app'
var logAnalyticsWorkspaceName = last(split(logAnalyticsWorkspaceId, '/'))
var identityPassSecretUri = '${keyVaultUrl}secrets/${kvNameIdentityPass}'

resource logAnalyticsWorkspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

// ── Container Apps Environment ─────────────────────────────────────────────────

resource containerAppEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: containerAppEnvironmentName
  location: location
  tags: {
    project: 'entra-verifiedid-example'
    environment: 'demo'
  }
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsWorkspace.properties.customerId
        sharedKey: logAnalyticsWorkspace.listKeys().primarySharedKey
      }
    }
  }
}

// ── Container App ───────────────────────────────────────────────────────────────

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: containerAppName
  location: location
  tags: {
    project: 'entra-verifiedid-example'
    environment: 'demo'
  }
  identity: {
    type: 'SystemAssigned,UserAssigned'
    userAssignedIdentities: {
      '${appRuntimeManagedIdentityResourceId}': {}
    }
  }
  properties: {
    environmentId: containerAppEnvironment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: containerRegistryLoginServer
          identity: 'system'
        }
      ]
      secrets: [
        {
          name: kvNameIdentityPass
          keyVaultUrl: identityPassSecretUri
          identity: 'system'
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'portal'
          image: 'mcr.microsoft.com/mirror/docker/library/node:20-bookworm-slim'
          command: [
            'node'
          ]
          args: [
            '-e'
            'const http=require("http");const port=Number(process.env.PORT||3000);http.createServer((req,res)=>{res.statusCode=200;res.setHeader("Content-Type","text/plain");res.end(req.url==="/health"?"ok":"Infrastructure is ready. Deploy the real portal image through GitHub Actions.");}).listen(port,"0.0.0.0");'
          ]
          env: [
            { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~20' }
            { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
            { name: 'NODE_ENV', value: 'production' }
            { name: 'AZURE_TENANT_ID', value: azureTenantId }
            { name: 'AZURE_CLIENT_ID', value: appRuntimeManagedIdentityClientId }
            { name: 'VC_ISSUER_AUTHORITY', value: verifiedIdAuthority }
            { name: 'VC_CREDENTIAL_MANIFEST_URL', value: credentialManifestUrl }
            { name: 'VC_CREDENTIAL_TYPE', value: credentialType }
            { name: 'IDENTITYPASS_API_ENDPOINT', value: identityPassEndpoint }
            { name: 'IDENTITYPASS_SUBSCRIPTION_KEY', secretRef: kvNameIdentityPass }
            { name: 'FIDO2_RP_NAME', value: fido2RpName }
            { name: 'FIDO2_RP_ID', value: fido2RpId }
            { name: 'FIDO2_ORIGIN', value: fido2Origin }
            { name: 'KEY_VAULT_URL', value: keyVaultUrl }
            { name: 'DEMO_MODE', value: string(demoMode) }
            { name: 'APPINSIGHTS_INSTRUMENTATIONKEY', value: appInsightsInstrumentationKey }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: appInsightsConnectionString }
            { name: 'ApplicationInsightsAgent_EXTENSION_VERSION', value: '~3' }
          ]
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 2
      }
    }
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────

@description('Container App resource name.')
output containerAppName string = containerApp.name

@description('Auto-generated Container App FQDN.')
output fqdn string = containerApp.properties.configuration.ingress.fqdn

@description('System-assigned managed identity principal ID.')
output principalId string = containerApp.identity.principalId
