#Requires -Version 7.0
<#
.SYNOPSIS
    Grants Microsoft Graph and Verified ID Request Service application
    permissions to the app runtime user-assigned managed identity (UAMI).

.DESCRIPTION
    Idempotent post-deploy script that:
      - Resolves the runtime app UAMI service principal object ID
      - Requires explicit operator confirmation before performing an
        admin-consent-equivalent directory change
      - Grants the runtime UAMI the same app-role set used by the app runtime:
          * Microsoft Graph
            - User.Read.All
            - UserAuthenticationMethod.ReadWrite.All
          * Verified ID Request Service
            - VerifiableCredential.Create.IssueRequest
            - VerifiableCredential.Create.PresentRequest
      - Checks existing app role assignments to avoid duplicates

    This is NOT Azure RBAC. The deploy UAMI must not be used here; the target
    principal is the app runtime UAMI assigned to the Container App.

.PARAMETER TenantId
    Target Entra tenant ID.

.PARAMETER SubscriptionId
    Target Azure subscription ID, used only when resolving the UAMI via Azure CLI.

.PARAMETER ResourceGroupName
    Resource group containing the runtime app UAMI.

.PARAMETER AppName
    App name prefix used by infra/main.bicep. When IdentityName is omitted,
    the script resolves the default runtime UAMI name as "uami-<AppName>-app".

.PARAMETER IdentityName
    Optional explicit runtime UAMI resource name.

.PARAMETER AppRuntimeIdentityPrincipalId
    Optional explicit service principal object ID for the runtime UAMI. When
    omitted, the script resolves it from az identity show.

.PARAMETER GrantAdminConsent
    Required confirmation switch. This script changes Microsoft Graph app role
    assignments and should only be run by an appropriately privileged operator.

.PARAMETER DemoMode
    Skips live Graph mutations and prints what would happen.

