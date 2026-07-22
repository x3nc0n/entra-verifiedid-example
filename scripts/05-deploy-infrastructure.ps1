#Requires -Version 7.0
<#
.SYNOPSIS
    Deploys Azure infrastructure for the Entra Verified ID onboarding portal.

.DESCRIPTION
    Idempotent script that:
      - Creates the Azure resource group if it does not exist
      - Checks for Bicep CLI availability; falls back to azuredeploy.json if needed
      - Deploys infra/main.bicep (or the ARM fallback) via New-AzResourceGroupDeployment
      - Waits for deployment completion and surfaces any provisioning errors
      - Retrieves deployment outputs (Container App name/FQDN, Key Vault URI, ACR, App Insights key, runtime UAMI IDs)
      - Stores the Entra ID / Verified ID / IdentityPass / FIDO2 configuration in Key Vault
      - Pushes runtime configuration into the Bicep deployment parameters
      - Leaves Microsoft Graph / Verified ID app-role grants for the post-deploy
        runtime-UAMI permission step (scripts/08-grant-app-uami-graph-permissions.ps1)

    This script does not publish the application image. The first real image
    delivery happens through .github/workflows/deploy.yml (push to main /
    workflow dispatch) or a manual az acr build + az containerapp update flow.

    Run independently or called from bootstrap.ps1.

.PARAMETER ResourceGroupName
    Azure resource group to deploy into
    (default: rg-entra-verifiedid-example).

.PARAMETER Location
    Azure region (default: centralus).

.PARAMETER AppName
    Application name prefix for resource naming (3–20 lowercase alphanumeric chars).

.PARAMETER TenantId
    Azure AD / Entra ID tenant GUID. Required for live runs; omitted by default
    in this public example repo.

.PARAMETER ClientId
    Legacy app registration client ID (output of 01-configure-app-registration.ps1).
    Retained for compatibility; runtime auth now uses the Container App managed identity.

.PARAMETER ClientSecret
    Deprecated. Runtime auth now uses the Container App managed identity, so no
    client secret is required.

.PARAMETER SubscriptionId
    Azure subscription GUID. Required for live runs; omitted by default in
    this public example repo.

.PARAMETER VerifiedIdAuthority
    Verified ID authority DID (output of 02-configure-verified-id.ps1).

.PARAMETER CredentialManifestUrl
    Credential manifest URL (output of script 02).

.PARAMETER CredentialType
    Credential type name (default: VerifiedEmployee).

.PARAMETER IdentityPassEndpoint
    IdentityPass API endpoint (output of script 03; use "demo://simulated" for demo).

.PARAMETER IdentityPassSubscriptionKey
    IdentityPass subscription key as SecureString (leave as empty SecureString for demo).

.PARAMETER Fido2RpId
    FIDO2 relying party ID — typically the public application domain
    (for example: myapp.<env-hash>.centralus.azurecontainerapps.io).

.PARAMETER Fido2Origin
    FIDO2 allowed origin — the full HTTPS URL
    (for example: https://myapp.<env-hash>.centralus.azurecontainerapps.io).

.PARAMETER DemoMode
    Skip real deployments and print what would happen.

.EXAMPLE
    .\05-deploy-infrastructure.ps1 `
        -ResourceGroupName "rg-entra-verifiedid-example" `
        -AppName "entra-vid" `
        -TenantId "<your-tenant-id>" `
        -ClientId "<app-client-id>" `
        -ClientSecret (Read-Host -AsSecureString "Client secret") `
        -SubscriptionId "<your-subscription-id>"

.OUTPUTS
    Hashtable with WebAppUrl, WebAppName, KeyVaultUrl, ResourceGroupName, AppInsightsKey, StorageAccount
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$ResourceGroupName = "rg-entra-verifiedid-example",

    [string]$Location = "centralus",

    [Parameter(Mandatory)]
    [ValidateLength(3, 20)]
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$AppName,

    [AllowEmptyString()]
    [string]$TenantId = "",

    [string]$ClientId = "",

    [System.Security.SecureString]$ClientSecret = $null,

    [AllowEmptyString()]
    [string]$SubscriptionId = "",

    [string]$VerifiedIdAuthority    = "",
    [string]$CredentialManifestUrl  = "",
    [string]$CredentialType         = "VerifiedEmployee",
    [string]$IdentityPassEndpoint   = "demo://simulated",

    [System.Security.SecureString]$IdentityPassSubscriptionKey = $null,

    [string]$Fido2RpId    = "",
    [string]$Fido2Origin  = "",

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

# ── Derived paths ──────────────────────────────────────────────────────────────
$infraRoot     = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".." "infra"))
$bicepFile     = Join-Path $infraRoot "main.bicep"
$armFallback   = Join-Path $infraRoot "azuredeploy.json"
# Append a timestamp to keep deployment names unique while still being traceable
$DEPLOYMENT_NAME = "verifiedid-$AppName-$(Get-Date -Format 'yyyyMMddHHmm')"

