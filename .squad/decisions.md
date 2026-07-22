# Squad Decisions

## Active Decisions

### 2026-07-21T18-02-56: Deploy target confirmed as Azure Container Apps (not App Service)
**By:** Squad-Coordinator
**What:** Deploy target confirmed as Azure Container Apps (not App Service)
**References:** trinity, morpheus, infra/main.bicep, deploy.yml, azuredeploy.json
**Why:** User (x3nc0n) confirmed Container Apps as the deploy target, matching `infra/main.bicep`. `.github/workflows/deploy.yml`, `azuredeploy.json`, and `.github/workflows/validate.yml` still assume App Service + a Service Principal client-secret param and need to be aligned. Trinity is implementing the fix; Morpheus should review the result for architectural consistency once done.

### 2026-07-21: GitHub Actions Azure auth switched to UAMI/OIDC
**By:** Trinity
**Source:** `trinity-uami-oidc-switch.md`

Date: 2026-07-21

## Decision

Switch GitHub Actions Azure authentication for this repo from app-registration / client-secret assumptions to a User-Assigned Managed Identity (UAMI) with GitHub OIDC federated credentials.

## Implemented

- Added `scripts/07-bootstrap-github-actions-uami.ps1` as the one-time `az` bootstrap path.
- Bootstrap defaults:
  - Resource group: `rg-entra-verifiedid-example`
  - Region: `centralus`
  - UAMI: `uami-entra-verifiedid-example-deploy`
  - Tenant: `<tenant-id>`
  - Subscription: `<subscription-id>`
- RBAC is scoped to the resource group only.
- Federated credentials are created for:
  - `repo:x3nc0n/entra-verifiedid-example:environment:staging`
  - `repo:x3nc0n/entra-verifiedid-example:environment:production`
  - `repo:x3nc0n/entra-verifiedid-example:ref:refs/heads/main`
- `.github/workflows/deploy.yml` now reads `client-id`, `tenant-id`, and `subscription-id` from GitHub **repository variables**, not secrets, and does not use a client secret.

## Why

The deploy jobs already declare GitHub Environments, which changes the GitHub OIDC subject to the environment form. Creating only a branch-subject federated credential would leave staging/production deploy jobs unable to authenticate.

## Follow-up / flags

- `infra/main.bicep` deploys **Container Apps**, but `.github/workflows/deploy.yml` and `azuredeploy.json` are still built around **App Service** deployment semantics.
- `azuredeploy.json` still requires `azureClientSecret` and writes `AZURE_CLIENT_SECRET`, so the deploy button path remains on the old app-registration model.
- `.github/workflows/validate.yml` still validates `azureClientSecret` as a required ARM-template parameter.

Morpheus/Neo should decide whether the long-term hosting target is App Service or Container Apps, then align workflow + IaC + ARM template around one model.

### 2026-07-21: Deployment path aligned to Azure Container Apps
**By:** Trinity
**Source:** `trinity-container-apps-migration.md`

- Date: 2026-07-21
- Scope: CI/CD, ARM template, deployment docs

## Decision

Align the repo's deployment path to Azure Container Apps instead of App Service:

1. `deploy.yml` now builds the root `Dockerfile`, pushes to GHCR, and deploys with `az containerapp update` after `azure/login@v2` OIDC/UAMI auth.
2. `azuredeploy.json` now models the Container Apps infrastructure from `infra/main.bicep` and removes the legacy `azureClientSecret` parameter. The template creates placeholder Key Vault secrets that bootstrap populates later.
3. `validate.yml` now rejects the legacy App Service / `azureClientSecret` shape and validates Container Apps resource types instead.
4. `README.md` now documents Container Apps hosting, the generated `webAppHostname` output, and the GHCR-based deployment path.

## Rationale

`infra/main.bicep` is already the source of truth and provisions a Container App, not an App Service. Keeping App Service deployment steps and ARM parameters in CI/docs would continue to drift from the deployed platform and force a secret-based flow that the team already rejected in favor of UAMI + OIDC.

## Follow-up

A human should decide whether GHCR is acceptable long-term or whether the stack should add Azure Container Registry so Azure Container Apps can pull without any package-visibility caveat.

### 2026-07-21: Container Apps migration rejected pending ACR and contract rework
**By:** Morpheus
**Source:** `morpheus-container-apps-review.md`

- Date: 2026-07-21
- Verdict: **Reject with required rework**
- Reviewed work from: **Trinity**
- Reviewer protocol: **Trinity is locked out of the next revision of this artifact. The coordinator must assign a different agent, or escalate to a new Azure delivery specialist. Trinity must not self-revise, advise, or co-author the fix.**

## What is approved

1. **UAMI + GitHub OIDC** is the right direction for GitHub Actions Azure auth.
2. **`/health` in `src/app.js`** is acceptable as an unauthenticated probe endpoint. It is minimal and does not leak tenant, config, or secret material.
3. **Contributor at RG scope** is sufficient for the *current* `az containerapp update --image ...` image-swap operation on an already-provisioned Container App.

## Why this is rejected

The migration is not architecturally coherent end-to-end yet. The main blockers are:

### 1. Registry strategy is unresolved in a way that breaks the deployment story

**Decision: switch to Azure Container Registry (ACR). Do not keep GHCR as the long-term runtime registry.**

Why:

- `deploy.yml` builds and pushes to `ghcr.io` (`.github/workflows/deploy.yml`), but neither `infra/main.bicep` nor `infra/modules/container-app.bicep` configures registry credentials for the Container App.
- A private GHCR image will not be pullable by Azure Container Apps without extra GitHub credential wiring.
- The README already admits this caveat instead of solving it.
- For a reference architecture, ACR + managed identity pull is the boring, repeatable Azure-native path.

Required rework:

- Add ACR to the infra stack.
- Configure the Container App to pull from ACR.
- Grant the Container App identity **AcrPull** on that ACR.
- Update the deploy workflow to push to ACR, not GHCR.

RBAC note:

- **Contributor** is enough for `az containerapp update`.
- **Contributor is not enough** if CI is expected to create RBAC assignments such as `AcrPull` during infra deployment; that requires additional authorization (for example `User Access Administrator`/equivalent at the needed scope) or a one-time human/bootstrap-owned role-assignment step.

### 2. The infra/button path does not deploy a runnable app

`azuredeploy.json` and `infra/modules/container-app.bicep` create a Container App whose image is `node:20-alpine` and command is `npm start`.

That image does **not** contain this repo's application code. So:

- the ARM **Deploy to Azure** button is not a true "running demo" path,
- the manual Bicep path is not a true "running demo" path,
- the README Quick Start currently overstates what those paths produce.

This is the biggest coherence problem in the current migration.

Required rework:

- Make the primary path explicitly **infra bootstrap + CI/CD image deployment**, or
- if a one-click runnable deployment is required, parameterize a real image and registry path that the deployed Container App can actually pull.

### 3. The Deploy to Azure button is no longer a primary deployment experience

My call:

- Keep `azuredeploy.json` only as a **quick single-resource-group evaluation** path.
- Do **not** present it as the primary deployment story.

Reason:

- The button cannot establish repo-bound GitHub OIDC federated credentials.
- The button cannot wire the GitHub environment/repository variables required by `azure/login@v2`.
- With the current placeholder image, it does not even produce a runnable app.

README should be updated so the primary path is:

1. deploy infra,
2. run bootstrap,
3. configure GitHub OIDC/UAMI + environment variables,
4. deploy image through CI/CD.

### 4. Variable-scope and configuration-contract drift remains

There is a mismatch between the workflow/docs and the runtime contract:

- `scripts/07-bootstrap-github-actions-uami.ps1` prints **repository-level** `gh variable set` commands for only `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID`.
- `deploy.yml` also needs `AZURE_RESOURCE_GROUP` and `AZURE_CONTAINER_APP_NAME`, and implies environment-scoped separation for staging/production.
- `README.md` tells users to set GitHub **Environment** variables for both environments, which does not match what the script prints.

There is also env-name drift between docs/infra and the app config:

