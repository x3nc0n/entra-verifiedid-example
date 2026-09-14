Set-StrictMode -Version Latest

function Test-EntraObjectId {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    return $Value -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
}

function Invoke-AzureCliCommand {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [scriptblock]$CommandInvoker
    )

    $execution = & $CommandInvoker $Arguments
    if ($null -eq $execution) {
        throw "Azure CLI command returned no execution result: az $($Arguments -join ' ')"
    }

    $exitCode = [int]$execution.ExitCode
    $output = [string]$execution.Output
    if ($exitCode -ne 0) {
        $detail = $output.Trim()
        if ([string]::IsNullOrWhiteSpace($detail)) {
            $detail = 'no diagnostic output'
        }
        throw "Azure CLI command failed with exit code ${exitCode}: az $($Arguments -join ' '). $detail"
    }

    return $output
}

function ConvertFrom-AzureCliJson {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,

        [Parameter(Mandatory = $true)]
        [scriptblock]$CommandInvoker
    )

    $output = Invoke-AzureCliCommand -Arguments $Arguments -CommandInvoker $CommandInvoker
    try {
        return $output | ConvertFrom-Json -ErrorAction Stop
    } catch {
        throw "Azure CLI returned invalid JSON for 'az $($Arguments -join ' ')': $($_.Exception.Message)"
    }
}

function Invoke-AzureCliLogin {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$TenantId,

        [Parameter(Mandatory = $true)]
        [bool]$ReuseExistingLogin,

        [Parameter(Mandatory = $true)]
        [bool]$UseDeviceCode,

        [Parameter(Mandatory = $true)]
        [scriptblock]$CommandInvoker
    )

    if ($ReuseExistingLogin) {
        return
    }

    Write-Warning 'Cancel any new consent prompt. Only pre-existing Azure CLI consent is authorized; this script cannot grant or suppress consent.'
    $loginArguments = @(
        'login',
        '--tenant',
        $TenantId,
        '--allow-no-subscriptions'
    )
    if ($UseDeviceCode) {
        Write-Warning 'Device-code authentication was explicitly selected. Tenant Conditional Access or location policy may disallow this flow; this script will not fall back automatically.'
        $loginArguments += '--use-device-code'
    }
    $loginArguments += @('--output', 'none')
    Invoke-AzureCliCommand `
        -Arguments $loginArguments `
        -CommandInvoker $CommandInvoker | Out-Null
}

