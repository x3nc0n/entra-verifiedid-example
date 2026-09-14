#Requires -Version 7.0
<#
.SYNOPSIS
Authenticates with the Azure CLI system browser and resolves the security groups used by manager app roles.

.DESCRIPTION
This bootstrap uses the Azure CLI system-browser sign-in and makes only GET
requests through 'az rest'. It verifies the tenant and account from 'az account
show', then verifies the actual signed-in Graph identity with GET /v1.0/me before
resolving the administrator and users security groups by exact display name or
immutable object ID.

It does not update an app registration, create a service principal, assign an
Enterprise App role, create credentials, or change Azure data.
Pre-existing delegated Graph read consent for the Azure CLI client is required.
Interactive authentication can present a new consent prompt: cancel it.
Granting consent is a persistent change requiring separate authorization; this
script cannot suppress or safely complete that prompt on the operator's behalf.
Use scripts/09-configure-manager-app-role-assignments.ps1 only after a separate
authorization for those directory writes.

.PARAMETER TenantId
Immutable Entra tenant ID expected after interactive authentication.

.PARAMETER ExpectedAccount
Exact account expected in the Azure CLI account context. The resulting account
and /me response are validated.

.PARAMETER AdminGroup
Exact display name or immutable object ID of the administrator security group.

.PARAMETER UsersGroup
Exact display name or immutable object ID of the users security group.

.PARAMETER ManagerAppClientId
Optional manager OIDC application client ID. When supplied, it is validated and
included in the printed, separately authorized follow-on command. The app is not
read or changed by this script.

.PARAMETER ReuseExistingLogin
Reuse the current Azure CLI login without starting a new browser sign-in. The
tenant, account, and Graph /me identity are still verified before group reads.

.PARAMETER UseDeviceCode
Explicitly use the Azure CLI device-code flow instead of the default system
browser. This is not automatic fallback; Conditional Access or tenant/location
policy may disallow device-code authentication.

.PARAMETER ExistingConsentConfirmed
Attest that delegated User.Read and Group.Read.All were already approved for the
Azure CLI client in the target tenant. This is not authorization to grant
consent and is not programmatic verification of an existing grant. Consent for
Microsoft Graph PowerShell does not satisfy this Azure CLI prerequisite.

.PARAMETER AsJson
Emit the verified non-secret tenant, account, and group identifiers as JSON.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$TenantId,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedAccount,

    [Parameter(Mandatory = $true)]
    [string]$AdminGroup,

    [Parameter(Mandatory = $true)]
    [string]$UsersGroup,

    [string]$ManagerAppClientId,

    [switch]$ReuseExistingLogin,

    [switch]$UseDeviceCode,

    [switch]$ExistingConsentConfirmed,

    [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $ExistingConsentConfirmed) {
    throw 'Pre-existing User.Read and Group.Read.All consent is required. Verify it separately before using -ExistingConsentConfirmed. Cancel any consent prompt; obtain separate authorization instead.'
}

. (Join-Path $PSScriptRoot 'helpers/manager-app-role-bootstrap.ps1')

if (-not (Test-EntraObjectId -Value $TenantId)) {
    throw 'TenantId must be an immutable Entra tenant ID GUID.'
}
if (-not [string]::IsNullOrWhiteSpace($ManagerAppClientId) -and
    -not (Test-EntraObjectId -Value $ManagerAppClientId)) {
    throw 'ManagerAppClientId must be an application client ID GUID.'
}
if ($ReuseExistingLogin -and $UseDeviceCode) {
    throw '-ReuseExistingLogin and -UseDeviceCode cannot be used together.'
}
$commandInvoker = {
    param([string[]]$Arguments)
    $output = (& az @Arguments 2>&1 | Out-String)
    [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = $output
    }
}

$brokerVariable = 'AZURE_CORE_ENABLE_BROKER_ON_WINDOWS'
$loginExperienceVariable = 'AZURE_CORE_LOGIN_EXPERIENCE_V2'
$originalBrokerValue = [Environment]::GetEnvironmentVariable($brokerVariable, 'Process')
$originalLoginExperienceValue = [Environment]::GetEnvironmentVariable($loginExperienceVariable, 'Process')

