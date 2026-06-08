# Entra Verified ID — Employee & Guest Onboarding Portal

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fx3nc0n%2Fentra-verifiedid-example%2Fmain%2Fazuredeploy.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20 LTS](https://img.shields.io/badge/node-20%20LTS-brightgreen.svg)](https://nodejs.org/)

A production-style demo portal showing **Microsoft-style employee and guest onboarding** using [Entra Verified ID](https://learn.microsoft.com/en-us/entra/verified-id/decentralized-identifier-overview). New users receive a verifiable credential through an IdentityPass request, present it to verify their identity, then register phishing-resistant MFA (Passkey on phone and/or YubiKey) — all in a single guided flow.

---

## Table of Contents

- [What This Demo Shows](#what-this-demo-shows)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Detailed Setup](#detailed-setup)
- [Demo Mode](#demo-mode)
- [API Reference](#api-reference)
- [Configuration Reference](#configuration-reference)
- [CI/CD](#cicd)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

---

## What This Demo Shows

Modern enterprise onboarding requires proving who a user is *before* granting access. This portal demonstrates a complete, end-to-end zero-trust onboarding flow:

| Stage | What Happens |
|-------|-------------|
| **Identity Request** | New user submits personal email + employee ID; portal creates an IdentityPass request |
| **Manager Approval** | Manager reviews and approves the identity request in the portal |
| **Credential Issuance** | Entra Verified ID issues a verifiable credential to the user's Microsoft Authenticator |
| **Credential Presentation** | User presents the Verified ID credential to confirm identity |
| **PRMFA Registration** | Portal guides Passkey registration on phone and/or YubiKey (FIDO2/WebAuthn) |
| **Onboarded** | User has phishing-resistant MFA and a verifiable digital identity |

This pattern maps directly to [Microsoft's Entra Verified ID employee onboarding guidance](https://learn.microsoft.com/en-us/entra/verified-id/plan-verification-solution) and is suitable for use as a reference architecture.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Onboarding Flow                              │
│                                                                     │
│  New User                                                           │
│  (Personal Email                                                    │
│   + Employee ID)                                                    │
│       │                                                             │
│       ▼                                                             │
│  ┌──────────┐    IdentityPass     ┌──────────────┐                  │
│  │  Portal  │ ──── Request ─────▶ │   Manager    │                  │
│  │ (Node.js)│                     │   Approval   │                  │
│  └──────────┘                     └──────┬───────┘                  │
│       │                                  │ Approved                 │
│       │                                  ▼                          │
│       │                    ┌─────────────────────────┐              │
│       │                    │  Entra Verified ID       │              │
│       │                    │  Credential Issuance     │              │
│       │                    │  → Microsoft Authenticator│             │
│       │                    └─────────────┬───────────┘              │
│       │                                  │                          │
│       │◀──── Credential Presentation ────┘                          │
│       │         (QR Code / Deep Link)                               │
│       │                                  │                          │
│       ▼                                  ▼                          │
│  ┌─────────────────────────────────────────────┐                    │
│  │          Passkey (PRMFA) Registration        │                    │
│  │    Phone (Authenticator) + YubiKey (FIDO2)   │                    │
│  └─────────────────────────────────────────────┘                    │
│                          │                                          │
│                          ▼                                          │
│                   User Onboarded ✓                                  │
│              (Phishing-Resistant MFA Active)                        │
└─────────────────────────────────────────────────────────────────────┘

Azure Resources:
  App Service (Node.js) → Entra Verified ID API → Microsoft Authenticator
                       → Key Vault (secrets)
                       → Cosmos DB / Storage (session state)
```

See [`docs/architecture.md`](docs/architecture.md) for detailed component descriptions and Mermaid sequence diagrams.

---

## Prerequisites

Before deploying, ensure you have:

| Requirement | Notes |
|-------------|-------|
| **Azure Subscription** | Owner or Contributor + User Access Administrator roles |
| **Entra ID Tenant** | P1 license minimum; P2 recommended for Conditional Access |
| **Verified ID Service** | Must be enabled in your tenant ([setup guide](https://learn.microsoft.com/en-us/entra/verified-id/verifiable-credentials-configure-tenant)) |
| **PowerShell 7+** | Required for bootstrap scripts |
| **Az PowerShell module** | `Install-Module Az` |
| **Microsoft.Graph module** | `Install-Module Microsoft.Graph` |
| **Node.js 20 LTS** | For local development only |
| **Azure CLI** | Optional but recommended |

---

## Quick Start

The fastest path to a running demo:

### 1. Click Deploy to Azure

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fx3nc0n%2Fentra-verifiedid-example%2Fmain%2Fazuredeploy.json)

Fill in the prompted parameters (tenant ID, resource group, etc.) and click **Review + Create**.

### 2. Run the Bootstrap Script

After deployment completes, open Azure Cloud Shell or a local PowerShell 7 session:

```powershell
# Clone the repo (if running locally)
git clone https://github.com/x3nc0n/entra-verifiedid-example.git
cd entra-verifiedid-example

# Authenticate to Azure and Microsoft Graph
Connect-AzAccount
Connect-MgGraph -Scopes "Application.ReadWrite.All", "Directory.ReadWrite.All"

# Run bootstrap — registers Entra app, configures Verified ID, outputs .env values
.\scripts\bootstrap.ps1 -TenantId "<your-tenant-id>" -SubscriptionId "<your-subscription-id>"
```

### 3. Configure Environment Variables

Copy the output from the bootstrap script into your App Service Configuration, or into a local `.env` for development:

```bash
cp .env.example .env
# Edit .env with values from bootstrap output
```

### 4. Access the Portal

Navigate to your App Service URL (shown in Azure Portal after deployment) or run locally:

```bash
npm install
npm start
# Portal available at http://localhost:3000
```

---

## Detailed Setup

### Manual Azure Setup (without Deploy to Azure)

If you prefer manual deployment:

```powershell
# 1. Create resource group
az group create --name rg-verifiedid-demo --location eastus

# 2. Deploy Bicep infrastructure
az deployment group create \
  --resource-group rg-verifiedid-demo \
  --template-file infra/main.bicep \
  --parameters @infra/main.bicepparam
```

### PowerShell Scripts Reference

| Script | Purpose |
|--------|---------|
| `scripts/bootstrap.ps1` | Full tenant bootstrap: registers Entra app, configures Verified ID service, creates Key Vault secrets, outputs `.env` values |
| `scripts/configure-verifiedid.ps1` | Configures Verified ID authority and credential manifest |
| `scripts/register-app.ps1` | Registers the portal app in Entra ID with required API permissions |
| `scripts/setup-storage.ps1` | Provisions Cosmos DB / Azure Storage for session state |
| `scripts/teardown.ps1` | Removes all demo resources cleanly |

#### bootstrap.ps1 Parameters

```powershell
.\scripts\bootstrap.ps1 `
  -TenantId        "<Entra Tenant ID>"        # Required
  -SubscriptionId  "<Azure Subscription ID>"   # Required
  -ResourceGroup   "rg-verifiedid-demo"        # Optional, default shown
  -Location        "eastus"                    # Optional, default shown
  -AppName         "VerifiedID-OnboardingDemo" # Optional, default shown
  -DemoMode        $false                      # Set $true for mocked flow
```

### Environment Variable Configuration

After bootstrapping, set these values in App Service → Configuration → Application settings (or `.env` for local dev):

See the full [Configuration Reference](#configuration-reference) table below.

### Entra Verified ID Credential Manifest

The IdentityPass credential manifest is deployed automatically by `configure-verifiedid.ps1`. The manifest defines:

- **Credential type:** `IdentityPass`
- **Claims:** `employeeId`, `displayName`, `email`, `department`, `issueDate`
- **Display:** Spava Corp branding with logo and background color

To customize the manifest, edit `infra/modules/verifiedid-manifest.json` before running the bootstrap script.

---

## Demo Mode

Set `DEMO_MODE=true` to run the portal without a real Entra Verified ID tenant. This is useful for UI/UX reviews, screenshots, and demos where credential issuance infrastructure isn't available.

```bash
DEMO_MODE=true npm start
```

### What's Mocked in Demo Mode

| Feature | Demo Mode | Production Mode |
|---------|-----------|----------------|
| IdentityPass request creation | ✅ Simulated | ✅ Real Entra Verified ID API |
| Manager approval workflow | ✅ Auto-approved after 5 seconds | ✅ Real manager notification + approval |
| QR code for Authenticator | ✅ Static placeholder QR | ✅ Live issuance QR from Verified ID |
| Credential presentation/verification | ✅ Mocked — always passes | ✅ Real cryptographic verification |
| Passkey registration | ✅ Simulated WebAuthn ceremony | ✅ Real FIDO2/WebAuthn via browser API |
| Email notifications | ✅ Logged to console only | ✅ Sent via configured mail provider |
| Session persistence | ✅ In-memory (resets on restart) | ✅ Cosmos DB / Azure Storage |

> ⚠️ **Demo mode is not suitable for production.** It bypasses all cryptographic verification. See [SECURITY.md](SECURITY.md) for details.

---

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full architecture document including:

- Component descriptions and responsibilities
- Mermaid sequence diagrams for all three major flows
- Azure resource dependencies
- Security model and threat considerations

### Component Summary

| Component | Technology | Role |
|-----------|-----------|------|
| **Portal** | Node.js 20, Express, EJS | Web frontend and API gateway |
| **Verified ID Service** | Entra Verified ID REST API | Credential issuance and presentation |
| **IdentityPass Workflow** | Node.js service + Entra | Request/approval/issuance orchestration |
| **PRMFA Registration** | WebAuthn/FIDO2 (browser API) | Passkey registration for phone + YubiKey |
| **App Service** | Azure App Service (Linux) | Hosting for the Node.js portal |
| **Key Vault** | Azure Key Vault | Secrets management (certs, client secrets) |
| **Storage** | Cosmos DB or Azure Storage | Session state, pending requests |
| **Entra ID** | Microsoft Entra ID | Identity provider, app registration |

### Security Considerations

- All secrets stored in Azure Key Vault; portal uses Managed Identity to access them
- Verified ID credentials are cryptographically signed — cannot be forged
- Passkey registration uses WebAuthn Level 2; keys never leave the authenticator
- Session tokens are short-lived and scoped to the onboarding flow
- HTTPS enforced; HSTS enabled on App Service
- See [SECURITY.md](SECURITY.md) for vulnerability reporting

---

## API Reference

All API endpoints are prefixed with `/api/v1`.

### Onboarding

#### `POST /api/v1/onboarding/start`

Initiates the onboarding flow for a new user.

**Request:**
```json
{
  "email": "jane.doe@personal.com",
  "employeeId": "EMP-12345",
  "displayName": "Jane Doe",
  "department": "Engineering"
}
```

**Response `201`:**
```json
{
  "requestId": "req_abc123",
  "status": "pending_approval",
  "message": "Identity request submitted. Awaiting manager approval."
}
```

---

#### `GET /api/v1/onboarding/status/:requestId`

Polls the status of an onboarding request.

**Response `200`:**
```json
{
  "requestId": "req_abc123",
  "status": "approved | pending_approval | credential_issued | presentation_required | mfa_registration | complete",
  "updatedAt": "2026-06-08T13:00:00Z"
}
```

---

### Manager Approval

#### `GET /api/v1/manager/requests`

Returns pending IdentityPass requests for the authenticated manager.

**Response `200`:**
```json
{
  "requests": [
    {
      "requestId": "req_abc123",
      "employeeId": "EMP-12345",
      "displayName": "Jane Doe",
      "email": "jane.doe@personal.com",
      "department": "Engineering",
      "submittedAt": "2026-06-08T12:00:00Z"
    }
  ]
}
```

---

#### `POST /api/v1/manager/requests/:requestId/approve`

Approves an IdentityPass request, triggering Verified ID credential issuance.

**Response `200`:**
```json
{
  "requestId": "req_abc123",
  "status": "approved",
  "issuanceUrl": "openid-vc://..."
}
```

#### `POST /api/v1/manager/requests/:requestId/deny`

Denies an IdentityPass request.

**Request:**
```json
{ "reason": "Unable to verify employment record." }
```

---

### Verified ID

#### `POST /api/v1/verifiedid/issue`

Initiates credential issuance after manager approval. Returns a QR code payload.

**Response `200`:**
```json
{
  "requestId": "req_abc123",
  "qrCode": "data:image/png;base64,...",
  "deepLink": "openid-vc://...",
  "expiresAt": "2026-06-08T13:15:00Z"
}
```

---

#### `POST /api/v1/verifiedid/present`

Initiates a presentation request for identity verification.

**Response `200`:**
```json
{
  "presentationRequestId": "pres_xyz789",
  "qrCode": "data:image/png;base64,...",
  "deepLink": "openid-vc://...",
  "expiresAt": "2026-06-08T13:15:00Z"
}
```

---

#### `POST /api/v1/verifiedid/callback`

Webhook callback from Entra Verified ID service (issuance and presentation events).

> This endpoint must be publicly reachable by the Entra Verified ID service. It is authenticated via a shared callback API key.

---

### PRMFA Registration

#### `POST /api/v1/mfa/register/begin`

Begins a WebAuthn registration ceremony for Passkey or security key.

**Request:**
```json
{ "type": "passkey | yubikey" }
```

**Response `200`:** WebAuthn `PublicKeyCredentialCreationOptions` JSON.

---

#### `POST /api/v1/mfa/register/complete`

Completes the WebAuthn registration ceremony.

**Request:** WebAuthn `AuthenticatorAttestationResponse` JSON.

**Response `200`:**
```json
{
  "status": "registered",
  "credentialId": "cred_...",
  "type": "passkey"
}
```

---

## Configuration Reference

All configuration is via environment variables. Set these in App Service → Configuration or a `.env` file for local development.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | `production` or `development` |
| `PORT` | No | `3000` | HTTP port for the Express server |
| `DEMO_MODE` | No | `false` | `true` to run with mocked flows (no real Verified ID) |
| `TENANT_ID` | **Yes** | — | Entra ID Tenant ID (GUID) |
| `CLIENT_ID` | **Yes** | — | Entra app registration Client ID |
| `CLIENT_SECRET` | **Yes** | — | Entra app Client Secret (use Key Vault ref in production) |
| `VERIFIED_ID_AUTHORITY` | **Yes** | — | DID of your Verified ID authority (from tenant configuration) |
| `VERIFIED_ID_CREDENTIAL_TYPE` | No | `IdentityPass` | The credential type name to issue |
| `VERIFIED_ID_MANIFEST_URL` | **Yes** | — | URL to the credential manifest JSON |
| `VERIFIED_ID_CALLBACK_URL` | **Yes** | — | Public URL for Verified ID service callbacks (must be HTTPS) |
| `VERIFIED_ID_CALLBACK_API_KEY` | **Yes** | — | Shared secret for callback authentication |
| `KEY_VAULT_URL` | No | — | Azure Key Vault URL (enables Managed Identity secret access) |
| `SESSION_SECRET` | **Yes** | — | Secret for Express session signing (min 32 chars) |
| `SESSION_STORE` | No | `memory` | `memory` or `cosmos` or `storage` |
| `COSMOS_CONNECTION_STRING` | No | — | Required if `SESSION_STORE=cosmos` |
| `STORAGE_CONNECTION_STRING` | No | — | Required if `SESSION_STORE=storage` |
| `MAIL_PROVIDER` | No | `none` | `none`, `sendgrid`, or `smtp` |
| `MAIL_API_KEY` | No | — | SendGrid API key (if `MAIL_PROVIDER=sendgrid`) |
| `SMTP_HOST` | No | — | SMTP host (if `MAIL_PROVIDER=smtp`) |
| `MANAGER_EMAIL` | No | — | Default manager email for approval notifications |
| `WEBAUTHN_RP_ID` | **Yes** | — | Relying party ID for WebAuthn (usually your domain, e.g. `contoso.com`) |
| `WEBAUTHN_RP_NAME` | No | `Onboarding Portal` | Display name for WebAuthn relying party |
| `WEBAUTHN_ORIGIN` | **Yes** | — | Full origin URL for WebAuthn (e.g. `https://onboarding.contoso.com`) |
| `LOG_LEVEL` | No | `info` | `error`, `warn`, `info`, `debug` |

> **Key Vault References:** In production App Service deployments, use Key Vault references for sensitive values:
> ```
> @Microsoft.KeyVault(SecretUri=https://kv-verifiedid.vault.azure.net/secrets/ClientSecret/)
> ```

---

## CI/CD

For automated deployment with GitHub Actions, see the companion private repository:

**[Spava-Corp/entra-verifiedid-deploy](https://github.com/Spava-Corp/entra-verifiedid-deploy)**

That repo contains:
- GitHub Actions workflows for CI/CD to Azure App Service
- Environment-specific configuration (staging, production, infrastructure)
- Slot swap deployment strategy for zero-downtime releases
- Secrets management via GitHub Environments

### Authentication: UAMI Recommended

When setting up CI/CD, use a **User-Assigned Managed Identity (UAMI)** with OIDC federation — not a service principal. UAMI is the Microsoft-recommended pattern for workload identity federation:

| | UAMI (Recommended) | Service Principal |
|---|---|---|
| **Client secret** | None — OIDC only | Required for some scenarios; expires ≤2 years |
| **Credential surface** | Federated credentials only | Client secrets, certs, federated — any Entra app admin can add more |
| **Managed by** | Azure RBAC (Contributor on the identity RG) | Entra ID (Application Administrator role) |
| **Secret rotation** | Not applicable | Manual; missed rotation = broken pipelines or security risk |
| **Blast radius** | Scoped to Azure resources only | Entra ID app registration + Azure resources |

```bash
# Create a UAMI and add OIDC federation (no secrets!)
az identity create --name uami-verifiedid-deploy --resource-group rg-identity --location eastus2
az identity federated-credential create \
  --name github-main \
  --identity-name uami-verifiedid-deploy \
  --resource-group rg-identity \
  --issuer "https://token.actions.githubusercontent.com" \
  --subject "repo:<ORG>/<REPO>:ref:refs/heads/main" \
  --audiences "api://AzureADTokenExchange"
```

See the [CI/CD deployment repo README](https://github.com/Spava-Corp/entra-verifiedid-deploy#1-configure-azure-oidc-authentication) for complete setup instructions including SP fallback.

---

## Troubleshooting

### Verified ID callback not receiving events

- Verify `VERIFIED_ID_CALLBACK_URL` is publicly reachable (use `curl` or [webhook.site](https://webhook.site) to test)
- Ensure the URL uses HTTPS — Entra Verified ID will not deliver to HTTP endpoints
- Check that `VERIFIED_ID_CALLBACK_API_KEY` matches what was registered in the tenant configuration
- App Service firewall rules must allow inbound traffic from Microsoft IP ranges

### QR code displayed but Authenticator won't scan

- Ensure the Verified ID authority DID (`VERIFIED_ID_AUTHORITY`) matches the DID registered in your tenant
- Check that the credential manifest URL is publicly accessible
- Verify Microsoft Authenticator is updated to the latest version
- Inspect App Service logs: `az webapp log tail --resource-group <rg> --name <app-name>`

### Bootstrap script fails with "Insufficient privileges"

- Ensure you are signed in as a Global Administrator or Privileged Role Administrator for Entra ID changes
- The app registration step requires `Application.ReadWrite.All` on Microsoft Graph
- Re-run `Connect-MgGraph -Scopes "Application.ReadWrite.All", "Directory.ReadWrite.All"` to refresh consent

### Passkey registration fails in browser

- `WEBAUTHN_RP_ID` must exactly match the domain of the page performing registration
- `WEBAUTHN_ORIGIN` must match the full origin (`https://` + domain)
- HTTPS is required — WebAuthn will not work on HTTP (except `localhost`)
- For YubiKey: ensure the key is FIDO2-capable; FIDO U2F-only keys are not supported for Passkey registration

### Demo mode: credential presentation always passes

This is by design. In demo mode, cryptographic verification is skipped. To test real verification, set `DEMO_MODE=false` and complete the full Entra Verified ID tenant configuration.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style, and pull request guidelines.

---

## Security

See [SECURITY.md](SECURITY.md) for the security policy and instructions on reporting vulnerabilities.

---

## License

[MIT](LICENSE) — Copyright (c) 2026 x3nc0n