# Resolve FIDO2 params — when a real public hostname is not supplied yet, use a
# representative Container Apps hostname shape and update the URL outputs after
# the deployment returns the actual FQDN.
$fido2RpIdValue   = if ($Fido2RpId)   { $Fido2RpId }   else { "$AppName.<env-hash>.$Location.azurecontainerapps.io" }
$fido2OriginValue = if ($Fido2Origin) { $Fido2Origin } else { "https://$fido2RpIdValue" }

# ── Main ───────────────────────────────────────────────────────────────────────
Write-StepHeader "05 — Azure Infrastructure Deployment" -Step "05"
Write-Info "Resource group: $ResourceGroupName"
Write-Info "Location:       $Location"
Write-Info "App name:       $AppName"
Write-Info "Subscription:   $(if ($SubscriptionId) { $SubscriptionId } else { '(not provided)' })"
Write-Info "Deployment:     $DEPLOYMENT_NAME"

if ($DemoMode) {
    Write-Warning "DEMO MODE — no Azure resources will be created"
} else {
    Assert-ExplicitGuidParameter -ParameterName "TenantId" -Value $TenantId
    Assert-ExplicitGuidParameter -ParameterName "SubscriptionId" -Value $SubscriptionId
}

# ── Step 1: Resource Group ─────────────────────────────────────────────────────
Write-StepHeader "Creating / finding resource group"

if (-not $DemoMode) {
    Write-Progress-Step "Resolving resource group '$ResourceGroupName'"
    $rg = Get-AzResourceGroup -Name $ResourceGroupName -ErrorAction SilentlyContinue

    if ($rg) {
        Write-Warning "'$ResourceGroupName' already exists (location: $($rg.Location)) — skipping creation"
    } else {
        Write-Info "Creating resource group '$ResourceGroupName' in $Location"
        if ($PSCmdlet.ShouldProcess($ResourceGroupName, "Create resource group in $Location")) {
            New-AzResourceGroup -Name $ResourceGroupName -Location $Location -Tag @{
                "project"    = "entra-verified-id"
                "managed-by" = "bootstrap.ps1"
                "created-at" = (Get-Date -Format "yyyy-MM-dd")
            } | Out-Null
            Write-Success "Resource group created: $ResourceGroupName"
        }
    }
} else {
    Write-Success "[DEMO] Would ensure resource group: $ResourceGroupName ($Location)"
}

# ── Step 2: Template Selection ─────────────────────────────────────────────────
Write-StepHeader "Selecting deployment template"

$templateFile = $null
$useBicep     = $false

if (Test-Path $bicepFile) {
    Write-Progress-Step "Checking for Bicep CLI"

    # Az PowerShell v8+ can deploy .bicep directly without the Bicep CLI binary.
    # We still check so we can surface a helpful message for older Az versions.
    $bicepCli = $false
    try {
        $null = & bicep --version 2>&1
        if ($LASTEXITCODE -eq 0) { $bicepCli = $true }
    } catch { }

    if (-not $bicepCli) {
        try {
            $null = & az bicep version 2>&1
            if ($LASTEXITCODE -eq 0) { $bicepCli = $true }
        } catch { }
    }

    if ($bicepCli) {
        Write-Success "Bicep CLI found — using infra/main.bicep"
    } else {
        Write-Info "Bicep CLI not in PATH — Az PowerShell will transpile Bicep internally"
        Write-Info "For explicit Bicep CLI install: https://learn.microsoft.com/azure/azure-resource-manager/bicep/install"
    }

    $useBicep     = $true
    $templateFile = $bicepFile

} elseif (Test-Path $armFallback) {
    Write-Info "infra/main.bicep not found — falling back to ARM template: $armFallback"
    $templateFile = $armFallback
} else {
    if ($DemoMode) {
        Write-Warning "[DEMO] No Bicep or ARM template found — would fail in production"
    } else {
        throw "No deployment template found.`n  Expected Bicep: $bicepFile`n  Expected ARM:   $armFallback`nAdd infra/main.bicep or run: az bicep build --file infra/main.bicep"
    }
}

