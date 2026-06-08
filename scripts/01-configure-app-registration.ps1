#Requires -Version 7.0
<#
.SYNOPSIS
    Creates and configures an Entra ID app registration for the Verified ID
    Onboarding Portal.

.DESCRIPTION
    Idempotent script that:
      - Creates an app registration named "Entra Verified ID Onboarding Portal"
      - Configures web redirect URIs for dev and prod
      - Adds Graph and Verifiable Credentials API permissions
      - Creates a client secret
      - Creates a service principal
      - Grants admin consent for all permissions

    Run independently or called from bootstrap.ps1.

.PARAMETER TenantId
    Azure AD / Entra ID tenant GUID.

.PARAMETER AppServiceUrl
    Optional production App Service URL for redirect URI registration.

.PARAMETER SecretExpirationYears
    Lifetime of the generated client secret in years (default 1).

.PARAMETER DemoMode
    Skips real API calls and prints what would happen.

.EXAMPLE
    .\01-configure-app-registration.ps1 -TenantId "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

.OUTPUTS
    Hashtable with ClientId, ClientSecret, TenantId, ObjectId
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
    [string]$TenantId,

    [string]$AppServiceUrl = "",

    [ValidateRange(1,2)]
    [int]$SecretExpirationYears = 1,

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
    # Allows the portal to read the signed-in user's profile
    @{ Id = "e1fe6dd8-ba31-4d61-89e7-88639da4683d"; Type = "Scope" }  # User.Read
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

# Dev redirect URIs — always registered
$DEV_REDIRECT_URIS = @(
    "https://localhost:5001/signin-oidc"
    "https://localhost:7001/signin-oidc"
    "http://localhost:5000/signin-oidc"
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

# ── Step 1: App Registration ───────────────────────────────────────────────────
Write-StepHeader "Creating / finding app registration"

$redirectUris = [System.Collections.Generic.List[string]]$DEV_REDIRECT_URIS

if ($AppServiceUrl) {
    $prodRedirect = "$($AppServiceUrl.TrimEnd('/'))/signin-oidc"
    $redirectUris.Add($prodRedirect)
    Write-Info "Including production redirect: $prodRedirect"
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
                DisplayName            = $APP_DISPLAY_NAME
                SignInAudience         = "AzureADMyOrg"   # Single-tenant — employees only
                Web                    = @{
                    RedirectUris          = $redirectUris
                    ImplicitGrantSettings = @{
                        EnableIdTokenIssuance     = $true
                        EnableAccessTokenIssuance = $false   # Use auth code flow, not implicit
                    }
                }
                # Required resource access added below after creation
            }
            $app      = New-MgApplication @appParams
            $appId    = $app.AppId
            $appObjId = $app.Id
            Write-Success "Created app registration: $appId"
        }
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

# ── Step 4: Client Secret ──────────────────────────────────────────────────────
Write-StepHeader "Generating client secret"

$secretValue = $null

if (-not $DemoMode) {
    $expiry = (Get-Date).AddYears($SecretExpirationYears)
    Write-Warning "Client secret will expire: $($expiry.ToString('yyyy-MM-dd'))"
    Write-Warning "Set a calendar reminder to rotate this secret before expiry!"

    if ($PSCmdlet.ShouldProcess($APP_DISPLAY_NAME, "Add client secret")) {
        $secretParams = @{
            ApplicationId     = $appObjId
            PasswordCredential = @{
                DisplayName = "Bootstrap secret $(Get-Date -Format 'yyyy-MM-dd')"
                EndDateTime = $expiry
            }
        }
        $secretObj   = Add-MgApplicationPassword @secretParams
        $secretValue = $secretObj.SecretText   # Only available at creation time!
        Write-Success "Client secret generated (save this — it won't be shown again)"
    }
} else {
    $secretValue = "DEMO-SECRET-$(New-Guid)"
    Write-Success "[DEMO] Would generate client secret"
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
    ENTRA_CLIENT_ID     = $appId
    ENTRA_CLIENT_SECRET = $secretValue
    ENTRA_TENANT_ID     = $TenantId
    ENTRA_APP_OBJECT_ID = $appObjId
    ENTRA_SP_OBJECT_ID  = $spId
}

Format-Summary -Title "App Registration Output" -Values @{
    ClientId     = $appId
    TenantId     = $TenantId
    AppObjectId  = $appObjId
    SecretExpiry = if ($DemoMode) { "N/A" } else { (Get-Date).AddYears($SecretExpirationYears).ToString("yyyy-MM-dd") }
}

Write-Warning "Store ENTRA_CLIENT_SECRET in Key Vault — it cannot be retrieved again!"

return $output
