# Azure Deployment Plan

> **Status:** Approved for implementation and validation; cloud deployment and the conditional Power Pages bootstrap remain gated on the prerequisites below

Generated: 2026-09-09

---

## 1. Project Overview

**Goal:** Deploy the existing employee and guest onboarding application into the specified identity tenant and Azure subscription, with an optional Power Pages onboarding surface whose versioned configuration is delivered through GitHub Actions.

**Path:** Modify an existing Azure-enabled application.

**Planning boundary:** This document covers Phase 1 only. No resources, tenant settings, application registrations, policies, low-code environments, websites, DNS records, or deployment credentials may be created or changed until the plan is completed and approved.

### Confirmed target context

| Attribute | Value |
|-----------|-------|
| Tenant | The Spaid Family |
| Tenant ID | `3b14ce70-8bea-4d11-9e2c-6b4a04c8010d` |
| Operator | `johnspaid@nerdypotato.onmicrosoft.com` |
| Subscription | `Spaid Family Core Infra LZ` |
| Subscription ID | `7e1b60b8-d616-4396-9de2-fc917930d02e` |
| Subscription state | Enabled |
| Azure location | West US 2 (`westus2`) |
| Inherited policy | West Europe is blocked |

The local Azure CLI context matches the requested tenant, subscription, and operator. This was verified read-only; no cloud changes were made.

---

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | End-to-end proof of concept with live identity proofing |
| Runtime scale | Small baseline: 0.5 vCPU, 1 GiB, zero to two replicas |
| Budget posture | Cost-optimized baseline |
| Subscription | Confirmed above |
| Location | West US 2 |
| Data residency or compliance | Not supplied |
| Live identity verification | Required |
| Managed low-code portal | Conditionally in scope after a controlled one-time bootstrap; ongoing configuration must deploy through GitHub Actions |
| Public trusted domain | Not required if the proofing partner issues the presented credential; required only if this tenant also becomes an issuer |

### Approved proof-of-concept defaults

- The initial target remains a demo or proof of concept. The current application stores sessions and issuance/presentation callback state in process memory, so it is not production-safe across restarts or multiple replicas.
- Existing low-cost defaults are acceptable: Basic container registry, consumption-style container hosting, locally redundant storage, and scale-to-zero.
- A single region is acceptable.
- The deployment will use the existing GitHub Actions environments and repository-bound OIDC model.
- Resource group: `rg-entra-verifiedid-example`.
- Application prefix: `entra-vid`.
- Initial GitHub environment: `staging`.

### Policy constraints

- An inherited policy blocks West Europe.
- Other subscription policies were not identified in the read-only subscription query.
- West US 2 supports Container Apps and the required resource providers are registered.

---

## 3. Components Detected

| Component | Type | Technology | Path |
|-----------|------|------------|------|
| Portal UI and API | Server-rendered web application | Node.js 20, Express 4, EJS | `src/` |
| Identity request and approval | Workflow integration | HTTP API, signed webhook callback, simulated mode | `src/services/identitypass-service.js`, `src/routes/identitypass.js` |
| Credential issuance | API integration | Verified credential request service | `src/routes/issuance.js`, `src/services/verified-id-service.js` |
| Credential presentation | API integration | Verified credential request service | `src/routes/verification.js`, `src/services/verified-id-service.js` |
| Strong-auth registration | Browser and directory integration | WebAuthn/FIDO2 plus directory API | `src/routes/passkey.js`, `src/services/fido2-service.js`, `src/services/graph-service.js` |
| Container image | Runtime packaging | Node.js 20 Alpine, non-root user, port 3000 | `Dockerfile` |
| Infrastructure | Infrastructure as code | Bicep with ARM JSON evaluation fallback | `infra/main.bicep`, `infra/modules/`, `azuredeploy.json` |
| Infrastructure workflow | Delivery automation | Manual GitHub Actions workflow with what-if mode | `.github/workflows/deploy-infrastructure.yml` |
| Application workflow | Delivery automation | OIDC login, registry build, container rollout, health check | `.github/workflows/deploy.yml` |
| Tenant bootstrap | Administrative automation | PowerShell, Azure modules, directory modules | `scripts/01-*.ps1` through `scripts/08-*.ps1`, `scripts/bootstrap.ps1` |
| Managed portal | Planned separate frontend | Power Pages website configuration in a Dataverse environment | Not yet present; future source path must contain original project content only |

