#Requires -Version 7.0
<#
.SYNOPSIS
Previews or explicitly applies the v2 manager app-role definitions and group assignments.

.DESCRIPTION
This script uses the Azure CLI system-browser login by default and performs
read-only discovery unless both -ConfirmAssignments and a successful
ShouldProcess approval permit a change. -WhatIf always previews without writes.
It preserves unrelated app roles and existing assignments, never creates a
service principal, and stops on any failed Graph request.

The Azure CLI client must already have consent for the delegated directory
permissions needed by the selected operation. The read-only prerequisite uses
User.Read and Group.Read.All. Applying changes additionally requires the
separately authorized write permissions for application role and app-role
assignment updates. This script does not grant consent.

.PARAMETER ReuseExistingLogin
Reuse the current Azure CLI login after verifying the tenant, account, and
Microsoft Graph /me identity.

.PARAMETER UseDeviceCode
Explicitly use Azure CLI device-code authentication instead of the default
system browser. There is no automatic fallback; tenant Conditional Access or
location policy may disallow this flow.

.PARAMETER ExistingWriteConsentConfirmed
Attest that the Azure CLI client already has separately authorized directory
write consent for an apply. This does not grant or verify consent automatically.

.PARAMETER ConfirmAssignments
Permit changes after review. Without this switch, the script performs discovery
and prints a no-write plan.
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory = $true)]
    [string]$TenantId,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedAccount,

    [Parameter(Mandatory = $true)]
    [string]$ManagerAppClientId,

    [Parameter(Mandatory = $true)]
    [string]$AdminGroupId,

    [Parameter(Mandatory = $true)]
    [string]$UsersGroupId,

    [string]$AdminRoleValue = 'VerifiedId.Onboarding.Admin',

    [string]$UserRoleValue = 'VerifiedId.Onboarding.User',

    [Guid]$AdminRoleId = '5f7f9a56-2d8f-4f50-9f44-7dc5a77d5e91',

    [Guid]$UserRoleId = 'e4fb7f7f-0d17-4e0d-8f53-4e6d7f0f4f88',

    [switch]$ReuseExistingLogin,

    [switch]$UseDeviceCode,

    [switch]$ExistingWriteConsentConfirmed,

    [switch]$ConfirmAssignments,

    [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'helpers/manager-app-role-bootstrap.ps1')

