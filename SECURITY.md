# Security Policy

## Supported version

This is a demonstration repository. The `main` branch is the supported reference
state; feature branches are not long-term supported releases.

## Pilot security boundary

The application now exposes only the manager-approved self-service Verified ID
onboarding flow.

- The browser submits only the employee UPN and employee ID; Graph selects the
  immutable employee object ID and current manager.
- The raw manager approval token exists only in the URL fragment and is never
  stored.
- Normal application access logs record only request paths, not query strings,
  fragments, or request bodies.
- Manager approval pages disable caching and referrer propagation and deny
  framing.
- Verified ID presentation is constrained to the exact onboarding-bound object
  ID and employee ID.
- Request state is durable in Azure Table Storage and uses optimistic
  concurrency for critical transitions.
- Shared Express sessions use a separate Azure Table.
- Immediately before TAP creation, Graph reloads the bound employee and requires
  an enabled account with current pilot-group membership.
- TAPs are single-use, short-lived, shown once, and not retained after display.
- Passkey registration is confirmed through Microsoft Graph.

Memory-backed state is allowed only for deliberate local demo mode. Production
startup rejects demo mode, missing pilot-group scope, missing v2 configuration,
and non-durable state configuration.

## Demo mode

`DEMO_MODE=true` replaces supported Graph and Verified ID calls with clearly fake
local values. Never expose demo mode to real users or interpret its results as
identity assurance.

## Production checklist

- [ ] `DEMO_MODE=false`.
- [ ] `SESSION_SECRET` is a random secret stored in Key Vault.
- [ ] `V2_TRANSIENT_PROTECTION_KEY` is a random base64-encoded 32-byte key.
- [ ] `V2_MANAGER_OIDC_CLIENT_SECRET` is random and stored securely.
- [ ] `V2_VERIFIED_ID_CALLBACK_API_KEY` is random and stored securely.
- [ ] Manager approval delivery does not log or forward the fragment-bearing URL.
- [ ] Azure Table session/request storage and managed-identity RBAC are provisioned.
- [ ] `PILOT_GROUP_ID` identifies the approved dedicated pilot group.
- [ ] TAP and FIDO2 policy are scoped to that group and permit the configured lifetime.
- [ ] Runtime Graph app roles are reduced to the least-privilege user-read, TAP, and passkey roles supported by the tenant.
- [ ] HTTPS is enforced.
- [ ] Application logs and telemetry are checked for manager-link, PIN, and TAP leakage.
- [ ] Dependency audit and tests pass.
- [ ] Verified ID authority, type, linked domain, claims, and callback authentication match the dedicated v2 contract.

## Vulnerability reporting

Do not open public issues for vulnerabilities. Use GitHub private vulnerability
reporting from the repository **Security** tab.

Include the affected route/file, impact, reproduction steps, environment, and a
suggested fix when available.

## In scope

- Manager approval token replay, brute force, leakage, or account rebinding.
- Manager sign-in, callback, or approval authorization bypass.
- Verified ID callback, presentation, or subject validation bypass.
- TAP disclosure or creation for the wrong Entra object ID.
- Passkey confirmation against the wrong user.
- Session fixation or hijacking.
- Server-side injection and secret exposure.

Report Microsoft Entra, Verified ID, or Graph service vulnerabilities directly to
[the Microsoft Security Response Center](https://msrc.microsoft.com/).
