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
      - Retrieves deployment outputs (web app name/URL, Key Vault URI, App Insights key)
      - Stores sensitive values as Key Vault secrets
      - Builds a deployment ZIP and publishes the Node.js application via ZIP deploy

    Run independently or called from bootstrap.ps1.

.PARAMETER ResourceGroupName
    Azure resource group to deploy into.

.PARAMETER Location
    Azure region (default: eastus).

.PARAMETER AppName
    Application name prefix for resource naming (3–20 lowercase alphanumeric chars).

.PARAMETER TenantId
    Azure AD / Entra ID tenant GUID.

.PARAMETER ClientId
    App registration client ID (output of 01-configure-app-registration.ps1).

.PARAMETER ClientSecret
    App registration client secret as a SecureString (output of script 01).

.PARAMETER SubscriptionId
    Azure subscription GUID.

.PARAMETER VerifiedIdAuthority
    Verified ID authority DID (output of 02-configure-verified-id.ps1).

.PARAMETER CredentialManifestUrl
    Credential manifest URL (output of script 02).

.PARAMETER CredentialType
    Credential type name (default: EmployeeOnboardingCredential).

.PARAMETER IdentityPassEndpoint
    IdentityPass API endpoint (output of script 03; use "demo://simulated" for demo).

.PARAMETER IdentityPassSubscriptionKey
    IdentityPass subscription key as SecureString (leave as empty SecureString for demo).

.PARAMETER Fido2RpId
    FIDO2 relying party ID — typically the application domain (e.g. myapp.azurewebsites.net).

.PARAMETER Fido2Origin
    FIDO2 allowed origin — the full HTTPS URL (e.g. https://myapp.azurewebsites.net).

.PARAMETER DemoMode
    Skip real deployments and print what would happen.

.EXAMPLE
    .\05-deploy-infrastructure.ps1 `
        -ResourceGroupName "rg-verifiedid-demo" `
        -AppName "entra-vid" `
        -TenantId "xxxx" `
        -ClientId "yyyy" `
        -ClientSecret (Read-Host -AsSecureString "Client secret") `
        -SubscriptionId "zzzz"

.OUTPUTS
    Hashtable with WebAppUrl, WebAppName, KeyVaultUrl, ResourceGroupName, AppInsightsKey, StorageAccount
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [string]$ResourceGroupName,

    [string]$Location = "eastus",

    [Parameter(Mandatory)]
    [ValidateLength(3, 20)]
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$AppName,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [string]$ClientId,

    [Parameter(Mandatory)]
    [System.Security.SecureString]$ClientSecret,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
    [string]$SubscriptionId,

    [string]$VerifiedIdAuthority    = "",
    [string]$CredentialManifestUrl  = "",
    [string]$CredentialType         = "EmployeeOnboardingCredential",
    [string]$IdentityPassEndpoint   = "demo://simulated",

    [System.Security.SecureString]$IdentityPassSubscriptionKey = $null,

    [string]$Fido2RpId    = "",
    [string]$Fido2Origin  = "",

    [switch]$DemoMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot\helpers\common.ps1"

# ── Derived paths ──────────────────────────────────────────────────────────────
$infraRoot     = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".." "infra"))
$bicepFile     = Join-Path $infraRoot "main.bicep"
$armFallback   = Join-Path $infraRoot "azuredeploy.json"
$projectRoot   = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$deploymentDir = Join-Path $projectRoot ".deployment"

# Append a timestamp to keep deployment names unique while still being traceable
$DEPLOYMENT_NAME = "verifiedid-$AppName-$(Get-Date -Format 'yyyyMMddHHmm')"

# Resolve FIDO2 params — default to the expected App Service domain if not supplied
$fido2RpIdValue   = if ($Fido2RpId)   { $Fido2RpId }   else { "$AppName.azurewebsites.net" }
$fido2OriginValue = if ($Fido2Origin) { $Fido2Origin } else { "https://$AppName.azurewebsites.net" }

