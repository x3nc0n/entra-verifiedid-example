# Security Policy

## Supported version

This is a demonstration repository. The `main` branch is the supported reference
state; feature branches are not long-term supported releases.

## Pilot security boundary

The default `ASSURANCE_MODE=invitation` flow is a manager-approved pilot, not a
general-purpose identity-proofing system.

- An approved upstream workflow chooses the immutable Entra object ID.
- The browser never chooses or supplies the tenant account.
- The raw invitation token has 256 bits of entropy and is not stored.
- The invitation token exists only in the URL fragment, which is cleared before
  the browser posts it in an HTTPS JSON body.
- Normal application access logs record only request paths, not query strings,
  fragments, or request bodies.
- Invitation pages disable caching and referrer propagation.
- Known personal email and employee ID are hash-compared before consumption.
- Invitations expire, limit failed attempts, and reject replay.
- Invitation state is durable in Azure Table Storage and consumption uses ETag
  optimistic concurrency.
- Shared Express sessions use a separate Azure Table.
- Immediately before TAP creation, Graph reloads the immutable object ID and
  requires an enabled account with current pilot-group membership.
- TAPs are single-use, short-lived, shown once, and not stored in the session.
- Passkey registration is confirmed through Microsoft Graph.

Memory-backed invitations and sessions are allowed only for deliberate local
demo mode. Production startup rejects demo mode, missing pilot-group scope, and
non-durable state configuration. The future Verified ID callback flow remains
production-blocked until its callback state is durable.

## Demo mode

`DEMO_MODE=true` replaces Graph calls with clearly fake local values. Never expose
demo mode to real users or interpret its results as identity assurance.

## Production checklist

- [ ] `DEMO_MODE=false`.
- [ ] `SESSION_SECRET` is a random secret stored in Key Vault.
- [ ] `ONBOARDING_APPROVAL_API_KEY` is random, stored in Key Vault, and available only to the approved manager workflow.
- [ ] The approval endpoint is not reachable through an untrusted public client.
- [ ] Invitation delivery does not log or forward the fragment-bearing URL to analytics systems.
- [ ] Azure Table invitation/session storage and managed-identity RBAC are provisioned.
- [ ] `PILOT_GROUP_ID` identifies the approved dedicated pilot group.
- [ ] TAP and FIDO2 policy are scoped to that group and permit the configured lifetime.
- [ ] Runtime Graph app roles are reduced to the least-privilege user-read, TAP, and passkey roles supported by the tenant.
- [ ] HTTPS is enforced.
- [ ] Application logs and telemetry are checked for invitation/TAP leakage.
- [ ] Dependency audit and tests pass.
- [ ] Optional Verified ID mode has exact provider issuer/type/claim configuration and callback authentication.

## Vulnerability reporting

Do not open public issues for vulnerabilities. Use GitHub private vulnerability
reporting from the repository **Security** tab.

Include the affected route/file, impact, reproduction steps, environment, and a
suggested fix when available.

## In scope

- Invitation replay, brute force, token leakage, or account rebinding.
- Approval endpoint authentication bypass.
- TAP disclosure or creation for the wrong Entra object ID.
- Verified ID callback/subject validation bypass.
- Passkey registration against the wrong user or challenge.
- Session fixation or hijacking.
- Server-side injection and secret exposure.

Report Microsoft Entra, Verified ID, or Graph service vulnerabilities directly to
the [Microsoft Security Response Center](https://msrc.microsoft.com/).
