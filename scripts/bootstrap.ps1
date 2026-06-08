#Requires -Version 7.0
<#
.SYNOPSIS
    Master bootstrapping script that orchestrates the full Entra Verified ID
    onboarding portal configuration from scratch.

.DESCRIPTION
    Idempotent orchestration script that runs the full setup sequence:

      Step 01 — App Registration        (01-configure-app-registration.ps1)
      Step 02 — Verified ID             (02-configure-verified-id.ps1)
      Step 03 — IdentityPass            (03-configure-identitypass.ps1)
      Step 04 — FIDO2 / TAP Policy      (04-configure-fido2-policy.ps1)
      Step 05 — Azure Infrastructure    (05-deploy-infrastructure.ps1)
      Step 06 — Demo Data               (06-seed-demo-data.ps1)

    After all steps complete, generates a .env file mapping all collected
    outputs to the environment variable names expected by src/config.js.

    Safe to re-run — all child scripts are idempotent.

.PARAMETER TenantId
    Azure AD / Entra ID tenant GUID (required).

.PARAMETER SubscriptionId
    Azure subscription GUID for infrastructure deployment (required).

.PARAMETER ResourceGroupName
    Azure resource group name (default: rg-verifiedid-demo).

.PARAMETER AppName
    Application name prefix for Azure resources (default: entra-vid).
    Must be 3–20 lowercase alphanumeric characters or hyphens.

.PARAMETER Location
    Azure region for infrastructure deployment (default: eastus).

.PARAMETER DemoMode
    Run in demo mode — all child scripts skip real API calls and use mock
    values. Useful for local development and CI/CD preview environments.

.EXAMPLE
    # Full demo setup — no real Azure resources
    .\bootstrap.ps1 -TenantId "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" `
                    -SubscriptionId "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy" `
                    -DemoMode

.EXAMPLE
    # Production setup
    .\bootstrap.ps1 -TenantId "xxxx" -SubscriptionId "yyyy" `
                    -ResourceGroupName "rg-verifiedid-prod" `
                    -AppName "contoso-vid" `
                    -Location "westeurope"

.EXAMPLE
    # Dry run — preview all changes without applying them
    .\bootstrap.ps1 -TenantId "xxxx" -SubscriptionId "yyyy" -WhatIf

.OUTPUTS
    Writes a .env file to the project root and returns a merged hashtable
    of all collected script outputs.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
    [string]$SubscriptionId,

    [string]$ResourceGroupName = "rg-verifiedid-demo",

    [ValidateLength(3, 20)]
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$AppName = "entra-vid",

    [string]$Location = "eastus",

    [switch]$DemoMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot\helpers\common.ps1"

$startTime = Get-Date

# ── Banner ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║    Entra Verified ID Onboarding Portal — Bootstrap               ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Info "Tenant ID:          $TenantId"
Write-Info "Subscription ID:    $SubscriptionId"
Write-Info "Resource group:     $ResourceGroupName"
Write-Info "App name:           $AppName"
Write-Info "Location:           $Location"
Write-Info "Demo mode:          $($DemoMode.IsPresent)"
Write-Host ""

if ($DemoMode) {
    Write-Warning "Running in DEMO MODE — no real API calls or Azure resources will be created"
}

# ── Propagate common bound parameters to child scripts ─────────────────────────
$passThrough = @{}
if ($PSBoundParameters.ContainsKey('WhatIf'))  { $passThrough['WhatIf']  = $true }
if ($PSBoundParameters.ContainsKey('Verbose')) { $passThrough['Verbose'] = $true }

# ── Prerequisites ──────────────────────────────────────────────────────────────
Write-StepHeader "Prerequisites Check"

# Az module set required by all child scripts
$requiredModules = @(
    @{ Name = "Az.Accounts";                      Purpose = "Azure authentication and context management" }
    @{ Name = "Az.Resources";                     Purpose = "Resource group and ARM/Bicep deployment" }
    @{ Name = "Az.KeyVault";                      Purpose = "Key Vault secret management" }
    @{ Name = "Az.Websites";                      Purpose = "App Service / Web App management" }
    @{ Name = "Microsoft.Graph.Authentication";   Purpose = "Microsoft Graph authentication" }
    @{ Name = "Microsoft.Graph.Applications";     Purpose = "App registration management" }
    @{ Name = "Microsoft.Graph.Identity.SignIns"; Purpose = "Authentication method policy management" }
)

$modulesFailed = $false
foreach ($mod in $requiredModules) {
    Write-Progress-Step "Checking $($mod.Name)"
    if (-not (Get-Module -ListAvailable -Name $mod.Name)) {
        Write-ErrorMessage "$($mod.Name) not installed — $($mod.Purpose)"
        Write-Info "  Install: Install-Module -Name $($mod.Name) -Scope CurrentUser"
        $modulesFailed = $true
    } else {
        $ver = (Get-Module -ListAvailable $mod.Name | Select-Object -First 1).Version
        Write-Success "$($mod.Name) v$ver"
    }
}

if ($modulesFailed) {
    throw "One or more required PowerShell modules are missing. Install them and re-run."
}

# Verify Az login and set correct subscription
try {
    $azCtx = Get-AzContext -ErrorAction Stop
    if (-not $azCtx) { throw "No context" }
    Write-Success "Azure: $($azCtx.Account.Id) → $($azCtx.Subscription.Name)"
} catch {
    throw "Not logged in to Azure. Run: Connect-AzAccount -TenantId '$TenantId'"
}

if ($azCtx.Subscription.Id -ne $SubscriptionId) {
    Write-Progress-Step "Switching to subscription $SubscriptionId"
    Set-AzContext -SubscriptionId $SubscriptionId -ErrorAction Stop | Out-Null
    Write-Success "Subscription set: $SubscriptionId"
}

# Verify Graph login (only needed for real operations)
if (-not $DemoMode) {
    try {
        $graphCtx = Get-MgContext -ErrorAction Stop
        if (-not $graphCtx) { throw "No context" }
        Write-Success "Graph: $($graphCtx.Account) ($($graphCtx.Scopes.Count) scopes)"
    } catch {
        $requiredScopes = @(
            "Application.ReadWrite.All"
            "AppRoleAssignment.ReadWrite.All"
            "DelegatedPermissionGrant.ReadWrite.All"
            "Policy.ReadWrite.AuthenticationMethod"
            "VerifiableCredential.Create.All"
            "UserAuthenticationMethod.ReadWrite.All"
            "User.ReadWrite.All"
            "GroupMember.ReadWrite.All"
        )
        throw "Not logged in to Microsoft Graph. Run:`nConnect-MgGraph -TenantId '$TenantId' -Scopes '$($requiredScopes -join "','")'"
    }
}

