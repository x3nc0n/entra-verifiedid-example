#Requires -Version 7.0
<#
.SYNOPSIS
    Shared helper functions for Entra Verified ID bootstrapping scripts.

.DESCRIPTION
    Provides formatted output, prerequisite checks, idempotent resource helpers,
    Graph API wrappers, and .env file generation used by all bootstrap scripts.
    Import with: . "$PSScriptRoot\helpers\common.ps1"
#>

# ── Output Formatting ──────────────────────────────────────────────────────────

function Write-StepHeader {
    <#
    .SYNOPSIS Writes a bold step header to distinguish phases in the output.
    #>
    param([string]$Message, [string]$Step = "")

    $separator = "─" * 70
    Write-Host ""
    Write-Host $separator -ForegroundColor Cyan
    if ($Step) {
        Write-Host "  [$Step] $Message" -ForegroundColor Cyan
    } else {
        Write-Host "  $Message" -ForegroundColor Cyan
    }
    Write-Host $separator -ForegroundColor Cyan
    Write-Host ""
}

function Write-Success {
    param([string]$Message)
    Write-Host "  ✅ $Message" -ForegroundColor Green
}

function Write-Warning {
    param([string]$Message)
    Write-Host "  ⚠️  $Message" -ForegroundColor Yellow
}

function Write-ErrorMessage {
    param([string]$Message)
    Write-Host "  ❌ $Message" -ForegroundColor Red
}

function Write-Info {
    param([string]$Message)
    Write-Host "  ℹ️  $Message" -ForegroundColor White
}

function Write-Progress-Step {
    param([string]$Message)
    Write-Host "  ⏳ $Message..." -ForegroundColor DarkCyan
}

# ── Prerequisite Checks ────────────────────────────────────────────────────────

function Test-Prerequisites {
    <#
    .SYNOPSIS
        Validates that required PowerShell modules are installed and the caller
        is authenticated to both Az and Microsoft Graph.

    .OUTPUTS
        $true if all checks pass; throws otherwise.
    #>
    param(
        [switch]$SkipAzCheck,
        [switch]$SkipGraphCheck
    )

    Write-StepHeader "Checking Prerequisites"

    $failed = $false

    # Az PowerShell module
    if (-not $SkipAzCheck) {
        Write-Progress-Step "Checking Az PowerShell module"
        if (-not (Get-Module -ListAvailable -Name Az.Accounts)) {
            Write-ErrorMessage "Az PowerShell module is not installed. Run: Install-Module -Name Az -Scope CurrentUser"
            $failed = $true
        } else {
            Write-Success "Az PowerShell module found"
        }

        # Check Az login context
        try {
            $ctx = Get-AzContext -ErrorAction Stop
            if (-not $ctx) {
                Write-ErrorMessage "Not logged in to Azure. Run: Connect-AzAccount"
                $failed = $true
            } else {
                Write-Success "Azure context: $($ctx.Account.Id) → $($ctx.Subscription.Name)"
            }
        } catch {
            Write-ErrorMessage "Not logged in to Azure. Run: Connect-AzAccount"
            $failed = $true
        }
    }

    # Microsoft.Graph SDK
    if (-not $SkipGraphCheck) {
        Write-Progress-Step "Checking Microsoft.Graph PowerShell SDK"
        if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
            Write-ErrorMessage "Microsoft.Graph SDK not installed. Run: Install-Module -Name Microsoft.Graph -Scope CurrentUser"
            $failed = $true
        } else {
            $graphVersion = (Get-Module -ListAvailable Microsoft.Graph.Authentication | Select-Object -First 1).Version
            Write-Success "Microsoft.Graph SDK v$graphVersion found"
        }

        # Check Graph login context
        try {
            $graphCtx = Get-MgContext -ErrorAction Stop
            if (-not $graphCtx) {
                Write-ErrorMessage "Not logged in to Microsoft Graph. Run: Connect-MgGraph -Scopes '...'"
                $failed = $true
            } else {
                Write-Success "Graph context: $($graphCtx.Account) (Scopes: $($graphCtx.Scopes -join ', '))"
            }
        } catch {
            Write-ErrorMessage "Not logged in to Microsoft Graph."
            $failed = $true
        }
    }

    if ($failed) {
        throw "Prerequisites check failed. Resolve the issues above and re-run."
    }

    Write-Success "All prerequisites satisfied"
    return $true
}

# ── Idempotent Resource Creation ───────────────────────────────────────────────