function Assert-ExpectedAzureCliIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object]$Account,

        [Parameter(Mandatory = $true)]
        [object]$Profile,

        [Parameter(Mandatory = $true)]
        [string]$TenantId,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedAccount
    )

    if (-not (Test-EntraObjectId -Value $TenantId)) {
        throw 'TenantId must be an immutable Entra tenant ID GUID.'
    }

    $actualTenantId = [string]$Account.tenantId
    if (-not [string]::Equals($actualTenantId, $TenantId, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Authenticated tenant mismatch. Expected '$TenantId'; received '$actualTenantId'."
    }

    $actualAccount = [string]$Account.user.name
    if ([string]::IsNullOrWhiteSpace($actualAccount)) {
        throw 'Azure CLI account context did not identify an authenticated user.'
    }
    if (-not [string]::Equals($actualAccount, $ExpectedAccount, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Authenticated account mismatch. Expected '$ExpectedAccount'; received '$actualAccount'."
    }

    $profileAccount = [string]$Profile.userPrincipalName
    if ([string]::IsNullOrWhiteSpace($profileAccount)) {
        throw 'Microsoft Graph /me did not return the authenticated user principal name.'
    }
    if (-not [string]::Equals($profileAccount, $ExpectedAccount, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Microsoft Graph /me account mismatch. Expected '$ExpectedAccount'; received '$profileAccount'."
    }

    if ([string]::IsNullOrWhiteSpace([string]$Profile.id)) {
        throw 'Microsoft Graph /me did not return an authenticated user object ID.'
    }

    return [pscustomobject]@{
        TenantId = $actualTenantId
        Account = $actualAccount
        ObjectId = [string]$Profile.id
        UserPrincipalName = [string]$Profile.userPrincipalName
    }
}

function Assert-ExpectedGraphIdentity {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object]$Context,

        [Parameter(Mandatory = $true)]
        [object]$Profile,

        [Parameter(Mandatory = $true)]
        [string]$TenantId,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedAccount
    )

    if (-not (Test-EntraObjectId -Value $TenantId)) {
        throw 'TenantId must be an immutable Entra tenant ID GUID.'
    }

    $actualTenantId = [string]$Context.TenantId
    if (-not [string]::Equals($actualTenantId, $TenantId, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Authenticated tenant mismatch. Expected '$TenantId'; received '$actualTenantId'."
    }

    $actualAccount = [string]$Context.Account
    if (-not [string]::Equals($actualAccount, $ExpectedAccount, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Authenticated account mismatch. Expected '$ExpectedAccount'; received '$actualAccount'."
    }

    if ([string]::IsNullOrWhiteSpace([string]$Profile.id)) {
        throw 'Microsoft Graph /me did not return an authenticated user object ID.'
    }

    return [pscustomobject]@{
        TenantId = $actualTenantId
        Account = $actualAccount
        ObjectId = [string]$Profile.id
        UserPrincipalName = [string]$Profile.userPrincipalName
    }
}

function Assert-RequiredGraphScopes {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object]$Context,

        [Parameter(Mandatory = $true)]
        [string[]]$RequiredScopes
    )

    $grantedScopes = @($Context.Scopes | Where-Object {
        -not [string]::IsNullOrWhiteSpace([string]$_)
    })
    $missingScopes = @($RequiredScopes | Where-Object {
        $requiredScope = $_
        -not ($grantedScopes | Where-Object {
            [string]::Equals(
                [string]$_,
                $requiredScope,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        })
    })

    if ($missingScopes.Count -gt 0) {
        throw "Authenticated Graph context is missing required read scope(s): $($missingScopes -join ', ')."
    }
}

function Get-GraphResponseProperty {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object]$Response,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    if ($Response -is [System.Collections.IDictionary]) {
        return $Response[$Name]
    }

    $property = $Response.PSObject.Properties[$Name]
    if ($property) {
        return $property.Value
    }

    return $null
}

function Get-GraphCollection {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Uri,

        [Parameter(Mandatory = $true)]
        [scriptblock]$RequestInvoker
    )

    $items = @()
    $nextUri = $Uri
    $visitedUris = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )

    while (-not [string]::IsNullOrWhiteSpace($nextUri)) {
        if (-not $visitedUris.Add($nextUri)) {
            throw "Microsoft Graph returned a repeated pagination link for '$Uri'."
        }

        try {
            $response = & $RequestInvoker $nextUri
        } catch {
            throw "Microsoft Graph read failed for '$Uri': $($_.Exception.Message)"
        }

        $hasValueProperty = if ($response -is [System.Collections.IDictionary]) {
            $response.Contains('value')
        } else {
            $null -ne $response.PSObject.Properties['value']
        }
        if (-not $hasValueProperty) {
            throw "Microsoft Graph collection response for '$Uri' did not contain a value array."
        }

        $pageItems = Get-GraphResponseProperty -Response $response -Name 'value'
        $items += @($pageItems)
        $nextUri = [string](Get-GraphResponseProperty -Response $response -Name '@odata.nextLink')
    }

    return @($items)
}

function Resolve-ExactSecurityGroup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Selector,

        [Parameter(Mandatory = $true)]
        [string]$Purpose,

        [Parameter(Mandatory = $true)]
        [scriptblock]$RequestInvoker
    )

    if ([string]::IsNullOrWhiteSpace($Selector)) {
        throw "$Purpose group selector must be an exact display name or immutable object ID."
    }

    if (Test-EntraObjectId -Value $Selector) {
        $uri = "/v1.0/groups/$Selector"
        try {
            $candidate = & $RequestInvoker $uri
        } catch {
            throw "Unable to resolve $Purpose group object ID '$Selector': $($_.Exception.Message)"
        }
        $candidates = @($candidate)
    } else {
        $escapedName = $Selector.Replace("'", "''")
        $encodedFilter = [System.Uri]::EscapeDataString("displayName eq '$escapedName'")
        # Keep the URL to one query parameter so PowerShell cannot pass an
        # unquoted ampersand to az.cmd on Windows.
        $uri = "/v1.0/groups?%24filter=$encodedFilter"
        $candidates = @(Get-GraphCollection -Uri $uri -RequestInvoker $RequestInvoker |
            Where-Object {
                [string]::Equals(
                    [string]$_.displayName,
                    $Selector,
                    [System.StringComparison]::OrdinalIgnoreCase
                )
            })
    }

    if ($candidates.Count -eq 0) {
        throw "No exact $Purpose group matched '$Selector'."
    }
    if ($candidates.Count -gt 1) {
        throw "More than one exact $Purpose group matched '$Selector'; use the immutable object ID."
    }

    $group = $candidates[0]
    if (-not (Test-EntraObjectId -Value ([string]$group.id))) {
        throw "Resolved $Purpose group '$Selector' did not return a valid immutable object ID."
    }
    if ($group.securityEnabled -ne $true) {
        throw "Resolved $Purpose group '$([string]$group.displayName)' is not security-enabled."
    }

    return [pscustomobject]@{
        Purpose = $Purpose
        Id = [string]$group.id
        DisplayName = [string]$group.displayName
        SecurityEnabled = $true
        MailEnabled = [bool]$group.mailEnabled
        GroupTypes = @($group.groupTypes)
    }
}

