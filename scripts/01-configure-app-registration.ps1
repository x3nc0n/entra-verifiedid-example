#Requires -Version 7.0
<#
.SYNOPSIS
    Creates and configures an Entra ID app registration for the Verified ID
    Onboarding Portal.

.DESCRIPTION
    Idempotent script that:
      - Creates an app registration named "Entra Verified ID Onboarding Portal"
      - Removes unused OIDC web redirect / implicit token settings
      - Adds Graph and Verifiable Credentials API permissions
      - Does not create a client secret because runtime auth now uses managed identity / DefaultAzureCredential
      - Creates a service principal
      - Grants admin consent for all permissions

    Run independently or called from bootstrap.ps1.

.PARAMETER TenantId
    Azure AD / Entra ID tenant GUID.

.PARAMETER AppServiceUrl
    Optional application base URL retained for compatibility with bootstrap.ps1.

.PARAMETER SecretExpirationYears
    Lifetime of the generated client secret in years (default 1).

.PARAMETER KeyVaultName
    Deprecated compatibility parameter. Client secrets are no longer generated
    because runtime auth now uses managed identity / DefaultAzureCredential.

.PARAMETER DemoMode
    Skips real API calls and prints what would happen.

.EXAMPLE
    .\01-configure-app-registration.ps1 -TenantId "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

.OUTPUTS
    Hashtable with ClientId, TenantId, ObjectId, and empty client-secret fields
    because runtime auth no longer relies on a bootstrap secret.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
    [string]$TenantId,

    [string]$AppServiceUrl = "",

    [ValidateRange(1,2)]
    [int]$SecretExpirationYears = 1,

    [string]$KeyVaultName = "",

    [switch]$DemoMode
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot\helpers\common.ps1"

# ── App Registration Constants ─────────────────────────────────────────────────
$APP_DISPLAY_NAME = "Entra Verified ID Onboarding Portal"

# Graph API permissions (AppId: 00000003-0000-0000-c000-000000000000)
$GRAPH_APP_ID    = "00000003-0000-0000-c000-000000000000"
$GRAPH_PERMISSIONS = @(
    # App-only /users lookups require the application permission User.Read.All.
    @{ Id = "7ab1d382-f21e-4acd-a863-ba3e13f7da61"; Type = "Role" }  # User.Read.All
    # Required to register FIDO2 keys and TAP for new employees
    @{ Id = "50483e42-d915-4231-9639-7fdb7fd190e5"; Type = "Role"  }  # UserAuthenticationMethod.ReadWrite.All
)

# Verifiable Credentials Service Request (AppId varies by tenant; use well-known GUID)
# AppId: 3db474b9-6a0c-4840-96ac-1fceb342124f
$VCS_APP_ID    = "3db474b9-6a0c-4840-96ac-1fceb342124f"
$VCS_PERMISSIONS = @(
    # Allows the portal to issue Verified ID credentials
    @{ Id = "b1949c8b-6e1e-4a6c-a8b8-f8ed1a4f3ac3"; Type = "Role" }  # VerifiableCredential.Create.IssueRequest
    # Allows the portal to request credential presentation from holders
    @{ Id = "680c2f48-4d1c-4e89-9bea-cfce432ee60e"; Type = "Role" }  # VerifiableCredential.Create.PresentRequest
)

# ── Main ───────────────────────────────────────────────────────────────────────

Write-StepHeader "01 — App Registration" -Step "01"
Write-Info "Target tenant: $TenantId"
Write-Info "App name: $APP_DISPLAY_NAME"

if ($DemoMode) {
    Write-Warning "DEMO MODE — no changes will be made to Entra ID"
}

# Ensure Graph scopes sufficient for app management
if (-not $DemoMode) {
    Assert-RequiredScopes -Required @(
        "Application.ReadWrite.All"
        "AppRoleAssignment.ReadWrite.All"
        "DelegatedPermissionGrant.ReadWrite.All"
    )
}

# Current app code uses app-only tokens and does not expose a /signin-oidc
# callback. Do not register redirect URIs or enable implicit ID-token issuance
# until the runtime actually implements an OIDC sign-in flow.