Write-Info "Template: $templateFile"

# ── Step 3: Deploy Template ────────────────────────────────────────────────────
Write-StepHeader "Deploying infrastructure"

$webAppName     = ""
$webAppHostname = ""
$keyVaultUri    = ""
$appInsightsKey = ""
$storageAccount = ""
$containerRegistryName = ""
$containerRegistryLoginServer = ""
$containerAppPrincipalId = ""
$appRuntimeManagedIdentityName = ""
$appRuntimeManagedIdentityClientId = ""
$appRuntimeManagedIdentityPrincipalId = ""

if (-not $DemoMode -and $templateFile) {
    # Build the parameter hashtable — only include optional params when non-empty
    $deployParams = @{
        ResourceGroupName     = $ResourceGroupName
        TemplateFile          = $templateFile
        Name                  = $DEPLOYMENT_NAME
        Mode                  = "Incremental"
        # Template parameters (names must match param declarations in main.bicep)
        location              = $Location
        appName               = $AppName
        azureTenantId         = $TenantId
        credentialType        = $CredentialType
        fido2RpName           = $AppName
        fido2RpId             = $fido2RpIdValue
        fido2Origin           = $fido2OriginValue
        demoMode              = $DemoMode.IsPresent
    }

    # Only include optional Bicep params when values are available
    if ($VerifiedIdAuthority)   { $deployParams['verifiedIdAuthority']   = $VerifiedIdAuthority }
    if ($CredentialManifestUrl) { $deployParams['credentialManifestUrl'] = $CredentialManifestUrl }
    if ($IdentityPassEndpoint -and $IdentityPassEndpoint -ne "demo://simulated") {
        $deployParams['identityPassEndpoint'] = $IdentityPassEndpoint
    }
    if ($PSCmdlet.ShouldProcess($ResourceGroupName, "Deploy '$DEPLOYMENT_NAME'")) {
        Write-Progress-Step "Submitting deployment (this may take 5–10 minutes)..."

        try {
            $deployment = New-AzResourceGroupDeployment @deployParams -ErrorAction Stop

            if ($deployment.ProvisioningState -ne "Succeeded") {
                throw "Deployment finished with unexpected state: $($deployment.ProvisioningState)"
            }

            Write-Success "Deployment succeeded: $DEPLOYMENT_NAME"

            # Extract typed outputs from the deployment result
            $webAppName     = $deployment.Outputs['webAppName']?.Value      ?? ""
            $webAppHostname = $deployment.Outputs['webAppHostname']?.Value  ?? ""
            $keyVaultUri    = $deployment.Outputs['keyVaultUri']?.Value     ?? ""
            $appInsightsKey = $deployment.Outputs['appInsightsKey']?.Value  ?? ""
            $storageAccount = $deployment.Outputs['storageAccountName']?.Value ?? ""
            $containerRegistryName = $deployment.Outputs['containerRegistryName']?.Value ?? ""
            $containerRegistryLoginServer = $deployment.Outputs['containerRegistryLoginServer']?.Value ?? ""
            $containerAppPrincipalId = $deployment.Outputs['containerAppPrincipalId']?.Value ?? ""
            $appRuntimeManagedIdentityName = $deployment.Outputs['appRuntimeManagedIdentityName']?.Value ?? ""
            $appRuntimeManagedIdentityClientId = $deployment.Outputs['appRuntimeManagedIdentityClientId']?.Value ?? ""
            $appRuntimeManagedIdentityPrincipalId = $deployment.Outputs['appRuntimeManagedIdentityPrincipalId']?.Value ?? ""

            Write-Info "Container App: $webAppHostname"
            Write-Info "Key Vault:  $keyVaultUri"
            Write-Info "ACR:        $containerRegistryLoginServer"
            if ($containerAppPrincipalId) {
                Write-Info "Container App system-assigned principal: $containerAppPrincipalId"
            }
            if ($appRuntimeManagedIdentityName) {
                Write-Info "Runtime UAMI: $appRuntimeManagedIdentityName"
            }
            if ($appRuntimeManagedIdentityClientId) {
                Write-Info "Runtime UAMI client ID: $appRuntimeManagedIdentityClientId"
            }
            if ($appRuntimeManagedIdentityPrincipalId) {
                Write-Info "Runtime UAMI principal ID: $appRuntimeManagedIdentityPrincipalId"
            }
            if ($appInsightsKey.Length -ge 8) {
                Write-Info "App Insights key: $($appInsightsKey.Substring(0,8))..."
            }

        } catch {
            Write-ErrorMessage "Deployment failed: $($_.Exception.Message)"
            Write-Info "Review deployment errors in the Azure portal:"
            Write-Info "  https://portal.azure.com/#resource/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/deployments"
            throw
        }
    }

} elseif ($DemoMode) {
    Write-Success "[DEMO] Would deploy template '$DEPLOYMENT_NAME' to $ResourceGroupName"
    $webAppName     = "$AppName-app"
    $webAppHostname = "$AppName.demo.$Location.azurecontainerapps.io"
    $keyVaultUri    = "https://kv-$AppName.vault.azure.net/"
    $appInsightsKey = "demo-instrumentation-key-$(New-Guid)"
    $storageAccount = "$($AppName.Replace('-', ''))storage"
    $containerRegistryName = "$($AppName.Replace('-', ''))acr"
    $containerRegistryLoginServer = "$containerRegistryName.azurecr.io"
    $containerAppPrincipalId = "demo-container-app-system-principal"
    $appRuntimeManagedIdentityName = "uami-$AppName-app"
    $appRuntimeManagedIdentityClientId = "demo-runtime-uami-client-id"
    $appRuntimeManagedIdentityPrincipalId = "demo-runtime-uami-principal-id"
}

