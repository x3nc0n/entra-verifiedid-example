#Requires -Version 7.0
<#
.SYNOPSIS
    Bootstraps GitHub Actions Azure authentication with a User-Assigned Managed
    Identity (UAMI) and OIDC federated credentials.

.DESCRIPTION
    Idempotent Azure CLI script that:
      - Ensures the target resource group exists
      - Ensures the deployment UAMI exists
      - Ensures GitHub Actions federated credentials exist for this repository
      - Assigns GitHub Actions RBAC at the resource-group scope
      - Discovers the deployed Container App and ACR in the target resource group
      - Grants the Container App's managed identity AcrPull on that ACR
      - Prints the exact environment-scoped `gh variable set` commands needed by azure/login@v2 and deploy.yml

    This is the one allowed direct `az` mutation path for CI/CD identity
    bootstrap. After it succeeds, infrastructure changes should flow through
    IaC and GitHub Actions only.

.PARAMETER TenantId
    Target Entra tenant ID.

.PARAMETER SubscriptionId
    Target Azure subscription ID.

.PARAMETER ResourceGroupName
    Target application resource group. Created if missing.

.PARAMETER Location
    Azure region for the resource group and UAMI.

.PARAMETER IdentityName
    User-assigned managed identity name.

.PARAMETER GitHubRepository
    Repository in OWNER/REPO format.

.PARAMETER GitHubEnvironments
    GitHub Environments used by deploy jobs. The script creates one federated
    credential per environment subject.

.PARAMETER GitHubBranchRefs
    Additional branch ref subjects to create. Useful for non-environment jobs.

.PARAMETER ContainerAppName
    Optional explicit Container App resource name. If omitted, the script will
    auto-discover a single Container App in the target resource group.

.PARAMETER ContainerRegistryName
    Optional explicit Azure Container Registry resource name. If omitted, the
    script will auto-discover a single registry in the target resource group.

.PARAMETER RoleDefinitionName
    Primary Azure RBAC role assigned to the UAMI at the resource-group scope.

.EXAMPLE
    .\07-bootstrap-github-actions-uami.ps1 `
        -TenantId "<your-tenant-id>" `
        -SubscriptionId "<your-subscription-id>"

.EXAMPLE
    .\07-bootstrap-github-actions-uami.ps1 `
        -TenantId "<your-tenant-id>" `
        -SubscriptionId "<your-subscription-id>" `
        -ResourceGroupName "rg-entra-verifiedid-example" `
        -Location "centralus"
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$TenantId,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F-]{36}$')]
    [string]$SubscriptionId,

    [string]$ResourceGroupName = "rg-entra-verifiedid-example",

    [string]$Location = "centralus",

    [ValidatePattern('^[a-zA-Z0-9-]{3,128}$')]
    [string]$IdentityName = "uami-entra-verifiedid-example-deploy",

    [ValidatePattern('^[^/\s]+/[^/\s]+$')]
    [string]$GitHubRepository = "x3nc0n/entra-verifiedid-example",

    [string[]]$GitHubEnvironments = @("staging", "production"),

    [string[]]$GitHubBranchRefs = @("refs/heads/main"),

    [string]$ContainerAppName = "",

    [string]$ContainerRegistryName = "",

    [ValidateSet("Contributor")]
    [string]$RoleDefinitionName = "Contributor"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot\helpers\common.ps1"
$script:BootstrapCmdlet = $PSCmdlet

