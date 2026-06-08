#Requires -Version 7.0
<#
.SYNOPSIS
    Enables Entra Verified ID and configures the credential authority, DID, and
    the EmployeeOnboardingCredential type.

.DESCRIPTION
    Idempotent script that:
      - Enables the Verified ID service via Graph beta API
      - Registers a did:web authority for the organisation
      - Creates the "EmployeeOnboardingCredential" contract with
        display (branding) and rules (id_token_hint attestation) definitions
      - Outputs the Authority DID, Credential Manifest URL, and Credential Type

    Run independently or called from bootstrap.ps1.

.PARAMETER TenantId
    Azure AD / Entra ID tenant GUID.

.PARAMETER DidWebDomain
    The domain used for did:web DID resolution (e.g., "contoso.com").
    This domain must be publicly accessible and have a well-known DID document.

.PARAMETER CredentialManifestBaseUrl
    Base URL where credential manifests are hosted (typically the App Service URL).

.PARAMETER DemoMode
    Skips real API calls and prints what would happen, using mock values.

.EXAMPLE
    .\02-configure-verified-id.ps1 -TenantId "xxxx" -DidWebDomain "contoso.com" -CredentialManifestBaseUrl "https://myapp.azurewebsites.net"

.OUTPUTS
    Hashtable with AuthorityDid, CredentialManifestUrl, CredentialType
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
    [string]$TenantId,

    [Parameter(Mandatory)]
    [string]$DidWebDomain,

    [string]$CredentialManifestBaseUrl = "https://localhost:5001",

    [switch]$DemoMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot\helpers\common.ps1"

# ── Constants ──────────────────────────────────────────────────────────────────
$CREDENTIAL_TYPE      = "EmployeeOnboardingCredential"
$CREDENTIAL_MANIFEST  = "$($CredentialManifestBaseUrl.TrimEnd('/'))/v1.0/verifiedid/manifest"

# ── Helper: Build credential display definition ────────────────────────────────
function Build-CredentialDisplay {
    <#
    The display definition controls how the credential appears in the
    Microsoft Authenticator app — card colour, logo, claim labels, etc.
    #>
    return @{
        locale  = "en-US"
        card    = @{
            title       = "Employee Onboarding"
            issuedBy    = "Your Organisation"
            backgroundColor = "#003087"       # Microsoft blue
            textColor       = "#FFFFFF"
            logo            = @{
                uri         = "$CredentialManifestBaseUrl/images/logo.png"
                description = "Organisation Logo"
            }
            description = "This credential proves your employment status and enables secure onboarding."
        }
        consent = @{
            title   = "Do you want to accept the Employee Onboarding credential?"
            instructions = "Sign in with your corporate account to receive your verified employment credential."
        }
        claims  = @(
            @{ claim = "$.employeeId";   label = "Employee ID";  type = "String" }
            @{ claim = "$.email";        label = "Work Email";   type = "String" }
            @{ claim = "$.displayName";  label = "Full Name";    type = "String" }
            @{ claim = "$.department";   label = "Department";   type = "String" }
            @{ claim = "$.startDate";    label = "Start Date";   type = "String" }
        )
    }
}

# ── Helper: Build credential rules definition ──────────────────────────────────
function Build-CredentialRules {
    <#
    The rules definition specifies the attestation flow.
    We use id_token_hint because the portal passes claims directly from the
    backend (after identity verification), rather than having the holder
    authenticate against an external IdP. This is the correct pattern for
    employer-issued credentials where the employer already knows the claims.
    #>
    param([string]$AppClientId)

    return @{
        attestations = @{
            idTokenHints = @(
                @{
                    # Mapping from id_token_hint claim names to VC claim names
                    mapping = @(
                        @{ outputClaim = "employeeId";  inputClaim = "employeeId";  indexed = $true }
                        @{ outputClaim = "email";       inputClaim = "email";       indexed = $false }
                        @{ outputClaim = "displayName"; inputClaim = "displayName"; indexed = $false }
                        @{ outputClaim = "department";  inputClaim = "department";  indexed = $false }
                        @{ outputClaim = "startDate";   inputClaim = "startDate";   indexed = $false }
                    )
                    # required = true means the credential can't be issued without these claims
                    required = $true
                }
            )
        }
        # Credential expires 1 year after issuance — employee should refresh annually
        validityInterval = 31536000   # seconds = 365 days
        vc               = @{
            type = @($CREDENTIAL_TYPE)
        }
    }
}

# ── Main ───────────────────────────────────────────────────────────────────────
Write-StepHeader "02 — Verified ID Configuration" -Step "02"
Write-Info "Tenant: $TenantId"
Write-Info "DID domain: $DidWebDomain"
Write-Info "Credential type: $CREDENTIAL_TYPE"

if ($DemoMode) {
    Write-Warning "DEMO MODE — no changes will be made to Entra ID"
}

# Verified ID configuration requires these Graph beta scopes
if (-not $DemoMode) {
    Assert-RequiredScopes -Required @(
        "VerifiableCredential.Create.All"
    )
}

# Get the tenant org ID (needed for Graph API paths)
if (-not $DemoMode) {
    $org   = Get-TenantOrganization
    $orgId = $org.Id
    Write-Info "Organisation: $($org.DisplayName) ($orgId)"
} else {
    $orgId = "DEMO-ORG-ID"
}

# ── Step 1: Enable Verified ID Service ────────────────────────────────────────
Write-StepHeader "Enabling Verified ID service"

