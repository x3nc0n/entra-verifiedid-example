# Microsoft Entra Passwordless Onboarding Pilot

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fx3nc0n%2Fentra-verifiedid-example%2Fmain%2Fazuredeploy.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20 LTS](https://img.shields.io/badge/node-20%20LTS-brightgreen.svg)](https://nodejs.org/)

This Node.js/Express portal demonstrates a first-release passwordless onboarding
pilot for a **pre-created Microsoft Entra user**:

1. An approved manager workflow creates an invitation bound to the immutable
   Entra object ID, known personal email, and employee identifier.
2. The approved delivery system sends the opaque one-time link to that known
   personal email.
3. The user validates the expected email and employee identifier. The portal
   atomically consumes the invitation.
4. The portal creates a short-lived, single-use Temporary Access Pass (TAP)
   through Microsoft Graph and displays it once.
5. The user signs in at Microsoft Security info with the TAP and registers a
   tenant passkey.
6. The portal confirms through Microsoft Graph that a FIDO2 authentication
   method was added after the invitation was consumed.

The portal does **not** let the browser choose an Entra account, call a fabricated
identity-proofing endpoint, or issue its own employee credential.

## Assurance modes

| Mode | Status | Behavior |
|------|--------|----------|
| `invitation` | Default pilot | Manager-approved invitation validation creates the TAP directly. |
| `verified-id` | Future extension | After invitation validation, request a partner-issued Verified ID presentation, match configured claims to the invitation-bound Entra user, then create the TAP. |
| `self-service-verified-id-v2` | Disabled by default | Employee intake, manager OIDC approval, dedicated credential issuance and presentation, TAP creation, and Graph-confirmed passkey enrollment. |

The `verified-id` extension uses the official Microsoft Entra Verified ID
presentation request shape and authenticated callback state. It remains gated
until the approved provider supplies its issuer DID, credential type, claim
mapping, and delivery/issuance contract.

The isolated v2 flow is enabled only when `SELF_SERVICE_V2_ENABLED=true`. It
uses the dedicated `/v2`, `/api/v2`, and `/auth/manager` namespaces and a
separate `onboardingV2Requests` Azure Table. Enabling the feature does not alter
the v1 invitation routes, state, or default assurance mode.

### v2 self-service flow

1. The employee submits the known directory UPN and employee identifier.
2. Graph loads the immutable employee object ID and current manager with
   `$expand=manager`; invalid and ineligible submissions receive the same
   generic `202` response.
3. A durable request and one-time manager token are created. Only the token hash
   is stored; the raw token appears only in the approval URL fragment.
4. The manager signs in through a dedicated single-tenant OIDC application with
   PKCE, state, and nonce. The returned `tid` and `oid` must match the configured
   tenant and the current manager relationship.
5. After approval, the app requests issuance of the dedicated onboarding
   credential and then requests presentation constrained to the bound object ID
   and employee ID.
6. The callback verifies the exact tenant issuer, credential type, linked
   domain, revocation status, validity dates, and bound claims before Graph can
   create a short-lived, single-use TAP.
7. The TAP is decrypted and displayed once. Completion requires Graph to report
   a FIDO2 method that was not present before TAP creation.

## Security properties

- Invitation tokens contain 256 bits of randomness.
- Only the SHA-256 token hash is stored; the raw token is returned once in the
  invitation URL.
- Invitation links carry the bearer token only in the URL fragment. The browser
  clears the fragment before posting the token in an HTTPS JSON request body.
- Application access logs record only the request path, so the normal activation
  flow cannot place the token in route or query logs.
- Invitation pages send `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer`.
- Validation compares hashed normalized personal email and employee ID values.
- Failed validation attempts are limited.
- Azure Table Storage persists invitation state and enforces the active-to-consumed
  transition with ETag compare-and-set semantics.
- Express sessions use a shared Azure Table store outside local demo mode.
- The Entra user is selected by immutable object ID before link creation.
- Immediately before TAP creation, Graph reloads that object ID and requires
  `accountEnabled=true` plus current transitive membership in `PILOT_GROUP_ID`.
- TAPs are created with `isUsableOnce: true`, displayed once, and never written
  to logs or the session.
- Production FIDO2 options come from Microsoft Graph v1.0; the portal does not
  generate a substitute production challenge.
- Graph confirms the registered FIDO2 method before onboarding completes.
- A passkey that existed before invitation consumption does not satisfy the
  onboarding completion check.
- V2 request state, callback correlation, manager-token redemption, rate limits,
  and TAP ownership use Azure Table ETag compare-and-set operations.
- V2 manager tokens and callback states use high-entropy random values. Manager
  tokens are stored only as SHA-256 hashes and transported only in URL fragments.
- V2 PIN and TAP values are protected at rest with AES-256-GCM and a separately
  configured 32-byte key. The PIN is cleared after issuance and the TAP
  ciphertext is cleared on first display.

## Pilot limitations

The approval endpoint returns the invitation URL but does not send email. Connect
it to an approved manager workflow and email provider; do not expose the endpoint
directly to browsers.

V2 manager notifications support Azure Communication Services Email. The `acs`
provider sends the approval link only to the manager mailbox returned by Graph.
It prefers the ACS HTTPS endpoint plus the runtime managed identity and supports
a connection-string fallback. Send failures are logged without recipient or
approval-link data, recorded durably, and do not transition the request to
`manager-notified`; the approval token therefore cannot be activated. The
`noop` provider remains available for tests and intentionally does not expose
the approval URL.

Production startup is fail-closed unless demo mode is off, the dedicated pilot
group object ID is configured, and the Azure Table state backend is available.
The future `verified-id` mode remains production-blocked because its callback
correlation store is not yet durable.

Microsoft Graph can return FIDO2 creation options whose relying-party ID is owned
by Microsoft and therefore cannot be used from the portal's web origin. The
recommended web flow is to register at
[Microsoft Security info](https://mysignins.microsoft.com/security-info) after
TAP sign-in, then use the portal's Graph confirmation action. The direct Graph
creation-options/submission path remains available for a compatible trusted
client/origin.

## Quick start

```powershell
npm ci
$env:DEMO_MODE = 'true'
npm start
```

Open `http://localhost:3000/onboarding`, select **Create local demo invitation**,
then validate it with:

- Personal email: `demo.user@personal.example`
- Employee identifier: `DEMO-001`

The demo TAP is clearly marked and is not a usable credential.

Run tests with:

```powershell
npm test
```

## Approval integration API

### `POST /api/invitations`

Creates an invitation only after the upstream manager workflow has approved the
onboarding record.

Header:

```http
x-onboarding-approval-key: <configured secret>
```

Body:

```json
{
  "entraUserId": "<immutable-entra-object-id>",
  "personalEmail": "<known-personal-email>",
  "employeeId": "<expected-employee-id>",
  "lifetimeMinutes": 60
}
```

The API reads the user by object ID from Microsoft Graph, refuses missing or
disabled users or users outside the configured pilot group, and returns the
invitation URL once:

```json
{
  "invitationUrl": "https://<portal>/onboarding/invite#token=<opaque-token>",
  "expiresAt": "<timestamp>",
  "user": {
    "id": "<immutable-entra-object-id>",
    "userPrincipalName": "<directory-upn>"
  },
  "deliveryRequired": true
}
```

The calling workflow is responsible for approved delivery to the known personal
email.

## Runtime routes

| Route | Purpose |
|-------|---------|
| `GET /onboarding/invite` | Render the fragment activation or evidence-validation page without a token in the request URL. |
| `POST /onboarding/invite/activate` | Accept the fragment token in a no-store JSON body and bind its digest to the server-side session. |
| `POST /onboarding/invite` | Validate evidence, atomically consume the bound invitation, revalidate the user/group, and create TAP. |
| `POST /passkey/register/options` | Retrieve Entra FIDO2 `creationOptions` from Graph. |
| `POST /passkey/register/verify` | Submit the WebAuthn public key credential to Graph and confirm it exists. |
| `POST /passkey/register/confirm` | Confirm a passkey registered through Microsoft Security info. |
| `POST /api/verification/request` | Future `verified-id` mode: create partner credential presentation request. |
| `POST /api/verification/callback` | Future `verified-id` mode: authenticated presentation callback. |

### v2 routes

| Route | Purpose |
|-------|---------|
| `GET /v2/onboarding` | Employee intake and session-bound status UI. |
| `POST /api/v2/onboarding/requests` | Validate directory evidence and create a durable request with a generic response. |
| `GET /api/v2/onboarding/status` | Return coarse progress for the bound employee session. |
| `POST /api/v2/verified-id/issuance/requests` | Create a dedicated Verified ID issuance request. |
| `POST /api/v2/verified-id/issuance/callback` | Authenticate and correlate issuance callbacks. |
| `POST /api/v2/verified-id/presentation/requests` | Create the constrained presentation request. |
| `POST /api/v2/verified-id/presentation/callback` | Validate the credential and idempotently create TAP. |
| `GET /v2/manager/approval` | Activate the fragment approval token and show the manager decision UI. |
| `POST /api/v2/manager-approvals/activate` | Hash and bind the one-time manager token to a short pre-auth session. |
| `GET /auth/manager/signin` | Start the single-tenant manager OIDC/PKCE flow. |
| `POST /auth/manager/callback` | Validate the manager identity and atomically redeem the token. |
| `POST /api/v2/manager-approvals/:requestId/decision` | Recheck the manager relationship and record the decision. |
| `GET /v2/passkey` | Display the protected TAP once and direct the user to Security info. |
| `POST /api/v2/passkey/confirm` | Confirm a newly added Graph FIDO2 method. |
| `GET /v2/complete` | Finalize the request and destroy the onboarding session. |

## Configuration

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NODE_ENV` | No | `development` | Runtime environment. |
| `PORT` | No | `3000` | Express port. |
| `SESSION_SECRET` | Production | Development placeholder | Session signing secret. |
| `APP_BASE_URL` | Production | `http://localhost:3000` | Public origin used for invitation links and callbacks. |
| `DEMO_MODE` | No | `false` | Use local simulated Graph responses. |
| `ASSURANCE_MODE` | No | `invitation` | `invitation`, future `verified-id`, or `self-service-verified-id-v2`. |
| `SELF_SERVICE_V2_ENABLED` | No | `false` | Independently exposes the v2 route namespaces. |
| `ONBOARDING_APPROVAL_API_KEY` | Live invitation creation | None | Authenticates the approved invitation-creation integration. |
| `INVITATION_LIFETIME_MINUTES` | No | `60` | Invitation validity, 5-1440 minutes. |
| `INVITATION_MAX_ATTEMPTS` | No | `5` | Failed evidence checks before lockout. |
| `TAP_LIFETIME_MINUTES` | No | `60` | TAP validity, 10-43200 minutes; TAP is always single-use. |
| `ENTRA_SECURITY_INFO_URL` | No | Microsoft Security info | TAP sign-in/passkey registration destination. |
| `AZURE_TENANT_ID` | Live | None | Entra tenant. |
| `AZURE_CLIENT_ID` | Azure UAMI | None | Runtime user-assigned managed identity client ID. |
| `PILOT_GROUP_ID` | Live | None | Dedicated pilot-group object ID rechecked immediately before TAP creation. |
| `ONBOARDING_STATE_BACKEND` | Live | `memory` | Must be `azure-table` outside local demo mode. |
| `AZURE_STORAGE_TABLE_ENDPOINT` | Live | None | HTTPS endpoint for the managed-identity-backed Table service. |
| `ONBOARDING_INVITATIONS_TABLE` | No | `onboardingInvitations` | Durable invitation table name. |
| `ONBOARDING_SESSIONS_TABLE` | No | `onboardingSessions` | Shared Express session table name. |
| `ONBOARDING_V2_REQUESTS_TABLE` | v2 | `onboardingV2Requests` | Durable v2 requests, locks, counters, and audit table. |
| `VC_SERVICE_SCOPE` | Future Verified ID | Request Service default | Verified ID Request Service token scope. |
| `VC_VERIFIER_AUTHORITY` | Future Verified ID | None | Verifier tenant DID. |
| `VC_CREDENTIAL_TYPE` | Future Verified ID | None | Partner credential type. |
| `VC_ACCEPTED_ISSUERS` | Future Verified ID | None | Comma-separated approved partner issuer DIDs. |
| `VC_USER_PRINCIPAL_NAME_CLAIM` | Future Verified ID | None | Claim path matched to the invitation-bound UPN. |
| `VC_EMPLOYEE_ID_CLAIM` | Future Verified ID | None | Optional employee claim path. |
| `VC_CALLBACK_API_KEY` | Future Verified ID | None | Shared callback authentication value. |
| `V2_TRANSIENT_PROTECTION_KEY` | v2 | None | Base64-encoded 32-byte AES-GCM key for transient PIN/TAP protection. |
| `V2_MANAGER_OIDC_CLIENT_ID` | v2 | None | Dedicated single-tenant manager OIDC application client ID. |
| `V2_MANAGER_OIDC_CLIENT_SECRET` | v2 | None | Manager OIDC confidential-client credential. |
| `V2_MANAGER_OIDC_REDIRECT_URI` | v2 | `<APP_BASE_URL>/auth/manager/callback` | HTTPS `form_post` callback. |
| `V2_VERIFIED_ID_AUTHORITY` | v2 | None | Exact tenant Verified ID authority DID. |
| `V2_VERIFIED_ID_MANIFEST_URL` | v2 | None | Dedicated v2 contract manifest URL. |
| `V2_VERIFIED_ID_CREDENTIAL_TYPE` | v2 | None | Dedicated v2 credential type. |
| `V2_VERIFIED_ID_OBJECT_ID_CLAIM` | v2 | None | Object-ID claim path in issued/presented credential. |
| `V2_VERIFIED_ID_EMPLOYEE_ID_CLAIM` | v2 | None | Employee-ID claim path in issued/presented credential. |
| `V2_VERIFIED_ID_LINKED_DOMAIN` | v2 | None | Exact verified linked domain required from presentation. |
| `V2_VERIFIED_ID_CALLBACK_API_KEY` | v2 | None | Shared callback authentication value. |
| `V2_MANAGER_NOTIFICATION_PROVIDER` | v2 | `noop` | `acs` for live ACS Email delivery or `noop` for tests. |
| `V2_ACS_EMAIL_ENDPOINT` | v2 ACS managed identity | None | ACS HTTPS endpoint. Preferred over a connection string. |
| `V2_ACS_EMAIL_SENDER_ADDRESS` | v2 ACS | None | Verified sender address on the connected ACS Email domain. |
| `V2_ACS_EMAIL_CONNECTION_STRING` | v2 ACS fallback | None | Secret ACS connection string used only when no endpoint is configured. |
| `FIDO2_RP_NAME` | Demo only | `Entra Verified ID Demo` | Local demo relying-party name. |
| `FIDO2_RP_ID` | Demo only | `localhost` | Local demo relying-party ID. |

`DefaultAzureCredential` is used for Microsoft Graph and Verified ID. The runtime
identity currently needs directory user read access, `GroupMember.Read.All` for
the user-scoped `checkMemberGroups` call, and authentication-method write access.
The repository bootstrap scripts still grant the broader
`UserAuthenticationMethod.ReadWrite.All`; a tenant/security owner should replace
that with the current least-privilege TAP and passkey app roles after validating
tenant availability.

V2 records the narrower intended application-role names:
`User.Read.All`, `GroupMember.Read.All`,
`UserAuthMethod-TAP.ReadWrite.All`, and
`UserAuthMethod-Passkey.Read.All`. Tenant grants remain a separate provisioning
step and are not performed by this application.

### Definitive live v2 deployment contract

The names below are the application contract. `MANAGER_APP_CLIENT_ID`,
`MANAGER_APP_CLIENT_SECRET`, and `MANAGER_APP_REDIRECT_URI` are not read by the
application and must not be used as aliases.

| Exact environment variable | Classification | Required live value |
|---|---|---|
| `NODE_ENV` | Plain config | `production`. |
| `DEMO_MODE` | Plain config | `false`. |
| `APP_BASE_URL` | Plain config | Public HTTPS origin, without a path. |
| `SESSION_SECRET` | **Secret** | High-entropy Express session signing secret. |
| `SELF_SERVICE_V2_ENABLED` | Plain config | `true`. |
| `ASSURANCE_MODE` | Plain config | `self-service-verified-id-v2` when v2 should own `/`; otherwise another valid mode may remain the default while `/v2` stays enabled. |
| `AZURE_TENANT_ID` | Plain config | Tenant GUID. |
| `AZURE_CLIENT_ID` | Plain config | Runtime user-assigned managed identity client ID. May be omitted only when intentionally using the Container App system-assigned identity for Graph, Table, Verified ID, and ACS. |
| `PILOT_GROUP_ID` | Plain config | Dedicated pilot group object-ID GUID. |
| `ONBOARDING_STATE_BACKEND` | Plain config | `azure-table`. |
| `AZURE_STORAGE_TABLE_ENDPOINT` | Plain config | HTTPS Table service endpoint. |
| `ONBOARDING_INVITATIONS_TABLE` | Plain config | Optional; defaults to `onboardingInvitations`. Still validated because v1 remains mounted. |
| `ONBOARDING_SESSIONS_TABLE` | Plain config | Optional; defaults to `onboardingSessions`. |
| `ONBOARDING_V2_REQUESTS_TABLE` | Plain config | Optional; defaults to `onboardingV2Requests`. |
| `V2_TRANSIENT_PROTECTION_KEY` | **Secret** | Standard base64 encoding of exactly 32 decoded bytes. |
| `V2_MANAGER_OIDC_CLIENT_ID` | Plain config | Dedicated single-tenant manager OIDC application client-ID GUID. |
| `V2_MANAGER_OIDC_CLIENT_SECRET` | **Secret** | Manager OIDC confidential-client secret value. |
| `V2_MANAGER_OIDC_REDIRECT_URI` | Plain config | Exact registered HTTPS URI ending in `/auth/manager/callback`. Defaults from `APP_BASE_URL`, but set it explicitly in live deployments. |
| `V2_VERIFIED_ID_AUTHORITY` | Plain config | Exact tenant authority DID. |
| `V2_VERIFIED_ID_MANIFEST_URL` | Plain config | HTTPS manifest URL for the dedicated v2 contract. |
| `V2_VERIFIED_ID_CREDENTIAL_TYPE` | Plain config | Exact dedicated credential type. |
| `V2_VERIFIED_ID_OBJECT_ID_CLAIM` | Plain config | Exact object-ID claim name/path in the contract. |
| `V2_VERIFIED_ID_EMPLOYEE_ID_CLAIM` | Plain config | Exact employee-ID claim name/path in the contract. |
| `V2_VERIFIED_ID_LINKED_DOMAIN` | Plain config | Exact verified hostname, without scheme or path. |
| `V2_VERIFIED_ID_CALLBACK_API_KEY` | **Secret** | High-entropy shared value sent and validated in the Request Service callback header. |
| `V2_MANAGER_NOTIFICATION_PROVIDER` | Plain config | `acs` for live delivery. `noop` is test-only. |
| `V2_ACS_EMAIL_ENDPOINT` | Plain config | ACS resource HTTPS endpoint for managed-identity authentication. Preferred live mode. |
| `V2_ACS_EMAIL_SENDER_ADDRESS` | Plain config | Verified ACS Email sender address. |
| `V2_ACS_EMAIL_CONNECTION_STRING` | **Secret, optional fallback** | ACS `endpoint=https://...;accesskey=...` connection string. Set only instead of `V2_ACS_EMAIL_ENDPOINT` when managed-identity authentication cannot be used. If both are set, the endpoint/managed-identity path wins. |

The following v2 variables are optional policy overrides and use the defaults in
`.env.example`: `V2_REQUEST_LIFETIME_MINUTES`,
`V2_MANAGER_TOKEN_LIFETIME_MINUTES`,
`V2_MANAGER_PREAUTH_LIFETIME_MINUTES`,
`V2_MAX_DAILY_REQUESTS_PER_UPN`, `V2_MAX_DAILY_REQUESTS_PER_IP`,
`V2_MAX_DAILY_REQUESTS_PER_EMPLOYEE`,
`V2_MAX_PASSKEY_CONFIRM_ATTEMPTS`, `V2_MAX_ISSUANCE_RETRIES`,
`V2_MAX_PRESENTATION_RETRIES`, `V2_MAX_VERIFICATION_FAILURES`,
`V2_VERIFIED_ID_ISSUANCE_PIN_LENGTH`, `TAP_LIFETIME_MINUTES`,
`ENTRA_SECURITY_INFO_URL`, and `VC_SERVICE_SCOPE`.

## Azure delivery

The repository's existing delivery path remains:

- `.github/workflows/deploy-infrastructure.yml` for Bicep what-if/apply.
- `.github/workflows/deploy.yml` for `npm ci`, tests, ACR build, and Container
  Apps rollout through GitHub OIDC.
- `scripts/07-bootstrap-github-actions-uami.ps1` for the deployment identity.
- `scripts/08-grant-app-uami-graph-permissions.ps1` for the approved runtime
  Graph app-role grants. Future Verified ID permissions remain deferred.

The Deploy to Azure button is evaluation-only. The real application image arrives
through the ACR/GitHub Actions flow.

`deploy.yml` does **not** build images for feature-branch pushes. Pull requests
run `.github/workflows/validate.yml` only. Merging to `main` triggers
`deploy.yml`, which builds and pushes both `<commit-sha>` and `latest` with
`az acr build`, deploys staging, and then deploys production subject to GitHub
Environment approval. A manual `workflow_dispatch` of `deploy.yml` can build a
selected branch/ref before merge. No separate local `docker build` is required.

The current deploy workflow still configures `ASSURANCE_MODE=invitation` and
does not map the v2 secrets or variables listed above. Building the image alone
therefore does not enable v2. Switch/Trinity must wire the definitive contract
to the Container App, or update the deployment workflow/environment mappings,
before setting `SELF_SERVICE_V2_ENABLED=true`.

## Required integration work before live use

1. Create the `session-secret` and `onboarding-approval-key` secrets in the
   deployed Key Vault before deploying the real image. Infrastructure templates
   deliberately do not create or overwrite secret values. The workflow maps
   them to `SESSION_SECRET` and `ONBOARDING_APPROVAL_API_KEY`; production
   startup rejects missing values and known placeholder values.
2. Set the exact dedicated `PILOT_GROUP_ID` and confirm that TAP/FIDO2 policy is
   scoped to it. Before the first production pilot release, run
   `scripts/08-grant-app-uami-graph-permissions.ps1` (or run `bootstrap.ps1`
   with `-GrantRuntimeManagedIdentityGraphPermissions`) as an appropriately
   privileged Entra operator. The runtime UAMI must have exactly the Graph
   application roles used by this flow: `User.Read.All`,
   `GroupMember.Read.All`, and `UserAuthenticationMethod.ReadWrite.All`.
   `GroupMember.Read.All` is required for the final `checkMemberGroups`
   revalidation immediately before TAP creation.
3. Confirm the provisioned runtime identity has `Storage Table Data Contributor`
   only on the two dedicated onboarding tables.
4. Connect the approval endpoint to an authenticated manager workflow.
5. Deliver the returned invitation through an approved mail provider without
   logging the raw URL.
6. If enabling `verified-id`, first implement durable callback correlation, then
   obtain the real provider contract and configure the
   exact issuer, type, claims, presentation callback authentication, and subject
   matching rules.
7. Before enabling v2, provision the dedicated manager OIDC app, Verified ID
   contract/manifest, callback key, transient-protection key, v2 Azure Table and
   table-level RBAC, granular Graph app roles, and ACS Email configuration.
   Grant the selected runtime managed identity the ACS email sender role when
   using `V2_ACS_EMAIL_ENDPOINT`; otherwise map the connection string as a
   Key Vault-backed secret.

See [`docs/architecture.md`](docs/architecture.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
