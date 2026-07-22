# Entra Verified ID — Employee & Guest Onboarding Portal

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fx3nc0n%2Fentra-verifiedid-example%2Fmain%2Fazuredeploy.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js 20 LTS](https://img.shields.io/badge/node-20%20LTS-brightgreen.svg)](https://nodejs.org/)

> **Deploy to Azure button = evaluation-only path.** The primary deployment story for this repo is infra + bootstrap + GitHub OIDC/environment wiring + CI/CD image deployment.

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
  Azure Container Apps (Node.js container) → Entra Verified ID API → Microsoft Authenticator
                                          → Key Vault (secrets)
                                          → Azure Storage (session state / artifacts)
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

The primary path to a running demo is:

### 1. Deploy the Azure infrastructure

Provision the shared Azure resources with either:

- the new manual GitHub Actions workflow: `.github/workflows/deploy-infrastructure.yml`, or
- a local/manual `az deployment group create` / `.\scripts\05-deploy-infrastructure.ps1` run.

The workflow path is recommended once the GitHub Actions deploy UAMI has already been bootstrapped and the target GitHub Environment has at least these seed variables set:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP`

Run `.github/workflows/deploy-infrastructure.yml` with:

- `environment`: `staging` or `production`
- `whatIf`: `true` first for preview, then `false` to apply

Use it once per environment before the first app deployment, then re-run it after any `infra/main.bicep` / `infra/modules/*.bicep` change.

This provisions Azure Container Apps infrastructure, Key Vault, storage, monitoring, and Azure Container Registry (ACR). The initial Container App revision is only a bootstrap placeholder so the infra deploy succeeds cleanly before CI publishes the real app image.

### 2. Run the Bootstrap Script

After infra deployment completes, open Azure Cloud Shell or a local PowerShell 7 session:

```powershell
# One-time GitHub Actions identity/bootstrap
.\scripts\07-bootstrap-github-actions-uami.ps1 `
  -ResourceGroupName "rg-entra-verifiedid-example" `
  -GitHubEnvironments @("staging")

# App/service bootstrap
.\scripts\bootstrap.ps1 `
  -DemoMode
```

`07-bootstrap-github-actions-uami.ps1` discovers the deployed Container App and ACR, grants the deploy UAMI both `Contributor` and `Role Based Access Control Administrator` on the resource group, grants the Container App's system-assigned identity `AcrPull` on the registry, and prints the exact `gh variable set` commands for GitHub Environment variables.

`bootstrap.ps1` now handles tenant/app/service setup plus infra configuration and `.env` generation, but it does **not** ZIP-deploy or otherwise publish the application image. The first runnable image still arrives through `.github/workflows/deploy.yml` (push to `main` / workflow dispatch) or a manual `az acr build` + `az containerapp update`.

### 3. Configure GitHub Environment variables

After a real `.github/workflows/deploy-infrastructure.yml` run (`whatIf: false`), copy the printed `gh variable set --env <environment> --body "<value>"` commands into a local shell and run them once for that environment.

The workflow prints the full deploy-time contract used by `.github/workflows/deploy.yml`:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP`
- `AZURE_CONTAINER_APP_NAME`
- `AZURE_CONTAINER_REGISTRY_NAME`
- `AZURE_CONTAINER_REGISTRY_LOGIN_SERVER`
- `AZURE_CONTAINER_APP_FQDN`

These must remain **GitHub Environment variables** (not repository variables) so staging and production can target different Azure resources safely.

### 4. Deploy the real app image through CI/CD

Push to `main` or run `.github/workflows/deploy.yml` manually. The workflow uses GitHub OIDC + the bootstrap UAMI to:

- build the repo's Docker image with `az acr build`
- push the image into the provisioned ACR
- update the target Azure Container App to that image
- smoke-test `https://<fqdn>/health`

> ⚠️ Graph API permission grant remains a separate manual/local step. After infrastructure exists, run `scripts/08-grant-app-uami-graph-permissions.ps1` as an Entra admin. This is intentionally **not** automated in GitHub Actions.

For local development, you can still copy the bootstrap output into `.env`:

```bash
cp .env.example .env
# Edit .env with values from bootstrap output
```

### Evaluation-only shortcut: Deploy to Azure button

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fx3nc0n%2Fentra-verifiedid-example%2Fmain%2Fazuredeploy.json)

Use the button only for quick single-resource-group evaluation. By itself it does **not** deploy the repo's real application image or configure GitHub OIDC/environment variables.

### 5. Access the Portal

After the deploy workflow completes, navigate to the Container App URL (the `webAppHostname` deployment output in Azure, or the `AZURE_CONTAINER_APP_FQDN` environment variable) or run locally:

```bash
npm install
npm start
# Portal available at http://localhost:3000
```

---

## Detailed Setup

### Manual Azure Setup (primary path)

If you prefer the primary scripted path:

```powershell
# 1. Create resource group
az group create --name rg-entra-verifiedid-example --location centralus

# 2. Deploy Bicep infrastructure (includes ACR + bootstrap placeholder revision)
az deployment group create \
  --resource-group rg-entra-verifiedid-example \
  --template-file infra/main.bicep \
  --parameters appName=entra-vid azureTenantId=<tenant-guid>
```

After the deployment completes:

1. read the `webAppHostname`, `containerRegistryName`, and `containerRegistryLoginServer` outputs,
2. run `scripts/07-bootstrap-github-actions-uami.ps1` for each GitHub Environment you want to target,
3. optionally run `.github/workflows/deploy-infrastructure.yml` for future infra updates instead of repeating local deploys,
4. set the printed GitHub Environment variables,
5. deploy the real image through `.github/workflows/deploy.yml`.

> The initial Container App revision is a bootstrap placeholder only. The real demo application is delivered by CI/CD, not by the ARM/Bicep deployment alone.

### Deploy to Azure button (evaluation-only)

You can still use the button for a fast single-resource-group evaluation:

[![Deploy to Azure](https://aka.ms/deploytoazurebutton)](https://portal.azure.com/#create/Microsoft.Template/uri/https%3A%2F%2Fraw.githubusercontent.com%2Fx3nc0n%2Fentra-verifiedid-example%2Fmain%2Fazuredeploy.json)

That path provisions the same infrastructure and a bootstrap placeholder revision, but it does **not** establish repo-bound GitHub OIDC federation or publish the repo's Docker image. Treat it as infrastructure evaluation, not the primary delivery story.

### PowerShell Scripts Reference

| Script | Purpose |
|--------|---------|
| `scripts/bootstrap.ps1` | Full tenant bootstrap: registers Entra app, configures Verified ID service, creates Key Vault secrets, outputs `.env` values |
| `scripts/07-bootstrap-github-actions-uami.ps1` | One-time GitHub Actions bootstrap: creates RG/UAMI, adds OIDC federated credentials, grants the deploy UAMI `Contributor` + `Role Based Access Control Administrator` on the resource group, grants the deployed Container App `AcrPull` on ACR, and prints environment-scoped `gh variable set` commands |
| `scripts/configure-verifiedid.ps1` | Configures Verified ID authority and credential manifest |
| `scripts/register-app.ps1` | Registers the portal app in Entra ID with required API permissions |
| `scripts/setup-storage.ps1` | Provisions Cosmos DB / Azure Storage for session state |
| `scripts/teardown.ps1` | Removes all demo resources cleanly |

#### bootstrap.ps1 Parameters

```powershell
.\scripts\bootstrap.ps1 `
  -TenantId          "<your-tenant-id>"                         # Required for live runs; omit in DemoMode
  -SubscriptionId    "<your-subscription-id>"                   # Required for live runs; omit in DemoMode
  -ResourceGroupName "rg-entra-verifiedid-example"              # Optional default shown
  -Location          "centralus"                                # Optional default shown
  -AppName           "entra-vid"                                # Optional default shown
  -AppBaseUrl        "https://entra-vid-app.<env-hash>.centralus.azurecontainerapps.io" # Optional for real runs
  -DemoMode          $true                                      # Use $false with real tenant values
```

### Environment Variable Configuration

After bootstrapping, set these values in the Container App's environment/secrets configuration (or `.env` for local dev):

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
| **Container App** | Azure Container Apps | Hosting for the Node.js portal container |
| **Key Vault** | Azure Key Vault | Secrets management (certs, client secrets) |
| **Storage** | Cosmos DB or Azure Storage | Session state, pending requests |
| **Entra ID** | Microsoft Entra ID | Identity provider, app registration |

### Security Considerations

- All secrets stored in Azure Key Vault; portal uses Managed Identity to access them
- Verified ID credentials are cryptographically signed — cannot be forged
- Passkey registration uses WebAuthn Level 2; keys never leave the authenticator
- Session tokens are short-lived and scoped to the onboarding flow
- HTTPS enforced at Container Apps ingress
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

All configuration is via environment variables. Set these in Azure Container Apps environment/secrets configuration or a `.env` file for local development.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | `production` or `development` |
| `PORT` | No | `3000` | HTTP port for the Express server |
| `SESSION_SECRET` | No | `insecure-dev-secret-change-me` | Express session signing secret; override in every non-local environment |
| `APP_BASE_URL` | No | `http://localhost:3000` | Public base URL used by the app when constructing links/callbacks |
| `DEMO_MODE` | No | `false` | `true` to run with mocked flows (no real Verified ID / Graph calls) |
| `AZURE_TENANT_ID` | Yes (when `DEMO_MODE=false`) | — | Entra tenant ID used for Graph and Verified ID token acquisition |
| `AZURE_CLIENT_ID` | No for local development; yes in Azure when using a user-assigned managed identity | — | Client ID of the app runtime user-assigned managed identity. Used to disambiguate `DefaultAzureCredential` in Azure; typically not needed for local development because developer credentials are tried first. |
| `AZURE_CLIENT_SECRET` | No | — | Deprecated legacy app-secret setting; Graph and Verified ID runtime auth now prefer managed identity via `DefaultAzureCredential`. |
| `AZURE_AUTHORITY` | No | `https://login.microsoftonline.com/<AZURE_TENANT_ID \|\| common>` | Optional authority override for Azure identity auth |
| `VC_SERVICE_SCOPE` | No | `3db474b9-6a0c-4840-96ac-1fceb342124f/.default` | OAuth scope used for the Microsoft Entra Verified ID Request Service |
| `VC_CREDENTIAL_MANIFEST_URL` | Yes (when issuing real credentials) | — | Public URL to the Verified ID credential manifest |
| `VC_CREDENTIAL_TYPE` | No | `VerifiedEmployee` | Verified ID credential type name |
| `VC_ISSUER_AUTHORITY` | Yes (when `DEMO_MODE=false`) | — | Verified ID issuer DID / authority |
| `IDENTITYPASS_API_ENDPOINT` | No | `https://identitypass.microsoft.com/api/v1` | IdentityPass API base URL |
| `IDENTITYPASS_SUBSCRIPTION_KEY` | Yes (outside demo or mock mode) | — | IdentityPass subscription key |
| `IDENTITYPASS_MANAGER_EMAIL` | No | — | Default manager email used by IdentityPass-related flows |
| `FIDO2_RP_NAME` | No | `Entra Verified ID Demo` | Display name for the FIDO2 / WebAuthn relying party |
| `FIDO2_RP_ID` | No | `localhost` | Relying party ID (usually your domain in hosted environments) |
| `FIDO2_ORIGIN` | No | `http://localhost:3000` | Full allowed origin for FIDO2 / WebAuthn |
| `KEY_VAULT_URL` | No | — | Azure Key Vault URL used by the app configuration |

> **Runtime vs CI auth:** `AZURE_CLIENT_ID` in app runtime configuration now identifies the Container App's **runtime** user-assigned managed identity for `DefaultAzureCredential`. This is separate from GitHub Actions CI/CD, which also uses a managed identity, but for deployment only.

> **Legacy secret note:** The Container App template may still bind `AZURE_CLIENT_SECRET` as a Key Vault-backed secret while infra/bootstrap catches up, but the Graph and Verified ID services no longer require it for token acquisition.

---

## CI/CD

This repo includes:

- `.github/workflows/deploy-infrastructure.yml` for **manual infrastructure provisioning / what-if previews**
- `.github/workflows/deploy.yml` for **application image build + Container App rollout**

Both workflows keep GitHub authentication on **UAMI + OIDC**. Infrastructure provisioning uses `az deployment group what-if` / `az deployment group create` against `infra/main.bicep`, while app delivery builds the repo image with **Azure Container Registry Tasks** (`az acr build`), pushes into the provisioned **ACR**, then updates the target Azure Container App with `az containerapp update`.

### Infrastructure workflow

Use `.github/workflows/deploy-infrastructure.yml`:

- **Trigger:** `workflow_dispatch` only
- **Inputs:**
  - `environment`: `staging` or `production`
  - `whatIf`: `true`/`false`, default `true`

Run it once per environment before the first `.github/workflows/deploy.yml` rollout, then run it again after any Bicep infrastructure change. A successful non-what-if run:

- deploys `infra/main.bicep` into `vars.AZURE_RESOURCE_GROUP`
- writes key Bicep outputs to the Actions job summary
- prints the exact `gh variable set ... --env <environment> --body "<value>"` commands needed by `.github/workflows/deploy.yml`

The workflow prints commands for:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP`
- `AZURE_CONTAINER_APP_NAME`
- `AZURE_CONTAINER_REGISTRY_NAME`
- `AZURE_CONTAINER_REGISTRY_LOGIN_SERVER`
- `AZURE_CONTAINER_APP_FQDN`

It does **not** attempt to write GitHub variables automatically, and it does **not** grant Graph permissions.

### Authentication: UAMI + OIDC

Use a **User-Assigned Managed Identity (UAMI)** with GitHub OIDC federation — not a client-secret-based service principal. The one-time bootstrap for this repo lives in:

```powershell
.\scripts\07-bootstrap-github-actions-uami.ps1
```

Default bootstrap settings:

- Resource group: `rg-entra-verifiedid-example`
- Region: `centralus`
- UAMI: `uami-entra-verifiedid-example-deploy`

Required explicit inputs:

- Tenant: pass `-TenantId <your-tenant-id>`
- Subscription: pass `-SubscriptionId <your-subscription-id>`

The script is idempotent and will:

- create the resource group if it does not already exist
- create the deployment UAMI if missing
- add GitHub OIDC federated credentials for the `staging` and `production` environments used by `deploy.yml`
- add a `refs/heads/main` branch federated credential for future non-environment jobs
- assign **Contributor** and **Role Based Access Control Administrator** on the **resource group only**
- discover the deployed Container App and Azure Container Registry in that resource group
- grant the Container App's system-assigned identity **AcrPull** on the ACR
- print the exact **environment-scoped** `gh variable set` commands required by `azure/login@v2` and the deploy workflow

After the deploy UAMI and seed environment variables exist, `.github/workflows/deploy-infrastructure.yml` can handle later Bicep applies from GitHub Actions using that same identity.

No `AZURE_CLIENT_SECRET` repository secret is required for this workflow.

> ⚠️ `scripts/08-grant-app-uami-graph-permissions.ps1` remains a **manual, local, Entra-admin-only** step. Do not expect any GitHub Actions workflow in this repo to perform Graph admin consent.

Use **GitHub Environment variables** (not repository variables) for each deploy target such as `staging` and `production`:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP`
- `AZURE_CONTAINER_APP_NAME`
- `AZURE_CONTAINER_REGISTRY_NAME`
- `AZURE_CONTAINER_REGISTRY_LOGIN_SERVER`
- `AZURE_CONTAINER_APP_FQDN` (optional but recommended for the environment URL shown in GitHub)

If staging and production point at different Azure resource groups or Container Apps, run `scripts/07-bootstrap-github-actions-uami.ps1` once per environment so the printed `gh variable set --env <name>` commands contain the correct target-specific values.

| | UAMI (Recommended) | Service Principal |
|---|---|---|
| **Client secret** | None — OIDC only | Required for some scenarios; expires ≤2 years |
| **Credential surface** | Federated credentials only | Client secrets, certs, federated — any Entra app admin can add more |
| **Managed by** | Azure RBAC on the target app resource group | Entra ID app + Azure RBAC |
| **Secret rotation** | Not applicable | Manual; missed rotation = broken pipelines or security risk |
| **Blast radius** | Scoped to Azure resources only | Entra ID app registration + Azure resources |

```powershell
# Example: run with explicit tenant/subscription IDs
.\scripts\07-bootstrap-github-actions-uami.ps1 `
  -TenantId "<your-tenant-id>" `
  -SubscriptionId "<your-subscription-id>"

# The script prints commands like:
gh variable set AZURE_CLIENT_ID --repo x3nc0n/entra-verifiedid-example --env staging --body "<uami-client-id>"
gh variable set AZURE_TENANT_ID --repo x3nc0n/entra-verifiedid-example --env staging --body "<your-tenant-id>"
gh variable set AZURE_SUBSCRIPTION_ID --repo x3nc0n/entra-verifiedid-example --env staging --body "<your-subscription-id>"
gh variable set AZURE_RESOURCE_GROUP --repo x3nc0n/entra-verifiedid-example --env staging --body "rg-entra-verifiedid-example"
gh variable set AZURE_CONTAINER_APP_NAME --repo x3nc0n/entra-verifiedid-example --env staging --body "<container-app-name>"
gh variable set AZURE_CONTAINER_REGISTRY_NAME --repo x3nc0n/entra-verifiedid-example --env staging --body "<acr-name>"
gh variable set AZURE_CONTAINER_REGISTRY_LOGIN_SERVER --repo x3nc0n/entra-verifiedid-example --env staging --body "<acr-name>.azurecr.io"
```

For broader deployment patterns, see the companion repo:

**[Spava-Corp/entra-verifiedid-deploy](https://github.com/Spava-Corp/entra-verifiedid-deploy)**

---

## Troubleshooting

### Verified ID callback not receiving events

- Verify `APP_BASE_URL` points to the public HTTPS origin of the app; the code derives callback URLs from it (for example `/api/issuance/callback` and `/api/verification/callback`)
- Ensure that public origin uses HTTPS — Entra Verified ID will not deliver callbacks to HTTP endpoints
- Confirm Container App ingress exposes the callback routes publicly over HTTPS

### QR code displayed but Authenticator won't scan

- Ensure the Verified ID authority DID (`VC_ISSUER_AUTHORITY`) matches the DID registered in your tenant
- Check that `VC_CREDENTIAL_MANIFEST_URL` is publicly accessible
- Verify Microsoft Authenticator is updated to the latest version
- Inspect Container App logs: `az containerapp logs show --resource-group <rg> --name <app-name> --follow`

### Bootstrap script fails with "Insufficient privileges"

- Ensure you are signed in as a Global Administrator or Privileged Role Administrator for Entra ID changes
- The app registration step requires `Application.ReadWrite.All` on Microsoft Graph
- Re-run `Connect-MgGraph -Scopes "Application.ReadWrite.All", "Directory.ReadWrite.All"` to refresh consent

### Passkey registration fails in browser

- `FIDO2_RP_ID` must exactly match the domain of the page performing registration
- `FIDO2_ORIGIN` must match the full origin (`https://` + domain)
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
