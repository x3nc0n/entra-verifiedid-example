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
- Invitation URL paths are redacted from application logs.
- Invitation pages disable caching and referrer propagation.
- Known personal email and employee ID are hash-compared before consumption.
- Invitations expire, limit failed attempts, and reject replay.
- TAP creation happens after invitation consumption.
- TAPs are single-use, short-lived, shown once, and not stored in the session.
- Passkey registration is confirmed through Microsoft Graph.

The in-memory invitation repository is safe only for a single-process pilot. Run
one always-on replica; scale-to-zero, restarts, or multiple replicas lose or split
invitation, session, and callback state until durable shared storage replaces it.

## Demo mode

`DEMO_MODE=true` replaces Graph calls with clearly fake local values. Never expose
demo mode to real users or interpret its results as identity assurance.

## Production checklist

- [ ] `DEMO_MODE=false`.
- [ ] `SESSION_SECRET` is a random secret stored in Key Vault.
- [ ] `ONBOARDING_APPROVAL_API_KEY` is random, stored in Key Vault, and available only to the approved manager workflow.
- [ ] The approval endpoint is not reachable through an untrusted public client.
- [ ] Invitation delivery does not log or forward the raw URL to analytics systems.
- [ ] The app runs one always-on replica, or all onboarding state uses durable shared storage.
- [ ] TAP policy is scoped to the pilot users and permits the configured lifetime.
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
