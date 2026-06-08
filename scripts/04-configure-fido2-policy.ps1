#Requires -Version 7.0
<#
.SYNOPSIS
    Configures FIDO2 security key policy and Temporary Access Pass (TAP) in
    Entra ID authentication methods.

.DESCRIPTION
    Idempotent script that:
      - Enables FIDO2 security keys via the authentication methods policy
      - Configures allowed AAGUIDs for approved hardware key models
      - Enables self-service FIDO2 registration for employees
      - Enables Temporary Access Pass (TAP) for bootstrap/initial onboarding
        (one-time use, short lifetime, scoped to appropriate users)

    FIDO2 policy: PATCH /beta/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/fido2
    TAP policy:   PATCH /beta/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/temporaryAccessPass

.PARAMETER TenantId
    Azure AD / Entra ID tenant GUID.

.PARAMETER TargetGroupId
    Object ID of the group to scope FIDO2 to (blank = all users).

.PARAMETER TapGroupId
    Object ID of the group to scope TAP to (blank = all users).

.PARAMETER TapLifetimeMinutes
    TAP lifetime in minutes (default: 60). Shorter is more secure.

.PARAMETER DemoMode
    Skips real API calls and prints what would happen.

.EXAMPLE
    .\04-configure-fido2-policy.ps1 -TenantId "xxxx"

.EXAMPLE
    # Scope to a specific group (recommended for production)
    .\04-configure-fido2-policy.ps1 -TenantId "xxxx" -TargetGroupId "yyyy" -TapGroupId "zzzz"

.OUTPUTS
    Hashtable with Fido2PolicyStatus, TapPolicyStatus
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
    [string]$TenantId,

    # Leave empty to target all users (not recommended for production)
    [string]$TargetGroupId = "",

    [string]$TapGroupId = "",

    [ValidateRange(10, 480)]
    [int]$TapLifetimeMinutes = 60,

    [switch]$DemoMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot\helpers\common.ps1"

# ── FIDO2 AAGUID Allowlist ─────────────────────────────────────────────────────
# AAGUIDs identify specific authenticator models.
# We allow the most common enterprise hardware keys plus platform authenticators.
# Reference: https://learn.microsoft.com/entra/identity/authentication/concept-fido2-hardware-vendor
#
# IMPORTANT: If your organisation uses a specific key model, add its AAGUID here.
# Leaving this list empty allows ANY FIDO2 authenticator.
$ALLOWED_AAGUIDS = @(
    # YubiKey 5 Series (USB-A NFC)
    "2fc0579f-8113-47ea-b116-bb5a8db9202a"
    # YubiKey 5C NFC
    "c1f9a0bc-1dd2-404a-b27f-8e29047a43fd"
    # YubiKey Bio Series
    "d8522d9f-575b-4866-88a9-ba99fa02f35b"
    # Microsoft Authenticator (passkeys in Authenticator app)
    "90a3ccdf-635c-4729-a248-9b709135078f"
    # Windows Hello for Business (platform authenticator)
    "08987058-cadc-4b81-b6e1-30de50dcbe96"
    # Apple FaceID / TouchID (platform)
    "fbefdf68-fe86-0906-6c95-2168af5e0fda"
)

# ── Main ───────────────────────────────────────────────────────────────────────
Write-StepHeader "04 — FIDO2 and TAP Policy" -Step "04"
Write-Info "Tenant: $TenantId"
Write-Info "FIDO2 target: $(if ($TargetGroupId) { "Group: $TargetGroupId" } else { "All users" })"
Write-Info "TAP target:   $(if ($TapGroupId)    { "Group: $TapGroupId"    } else { "All users" })"

if ($DemoMode) {
    Write-Warning "DEMO MODE — no policy changes will be made"
}

if (-not $DemoMode) {
    Assert-RequiredScopes -Required @(
        "Policy.ReadWrite.AuthenticationMethod"
        "Policy.Read.All"
    )
}

# ── Helper: Build target include list ─────────────────────────────────────────
function Build-IncludeTargets {
    param([string]$GroupId, [string]$TargetType = "group")

    if ($GroupId) {
        return @(@{
            id         = $GroupId
            targetType = $TargetType
        })
    } else {
        # "all_users" is a special value meaning tenant-wide
        return @(@{
            id         = "all_users"
            targetType = "group"
        })
    }
}

# ── Step 1: FIDO2 Policy ───────────────────────────────────────────────────────
Write-StepHeader "Configuring FIDO2 security key policy"

$fido2State = "unknown"