# ── Main ───────────────────────────────────────────────────────────────────────
Write-StepHeader "05 — Azure Infrastructure Deployment" -Step "05"
Write-Info "Resource group: $ResourceGroupName"
Write-Info "Location:       $Location"
Write-Info "App name:       $AppName"
Write-Info "Subscription:   $SubscriptionId"
Write-Info "Deployment:     $DEPLOYMENT_NAME"

if ($DemoMode) {
    Write-Warning "DEMO MODE — no Azure resources will be created"
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
        azureClientId         = $ClientId
        azureClientSecret     = $ClientSecret
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
    if ($IdentityPassSubscriptionKey) {
        $deployParams['identityPassSubscriptionKey'] = $IdentityPassSubscriptionKey
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

            Write-Info "Web app:    $webAppHostname"
            Write-Info "Key Vault:  $keyVaultUri"
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
    $webAppName     = "$AppName-webapp"
    $webAppHostname = "$AppName.azurewebsites.net"
    $keyVaultUri    = "https://kv-$AppName.vault.azure.net/"
    $appInsightsKey = "demo-instrumentation-key-$(New-Guid)"
    $storageAccount = "$($AppName.Replace('-', ''))storage"
}

$webAppUrl = if ($webAppHostname) { "https://$webAppHostname" } else { "https://$AppName.azurewebsites.net" }

# ── Step 4: Configure Key Vault Secrets ───────────────────────────────────────
Write-StepHeader "Configuring Key Vault secrets"

if (-not $DemoMode -and $keyVaultUri) {
    # Extract vault name from URI: https://kv-name.vault.azure.net/
    $vaultName = ([System.Uri]$keyVaultUri).Host -replace '\.vault\.azure\.net$', ''
    Write-Progress-Step "Writing secrets to Key Vault: $vaultName"

    # These secrets supplement what Bicep already stores during provisioning
    $extraSecrets = [ordered]@{
        "AzureClientSecret"           = $ClientSecret
    }
    if ($IdentityPassSubscriptionKey) {
        $extraSecrets["IdentityPassSubscriptionKey"] = $IdentityPassSubscriptionKey
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

# ── Step 5: Deploy Application Code ───────────────────────────────────────────
Write-StepHeader "Deploying application code"

if (-not $DemoMode -and $webAppName) {
    $zipPath    = Join-Path $deploymentDir "app.zip"
    $stagingDir = Join-Path $deploymentDir "staging"

    if ($PSCmdlet.ShouldProcess($zipPath, "Create deployment ZIP")) {
        try {
            # Ensure production dependencies are installed
            Write-Progress-Step "Running npm install --omit=dev"
            Push-Location $projectRoot
            try {
                npm install --omit=dev 2>&1 | ForEach-Object { Write-Verbose $_ }
                if ($LASTEXITCODE -ne 0) {
                    Write-Warning "npm install returned exit code $LASTEXITCODE — continuing"
                }
            } finally {
                Pop-Location
            }

            # Create a clean staging directory
            if (Test-Path $stagingDir) { Remove-Item $stagingDir -Recurse -Force }
            New-Item -ItemType Directory -Path $stagingDir -Force | Out-Null

            # Exclude dev-only and sensitive paths from the deployment package
            $excludedTopLevel = @('.git', '.deployment', 'scripts', 'infra', '.azure')
            $excludedFiles    = @('.env', '.env.local', '.env.production', '.gitignore')
            $excludedPatterns = @('*.md', '*.bicep', '*.test.js', 'jest.config*', '.eslintrc*')

            Write-Progress-Step "Staging deployment files"
            Get-ChildItem -Path $projectRoot -Recurse | Where-Object {
                -not $_.PSIsContainer
            } | Where-Object {
                $rel      = $_.FullName.Substring($projectRoot.Length).TrimStart('\', '/')
                $topLevel = $rel.Split([IO.Path]::DirectorySeparatorChar)[0]

                -not ($topLevel -in $excludedTopLevel) -and
                -not ($_.Name -in $excludedFiles) -and
                -not ($excludedPatterns | Where-Object { $_.Name -like $_ })
            } | ForEach-Object {
                $relPath = $_.FullName.Substring($projectRoot.Length).TrimStart('\', '/')
                $dest    = Join-Path $stagingDir $relPath
                $destDir = Split-Path $dest -Parent
                if (-not (Test-Path $destDir)) {
                    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
                }
                Copy-Item $_.FullName -Destination $dest -Force
            }

            # Compress the staging directory
            if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
            Compress-Archive -Path "$stagingDir\*" -DestinationPath $zipPath -CompressionLevel Optimal
            $zipSizeKb = [math]::Round((Get-Item $zipPath).Length / 1KB, 0)
            Write-Success "Deployment ZIP created: $zipSizeKb KB"

        } catch {
            Write-Warning "ZIP creation failed: $($_.Exception.Message)"
            Write-Info "Skipping code deployment — deploy manually or via GitHub Actions"
        } finally {
            # Always clean up the staging directory
            if (Test-Path $stagingDir) { Remove-Item $stagingDir -Recurse -Force -ErrorAction SilentlyContinue }
        }
    }

    if ((Test-Path $zipPath) -and $PSCmdlet.ShouldProcess($webAppName, "Deploy application ZIP")) {
        Write-Progress-Step "Publishing to App Service: $webAppName"
        $deployed = $false

        # Primary: Publish-AzWebApp (Az.Websites module)
        try {
            Publish-AzWebApp `
                -ResourceGroupName $ResourceGroupName `
                -Name $webAppName `
                -ArchivePath $zipPath `
                -Force | Out-Null
            Write-Success "Application deployed: $webAppUrl"
            $deployed = $true
        } catch {
            Write-Warning "Publish-AzWebApp failed: $($_.Exception.Message)"
        }

        # Fallback: az webapp deployment source config-zip (Azure CLI)
        if (-not $deployed) {
            Write-Info "Attempting fallback via Azure CLI..."
            try {
                $azOutput = az webapp deployment source config-zip `
                    --resource-group $ResourceGroupName `
                    --name $webAppName `
                    --src $zipPath 2>&1

                if ($LASTEXITCODE -eq 0) {
                    Write-Success "Application deployed via Azure CLI: $webAppUrl"
                    $deployed = $true
                } else {
                    throw $azOutput
                }
            } catch {
                Write-Warning "Azure CLI deployment also failed: $_"
                Write-Info "Deploy manually:"
                Write-Info "  az webapp deployment source config-zip --resource-group $ResourceGroupName --name $webAppName --src $zipPath"
            }
        }
    }

    # Clean up deployment artefacts
    if (Test-Path $deploymentDir) {
        Remove-Item $deploymentDir -Recurse -Force -ErrorAction SilentlyContinue
    }

} elseif ($DemoMode) {
    Write-Success "[DEMO] Would package and deploy application to: $webAppName"
} else {
    Write-Warning "Web app name not available — skipping code deployment"
}

# ── Output Summary ─────────────────────────────────────────────────────────────
$output = @{
    WebAppUrl         = $webAppUrl
    WebAppName        = $webAppName
    KeyVaultUrl       = $keyVaultUri
    ResourceGroupName = $ResourceGroupName
    AppInsightsKey    = $appInsightsKey
    StorageAccount    = $storageAccount
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
}

Write-Host ""
Write-Host "  📋 Post-Deployment Steps:" -ForegroundColor Cyan
Write-Host "     1. Verify the app is running: $webAppUrl" -ForegroundColor White
Write-Host "     2. Configure the custom domain and SSL certificate (if needed)" -ForegroundColor White
Write-Host "     3. Upload the DID document to https://$fido2RpIdValue/.well-known/did-configuration.json" -ForegroundColor White
Write-Host ""

return $output
