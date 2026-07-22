#Requires -Version 7.0
<#
.SYNOPSIS
    Seeds demo data for testing the Entra Verified ID onboarding portal.

.DESCRIPTION
    Idempotent script that:
      - Writes a demo-data.json file to the project root with representative
        test employee records (always, in both demo and production modes)
      - In non-DemoMode, when Graph is connected:
          • Creates the test users in Entra ID (if they don't already exist)
          • Creates or finds a "Verified ID Demo Users" security group
          • Adds each test user to the group
          • Generates one-time Temporary Access Passes (TAPs) for initial login
      - Writes a manager-approval-config.json describing the simulated approval
        workflow endpoints

    Run independently or called from bootstrap.ps1.

.PARAMETER TenantId
    Azure AD / Entra ID tenant GUID.

.PARAMETER WebAppUrl
    URL of the running onboarding portal (used to build approval callback URLs).

.PARAMETER DemoMode
    Write demo data locally only — skip creating real users in Entra ID.

.EXAMPLE
    # Write demo data files only (no Graph user creation)
    .\06-seed-demo-data.ps1 -TenantId "xxxx" -DemoMode

.EXAMPLE
    # Full seed — create real users, groups, and TAPs in the tenant
    .\06-seed-demo-data.ps1 -TenantId "xxxx" -WebAppUrl "https://myapp.azurewebsites.net"

.OUTPUTS
    Hashtable with DemoDataPath, ApprovalConfigPath, TestUsers (array of created users + TAPs)
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
    [string]$TenantId,

    [switch]$DemoMode,

    [string]$WebAppUrl = "https://localhost:3000"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. "$PSScriptRoot\helpers\common.ps1"

# ── Constants ──────────────────────────────────────────────────────────────────
$DEMO_GROUP_NAME   = "Verified ID Demo Users"
$DEMO_GROUP_NICK   = "verifiedid-demo-users"
$DATA_DIR          = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$DEMO_DATA_FILE    = Join-Path $DATA_DIR "demo-data.json"
$APPROVAL_CFG_FILE = Join-Path $DATA_DIR "manager-approval-config.json"

# Canonical test employee records used in both demo and production seeding.
# employeeId, email, displayName, department, and manager mirror the
# EmployeeOnboardingCredential claim schema from script 02.
$DEMO_EMPLOYEES = @(
    @{
        employeeId  = "EMP001"
        email       = "alice@contoso.com"
        displayName = "Alice Johnson"
        department  = "Engineering"
        manager     = "bob@contoso.com"
        startDate   = "2024-01-15"
    }
    @{
        employeeId  = "EMP002"
        email       = "carol@contoso.com"
        displayName = "Carol Williams"
        department  = "Marketing"
        manager     = "dave@contoso.com"
        startDate   = "2024-03-01"
    }
    @{
        employeeId  = "GUEST001"
        email       = "external@partner.com"
        displayName = "External Partner"
        department  = "Consulting"
        manager     = "alice@contoso.com"
        startDate   = "2024-06-01"
    }
)

# ── Main ───────────────────────────────────────────────────────────────────────
Write-StepHeader "06 — Demo Data Seeding" -Step "06"
Write-Info "Tenant:     $TenantId"
Write-Info "Portal URL: $WebAppUrl"
Write-Info "Demo mode:  $($DemoMode.IsPresent)"

if ($DemoMode) {
    Write-Warning "DEMO MODE — only local data files will be written; no Entra ID changes"
}

# Track created users and their TAPs for the return value
$createdUsers = [System.Collections.Generic.List[hashtable]]::new()

# ── Step 1: Write demo-data.json ───────────────────────────────────────────────
Write-StepHeader "Writing demo-data.json"

$demoData = @{
    '$schema'   = "https://json-schema.org/draft/2020-12/schema"
    description = "Test employee records for the Entra Verified ID onboarding portal"
    generated   = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    tenantId    = $TenantId
    employees   = $DEMO_EMPLOYEES
}

if ($PSCmdlet.ShouldProcess($DEMO_DATA_FILE, "Write demo-data.json")) {
    $demoData | ConvertTo-Json -Depth 5 | Set-Content -Path $DEMO_DATA_FILE -Encoding UTF8
    Write-Success "demo-data.json written: $DEMO_DATA_FILE"
    Write-Info "  Records: $($DEMO_EMPLOYEES.Count) test employees"
}

# ── Step 2: Entra ID User Creation (non-demo only) ─────────────────────────────
Write-StepHeader "Entra ID user provisioning"

$graphConnected = $false
if (-not $DemoMode) {
    try {
        $graphCtx = Get-MgContext -ErrorAction Stop
        $graphConnected = $null -ne $graphCtx
        if ($graphConnected) {
            Write-Success "Graph connected: $($graphCtx.Account)"
            Assert-RequiredScopes -Required @(
                "User.ReadWrite.All"
                "GroupMember.ReadWrite.All"
                "UserAuthenticationMethod.ReadWrite.All"
            )
        }
    } catch {
        Write-Warning "Graph not connected — skipping Entra ID user creation"
        Write-Info "Connect with: Connect-MgGraph -TenantId '$TenantId' -Scopes 'User.ReadWrite.All','GroupMember.ReadWrite.All','UserAuthenticationMethod.ReadWrite.All'"
    }
}

if ($graphConnected -and -not $DemoMode) {

    # ── 2a: Find or create the demo security group ─────────────────────────────
    Write-Progress-Step "Resolving group '$DEMO_GROUP_NAME'"

    $demoGroup = Get-MgGroup -Filter "displayName eq '$DEMO_GROUP_NAME'" `
                             -ErrorAction SilentlyContinue |
                 Select-Object -First 1

    if ($demoGroup) {
        Write-Warning "'$DEMO_GROUP_NAME' already exists (Id: $($demoGroup.Id))"
    } else {
        Write-Info "Creating security group '$DEMO_GROUP_NAME'"
        if ($PSCmdlet.ShouldProcess($DEMO_GROUP_NAME, "Create Entra ID security group")) {
            $demoGroup = New-MgGroup `
                -DisplayName $DEMO_GROUP_NAME `
                -MailEnabled:$false `
                -SecurityEnabled:$true `
                -MailNickname $DEMO_GROUP_NICK `
                -Description "Test users for the Entra Verified ID onboarding portal demo"
            Write-Success "Group created: $($demoGroup.Id)"
        }
    }

    # ── 2b: Create each demo user if they don't already exist ──────────────────
    foreach ($employee in $DEMO_EMPLOYEES) {
        Write-Progress-Step "Resolving user '$($employee.email)'"

        $existingUser = Get-MgUser -Filter "userPrincipalName eq '$($employee.email)'" `
                                   -ErrorAction SilentlyContinue |
                        Select-Object -First 1

        if ($existingUser) {
            Write-Warning "User '$($employee.email)' already exists (Id: $($existingUser.Id))"
            $userId = $existingUser.Id
        } else {
            if ($PSCmdlet.ShouldProcess($employee.email, "Create Entra ID user")) {
                try {
                    # Generate a strong initial password — the user will authenticate
                    # via TAP for first login so this password is effectively unused
                    $initialPassword = "$([System.Convert]::ToBase64String(
                        [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(12)
                    ))Aa1!"

                    $mailNickname = ($employee.email -split '@')[0]

                    $newUser = New-MgUser `
                        -DisplayName $employee.displayName `
                        -UserPrincipalName $employee.email `
                        -MailNickname $mailNickname `
                        -AccountEnabled:$true `
                        -Department $employee.department `
                        -EmployeeId $employee.employeeId `
                        -PasswordProfile @{
                            Password                      = $initialPassword
                            ForceChangePasswordNextSignIn = $false
                        }

                    $userId = $newUser.Id
                    Write-Success "User created: $($employee.displayName) ($userId)"
                } catch {
                    Write-Warning "Could not create user '$($employee.email)': $($_.Exception.Message)"
                    continue
                }
            } else {
                # -WhatIf path — skip dependent steps for this user
                continue
            }
        }

        # ── 2c: Add user to the demo group ──────────────────────────────────────
        if ($demoGroup -and $PSCmdlet.ShouldProcess("$DEMO_GROUP_NAME ← $($employee.email)", "Add group member")) {
            try {
                $existingMembership = Get-MgGroupMember -GroupId $demoGroup.Id `
                    -Filter "id eq '$userId'" -ErrorAction SilentlyContinue |
                    Select-Object -First 1

                if (-not $existingMembership) {
                    New-MgGroupMember -GroupId $demoGroup.Id -DirectoryObjectId $userId | Out-Null
                    Write-Success "Added to group: $($employee.displayName) → $DEMO_GROUP_NAME"
                } else {
                    Write-Info "$($employee.displayName) is already a group member"
                }
            } catch {
                Write-Warning "Could not add '$($employee.email)' to group: $($_.Exception.Message)"
            }
        }

        # ── 2d: Generate a Temporary Access Pass (TAP) ─────────────────────────
        $tapValue = $null
        if ($PSCmdlet.ShouldProcess($employee.email, "Generate Temporary Access Pass")) {
            try {
                $tap = New-MgUserAuthenticationTemporaryAccessPassMethod `
                    -UserId $userId `
                    -BodyParameter @{
                        lifetimeInMinutes = 60       # One hour — collect keys quickly after onboarding
                        isUsableOnce      = $true    # One-time use, matching script 04 TAP policy
                    }

                $tapValue = $tap.TemporaryAccessPass
                Write-Success "TAP generated for $($employee.displayName) (expires: $($tap.StartDateTime.AddMinutes(60).ToString('HH:mm')))"
                Write-Warning "  TAP: $tapValue  ← save this — it cannot be retrieved again!"
            } catch {
                Write-Warning "Could not generate TAP for '$($employee.email)': $($_.Exception.Message)"
                Write-Info "Ensure TAP policy is enabled (script 04) and you have UserAuthenticationMethod.ReadWrite.All scope"
            }
        }

        $createdUsers.Add(@{
            employeeId  = $employee.employeeId
            email       = $employee.email
            displayName = $employee.displayName
            userId      = $userId
            tap         = $tapValue ?? "(not generated)"
        })
    }

} else {
    Write-Success "[DEMO] Would create $($DEMO_EMPLOYEES.Count) test users in Entra ID"
    Write-Info "  Users: $($DEMO_EMPLOYEES | ForEach-Object { $_.displayName } | Join-String -Separator ', ')"
    Write-Info "  Group: $DEMO_GROUP_NAME"
    Write-Info "  TAPs:  60-minute one-time TAP for each user"

    # Populate createdUsers with demo placeholders for the return value
    foreach ($employee in $DEMO_EMPLOYEES) {
        $createdUsers.Add(@{
            employeeId  = $employee.employeeId
            email       = $employee.email
            displayName = $employee.displayName
            userId      = "DEMO-USER-ID-$(New-Guid)"
            tap         = "DEMO-TAP-$((New-Guid).ToString().Substring(0,8).ToUpper())"
        })
    }
}

# ── Step 3: Manager Approval Simulation Config ─────────────────────────────────
Write-StepHeader "Manager approval simulation config"

$approvalConfig = @{
    description  = "Manager approval endpoint config for the Verified ID onboarding portal"
    generated    = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
    portalUrl    = $WebAppUrl
    # Canonical callback endpoint that the portal listens on for IdentityPass callbacks
    endpoints    = @{
        callbackUrl = "$($WebAppUrl.TrimEnd('/'))/api/identitypass/callback"
    }
    # Simulated manager → employee mapping (used by demo mode to auto-approve)
    managers     = @(
        @{
            managerEmail    = "bob@contoso.com"
            managerName     = "Bob (Engineering Manager)"
            approves        = @("EMP001")
        }
        @{
            managerEmail    = "dave@contoso.com"
            managerName     = "Dave (Marketing Manager)"
            approves        = @("EMP002")
        }
        @{
            managerEmail    = "alice@contoso.com"
            managerName     = "Alice Johnson (Consulting Lead)"
            approves        = @("GUEST001")
        }
    )
    # In demo mode the portal auto-approves after this delay (seconds)
    demoAutoApproveDelaySeconds = 3
}

if ($PSCmdlet.ShouldProcess($APPROVAL_CFG_FILE, "Write manager-approval-config.json")) {
    $approvalConfig | ConvertTo-Json -Depth 5 | Set-Content -Path $APPROVAL_CFG_FILE -Encoding UTF8
    Write-Success "manager-approval-config.json written: $APPROVAL_CFG_FILE"
}

# ── Output Summary ─────────────────────────────────────────────────────────────
$output = @{
    DemoDataPath       = $DEMO_DATA_FILE
    ApprovalConfigPath = $APPROVAL_CFG_FILE
    TestUsers          = $createdUsers.ToArray()
}

Format-Summary -Title "Demo Data Seeding Output" -Values @{
    DemoDataFile      = $DEMO_DATA_FILE
    ApprovalCfgFile   = $APPROVAL_CFG_FILE
    EmployeeCount     = $DEMO_EMPLOYEES.Count
    UsersCreated      = $createdUsers.Count
    TapsGenerated     = ($createdUsers | Where-Object { $_.tap -and $_.tap -notlike "DEMO-*" -and $_.tap -ne "(not generated)" } | Measure-Object).Count
    DemoGroupName     = $DEMO_GROUP_NAME
}

if ($createdUsers.Count -gt 0) {
    Write-Host ""
    Write-Host "  👤 Test Users:" -ForegroundColor Cyan
    foreach ($u in $createdUsers) {
        $tapDisplay = if ($u.tap -and $u.tap -ne "(not generated)") { $u.tap } else { "—" }
        Write-Host "     $($u.displayName.PadRight(22)) $($u.email.PadRight(30)) TAP: $tapDisplay" -ForegroundColor White
    }
    Write-Host ""
}

Write-Host ""
Write-Host "  📋 Post-Seeding Steps:" -ForegroundColor Cyan
Write-Host "     1. Open the portal at $WebAppUrl and sign in as a test user" -ForegroundColor White
if ($graphConnected -and -not $DemoMode) {
    Write-Host "     2. Use the TAPs above to authenticate for the first time" -ForegroundColor White
    Write-Host "     3. Register a FIDO2 key or Microsoft Authenticator passkey" -ForegroundColor White
    Write-Host "     4. Trigger the onboarding flow and inspect the Verified ID credential" -ForegroundColor White
} else {
    Write-Host "     2. Demo mode is active — identity checks auto-approve after a short delay" -ForegroundColor White
    Write-Host "     3. No FIDO2 key is required in demo mode" -ForegroundColor White
}
Write-Host ""

return $output