- `src/config.js` reads `AZURE_*`, `VC_*`, `IDENTITYPASS_API_ENDPOINT`, `FIDO2_*`
- `infra/modules/container-app.bicep` sets `VERIFIED_ID_AUTHORITY`, `CREDENTIAL_MANIFEST_URL`, `CREDENTIAL_TYPE`, `IDENTITYPASS_ENDPOINT`
- `README.md` configuration tables still document another shape in places (`TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `WEBAUTHN_*`)

Required rework:

- Pick one canonical runtime env contract and align **app config**, **infra**, and **README** to it.
- Decide explicitly whether deploy-time variables are repo-scoped or environment-scoped, then make the bootstrap script print the correct `gh` commands for the chosen model.

## File-by-file review notes

- **`.github/workflows/deploy.yml`**  
  Sound move: OIDC/UAMI login and post-deploy health checks.  
  Problem: runtime registry choice is unresolved, and staging/production targeting semantics are unclear unless environment-scoped vars are truly used.

- **`azuredeploy.json`**  
  Better aligned to Container Apps than before, but not coherent as a runnable deployment because it deploys a placeholder base image and cannot wire repo-specific CI auth.

- **`.github/workflows/validate.yml`**  
  Improved directionally, but it validates JSON shape more than deployment coherence. It does not protect against the current broken image/registry story or contract drift between app config and infra.

- **`infra/main.bicep` + `infra/modules/`**  
  Container Apps alignment is correct in principle, but the runtime image/registry model is incomplete. Contributor-at-RG does not cover future RBAC writes such as `AcrPull` assignment if CI is asked to own those too.

- **`src/app.js`**  
  `/health` is acceptable as implemented.

- **`README.md`**  
  Needs a harder architectural correction: the button/manual path must be demoted, and the config reference must stop mixing old and new environment-variable names.

- **`scripts/07-bootstrap-github-actions-uami.ps1`**  
  Good one-time bootstrap foundation, but incomplete for the actual workflow contract and too rigid if future CI ownership includes RBAC writes beyond plain image updates.

## Required follow-up ownership

**Escalate to a new Azure delivery specialist for the next revision** (Container Apps + GitHub Actions + ACR + Azure RBAC).  
If the chosen fix also standardizes runtime env names, **Neo may own the app/config alignment portion**, but **Trinity must remain locked out of the next revision of this artifact**.

### 2026-07-21: ACR delivery rework adopted for Container Apps
**By:** Switch
**Source:** `switch-acr-delivery-fix.md`

- Date: 2026-07-21
- Scope: `infra/main.bicep`, `infra/modules/container-app.bicep`, new `infra/modules/container-registry.bicep`, `azuredeploy.json`, `.github/workflows/deploy.yml`, `.github/workflows/validate.yml`, `scripts/07-bootstrap-github-actions-uami.ps1`, `README.md`

## Decision

Implement Morpheus's required rework by making **Azure Container Registry (ACR)** the runtime registry and by making the **primary deployment story** explicitly:

1. deploy infra,
2. run the GitHub Actions UAMI/OIDC bootstrap,
3. set GitHub **Environment-scoped** variables,
4. publish the real app image through CI/CD.

I chose Morpheus option **(a)** for the placeholder-image issue: the ARM/Bicep path now stands up infrastructure plus a clearly intentional bootstrap placeholder revision, and the real repo image is delivered only by `.github/workflows/deploy.yml`.

## Implemented

- Added an ACR resource to the infra stack and exposed its name/login server in outputs.
- Configured the Container App with registry wiring for managed-identity-based ACR pulls.
- Switched the deploy workflow from GHCR to ACR using `az acr build` plus the existing Azure OIDC/UAMI login flow.
- Standardized the deploy-time variable contract on **GitHub Environment variables**:
  - `AZURE_CLIENT_ID`
  - `AZURE_TENANT_ID`
  - `AZURE_SUBSCRIPTION_ID`
  - `AZURE_RESOURCE_GROUP`
  - `AZURE_CONTAINER_APP_NAME`
  - `AZURE_CONTAINER_REGISTRY_NAME`
  - `AZURE_CONTAINER_REGISTRY_LOGIN_SERVER`
  - `AZURE_CONTAINER_APP_FQDN` (optional)
- Updated `scripts/07-bootstrap-github-actions-uami.ps1` to discover the deployed Container App and ACR, grant the Container App identity `AcrPull` on the ACR, and print the matching environment-scoped `gh variable set --env ...` commands.
- Demoted the Deploy to Azure button in `README.md` to an evaluation-only path and documented CI/CD as the primary delivery mechanism.
- Tightened `validate.yml` so it now checks for ACR presence, Container App registry wiring, and removal of the broken `npm start` placeholder behavior.

## RBAC choice

Per Morpheus's note, I kept CI's ongoing permissions minimal and put the `AcrPull` assignment in the **one-time bootstrap script** rather than requiring CI to create role assignments. CI continues to rely on RG-scoped Contributor for `az acr build` / `az containerapp update`; the bootstrap handles the one-time RBAC write.

## Reviewer status

Ready for **Morpheus re-review**.

## Remaining user-facing questions

None required to review this rework. The infra currently defaults ACR to **Basic** SKU for demo cost/footprint; upgrade later only if throughput, geo-replication, or premium registry features are needed.

### 2026-07-21: Container Apps delivery rework approved
**By:** Morpheus
**Source:** `morpheus-container-apps-review-2.md`

- Date: 2026-07-21
- Verdict: **Approve**
- Reviewed work from: **Switch**

## Decision

Switch addressed the architectural blockers from my prior rejection. This is now a coherent delivery path for the scope under review.

## What I verified

### 1. ACR is now the runtime registry, with managed-identity pull

- `infra/modules/container-registry.bicep` adds ACR and disables admin credentials (`adminUserEnabled: false`).
- `infra/modules/container-app.bicep` wires the Container App to the registry through:
  - `configuration.registries`
  - `server: containerRegistryLoginServer`
  - `identity: 'system'`
- `scripts/07-bootstrap-github-actions-uami.ps1` now grants the Container App's system-assigned identity **AcrPull** on the discovered ACR as a one-time bootstrap-owned RBAC write.

That is the correct architecture. No admin-user registry path is being normalized here.

### 2. `deploy.yml` now uses ACR under OIDC/UAMI auth

- GitHub Actions still authenticates with `azure/login@v2` using OIDC/UAMI.
- The workflow now builds and pushes with `az acr build`.
- The pushed image reference comes from `AZURE_CONTAINER_REGISTRY_LOGIN_SERVER`, not GHCR.
- Deployment still happens through `az containerapp update`.

This matches the architecture call I made.

### 3. Bootstrap script ownership and variable scope are corrected

- CI's ongoing permission model stays at RG-scoped **Contributor** for the GitHub Actions UAMI.
- The one-time script owns the extra RBAC write for **AcrPull**.
- The script now prints **environment-scoped** `gh variable set --env ...` commands for:
  - `AZURE_CLIENT_ID`
  - `AZURE_TENANT_ID`
  - `AZURE_SUBSCRIPTION_ID`
  - `AZURE_RESOURCE_GROUP`
  - `AZURE_CONTAINER_APP_NAME`
  - `AZURE_CONTAINER_APP_FQDN`
  - `AZURE_CONTAINER_REGISTRY_NAME`
  - `AZURE_CONTAINER_REGISTRY_LOGIN_SERVER`

Those names match what `deploy.yml` reads.

### 4. Deploy-to-Azure path is properly demoted

- `README.md` now makes the primary path explicit:
  1. deploy infra
  2. run bootstrap
  3. set GitHub Environment variables
  4. deploy image through CI/CD
- The ARM button is clearly labeled **evaluation-only**.
- `azuredeploy.json` metadata now says it provisions infrastructure plus a bootstrap placeholder, not the repo's real application image.

That is the right framing.

### 5. Validation checks are aligned with the new story

- `validate.yml` now checks for ACR presence.
- It checks Container App registry wiring and requires `identity: system`.
- It rejects the old broken placeholder shape (`npm start` on a base image).

This is directionally sufficient for the artifact under review.

## Remaining follow-up (non-blocking, separate artifact)

The runtime app/config env-name reconciliation is still pending between `src/config.js`, infra-set variables, and parts of the README configuration reference. Per the task framing, that remains a **Neo follow-up** and is **not a blocker for approving this Azure delivery rework**.

## Final call

Approve Switch's rework. The previous blockers around GHCR, unclear registry auth, button positioning, and bootstrap variable scope are resolved.

### 2026-07-21: Runtime env-var contract reconciled to src/config.js
**By:** Neo
**Source:** `neo-env-var-reconciliation.md`

- Date: 2026-07-21
- Scope: `src/config.js`, `infra/main.bicep`, `infra/modules/container-app.bicep`, `README.md`

## Decision

Use **`src/config.js` as the canonical runtime environment-variable contract** and align infra/docs to the names the application code already consumes.

## Implemented

- Updated `infra/modules/container-app.bicep` so the Container App now injects the Verified ID and IdentityPass variables that `src/config.js` actually reads:
  - `VC_ISSUER_AUTHORITY`
  - `VC_CREDENTIAL_MANIFEST_URL`
  - `VC_CREDENTIAL_TYPE`
  - `IDENTITYPASS_API_ENDPOINT`
- Left `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `FIDO2_*`, `KEY_VAULT_URL`, and `DEMO_MODE` unchanged because they already match `src/config.js`.
- Rewrote the `README.md` configuration reference to document the real current contract from `src/config.js`, including `APP_BASE_URL`, `SESSION_SECRET`, `AZURE_AUTHORITY`, `VC_SERVICE_SCOPE`, `IDENTITYPASS_SUBSCRIPTION_KEY`, and `IDENTITYPASS_MANAGER_EMAIL`.
- Removed stale README entries that no longer match the code, including `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `VERIFIED_ID_*`, `WEBAUTHN_*`, callback/session-store/mail/log-level settings, and other variables not read by `src/config.js`.

## Notes

- `infra/main.bicep` parameter names remain unchanged; they are deployment-time Bicep parameter names, not the app's runtime env-var contract.
- The app still uses `ClientSecretCredential` in `src/services/graph-service.js` and `src/services/verified-id-service.js`, so `AZURE_CLIENT_SECRET` is still a real runtime requirement today.

## Recommendation for Tank

Evaluate a follow-up security change to move app runtime auth from `ClientSecretCredential` to `DefaultAzureCredential` / managed identity where feasible. I did **not** make that policy change here because it would alter the app's auth model, not just reconcile naming.

## Governance

- All meaningful changes require team consensus
- Document architectural decisions here
- Keep history focused on work, decisions focused on direction

### 2026-07-21: Switch — bootstrap script bugfixes for live Azure OIDC/UAMI run
**By:** Switch
**Source:** `switch-bootstrap-script-bugfix.md`

# Switch — bootstrap script bugfixes for live Azure OIDC/UAMI run

- Date: 2026-07-21
- Scope: `scripts/07-bootstrap-github-actions-uami.ps1`

## Decision

Fix two production-impacting bugs found during the coordinator's live Azure run of `scripts/07-bootstrap-github-actions-uami.ps1`:

1. Wrap interpolated variables in the federated-credential subjects with `${...}` so PowerShell does not misparse `"$GitHubRepository:environment"` / `"$GitHubRepository:ref"` as drive-qualified variable references.
2. Remove `--assignee-principal-type ServicePrincipal` from the `az role assignment list` call only; retain it on the `az role assignment create` call.

## Why

- The broken interpolation created invalid federated credential subjects such as `repo:staging` and `repo:refs/heads/main`, which will not match GitHub Actions OIDC tokens and would break `azure/login@v2`.
- Azure CLI 2.88.0 rejects `--assignee-principal-type` on `role assignment list`, so idempotent RBAC checks failed before create logic could run.

## Verification notes

- `Ensure-FederatedCredential` already compares `issuer`, `subject`, and `audiences`; on re-run it will detect the existing bad subject as a mismatch, delete the stale credential, and recreate it with the corrected subject.
- The shared `Ensure-RoleAssignment` helper is used for both RG-scoped Contributor and ACR-scoped AcrPull checks, so removing the invalid flag from the list call fixes both paths at once.
- Repo-wide scan of `.ps1` files found no other risky `"$Variable:something"` interpolation sites beyond the two federated-credential subject strings in this script.

### 2026-07-21:  bootstrap yes flag fix
**By:** Switch
**Source:** `switch-bootstrap-yes-flag-fix.md`

2026-07-21: Added non-interactive confirmation flags for destructive bootstrap cleanup/delete commands in 07-bootstrap-github-actions-uami.ps1.

### 2026-07-21: Switch: bootstrap chain aligned to Container Apps delivery
**By:** Switch
**Source:** `switch-bootstrap-chain-container-apps-alignment.md`

# Switch: bootstrap chain aligned to Container Apps delivery

- Date: 2026-07-21
- Scope: `scripts/bootstrap.ps1`, `scripts/05-deploy-infrastructure.ps1`, `README.md`

## Decision

Treat `scripts/05-deploy-infrastructure.ps1` as an **infrastructure-and-runtime-config** step only. It should deploy the Bicep stack, write the canonical Entra/Verified ID/IdentityPass/FIDO2 values into Key Vault, and hand application image delivery off to the existing ACR + GitHub Actions Container Apps pipeline instead of attempting any App Service ZIP deploy.

## Implemented

- Removed ZIP/App Service deployment behavior from `scripts/05-deploy-infrastructure.ps1` and replaced it with an explicit Container Apps delivery handoff (`deploy.yml` or manual `az acr build` + `az containerapp update`).
- Updated bootstrap/deploy defaults to this repo's provisioned target values:
  - Resource group: `rg-entra-verifiedid-example`
  - Region: `centralus`
  - Tenant: `b9735550-cbce-4703-9c6e-e0e51de71a0d`
  - Subscription: `7e1b60b8-d616-4396-9de2-fc917930d02e`
- Aligned the generated `.env` file to the canonical runtime contract from `src/config.js` (`AZURE_*`, `VC_*`, `IDENTITYPASS_*`, `FIDO2_*`, `KEY_VAULT_URL`, `APP_BASE_URL`, `SESSION_SECRET`, etc.).
- Updated comments/examples away from `*.azurewebsites.net` assumptions toward Container Apps FQDN guidance and added an optional `-AppBaseUrl` bootstrap override for real runs where the exact public URL is already known.

## Why

The repo's source of truth now provisions Azure Container Apps plus ACR, and the real application image is delivered by CI/CD. Keeping ZIP deploy logic in the bootstrap chain would reintroduce the rejected App Service assumptions and hide the fact that first image publication is a separate delivery step.

## Follow-up

For **demo mode**, the chain can run end-to-end with placeholder Container Apps URL shape values. For **real** tenant/bootstrap runs, the exact Container Apps FQDN is only known after infrastructure deployment, so rerunning the pre-infra identity/config steps with the actual public URL (or supplying `-AppBaseUrl` up front when using a custom domain) remains the safest path.

### 2026-07-21: Tank review of Entra ID / Verified ID setup scripts
**By:** Tank
**Source:** `tank-entra-id-config-review.md`

## 2026-07-21 — Tank review of Entra ID / Verified ID setup scripts

**Reviewer:** Tank  
**Scope reviewed:** `scripts/01-configure-app-registration.ps1`, `02-configure-verified-id.ps1`, `03-configure-identitypass.ps1`, `04-configure-fido2-policy.ps1`  
**Tenant intended for run:** `b9735550-cbce-4703-9c6e-e0e51de71a0d`

### Sources checked

- Repo code:
  - `scripts/01-configure-app-registration.ps1`
  - `scripts/02-configure-verified-id.ps1`
  - `scripts/03-configure-identitypass.ps1`
  - `scripts/04-configure-fido2-policy.ps1`
  - `src/services/graph-service.js`
  - `src/services/verified-id-service.js`
  - `src/services/identitypass-service.js`
  - `src/routes/issuance.js`
  - `src/views/status.ejs`
  - `src/views/complete.ejs`
  - `src/app.js`
- Microsoft Learn:
  - https://learn.microsoft.com/en-us/entra/verified-id/verifiable-credentials-configure-tenant
  - https://learn.microsoft.com/en-us/entra/verified-id/admin-api
  - https://learn.microsoft.com/en-us/entra/verified-id/how-to-register-didwebsite
  - https://learn.microsoft.com/en-us/entra/identity/authentication/howto-authentication-temporary-access-pass
  - https://learn.microsoft.com/en-us/graph/api/user-list?view=graph-rest-1.0
  - https://learn.microsoft.com/en-us/graph/api/authentication-post-fido2methods?view=graph-rest-beta

---

## Verdicts

### 1) `scripts/01-configure-app-registration.ps1`
**Verdict:** **Needs change before running for real**

**What is fine**
- The Verified ID Request Service permissions are directionally least-privilege for an app that does both issuance and presentation: `VerifiableCredential.Create.IssueRequest` and `VerifiableCredential.Create.PresentRequest` on app `3db474b9-6a0c-4840-96ac-1fceb342124f` are narrower than blanket `VerifiableCredential.Create.All`.

**Problems**
1. **Graph permission set is not aligned to the runtime auth model.**  
   The script adds delegated `User.Read` plus application `UserAuthenticationMethod.ReadWrite.All` (`01-configure-app-registration.ps1:62-64`). But the app runtime uses `ClientSecretCredential` and `/.default` app-only tokens (`src/services/graph-service.js`, `src/services/verified-id-service.js`), so delegated `User.Read` will not be present in the app token. The code also does an app-only `/users` lookup by email (`src/services/graph-service.js:41-63`), which needs an application read permission such as `User.Read.All`, not delegated `User.Read`.
2. **Client secret is returned in plaintext from the script.**  
   The script includes `ENTRA_CLIENT_SECRET = $secretValue` in its returned hashtable and then `return $output` (`01-configure-app-registration.ps1:282-297`). If invoked directly without capturing output, PowerShell will print the secret to the console. That is not safe for a real tenant run.
3. **Redirect/OIDC shape is not proven correct for the current app.**  
   The script registers `/signin-oidc` redirect URIs and enables ID-token implicit issuance (`01-configure-app-registration.ps1:109,138`), but the current Node app does not expose any `signin-oidc` route (`src/app.js` only mounts `/`, `/onboarding`, `/api/issuance`, `/api/verification`, `/passkey`). This is dead config at best and misleading at worst.

**Required changes**
- **Switch:** update script 01 so it requests the Graph **application** permissions the current runtime actually uses. At minimum, if the current app-only lookup stays, replace delegated `User.Read` with the least app-only read permission that supports `/users?$filter=mail...` (currently `User.Read.All` per Learn). Keep `UserAuthenticationMethod.ReadWrite.All` only if Neo keeps server-side FIDO2 registration.
- **Switch:** stop returning plaintext secrets in the script result. Persist the secret directly to Key Vault or emit only a secure reference/name; do not return `ENTRA_CLIENT_SECRET` as a plain string.
- **Neo:** either implement the actual OIDC callback flow that matches `/signin-oidc`, or have Switch remove the unused redirect URI + implicit ID-token configuration from script 01 until the app truly needs it.

---

### 2) `scripts/02-configure-verified-id.ps1`
**Verdict:** **Needs change before running for real**

**Problems**
1. **Authority/contract management permission model looks stale.**  
   The script asserts only `VerifiableCredential.Create.All` (`02-configure-verified-id.ps1:141`) while it creates authorities and contracts through beta management endpoints (`02-configure-verified-id.ps1:156-246`). Current Learn admin guidance for managing authorities/contracts calls out the **Verifiable Credentials Service Admin** permissions such as `VerifiableCredential.Authority.ReadWrite` and `VerifiableCredential.Contract.ReadWrite`, plus Key Vault `Create Key` when creating a new authority. Revalidate this before touching a real tenant.
2. **`DidWebDomain` is not validated strongly enough.**  
   The script accepts any string and interpolates it into `https://$DidWebDomain/.well-known/did-configuration.json` and `did:web:$DidWebDomain` (`02-configure-verified-id.ps1:43,175,197,201,269`). Per Learn, the linked domain must be an exact HTTPS host with no redirects. The script should reject schemes, paths, query strings, whitespace, and anything that is not a bare host/domain.
3. **Credential contract over-collects data and is internally inconsistent with issuance.**  
   The contract display/rules require `employeeId`, `email`, `displayName`, `department`, and `startDate` (`02-configure-verified-id.ps1:83-87,109-113`), but the actual issuance path only sends `employeeId`, `email`, and `onboardingDate` (`src/routes/issuance.js:28-30`). This is both a correctness bug and a minimization issue. `department` and exact `startDate` are unnecessary PII for this demo onboarding flow as currently implemented.

**Required changes**
- **Switch:** rework script 02 to use the currently documented authority/contract management permission model, or explicitly prove the beta Graph path/permission set against current Learn before a real run.
- **Switch:** add strict validation for `DidWebDomain` as a host-only value and fail fast if the derived HTTPS URL is not a direct, non-redirecting public `.well-known` endpoint.
- **Neo:** reduce the credential schema to the minimum claims the app actually needs, then align issuance payloads and contract rules. Today the cleanest fix is to remove `department` and `startDate` from the contract unless the app is updated to use and justify them.

---

### 3) `scripts/03-configure-identitypass.ps1`
**Verdict:** **Needs change before running at all, even in DemoMode**

**Problems**
1. **The script’s callback URLs do not match the app.**  
   The script registers `/api/identitypass/webhook` and `/api/identitypass/approval` (`03-configure-identitypass.ps1:92-93`), while the runtime service code uses `/api/identitypass/callback` (`src/services/identitypass-service.js:46`) and `src/app.js` does not mount any IdentityPass route at all. As written, the production webhook path is not wired.
2. **Webhook signature validation is not implemented.**  
   The script generates a webhook secret and warns operators to validate HMAC (`03-configure-identitypass.ps1:141-164,301,319`), but there is no matching webhook handler or signature check in the app code. That is a real integrity gap.
3. **Demo mode can easily be mistaken for real approval.**  
   The script says demo mode means “all identity checks return verified” (`03-configure-identitypass.ps1:20`) and the service auto-approves locally after 15 seconds (`src/services/identitypass-service.js:7-33,64-72`), but the user-facing status/complete views still say the manager receives an IdentityPass email and approval completed via IdentityPass (`src/views/status.ejs`, `src/views/complete.ejs`). A header “Demo Mode” badge exists, but that is not strong enough for a security-sensitive identity workflow.
4. **Sensitive values are returned in plaintext.**  
   The script returns `IDENTITYPASS_API_KEY` and `IDENTITYPASS_WEBHOOK_SECRET` in its result object (`03-configure-identitypass.ps1:298-303,323`). Like script 01, direct invocation can print them.

**Required changes**
- **Switch:** make script 03 emit callback URLs that exactly match implemented app routes, or block non-demo mode until the runtime route contract exists.
- **Neo:** implement the actual `/api/identitypass/...` webhook/callback handlers and enforce HMAC signature validation before any state transition is accepted.
- **Neo:** make demo mode unmistakable in the actual UX and API responses: explicitly label the onboarding step as simulated, replace “manager receives an email via IdentityPass” copy in demo mode, and mark the completion page as simulated approval rather than real identity proofing.
- **Switch:** stop returning plaintext IdentityPass secrets/API keys from the script output.

---

### 4) `scripts/04-configure-fido2-policy.ps1`
**Verdict:** **Needs change before running for real**

**What is fine**
- Default TAP lifetime of **60 minutes** is reasonable. Microsoft Learn still documents **1 hour** as the default TAP lifetime, with one-time use available and recommended for tighter control.
- The script already sets `isUsableOnce = $true` and caps `maximumLifetimeInMinutes` at 480, which is stricter than the broad platform maximums.
- FIDO2 attestation enforcement plus an explicit AAGUID allowlist is the right security direction.

**Problems**
1. **Blank scope silently means tenant-wide rollout.**  
   When `TargetGroupId`/`TapGroupId` are blank, the helper emits `all_users` (`04-configure-fido2-policy.ps1:114-117`) and the script only prints “All users” (`04-configure-fido2-policy.ps1:90-91`). That is too soft for a real production run.
2. **Production guardrails are too weak for TAP blast radius.**  
   Learn guidance expects admins to choose included users/groups for TAP. With the current defaults, a rushed operator can enable TAP/FIDO2 tenant-wide without a prominent warning or explicit opt-in switch.

**Required changes**
- **Switch:** add loud runtime warnings whenever either scope is blank, and require an explicit override switch (for example `-AllowAllUsers`) before non-demo runs can target all users.
- **Switch:** keep 60 minutes as the default, but print a production recommendation to scope TAP to a dedicated onboarding group and consider 15-30 minutes for higher-risk cohorts.

---

## Recommendation on Neo’s standing flag: move runtime auth from `ClientSecretCredential` to managed identity?

**Recommendation: Yes.**

Because this app now targets Azure Container Apps and the team already moved CI/CD to managed-identity/OIDC patterns, the runtime should also stop depending on a long-lived `AZURE_CLIENT_SECRET`. Use `DefaultAzureCredential` so the app uses managed identity in Azure and developer credentials locally. This removes secret storage/rotation risk, reduces blast radius, and aligns with Tank’s rule to prefer Key Vault/managed identity over static client secrets.

**Follow-up owner:** **Neo** for the app auth code (`src/services/graph-service.js`, `src/services/verified-id-service.js`), with **Switch** for any required role assignments or config changes.

### 2026-07-21T15:18:12.548-04:00: Route contract decided for IdentityPass runtime/app alignment
**By:** Neo
**Source:** `neo-identitypass-route-contract.md`

# Route contract decided for IdentityPass runtime/app alignment
Date: 2026-07-21T15:18:12.548-04:00
Method: POST
Path: /api/identitypass/callback
Rationale: Match the existing application service callback URL to minimize moving parts; Switch should align script 03 to this exact route.

### 2026-07-21T15:18:12.548-04:00: VC claims decision
**By:** Neo
**Source:** `neo-vc-claims-decision.md`

# VC claims decision
Date: 2026-07-21T15:18:12.548-04:00
Decision: Keep the issuance contract minimal.
Claims used by the app today: employeeId, email, onboardingDate.
Claims not used by the app and should be removed from script 02's contract: displayName, department, startDate.
Switch should align the contract to this minimal claim set.

### 2026-07-21T15:18:12.548-04:00: Neo security fixes summary
**By:** Neo
**Source:** `neo-security-fixes.md`

# Neo security fixes summary
Date: 2026-07-21T15:18:12.548-04:00

## 1) IdentityPass webhook / callback
- Final route contract: `POST /api/identitypass/callback`.
- Implemented `src/routes/identitypass.js` and mounted it in `src/app.js` before the JSON body parser so the raw request body can be HMAC-verified.
- Added `IDENTITYPASS_WEBHOOK_SECRET` support in `src/config.js`.
- Callback now rejects missing/invalid signatures with `401` and only updates approval state after a valid HMAC check.
- `src/services/identitypass-service.js` now tracks request state so webhook updates can drive the approval step.

## 2) Demo-mode UX
- Updated `src/views/status.ejs` to make simulated approval explicit in the title, subtitle, status text, and "What happens next?" copy.
- Updated `src/views/complete.ejs` to clearly state that manager approval was simulated in Demo Mode.
- Updated `src/routes/onboarding.js` approval-status JSON to return `simulatedApproval` and demo-mode status copy.

## 3) Credential contract minimization
- Confirmed the app only uses `employeeId`, `email`, and `onboardingDate` for issuance today.
- Left issuance claims minimal in `src/routes/issuance.js` and wrote `.squad/decisions/inbox/neo-vc-claims-decision.md` so Switch can remove `displayName`, `department`, and `startDate` from script 02's contract.

## 4) Managed identity migration
- Replaced `ClientSecretCredential` with `DefaultAzureCredential` in `src/services/graph-service.js` and `src/services/verified-id-service.js`.
- Left `AZURE_CLIENT_SECRET` in `src/config.js` only as a deprecated compatibility entry because infra/docs/bootstrap still reference it outside `src/`.

## Validation
- `package.json` has no `npm test` script, so there were no existing automated tests to run.
- Ran `npm install` after validation first failed on missing dependencies.
- Smoke-tested the app in demo mode:
  - `/health` returned `ok`
  - onboarding status page showed the new simulated-approval copy
  - invalid IdentityPass callback signature returned `401`
  - valid callback signature advanced approval state to `approved`
- Loaded the updated service modules directly with Node (`graph-service`, `verified-id-service`, `identitypass-service`).

## Coordinator / Switch follow-up
- The managed identity itself must receive its own Microsoft Graph / Verified ID app-role assignments and admin consent where applicable; those permissions do **not** carry over from the current app registration automatically.
- If Azure runtime env vars keep setting `AZURE_CLIENT_SECRET`, `DefaultAzureCredential` can still authenticate with environment credentials instead of managed identity; infra/runtime config should remove that secret when the tenant-side migration is ready.
- If Azure keeps setting `AZURE_CLIENT_ID`, confirm it refers to the intended managed identity (for UAMI) or omit it for system-assigned MI.
- IdentityPass signature header naming is still partner-doc-dependent; the runtime currently accepts `x-signature`, `x-identitypass-signature`, `x-hub-signature-256`, and `x-signature-hmac-sha256` to cover the common HMAC patterns until Switch confirms the exact partner header.

### 2026-07-21T15:18:12-04:00: 18:12-04:00 — Entra setup script security fixes
**By:** Switch
**Source:** `switch-entra-config-security-fixes.md`

## 2026-07-21T15:18:12-04:00 — Entra setup script security fixes

**By:** Switch  
**Scope:** `scripts/01-configure-app-registration.ps1`, `02-configure-verified-id.ps1`, `03-configure-identitypass.ps1`, `04-configure-fido2-policy.ps1`, tightly-coupled `scripts/bootstrap.ps1`

### What changed

1. **Script 01**
   - Replaced delegated Graph `User.Read` with application `User.Read.All` for the app-only `/users?$filter=mail...` runtime pattern.
   - Kept `UserAuthenticationMethod.ReadWrite.All` because the current runtime still has server-side Graph FIDO2 registration calls.
   - Removed unused `/signin-oidc` redirect / implicit ID-token registration and now clears that stale web config on existing app registrations too.
   - After Neo confirmed the app now uses `DefaultAzureCredential`, script 01 no longer creates a runtime client secret at all.

2. **Script 02**
   - Added strict `DidWebDomain` validation for host-only input and a fail-fast check that `https://<domain>/.well-known/did-configuration.json` is directly reachable without redirects.
   - Minimized the credential contract to `employeeId`, `email`, and `onboardingDate` to match current issuance behavior.
   - Updated the script guidance to reflect current Microsoft Learn admin-permission guidance (`VerifiableCredential.Authority.ReadWrite` and `VerifiableCredential.Contract.ReadWrite`) instead of the stale `VerifiableCredential.Create.All` assertion.

3. **Script 03**
   - Aligned webhook/approval callback registration to `/api/identitypass/callback` as the best current runtime contract.
   - Stopped returning `IDENTITYPASS_API_KEY` and `IDENTITYPASS_WEBHOOK_SECRET` in plaintext; they are now secure-string outputs unless persisted to Key Vault.

4. **Script 04**
   - Added `-AllowAllUsers` as an explicit override for blank FIDO2/TAP scopes.
   - Blank scopes now fail loudly in non-demo mode unless the override is supplied.
   - Added TAP scoping/lifetime guidance (dedicated onboarding group; 15–30 minutes for higher-risk cohorts).

5. **Bootstrap compatibility**
   - Updated `scripts/bootstrap.ps1` to tolerate the absence of a client secret, and to pass the IdentityPass subscription key to infrastructure as a `SecureString`.

6. **Managed identity runtime alignment**
   - Updated `scripts/05-deploy-infrastructure.ps1` to grant the Container App managed identity the required Microsoft Graph and Verified ID Request Service app roles after deployment.
   - Stopped injecting `AZURE_CLIENT_SECRET` into the Container App / ARM evaluation path so `DefaultAzureCredential` can prefer managed identity cleanly.

### Validation

- PowerShell parse checks passed for scripts 01–04 and the updated bootstrap script.
- Re-ran validation after Neo's runtime-auth decision: PowerShell parse checks passed for scripts 01–05 and `bootstrap.ps1`; `azuredeploy.json` parsed cleanly; `az bicep build --file infra/main.bicep` succeeded.

### Assumptions / coordinator follow-up

- Neo confirmed the final IdentityPass route is **`POST /api/identitypass/callback`** and the Verified ID contract should stay minimal (`employeeId`, `email`, `onboardingDate`), so the scripts were aligned to that exact runtime contract.
- I removed the unused OIDC redirect config because Neo confirmed there is no real `/signin-oidc` flow.
- I kept `UserAuthenticationMethod.ReadWrite.All` because Neo confirmed the app still performs server-side FIDO2 registration.
- Script 02 now reflects current Learn permission guidance, but it still uses the repo's existing Graph request helper rather than a full Admin API replatform. If Morpheus wants a deeper API-path migration later, that should be a separate follow-up.

### 2026-07-21T16:01:13.239-04:00:  app uami credential pinning
**By:** Neo
**Source:** `neo-app-uami-credential-pinning.md`

Date: 2026-07-21T16:01:13.239-04:00
By: Neo

## Decision

Pin `DefaultAzureCredential` to the app runtime user-assigned managed identity by passing `managedIdentityClientId` from the canonical runtime env contract.

## Implemented

- Updated `src/services/graph-service.js` to construct `DefaultAzureCredential` with `managedIdentityClientId: config.azure.clientId || undefined`.
- Updated `src/services/verified-id-service.js` the same way so both Graph and Verified ID token acquisition use the same runtime identity hint.
- Kept `src/config.js` as the single source of truth and clarified that `AZURE_CLIENT_ID` is the app runtime UAMI client ID used to disambiguate managed identity selection in Azure.
- Updated `README.md` configuration docs to explain that `AZURE_CLIENT_ID` is primarily for Azure runtime identity selection and is usually not required for local development.

## Contract note

`switch-app-uami-contract.md` was not present when this work ran, so I used `AZURE_CLIENT_ID` as the working contract, matching existing `src/config.js` conventions. Coordinator should reconcile only if Switch later publishes a different env-var name.

### 2026-07-21: Runtime app UAMI env contract
**By:** Switch
**What:** The Container App now gets `AZURE_CLIENT_ID=<app runtime UAMI clientId>` for the new runtime identity resource `uami-entra-vid-app` (`Microsoft.ManagedIdentity/userAssignedIdentities`). Neo should pin `DefaultAzureCredential({ managedIdentityClientId: config.azure.clientId })` so the app selects this UAMI instead of the deploy UAMI or any future sibling identity.
**Why:** The Container App now carries both a system-assigned identity (for ACR pull / Key Vault secret resolution) and a separate runtime UAMI for Microsoft Graph / Verified ID calls. Without explicitly pinning the managed-identity client ID, multi-identity resolution can drift.

### 2026-07-21: Runtime app UAMI wired for Container Apps + post-deploy Graph grants
**By:** Switch
**What:** Added a separate app-runtime UAMI flow without touching the deploy UAMI:

- Added `infra/modules/user-assigned-identity.bicep` and wired `infra/main.bicep` to create a new runtime identity named `uami-entra-vid-app`.
- Updated `infra/modules/container-app.bicep` so the Container App uses `SystemAssigned,UserAssigned`; the system identity stays in place for ACR pull and Key Vault secret resolution, while the runtime UAMI is attached for Graph / Verified ID API auth.
- Injected `AZURE_CLIENT_ID` into the Container App from the runtime UAMI client ID and exposed new Bicep/ARM outputs for the runtime UAMI name, client ID, and principal ID.
- Removed the old in-step app-role grant attempt from `scripts/05-deploy-infrastructure.ps1`; step 05 now surfaces the runtime UAMI identifiers and hands off the privileged directory change.
- Added `scripts/08-grant-app-uami-graph-permissions.ps1` as the idempotent post-deploy Microsoft Graph app-role grant step for the runtime UAMI service principal. It grants:
  - Microsoft Graph: `User.Read.All`, `UserAuthenticationMethod.ReadWrite.All`
  - Verified ID Request Service (`3db474b9-6a0c-4840-96ac-1fceb342124f`): `VerifiableCredential.Create.IssueRequest`, `VerifiableCredential.Create.PresentRequest`
- Updated `scripts/bootstrap.ps1` to orchestrate the new step as opt-in via `-GrantRuntimeManagedIdentityGraphPermissions`, keeping the privileged grant behind explicit confirmation.
- Kept the deploy UAMI (`uami-entra-verifiedid-example-deploy`) unchanged and still free of Graph permissions.

**Why:** The runtime Node app now uses `DefaultAzureCredential`, so it needs a dedicated managed identity with Graph application permissions granted to the correct service principal. The deploy UAMI is intentionally RG-scoped Contributor-only and must never become a directory-permission principal. Keeping system-assigned + user-assigned identities side by side preserves the existing Azure-resource access path while isolating Graph/Verified ID auth onto the new runtime identity.

**Validation:** PowerShell parse checks passed for `scripts/05-deploy-infrastructure.ps1`, `scripts/08-grant-app-uami-graph-permissions.ps1`, and `scripts/bootstrap.ps1`. `az bicep build --file infra\main.bicep --stdout` succeeded. `azuredeploy.json` parses successfully. Bicep emitted one pre-existing warning about secret-like outputs in `infra/modules/storage.bicep`.

**Open question:** The directory grant step is intentionally gated behind `-GrantAdminConsent`; it still depends on the operator holding sufficient tenant role privileges (Global Administrator, Privileged Role Administrator, or equivalent app-role-assignment authority) plus Graph scopes. Neo should still pin `managedIdentityClientId` in app code to avoid ambiguous identity selection when multiple identities are present.

### 2026-07-21: Switch — DemoMode bootstrap bugfixes for Verified ID, runtime UAMI grants, and demo TAP generation
**By:** Switch
**Source:** `switch-demomode-bugfixes.md`

# Switch — DemoMode bootstrap bugfixes for Verified ID, runtime UAMI grants, and demo TAP generation

- Date: 2026-07-21
- Scope: `scripts/bootstrap.ps1`, `scripts/08-grant-app-uami-graph-permissions.ps1`, `scripts/06-seed-demo-data.ps1`

## Decision

Harden the bootstrap/demo path without weakening real-run validation:

1. In `bootstrap.ps1`, DemoMode now uses a syntactically valid placeholder Container Apps hostname (`<app>-demo.<region>.azurecontainerapps.io`) when no real `-AppBaseUrl` was supplied, so Step 02 passes strict DID host validation.
2. In `bootstrap.ps1`, Step 05b is now skipped in DemoMode with a `[DEMO] Would grant Graph app roles to runtime UAMI` info line instead of attempting a real runtime-UAMI permission grant.
3. In `06-seed-demo-data.ps1`, demo TAP generation now wraps `New-Guid` in parentheses before calling `.ToString().Substring(...)`, fixing the PowerShell parser error.
4. In `08-grant-app-uami-graph-permissions.ps1`, DemoMode now ignores any non-GUID placeholder `AppRuntimeIdentityPrincipalId` and falls back to demo identity values, preserving strict GUID validation for real runs only.

## Why

- Strict DID domain validation in `02-configure-verified-id.ps1` is correct; the bug was the invalid `<env-hash>` placeholder constructed upstream during DemoMode bootstrap.
- DemoMode has no deployed runtime UAMI to permission, so attempting Step 05b with placeholder identity data is the wrong behavior.
- The TAP syntax bug in Step 06 is a real script defect and fails before any Azure-side logic matters.

## Verification notes

- Parsed `scripts/bootstrap.ps1`, `scripts/06-seed-demo-data.ps1`, and `scripts/08-grant-app-uami-graph-permissions.ps1` with PowerShell's parser; all three returned `PARSE-OK`.
- Scanned `06-seed-demo-data.ps1` for remaining `New-Guid.` method-chaining patterns and found none after the fix.

### 2026-07-21: Switch — templatized public-repo Azure IDs and bootstrap examples
**By:** Switch
**Source:** `switch-templatization-fix.md`

# Switch — templatized public-repo Azure IDs and bootstrap examples

- Date: 2026-07-21
- Scope: `scripts/bootstrap.ps1`, `scripts/05-deploy-infrastructure.ps1`, `scripts/07-bootstrap-github-actions-uami.ps1`, `scripts/08-grant-app-uami-graph-permissions.ps1`, `README.md`

## Decision

Remove hardcoded real Azure tenant/subscription defaults from the public example repo and require operators to pass their own values explicitly for live runs.

## Implemented

1. `scripts/07-bootstrap-github-actions-uami.ps1` now makes `-TenantId` and `-SubscriptionId` mandatory parameters instead of shipping real defaults.
2. `scripts/bootstrap.ps1`, `scripts/05-deploy-infrastructure.ps1`, and `scripts/08-grant-app-uami-graph-permissions.ps1` now default `TenantId` / `SubscriptionId` to empty strings and perform explicit runtime validation for live runs with helpful `Pass -TenantId <your-tenant-id>` / `-SubscriptionId <your-subscription-id>` errors.
3. Updated all script comment-based help examples and `README.md` examples to use `<your-tenant-id>` / `<your-subscription-id>` placeholders instead of real GUIDs.
4. Re-scanned the repo (excluding `.squad/` and `.env`) for the real tenant GUID, real subscription GUID, `spaidfamily`, `Spaid Family`, and `Spaid`; no matches remain in scripts or docs.

## Why

This repository is public, so real tenant/subscription identifiers must not appear as baked-in defaults that readers can mistake for safe example values. Explicit operator-supplied parameters are clearer and safer than plausible-looking placeholder GUIDs.

## Verification notes

- Parsed all touched PowerShell scripts with the PowerShell parser; all returned `PARSE-OK`.
- Repo-wide grep after the edits found no remaining matches for the real tenant/subscription GUIDs or the requested `Spaid` / `spaidfamily` strings outside `.squad/` and `.env`.

### 2026-07-21: Trinity: deploy-infrastructure workflow
**By:** Trinity
**Source:** `trinity-deploy-infrastructure-workflow.md`

# Trinity: deploy-infrastructure workflow

- Date: 2026-07-21
- Scope: `.github/workflows/deploy-infrastructure.yml`, `README.md`

## Decision

Add a separate **manual-only** GitHub Actions workflow for provisioning `infra/main.bicep` with the existing deploy UAMI over GitHub OIDC, instead of coupling infra provisioning to the app-image rollout workflow.

## Implemented

- Added `.github/workflows/deploy-infrastructure.yml` with `workflow_dispatch` only.
- The workflow targets a selected GitHub Environment (`staging` or `production`) and supports `whatIf` preview mode by default.
- Authentication matches `deploy.yml`: `azure/login@v2` using `vars.AZURE_CLIENT_ID`, `vars.AZURE_TENANT_ID`, and `vars.AZURE_SUBSCRIPTION_ID`.
- Real applies run `az deployment group create` against `infra/main.bicep` in `vars.AZURE_RESOURCE_GROUP`.
- Successful applies capture Bicep outputs and print operator-run `gh variable set ... --env <environment> --body "<value>"` commands for every `vars.AZURE_*` value `deploy.yml` depends on.
- The workflow emits an explicit reminder that `scripts/08-grant-app-uami-graph-permissions.ps1` stays manual/local and requires an Entra admin.
- `README.md` now documents when to run the new workflow, the manual variable-setting follow-up, and the Graph-consent non-goal.

## Why

`deploy.yml` assumes the Container App, ACR, and runtime UAMI already exist. A dedicated manual infra workflow closes that gap without widening the trust boundary: the existing RG-scoped deploy UAMI is enough for Bicep, while Graph permission grants remain outside GitHub Actions.

### 2026-07-21:  deploy infra workflow review
**By:** Morpheus
**Source:** `morpheus-deploy-infra-workflow-review.md`

- Date: 2026-07-21
- Verdict: **REJECTED**
- Reviewed work from: **Trinity**
- Reviewer protocol: **Trinity is locked out of the next revision of this artifact. Switch should own the revision. Trinity must not self-revise, advise, or co-author the fix.**

## Decision

Reject this workflow as submitted. Most of the architecture is sound, but it violates the repo owner's hard security-boundary requirement by embedding Graph-permission follow-up instructions directly inside the privileged GitHub Actions workflow.

## What I verified

### 1. Security boundary — **fails as written**

What holds:

- The workflow authenticates with `azure/login@v2` using `vars.AZURE_CLIENT_ID`, `vars.AZURE_TENANT_ID`, and `vars.AZURE_SUBSCRIPTION_ID` (`.github/workflows/deploy-infrastructure.yml:40-44`).
- The only Azure actions are `az deployment group what-if` and `az deployment group create` at resource-group scope (`.github/workflows/deploy-infrastructure.yml:55-60`, `84-89`).
- I found **no** `az role assignment`, `az ad`, `az rest`, Graph endpoint, or privilege-expansion commands in the workflow body.

What fails:

- The workflow summary/output code explicitly references `scripts/08-grant-app-uami-graph-permissions.ps1` and “Graph API permissions” (`.github/workflows/deploy-infrastructure.yml:157`, `169`).

That breaks the required boundary for this artifact: the workflow must stay strictly on infra provisioning and must not touch the Graph-consent step anywhere in the workflow itself.

**Required change:** remove both Graph/script reminder lines from the workflow. If operator guidance is still needed, move it to `README.md` or another local/manual runbook outside this privileged workflow.

### 2. Safety of manual trigger — **passes**

- Trigger is `workflow_dispatch` only (`.github/workflows/deploy-infrastructure.yml:4`).
- The `whatIf` boolean input exists and defaults to `true` (`.github/workflows/deploy-infrastructure.yml:14-18`).
- The workflow cleanly separates preview vs apply paths with `if: ${{ inputs.whatIf }}` and `if: ${{ !inputs.whatIf }}` (`.github/workflows/deploy-infrastructure.yml:47`, `76`, `93`).

This satisfies the accidental-trigger safety requirement.

### 3. No hardcoded identifiers — **passes**

- Tenant, subscription, client ID, and resource group all come from `vars.*` (`.github/workflows/deploy-infrastructure.yml:42-44`, `51-52`, `80-81`, `97-100`).
- I found no hardcoded GUIDs in the workflow.

This meets the public-repo rule.

### 4. Correctness vs `deploy.yml` contract — **passes**

`deploy.yml` consumes these environment variables:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_RESOURCE_GROUP`
- `AZURE_CONTAINER_APP_NAME`
- `AZURE_CONTAINER_REGISTRY_NAME`
- `AZURE_CONTAINER_REGISTRY_LOGIN_SERVER`
- `AZURE_CONTAINER_APP_FQDN`

Verified in `.github/workflows/deploy.yml:57`, `66-68`, `78`, `85`, `94-95`, `104-105`, `140`, `149-151`, `161`, `168`, `177-178`, `187-188`.

The infra workflow emits `gh variable set` commands for exactly that same set (`.github/workflows/deploy-infrastructure.yml:125-132`, `137`).

The captured Bicep outputs are internally consistent with `infra/main.bicep`:

- `webAppName` → `AZURE_CONTAINER_APP_NAME`
- `webAppHostname` → `AZURE_CONTAINER_APP_FQDN`
- `containerRegistryName` → `AZURE_CONTAINER_REGISTRY_NAME`
- `containerRegistryLoginServer` → `AZURE_CONTAINER_REGISTRY_LOGIN_SERVER`

Verified against `infra/main.bicep` outputs.

### 5. Environment gating — **passes**

- The workflow uses a job-level `environment:` block with `name: ${{ inputs.environment }}` (`.github/workflows/deploy-infrastructure.yml:32-33`).
- The dispatch input restricts values to `staging` or `production` (`.github/workflows/deploy-infrastructure.yml:6-13`).
- That is consistent with the repo’s existing staging/production environment pattern in `deploy.yml`, so GitHub Environment protection rules can apply here too.

## Final call

**Reject for one required revision:** remove Graph-permission and `scripts/08-grant-app-uami-graph-permissions.ps1` references from the workflow itself. The privilege scope, trigger safety, variable sourcing, output contract, and environment gating are otherwise acceptable.

### 2026-07-21: Switch — deploy-infrastructure workflow Graph-boundary fix
**By:** Switch
**Source:** `switch-deploy-infra-workflow-fix.md`

# Switch — deploy-infrastructure workflow Graph-boundary fix

- Date: 2026-07-21
- Reviewed work from: **Trinity** (rejected by Morpheus; reviewer lockout honored)
- Revision owner: **Switch**

## Decision

Remove the manual Graph-consent reminder from `.github/workflows/deploy-infrastructure.yml` entirely so the privileged infrastructure workflow contains **no** reference to `scripts/08-grant-app-uami-graph-permissions.ps1`, Graph API permissions, or Graph admin consent.

## What changed

- Deleted the step-summary reminder line that mentioned `scripts/08-grant-app-uami-graph-permissions.ps1` and Graph API permissions.
- Deleted the matching console `print(...)` reminder line from the same workflow body.
- Left the rest of the workflow unchanged.

## Documentation check

`README.md` already retains the required local/manual guidance:

- `README.md:184` — manual Graph permission grant remains a separate local step after infrastructure exists.
- `README.md:617` — GitHub Actions must not perform Graph admin consent.

## Validation

- Searched `.github/workflows/deploy-infrastructure.yml` after the edit: no matches remain for `08-grant-app-uami-graph-permissions`, `Graph API permissions`, or `Graph admin consent`.
- Parsed the workflow with PowerShell `ConvertFrom-Yaml`: `YAML_OK`.

## Result

The workflow now stays inside the infra-only cloud-credential boundary, while the README remains the sole home for the manual Graph-consent instruction.

### 2026-07-21:  deploy infra workflow final review
**By:** Morpheus
**Source:** `morpheus-deploy-infra-workflow-final-review.md`

- Date: 2026-07-21
- Verdict: **APPROVED**
- Reviewed work from: **Switch**
- Prior rejection addressed: **yes**

## Decision

Approve `.github/workflows/deploy-infrastructure.yml` as revised.

## What I verified

### 1. Graph-permission/script 08 references are removed from the privileged workflow body — **passes**

- I re-reviewed `.github/workflows/deploy-infrastructure.yml` directly.
- A targeted search of that workflow returned **no matches** for `08-grant-app-uami-graph-permissions`, `Graph API permissions`, `Graph admin consent`, `graph-permission`, or `graph-consent`.
- The workflow body now stays focused on `azure/login@v2`, `az deployment group what-if`, `az deployment group create`, and deployment-output summarization only.

### 2. README keeps the Graph-consent step as a standalone local/manual action — **passes**

- `README.md:184` keeps the required operator guidance: run `scripts/08-grant-app-uami-graph-permissions.ps1` manually as an Entra admin after infrastructure exists, and explicitly states this is **not** automated in GitHub Actions.
- `README.md:617` repeats the same boundary: script 08 remains a **manual, local, Entra-admin-only** step and GitHub Actions must not perform Graph admin consent.

### 3. Trigger safety still holds — **passes**

- The workflow remains `workflow_dispatch` only (`.github/workflows/deploy-infrastructure.yml:4`).
- The `whatIf` input remains present and defaults to `true` (`.github/workflows/deploy-infrastructure.yml:14-18`).
- Preview and apply paths are still explicitly split by `if: ${{ inputs.whatIf }}` and `if: ${{ !inputs.whatIf }}` (`.github/workflows/deploy-infrastructure.yml:47`, `76`, `93`).

### 4. No hardcoded identifiers; `vars.*` sourcing still holds — **passes**

- OIDC login still sources `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` from `vars.*` (`.github/workflows/deploy-infrastructure.yml:42-44`).
- Resource-group and tenant parameters in preview/apply paths still come from `vars.AZURE_RESOURCE_GROUP` and `vars.AZURE_TENANT_ID` (`.github/workflows/deploy-infrastructure.yml:51-52`, `80-81`, `97-100`).
- I found no hardcoded GUIDs or tenant/subscription IDs in the workflow.

### 5. `deploy.yml` variable contract consistency still holds — **passes**

`deploy.yml` still consumes this environment-variable contract:

- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (`.github/workflows/deploy.yml:66-68`, `149-151`)
- `AZURE_RESOURCE_GROUP`, `AZURE_CONTAINER_APP_NAME` (`.github/workflows/deploy.yml:94-95`, `104-105`, `177-178`, `187-188`)
- `AZURE_CONTAINER_REGISTRY_NAME`, `AZURE_CONTAINER_REGISTRY_LOGIN_SERVER` (`.github/workflows/deploy.yml:78`, `85`, `161`, `168`)
- `AZURE_CONTAINER_APP_FQDN` for environment URLs (`.github/workflows/deploy.yml:57`, `140`)

The infra workflow still prepares the same contract from current env vars and Bicep outputs, and those output names still exist in `infra/main.bicep`:

- `webAppName` (`infra/main.bicep:127`)
- `webAppHostname` (`infra/main.bicep:130`)
- `containerRegistryName` (`infra/main.bicep:142`)
- `containerRegistryLoginServer` (`infra/main.bicep:145`)
- `containerAppPrincipalId` (`infra/main.bicep:148`)
- `appRuntimeManagedIdentityName` (`infra/main.bicep:151`)
- `appRuntimeManagedIdentityClientId` (`infra/main.bicep:154`)
- `appRuntimeManagedIdentityPrincipalId` (`infra/main.bicep:157`)

### 6. Environment gating still holds — **passes**

- The dispatch input still restricts the target environment to `staging` or `production` (`.github/workflows/deploy-infrastructure.yml:6-13`).
- The deploy job still binds GitHub Environment protection via `environment.name: ${{ inputs.environment }}` (`.github/workflows/deploy-infrastructure.yml:32-33`).

## Final call

**APPROVED.** Switch removed the prohibited Graph/script 08 guidance from the privileged workflow body without regressing trigger safety, what-if default behavior, `vars.*` sourcing, `deploy.yml` contract consistency, or environment gating.

### 2026-07-21: Switch: script 06 IdentityPass callback path fix
**By:** Switch
**Source:** `switch-script06-endpoint-fix.md`

# Switch: script 06 IdentityPass callback path fix

- Date: 2026-07-21
- Scope: `scripts/06-seed-demo-data.ps1`

## Decision

Normalize the demo-data manager approval config to the single canonical IdentityPass callback endpoint:

- `/api/identitypass/callback`

## Why

`src/routes/identitypass.js` exposes only `POST /api/identitypass/callback`, and `scripts/03-configure-identitypass.ps1` already standardizes IdentityPass callbacks on that same path. Keeping separate `/approval` and `/webhook` values in script 06 was stale drift that could misconfigure locally generated demo artifacts.

### 2026-07-21T23:18:43.902-04:00:  npm audit fix
**By:** Neo
**Source:** `neo-npm-audit-fix.md`

Date: 2026-07-21T23:18:43.902-04:00
By: Neo

## Decision

Resolve the CI `npm audit --audit-level=high` failure by applying non-breaking audit fixes and upgrading `uuid` only to the first secure CommonJS-compatible major instead of jumping to the ESM-oriented latest major.

## Implemented

- Ran `npm audit fix`, which updated the vulnerable packages pulled into the app/runtime:
  - `axios` → `1.18.1`
  - `body-parser` → `1.20.6`
  - `brace-expansion` → `2.1.2` and `5.0.7`
  - `form-data` → `4.0.6`
- Upgraded the direct dependency `uuid` from `^9.0.0` to `^11.1.1`.
- Verified `uuid@11.1.1` still exposes the CommonJS `require('uuid')` entrypoint used by the app via `dist/cjs/index.js`.

## Why

`npm audit fix --force` would have pushed `uuid` to the latest major, but this repo is still CommonJS and currently imports `uuid` with `require(...)`. `uuid@11.1.1` clears the advisory while preserving the existing backend module contract, which keeps the smoke check green and avoids unnecessary source churn.

## Validation

- `npm audit --audit-level=high` now reports `found 0 vulnerabilities`.
- `node -e "require('./src/config'); require('./src/services/graph-service'); require('./src/services/verified-id-service'); console.log('module smoke check passed')"` succeeded.

### 2026-07-22T03-20-21: Fix false-positive ARM expression handling in Container App registry validation
**By:** Trinity
**What:** Fix false-positive ARM expression handling in Container App registry validation
**References:** .github/workflows/validate.yml, azuredeploy.json, PR #1
**Why:** The PR validation workflow's "Check Container App registry wiring" step was incorrectly treating ARM expression strings from azuredeploy.json as already-evaluated literals. In this template, the registry server is stored as [variables('acrLoginServer')], so a raw substring check against the unevaluated expression always fails even though deployment-time resolution produces an ACR login server. The fix adds a small ARM-expression-aware resolver for this check that can walk variables('name') and concat(...) references, recurse through the template's variables block, preserve opaque nested expressions symbolically when needed, and fail clearly on genuine resolution errors. The same resolver is now used for the registry identity and container args checks in that step so those checks remain correct if those fields are later expressed via simple ARM variables instead of literals.

### 2026-07-21: Trinity: workflow-level infra region override for capacity fallback
**By:** Trinity
**Source:** `trinity-region-override.md`

# Trinity: workflow-level infra region override for capacity fallback

- Date: 2026-07-21
- Scope: `.github/workflows/deploy-infrastructure.yml`

## Decision

Add an optional `workflow_dispatch` `location` input to the infrastructure deployment workflow and pass it through to the Bicep deployment only when provided.

## Why

`infra/main.bicep` already supports a `location` parameter and correctly defaults to `resourceGroup().location`, but live deployments can fail when a specific service has temporary regional capacity exhaustion. A workflow-level override lets operators retry a single deployment in an alternate Azure region without changing the resource group's home region or editing IaC defaults.

### 2026-07-21: Trinity: split Container Apps region from base infra region
**By:** Trinity
**Source:** `trinity-containerapp-region-split.md`

# Trinity: split Container Apps region from base infra region

- Date: 2026-07-21
- Context: Central US successfully provisioned the shared infra resources, but repeated deployments failed to create `Microsoft.App/managedEnvironments` with `ManagedEnvironmentCapacityHeavyUsageError`, blocking the Container Apps layer only.
- Decision: Keep the top-level `location` parameter for the shared stack, add a dedicated `containerAppLocation` parameter in `infra/main.bicep`, and route the workflow's existing optional `location` input to that new parameter instead of overriding the whole deployment region.
- Consequence: Existing centralus resources remain unchanged while the Container Apps managed environment and app can be retried in another supported region such as `eastus2`, `westus3`, or `swedencentral`.

### 2026-07-22: Trinity: use MCR Docker Hub mirror for bootstrap placeholder image
**By:** Trinity
**Source:** `trinity-mcr-mirror-fix.md`

# Trinity: use MCR Docker Hub mirror for bootstrap placeholder image

- **Date:** 2026-07-22
- **Scope:** `infra/modules/container-app.bicep`, `azuredeploy.json`

## Context

`Microsoft.App/containerApps` was failing to provision the bootstrap revision with:

`ContainerAppOperationError: Failed to provision revision for container app 'entra-vid-app'. Error details: Operation expired.`

The failure pattern was consistent across retries and took about 21–22 minutes each time.

## Root cause

The bootstrap placeholder container pulled `node:20-alpine` directly from Docker Hub (`docker.io`). From Azure datacenters this can hang or rate-limit badly enough that Container Apps never finishes pulling the image before its internal revision provisioning timeout expires.

## Decision

Keep the existing bootstrap placeholder behavior exactly the same, but change the image reference to Microsoft's public Docker Hub mirror on MCR:

- from: `node:20-alpine`
- to: `mcr.microsoft.com/mirror/docker/library/node:20-alpine`

No `registries` config change is required because the MCR mirror is a public anonymous-pull endpoint. The existing ACR registry wiring remains only for the real application image.

## Why

MCR mirrors the same public Docker Hub image content and tags while providing more reliable pull performance from Azure-hosted services. This is the lowest-risk fix because it changes only the registry path, not the container command, args, ports, env, or bootstrap semantics.

### 2026-07-22:  mcr tag fix
**By:** Trinity
**Source:** `trinity-mcr-tag-fix.md`

Date: 2026-07-22
By: Trinity

Decision:
- Update the bootstrap placeholder Container App image tag from `mcr.microsoft.com/mirror/docker/library/node:20-alpine` to `mcr.microsoft.com/mirror/docker/library/node:20-bookworm-slim` in both `infra/modules/container-app.bicep` and `azuredeploy.json`.

Why:
- The MCR Docker Hub mirror does not publish the `20-alpine` tag for `library/node`, which causes `MANIFEST_UNKNOWN` during bootstrap deployments.
- `20-bookworm-slim` is published on the MCR mirror and remains a small Node 20 base image suitable for the existing inline placeholder HTTP server.

### 2026-07-22T00:58:49.4045725-04:00: Trinity: decouple Container App Key Vault secret wiring from initial provisioning
**By:** Trinity
**Source:** `trinity-kv-rbac-deadlock-fix.md`

# Trinity: decouple Container App Key Vault secret wiring from initial provisioning

## Context

The initial `Microsoft.App/containerApps` deployment wired `IDENTITYPASS_SUBSCRIPTION_KEY` through a Key Vault-backed Container Apps secret (`identitypass-key`) resolved with the container app's own system-assigned managed identity.

At the same time, the template granted the `Key Vault Secrets User` role to that same system-assigned identity by computing the `principalId` from the container app resource itself. ARM therefore could not create the role assignment until the container app reached a terminal provisioning state.

## Problem

This created a circular dependency:

1. Container App startup needed to resolve `identitypass-key` from Key Vault.
2. That secret resolution required the container app's system identity to already have `Key Vault Secrets User`.
3. The role assignment could only be created after ARM finished provisioning the container app and could resolve its `principalId`.

In practice, the container app never reached `Succeeded`; it hung until Azure timed the operation out with `ContainerAppOperationError` / `Operation expired`.

## Decision

Bootstrap infra must not require the container app to resolve Key Vault-backed secrets during initial creation.

- Removed the Key Vault-backed `identitypass-key` secret from the bootstrap Container App definition.
- Removed the bootstrap `IDENTITYPASS_SUBSCRIPTION_KEY` secretRef env var from the initial Container App definition.
- Kept the Key Vault RBAC role assignment exactly as-is so it still lands after the container app exists.
- Updated post-image deployment workflow steps to configure the Key Vault-backed secret and set `IDENTITYPASS_SUBSCRIPTION_KEY=secretref:identitypass-key` with Azure CLI after the app already exists.
- Added `KEY_VAULT_URL` to the infra deployment output summary / `gh variable set` guidance so deploy workflows can wire the secret later.
- Mirrored the same bootstrap fix in `azuredeploy.json` to keep ARM-template-based deployment paths aligned.

## Consequences

- Initial infra deployment can now complete without the Key Vault RBAC deadlock.
- The later app deployment workflow remains responsible for attaching the real Key Vault-backed secret after infra has finished and RBAC exists.
- Future bootstrap secrets should avoid any design that requires a resource to fetch a secret before the identity permissions needed for that fetch can exist.

### 2026-07-22T01:24:01.8965534-04:00: ACR bootstrap RBAC deadlock fix
**By:** Trinity
**Source:** `trinity-acr-rbac-deadlock-fix.md`

## ACR bootstrap RBAC deadlock fix

- **Bug:** The bootstrap Container App configured `configuration.registries[]` to use its system-assigned identity against ACR during initial creation. That created the same RBAC circular dependency as the prior Key Vault secret issue: the app needed `AcrPull` during provisioning, but the role assignment could only be created after the Container App reached terminal state.
- **Fix:** Remove bootstrap-time ACR registry wiring from the initial Container App definition, then grant `AcrPull` on the ACR to the Container App system identity after the app exists. Wire the registry credential later in GitHub Actions with `az containerapp registry set`, just like we now defer Key Vault-backed secret wiring until post-provisioning.
- **Variables:** No new GitHub variables are required. `AZURE_CONTAINER_REGISTRY_LOGIN_SERVER` and `AZURE_CONTAINER_REGISTRY_NAME` already cover the post-provisioning registry wiring flow.

### 2026-07-22: Deploy UAMI needs RBAC admin at RG scope for Bicep role assignments
**By:** Trinity

- Date: 2026-07-22
- Scope: GitHub Actions bootstrap, Azure RBAC, infra deployment reproducibility

## Gap

The GitHub Actions deploy UAMI (`uami-entra-verifiedid-example-deploy`) previously received only `Contributor` on the application resource group. That was enough for most ARM/Bicep resource writes, but it failed on `Microsoft.Authorization/roleAssignments/write`.

`infra/main.bicep` creates role assignments such as `AcrPull` and `Key Vault Secrets User` for managed identities. During a real tenant deployment, those resources failed because `Contributor` does not include role-assignment write permission.

## Fix

Keep the existing `Contributor` grant and add `Role Based Access Control Administrator` at the same resource-group scope during `scripts/07-bootstrap-github-actions-uami.ps1`.

- Role definition ID: `f58310d9-a9f6-439a-9e8d-f62e7b41a168`
- Scope: target application resource group

The script remains idempotent by checking for an existing role assignment before creating it.

## Why this role

`Role Based Access Control Administrator` is the least-privilege fit here: it allows the deploy identity to create and delete role assignments within scope, but it is narrower than `User Access Administrator` and cannot grant `Owner` or `User Access Administrator`.

### 2026-07-22: Trinity: Graph scope check fix for raw access-token auth
**By:** Trinity
**Source:** `trinity-graph-scope-check-accesstoken-fix.md`

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

### 2026-07-22: Trinity: Dynamic Graph/VCS app role resolution by name
**By:** Trinity
**Source:** `trinity-vcs-role-id-fix.md`

- Date: 2026-07-22
- Area: PowerShell permission-grant automation / Entra service principals

## Decision

Stop hardcoding Microsoft Graph and Verified ID Request Service app-role GUIDs in `scripts/08-grant-app-uami-graph-permissions.ps1`. Store only the role value strings and resolve the current tenant's role IDs dynamically from the target resource service principal's `AppRoles` collection at runtime.

## Why

Live execution against the Spaid Family tenant proved the previously hardcoded Verified ID Request Service role IDs were stale/incorrect. The script requested the correct permission names, but it submitted GUIDs that did not exist on that tenant's `Verifiable Credentials Service Request` service principal, which produced a generic Graph `400 BadRequest` (`Permission being assigned was not found on application ...`).

Hardcoding these IDs is fragile even when it appears to work, because the real source of truth during assignment is the resource service principal present in the tenant being targeted. Resolving by `AppRoles.Value` makes failures deterministic and diagnosable.

## Implementation

- Changed both `$GRAPH_APP_ROLES` and `$VCS_REQUEST_APP_ROLES` to arrays of role-name strings only.
- Updated `Get-ResourceServicePrincipal` to fetch the resource service principal with `appRoles` included.
- Updated `Grant-AppRolesToPrincipal` to:
  - accept role names instead of `{ Id, Name }` objects
  - look up the live app-role object with `Where-Object { $_.Value -eq $roleName }`
  - use the resolved `Id` for duplicate detection and assignment
  - throw a clear error listing available roles when a requested role name is missing

## Live tenant reference

Verified ID Request Service (`appId 3db474b9-6a0c-4840-96ac-1fceb342124f`, display name `Verifiable Credentials Service Request`) exposed these role IDs when queried directly in the live tenant:

- `0165bd66-5f36-41ef-abde-4e8fc0c91294` → `VerifiableCredential.Create.IssueRequest`
- `410607a4-22de-48a8-b35d-ad33c0c2e1bf` → `VerifiableCredential.Create.PresentRequest`
- `949ebb93-18f8-41b4-b677-c2bfea940027` → `VerifiableCredential.Create.All`

These values are recorded here for debugging/reference only; the script should continue resolving IDs dynamically by role name rather than treating these GUIDs as durable constants.