if (-not $DemoMode) {
    try {
        # Check if Verified ID is already configured
        $existing = Invoke-GraphApi -Method GET `
            -Uri "/beta/organization/$orgId/verifiedIdAuthorities" `
            -ErrorAction SilentlyContinue

        if ($existing -and $existing.value.Count -gt 0) {
            Write-Warning "Verified ID authority already exists — skipping service enablement"
            $authority = $existing.value[0]
        } else {
            Write-Progress-Step "Registering Verified ID authority with did:web"

            if ($PSCmdlet.ShouldProcess("Verified ID Authority", "Create did:web authority")) {
                $authorityBody = @{
                    # did:web uses your domain's .well-known/did.json for DID resolution
                    # The domain must be publicly reachable
                    didMethod = "web"
                    linkedDomainUrl = "https://$DidWebDomain/.well-known/did-configuration.json"
                    # Signing keys are managed by the Verified ID service
                }

                $authority = Invoke-GraphApi -Method POST `
                    -Uri "/beta/organization/$orgId/verifiedIdAuthorities" `
                    -Body $authorityBody

                Write-Success "Verified ID authority created"
            }
        }

        $authorityId  = $authority.Id
        $authorityDid = $authority.did
        Write-Success "DID: $authorityDid"

    } catch {
        Write-Warning "Could not configure Verified ID authority: $($_.Exception.Message)"
        Write-Info "The Verified ID service may need to be enabled in the Entra admin portal first:"
        Write-Info "  https://entra.microsoft.com → Verified ID → Setup"
        # In demo/early-setup scenarios, continue with a placeholder
        $authorityId  = "pending-setup"
        $authorityDid = "did:web:$DidWebDomain"
    }
} else {
    $authorityId  = "DEMO-AUTHORITY-ID"
    $authorityDid = "did:web:$DidWebDomain"
    Write-Success "[DEMO] Would create Verified ID authority: did:web:$DidWebDomain"
}

# ── Step 2: Create Credential Contract (display + rules) ──────────────────────
Write-StepHeader "Creating / updating credential contract"

$appClientId = (Get-MgContext).ClientId

if (-not $DemoMode) {
    try {
        # Check if the contract already exists
        $existingContracts = Invoke-GraphApi -Method GET `
            -Uri "/beta/organization/$orgId/verifiedIdAuthorities/$authorityId/contracts" `
            -ErrorAction SilentlyContinue

        $existingContract = $existingContracts?.value | Where-Object { $_.name -eq $CREDENTIAL_TYPE } |
                            Select-Object -First 1

        $display = Build-CredentialDisplay
        $rules   = Build-CredentialRules -AppClientId $appClientId

        if ($existingContract) {
            Write-Warning "Credential contract '$CREDENTIAL_TYPE' already exists — updating"

            if ($PSCmdlet.ShouldProcess($CREDENTIAL_TYPE, "Update credential contract")) {
                $contract = Invoke-GraphApi -Method PATCH `
                    -Uri "/beta/organization/$orgId/verifiedIdAuthorities/$authorityId/contracts/$($existingContract.Id)" `
                    -Body @{
                        displays = @($display)
                        rules    = $rules
                    }
            }
        } else {
            Write-Progress-Step "Creating credential contract '$CREDENTIAL_TYPE'"

            if ($PSCmdlet.ShouldProcess($CREDENTIAL_TYPE, "Create credential contract")) {
                $contract = Invoke-GraphApi -Method POST `
                    -Uri "/beta/organization/$orgId/verifiedIdAuthorities/$authorityId/contracts" `
                    -Body @{
                        name     = $CREDENTIAL_TYPE
                        displays = @($display)
                        rules    = $rules
                    }
                Write-Success "Credential contract created"
            }
        }

        $manifestUrl = $contract?.manifestUrl ?? $CREDENTIAL_MANIFEST

    } catch {
        Write-Warning "Could not create credential contract: $($_.Exception.Message)"
        Write-Info "Ensure the Verified ID authority is fully set up before creating contracts"
        $manifestUrl = $CREDENTIAL_MANIFEST
    }
} else {
    Write-Success "[DEMO] Would create credential contract with display + rules definitions"
    Write-Info "  Claims: employeeId, email, displayName, department, startDate"
    Write-Info "  Attestation: id_token_hint (backend passes claims directly)"
    Write-Info "  Validity: 365 days"
    $manifestUrl = "$CREDENTIAL_MANIFEST"
}

# ── Step 3: DID Configuration Document (instructions) ─────────────────────────
Write-StepHeader "DID Well-Known Configuration"

Write-Info "For did:web to work, you must publish a DID configuration document:"
Write-Info ""
Write-Info "  URL: https://$DidWebDomain/.well-known/did-configuration.json"
Write-Info ""
Write-Info "  This document links your domain to your DID and must be:"
Write-Info "    1. Publicly accessible (no auth required)"
Write-Info "    2. Served over HTTPS"
Write-Info "    3. Signed with your Verified ID signing key"
Write-Info ""
Write-Info "  The Entra admin portal generates this document at:"
Write-Info "  https://entra.microsoft.com → Verified ID → Registration → Download DID document"

# ── Output Summary ─────────────────────────────────────────────────────────────
$output = @{
    VERIFIED_ID_AUTHORITY_ID  = $authorityId
    VERIFIED_ID_AUTHORITY_DID = $authorityDid
    VERIFIED_ID_MANIFEST_URL  = $manifestUrl
    VERIFIED_ID_CREDENTIAL_TYPE = $CREDENTIAL_TYPE
}

Format-Summary -Title "Verified ID Configuration Output" -Values @{
    AuthorityId     = $authorityId
    AuthorityDid    = $authorityDid
    CredentialType  = $CREDENTIAL_TYPE
    ManifestUrl     = $manifestUrl
}

return $output
