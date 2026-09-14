$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot '../scripts/helpers/manager-app-role-bootstrap.ps1')

function Assert-ThrowsLike {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Action,

        [Parameter(Mandatory = $true)]
        [string]$Pattern
    )

    try {
        & $Action
    } catch {
        if ($_.Exception.Message -notmatch $Pattern) {
            throw "Expected error matching '$Pattern'; received '$($_.Exception.Message)'."
        }
        return
    }

    throw "Expected error matching '$Pattern', but the action succeeded."
}

$tenantId = '11111111-2222-3333-4444-555555555555'
$context = [pscustomobject]@{
    TenantId = $tenantId
    Account = 'operator@example.test'
    Scopes = @('User.Read', 'Group.Read.All')
}
$profile = [pscustomobject]@{
    id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    userPrincipalName = 'operator@example.test'
}

Assert-ThrowsLike -Pattern 'Authenticated tenant mismatch' -Action {
    Assert-ExpectedGraphIdentity `
        -Context $context `
        -Profile $profile `
        -TenantId '99999999-2222-3333-4444-555555555555' `
        -ExpectedAccount 'operator@example.test'
}
Assert-ThrowsLike -Pattern 'Authenticated account mismatch' -Action {
    Assert-ExpectedGraphIdentity `
        -Context $context `
        -Profile $profile `
        -TenantId $tenantId `
        -ExpectedAccount 'different@example.test'
}
Assert-ThrowsLike -Pattern 'Microsoft Graph /me account mismatch' -Action {
    Assert-ExpectedAzureCliIdentity `
        -Account ([pscustomobject]@{
            tenantId = $tenantId
            user = [pscustomobject]@{ name = 'operator@example.test' }
        }) `
        -Profile ([pscustomobject]@{
            id = $profile.id
            userPrincipalName = 'different@example.test'
        }) `
        -TenantId $tenantId `
        -ExpectedAccount 'operator@example.test'
}
Assert-ThrowsLike -Pattern 'missing required read scope' -Action {
    Assert-RequiredGraphScopes `
        -Context ([pscustomobject]@{ Scopes = @('User.Read') }) `
        -RequiredScopes @('User.Read', 'Group.Read.All')
}

$adminId = 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb'
$usersId = 'cccccccc-1111-2222-3333-dddddddddddd'
$pagedRequests = [System.Collections.Generic.List[string]]::new()
$pagedInvoker = {
    param([string]$Uri)
    $pagedRequests.Add($Uri)
    if ($pagedRequests.Count -eq 1) {
        return [pscustomobject]@{
            value = @(
                [pscustomobject]@{
                    id = $adminId
                    displayName = 'Portal Admins'
                    securityEnabled = $true
                    mailEnabled = $false
                    groupTypes = @()
                }
            )
            '@odata.nextLink' = 'https://graph.microsoft.com/v1.0/groups?page=2'
        }
    }

    return [pscustomobject]@{
        value = @(
            [pscustomobject]@{
                id = $usersId
                displayName = 'Portal Admins'
                securityEnabled = $true
                mailEnabled = $false
                groupTypes = @()
            }
        )
    }
}
Assert-ThrowsLike -Pattern 'More than one exact administrator group' -Action {
    Resolve-ExactSecurityGroup `
        -Selector 'Portal Admins' `
        -Purpose 'administrator' `
        -RequestInvoker $pagedInvoker
}
if ($pagedRequests.Count -ne 2) {
    throw "Expected pagination to request two pages; requested $($pagedRequests.Count)."
}

$missingInvoker = {
    param([string]$Uri)
    return [pscustomobject]@{ value = @() }
}
Assert-ThrowsLike -Pattern 'No exact users group matched' -Action {
    Resolve-ExactSecurityGroup `
        -Selector 'Missing Users' `
        -Purpose 'users' `
        -RequestInvoker $missingInvoker
}