try {
    [Environment]::SetEnvironmentVariable($brokerVariable, 'false', 'Process')
    [Environment]::SetEnvironmentVariable($loginExperienceVariable, 'off', 'Process')

    Invoke-AzureCliLogin `
        -TenantId $TenantId `
        -ReuseExistingLogin ([bool]$ReuseExistingLogin) `
        -UseDeviceCode ([bool]$UseDeviceCode) `
        -CommandInvoker $commandInvoker

    $account = ConvertFrom-AzureCliJson `
        -Arguments @('account', 'show', '--output', 'json') `
        -CommandInvoker $commandInvoker
    $profile = ConvertFrom-AzureCliJson `
        -Arguments @('rest', '--method', 'GET', '--url', 'https://graph.microsoft.com/v1.0/me', '--output', 'json') `
        -CommandInvoker $commandInvoker
    $identity = Assert-ExpectedAzureCliIdentity `
        -Account $account `
        -Profile $profile `
        -TenantId $TenantId `
        -ExpectedAccount $ExpectedAccount

    $requestInvoker = {
        param([string]$Uri)
        $graphUrl = if ($Uri -match '^https?://') {
            $Uri
        } else {
            "https://graph.microsoft.com$Uri"
        }
        ConvertFrom-AzureCliJson `
            -Arguments @('rest', '--method', 'GET', '--url', $graphUrl, '--output', 'json') `
            -CommandInvoker $commandInvoker
    }
    $adminGroupResult = Resolve-ExactSecurityGroup `
        -Selector $AdminGroup `
        -Purpose 'administrator' `
        -RequestInvoker $requestInvoker
    $usersGroupResult = Resolve-ExactSecurityGroup `
        -Selector $UsersGroup `
        -Purpose 'users' `
        -RequestInvoker $requestInvoker
} finally {
    [Environment]::SetEnvironmentVariable($brokerVariable, $originalBrokerValue, 'Process')
    [Environment]::SetEnvironmentVariable($loginExperienceVariable, $originalLoginExperienceValue, 'Process')
}

if ([string]::Equals(
    $adminGroupResult.Id,
    $usersGroupResult.Id,
    [System.StringComparison]::OrdinalIgnoreCase
)) {
    throw 'Administrator and users groups must be different security groups.'
}

$result = [ordered]@{
    ReadOnly = $true
    TenantId = $identity.TenantId
    Account = $identity.Account
    AccountObjectId = $identity.ObjectId
    AdminGroup = [ordered]@{
        DisplayName = $adminGroupResult.DisplayName
        ObjectId = $adminGroupResult.Id
    }
    UsersGroup = [ordered]@{
        DisplayName = $usersGroupResult.DisplayName
        ObjectId = $usersGroupResult.Id
    }
}

if ($AsJson) {
    $result | ConvertTo-Json -Depth 4
    return
}

Write-Host ''
Write-Host 'Read-only Microsoft Graph prerequisite check succeeded.'
Write-Host "Tenant:              $($result.TenantId)"
Write-Host "Authenticated account: $($result.Account)"
Write-Host "Administrator group: $($result.AdminGroup.DisplayName) ($($result.AdminGroup.ObjectId))"
Write-Host "Users group:         $($result.UsersGroup.DisplayName) ($($result.UsersGroup.ObjectId))"
Write-Host ''
Write-Host 'No app roles or group assignments were changed.'

if (-not [string]::IsNullOrWhiteSpace($ManagerAppClientId)) {
    Write-Host ''
    Write-Host 'After separate Azure CLI write authorization, reuse this verified login and review with -WhatIf first:'
    Write-Host (
        ".\scripts\09-configure-manager-app-role-assignments.ps1 " +
        "-TenantId '$TenantId' " +
        "-ExpectedAccount '$ExpectedAccount' " +
        "-ManagerAppClientId '$ManagerAppClientId' " +
        "-AdminGroupId '$($result.AdminGroup.ObjectId)' " +
        "-UsersGroupId '$($result.UsersGroup.ObjectId)' " +
        '-ReuseExistingLogin -ConfirmAssignments -WhatIf'
    )
}
