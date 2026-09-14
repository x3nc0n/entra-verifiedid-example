Set-StrictMode -Version Latest

function Test-EntraObjectId {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    return $Value -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
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

    $select = 'id,displayName,securityEnabled,mailEnabled,groupTypes'
    if (Test-EntraObjectId -Value $Selector) {
        $uri = "/v1.0/groups/$Selector`?`$select=$select"
        try {
            $candidate = & $RequestInvoker $uri
        } catch {
            throw "Unable to resolve $Purpose group object ID '$Selector': $($_.Exception.Message)"
        }
        $candidates = @($candidate)
    } else {
        $escapedName = $Selector.Replace("'", "''")
        $encodedFilter = [System.Uri]::EscapeDataString("displayName eq '$escapedName'")
        $uri = "/v1.0/groups?`$select=$select&`$filter=$encodedFilter&`$top=100"
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