.EXAMPLE
    .\08-grant-app-uami-graph-permissions.ps1 `
        -TenantId "<your-tenant-id>" `
        -SubscriptionId "<your-subscription-id>" `
        -ResourceGroupName "rg-entra-verifiedid-example" `
        -AppName "entra-vid" `
        -GrantAdminConsent
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [AllowEmptyString()]
    [string]$TenantId = "",

    [AllowEmptyString()]
    [string]$SubscriptionId = "",

    [string]$ResourceGroupName = "rg-entra-verifiedid-example",

    [ValidateLength(3, 20)]
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$AppName = "entra-vid",

    [AllowEmptyString()]
    [string]$IdentityName = "",

    [AllowEmptyString()]
    [string]$AppRuntimeIdentityPrincipalId = "",

    [switch]$GrantAdminConsent,

    [switch]$DemoMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot\helpers\common.ps1"

function Assert-ExplicitGuidParameter {
    param(
        [Parameter(Mandatory)]
        [string]$ParameterName,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Value
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        $placeholder = if ($ParameterName -eq "TenantId") { "<your-tenant-id>" } else { "<your-subscription-id>" }
        throw "$ParameterName is required for live runs. This public example repo does not ship a default $ParameterName. Pass -$ParameterName $placeholder explicitly."
    }

    if ($Value -notmatch '^[0-9a-fA-F-]{36}$') {
        $placeholder = if ($ParameterName -eq "TenantId") { "<your-tenant-id>" } else { "<your-subscription-id>" }
        throw "$ParameterName must be a GUID. Pass -$ParameterName $placeholder explicitly."
    }
}

$GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000"
$GRAPH_APP_ROLES = @(
    "User.Read.All"
    "UserAuthenticationMethod.ReadWrite.All"
)
$VCS_REQUEST_APP_ID = "3db474b9-6a0c-4840-96ac-1fceb342124f"
$VCS_REQUEST_APP_ROLES = @(
    "VerifiableCredential.Create.IssueRequest"
    "VerifiableCredential.Create.PresentRequest"
)

$resolvedIdentityName = if ($IdentityName) { $IdentityName } else { "uami-$AppName-app" }
$resolvedPrincipalId = $AppRuntimeIdentityPrincipalId

if ($IdentityName -and $IdentityName -notmatch '^[a-zA-Z0-9-]{3,128}$') {
    throw "IdentityName must be 3-128 characters using letters, numbers, or hyphens."
}

if (-not $DemoMode -and $AppRuntimeIdentityPrincipalId -and $AppRuntimeIdentityPrincipalId -notmatch '^[0-9a-fA-F-]{36}$') {
    throw "AppRuntimeIdentityPrincipalId must be a GUID when provided."
}

if ($DemoMode -and $AppRuntimeIdentityPrincipalId -and $AppRuntimeIdentityPrincipalId -notmatch '^[0-9a-fA-F-]{36}$') {
    Write-Info "[DEMO] Ignoring non-GUID AppRuntimeIdentityPrincipalId placeholder and using demo runtime UAMI values."
    $resolvedPrincipalId = ""
}

function Assert-AzCli {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw "Azure CLI is required to resolve the runtime UAMI. Install it from https://aka.ms/azure-cli and re-run."
    }
}

function Invoke-AzCli {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [switch]$AsJson
    )

    $output = & az @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed:`n  az $($Arguments -join ' ')`n$($output | Out-String)"
    }

    $text = ($output | Out-String).Trim()
    if (-not $AsJson) {
        return $text
    }

    if (-not $text) {
        return $null
    }

    return $text | ConvertFrom-Json -Depth 20
}

function Resolve-UamiPrincipal {
    param(
        [Parameter(Mandatory)]
        [string]$Name
    )

    Assert-AzCli

    try {
        $null = Invoke-AzCli -Arguments @("account", "show", "-o", "json") -AsJson
    } catch {
        throw "Not logged in to Azure CLI. Run: az login --tenant $TenantId"
    }

    Invoke-AzCli -Arguments @("account", "set", "--subscription", $SubscriptionId) | Out-Null
    $identity = Invoke-AzCli -Arguments @(
        "identity", "show",
        "--resource-group", $ResourceGroupName,
        "--name", $Name,
        "-o", "json"
    ) -AsJson

    if (-not $identity) {
        throw "Runtime UAMI '$Name' was not found in resource group '$ResourceGroupName'."
    }

    return @{
        Name = [string]$identity.name
        ClientId = [string]$identity.clientId
        PrincipalId = [string]$identity.principalId
        ResourceId = [string]$identity.id
    }
}

function Get-ResourceServicePrincipal {
    param(
        [Parameter(Mandatory)]
        [string]$ResourceAppId
    )

    $resourceSp = Get-MgServicePrincipal -Filter "appId eq '$ResourceAppId'" -Property "id,appId,displayName,appRoles" -ErrorAction Stop | Select-Object -First 1
    if (-not $resourceSp) {
        throw "Service principal for resource app '$ResourceAppId' was not found in this tenant."
    }

    return $resourceSp
}

function Grant-AppRolesToPrincipal {
    param(
        [Parameter(Mandatory)]
        [string]$PrincipalId,

        [Parameter(Mandatory)]
        [object]$ResourceServicePrincipal,

        [Parameter(Mandatory)]
        [string[]]$RoleNames
    )

    $existingAssignments = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $PrincipalId -ErrorAction SilentlyContinue

    $availableRoleNames = @(
        $ResourceServicePrincipal.AppRoles |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_.Value) } |
            Select-Object -ExpandProperty Value
    )

    foreach ($roleName in $RoleNames) {
        $role = $ResourceServicePrincipal.AppRoles | Where-Object { $_.Value -eq $roleName } | Select-Object -First 1
        if (-not $role) {
            $availableRolesText = if ($availableRoleNames.Count -gt 0) { $availableRoleNames -join ', ' } else { '(none exposed)' }
            throw "App role '$roleName' was not found on service principal '$($ResourceServicePrincipal.DisplayName)' (appId $($ResourceServicePrincipal.AppId)). Available roles: $availableRolesText"
        }

        $hasAssignment = $existingAssignments | Where-Object {
            $_.ResourceId -eq $ResourceServicePrincipal.Id -and $_.AppRoleId -eq $role.Id
        }

        if ($hasAssignment) {
            Write-Success "App role already assigned: $roleName"
            continue
        }

        if ($PSCmdlet.ShouldProcess($PrincipalId, "Grant $roleName on $($ResourceServicePrincipal.AppId)")) {
            New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $PrincipalId `
                -PrincipalId $PrincipalId `
                -ResourceId $ResourceServicePrincipal.Id `
                -AppRoleId $role.Id | Out-Null
            Write-Success "Granted app role: $roleName"
        }
    }
}