function New-ManagerAppRoleDefinition {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [Guid]$Id,

        [Parameter(Mandatory = $true)]
        [string]$Value,

        [Parameter(Mandatory = $true)]
        [string]$DisplayName,

        [Parameter(Mandatory = $true)]
        [string]$Description
    )

    return [ordered]@{
        id = $Id.ToString()
        allowedMemberTypes = @('User')
        description = $Description
        displayName = $DisplayName
        isEnabled = $true
        value = $Value
    }
}

function Test-ManagerAppRoleDefinitionExact {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [object]$ExistingRole,

        [Parameter(Mandatory = $true)]
        [object]$RequiredRole
    )

    $existingAllowedMemberTypes = @((Get-GraphResponseProperty -Response $ExistingRole -Name 'allowedMemberTypes') |
        ForEach-Object { [string]$_ })
    $requiredAllowedMemberTypes = @($RequiredRole.allowedMemberTypes | ForEach-Object { [string]$_ })
    return (
        [string]::Equals([string](Get-GraphResponseProperty $ExistingRole 'id'), [string]$RequiredRole.id, [System.StringComparison]::OrdinalIgnoreCase) -and
        [string]::Equals([string](Get-GraphResponseProperty $ExistingRole 'value'), [string]$RequiredRole.value, [System.StringComparison]::Ordinal) -and
        [string]::Equals([string](Get-GraphResponseProperty $ExistingRole 'displayName'), [string]$RequiredRole.displayName, [System.StringComparison]::Ordinal) -and
        [string]::Equals([string](Get-GraphResponseProperty $ExistingRole 'description'), [string]$RequiredRole.description, [System.StringComparison]::Ordinal) -and
        ([bool](Get-GraphResponseProperty $ExistingRole 'isEnabled')) -eq [bool]$RequiredRole.isEnabled -and
        (@($existingAllowedMemberTypes) -join "`n") -ceq (@($requiredAllowedMemberTypes) -join "`n")
    )
}