Write-Success "All prerequisites satisfied"

# ── Derived values ─────────────────────────────────────────────────────────────
# Build the expected App Service URL from the app name for redirect URI / DID
# registration before the infrastructure step runs. Script 05 updates these.
$expectedAppUrl = "https://$AppName.azurewebsites.net"
$expectedDomain  = "$AppName.azurewebsites.net"

# ── Results collector ──────────────────────────────────────────────────────────
$results    = @{}
$stepErrors = [System.Collections.Generic.List[string]]::new()

# Helper to merge a step result into the collector
function Merge-StepResult {
    param([hashtable]$StepOutput)
    if (-not $StepOutput) { return }
    foreach ($key in $StepOutput.Keys) {
        $results[$key] = $StepOutput[$key]
    }
}

# ── Step 01: App Registration ─────────────────────────────────────────────────
Write-StepHeader "Step 01 — App Registration" -Step "BOOTSTRAP"

try {
    $r01 = & "$PSScriptRoot\01-configure-app-registration.ps1" `
        -TenantId $TenantId `
        -AppServiceUrl $expectedAppUrl `
        -DemoMode:$DemoMode `
        @passThrough

    Merge-StepResult -StepOutput $r01
    Write-Success "Step 01 complete — ClientId: $($r01.ENTRA_CLIENT_ID)"
} catch {
    $msg = "Step 01 (App Registration) failed: $($_.Exception.Message)"
    Write-ErrorMessage $msg
    $stepErrors.Add($msg)
    # App registration is a hard dependency — abort if it fails
    throw "Cannot continue: app registration is required by all subsequent steps."
}

# ── Step 02: Verified ID Configuration ────────────────────────────────────────
Write-StepHeader "Step 02 — Verified ID Configuration" -Step "BOOTSTRAP"

