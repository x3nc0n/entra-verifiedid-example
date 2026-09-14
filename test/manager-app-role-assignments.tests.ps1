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

$adminId = [Guid]'5f7f9a56-2d8f-4f50-9f44-7dc5a77d5e91'
$userId = [Guid]'e4fb7f7f-0d17-4e0d-8f53-4e6d7f0f4f88'
$adminRole = New-ManagerAppRoleDefinition `
    -Id $adminId `
    -Value 'VerifiedId.Onboarding.Admin' `
    -DisplayName 'Verified ID onboarding administrator' `
    -Description 'Can access scoped v2 admin reset operations.'
$userRole = New-ManagerAppRoleDefinition `
    -Id $userId `
    -Value 'VerifiedId.Onboarding.User' `
    -DisplayName 'Verified ID onboarding user' `
    -Description 'Can sign in to manager approval and dashboard surfaces; Graph relationships still scope manager and skip-manager actions.'

$unrelatedRole = [pscustomobject]@{
    id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    allowedMemberTypes = @('User')
    description = 'Unrelated role'
    displayName = 'Unrelated role'
    isEnabled = $true
    value = 'Unrelated.Value'
    origin = 'Application'
    '@odata.type' = '#microsoft.graph.appRole'
}
$exactAdmin = [pscustomobject]$adminRole
$exactUser = [pscustomobject]$userRole
$exactAdmin | Add-Member -NotePropertyName origin -NotePropertyValue 'Application'
$exactUser | Add-Member -NotePropertyName origin -NotePropertyValue 'Application'
$exactPlan = Merge-ManagerAppRoleDefinitions `
    -ExistingRoles @($unrelatedRole, $exactAdmin, $exactUser) `
    -RequiredRoles @($adminRole, $userRole)
if ($exactPlan.Changed -or $exactPlan.Roles.Count -ne 3 -or
    -not ($exactPlan.Roles | Where-Object { $_.value -eq 'Unrelated.Value' })) {
    throw 'Exact existing roles should produce an idempotent plan preserving unrelated roles.'
}

$assignmentBody = New-ManagerAppRoleAssignmentBody `
    -GroupId 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb' `
    -ResourceServicePrincipalId '11111111-2222-3333-4444-555555555555' `
    -RoleId $adminId
if ($assignmentBody.Keys -join ',' -ne 'principalId,resourceId,appRoleId' -or
    $assignmentBody.principalId -ne 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb' -or
    $assignmentBody.resourceId -ne '11111111-2222-3333-4444-555555555555' -or
    $assignmentBody.appRoleId -ne $adminId.ToString()) {
    throw 'Assignment payload does not match the exact Graph app-role assignment contract.'
}

$newPlan = Merge-ManagerAppRoleDefinitions `
    -ExistingRoles @($unrelatedRole) `
    -RequiredRoles @($adminRole, $userRole)
if (-not $newPlan.Changed -or $newPlan.Roles.Count -ne 3) {
    throw 'Missing managed roles should produce an additive plan.'
}

foreach ($plan in @($exactPlan, $newPlan)) {
    $payload = @{ appRoles = @($plan.Roles) } | ConvertTo-Json -Depth 12 -Compress |
        ConvertFrom-Json
    foreach ($role in $payload.appRoles) {
        $keys = @($role.PSObject.Properties.Name | Sort-Object) -join ','
        if ($keys -cne 'allowedMemberTypes,description,displayName,id,isEnabled,value') {
            throw "App-role PATCH must contain only writable properties; received '$keys'."
        }
    }
    $preserved = $payload.appRoles | Where-Object { $_.id -eq $unrelatedRole.id }
    foreach ($key in @('id', 'description', 'displayName', 'isEnabled', 'value')) {
        if ($preserved.$key -cne $unrelatedRole.$key) {
            throw "App-role PATCH changed unrelated role property '$key'."
        }
    }
    if (($preserved.allowedMemberTypes -join ',') -cne ($unrelatedRole.allowedMemberTypes -join ',')) {
        throw 'App-role PATCH changed unrelated allowed member types.'
    }
}
if ($unrelatedRole.origin -ne 'Application' -or $exactAdmin.origin -ne 'Application') {
    throw 'Payload normalization must not mutate source Graph response objects.'
}

Assert-ThrowsLike -Pattern 'refusing to overwrite an unrelated role' -Action {
    Merge-ManagerAppRoleDefinitions `
        -ExistingRoles @([pscustomobject]@{
            id = $adminId.ToString()
            value = 'Other.Value'
            displayName = 'Other'
            description = 'Other'
            allowedMemberTypes = @('User')
            isEnabled = $true
        }) `
        -RequiredRoles @($adminRole, $userRole)
}
Assert-ThrowsLike -Pattern 'already exists with ID' -Action {
    Merge-ManagerAppRoleDefinitions `
        -ExistingRoles @([pscustomobject]@{
            id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
            value = $adminRole.value
            displayName = 'Other'
            description = 'Other'
            allowedMemberTypes = @('User')
            isEnabled = $true
        }) `
        -RequiredRoles @($adminRole, $userRole)
}
Assert-ThrowsLike -Pattern 'duplicate ID' -Action {
    Merge-ManagerAppRoleDefinitions `
        -ExistingRoles @(
            [pscustomobject]@{ id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; value = 'One' },
            [pscustomobject]@{ id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; value = 'Two' }
        ) `
        -RequiredRoles @($adminRole, $userRole)
}

$assignmentRequests = [System.Collections.Generic.List[string]]::new()
$assignmentInvoker = {
    param([string]$Uri)
    $assignmentRequests.Add($Uri)
    if ($assignmentRequests.Count -eq 1) {
        return [pscustomobject]@{
            value = @(
                [pscustomobject]@{
                    id = 'assignment-1'
                    resourceId = '11111111-2222-3333-4444-555555555555'
                    appRoleId = $adminId.ToString()
                }
            )
            '@odata.nextLink' = 'https://graph.microsoft.com/v1.0/groups/page-2'
        }
    }
    return [pscustomobject]@{ value = @() }
}
$assignmentState = Get-ManagerAppRoleAssignmentState `
    -GroupId 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb' `
    -ResourceServicePrincipalId '11111111-2222-3333-4444-555555555555' `
    -RoleId $adminId `
    -RequestInvoker $assignmentInvoker
if (-not $assignmentState.Exists -or $assignmentRequests.Count -ne 2) {
    throw 'Assignment discovery must follow pagination and detect an existing exact assignment.'
}

Assert-ThrowsLike -Pattern 'duplicate assignments' -Action {
    Get-ManagerAppRoleAssignmentState `
        -GroupId 'aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb' `
        -ResourceServicePrincipalId '11111111-2222-3333-4444-555555555555' `
        -RoleId $adminId `
        -RequestInvoker {
            param([string]$Uri)
            [pscustomobject]@{
                value = @(
                    [pscustomobject]@{
                        id = 'assignment-1'
                        resourceId = '11111111-2222-3333-4444-555555555555'
                        appRoleId = $adminId.ToString()
                    },
                    [pscustomobject]@{
                        id = 'assignment-2'
                        resourceId = '11111111-2222-3333-4444-555555555555'
                        appRoleId = $adminId.ToString()
                    }
                )
            }
        }
}

Write-Output 'Manager app-role assignment tests passed.'
