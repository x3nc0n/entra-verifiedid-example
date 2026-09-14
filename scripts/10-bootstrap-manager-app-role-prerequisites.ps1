#Requires -Version 7.0
<#
.SYNOPSIS
Authenticates interactively and resolves the security groups used by manager app roles.

.DESCRIPTION
This bootstrap is read-only. It requests only delegated User.Read and
Group.Read.All, verifies the authenticated tenant and account after sign-in,
and resolves the administrator and users security groups by exact display name
or immutable object ID.

It does not update an app registration, create a service principal, assign an
Enterprise App role, grant consent, create credentials, or change Azure data.
Use scripts/09-configure-manager-app-role-assignments.ps1 only after a separate
authorization for those directory writes.

.PARAMETER TenantId
Immutable Entra tenant ID expected after interactive authentication.

.PARAMETER ExpectedAccount
Exact account expected in the authenticated Microsoft Graph context. Login hints
are not accepted as proof; the resulting context and /me response are validated.

.PARAMETER AdminGroup
Exact display name or immutable object ID of the administrator security group.

.PARAMETER UsersGroup
Exact display name or immutable object ID of the users security group.

.PARAMETER ManagerAppClientId
Optional manager OIDC application client ID. When supplied, it is validated and
included in the printed, separately authorized follow-on command. The app is not
read or changed by this script.

.PARAMETER UseDeviceCode
Use the Microsoft device-code flow instead of opening the interactive browser.
The operator must complete sign-in, MFA, and any consent prompt.

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

    [switch]$UseDeviceCode,

    [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'helpers/manager-app-role-bootstrap.ps1')

if (-not (Test-EntraObjectId -Value $TenantId)) {
    throw 'TenantId must be an immutable Entra tenant ID GUID.'
}
if (-not [string]::IsNullOrWhiteSpace($ManagerAppClientId) -and
    -not (Test-EntraObjectId -Value $ManagerAppClientId)) {
    throw 'ManagerAppClientId must be an application client ID GUID.'
}
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
    throw 'Microsoft.Graph.Authentication is required. Install-Module Microsoft.Graph -Scope CurrentUser.'
}

Import-Module Microsoft.Graph.Authentication

$requiredScopes = @('User.Read', 'Group.Read.All')
$connectParameters = @{
    TenantId = $TenantId
    Scopes = $requiredScopes
    LoginHint = $ExpectedAccount
    ContextScope = 'Process'
    NoWelcome = $true
}
if ($UseDeviceCode) {
    $connectParameters.UseDeviceCode = $true
}

Connect-MgGraph @connectParameters

$context = Get-MgContext
Assert-RequiredGraphScopes -Context $context -RequiredScopes $requiredScopes

$requestInvoker = {
    param([string]$Uri)
    Invoke-MgGraphRequest -Method GET -Uri $Uri -ErrorAction Stop
}
$profile = & $requestInvoker '/v1.0/me?$select=id,userPrincipalName'
$identity = Assert-ExpectedGraphIdentity `
    -Context $context `
    -Profile $profile `
    -TenantId $TenantId `
    -ExpectedAccount $ExpectedAccount

$adminGroupResult = Resolve-ExactSecurityGroup `
    -Selector $AdminGroup `
    -Purpose 'administrator' `
    -RequestInvoker $requestInvoker
$usersGroupResult = Resolve-ExactSecurityGroup `
    -Selector $UsersGroup `
    -Purpose 'users' `
    -RequestInvoker $requestInvoker

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
    Write-Host 'After separate write authorization and a new privileged Graph sign-in, review with -WhatIf first:'
    Write-Host (
        ".\scripts\09-configure-manager-app-role-assignments.ps1 " +
        "-ManagerAppClientId '$ManagerAppClientId' " +
        "-AdminGroupId '$($result.AdminGroup.ObjectId)' " +
        "-UsersGroupId '$($result.UsersGroup.ObjectId)' " +
        '-ConfirmAssignments -WhatIf'
    )
}
