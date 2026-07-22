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
      Step 05b — Runtime UAMI App Roles (08-grant-app-uami-graph-permissions.ps1, opt-in)
      Step 06 — Demo Data               (06-seed-demo-data.ps1)

    After all steps complete, generates a .env file mapping all collected
    outputs to the environment variable names expected by src/config.js.

    Step 05 deploys the Azure infrastructure stack and runtime configuration.
    It does not publish the application image — first image delivery happens
    through .github/workflows/deploy.yml (push to main / workflow dispatch) or
    a manual az acr build + az containerapp update flow.

    Safe to re-run — all child scripts are idempotent.

.PARAMETER TenantId
    Azure AD / Entra ID tenant GUID. Required for live runs; omitted by default
    in this public example repo.

.PARAMETER SubscriptionId
    Azure subscription GUID for infrastructure deployment. Required for live
    runs; omitted by default in this public example repo.

.PARAMETER ResourceGroupName
    Azure resource group name (default: rg-entra-verifiedid-example).

.PARAMETER AppName
    Application name prefix for Azure resources (default: entra-vid).
    Must be 3–20 lowercase alphanumeric characters or hyphens.

.PARAMETER Location
    Azure region for infrastructure deployment (default: centralus).

.PARAMETER AppBaseUrl
    Optional public HTTPS base URL for the deployed portal (custom domain or
    Container Apps FQDN). When omitted, demo runs use a representative
    Container Apps URL shape and real runs should be re-run with the actual
    deployed URL once the first image has been published.

.PARAMETER DemoMode
    Run in demo mode — all child scripts skip real API calls and use mock
    values. Useful for local development and CI/CD preview environments.

.PARAMETER GrantRuntimeManagedIdentityGraphPermissions
    Explicitly opts into the post-deploy Microsoft Graph / Verified ID Request
    Service app-role grant for the runtime app UAMI. This is an
    admin-consent-equivalent directory change and is skipped unless this switch
    is supplied.

.EXAMPLE
    # Full demo setup without real tenant/subscription IDs
    .\bootstrap.ps1 -DemoMode

.EXAMPLE
    # Production setup
    .\bootstrap.ps1 -TenantId "<your-tenant-id>" -SubscriptionId "<your-subscription-id>" `
                    -ResourceGroupName "rg-entra-verifiedid-prod" `
                    -AppName "contoso-vid" `
                    -Location "centralus" `
                    -AppBaseUrl "https://contoso-vid-app.<env-hash>.centralus.azurecontainerapps.io"

.EXAMPLE
    # Dry run — preview all changes without applying them
    .\bootstrap.ps1 -TenantId "<your-tenant-id>" -SubscriptionId "<your-subscription-id>" -WhatIf

.OUTPUTS
    Writes a .env file to the project root and returns a merged hashtable
    of all collected script outputs.
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

    [string]$Location = "centralus",

    [string]$AppBaseUrl = "",

    [switch]$GrantRuntimeManagedIdentityGraphPermissions,

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

