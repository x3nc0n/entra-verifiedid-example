# Trinity: Graph scope check fix for raw access-token auth

- Date: 2026-07-22
- Area: PowerShell bootstrap scripts / Microsoft Graph auth

## Decision

Update `Assert-RequiredScopes` in `scripts/helpers/common.ps1` to detect Microsoft Graph PowerShell sessions established with a user-provided access token and skip local scope validation when `Get-MgContext().Scopes` is empty for that auth path.

## Why

`Connect-MgGraph -AccessToken ...` can produce a valid delegated Graph session, but `Get-MgContext().Scopes` is not populated for `UserProvidedAccessToken` authentication. The old helper treated the empty scope list as missing permissions and falsely blocked scripts such as `08-grant-app-uami-graph-permissions.ps1`, even when the caller's token already contained the required delegated permissions.

## Implementation

- Keep the existing strict missing-scope failure for normal interactive/device-code/delegated flows where `Scopes` is populated.
- If the Graph context reports `AuthType` or `TokenCredentialType` as `UserProvidedAccessToken` **and** `Scopes` is empty, emit a warning and skip the local scope assertion.
- Do not attempt JWT decoding in the helper because the raw token is not available from `Get-MgContext`; the operator must ensure the pre-issued token was requested with sufficient scopes.

## Impact

- Fixes false negatives for deploy-session workflows that connect Graph using a pre-issued Azure CLI token.
- Leaves all existing call sites backward compatible because only the user-provided access-token edge case changes behavior.