### Existing infrastructure

| Item | Status |
|------|--------|
| `azure.yaml` | Not present |
| Bicep | Present and is the primary infrastructure source |
| ARM template | Present as an evaluation-only fallback |
| Dockerfile | Present |
| GitHub Actions | Present for validation, infrastructure, and image rollout |
| Persistent application state | Not implemented; runtime state remains in memory |
| Application telemetry SDK | Not present; platform logging resources are provisioned |

### Specialized technology check

No hosted Copilot SDK, function-app, cross-cloud migration, durable workflow, or API gateway markers were found. The existing container deployment path remains appropriate.

---

## 4. Deployment Recipe

**Selected:** Direct Bicep plus the repository's existing Azure CLI/PowerShell and GitHub Actions flow.

**Rationale:**

- The repository already has a reviewed Bicep module layout and no `azure.yaml`.
- The infrastructure workflow already runs a resource-group what-if or apply against `infra/main.bicep`.
- The image workflow already builds in the private registry and updates the container application.
- Introducing a new deployment orchestrator would create unnecessary drift during a tenant move.
- `azuredeploy.json` must remain an evaluation-only route because it provisions a bootstrap container, not the real application image or repository OIDC trust.

---

## 5. Architecture

**Stack:** Containerized Node.js web application on Azure Container Apps.

### Service mapping

| Component | Azure service | Existing configuration |
|-----------|---------------|------------------------|
| Portal | Container App | External HTTPS ingress, port 3000, scale 0-2 |
| Container runtime boundary | Container Apps managed environment | Log workspace integration |
| Image storage and build | Container Registry | Basic SKU, admin credentials disabled |
| Runtime secrets | Key Vault | Standard SKU, RBAC enabled, purge protection enabled |
| Artifact storage | Storage account and private blob container | Standard locally redundant storage |
| Central logs | Log Analytics workspace | 30-day retention |
| Platform monitoring | Application Insights | Workspace-based |
| Cloud-resource access | System-assigned managed identity | Registry pull and Key Vault secret resolution |
| Directory and credential APIs | User-assigned managed identity | Dedicated runtime identity; app roles granted separately |
| CI/CD deployment | User-assigned managed identity with OIDC federation | Resource-group-scoped deployment identity |
| Managed portal frontend | Power Pages | Separate user experience backed by the existing Container App APIs |
| Managed portal ALM | Power Platform GitHub Actions and CLI | Upload versioned website configuration with a target deployment profile |

### Delivery chain

1. Deploy Bicep into a resource group. The first container revision is a public bootstrap placeholder.
2. Create or verify the repository-bound deployment identity and federated credentials.
3. Grant the container application's system identity registry pull access.
4. Grant the runtime user-assigned identity only the directory and credential-service application roles required by the app.
5. Build the real image in the private registry.
6. Configure registry identity and Key Vault-backed runtime secrets after the container app exists.
7. Update the container app to the immutable commit-tagged image.
8. Verify `GET /health` over HTTPS.
9. After the controlled Power Pages bootstrap is complete, deploy versioned website configuration through a protected GitHub Actions environment.
10. Verify the managed portal resolves at its approved URL and can reach only the approved Container App API origin.

### Identity boundary

- The system-assigned identity is for Azure resource access.
- The runtime user-assigned identity is for directory and credential-service API calls.
- The GitHub deployment identity is for infrastructure and application delivery.
- The Power Platform deployment service principal is a separate Dataverse application user for website-configuration deployment.
- Directory app-role consent is an explicit local administrator action and must not run in GitHub Actions.
- Do not reuse the Azure resource deployment identity for Dataverse deployment unless the platform explicitly supports that authentication path and the identity is separately configured as an application user.

### Tenant-level services

The following are not fully provisioned by the Bicep deployment and require separate, privileged setup after approval:

- Credential-service authority and contract.
- Public trusted-domain binding and directly reachable `/.well-known/did-configuration.json` with no redirect.
- Runtime identity application-role assignments.
- FIDO2 and temporary-access policy scope.
- Live identity-proofing endpoint, key, callback secret, and manager routing.

