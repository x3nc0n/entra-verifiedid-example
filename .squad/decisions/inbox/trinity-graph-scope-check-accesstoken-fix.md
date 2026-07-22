# Trinity: Graph scope check fix for raw access-token auth

- Date: 2026-07-22
- Area: PowerShell bootstrap scripts / Microsoft Graph auth

## Decision

Correct `Assert-RequiredScopes` in `scripts/helpers/common.ps1` so Graph delegated scope validation treats `*.ReadWrite*` as satisfying the corresponding `*.Read*` requirement for the same permission prefix, while keeping exact-match validation for everything else.

## Why

The previous diagnosis in commit `4084126` was wrong. Re-verification showed that `Connect-MgGraph -AccessToken ...` can populate `Get-MgContext().Scopes` correctly for the Azure CLI-issued delegated token used here.

The actual failure was a naive exact-string comparison in `Assert-RequiredScopes`: `08-grant-app-uami-graph-permissions.ps1` required `Application.Read.All`, while the caller's token contained `Application.ReadWrite.All`. That granted scope is a strict privilege superset for the same permission family, but the old helper still marked it missing because the literal strings differ.

## Implementation

- Added a small helper that evaluates whether a granted scope satisfies a required scope.
- Exact matches still pass unchanged.
- A required `X.Read.All` is now satisfied by granted `X.ReadWrite.All`.
- A required `X.Read` is now satisfied by granted `X.ReadWrite`.
- Prefixes must still match exactly, so unrelated scopes such as `AuditLog.Read.All` do not satisfy `Application.Read.All`.
- The earlier `UserProvidedAccessToken` / empty-Scopes warning branch remains only as a defensive fallback for sessions where `Get-MgContext` truly exposes no scopes; it is no longer the primary fix or root-cause explanation.

## Impact

- Fixes the false negative in `scripts/08-grant-app-uami-graph-permissions.ps1` for Azure CLI-issued delegated Graph tokens that include `Application.ReadWrite.All` but not the narrower literal `Application.Read.All`.
- Keeps all existing call sites backward compatible because the new behavior is only an additive relaxation from `Read` to matching `ReadWrite`; it never treats `Read` as satisfying `ReadWrite`, and it never crosses permission prefixes.
