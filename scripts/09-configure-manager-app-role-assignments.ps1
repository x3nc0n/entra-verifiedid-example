<#
.SYNOPSIS
Defines the v2 manager OIDC Enterprise App roles and assigns the pilot security groups.

.DESCRIPTION
This script is intentionally operator-driven. It does not run during deployment.
It configures stable app-role definitions on the manager OIDC app registration and
then maps Entra security groups to those roles on the Enterprise App service
principal:

- JustJohn-SG -> VerifiedId.Onboarding.Admin
- NativeUsers-SG -> VerifiedId.Onboarding.User

Group-based app-role assignment requires an Entra edition that supports assigning
groups to enterprise applications. Nested group membership is not evaluated for
the roles claim; maintain direct membership in the assigned groups.
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
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

    [switch]$ConfirmAssignments
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-GuidValue {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$Value
    )
    if ($Value -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') {
        throw "$Name must be an immutable Entra object ID GUID."
    }
}

function Ensure-MgGraph {
    if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Applications)) {
        throw 'Microsoft.Graph PowerShell modules are required. Install-Module Microsoft.Graph -Scope CurrentUser, then connect with Application.ReadWrite.All, AppRoleAssignment.ReadWrite.All, and Group.Read.All.'
    }
    Import-Module Microsoft.Graph.Applications
    Import-Module Microsoft.Graph.Groups
}

function New-RoleDefinition {
    param(
        [Guid]$Id,
        [string]$Value,
        [string]$DisplayName,
        [string]$Description
    )
    @{
        id = $Id.ToString()
        allowedMemberTypes = @('User')
        description = $Description
        displayName = $DisplayName
        isEnabled = $true
        value = $Value
    }
}

function Merge-AppRole {
    param(
        [array]$ExistingRoles,
        [hashtable]$RequiredRole
    )
    $matchingByValue = @($ExistingRoles | Where-Object { $_.Value -eq $RequiredRole.value })
    if ($matchingByValue.Count -gt 0 -and $matchingByValue[0].Id.ToString() -ne $RequiredRole.id) {
        throw "App role value '$($RequiredRole.value)' already exists with ID '$($matchingByValue[0].Id)'; expected stable ID '$($RequiredRole.id)'. Resolve manually before continuing."
    }
    $others = @($ExistingRoles | Where-Object { $_.Id.ToString() -ne $RequiredRole.id })
    return @($others + $RequiredRole)
}

function Ensure-GroupRoleAssignment {
    param(
        [string]$ResourceServicePrincipalId,
        [string]$GroupId,
        [Guid]$RoleId,
        [string]$RoleValue
    )
    $existing = Get-MgGroupAppRoleAssignment -GroupId $GroupId -All |
        Where-Object {
            $_.ResourceId -eq $ResourceServicePrincipalId -and
            $_.AppRoleId -eq $RoleId
        } |
        Select-Object -First 1
    if ($existing) {
        Write-Host "✓ Group $GroupId is already assigned to $RoleValue"
        return
    }

    if (-not $ConfirmAssignments) {
        throw "Refusing to create app-role assignments without -ConfirmAssignments. Re-run with -ConfirmAssignments after review."
    }

    $body = @{
        principalId = $GroupId
        resourceId = $ResourceServicePrincipalId
        appRoleId = $RoleId.ToString()
    }
    if ($PSCmdlet.ShouldProcess("group $GroupId", "Assign Enterprise App role $RoleValue")) {
        New-MgGroupAppRoleAssignment -GroupId $GroupId -BodyParameter $body | Out-Null
        Write-Host "✓ Assigned group $GroupId to $RoleValue"
    }
}

Assert-GuidValue -Name 'ManagerAppClientId' -Value $ManagerAppClientId
Assert-GuidValue -Name 'AdminGroupId' -Value $AdminGroupId
Assert-GuidValue -Name 'UsersGroupId' -Value $UsersGroupId
Ensure-MgGraph

$application = Get-MgApplication -Filter "appId eq '$ManagerAppClientId'" -Property 'id,appId,displayName,appRoles' |
    Select-Object -First 1
if (-not $application) {
    throw "Manager app registration with appId '$ManagerAppClientId' was not found."
}

$servicePrincipal = Get-MgServicePrincipal -Filter "appId eq '$ManagerAppClientId'" -Property 'id,appId,displayName,appRoles' |
    Select-Object -First 1
if (-not $servicePrincipal) {
    if ($PSCmdlet.ShouldProcess($application.DisplayName, 'Create Enterprise App service principal')) {
        $servicePrincipal = New-MgServicePrincipal -AppId $ManagerAppClientId
    }
}

$adminRole = New-RoleDefinition `
    -Id $AdminRoleId `
    -Value $AdminRoleValue `
    -DisplayName 'Verified ID onboarding administrator' `
    -Description 'Can access scoped v2 admin reset operations.'
$userRole = New-RoleDefinition `
    -Id $UserRoleId `
    -Value $UserRoleValue `
    -DisplayName 'Verified ID onboarding user' `
    -Description 'Can sign in to manager approval and dashboard surfaces; Graph relationships still scope manager and skip-manager actions.'

$mergedRoles = Merge-AppRole -ExistingRoles @($application.AppRoles) -RequiredRole $adminRole
$mergedRoles = Merge-AppRole -ExistingRoles $mergedRoles -RequiredRole $userRole

if ($PSCmdlet.ShouldProcess($application.DisplayName, 'Update manager OIDC app-role definitions')) {
    Update-MgApplication -ApplicationId $application.Id -AppRoles $mergedRoles
    Write-Host "✓ App-role definitions are present on $($application.DisplayName)"
}

Ensure-GroupRoleAssignment `
    -ResourceServicePrincipalId $servicePrincipal.Id `
    -GroupId $AdminGroupId `
    -RoleId $AdminRoleId `
    -RoleValue $AdminRoleValue
Ensure-GroupRoleAssignment `
    -ResourceServicePrincipalId $servicePrincipal.Id `
    -GroupId $UsersGroupId `
    -RoleId $UserRoleId `
    -RoleValue $UserRoleValue

Write-Host ''
Write-Host 'Review in Entra admin center: Enterprise applications -> app -> Users and groups.'
Write-Host 'Confirm assigned groups are direct groups and that nested group membership is not relied upon.'