$webAppUrl = if ($webAppHostname) { "https://$webAppHostname" } else { "https://$AppName.demo.$Location.azurecontainerapps.io" }

if (-not $Fido2RpId -and $webAppHostname) {
    $fido2RpIdValue = $webAppHostname
}

if (-not $Fido2Origin -and $webAppUrl) {
    $fido2OriginValue = $webAppUrl
}

# ── Step 4: Configure Key Vault Secrets ───────────────────────────────────────
Write-StepHeader "Configuring Key Vault secrets"

if (-not $DemoMode -and $keyVaultUri) {
    # Extract vault name from URI: https://kv-name.vault.azure.net/
    $vaultName = ([System.Uri]$keyVaultUri).Host -replace '\.vault\.azure\.net$', ''
    Write-Progress-Step "Writing secrets to Key Vault: $vaultName"

    # These secrets supplement what Bicep already stores during provisioning and
    # preserve the canonical runtime contract generated by bootstrap.ps1.
    $extraSecrets = [ordered]@{
        "azure-tenant-id"               = $TenantId
        "vc-issuer-authority"           = $VerifiedIdAuthority
        "vc-credential-manifest-url"    = $CredentialManifestUrl
        "vc-credential-type"            = $CredentialType
        "identitypass-api-endpoint"     = $IdentityPassEndpoint
        "fido2-rp-name"                 = $AppName
        "fido2-rp-id"                   = $fido2RpIdValue
        "fido2-origin"                  = $fido2OriginValue
        "app-base-url"                  = $webAppUrl
    }
    if ($IdentityPassSubscriptionKey) {
        $extraSecrets["identitypass-key"] = $IdentityPassSubscriptionKey
    }

    foreach ($secretName in $extraSecrets.Keys) {
        if ($PSCmdlet.ShouldProcess("$vaultName/$secretName", "Set Key Vault secret")) {
            try {
                $secretVal = $extraSecrets[$secretName]
                if ($secretVal -isnot [System.Security.SecureString]) {
                    $secretVal = ConvertTo-SecureString ([string]$secretVal) -AsPlainText -Force
                }
                Set-AzKeyVaultSecret -VaultName $vaultName -Name $secretName -SecretValue $secretVal | Out-Null
                Write-Success "Key Vault secret set: $secretName"
            } catch {
                Write-Warning "Could not set Key Vault secret '$secretName': $($_.Exception.Message)"
                Write-Info "Ensure the deployment identity has 'Key Vault Secrets Officer' on $vaultName"
            }
        }
    }
} elseif ($DemoMode) {
    Write-Success "[DEMO] Would configure Key Vault secrets in kv-$AppName"
} else {
    Write-Warning "Key Vault URI not available — skipping secret configuration"
}

