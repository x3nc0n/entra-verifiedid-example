# Microsoft Entra Self-Service Verified ID Onboarding

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fx3nc0n%2Fentra-verifiedid-example%2Fmain%2Fazuredeploy.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20 LTS](https://img.shields.io/badge/node-20%20LTS-brightgreen.svg)](https://nodejs.org/)

This Node.js/Express portal now runs the v2 Microsoft Entra Verified ID
experience for both manager-approved onboarding and self-service recovery.

## Flow overview

### Employee self-service onboarding

1. The employee submits the directory UPN and employee ID.
2. Graph resolves the immutable employee object ID and current manager.
3. The app creates a durable onboarding request and a one-time manager approval
   token stored only as a hash.
4. The current Entra manager opens the approval link at
   `GET /v2/manager/approval`, signs in through the dedicated single-tenant OIDC
   application, and records an approve or reject decision.
5. After approval, the employee requests issuance of the dedicated onboarding
   credential and then presents it back to the portal.
6. The callback validates issuer, credential type, linked domain, revocation
   status, and the exact bound object ID plus employee ID before Microsoft Graph
   can create a short-lived, single-use Temporary Access Pass (TAP).
7. The employee signs in with the TAP, registers a tenant passkey, and confirms
   the new FIDO2 method to finish onboarding.

### Manager-initiated onboarding

1. The manager signs in at `GET /v2/manager/dashboard`.
2. Graph returns the signed-in manager's direct reports.
3. The manager generates a one-time employee invitation for a direct report.
4. The employee opens `GET /v2/onboarding/invite`, confirms UPN plus employee
   ID, and then continues through the same Verified ID + TAP + passkey flow.

### Self-service recovery

1. The employee opens `GET /v2/recovery` and submits UPN plus employee ID.
2. The app returns a generic response and, only after server-side eligibility
   checks, creates a recovery request bound to the browser and notifies the
   current manager.
3. The direct manager approves, or the employee requests escalation to exactly
   the direct manager's manager; both authority checks are revalidated live from
   Graph at decision time.
4. After approval, the employee presents the existing Verified ID credential.
5. The callback validates the same bound object ID and employee ID claims.
6. Before a replacement TAP is issued, Microsoft Graph revokes every existing
   FIDO2 method for that employee.
7. The employee signs in with the one-time TAP and registers a replacement
   tenant passkey.

The legacy v1 invitation-based and pre-v2 flows remain removed from the
application.

## Runtime routes

| Route | Purpose |
|-------|---------|
| `GET /` | Redirect to the canonical onboarding entry point. |
| `GET /v2/onboarding` | Employee intake and session-bound status UI. |
| `GET /v2/onboarding/invite` | Employee confirmation screen for a manager-generated invitation. |
| `POST /api/v2/onboarding/requests` | Validate directory evidence and create a durable request with a generic response. |
| `POST /api/v2/onboarding/invitations/activate` | Hash and bind the one-time employee invitation token to a short pre-auth session. |
| `POST /api/v2/onboarding/invitations/confirm` | Confirm the invited employee identity before continuing onboarding. |
| `GET /api/v2/onboarding/status` | Return coarse progress for the bound employee session. |
| `GET /v2/manager/dashboard` | Signed-in manager dashboard for direct-report invitation generation. |
| `POST /api/v2/verified-id/issuance/requests` | Create a dedicated Verified ID issuance request. |
| `POST /api/v2/verified-id/issuance/callback` | Authenticate and correlate issuance callbacks. |
| `POST /api/v2/verified-id/presentation/requests` | Create the constrained presentation request. |
| `POST /api/v2/verified-id/presentation/callback` | Validate the credential and idempotently create TAP. |
| `GET /v2/manager/approval` | Activate the fragment approval token and show the manager decision UI. |
| `POST /api/v2/manager-approvals/activate` | Hash and bind the one-time manager token to a short pre-auth session. |
| `POST /api/v2/manager-approvals/:requestKind/:requestId/escalate` | Let the browser-bound employee request skip-level approval from exactly the direct manager's manager. |
| `POST /api/v2/manager/invitations` | Validate a selected direct report and create a manager-initiated onboarding request. |
| `GET /auth/manager/signin` | Start the single-tenant manager OIDC/PKCE flow. |
| `GET /auth/manager/dashboard/signin` | Start the manager-dashboard OIDC/PKCE flow. |
| `GET /auth/admin/signin` | Start the admin OIDC/PKCE flow before live group membership authorization. |
| `POST /auth/manager/callback` | Validate the manager identity and atomically redeem the token. |
| `POST /api/v2/manager-approvals/:requestId/decision` | Recheck the manager relationship and record the decision. |
| `GET /v2/admin` | Portal administrator operation entry point. |
| `POST /api/v2/admin/requests/:requestKind/:requestId/reset` | Audited scoped cancel/restart/unblock operation guarded by admin group membership and ETag. |
| `GET /v2/recovery` | Recovery intake and session-bound status UI. |
| `POST /api/v2/recovery/requests` | Validate intake evidence and create a recovery request with a generic response. |
| `GET /api/v2/recovery/status` | Return coarse progress for the bound recovery session. |
| `POST /api/v2/recovery/verified-id/presentation/requests` | Create the constrained recovery presentation request. |
| `POST /api/v2/recovery/verified-id/presentation/callback` | Validate the recovery credential and revoke passkeys before TAP issuance. |
| `GET /v2/recovery/passkey` | Display the protected recovery TAP once and direct the user to Security info. |
| `POST /api/v2/recovery/passkey/confirm` | Confirm a newly added replacement Graph FIDO2 method. |
| `GET /v2/recovery/complete` | Finalize the recovery request and destroy the recovery session. |
| `GET /v2/passkey` | Display the protected TAP once and direct the user to Security info. |
| `POST /api/v2/passkey/confirm` | Confirm a newly added Graph FIDO2 method. |
| `GET /v2/complete` | Finalize the request and destroy the onboarding session. |
| `GET /health` | Health probe. |

## Security properties

- Manager approval links carry the bearer token only in the URL fragment.
- The raw manager token is never stored; only its SHA-256 hash is persisted.
- Employee invitation links also carry a fragment token that is stored only as a
  SHA-256 hash.
- Requests, rate limits, callback correlation, and state transitions are durable
  and concurrency-safe in Azure Table Storage.
- Verified ID presentation is constrained to the exact employee object ID and
  employee ID recorded at intake.
- Manager sign-in uses PKCE, state, nonce, and tenant/object-ID validation.
- Admin authority comes from live membership in the configured immutable admin
  group object ID. User, manager, and skip-manager eligibility comes from live
  membership in the configured immutable users group object ID.
- Manager dashboard OIDC transaction state is durable, so `form_post`
  callbacks do not rely on SameSite=Strict cookies carrying session-only
  pre-auth state across a cross-site POST.
- Recovery requires manager or skip-level approval plus re-presentation of the
  existing Verified ID before passkeys are revoked and a replacement TAP is
  issued.
- Recovery revokes all existing FIDO2 methods before replacement passkey setup.
- Cache-control, referrer, frame, content-type, and CSP headers are applied
  across the app.
- TAP values are single-use, short-lived, encrypted at rest, displayed once,
  and cleared after first display.
- Completion requires Graph to report a newly added FIDO2 method.

## Quick start

```powershell
npm ci
$env:DEMO_MODE = 'true'
npm test
npm start
```

Open `http://localhost:3000`.

Demo mode still allows local rendering and tests without live tenant resources.
A full end-to-end onboarding run requires the live v2 manager OIDC, Verified ID,
Table Storage, and Graph configuration described below.

## Configuration

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NODE_ENV` | No | `development` | Runtime environment. |
| `PORT` | No | `3000` | Express port. |
| `SESSION_SECRET` | Production | Development placeholder | Session signing secret. |
| `APP_BASE_URL` | Production | `http://localhost:3000` | Public origin used for approval links and callbacks. |
| `DEMO_MODE` | No | `false` | Use local simulated Graph and Verified ID responses where supported. |
| `AZURE_TENANT_ID` | Live | None | Entra tenant GUID. |
| `AZURE_CLIENT_ID` | Azure UAMI | None | Runtime user-assigned managed identity client ID. |
| `AZURE_CLIENT_SECRET` | No | None | Deprecated runtime secret; preserved only for bootstrap compatibility. |
| `AZURE_AUTHORITY` | No | `https://login.microsoftonline.com/<tenant>` | Entra authority base URL. |
| `PILOT_GROUP_ID` | Live | None | Dedicated pilot-group object ID rechecked before TAP creation. |
| `V2_ADMIN_GROUP_ID` | Live | None | Immutable object ID of the security group authorized for portal admin reset operations. |
| `V2_USERS_GROUP_ID` | Live | None | Immutable object ID of the security group required for employee, manager, and skip-level participation. |
| `ONBOARDING_STATE_BACKEND` | Live | `memory` | Must be `azure-table` outside local demo mode. |
| `AZURE_STORAGE_TABLE_ENDPOINT` | Live | None | HTTPS endpoint for the managed-identity-backed Table service. |
| `ONBOARDING_SESSIONS_TABLE` | No | `onboardingSessions` | Shared Express session table name. |
| `ONBOARDING_V2_REQUESTS_TABLE` | No | `onboardingV2Requests` | Durable v2 request, rate-limit, and audit table name. |
| `VC_SERVICE_SCOPE` | No | Request Service default | Verified ID Request Service token scope shared by the v2 endpoints. |
| `V2_REQUEST_LIFETIME_MINUTES` | No | `1440` | Request validity window. |
| `V2_MANAGER_TOKEN_LIFETIME_MINUTES` | No | `1440` | Manager approval-token validity window. |
| `V2_MANAGER_PREAUTH_LIFETIME_MINUTES` | No | `10` | Short pre-auth binding lifetime after approval-token activation. |
| `V2_MAX_DAILY_REQUESTS_PER_UPN` | No | `3` | Daily employee UPN request limit. |
| `V2_MAX_DAILY_REQUESTS_PER_IP` | No | `10` | Daily client IP request limit. |
| `V2_MAX_DAILY_REQUESTS_PER_EMPLOYEE` | No | `3` | Daily immutable employee-object request limit. |
| `V2_MAX_DAILY_MANAGER_INVITATIONS` | No | `20` | Daily manager-dashboard invitation limit per signed-in manager. |
| `V2_MAX_EMPLOYEE_INVITE_CONFIRM_ATTEMPTS` | No | `3` | Employee invitation identity-confirmation failure limit before lock. |
| `V2_MAX_PASSKEY_CONFIRM_ATTEMPTS` | No | `30` | Confirmation retry limit. |
| `V2_MAX_ISSUANCE_RETRIES` | No | `3` | Issuance retry limit. |
| `V2_MAX_PRESENTATION_RETRIES` | No | `3` | Presentation retry limit. |
| `V2_MAX_VERIFICATION_FAILURES` | No | `3` | Verified ID validation failure limit. |
| `V2_RECOVERY_REQUEST_LIFETIME_MINUTES` | No | `60` | Recovery request validity window. |
| `V2_RECOVERY_MAX_DAILY_REQUESTS_PER_IP` | No | `5` | Daily recovery request limit per client IP. |
| `V2_RECOVERY_MAX_DAILY_REQUESTS_PER_UPN` | No | `3` | Daily recovery request limit per employee UPN. |
| `V2_RECOVERY_MAX_DAILY_REQUESTS_PER_EMPLOYEE` | No | `3` | Daily recovery request limit per immutable employee object. |
| `V2_RECOVERY_MAX_PRESENTATION_RETRIES` | No | `3` | Recovery credential-presentation retry limit. |
| `V2_RECOVERY_MAX_VERIFICATION_FAILURES` | No | `3` | Recovery Verified ID validation failure limit. |
| `V2_RECOVERY_MAX_PASSKEY_CONFIRM_ATTEMPTS` | No | `30` | Recovery replacement-passkey confirmation retry limit. |
| `V2_TRANSIENT_PROTECTION_KEY` | Live | None | Base64-encoded 32-byte AES-GCM key for transient PIN and TAP protection. |
| `V2_MANAGER_OIDC_CLIENT_ID` | Live | None | Dedicated single-tenant manager OIDC application client ID. |
| `V2_MANAGER_OIDC_CLIENT_SECRET` | Live | None | Manager OIDC confidential-client secret. |
| `V2_MANAGER_OIDC_REDIRECT_URI` | Live | `<APP_BASE_URL>/auth/manager/callback` | HTTPS `form_post` callback. |
| `V2_VERIFIED_ID_AUTHORITY` | Live | None | Exact tenant Verified ID authority DID. |
| `V2_VERIFIED_ID_MANIFEST_URL` | Live | None | Dedicated v2 contract manifest URL. |
| `V2_VERIFIED_ID_CREDENTIAL_TYPE` | Live | None | Dedicated v2 credential type. |
| `V2_VERIFIED_ID_OBJECT_ID_CLAIM` | Live | None | Object-ID claim path in issued and presented credentials. |
| `V2_VERIFIED_ID_EMPLOYEE_ID_CLAIM` | Live | None | Employee-ID claim path in issued and presented credentials. |
| `V2_VERIFIED_ID_LINKED_DOMAIN` | Live | None | Exact verified linked domain host name. |
| `V2_VERIFIED_ID_CALLBACK_API_KEY` | Live | None | Shared callback authentication value. |
| `V2_VERIFIED_ID_ISSUANCE_PIN_LENGTH` | No | `6` | Issuance PIN length. |
| `V2_MANAGER_NOTIFICATION_PROVIDER` | No | `noop` | `acs` for live delivery, `noop` for tests. |
| `V2_ACS_EMAIL_ENDPOINT` | ACS managed identity | None | ACS HTTPS endpoint. Preferred live mode. |
| `V2_ACS_EMAIL_SENDER_ADDRESS` | ACS | None | Verified ACS Email sender address. |
| `V2_ACS_EMAIL_CONNECTION_STRING` | ACS fallback | None | ACS connection string used only when no endpoint is configured. |
| `TAP_LIFETIME_MINUTES` | No | `60` | TAP validity, always single-use. |
| `ENTRA_SECURITY_INFO_URL` | No | Microsoft Security info | TAP sign-in and passkey registration destination. |
| `FIDO2_RP_NAME` | Demo only | `Entra Verified ID Demo` | Local demo relying-party name. |
| `FIDO2_RP_ID` | Demo only | `localhost` | Local demo relying-party ID. |
| `FIDO2_ORIGIN` | Demo only | `http://localhost:3000` | Local demo WebAuthn origin. |
| `KEY_VAULT_URL` | No | None | Preserved for deployment contract alignment and secret wiring. |

## Azure delivery notes

Application code now assumes the v2 self-service flow is always on. The current
infrastructure and deployment workflows may still set legacy environment values.
Those legacy values are now orphaned application-side and should be cleaned up
by infra owners in a follow-up change:

- `ASSURANCE_MODE`
- `SELF_SERVICE_V2_ENABLED`
- `ONBOARDING_APPROVAL_API_KEY`
- `ONBOARDING_INVITATIONS_TABLE`
- `INVITATION_LIFETIME_MINUTES`
- `INVITATION_MAX_ATTEMPTS`
- `VC_VERIFIER_AUTHORITY`
- `VC_CREDENTIAL_TYPE`
- `VC_ACCEPTED_ISSUERS`
- `VC_USER_PRINCIPAL_NAME_CLAIM`
- `VC_EMPLOYEE_ID_CLAIM`
- `VC_CALLBACK_API_KEY`

Do not remove them from `.github/workflows/` in application-only changes unless
those workflows are being updated in the same reviewed infra PR.

## Required live integration work

1. Provide `SESSION_SECRET`, `V2_TRANSIENT_PROTECTION_KEY`,
   `V2_MANAGER_OIDC_CLIENT_SECRET`, and `V2_VERIFIED_ID_CALLBACK_API_KEY` as
   high-entropy secrets.
2. Set `V2_ADMIN_GROUP_ID` and `V2_USERS_GROUP_ID` to immutable Entra security
   group object IDs. For the Spaid pilot tenant, the deployment targets are
   JustJohn-SG `80334aae-af17-4a5a-9bca-046c0df39c15` and NativeUsers-SG
   `914a7e6f-dcc2-438a-bc02-d58d2eb5e87a`; keep these as deployment
   configuration, not hardcoded runtime names.
3. Set `ONBOARDING_STATE_BACKEND=azure-table` and grant the runtime identity
   table-scoped access to the session and v2 request tables.
4. Grant the runtime identity the Graph app roles used by this flow:
   `User.Read.All`, `GroupMember.Read.All`,
   `UserAuthMethod-TAP.ReadWrite.All`, and
   `UserAuthMethod-Passkey.Read.All`.
5. Provision and register the dedicated manager OIDC app callback at
   `/auth/manager/callback`.
6. Provision the dedicated Verified ID v2 contract and manifest.
7. Configure ACS Email when live manager notifications should be sent.

See [`docs/architecture.md`](docs/architecture.md),
[`docs/job-aids.md`](docs/job-aids.md), and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