try {
    $r02 = & "$PSScriptRoot\02-configure-verified-id.ps1" `
        -TenantId $TenantId `
        -DidWebDomain $expectedDomain `
        -CredentialManifestBaseUrl $expectedAppUrl `
        -DemoMode:$DemoMode `
        @passThrough

    Merge-StepResult -StepOutput $r02
    Write-Success "Step 02 complete — DID: $($r02.VERIFIED_ID_AUTHORITY_DID)"
} catch {
    $msg = "Step 02 (Verified ID) failed: $($_.Exception.Message)"
    Write-ErrorMessage $msg
    $stepErrors.Add($msg)
    # Non-fatal — continue with remaining steps
}

# ── Step 03: IdentityPass ─────────────────────────────────────────────────────
Write-StepHeader "Step 03 — IdentityPass Configuration" -Step "BOOTSTRAP"

try {
    $r03 = & "$PSScriptRoot\03-configure-identitypass.ps1" `
        -TenantId $TenantId `
        -ResourceGroupName $ResourceGroupName `
        -Location $Location `
        -AppServiceUrl $expectedAppUrl `
        -DemoMode:$DemoMode `
        @passThrough

    Merge-StepResult -StepOutput $r03
    Write-Success "Step 03 complete — DemoMode: $($r03.IDENTITYPASS_DEMO_MODE)"
} catch {
    $msg = "Step 03 (IdentityPass) failed: $($_.Exception.Message)"
    Write-ErrorMessage $msg
    $stepErrors.Add($msg)
}

# ── Step 04: FIDO2 / TAP Policy ───────────────────────────────────────────────
Write-StepHeader "Step 04 — FIDO2 and TAP Policy" -Step "BOOTSTRAP"

try {
    $r04 = & "$PSScriptRoot\04-configure-fido2-policy.ps1" `
        -TenantId $TenantId `
        -DemoMode:$DemoMode `
        @passThrough

    Merge-StepResult -StepOutput $r04
    Write-Success "Step 04 complete — FIDO2: $($r04.FIDO2_POLICY_STATE), TAP: $($r04.TAP_POLICY_STATE)"
} catch {
    $msg = "Step 04 (FIDO2/TAP) failed: $($_.Exception.Message)"
    Write-ErrorMessage $msg
    $stepErrors.Add($msg)
}

# ── Step 05: Deploy Infrastructure ───────────────────────────────────────────
Write-StepHeader "Step 05 — Azure Infrastructure" -Step "BOOTSTRAP"

# Convert the plain-text client secret to SecureString for the infrastructure script
$clientSecretSecure = if ($results.ContainsKey('ENTRA_CLIENT_SECRET') -and $results.ENTRA_CLIENT_SECRET) {
    ConvertTo-SecureString $results.ENTRA_CLIENT_SECRET -AsPlainText -Force
} else {
    ConvertTo-SecureString "demo-placeholder-not-real" -AsPlainText -Force
}