# ── Step 5: Runtime UAMI Graph app-role handoff ───────────────────────────────
Write-StepHeader "Runtime UAMI Graph app-role handoff"

if ($DemoMode) {
    Write-Success "[DEMO] Runtime UAMI app-role grants are deferred to scripts/08-grant-app-uami-graph-permissions.ps1"
} elseif ($appRuntimeManagedIdentityPrincipalId) {
    Write-Warning "The runtime app UAMI still needs Microsoft Graph + Verified ID Request Service app-role grants."
    Write-Info "Run scripts/08-grant-app-uami-graph-permissions.ps1 after deployment using the runtime UAMI principal ID below."
    Write-Info "This requires a Microsoft Graph admin-consent-equivalent operator (Global Administrator / Privileged Role Administrator or equivalent app-role assignment rights)."
    Write-Info "Runtime UAMI principal ID: $appRuntimeManagedIdentityPrincipalId"
} else {
    Write-Warning "Runtime UAMI principal ID not available — scripts/08-grant-app-uami-graph-permissions.ps1 will need -IdentityName or -AppRuntimeIdentityPrincipalId."
}

# ── Step 6: Delivery Handoff ───────────────────────────────────────────────────
Write-StepHeader "Application image delivery handoff"

if ($DemoMode) {
    Write-Success "[DEMO] Infrastructure only — application image delivery remains a CI/CD concern"
} elseif ($webAppName) {
    Write-Info "The infrastructure is ready, but this script does not publish the application image."
    Write-Info "First image delivery options:"
    Write-Info "  1. Push to main or run .github/workflows/deploy.yml manually"
    if ($containerRegistryName -and $containerRegistryLoginServer) {
        Write-Info "  2. Manual bootstrap: az acr build --registry $containerRegistryName --image $AppName:manual ."
        Write-Info "     then: az containerapp update --resource-group $ResourceGroupName --name $webAppName --image $containerRegistryLoginServer/$AppName:manual"
    } else {
        Write-Info "  2. Manual bootstrap: az acr build ... then az containerapp update ..."
    }
} else {
    Write-Warning "Container App name not available — unable to print image delivery handoff commands"
}

# ── Output Summary ─────────────────────────────────────────────────────────────
$output = @{
    WebAppUrl         = $webAppUrl
    WebAppName        = $webAppName
    KeyVaultUrl       = $keyVaultUri
    ResourceGroupName = $ResourceGroupName
    AppInsightsKey    = $appInsightsKey
    StorageAccount    = $storageAccount
    ContainerRegistryName = $containerRegistryName
    ContainerRegistryLoginServer = $containerRegistryLoginServer
    ContainerAppPrincipalId = $containerAppPrincipalId
    AppRuntimeManagedIdentityName = $appRuntimeManagedIdentityName
    AppRuntimeManagedIdentityClientId = $appRuntimeManagedIdentityClientId
    AppRuntimeManagedIdentityPrincipalId = $appRuntimeManagedIdentityPrincipalId
}

Format-Summary -Title "Infrastructure Deployment Output" -Values @{
    WebAppUrl         = $webAppUrl
    WebAppName        = $webAppName
    KeyVaultUri       = $keyVaultUri
    ResourceGroupName = $ResourceGroupName
    AppInsightsKey    = if ($appInsightsKey.Length -ge 8) {
                            "$($appInsightsKey.Substring(0, 8))..."
                        } else { $appInsightsKey }
    StorageAccount    = $storageAccount
    ContainerRegistry = $containerRegistryLoginServer
}

Write-Host ""
Write-Host "  📋 Post-Deployment Steps:" -ForegroundColor Cyan
Write-Host "     1. Review the Container App URL: $webAppUrl" -ForegroundColor White
Write-Host "     2. Publish the first real image via .github/workflows/deploy.yml or manual az acr build + az containerapp update" -ForegroundColor White
Write-Host "     3. Re-run the pre-infra bootstrap steps with the actual public URL if you used a placeholder Container Apps FQDN shape" -ForegroundColor White
Write-Host "     4. Upload the DID document to https://$fido2RpIdValue/.well-known/did-configuration.json" -ForegroundColor White
Write-Host ""

return $output