For advanced credential-service setup, the signing-key vault has a different permission-model requirement than the application's RBAC-enabled secret vault. Do not assume the application vault can also serve as the signing-key vault; confirm the tenant setup path and use a separate vault if required.

### Known implementation constraints

- `express-session` uses its default in-memory store.
- Issuance and presentation callbacks are held in in-memory maps.
- The storage account is provisioned but is not wired into application state.
- The current architecture is therefore appropriate only for demo/POC use until durable state is implemented.
- The storage module exposes a primary-key connection string as a deployment output. The Bicep linter flags this as a possible secret-bearing output; it must not be propagated, logged, or adopted as the application access model.
- `docs/architecture.md` still describes a legacy App Service/Cosmos shape. Use the Bicep, ARM template, workflows, and current README as deployment evidence instead.
- The tenant bootstrap script performs multiple cloud and directory mutations. It must not be used as a single unattended command before each mutation and scope are reviewed.
- The FIDO2/TAP script refuses implicit tenant-wide rollout unless an explicit override is passed. Dedicated onboarding groups are the safer default.
- The credential setup script requires a real trusted domain. A generated container hostname or managed portal hostname must not be assumed suitable until it can serve the exact well-known file over HTTPS without redirects.

### Required live onboarding sequence

The approved end-to-end proof-of-concept sequence is:

1. A pre-created tenant user receives a short-lived, user-specific onboarding link.
2. The identity-proofing partner verifies the person and issues a partner-backed Verified ID.
3. The portal requests presentation of that Verified ID.
4. The portal validates the presentation, matches its claims to the pre-created tenant user, and records the audit result.
5. The portal creates a Temporary Access Pass for that tenant user through the directory API.
6. The TAP is shown once through a protected handoff.
7. The user signs in with the TAP and registers a tenant passkey.
8. The portal confirms the tenant authentication method exists and marks onboarding complete.

This differs from the current application. The following corrections are mandatory before live deployment:

- Replace the placeholder identity-proofing `/requests` contract with an actual approved provider contract. The configured `https://identitypass.microsoft.com/api/v1` endpoint returns only a product label, and no public request, status, authentication, or callback contract was found. It must not be treated as a callable tenant service.
- Consume and verify a partner-issued credential instead of issuing a new employee credential before proofing.
- Add tenant-user matching and TAP creation.
- Retrieve passkey `creationOptions` from the directory API; do not generate an application-domain WebAuthn challenge and submit it as a tenant passkey.
- Complete passkey registration with the directory API and verify the created authentication method.
- Validate all credential-service callback authentication rather than accepting the current hard-coded callback header without server-side enforcement.
- Use least-privilege TAP and passkey application permissions for the runtime identity.
- Add a protected, one-time TAP display and avoid logging or persisting the TAP value.

---

## 6. Managed Portal CI/CD Feasibility

The current repository does **not** require a Power Apps, Power Pages, Dataverse, or other low-code environment. No repository dependency, deployment parameter, infrastructure resource, or script references one.

The managed portal is now conditionally in scope. It is feasible only as a distinct frontend whose source-controlled website configuration is deployed through GitHub Actions after a controlled one-time environment and site bootstrap.

### Feasibility conclusion

- Official Power Platform GitHub Actions support uploading Power Pages website configuration to a target Dataverse environment.
- The upload action accepts the environment URL, service-principal application ID, tenant ID, client secret, content path, deployment profile, and data-model version.
- Power Platform CLI supports listing, downloading, and uploading Power Pages website configuration.
- The current generally available CLI command reference does not document `pac pages create-site` or a read-only global website-address availability command. A release-plan entry describes future create/delete support, but the plan must not depend on a release-plan-only capability until it appears in the installed CLI and current command reference.
- Therefore, Actions can own repeatable website-content delivery, but the first Dataverse environment, website host, activation, and `powerappsportals.com` address require a controlled bootstrap through authorized administration tooling.
- The existing Express/EJS application cannot be uploaded to Power Pages as-is. The portal must be authored as a separate Power Pages frontend that calls the existing Container App APIs.

This satisfies the CI/CD requirement only if "deployed through GitHub Actions" means all versioned portal content and configuration after one approved bootstrap. If the requirement means zero manual environment, site-host, activation, and URL bootstrap, the portal is not approval-ready with the currently documented generally available tooling.

