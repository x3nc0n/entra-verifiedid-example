$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$entryPoint = Join-Path $PSScriptRoot '../scripts/bootstrap-manager-app-roles.ps1'
$source = Get-Content -LiteralPath $entryPoint -Raw

foreach ($requiredText in @(
    '10-bootstrap-manager-app-role-prerequisites.ps1',
    '09-configure-manager-app-role-assignments.ps1',
    'ExistingConsentConfirmed',
    'ExistingWriteConsentConfirmed',
    'ConfirmAssignments',
    'WhatIf',
    'ReuseExistingLogin',
    'UseDeviceCode'
)) {
    if ($source.IndexOf($requiredText) -lt 0) {
        throw "Public manager-role entry point is missing '$requiredText'."
    }
}

if ($source -match '05-deploy-infrastructure|New-AzResourceGroupDeployment|bootstrap\.ps1') {
    throw 'Manager-role entry point must not trigger infrastructure orchestration.'
}
if ($source.IndexOf('10-bootstrap-manager-app-role-prerequisites.ps1') -gt
    $source.IndexOf('09-configure-manager-app-role-assignments.ps1')) {
    throw 'Public manager-role entry point must run read-only discovery before assignment planning.'
}

Write-Output 'Public manager-role entry point tests passed.'
