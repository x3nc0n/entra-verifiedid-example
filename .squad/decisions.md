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