Write-StepHeader "08 — Runtime App UAMI Graph Permissions" -Step "08"
Write-Info "Tenant ID:       $(if ($TenantId) { $TenantId } else { '(not provided)' })"
Write-Info "Subscription ID: $(if ($SubscriptionId) { $SubscriptionId } else { '(not provided)' })"
Write-Info "Resource group:  $ResourceGroupName"
Write-Info "Runtime UAMI:    $resolvedIdentityName"

Write-Warning "This script performs Microsoft Graph app-role assignments on the runtime app UAMI service principal."
Write-Warning "This is an admin-consent-equivalent directory change. Use a Global Administrator, Privileged Role Administrator, or equivalent app-role assignment authority."

if (-not $DemoMode -and -not $GrantAdminConsent) {
    throw "Refusing to continue without explicit confirmation. Re-run with -GrantAdminConsent after verifying you are targeting the runtime app UAMI (not the deploy UAMI)."
}

if (-not $DemoMode) {
    Assert-ExplicitGuidParameter -ParameterName "TenantId" -Value $TenantId
    Assert-ExplicitGuidParameter -ParameterName "SubscriptionId" -Value $SubscriptionId
    Assert-RequiredScopes -Required @(
        "Application.Read.All"
        "AppRoleAssignment.ReadWrite.All"
    )
}

$runtimeIdentity = $null
if ($resolvedPrincipalId) {
    $runtimeIdentity = @{
        Name = $resolvedIdentityName
        ClientId = ""
        PrincipalId = $resolvedPrincipalId
        ResourceId = ""
    }
} elseif (-not $DemoMode) {
    $runtimeIdentity = Resolve-UamiPrincipal -Name $resolvedIdentityName
    $resolvedPrincipalId = $runtimeIdentity.PrincipalId
} else {
    $runtimeIdentity = @{
        Name = $resolvedIdentityName
        ClientId = "demo-runtime-uami-client-id"
        PrincipalId = "00000000-0000-0000-0000-000000000000"
        ResourceId = "/subscriptions/$(if ($SubscriptionId) { $SubscriptionId } else { '<your-subscription-id>' })/resourceGroups/$ResourceGroupName/providers/Microsoft.ManagedIdentity/userAssignedIdentities/$resolvedIdentityName"
    }
    $resolvedPrincipalId = $runtimeIdentity.PrincipalId
}

if (-not $resolvedPrincipalId) {
    throw "Runtime UAMI principal ID could not be resolved."
}

Write-Info "Target runtime UAMI principal ID: $resolvedPrincipalId"

if ($DemoMode) {
    Write-Success "[DEMO] Would grant Microsoft Graph app roles: $($GRAPH_APP_ROLES -join ', ')"
    Write-Success "[DEMO] Would grant Verified ID Request Service app roles: $($VCS_REQUEST_APP_ROLES -join ', ')"
} else {
    $graphSp = Get-ResourceServicePrincipal -ResourceAppId $GRAPH_APP_ID
    $vcsRequestSp = Get-ResourceServicePrincipal -ResourceAppId $VCS_REQUEST_APP_ID

    Grant-AppRolesToPrincipal -PrincipalId $resolvedPrincipalId -ResourceServicePrincipal $graphSp -RoleNames $GRAPH_APP_ROLES
    Grant-AppRolesToPrincipal -PrincipalId $resolvedPrincipalId -ResourceServicePrincipal $vcsRequestSp -RoleNames $VCS_REQUEST_APP_ROLES
}

Format-Summary -Title "Runtime App UAMI Permission Grant" -Values @{
    RuntimeIdentityName = $runtimeIdentity.Name
    RuntimeIdentityClientId = $runtimeIdentity.ClientId
    RuntimeIdentityPrincipalId = $resolvedPrincipalId
    GraphAppRoles = ($GRAPH_APP_ROLES -join ', ')
    VerifiedIdRequestAppRoles = ($VCS_REQUEST_APP_ROLES -join ', ')
}

return @{
    AppRuntimeManagedIdentityName = $runtimeIdentity.Name
    AppRuntimeManagedIdentityClientId = $runtimeIdentity.ClientId
    AppRuntimeManagedIdentityPrincipalId = $resolvedPrincipalId
    GraphAppRoles = $GRAPH_APP_ROLES
    VerifiedIdRequestAppRoles = $VCS_REQUEST_APP_ROLES
}
