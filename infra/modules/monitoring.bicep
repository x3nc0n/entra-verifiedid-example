// ── Parameters ─────────────────────────────────────────────────────────────────

@description('Azure region.')
param location string

@description('Application name prefix.')
param appName string

// ── Variables ──────────────────────────────────────────────────────────────────

var lawName = '${appName}-law'
var appInsightsName = '${appName}-ai'

// ── Log Analytics Workspace ────────────────────────────────────────────────────

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: lawName
  location: location
  tags: {
    project: 'entra-verifiedid-example'
    environment: 'demo'
  }
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

// ── Application Insights ───────────────────────────────────────────────────────

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  tags: {
    project: 'entra-verifiedid-example'
    environment: 'demo'
  }
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    RetentionInDays: 30
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// ── Outputs ────────────────────────────────────────────────────────────────────

@description('Application Insights instrumentation key.')
output instrumentationKey string = appInsights.properties.InstrumentationKey

@description('Application Insights connection string.')
output connectionString string = appInsights.properties.ConnectionString

@description('Log Analytics workspace resource ID.')
output workspaceId string = logAnalytics.id

@description('Log Analytics workspace resource ID for downstream modules.')
output logAnalyticsWorkspaceId string = logAnalytics.id