### Selected ALM model

- Use a dedicated non-default Power Platform environment with a Dataverse database.
- Use the enhanced website data model where available in both source and target environments.
- Create one blank or approved starter site during the controlled bootstrap.
- Store only original project website configuration under a future repository path such as `power-pages/site/`.
- Use deployment profiles for environment-specific API origins, website IDs, and non-secret settings.
- Use a protected GitHub environment and the official website upload action or an equivalent `pac pages upload` command.
- Keep Dataverse tables, schema, flows, connection references, and environment variables in a solution because website upload alone does not migrate schema.

### Safe `forgetfulpotato` availability workflow

The authoritative availability result comes from the Power Pages create-site or site-URL administration UI, not DNS and not `pac pages list`.

1. A future `power-pages-preflight` workflow is started with `workflow_dispatch` input `requested_subdomain=forgetfulpotato`.
2. The read-only job authenticates to the selected Dataverse environment, runs `pac pages list`, and confirms whether a project website already exists. This only inventories the environment; it does not prove global address availability.
3. The workflow stops at a protected GitHub environment named for portal bootstrap and requires an authorized administrator's approval.
4. The administrator opens the approved environment in Power Pages, starts creation of the selected blank or starter site, enters `forgetfulpotato` in the website-address field, and waits for the portal's availability validation.
5. If the address is available, the administrator records the accepted candidate in the workflow approval evidence. The administrator does not select **Done** until a separate provisioning approval is granted.
6. If the address is unavailable, the administrator cancels the wizard. The workflow ends with `fallback_required`; it must not append numbers, reserve another name, or choose a fallback automatically.
7. The user selects the next candidate and reruns `workflow_dispatch`. GitHub Actions environment approval and explicit dispatch inputs provide the prompt/decision boundary; an unattended job must not invent a fallback.
8. Only after explicit provisioning approval may the selected address be created. This planning task performs no availability probe, reservation, or provisioning.

Changing an existing site's base URL is not an availability test because applying the change restarts the site, releases the old address, and changes user access.

### Future GitHub Actions deployment design

The future deployment workflow is intentionally not created during this planning-only task. Its approved design is:

1. Trigger on reviewed changes under `power-pages/` and allow a manual dispatch.
2. Use a protected GitHub environment with required reviewers and deployment concurrency.
3. Authenticate with the dedicated Power Platform service principal and client secret stored as an environment secret.
4. Validate the target environment URL and website record with `pac pages list`.
5. Fail closed if the target website ID or approved site URL does not match the GitHub environment variables.
6. Scan the portal source path before upload and reject copied external business-process content, reference-site URLs, brand attribution, or unapproved assets. Technical platform identifiers required for deployment are not user-facing attribution.
7. Upload website configuration with the target deployment profile and enhanced data model.
8. Import any required managed solution before the website upload so Dataverse schema, flows, connection references, and environment variables already exist.
9. Sync or restart only through supported tooling when required, then verify the public URL and an application-specific health page.
10. Never create, rename, delete, or select a fallback website in the routine content-deployment workflow.

### GitHub Actions and Power Platform prerequisites

1. A dedicated non-default Power Platform environment with a Dataverse database, environment type, geography, base language, currency, security group, capacity, and licensing explicitly approved. West US 2 must not be assumed to map to the Power Platform geography.
2. An authorized Power Pages administrator or maker for the one-time site template, address, activation, visibility, and authentication bootstrap.
3. A dedicated app registration and service principal for CI/CD.
4. A Dataverse application user for that service principal in each target environment. The official setup path assigns the System Administrator role; any later least-privilege replacement must be proven to support website and solution deployment before reducing it.
5. GitHub environment variables for the Dataverse environment URL, approved website ID, approved site URL, deployment profile, and data-model version.
6. GitHub environment secrets for the Power Platform client ID, tenant ID, and client secret. Current official GitHub Actions authentication uses a client secret; repository secrets and personal-user credentials are not approved.
7. Power Pages authenticated-user or pay-as-you-go capacity appropriate for the test, plus Dataverse database capacity.
8. Exact authentication, CORS, API base URL, table-permission, web-role, and site-visibility decisions for the frontend-to-Container-App boundary.
9. An original portal content baseline authored for this project. No external business-process data, copied wording, screenshots, logos, personal data, or attribution may be committed.
10. A separately approved site bootstrap and address decision before any workflow can upload content.