$nonSecurityInvoker = {
    param([string]$Uri)
    return [pscustomobject]@{
        id = $adminId
        displayName = 'Distribution List'
        securityEnabled = $false
        mailEnabled = $true
        groupTypes = @()
    }
}
Assert-ThrowsLike -Pattern 'is not security-enabled' -Action {
    Resolve-ExactSecurityGroup `
        -Selector $adminId `
        -Purpose 'administrator' `
        -RequestInvoker $nonSecurityInvoker
}

$failureInvoker = {
    param([string]$Uri)
    throw 'simulated Graph denial'
}
Assert-ThrowsLike -Pattern 'Microsoft Graph read failed.*simulated Graph denial' -Action {
    Get-GraphCollection `
        -Uri '/v1.0/groups?$top=100' `
        -RequestInvoker $failureInvoker
}

$commandCalls = [System.Collections.Generic.List[object]]::new()
$commandInvoker = {
    param([string[]]$Arguments)
    $commandCalls.Add(@($Arguments))
    if ($Arguments[0] -eq 'account') {
        return [pscustomobject]@{
            ExitCode = 0
            Output = '{"tenantId":"11111111-2222-3333-4444-555555555555","user":{"name":"operator@example.test"}}'
        }
    }
    return [pscustomobject]@{
        ExitCode = 0
        Output = '{"id":"aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee","userPrincipalName":"operator@example.test"}'
    }
}
$accountResult = ConvertFrom-AzureCliJson `
    -Arguments @('account', 'show', '--output', 'json') `
    -CommandInvoker $commandInvoker
$profileResult = ConvertFrom-AzureCliJson `
    -Arguments @('rest', '--method', 'GET', '--url', 'https://graph.microsoft.com/v1.0/me', '--output', 'json') `
    -CommandInvoker $commandInvoker
$cliIdentity = Assert-ExpectedAzureCliIdentity `
    -Account $accountResult `
    -Profile $profileResult `
    -TenantId $tenantId `
    -ExpectedAccount 'operator@example.test'
if ($cliIdentity.Account -ne 'operator@example.test' -or $commandCalls.Count -ne 2) {
    throw 'Expected Azure CLI account and /me commands to produce the verified identity.'
}
Assert-ThrowsLike -Pattern 'Azure CLI command failed with exit code 7.*simulated CLI failure' -Action {
    Invoke-AzureCliCommand `
        -Arguments @('account', 'show') `
        -CommandInvoker {
            param([string[]]$Arguments)
            [pscustomobject]@{ ExitCode = 7; Output = 'simulated CLI failure' }
        }
}

$groupUris = [System.Collections.Generic.List[string]]::new()
Resolve-ExactSecurityGroup `
    -Selector 'Portal Users' `
    -Purpose 'users' `
    -RequestInvoker {
        param([string]$Uri)
        $groupUris.Add($Uri)
        [pscustomobject]@{
            value = @(
                [pscustomobject]@{
                    id = $usersId
                    displayName = 'Portal Users'
                    securityEnabled = $true
                    mailEnabled = $false
                    groupTypes = @()
                }
            )
        }
    } | Out-Null
    if ($groupUris.Count -ne 1 -or $groupUris[0] -match '&' -or $groupUris[0] -notmatch '%24filter=') {
        throw "Group lookup URL is not safe for az.cmd invocation: '$($groupUris -join ',')'."
}

$successInvoker = {
    param([string]$Uri)
    return [pscustomobject]@{
        id = $usersId
        displayName = 'Portal Users'
        securityEnabled = $true
        mailEnabled = $false
        groupTypes = @('DynamicMembership')
    }
}
$resolved = Resolve-ExactSecurityGroup `
    -Selector $usersId `
    -Purpose 'users' `
    -RequestInvoker $successInvoker
if ($resolved.Id -ne $usersId -or $resolved.DisplayName -ne 'Portal Users') {
    throw 'Expected object-ID group resolution to return the mocked security group.'
}

$bootstrapPath = Join-Path $PSScriptRoot '../scripts/10-bootstrap-manager-app-role-prerequisites.ps1'
$bootstrapSource = Get-Content -LiteralPath $bootstrapPath -Raw
Assert-ThrowsLike {
    & $bootstrapPath -TenantId '11111111-1111-1111-1111-111111111111' `
        -ExpectedAccount 'operator@example.invalid' -AdminGroup 'Admins' -UsersGroup 'Users'
} 'Pre-existing User\.Read and Group\.Read\.All consent is required'
Assert-ThrowsLike {
    & $bootstrapPath -TenantId '11111111-1111-1111-1111-111111111111' `
        -ExpectedAccount 'operator@example.invalid' -AdminGroup 'Admins' -UsersGroup 'Users' `
        -ExistingConsentConfirmed -ReuseExistingLogin -UseDeviceCode
} 'cannot be used together'
if ($bootstrapSource.IndexOf('if (-not $ExistingConsentConfirmed)') -gt
    $bootstrapSource.IndexOf('$commandInvoker =')) {
    throw 'Consent prerequisite guard must run before Azure CLI authentication setup.'
}
if ($bootstrapSource.IndexOf("Write-Warning 'Cancel any new consent prompt.") -lt 0 -or
    $bootstrapSource.IndexOf("Write-Warning 'Cancel any new consent prompt.") -gt
    $bootstrapSource.IndexOf('Invoke-AzureCliCommand')) {
    throw 'Consent cancellation warning must precede Azure CLI browser authentication.'
}
foreach ($requiredText in @(
    '$ReuseExistingLogin',
    '$UseDeviceCode',
    'AZURE_CORE_ENABLE_BROKER_ON_WINDOWS',
    'AZURE_CORE_LOGIN_EXPERIENCE_V2',
    'allow-no-subscriptions',
    '--use-device-code',
    'Assert-ExpectedAzureCliIdentity',
    'finally'
)) {
    if ($bootstrapSource.IndexOf($requiredText) -lt 0) {
        throw "Bootstrap is missing required Azure CLI behavior '$requiredText'."
    }
}
if ($bootstrapSource.IndexOf('Resolve-ExactSecurityGroup') -lt
    $bootstrapSource.IndexOf('Assert-ExpectedAzureCliIdentity')) {
    throw 'Identity verification must precede all group reads.'
}
$forbiddenPatterns = @(
    'Connect-MgGraph',
    'Invoke-MgGraphRequest',
    '\b(New|Update|Remove)-Mg',
    '\baz\s+(ad|role|storage)\b',
    '\bgh\s+variable\s+set\b',
    '09-configure-manager-app-role-assignments\.ps1[^''"\r\n]*&'
)
foreach ($pattern in $forbiddenPatterns) {
    if ($bootstrapSource -match $pattern) {
        throw "Read-only bootstrap contains forbidden write pattern '$pattern'."
    }
    if ($bootstrapSource -match 'catch[\s\S]{0,300}--use-device-code' -or
        $bootstrapSource -match 'catch[\s\S]{0,300}az login') {
        throw 'Device-code authentication must not be an automatic fallback.'
    }
    if ($bootstrapSource.IndexOf('if ($UseDeviceCode)') -lt
        $bootstrapSource.IndexOf('$loginArguments =')) {
        throw 'Device-code flow must be selected only through the explicit switch.'
    }
    $loginArgumentSetup = $bootstrapSource.Substring(
        $bootstrapSource.IndexOf('$loginArguments ='),
        $bootstrapSource.IndexOf('if ($UseDeviceCode)') - $bootstrapSource.IndexOf('$loginArguments =')
    )
    if ($loginArgumentSetup -match 'use-device-code') {
        throw 'The default Azure CLI login arguments must not request device code.'
    }
}

$assignmentPath = Join-Path $PSScriptRoot '../scripts/09-configure-manager-app-role-assignments.ps1'
$assignmentSource = Get-Content -LiteralPath $assignmentPath -Raw
$confirmationIndex = $assignmentSource.IndexOf('if (-not $ConfirmAssignments)')
$firstWriteIndex = $assignmentSource.IndexOf('Update-MgApplication')
if ($confirmationIndex -lt 0 -or $firstWriteIndex -lt 0 -or $confirmationIndex -gt $firstWriteIndex) {
    throw 'The explicit assignment confirmation guard must precede the first app-role write.'
}

Write-Output 'Manager app-role bootstrap tests passed.'