# ── Step 1: App Registration ───────────────────────────────────────────────────
Write-StepHeader "Creating / finding app registration"

if ($AppServiceUrl) {
    Write-Info "AppServiceUrl provided for downstream scripts: $AppServiceUrl"
    Write-Info "Skipping /signin-oidc redirect registration because the app has no OIDC callback route today"
}

if ($DemoMode) {
    $appId     = "DEMO-CLIENT-ID-$(New-Guid)"
    $appObjId  = "DEMO-OBJ-ID-$(New-Guid)"
    Write-Success "[DEMO] Would create app registration '$APP_DISPLAY_NAME'"
} else {
    # Look for existing registration to stay idempotent
    $existing = Get-MgApplication -Filter "displayName eq '$APP_DISPLAY_NAME'" -ErrorAction SilentlyContinue |
                Select-Object -First 1

    if ($existing) {
        Write-Warning "App registration '$APP_DISPLAY_NAME' already exists (AppId: $($existing.AppId))"
        $app     = $existing
        $appId   = $app.AppId
        $appObjId = $app.Id
    } else {
        Write-Progress-Step "Creating new app registration"

        if ($PSCmdlet.ShouldProcess($APP_DISPLAY_NAME, "Create app registration")) {
            $appParams = @{
                DisplayName    = $APP_DISPLAY_NAME
                SignInAudience = "AzureADMyOrg"   # Single-tenant — employees only
                # Required resource access added below after creation
            }
            $app      = New-MgApplication @appParams
            $appId    = $app.AppId
            $appObjId = $app.Id
            Write-Success "Created app registration: $appId"
        }
    }

    if ($PSCmdlet.ShouldProcess($APP_DISPLAY_NAME, "Remove unused OIDC redirect / implicit token configuration")) {
        Update-MgApplication -ApplicationId $appObjId -Web @{
            RedirectUris = @()
            ImplicitGrantSettings = @{
                EnableIdTokenIssuance     = $false
                EnableAccessTokenIssuance = $false
            }
        }
        Write-Success "Removed unused /signin-oidc redirect and implicit ID-token settings"
    }
}

# ── Step 2: API Permissions ────────────────────────────────────────────────────
Write-StepHeader "Configuring API permissions"

if (-not $DemoMode) {
    # Build the RequiredResourceAccess list
    $resourceAccess = @(
        @{
            ResourceAppId  = $GRAPH_APP_ID
            ResourceAccess = $GRAPH_PERMISSIONS
        }
        @{
            ResourceAppId  = $VCS_APP_ID
            ResourceAccess = $VCS_PERMISSIONS
        }
    )

    if ($PSCmdlet.ShouldProcess($APP_DISPLAY_NAME, "Set API permissions")) {
        Update-MgApplication -ApplicationId $appObjId -RequiredResourceAccess $resourceAccess
        Write-Success "API permissions configured (Graph + Verifiable Credentials)"
    }
} else {
    Write-Success "[DEMO] Would configure Graph + Verifiable Credentials permissions"
}

# ── Step 3: Service Principal ──────────────────────────────────────────────────
Write-StepHeader "Creating / finding service principal"

if (-not $DemoMode) {
    $sp = Get-MgServicePrincipal -Filter "appId eq '$appId'" -ErrorAction SilentlyContinue |
          Select-Object -First 1

    if ($sp) {
        Write-Warning "Service principal already exists (Id: $($sp.Id))"
    } else {
        if ($PSCmdlet.ShouldProcess("Service Principal for $appId", "Create")) {
            $sp = New-MgServicePrincipal -AppId $appId
            Write-Success "Service principal created: $($sp.Id)"
        }
    }
    $spId = $sp.Id
} else {
    $spId = "DEMO-SP-ID"
    Write-Success "[DEMO] Would create service principal"
}

# ── Step 4: Managed Identity Runtime Alignment ─────────────────────────────────
Write-StepHeader "Runtime authentication model"

$secretValue = $null
$secretReferenceName = ""
$secretStoredInKeyVault = $false