function Merge-ManagerAppRoleDefinitions {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [object[]]$ExistingRoles,

        [Parameter(Mandatory = $true)]
        [object[]]$RequiredRoles
    )

    $existing = @($ExistingRoles)
    $result = [System.Collections.Generic.List[object]]::new()
    $changed = $false

    $duplicateIds = @($existing | Group-Object {
        [string](Get-GraphResponseProperty $_ 'id')
    } | Where-Object { $_.Count -gt 1 })
    if ($duplicateIds.Count -gt 0) {
        throw "Existing app roles contain duplicate ID '$($duplicateIds[0].Name)'; resolve manually before continuing."
    }
    $duplicateValues = @($existing | Group-Object {
        [string](Get-GraphResponseProperty $_ 'value')
    } | Where-Object { $_.Count -gt 1 })
    if ($duplicateValues.Count -gt 0) {
        throw "Existing app roles contain duplicate value '$($duplicateValues[0].Name)'; resolve manually before continuing."
    }

    foreach ($requiredRole in $RequiredRoles) {
        $sameId = @($existing | Where-Object {
            [string]::Equals(
                [string](Get-GraphResponseProperty $_ 'id'),
                [string]$requiredRole.id,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        })
        $sameValue = @($existing | Where-Object {
            [string]::Equals(
                [string](Get-GraphResponseProperty $_ 'value'),
                [string]$requiredRole.value,
                [System.StringComparison]::Ordinal
            )
        })

        if ($sameId.Count -gt 1 -or $sameValue.Count -gt 1) {
            throw "Existing app roles contain duplicate ID or value for '$($requiredRole.value)'; resolve manually before continuing."
        }
        if ($sameId.Count -eq 1 -and
            -not [string]::Equals(
                [string](Get-GraphResponseProperty $sameId[0] 'value'),
                [string]$requiredRole.value,
                [System.StringComparison]::Ordinal
            )) {
            throw "App role ID '$($requiredRole.id)' is already used by value '$([string](Get-GraphResponseProperty $sameId[0] 'value'))'; refusing to overwrite an unrelated role."
        }
        if ($sameValue.Count -eq 1 -and
            -not [string]::Equals(
                [string](Get-GraphResponseProperty $sameValue[0] 'id'),
                [string]$requiredRole.id,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
            throw "App role value '$($requiredRole.value)' already exists with ID '$([string](Get-GraphResponseProperty $sameValue[0] 'id'))'; refusing to overwrite an unrelated role."
        }
    }

    foreach ($role in $existing) {
        $requiredRole = $RequiredRoles | Where-Object {
            [string]::Equals(
                [string](Get-GraphResponseProperty $role 'id'),
                [string]$_.id,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        } | Select-Object -First 1
        if ($requiredRole) {
            if (-not (Test-ManagerAppRoleDefinitionExact -ExistingRole $role -RequiredRole $requiredRole)) {
                $result.Add($requiredRole)
                $changed = $true
            } else {
                $result.Add($role)
            }
        } else {
            $result.Add($role)
        }
    }

    foreach ($requiredRole in $RequiredRoles) {
        $present = $result | Where-Object {
            [string]::Equals(
                [string](Get-GraphResponseProperty $_ 'id'),
                [string]$requiredRole.id,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        }
        if (-not $present) {
            $result.Add($requiredRole)
            $changed = $true
        }
    }

    return [pscustomobject]@{
        # Graph response metadata (notably origin) is forbidden in app-role PATCHes.
        Roles = @($result | ForEach-Object {
            [ordered]@{
                id = Get-GraphResponseProperty $_ 'id'
                allowedMemberTypes = @(Get-GraphResponseProperty $_ 'allowedMemberTypes')
                description = Get-GraphResponseProperty $_ 'description'
                displayName = Get-GraphResponseProperty $_ 'displayName'
                isEnabled = Get-GraphResponseProperty $_ 'isEnabled'
                value = Get-GraphResponseProperty $_ 'value'
            }
        })
        Changed = $changed
    }
}

function Get-ManagerAppRoleAssignmentState {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$GroupId,

        [Parameter(Mandatory = $true)]
        [string]$ResourceServicePrincipalId,

        [Parameter(Mandatory = $true)]
        [Guid]$RoleId,

        [Parameter(Mandatory = $true)]
        [scriptblock]$RequestInvoker
    )

    $assignments = @(Get-GraphCollection `
        -Uri "/v1.0/groups/$GroupId/appRoleAssignments" `
        -RequestInvoker $RequestInvoker |
        Where-Object {
            [string]::Equals(
                [string](Get-GraphResponseProperty $_ 'resourceId'),
                $ResourceServicePrincipalId,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -and
            [string]::Equals(
                [string](Get-GraphResponseProperty $_ 'appRoleId'),
                $RoleId.ToString(),
                [System.StringComparison]::OrdinalIgnoreCase
            )
        })

    if ($assignments.Count -gt 1) {
        throw "Group '$GroupId' has duplicate assignments for resource '$ResourceServicePrincipalId' and role '$RoleId'; resolve manually before continuing."
    }

    return [pscustomobject]@{
        Exists = $assignments.Count -eq 1
        Assignment = if ($assignments.Count -eq 1) { $assignments[0] } else { $null }
    }
}

function New-ManagerAppRoleAssignmentBody {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$GroupId,

        [Parameter(Mandatory = $true)]
        [string]$ResourceServicePrincipalId,

        [Parameter(Mandatory = $true)]
        [Guid]$RoleId
    )

    return [ordered]@{
        principalId = $GroupId
        resourceId = $ResourceServicePrincipalId
        appRoleId = $RoleId.ToString()
    }
}