foreach ($input in @(
    @{ Name = 'TenantId'; Value = $TenantId },
    @{ Name = 'ManagerAppClientId'; Value = $ManagerAppClientId },
    @{ Name = 'AdminGroupId'; Value = $AdminGroupId },
    @{ Name = 'UsersGroupId'; Value = $UsersGroupId }
)) {
    if (-not (Test-EntraObjectId -Value $input.Value)) {
        throw "$($input.Name) must be an immutable Entra object ID GUID."
    }
}
if ($AdminRoleId -eq $UserRoleId) {
    throw 'AdminRoleId and UserRoleId must be different stable role IDs.'
}
if ([string]::Equals($AdminRoleValue, $UserRoleValue, [System.StringComparison]::Ordinal)) {
    throw 'AdminRoleValue and UserRoleValue must be different stable role values.'
}
if ([string]::Equals($AdminGroupId, $UsersGroupId, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'AdminGroupId and UsersGroupId must be different security groups.'
}
if ($ReuseExistingLogin -and $UseDeviceCode) {
    throw '-ReuseExistingLogin and -UseDeviceCode cannot be used together.'
}
if ($ConfirmAssignments -and -not $WhatIfPreference -and -not $ExistingWriteConsentConfirmed) {
    throw 'Applying directory changes requires separately confirmed Azure CLI write consent. Use -ExistingWriteConsentConfirmed only after verifying that authorization; it does not grant consent.'
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

    $adminGroup = Resolve-ExactSecurityGroup `
        -Selector $AdminGroupId `
        -Purpose 'administrator' `
        -RequestInvoker $requestInvoker
    $usersGroup = Resolve-ExactSecurityGroup `
        -Selector $UsersGroupId `
        -Purpose 'users' `
        -RequestInvoker $requestInvoker

    $applicationCandidates = @(Get-GraphCollection `
        -Uri "/v1.0/applications?%24filter=appId%20eq%20%27$ManagerAppClientId%27" `
        -RequestInvoker $requestInvoker)
    if ($applicationCandidates.Count -eq 0) {
        throw "Manager app registration with appId '$ManagerAppClientId' was not found."
    }
    if ($applicationCandidates.Count -gt 1) {
        throw "More than one application matched appId '$ManagerAppClientId'; refusing to choose a target."
    }
    $application = $applicationCandidates[0]

    $servicePrincipalCandidates = @(Get-GraphCollection `
        -Uri "/v1.0/servicePrincipals?%24filter=appId%20eq%20%27$ManagerAppClientId%27" `
        -RequestInvoker $requestInvoker)
    if ($servicePrincipalCandidates.Count -gt 1) {
        throw "More than one Enterprise App service principal matched appId '$ManagerAppClientId'; refusing to choose a target."
    }
    $servicePrincipal = if ($servicePrincipalCandidates.Count -eq 1) {
        $servicePrincipalCandidates[0]
    } else {
        $null
    }

    $adminRole = New-ManagerAppRoleDefinition `
        -Id $AdminRoleId `
        -Value $AdminRoleValue `
        -DisplayName 'Verified ID onboarding administrator' `
        -Description 'Can access scoped v2 admin reset operations.'
    $userRole = New-ManagerAppRoleDefinition `
        -Id $UserRoleId `
        -Value $UserRoleValue `
        -DisplayName 'Verified ID onboarding user' `
        -Description 'Can sign in to manager approval and dashboard surfaces; Graph relationships still scope manager and skip-manager actions.'
    $rolePlan = Merge-ManagerAppRoleDefinitions `
        -ExistingRoles @((Get-GraphResponseProperty -Response $application -Name 'appRoles')) `
        -RequiredRoles @($adminRole, $userRole)

    $assignmentPlans = @(
        [pscustomobject]@{
            Purpose = 'administrator'
            Group = $adminGroup
            Role = $adminRole
        },
        [pscustomobject]@{
            Purpose = 'users'
            Group = $usersGroup
            Role = $userRole
        }
    )

    $assignmentStates = foreach ($plan in $assignmentPlans) {
        if ($null -eq $servicePrincipal) {
            [pscustomobject]@{
                Purpose = $plan.Purpose
                GroupId = $plan.Group.Id
                GroupDisplayName = $plan.Group.DisplayName
                RoleId = $plan.Role.id
                RoleValue = $plan.Role.value
                Exists = $false
                Assignment = $null
            }
        } else {
            $state = Get-ManagerAppRoleAssignmentState `
                -GroupId $plan.Group.Id `
                -ResourceServicePrincipalId ([string](Get-GraphResponseProperty -Response $servicePrincipal -Name 'id')) `
                -RoleId ([Guid]$plan.Role.id) `
                -RequestInvoker $requestInvoker
            [pscustomobject]@{
                Purpose = $plan.Purpose
                GroupId = $plan.Group.Id
                GroupDisplayName = $plan.Group.DisplayName
                RoleId = $plan.Role.id
                RoleValue = $plan.Role.value
                Exists = $state.Exists
                Assignment = $state.Assignment
            }
        }
    }

    $preview = [ordered]@{
        TenantId = $identity.TenantId
        Account = $identity.Account
        AccountObjectId = $identity.ObjectId
        Application = [ordered]@{
            ObjectId = [string](Get-GraphResponseProperty -Response $application -Name 'id')
            ClientId = $ManagerAppClientId
            DisplayName = [string](Get-GraphResponseProperty -Response $application -Name 'displayName')
        }
        ServicePrincipal = [ordered]@{
            Present = $null -ne $servicePrincipal
            ObjectId = if ($null -ne $servicePrincipal) {
                [string](Get-GraphResponseProperty -Response $servicePrincipal -Name 'id')
            } else {
                $null
            }
            Action = if ($null -eq $servicePrincipal) {
                'Missing; apply is refused. Create the Enterprise App separately.'
            } else {
                'Preserve existing Enterprise App; no service principal write.'
            }
        }
        PlannedAppRoles = @($rolePlan.Roles)
        AppRolesChanged = [bool]$rolePlan.Changed
        PlannedGroupMappings = @($assignmentStates | ForEach-Object {
            [ordered]@{
                Purpose = $_.Purpose
                GroupDisplayName = $_.GroupDisplayName
                GroupObjectId = $_.GroupId
                RoleValue = $_.RoleValue
                RoleId = $_.RoleId
                AssignmentPresent = [bool]$_.Exists
                Action = if ($_.Exists) { 'No change' } else { 'Create assignment on apply' }
            }
        })
    }

    if ($AsJson) {
        $preview | ConvertTo-Json -Depth 12
    } else {
        Write-Host ''
        Write-Host 'Manager app-role bootstrap plan (no writes performed yet):'
        Write-Host ($preview | ConvertTo-Json -Depth 12)
    }

    if ($null -eq $servicePrincipal -and $ConfirmAssignments -and -not $WhatIfPreference) {
        throw 'Enterprise App service principal is absent. Apply is refused; create it separately with explicit authorization before rerunning.'
    }

    if (-not $ConfirmAssignments -or $WhatIfPreference) {
        Write-Host 'Preview only: no app-role or group-assignment writes were performed.'
        return
    }

    if ($rolePlan.Changed) {
        $applicationId = [string](Get-GraphResponseProperty -Response $application -Name 'id')
        $roleBody = @{ appRoles = @($rolePlan.Roles) } | ConvertTo-Json -Depth 12 -Compress
        if (-not $PSCmdlet.ShouldProcess(
            "application $ManagerAppClientId",
            "Replace only the two managed app-role definitions while preserving unrelated roles"
        )) {
            throw 'App-role definition update was not approved; no group assignments were written.'
        }
        Invoke-AzureCliCommand `
            -Arguments @(
                'rest',
                '--method',
                'PATCH',
                '--url',
                "https://graph.microsoft.com/v1.0/applications/$applicationId",
                '--headers',
                'Content-Type=application/json',
                '--body',
                $roleBody,
                '--output',
                'none'
            ) `
            -CommandInvoker $commandInvoker | Out-Null
        Write-Host 'App-role definitions updated.'
    }

    foreach ($state in $assignmentStates) {
        if ($state.Exists) {
            continue
        }
        $assignmentBody = New-ManagerAppRoleAssignmentBody `
            -GroupId $state.GroupId `
            -ResourceServicePrincipalId ([string](Get-GraphResponseProperty -Response $servicePrincipal -Name 'id')) `
            -RoleId ([Guid]$state.RoleId) |
            ConvertTo-Json -Depth 4 -Compress
        if (-not $PSCmdlet.ShouldProcess(
            "group $($state.GroupId)",
            "Create Enterprise App role assignment $($state.RoleValue)"
        )) {
            throw "Assignment for group '$($state.GroupId)' was not approved; no later writes were performed."
        }
        Invoke-AzureCliCommand `
            -Arguments @(
                'rest',
                '--method',
                'POST',
                '--url',
                "https://graph.microsoft.com/v1.0/groups/$($state.GroupId)/appRoleAssignments",
                '--headers',
                'Content-Type=application/json',
                '--body',
                $assignmentBody,
                '--output',
                'none'
            ) `
            -CommandInvoker $commandInvoker | Out-Null
        Write-Host "Assignment created for $($state.GroupDisplayName) -> $($state.RoleValue)."
    }

    Write-Host 'Manager app-role definitions and group assignments are configured.'
} finally {
    [Environment]::SetEnvironmentVariable($brokerVariable, $originalBrokerValue, 'Process')
    [Environment]::SetEnvironmentVariable($loginExperienceVariable, $originalLoginExperienceValue, 'Process')
}