Write-Info "The app runtime now uses DefaultAzureCredential (managed identity in Azure, developer credentials locally)."
Write-Info "No bootstrap client secret will be created or stored."
if ($KeyVaultName) {
    Write-Info "Ignoring -KeyVaultName for script 01 because no client secret is generated."
}
if ($DemoMode) {
    Write-Success "[DEMO] No client secret needed for the current runtime model"
}

# ── Step 5: Admin Consent ──────────────────────────────────────────────────────
Write-StepHeader "Granting admin consent"

if (-not $DemoMode) {
    # Grant admin consent for the Graph application permissions (app roles)
    # For delegated scopes, admin consent is granted via the OAuth2PermissionGrant endpoint
    try {
        if ($PSCmdlet.ShouldProcess($APP_DISPLAY_NAME, "Grant admin consent — Graph app roles")) {
            # Find the Graph service principal in the tenant
            $graphSp = Get-MgServicePrincipal -Filter "appId eq '$GRAPH_APP_ID'" | Select-Object -First 1

            foreach ($perm in ($GRAPH_PERMISSIONS | Where-Object { $_.Type -eq "Role" })) {
                $existing = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $spId -ErrorAction SilentlyContinue |
                            Where-Object { $_.AppRoleId -eq $perm.Id }
                if (-not $existing) {
                    New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $spId `
                        -PrincipalId $spId `
                        -ResourceId $graphSp.Id `
                        -AppRoleId $perm.Id | Out-Null
                }
            }

            Write-Success "Admin consent granted for Graph app roles"
        }

        # VCS app roles
        if ($PSCmdlet.ShouldProcess($APP_DISPLAY_NAME, "Grant admin consent — VCS app roles")) {
            $vcsSp = Get-MgServicePrincipal -Filter "appId eq '$VCS_APP_ID'" -ErrorAction SilentlyContinue |
                     Select-Object -First 1

            if ($vcsSp) {
                foreach ($perm in $VCS_PERMISSIONS) {
                    $existingVcs = Get-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $spId -ErrorAction SilentlyContinue |
                                   Where-Object { $_.AppRoleId -eq $perm.Id }
                    if (-not $existingVcs) {
                        New-MgServicePrincipalAppRoleAssignment -ServicePrincipalId $spId `
                            -PrincipalId $spId `
                            -ResourceId $vcsSp.Id `
                            -AppRoleId $perm.Id | Out-Null
                    }
                }
                Write-Success "Admin consent granted for Verifiable Credentials app roles"
            } else {
                Write-Warning "Verifiable Credentials service principal not found in tenant — skipping VCS consent"
                Write-Info "Ensure the Verifiable Credentials service is enabled in your tenant first"
            }
        }
    } catch {
        Write-Warning "Admin consent step encountered an issue: $($_.Exception.Message)"
        Write-Info "You can grant consent manually in Entra admin center: App registrations → $APP_DISPLAY_NAME → API permissions → Grant admin consent"
    }
} else {
    Write-Success "[DEMO] Would grant admin consent for all permissions"
}

# ── Output Summary ─────────────────────────────────────────────────────────────
$output = @{
    ENTRA_CLIENT_ID               = $appId
    ENTRA_CLIENT_SECRET           = if ($secretValue -and -not $secretStoredInKeyVault) { ConvertTo-SecureString $secretValue -AsPlainText -Force } else { $null }
    ENTRA_CLIENT_SECRET_SECRET_NAME = $secretReferenceName
    ENTRA_CLIENT_SECRET_KEYVAULT_NAME = if ($secretStoredInKeyVault) { $KeyVaultName } else { "" }
    ENTRA_TENANT_ID               = $TenantId
    ENTRA_APP_OBJECT_ID           = $appObjId
    ENTRA_SP_OBJECT_ID            = $spId
}

Format-Summary -Title "App Registration Output" -Values @{
    ClientId     = $appId
    TenantId     = $TenantId
    AppObjectId  = $appObjId
    SecretExpiry = "Not used (DefaultAzureCredential)"
}

Write-Warning "Runtime auth now relies on managed identity / developer credentials. Grant app roles to the runtime identity, not to a client secret."

return $output
