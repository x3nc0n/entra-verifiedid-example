@description('Azure region.')
param location string

@description('Application name prefix.')
param appName string

var identityName = 'uami-${appName}-app'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: {
    project: 'entra-verifiedid-example'
    environment: 'demo'
  }
}

@description('User-assigned managed identity resource ID.')
output resourceId string = identity.id

@description('User-assigned managed identity resource name.')
output name string = identity.name

@description('User-assigned managed identity client ID.')
output clientId string = identity.properties.clientId

@description('User-assigned managed identity principal ID.')
output principalId string = identity.properties.principalId