function Assert-AzCli {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw "Azure CLI is required. Install it from https://aka.ms/azure-cli and re-run."
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

function Try-Get-AzJson {
    param(
        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    $output = & az @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) {
        $text = ($output | Out-String).Trim()
        if ($text -match 'could not be found|was not found|ResourceNotFound|NotFound') {
            return $null
        }
        throw "Azure CLI failed:`n  az $($Arguments -join ' ')`n$text"
    }

    $text = ($output | Out-String).Trim()
    if (-not $text) {
        return $null
    }

    return $text | ConvertFrom-Json -Depth 20
}

function Ensure-FederatedCredential {
    param(
        [Parameter(Mandatory)]
        [pscustomobject]$Identity,

        [Parameter(Mandatory)]
        [string]$CredentialName,

        [Parameter(Mandatory)]
        [string]$Subject
    )

    $existing = Try-Get-AzJson -Arguments @(
        "identity", "federated-credential", "show",
        "--resource-group", $ResourceGroupName,
        "--identity-name", $Identity.name,
        "--name", $CredentialName,
        "-o", "json"
    )

    $issuer = "https://token.actions.githubusercontent.com"
    $audience = "api://AzureADTokenExchange"

    $matches = $existing -and
        $existing.issuer -eq $issuer -and
        $existing.subject -eq $Subject -and
        @($existing.audiences) -contains $audience

    if ($matches) {
        Write-Success "Federated credential is current: $CredentialName ($Subject)"
        return
    }

    if ($existing -and $script:BootstrapCmdlet.ShouldProcess($CredentialName, "Replace federated credential")) {
        Write-Warning "Federated credential '$CredentialName' differs — recreating"
        Invoke-AzCli -Arguments @(
            "identity", "federated-credential", "delete",
            "--resource-group", $ResourceGroupName,
            "--identity-name", $Identity.name,
            "--name", $CredentialName,
            "--yes"
        ) | Out-Null
    }

    if (-not $existing) {
        Write-Info "Creating federated credential '$CredentialName'"
    }

    if ($script:BootstrapCmdlet.ShouldProcess($CredentialName, "Create federated credential")) {
        Invoke-AzCli -Arguments @(
            "identity", "federated-credential", "create",
            "--resource-group", $ResourceGroupName,
            "--identity-name", $Identity.name,
            "--name", $CredentialName,
            "--issuer", $issuer,
            "--subject", $Subject,
            "--audiences", $audience
        ) -AsJson | Out-Null
        Write-Success "Federated credential ready: $CredentialName ($Subject)"
    }
}

function Get-AzureResource {
    param(
        [Parameter(Mandatory)]
        [string]$ResourceType,

        [string]$ResourceName = "",

        [Parameter(Mandatory)]
        [string]$FriendlyName,

        [Parameter(Mandatory)]
        [string]$ExplicitNameParameter
    )

    if ($ResourceName) {
        return Invoke-AzCli -Arguments @(
            "resource", "show",
            "--resource-group", $ResourceGroupName,
            "--resource-type", $ResourceType,
            "--name", $ResourceName,
            "-o", "json"
        ) -AsJson
    }

    $resources = Invoke-AzCli -Arguments @(
        "resource", "list",
        "--resource-group", $ResourceGroupName,
        "--resource-type", $ResourceType,
        "-o", "json"
    ) -AsJson

    $matches = @($resources)
    if ($matches.Count -eq 0) {
        Write-Warning "No $FriendlyName resources were found in $ResourceGroupName."
        return $null
    }

    if ($matches.Count -gt 1) {
        throw "Found multiple $FriendlyName resources in $ResourceGroupName. Re-run with -$ExplicitNameParameter explicitly set."
    }

    return $matches[0]
}

function Ensure-RoleAssignment {
    param(
        [Parameter(Mandatory)]
        [string]$PrincipalId,

        [Parameter(Mandatory)]
        [string]$RoleName,

        [Parameter(Mandatory)]
        [string]$Scope,

        [Parameter(Mandatory)]
        [string]$TargetDescription
    )

    $existingAssignment = Invoke-AzCli -Arguments @(
        "role", "assignment", "list",
        "--assignee-object-id", $PrincipalId,
        "--role", $RoleName,
        "--scope", $Scope,
        "-o", "json"
    ) -AsJson

    if (@($existingAssignment).Count -gt 0) {
        Write-Success "RBAC already assigned: $RoleName on $TargetDescription"
        return
    }

    if ($PSCmdlet.ShouldProcess($TargetDescription, "Assign $RoleName")) {
        Invoke-AzCli -Arguments @(
            "role", "assignment", "create",
            "--assignee-object-id", $PrincipalId,
            "--assignee-principal-type", "ServicePrincipal",
            "--role", $RoleName,
            "--scope", $Scope
        ) -AsJson | Out-Null
        Write-Success "RBAC assigned: $RoleName on $TargetDescription"
    }
}

Assert-AzCli

Write-StepHeader "07 — GitHub Actions UAMI / OIDC Bootstrap" -Step "07"
Write-Info "Tenant ID:        $TenantId"
Write-Info "Subscription ID:  $SubscriptionId"
Write-Info "Resource group:   $ResourceGroupName"
Write-Info "Location:         $Location"
Write-Info "Identity name:    $IdentityName"
Write-Info "GitHub repo:      $GitHubRepository"

Write-StepHeader "Checking Azure CLI context"

try {
    $null = Invoke-AzCli -Arguments @("account", "show", "-o", "json") -AsJson
} catch {
    throw "Not logged in to Azure CLI. Run: az login --tenant $TenantId"
}

Invoke-AzCli -Arguments @("account", "set", "--subscription", $SubscriptionId) | Out-Null
$account = Invoke-AzCli -Arguments @("account", "show", "-o", "json") -AsJson

if ($account.tenantId -ne $TenantId) {
    throw "Azure CLI is using tenant '$($account.tenantId)', but this bootstrap targets '$TenantId'. Re-run az login against the correct tenant."
}

Write-Success "Azure CLI context ready: $($account.user.name) → $($account.name)"

Write-StepHeader "Ensuring target resource group"

if ($PSCmdlet.ShouldProcess($ResourceGroupName, "Create or update resource group")) {
    $null = Invoke-AzCli -Arguments @(
        "group", "create",
        "--name", $ResourceGroupName,
        "--location", $Location,
        "--tags",
        "project=entra-verifiedid-example",
        "managed-by=07-bootstrap-github-actions-uami.ps1",
        "purpose=github-actions-oidc"
    ) -AsJson
    Write-Success "Resource group ready: $ResourceGroupName"
}

Write-StepHeader "Ensuring deployment managed identity"

$identity = Try-Get-AzJson -Arguments @(
    "identity", "show",
    "--resource-group", $ResourceGroupName,
    "--name", $IdentityName,
    "-o", "json"
)

if (-not $identity) {
    if ($PSCmdlet.ShouldProcess($IdentityName, "Create user-assigned managed identity")) {
        $identity = Invoke-AzCli -Arguments @(
            "identity", "create",
            "--resource-group", $ResourceGroupName,
            "--name", $IdentityName,
            "--location", $Location,
            "--tags",
            "project=entra-verifiedid-example",
            "managed-by=07-bootstrap-github-actions-uami.ps1"
        ) -AsJson
        Write-Success "Managed identity created: $IdentityName"
    }
} else {
    Write-Success "Managed identity already exists: $IdentityName"
}

if (-not $identity) {
    throw "Managed identity details were not available after creation."
}

Write-StepHeader "Ensuring GitHub OIDC federated credentials"

foreach ($environmentName in $GitHubEnvironments) {
    # Braces are required here so PowerShell does not parse $GitHubRepository:environment as a drive-qualified variable.
    Ensure-FederatedCredential `
        -Identity $identity `
        -CredentialName "github-environment-$environmentName" `
        -Subject "repo:${GitHubRepository}:environment:${environmentName}"
}

foreach ($branchRef in $GitHubBranchRefs) {
    $branchName = ($branchRef -replace '^refs/heads/', '') -replace '[^a-zA-Z0-9-]', '-'
    # Braces are required here so PowerShell does not parse $GitHubRepository:ref as a drive-qualified variable.
    Ensure-FederatedCredential `
        -Identity $identity `
        -CredentialName "github-branch-$branchName" `
        -Subject "repo:${GitHubRepository}:ref:${branchRef}"
}

Write-StepHeader "Ensuring resource-group-scoped RBAC"

$scope = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName"
$rbacAdministratorRoleDefinitionId = "f58310d9-a9f6-439a-9e8d-f62e7b41a168"
Ensure-RoleAssignment `
    -PrincipalId ([string]$identity.principalId) `
    -RoleName $RoleDefinitionName `
    -Scope $scope `
    -TargetDescription $scope

# Bicep templates create Microsoft.Authorization/roleAssignments resources
# (e.g. granting AcrPull, Key Vault Secrets User to app identities); the deploy
# identity needs roleAssignments/write to create those, which Contributor alone
# does not grant.
Ensure-RoleAssignment `
    -PrincipalId ([string]$identity.principalId) `
    -RoleName $rbacAdministratorRoleDefinitionId `
    -Scope $scope `
    -TargetDescription $scope

Write-StepHeader "Discovering deployed Container App and ACR"

$containerApp = Get-AzureResource `
    -ResourceType "Microsoft.App/containerApps" `
    -ResourceName $ContainerAppName `
    -FriendlyName "Container App" `
    -ExplicitNameParameter "ContainerAppName"

$containerRegistry = Get-AzureResource `
    -ResourceType "Microsoft.ContainerRegistry/registries" `
    -ResourceName $ContainerRegistryName `
    -FriendlyName "Container Registry" `
    -ExplicitNameParameter "ContainerRegistryName"

$containerAppResourceName = ""
$containerAppPrincipalId = ""
$containerAppFqdn = ""
$registryName = ""
$registryLoginServer = ""
$acrPullScope = ""

if ($containerApp) {
    $containerAppResourceName = [string]$containerApp.name
    $containerAppPrincipalId = [string]$containerApp.identity.principalId
    $containerAppFqdn = [string]$containerApp.properties.configuration.ingress.fqdn
    Write-Success "Container App discovered: $containerAppResourceName"
}

if ($containerRegistry) {
    $registryName = [string]$containerRegistry.name
    $registryLoginServer = [string]$containerRegistry.properties.loginServer
    $acrPullScope = [string]$containerRegistry.id
    Write-Success "Container Registry discovered: $registryName ($registryLoginServer)"
}

if ($containerAppPrincipalId -and $acrPullScope) {
    Write-StepHeader "Ensuring Container App AcrPull RBAC"
    Ensure-RoleAssignment `
        -PrincipalId $containerAppPrincipalId `
        -RoleName "AcrPull" `
        -Scope $acrPullScope `
        -TargetDescription $acrPullScope
} else {
    Write-Warning "Skipped AcrPull assignment because the Container App or ACR could not be resolved."
}

$clientId = [string]$identity.clientId
$principalId = [string]$identity.principalId

Format-Summary -Title "GitHub Actions Azure OIDC Identity" -Values @{
    ResourceGroup   = $ResourceGroupName
    Location        = $Location
    IdentityName    = $IdentityName
    ClientId        = $clientId
    PrincipalId     = $principalId
    TenantId        = $TenantId
    SubscriptionId  = $SubscriptionId
    RoleAssignments = "$RoleDefinitionName @ $scope; Role Based Access Control Administrator ($rbacAdministratorRoleDefinitionId) @ $scope"
    ContainerApp    = $(if ($containerAppResourceName) { $containerAppResourceName } else { "not found" })
    Registry        = $(if ($registryName) { $registryName } else { "not found" })
    AcrPull         = $(if ($acrPullScope -and $containerAppPrincipalId) { "AcrPull @ $acrPullScope" } else { "not assigned" })
}

Write-Host ""
Write-Host "  📋 GitHub Environment variable wiring commands:" -ForegroundColor Cyan
foreach ($environmentName in $GitHubEnvironments) {
    Write-Host "     # Environment: $environmentName" -ForegroundColor DarkCyan
    Write-Host "     gh variable set AZURE_CLIENT_ID --repo $GitHubRepository --env $environmentName --body `"$clientId`"" -ForegroundColor White
    Write-Host "     gh variable set AZURE_TENANT_ID --repo $GitHubRepository --env $environmentName --body `"$TenantId`"" -ForegroundColor White
    Write-Host "     gh variable set AZURE_SUBSCRIPTION_ID --repo $GitHubRepository --env $environmentName --body `"$SubscriptionId`"" -ForegroundColor White
    Write-Host "     gh variable set AZURE_RESOURCE_GROUP --repo $GitHubRepository --env $environmentName --body `"$ResourceGroupName`"" -ForegroundColor White
    if ($containerAppResourceName) {
        Write-Host "     gh variable set AZURE_CONTAINER_APP_NAME --repo $GitHubRepository --env $environmentName --body `"$containerAppResourceName`"" -ForegroundColor White
    }
    if ($containerAppFqdn) {
        Write-Host "     gh variable set AZURE_CONTAINER_APP_FQDN --repo $GitHubRepository --env $environmentName --body `"$containerAppFqdn`"" -ForegroundColor White
    }
    if ($registryName) {
        Write-Host "     gh variable set AZURE_CONTAINER_REGISTRY_NAME --repo $GitHubRepository --env $environmentName --body `"$registryName`"" -ForegroundColor White
    }
    if ($registryLoginServer) {
        Write-Host "     gh variable set AZURE_CONTAINER_REGISTRY_LOGIN_SERVER --repo $GitHubRepository --env $environmentName --body `"$registryLoginServer`"" -ForegroundColor White
    }
    Write-Host ""
}
Write-Host "  ℹ️  No gh secret set commands are required for azure/login OIDC." -ForegroundColor White
Write-Host "  ℹ️  Optional cleanup after verification:" -ForegroundColor White
Write-Host "     gh secret delete AZURE_CLIENT_SECRET --repo $GitHubRepository --yes" -ForegroundColor White
Write-Host ""

return @{
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    IdentityName = $IdentityName
    ClientId = $clientId
    PrincipalId = $principalId
    TenantId = $TenantId
    SubscriptionId = $SubscriptionId
    Scope = $scope
    ContainerAppName = $containerAppResourceName
    ContainerAppFqdn = $containerAppFqdn
    ContainerRegistryName = $registryName
    ContainerRegistryLoginServer = $registryLoginServer
}
