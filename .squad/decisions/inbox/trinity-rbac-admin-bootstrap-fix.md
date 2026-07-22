### 2026-07-22: Deploy UAMI needs RBAC admin at RG scope for Bicep role assignments
**By:** Trinity

- Date: 2026-07-22
- Scope: GitHub Actions bootstrap, Azure RBAC, infra deployment reproducibility

## Gap

The GitHub Actions deploy UAMI (`uami-entra-verifiedid-example-deploy`) previously received only `Contributor` on the application resource group. That was enough for most ARM/Bicep resource writes, but it failed on `Microsoft.Authorization/roleAssignments/write`.

`infra/main.bicep` creates role assignments such as `AcrPull` and `Key Vault Secrets User` for managed identities. During a real tenant deployment, those resources failed because `Contributor` does not include role-assignment write permission.

## Fix

Keep the existing `Contributor` grant and add `Role Based Access Control Administrator` at the same resource-group scope during `scripts/07-bootstrap-github-actions-uami.ps1`.

- Role definition ID: `f58310d9-a9f6-439a-9e8d-f62e7b41a168`
- Scope: target application resource group

The script remains idempotent by checking for an existing role assignment before creating it.

## Why this role

`Role Based Access Control Administrator` is the least-privilege fit here: it allows the deploy identity to create and delete role assignments within scope, but it is narrower than `User Access Administrator` and cannot grant `Owner` or `User Access Administrator`.