---

## 7. Provisioning Limit Checklist

West US 2 service support and the applicable regional quotas were checked read-only.

| Resource type | Number to deploy | Total after deployment | Limit / quota | Result and source |
|---------------|------------------|------------------------|---------------|-------------------|
| Container Apps managed environment | 1 | 1 | 20 | Within quota; `az quota` reports current usage 0 in West US 2 |
| Container App | 1 | 1 | Within the managed environment | The initial maximum replica count is 2; no subscription count blocker applies at this scale |
| Container Registry | 1 | 1 | SKU limits apply | No existing registry was found in West US 2; Basic provides 10 GiB included storage and supports the planned single repository |
| Key Vault | 1 application vault | 1 | No vault-count quota documented | Service transaction limits are not material at proof-of-concept scale |
| Storage account | 1 | 3 | 250 per region by default | Two existing standard-endpoint accounts plus one planned account are within the West US 2 limit |
| Log Analytics workspace | 1 | 1 planned | No workspace-count limit for the selected tier | Limited by generic subscription/resource-group limits |
| Application Insights component | 1 | 1 planned | No count blocker identified | Workspace-based component; configure cost controls before production |
| User-assigned managed identity | 1 runtime identity | 1 planned | 80 create operations per 20 seconds per subscription/region | One creation is within the documented rate limit |
| Deployment user-assigned identity | 1 | 1 planned | Same managed identity rate limit | Resource group and deployment identity do not currently exist |
| Role assignments | At least 2 in Bicep, plus deployment/bootstrap assignments | Planned set only | Subscription/RG authorization limits not approached | Operator permission still must allow role-assignment writes |
| Power Platform environment and Power Pages site | 1 environment and 1 site | Unknown until bootstrap | Separate licensing, Dataverse, and Power Pages capacity | Not an Azure regional quota; requires explicit geography, capacity, license, and site-address approval |

**Quota status:** Within documented limits. A successful what-if does not guarantee transient Container Apps capacity, so actual provisioning still needs normal capacity-error recovery.

---

## 8. Required Inputs Before Live End-to-End Testing

1. **Identity-proofing provider contract:** select a generally available identity-verification provider that can issue or support issuance of the credential, then provide the real endpoint, authentication method, request/response schema, callback-signing rules, and test credentials through an approved secret channel. The repository's default IdentityPass URL is not an actionable API contract.
2. **Test tenant user:** provide an existing non-production user UPN whose HR/proofing claims can be matched. The account must be pre-created before the flow starts.
3. **TAP/FIDO2 pilot scope:** provide or approve creation of a dedicated pilot group containing only the test user.
4. **Administrative operators:** confirm access to an Authentication Policy Administrator for policy changes and an Authentication Administrator or equivalent application-permission grant path for TAP/passkey operations.
5. **TAP policy:** use one-time, 60-minute TAP for the first test unless the test includes device enrollment likely to exceed the ten-minute post-sign-in authentication-method registration window.
6. **Claim matching:** define the minimum exact-match claims used to bind the presented credential to the tenant user.
7. **Public URL:** use the generated Container App hostname for the proof-of-concept unless the identity-proofing provider requires a pre-registered custom callback domain.
8. **Credential issuer decision:** confirm that the proofing partner issues the credential. If this tenant must issue its own credential, a trusted domain and signing-key setup become required.
9. **Power Platform environment:** provide or approve the environment type, Power Platform geography, base language, currency, security group, Dataverse database, capacity, and licensing.
10. **Power Pages bootstrap:** approve the site template, enhanced data model, authentication mode, site visibility, and one-time authorized address check for `forgetfulpotato`.
11. **Portal CI/CD identity:** approve a dedicated app registration, Dataverse application user, GitHub environment, and client-secret lifecycle.
12. **Frontend integration:** define the exact APIs exposed by the Container App, allowed portal origin, authentication token flow, table permissions, and web roles.

---

## 9. Execution Checklist

### Phase 1: Planning