if (-not $DemoMode) {
    try {
        # Read current policy first
        $currentFido2 = Invoke-GraphApi -Method GET `
            -Uri "/beta/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/fido2"

        Write-Info "Current FIDO2 state: $($currentFido2.state)"

        $fido2Body = @{
            "@odata.type"                    = "#microsoft.graph.fido2AuthenticationMethodConfiguration"
            state                            = "enabled"
            isAttestationEnforced            = $true      # Require FIDO2 attestation to verify key authenticity
            isSelfServiceRegistrationAllowed = $true      # Employees can register their own keys
            includeTargets                   = Build-IncludeTargets -GroupId $TargetGroupId
        }

        # Only include keyRestrictions if we have a specific allowlist
        if ($ALLOWED_AAGUIDS.Count -gt 0) {
            $fido2Body.keyRestrictions = @{
                isEnforced    = $true
                enforcementType = "allow"
                aaGuids       = $ALLOWED_AAGUIDS
            }
            Write-Info "AAGUID allowlist: $($ALLOWED_AAGUIDS.Count) approved authenticator models"
        } else {
            Write-Warning "No AAGUID allowlist — all FIDO2 authenticators will be permitted"
        }

        if ($PSCmdlet.ShouldProcess("FIDO2 policy", "Enable and configure")) {
            Invoke-GraphApi -Method PATCH `
                -Uri "/beta/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/fido2" `
                -Body $fido2Body | Out-Null

            Write-Success "FIDO2 policy enabled"
            $fido2State = "enabled"
        }

    } catch {
        Write-Warning "FIDO2 policy update failed: $($_.Exception.Message)"
        Write-Info "Ensure you have Policy.ReadWrite.AuthenticationMethod scope"
        $fido2State = "failed"
    }
} else {
    Write-Success "[DEMO] Would enable FIDO2 with $($ALLOWED_AAGUIDS.Count) approved AAGUIDs"
    $fido2State = "demo-enabled"
}

# ── Step 2: Temporary Access Pass (TAP) Policy ────────────────────────────────
Write-StepHeader "Configuring Temporary Access Pass (TAP)"

Write-Info "TAP is used for initial onboarding:"
Write-Info "  - New employee receives a TAP to bootstrap their account"
Write-Info "  - TAP is one-time use with a $TapLifetimeMinutes-minute lifetime"
Write-Info "  - Employee uses TAP to register their FIDO2 key or MFA method"

$tapState = "unknown"

if (-not $DemoMode) {
    try {
        $currentTap = Invoke-GraphApi -Method GET `
            -Uri "/beta/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/temporaryAccessPass"

        Write-Info "Current TAP state: $($currentTap.state)"

        $tapBody = @{
            "@odata.type"             = "#microsoft.graph.temporaryAccessPassAuthenticationMethodConfiguration"
            state                     = "enabled"
            defaultLifetimeInMinutes  = $TapLifetimeMinutes
            defaultLength             = 8             # 8-character TAP (minimum for security)
            minimumLifetimeInMinutes  = 10
            maximumLifetimeInMinutes  = 480           # 8 hours max; admins can issue longer if needed
            isUsableOnce              = $true         # ONE-TIME USE: prevents TAP reuse/interception
            includeTargets            = Build-IncludeTargets -GroupId $TapGroupId
        }

        if ($PSCmdlet.ShouldProcess("TAP policy", "Enable and configure")) {
            Invoke-GraphApi -Method PATCH `
                -Uri "/beta/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/temporaryAccessPass" `
                -Body $tapBody | Out-Null

            Write-Success "TAP policy enabled (lifetime: $TapLifetimeMinutes min, one-time use)"
            $tapState = "enabled"
        }

    } catch {
        Write-Warning "TAP policy update failed: $($_.Exception.Message)"
        $tapState = "failed"
    }
} else {
    Write-Success "[DEMO] Would enable TAP: $TapLifetimeMinutes min lifetime, one-time use, length 8"
    $tapState = "demo-enabled"
}

# ── Step 3: Verify / Read Back Policy ─────────────────────────────────────────
Write-StepHeader "Verifying policy configuration"

if (-not $DemoMode -and $fido2State -eq "enabled") {
    try {
        $verifyFido2 = Invoke-GraphApi -Method GET `
            -Uri "/beta/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/fido2"
        Write-Success "FIDO2 policy verified: state=$($verifyFido2.state), attestation=$($verifyFido2.isAttestationEnforced)"
    } catch {
        Write-Warning "Could not verify FIDO2 policy state"
    }

    try {
        $verifyTap = Invoke-GraphApi -Method GET `
            -Uri "/beta/policies/authenticationMethodsPolicy/authenticationMethodConfigurations/temporaryAccessPass"
        Write-Success "TAP policy verified: state=$($verifyTap.state), lifetime=$($verifyTap.defaultLifetimeInMinutes)min"
    } catch {
        Write-Warning "Could not verify TAP policy state"
    }
} else {
    Write-Info "[DEMO] Would verify FIDO2 and TAP policy state via GET"
}

# ── Output Summary ─────────────────────────────────────────────────────────────
$output = @{
    FIDO2_POLICY_STATE    = $fido2State
    FIDO2_AAGUID_COUNT    = $ALLOWED_AAGUIDS.Count
    TAP_POLICY_STATE      = $tapState
    TAP_LIFETIME_MINUTES  = $TapLifetimeMinutes
    TAP_ONE_TIME_USE      = "true"
}

Format-Summary -Title "Authentication Method Policy Output" -Values @{
    Fido2State       = $fido2State
    Fido2AaguidCount = $ALLOWED_AAGUIDS.Count
    TapState         = $tapState
    TapLifetime      = "$TapLifetimeMinutes minutes"
    TapOneTimeUse    = $true
}

Write-Host ""
Write-Host "  📋 Post-Configuration Steps:" -ForegroundColor Cyan
Write-Host "     1. Test FIDO2 registration: sign in as a test user and register a security key" -ForegroundColor White
Write-Host "     2. Issue a TAP for your test user via: New-MgUserAuthenticationTemporaryAccessPassMethod" -ForegroundColor White
Write-Host "     3. Verify the test user can use TAP to sign in and register FIDO2" -ForegroundColor White
Write-Host ""

return $output
