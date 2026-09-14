#Requires -Version 7.0
<#
.SYNOPSIS
Discovers and previews/applies the manager app-role bootstrap in one operation.

.DESCRIPTION
This is the public entry point for the manager app-role setup. It first runs the
read-only group and identity prerequisite check, then passes the verified group
IDs to the role-definition and assignment planner.

Without -ConfirmAssignments, or with -WhatIf, no directory writes are allowed.
Applying changes additionally requires -ExistingWriteConsentConfirmed. This
entry point never deploys Azure infrastructure, creates an Enterprise App, or
grants consent.

The numbered scripts 09 and 10 remain supported compatibility/internal entry
points for callers that need the individual phases.
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [string]$TenantId,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedAccount,

    [Parameter(Mandatory = $true)]
    [string]$AdminGroup,

    [Parameter(Mandatory = $true)]
    [string]$UsersGroup,

    [Parameter(Mandatory = $true)]
    [string]$ManagerAppClientId,

    [string]$AdminRoleValue = 'VerifiedId.Onboarding.Admin',

    [string]$UserRoleValue = 'VerifiedId.Onboarding.User',

    [Guid]$AdminRoleId = '5f7f9a56-2d8f-4f50-9f44-7dc5a77d5e91',

    [Guid]$UserRoleId = 'e4fb7f7f-0d17-4e0d-8f53-4e6d7f0f4f88',

    [switch]$ReuseExistingLogin,

    [switch]$UseDeviceCode,

    [switch]$ExistingConsentConfirmed,

    [switch]$ExistingWriteConsentConfirmed,

    [switch]$ConfirmAssignments,

    [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($ReuseExistingLogin -and $UseDeviceCode) {
    throw '-ReuseExistingLogin and -UseDeviceCode cannot be used together.'
}
if ($ConfirmAssignments -and -not $WhatIfPreference -and -not $ExistingWriteConsentConfirmed) {
    throw 'Applying directory changes requires -ExistingWriteConsentConfirmed after separately verifying Azure CLI write authorization.'
}
if (-not $ExistingConsentConfirmed) {
    throw 'Pre-existing Azure CLI Graph read consent is required. Verify it separately, then use -ExistingConsentConfirmed.'
}

$readOnlyScript = Join-Path $PSScriptRoot '10-bootstrap-manager-app-role-prerequisites.ps1'
$assignmentScript = Join-Path $PSScriptRoot '09-configure-manager-app-role-assignments.ps1'

$readArguments = @{
    TenantId = $TenantId
    ExpectedAccount = $ExpectedAccount
    AdminGroup = $AdminGroup
    UsersGroup = $UsersGroup
    ManagerAppClientId = $ManagerAppClientId
    ExistingConsentConfirmed = $true
    AsJson = $true
}
if ($ReuseExistingLogin) {
    $readArguments.ReuseExistingLogin = $true
}
if ($UseDeviceCode) {
    $readArguments.UseDeviceCode = $true
}

$identityJson = & $readOnlyScript @readArguments
if ($LASTEXITCODE -ne 0) {
    throw "Read-only manager app-role prerequisite check failed with exit code $LASTEXITCODE."
}
try {
    $identityResult = ($identityJson -join [Environment]::NewLine) | ConvertFrom-Json -ErrorAction Stop
} catch {
    throw "Read-only manager app-role prerequisite check returned invalid JSON: $($_.Exception.Message)"
}

$assignmentArguments = @{
    TenantId = $TenantId
    ExpectedAccount = $ExpectedAccount
    ManagerAppClientId = $ManagerAppClientId
    AdminGroupId = [string]$identityResult.AdminGroup.ObjectId
    UsersGroupId = [string]$identityResult.UsersGroup.ObjectId
    AdminRoleValue = $AdminRoleValue
    UserRoleValue = $UserRoleValue
    AdminRoleId = $AdminRoleId
    UserRoleId = $UserRoleId
    ExistingWriteConsentConfirmed = $ExistingWriteConsentConfirmed
    ConfirmAssignments = $ConfirmAssignments
    AsJson = $AsJson
    ReuseExistingLogin = $true
}
if ($WhatIfPreference) {
    $assignmentArguments.WhatIf = $true
}

& $assignmentScript @assignmentArguments