function Get-OrCreate {
    <#
    .SYNOPSIS
        Idempotent resource helper. Tries Get-ScriptBlock first; if it returns
        null/empty, runs Create-ScriptBlock and returns the result.

    .EXAMPLE
        $rg = Get-OrCreate `
            -ResourceName "my-resource-group" `
            -GetScriptBlock   { Get-AzResourceGroup -Name "my-rg" -ErrorAction SilentlyContinue } `
            -CreateScriptBlock { New-AzResourceGroup -Name "my-rg" -Location "eastus" }
    #>
    param(
        [string]$ResourceName,
        [scriptblock]$GetScriptBlock,
        [scriptblock]$CreateScriptBlock
    )

    Write-Progress-Step "Resolving '$ResourceName'"
    $existing = & $GetScriptBlock

    if ($existing) {
        Write-Warning "'$ResourceName' already exists — skipping creation"
        return $existing
    }

    Write-Info "Creating '$ResourceName'"
    $created = & $CreateScriptBlock
    Write-Success "'$ResourceName' created"
    return $created
}

# ── Graph API Wrapper ──────────────────────────────────────────────────────────

function Invoke-GraphApi {
    <#
    .SYNOPSIS
        Wrapper around Invoke-MgGraphRequest with consistent error handling,
        retry logic, and logging.

    .PARAMETER Method
        HTTP verb: GET, POST, PATCH, PUT, DELETE

    .PARAMETER Uri
        Graph endpoint path (relative, e.g. /beta/organization) or full URL.

    .PARAMETER Body
        Hashtable request body (auto-serialised to JSON).

    .PARAMETER MaxRetries
        Number of transient-failure retries (default 3).
    #>
    param(
        [ValidateSet("GET","POST","PATCH","PUT","DELETE")]
        [string]$Method = "GET",

        [Parameter(Mandatory)]
        [string]$Uri,

        [hashtable]$Body,

        [int]$MaxRetries = 3
    )

    # Normalise relative paths
    if ($Uri -notmatch "^https://") {
        $Uri = "https://graph.microsoft.com$Uri"
    }

    $attempt = 0
    while ($attempt -lt $MaxRetries) {
        $attempt++
        try {
            $params = @{
                Method = $Method
                Uri    = $Uri
            }
            if ($Body) {
                $params.Body        = ($Body | ConvertTo-Json -Depth 20 -Compress)
                $params.ContentType = "application/json"
            }

            $response = Invoke-MgGraphRequest @params -ErrorAction Stop
            return $response
        } catch {
            $statusCode = $_.Exception.Response?.StatusCode.value__
            if ($statusCode -in @(429, 503, 504) -and $attempt -lt $MaxRetries) {
                $delay = [math]::Pow(2, $attempt)
                Write-Warning "Graph API throttled ($statusCode). Retrying in ${delay}s (attempt $attempt/$MaxRetries)..."
                Start-Sleep -Seconds $delay
                continue
            }
            throw "Graph API call failed [$Method $Uri]: $($_.Exception.Message)"
        }
    }
}

# ── .env File Generation ───────────────────────────────────────────────────────

function ConvertTo-EnvFile {
    <#
    .SYNOPSIS
        Serialises a hashtable to a .env file.

    .PARAMETER Values
        Hashtable of key=value pairs to write.

    .PARAMETER Path
        Output path for the .env file. Defaults to .env in caller's directory.

    .PARAMETER Append
        Merge into an existing .env file rather than overwriting.
    #>
    param(
        [Parameter(Mandatory)]
        [hashtable]$Values,

        [string]$Path = ".env",

        [switch]$Append
    )

    $lines = @()
    $lines += "# Auto-generated by Entra Verified ID bootstrap scripts"
    $lines += "# Generated: $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')"
    $lines += "# DO NOT commit this file — add .env to .gitignore"
    $lines += ""

    foreach ($key in ($Values.Keys | Sort-Object)) {
        $val = $Values[$key]
        # Quote values that contain spaces or special characters
        if ($val -match '[\s#=]') {
            $val = "`"$val`""
        }
        $lines += "$key=$val"
    }

    if ($Append -and (Test-Path $Path)) {
        # Read existing, remove any keys we are about to write, then append new
        $existing = Get-Content $Path | Where-Object {
            $keyName = ($_ -split '=')[0].Trim()
            -not $Values.ContainsKey($keyName)
        }
        $lines = $existing + "" + $lines
    }

    $lines | Set-Content -Path $Path -Encoding UTF8
    Write-Success ".env written to $Path"
}

# ── Misc Utilities ─────────────────────────────────────────────────────────────

function Get-TenantOrganization {
    <#
    .SYNOPSIS Returns the current tenant's organisation object from Graph.
    #>
    $response = Invoke-GraphApi -Method GET -Uri "/v1.0/organization"
    return $response.value | Select-Object -First 1
}

function Assert-RequiredScopes {
    <#
    .SYNOPSIS
        Checks that the current Graph context has all required delegated scopes.
        Throws with a remediation message if any are missing.
    #>
    param([string[]]$Required)

    $ctx = Get-MgContext
    $current = @($ctx.Scopes | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })

    $authType = if ($ctx.PSObject.Properties['AuthType']) {
        [string]$ctx.AuthType
    } else {
        ""
    }
    $tokenCredentialType = if ($ctx.PSObject.Properties['TokenCredentialType']) {
        [string]$ctx.TokenCredentialType
    } else {
        ""
    }

    $isUserProvidedAccessToken = @($authType, $tokenCredentialType) -contains "UserProvidedAccessToken"

    if ($current.Count -eq 0 -and $isUserProvidedAccessToken) {
        Write-Warning "Skipping Graph scope validation: connected via a pre-issued access token and Get-MgContext does not expose scopes for this auth path. Ensure the token includes: $($Required -join ', ')"
        return
    }

    $missing = $Required | Where-Object { $_ -notin $current }

    if ($missing) {
        $scopeList = $missing -join ", "
        throw "Missing required Graph scopes: $scopeList`nRun: Connect-MgGraph -Scopes '$($Required -join "','")'"
    }
}

function Format-Summary {
    <#
    .SYNOPSIS Prints a formatted summary table of key=value pairs.
    #>
    param(
        [string]$Title,
        [hashtable]$Values
    )

    Write-Host ""
    Write-Host "  ┌─ $Title " -ForegroundColor Magenta
    foreach ($key in ($Values.Keys | Sort-Object)) {
        Write-Host "  │  $($key.PadRight(30)) $($Values[$key])" -ForegroundColor White
    }
    Write-Host "  └────────────────────────────────────────────────────" -ForegroundColor Magenta
    Write-Host ""
}