function ConvertFrom-SecureValue {
    param([object]$Value)

    if ($null -eq $Value) {
        return ""
    }

    if ($Value -is [System.Security.SecureString]) {
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
        try {
            return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
    }

    return [string]$Value
}

$startTime = Get-Date

# ── Banner ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "  ║    Entra Verified ID Onboarding Portal — Bootstrap               ║" -ForegroundColor Cyan
Write-Host "  ╚══════════════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Info "Tenant ID:          $(if ($TenantId) { $TenantId } else { '(not provided)' })"
Write-Info "Subscription ID:    $(if ($SubscriptionId) { $SubscriptionId } else { '(not provided)' })"
Write-Info "Resource group:     $ResourceGroupName"
Write-Info "App name:           $AppName"
Write-Info "Location:           $Location"
Write-Info "Grant runtime UAMI app roles: $($GrantRuntimeManagedIdentityGraphPermissions.IsPresent)"
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

if (-not $DemoMode) {
    Assert-ExplicitGuidParameter -ParameterName "TenantId" -Value $TenantId
    Assert-ExplicitGuidParameter -ParameterName "SubscriptionId" -Value $SubscriptionId
}

# Az module set required by all child scripts
$requiredModules = @(
    @{ Name = "Az.Accounts";                      Purpose = "Azure authentication and context management" }
    @{ Name = "Az.Resources";                     Purpose = "Resource group and ARM/Bicep deployment" }
    @{ Name = "Az.KeyVault";                      Purpose = "Key Vault secret management" }
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
# Build the expected public URL used by scripts 01–04 before infrastructure
# deployment. Container Apps FQDNs are only known after deployment, so callers
# can provide -AppBaseUrl for real runs; otherwise we fall back to a
# representative Container Apps hostname shape and update to the actual output
# after step 05 completes.
if ($AppBaseUrl) {
    $expectedAppUrl = $AppBaseUrl.TrimEnd('/')
    $expectedDomain = ([System.Uri]$expectedAppUrl).Host
} else {
    $expectedDomain = if ($DemoMode) {
        "$AppName-demo.$Location.azurecontainerapps.io"
    } else {
        "$AppName.<env-hash>.$Location.azurecontainerapps.io"
    }
    $expectedAppUrl = "https://$expectedDomain"
    if (-not $DemoMode) {
        Write-Warning "No -AppBaseUrl supplied. Pre-infrastructure steps will use a placeholder Container Apps FQDN shape until step 05 returns the actual hostname."
    } else {
        Write-Info "[DEMO] No -AppBaseUrl supplied. Using demo-safe placeholder hostname: $expectedDomain"
    }
}

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

# Convert the app-registration output into a SecureString for the infrastructure script.
# Current runtime auth uses managed identity, so this is normally null.
$clientSecretSecure = if ($results.ContainsKey('ENTRA_CLIENT_SECRET') -and $results.ENTRA_CLIENT_SECRET) {
    if ($results.ENTRA_CLIENT_SECRET -is [System.Security.SecureString]) {
        $results.ENTRA_CLIENT_SECRET
    } else {
        ConvertTo-SecureString ([string]$results.ENTRA_CLIENT_SECRET) -AsPlainText -Force
    }
} else {
    $null
}

$identityPassSubscriptionKeySecure = if ($results.ContainsKey('IDENTITYPASS_SUBSCRIPTION_KEY') -and $results.IDENTITYPASS_SUBSCRIPTION_KEY -and $results.IDENTITYPASS_SUBSCRIPTION_KEY -ne 'demo-not-required') {
    ConvertTo-SecureString ([string]$results.IDENTITYPASS_SUBSCRIPTION_KEY) -AsPlainText -Force
} else {
    $null
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
        -CredentialType ($results['VERIFIED_ID_CREDENTIAL_TYPE'] ?? "VerifiedEmployee") `
        -IdentityPassEndpoint ($results['IDENTITYPASS_ENDPOINT'] ?? "demo://simulated") `
        -IdentityPassSubscriptionKey $identityPassSubscriptionKeySecure `
        -Fido2RpId $expectedDomain `
        -Fido2Origin $expectedAppUrl `
        -DemoMode:$DemoMode `
        @passThrough

    Merge-StepResult -StepOutput $r05
    Write-Success "Step 05 complete — Container App URL: $($r05.WebAppUrl)"

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

# ── Step 05b: Runtime UAMI Graph / Verified ID app roles ─────────────────────
Write-StepHeader "Step 05b — Runtime UAMI Graph App Roles" -Step "BOOTSTRAP"

if ($DemoMode) {
    Write-Info "[DEMO] Would grant Graph app roles to runtime UAMI"
} elseif ($GrantRuntimeManagedIdentityGraphPermissions) {
    try {
        $r05b = & "$PSScriptRoot\08-grant-app-uami-graph-permissions.ps1" `
            -TenantId $TenantId `
            -SubscriptionId $SubscriptionId `
            -ResourceGroupName $ResourceGroupName `
            -AppName $AppName `
            -AppRuntimeIdentityPrincipalId ($results['AppRuntimeManagedIdentityPrincipalId'] ?? "") `
            -GrantAdminConsent:$GrantRuntimeManagedIdentityGraphPermissions `
            -DemoMode:$DemoMode `
            @passThrough

        Merge-StepResult -StepOutput $r05b
        Write-Success "Step 05b complete — Runtime UAMI principal: $($r05b.AppRuntimeManagedIdentityPrincipalId)"
    } catch {
        $msg = "Step 05b (Runtime UAMI Graph app roles) failed: $($_.Exception.Message)"
        Write-ErrorMessage $msg
        $stepErrors.Add($msg)
    }
} else {
    Write-Warning "Skipping runtime UAMI app-role grants by default."
    Write-Info "Re-run bootstrap.ps1 with -GrantRuntimeManagedIdentityGraphPermissions after reviewing the target UAMI and signing in with an appropriately privileged Graph operator."
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
    AZURE_CLIENT_ID     = $results['AppRuntimeManagedIdentityClientId'] ?? $results['ENTRA_CLIENT_ID'] ?? ""
    AZURE_CLIENT_SECRET = ConvertFrom-SecureValue ($results['ENTRA_CLIENT_SECRET'] ?? "")
    AZURE_AUTHORITY     = "https://login.microsoftonline.com/$($results['ENTRA_TENANT_ID'] ?? $TenantId)"

    # ── Entra Verified ID ────────────────────────────────────────────────────────
    VC_SERVICE_SCOPE            = "3db474b9-6a0c-4840-96ac-1fceb342124f/.default"
    VC_CREDENTIAL_MANIFEST_URL = $results['VERIFIED_ID_MANIFEST_URL'] ?? ""
    VC_CREDENTIAL_TYPE         = $results['VERIFIED_ID_CREDENTIAL_TYPE'] ?? "VerifiedEmployee"
    VC_ISSUER_AUTHORITY        = $results['VERIFIED_ID_AUTHORITY_DID'] ?? ""

    # ── IdentityPass ─────────────────────────────────────────────────────────────
    IDENTITYPASS_API_ENDPOINT     = $results['IDENTITYPASS_ENDPOINT'] ?? ""
    IDENTITYPASS_SUBSCRIPTION_KEY = $results['IDENTITYPASS_SUBSCRIPTION_KEY'] ?? ""
    IDENTITYPASS_MANAGER_EMAIL    = $results['IDENTITYPASS_MANAGER_EMAIL'] ?? ""

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
    RuntimeClientId  = $results['AppRuntimeManagedIdentityClientId'] ?? $results['ENTRA_CLIENT_ID'] ?? "(not set)"
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
if (-not $DemoMode -and -not $GrantRuntimeManagedIdentityGraphPermissions) {
    Write-Host "     3. Run bootstrap.ps1 again with -GrantRuntimeManagedIdentityGraphPermissions (or run scripts/08-grant-app-uami-graph-permissions.ps1) before real Graph / Verified ID usage" -ForegroundColor White
    Write-Host "     4. Publish the first real image via .github/workflows/deploy.yml (push to main) or manual az acr build + az containerapp update" -ForegroundColor White
    Write-Host "     5. Start the portal locally if needed: npm install && npm start" -ForegroundColor White
} else {
    Write-Host "     3. Publish the first real image via .github/workflows/deploy.yml (push to main) or manual az acr build + az containerapp update" -ForegroundColor White
    Write-Host "     4. Start the portal locally if needed: npm install && npm start" -ForegroundColor White
}
if (-not $DemoMode -and -not $AppBaseUrl) {
    Write-Host "     6. Re-run bootstrap.ps1 with -AppBaseUrl $expectedAppUrl after the first image deploy so steps 01–04 can use the actual Container Apps URL" -ForegroundColor White
} elseif (-not $results['WebAppUrl']) {
    Write-Host "     6. Re-run without -DemoMode to provision real Azure infrastructure" -ForegroundColor White
}
Write-Host ""

return $results
