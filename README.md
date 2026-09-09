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

The `verified-id` extension uses the official Microsoft Entra Verified ID
presentation request shape and authenticated callback state. It remains gated
until the approved provider supplies its issuer DID, credential type, claim
mapping, and delivery/issuance contract.

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

## Pilot limitations

The approval endpoint returns the invitation URL but does not send email. Connect
it to an approved manager workflow and email provider; do not expose the endpoint
directly to browsers.

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

## Configuration

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NODE_ENV` | No | `development` | Runtime environment. |
| `PORT` | No | `3000` | Express port. |
| `SESSION_SECRET` | Production | Development placeholder | Session signing secret. |
| `APP_BASE_URL` | Production | `http://localhost:3000` | Public origin used for invitation links and callbacks. |
| `DEMO_MODE` | No | `false` | Use local simulated Graph responses. |
| `ASSURANCE_MODE` | No | `invitation` | `invitation` or future `verified-id`. |
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
| `VC_SERVICE_SCOPE` | Future Verified ID | Request Service default | Verified ID Request Service token scope. |
| `VC_VERIFIER_AUTHORITY` | Future Verified ID | None | Verifier tenant DID. |
| `VC_CREDENTIAL_TYPE` | Future Verified ID | None | Partner credential type. |
| `VC_ACCEPTED_ISSUERS` | Future Verified ID | None | Comma-separated approved partner issuer DIDs. |
| `VC_USER_PRINCIPAL_NAME_CLAIM` | Future Verified ID | None | Claim path matched to the invitation-bound UPN. |
| `VC_EMPLOYEE_ID_CLAIM` | Future Verified ID | None | Optional employee claim path. |
| `VC_CALLBACK_API_KEY` | Future Verified ID | None | Shared callback authentication value. |
| `FIDO2_RP_NAME` | Demo only | `Entra Verified ID Demo` | Local demo relying-party name. |
| `FIDO2_RP_ID` | Demo only | `localhost` | Local demo relying-party ID. |

`DefaultAzureCredential` is used for Microsoft Graph and Verified ID. The runtime
identity currently needs directory user read access, `GroupMember.Read.All` for
the user-scoped `checkMemberGroups` call, and authentication-method write access.
The repository bootstrap scripts still grant the broader
`UserAuthenticationMethod.ReadWrite.All`; a tenant/security owner should replace
that with the current least-privilege TAP and passkey app roles after validating
tenant availability.

## Azure delivery

The repository's existing delivery path remains:

- `.github/workflows/deploy-infrastructure.yml` for Bicep what-if/apply.
- `.github/workflows/deploy.yml` for `npm ci`, tests, ACR build, and Container
  Apps rollout through GitHub OIDC.
- `scripts/07-bootstrap-github-actions-uami.ps1` for the deployment identity.
- `scripts/08-grant-app-uami-graph-permissions.ps1` for runtime Graph/Verified ID
  app-role grants.

The Deploy to Azure button is evaluation-only. The real application image arrives
through the ACR/GitHub Actions flow.

## Required integration work before live use

1. Create the `session-secret` and `onboarding-approval-key` secrets in the
   deployed Key Vault before deploying the real image. Infrastructure templates
   deliberately do not create or overwrite secret values. The workflow maps
   them to `SESSION_SECRET` and `ONBOARDING_APPROVAL_API_KEY`; production
   startup rejects missing values and known placeholder values.
2. Set the exact dedicated `PILOT_GROUP_ID`, confirm that TAP/FIDO2 policy is
   scoped to it, and grant the runtime identity the required Graph application roles.
3. Confirm the provisioned runtime identity has `Storage Table Data Contributor`
   only on the two dedicated onboarding tables.
4. Connect the approval endpoint to an authenticated manager workflow.
5. Deliver the returned invitation through an approved mail provider without
   logging the raw URL.
6. If enabling `verified-id`, first implement durable callback correlation, then
   obtain the real provider contract and configure the
   exact issuer, type, claims, presentation callback authentication, and subject
   matching rules.

See [`docs/architecture.md`](docs/architecture.md) and [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