try {
    $r05 = & "$PSScriptRoot\05-deploy-infrastructure.ps1" `
        -ResourceGroupName $ResourceGroupName `
        -Location $Location `
        -AppName $AppName `
        -TenantId $TenantId `
        -ClientId ($results['ENTRA_CLIENT_ID'] ?? "demo-client-id") `
        -ClientSecret $clientSecretSecure `
        -SubscriptionId $SubscriptionId `
        -VerifiedIdAuthority ($results['VERIFIED_ID_AUTHORITY_DID'] ?? "did:web:$expectedDomain") `
        -CredentialManifestUrl ($results['VERIFIED_ID_MANIFEST_URL'] ?? "$expectedAppUrl/v1.0/verifiedid/manifest") `
        -CredentialType ($results['VERIFIED_ID_CREDENTIAL_TYPE'] ?? "EmployeeOnboardingCredential") `
        -IdentityPassEndpoint ($results['IDENTITYPASS_ENDPOINT'] ?? "demo://simulated") `
        -Fido2RpId $expectedDomain `
        -Fido2Origin $expectedAppUrl `
        -DemoMode:$DemoMode `
        @passThrough

    Merge-StepResult -StepOutput $r05
    Write-Success "Step 05 complete — WebApp: $($r05.WebAppUrl)"

    # Update expected URL now that we have the real deployment output
    if ($r05.WebAppUrl) {
        $expectedAppUrl = $r05.WebAppUrl
        $expectedDomain  = ([System.Uri]$expectedAppUrl).Host
    }
} catch {
    $msg = "Step 05 (Infrastructure) failed: $($_.Exception.Message)"
    Write-ErrorMessage $msg
    $stepErrors.Add($msg)
}

# ── Step 06: Demo Data Seeding ────────────────────────────────────────────────
Write-StepHeader "Step 06 — Demo Data Seeding" -Step "BOOTSTRAP"

try {
    $r06 = & "$PSScriptRoot\06-seed-demo-data.ps1" `
        -TenantId $TenantId `
        -WebAppUrl $expectedAppUrl `
        -DemoMode:$DemoMode `
        @passThrough

    Merge-StepResult -StepOutput $r06
    Write-Success "Step 06 complete — Demo data: $($r06.DemoDataPath)"
} catch {
    $msg = "Step 06 (Demo Data) failed: $($_.Exception.Message)"
    Write-ErrorMessage $msg
    $stepErrors.Add($msg)
}

# ── Generate .env ──────────────────────────────────────────────────────────────
Write-StepHeader "Generating .env file"

# Generate a cryptographically random session secret (32 bytes → base64)
$sessionSecret = [System.Convert]::ToBase64String(
    [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
)

# Map all collected outputs to the environment variable names that src/config.js reads
$envValues = @{
    # ── Azure AD / Entra ID ─────────────────────────────────────────────────────
    AZURE_TENANT_ID     = $results['ENTRA_TENANT_ID'] ?? $TenantId
    AZURE_CLIENT_ID     = $results['ENTRA_CLIENT_ID'] ?? ""
    AZURE_CLIENT_SECRET = $results['ENTRA_CLIENT_SECRET'] ?? ""

    # ── Entra Verified ID ────────────────────────────────────────────────────────
    VC_CREDENTIAL_MANIFEST_URL = $results['VERIFIED_ID_MANIFEST_URL'] ?? ""
    VC_CREDENTIAL_TYPE         = $results['VERIFIED_ID_CREDENTIAL_TYPE'] ?? "EmployeeOnboardingCredential"
    VC_ISSUER_AUTHORITY        = $results['VERIFIED_ID_AUTHORITY_DID'] ?? ""

    # ── IdentityPass ─────────────────────────────────────────────────────────────
    IDENTITYPASS_API_ENDPOINT     = $results['IDENTITYPASS_ENDPOINT'] ?? ""
    IDENTITYPASS_SUBSCRIPTION_KEY = $results['IDENTITYPASS_SUBSCRIPTION_KEY'] ?? ""

    # ── FIDO2 / WebAuthn ─────────────────────────────────────────────────────────
    FIDO2_RP_NAME = $AppName
    FIDO2_RP_ID   = $expectedDomain
    FIDO2_ORIGIN  = $expectedAppUrl

    # ── Application ──────────────────────────────────────────────────────────────
    APP_BASE_URL   = $results['WebAppUrl'] ?? $expectedAppUrl
    KEY_VAULT_URL  = $results['KeyVaultUrl'] ?? ""
    SESSION_SECRET = $sessionSecret
    DEMO_MODE      = $DemoMode.IsPresent.ToString().ToLower()
    NODE_ENV       = if ($DemoMode) { "development" } else { "production" }
}

$envPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".." ".env"))

if ($PSCmdlet.ShouldProcess($envPath, "Write .env file")) {
    ConvertTo-EnvFile -Values $envValues -Path $envPath
}

# ── Final Summary ──────────────────────────────────────────────────────────────
$elapsed = (Get-Date) - $startTime

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════════════════╗" -ForegroundColor Magenta
Write-Host "  ║    Bootstrap Complete                                             ║" -ForegroundColor Magenta
Write-Host "  ╚══════════════════════════════════════════════════════════════════╝" -ForegroundColor Magenta

Format-Summary -Title "Bootstrap Results" -Values @{
    TenantId         = $TenantId
    ClientId         = $results['ENTRA_CLIENT_ID'] ?? "(not set)"
    AuthorityDid     = $results['VERIFIED_ID_AUTHORITY_DID'] ?? "(not set)"
    CredentialType   = $results['VERIFIED_ID_CREDENTIAL_TYPE'] ?? "(not set)"
    WebAppUrl        = $results['WebAppUrl'] ?? $expectedAppUrl
    KeyVaultUrl      = $results['KeyVaultUrl'] ?? "(not set)"
    IdentityPassMode = if ($DemoMode) { "demo" } else { $results['IDENTITYPASS_ENDPOINT'] ?? "demo" }
    Fido2State       = $results['FIDO2_POLICY_STATE'] ?? "(not set)"
    TapState         = $results['TAP_POLICY_STATE'] ?? "(not set)"
    DemoDataPath     = $results['DemoDataPath'] ?? "(not seeded)"
    EnvFile          = $envPath
    ElapsedTime      = "$([math]::Round($elapsed.TotalSeconds, 1))s"
}

if ($stepErrors.Count -gt 0) {
    Write-Host ""
    Write-Host "  ⚠️  $($stepErrors.Count) step(s) completed with errors:" -ForegroundColor Yellow
    foreach ($err in $stepErrors) {
        Write-Host "     • $err" -ForegroundColor Yellow
    }
    Write-Host ""
}

Write-Host ""
Write-Host "  📋 Next Steps:" -ForegroundColor Cyan
Write-Host "     1. Review the generated .env file at: $envPath" -ForegroundColor White
Write-Host "     2. Ensure .env is listed in .gitignore — never commit secrets!" -ForegroundColor White
Write-Host "     3. Start the portal:  npm install && npm start" -ForegroundColor White
if (-not $results['WebAppUrl']) {
    Write-Host "     4. Re-run without -DemoMode to provision real Azure infrastructure" -ForegroundColor White
}
Write-Host ""

return $results
