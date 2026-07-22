# Trinity: Dynamic Graph/VCS app role resolution by name

- Date: 2026-07-22
- Area: PowerShell permission-grant automation / Entra service principals

## Decision

Stop hardcoding Microsoft Graph and Verified ID Request Service app-role GUIDs in `scripts/08-grant-app-uami-graph-permissions.ps1`. Store only the role value strings and resolve the current tenant's role IDs dynamically from the target resource service principal's `AppRoles` collection at runtime.

## Why

Live execution against the Spaid Family tenant proved the previously hardcoded Verified ID Request Service role IDs were stale/incorrect. The script requested the correct permission names, but it submitted GUIDs that did not exist on that tenant's `Verifiable Credentials Service Request` service principal, which produced a generic Graph `400 BadRequest` (`Permission being assigned was not found on application ...`).

Hardcoding these IDs is fragile even when it appears to work, because the real source of truth during assignment is the resource service principal present in the tenant being targeted. Resolving by `AppRoles.Value` makes failures deterministic and diagnosable.

## Implementation

- Changed both `$GRAPH_APP_ROLES` and `$VCS_REQUEST_APP_ROLES` to arrays of role-name strings only.
- Updated `Get-ResourceServicePrincipal` to fetch the resource service principal with `appRoles` included.
- Updated `Grant-AppRolesToPrincipal` to:
  - accept role names instead of `{ Id, Name }` objects
  - look up the live app-role object with `Where-Object { $_.Value -eq $roleName }`
  - use the resolved `Id` for duplicate detection and assignment
  - throw a clear error listing available roles when a requested role name is missing

## Live tenant reference

Verified ID Request Service (`appId 3db474b9-6a0c-4840-96ac-1fceb342124f`, display name `Verifiable Credentials Service Request`) exposed these role IDs when queried directly in the live tenant:

- `0165bd66-5f36-41ef-abde-4e8fc0c91294` → `VerifiableCredential.Create.IssueRequest`
- `410607a4-22de-48a8-b35d-ad33c0c2e1bf` → `VerifiableCredential.Create.PresentRequest`
- `949ebb93-18f8-41b4-b677-c2bfea940027` → `VerifiableCredential.Create.All`

These values are recorded here for debugging/reference only; the script should continue resolving IDs dynamically by role name rather than treating these GUIDs as durable constants.