- [x] Create the deployment-plan artifact
- [x] Analyze the workspace
- [x] Scan application, infrastructure, package, workflow, and bootstrap files
- [x] Confirm tenant and subscription context read-only
- [x] Identify inherited region restriction
- [x] Select the existing Bicep and container delivery recipe
- [x] Inventory resources
- [x] Assess optional managed portal applicability
- [x] Confirm managed portal is conditionally in scope only with GitHub Actions ALM
- [x] Design the non-mutating address-check and explicit fallback decision boundary
- [x] Document Power Pages CI/CD feasibility and prerequisites
- [x] Receive region, proof-of-concept, live-flow, and portal-scope decisions
- [x] Validate regional quotas and documented limits
- [x] Complete deployment architecture decisions
- [x] Receive approval to proceed with implementation and validation

### Phase 2: Implementation and validation

- [x] Research and confirm service-specific requirements for the selected region
- [ ] Correct the live identity-proofing, TAP, and tenant-passkey flow
- [ ] Add focused tests for the corrected flow
- [ ] Obtain the live provider contract and test credentials
- [ ] Approve the Power Platform environment, capacity, licensing, and site bootstrap inputs
- [ ] Author original Power Pages frontend content and its deployment profile
- [ ] Add the protected Power Pages preflight and deployment workflows
- [ ] Run the authorized `forgetfulpotato` availability check without provisioning
- [ ] Receive explicit approval before creating the Power Pages site
- [ ] Run `azure-validate`
- [ ] Run infrastructure what-if
- [ ] Provision approved infrastructure
- [ ] Perform separately approved tenant and directory changes
- [ ] Configure repository environments and OIDC
- [ ] Publish the real application image
- [ ] Configure final callback, origin, and relying-party values
- [ ] Verify health and end-to-end onboarding

---

## 10. Validation Proof

Not applicable during Phase 1. This section must be populated by `azure-validate` after plan approval and before deployment.

---

## 11. Files

| File | Purpose | Status |
|------|---------|--------|
| `.azure/deployment-plan.md` | Deployment source of truth | Approved; implementation gates documented |
| `infra/main.bicep` | Existing infrastructure source | No change planned |
| `azuredeploy.json` | Existing evaluation-only fallback | No change planned |
| `.github/workflows/deploy-infrastructure.yml` | Existing what-if/apply workflow | No change planned |
| `.github/workflows/deploy.yml` | Existing image delivery workflow | No change planned |
| `.github/workflows/power-pages-preflight.yml` | Future non-mutating environment inventory and human address-check gate | Planned; not created |
| `.github/workflows/power-pages-deploy.yml` | Future protected Power Pages website-configuration deployment | Planned; not created |
| `power-pages/site/` | Future original portal source and deployment profiles | Planned; no external reference content may be copied |

---

## 12. Evidence

| Finding | Repository evidence |
|---------|---------------------|
| Container Apps is the deployment target | `infra/main.bicep`, `infra/modules/container-app.bicep`, `.squad/decisions.md` |
| Private registry with managed-identity pull | `infra/modules/container-registry.bicep`, `.github/workflows/deploy.yml`, `scripts/07-bootstrap-github-actions-uami.ps1` |
| Real image arrives after infrastructure | `README.md`, `azuredeploy.json`, `.github/workflows/deploy.yml` |
| Runtime and deployment identities are separate | `infra/modules/user-assigned-identity.bicep`, `scripts/07-bootstrap-github-actions-uami.ps1`, `scripts/08-grant-app-uami-graph-permissions.ps1` |
| Current state is in memory | `src/app.js`, `src/routes/issuance.js`, `src/routes/verification.js` |
| Managed portal is a separate frontend | No existing dependency, parameter, resource, workflow, or portal source is present in the repository |
| Power Pages website configuration supports GitHub Actions delivery | Official ALM documentation lists website upload actions, deployment profiles, and CLI upload/list/download commands |
| Initial site URL remains a controlled bootstrap | The current generally available CLI reference lacks a documented create-site or read-only global URL availability command |
| Node.js runtime contract | `package.json`, `package-lock.json`, `Dockerfile`, `src/config.js` |

---

## 13. Next Step

Approve the Power Platform environment and bootstrap prerequisites, then implement the live onboarding corrections and original portal frontend. After the future protected workflows and content are ready, update this plan to `Ready for Validation` and invoke `azure-validate` before any deployment.
