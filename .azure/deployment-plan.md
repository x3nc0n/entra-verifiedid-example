# Azure Deployment Plan

> **Status:** Approved for implementation and validation; cloud deployment is gated on the live-flow corrections below

Generated: 2026-09-09

---

## 1. Project Overview

**Goal:** Deploy the existing employee and guest onboarding portal into the specified identity tenant and Azure subscription without changing the application's established delivery architecture.

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
| Managed low-code portal | Out of scope for this deployment |
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

### Delivery chain

1. Deploy Bicep into a resource group. The first container revision is a public bootstrap placeholder.
2. Create or verify the repository-bound deployment identity and federated credentials.
3. Grant the container application's system identity registry pull access.
4. Grant the runtime user-assigned identity only the directory and credential-service application roles required by the app.
5. Build the real image in the private registry.
6. Configure registry identity and Key Vault-backed runtime secrets after the container app exists.
7. Update the container app to the immutable commit-tagged image.
8. Verify `GET /health` over HTTPS.

### Identity boundary

- The system-assigned identity is for Azure resource access.
- The runtime user-assigned identity is for directory and credential-service API calls.
- The GitHub deployment identity is for infrastructure and application delivery.
- Directory app-role consent is an explicit local administrator action and must not run in GitHub Actions.

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

- Replace the placeholder identity-proofing `/requests` contract with the actual approved provider contract.
- Consume and verify a partner-issued credential instead of issuing a new employee credential before proofing.
- Add tenant-user matching and TAP creation.
- Retrieve passkey `creationOptions` from the directory API; do not generate an application-domain WebAuthn challenge and submit it as a tenant passkey.
- Complete passkey registration with the directory API and verify the created authentication method.
- Validate all credential-service callback authentication rather than accepting the current hard-coded callback header without server-side enforcement.
- Use least-privilege TAP and passkey application permissions for the runtime identity.
- Add a protected, one-time TAP display and avoid logging or persisting the TAP value.

---

## 6. Deferred Managed Portal Assessment

The current repository does **not** require a Power Apps, Power Pages, Dataverse, or other low-code environment. No repository dependency, deployment parameter, infrastructure resource, or script references one.

The requested `forgetfulpotato` name and the separate managed portal are explicitly deferred.

### If a separate managed portal is desired

A comparable guided onboarding experience should be treated as a distinct product surface with an ordered checklist covering:

1. Initial credential or invitation retrieval.
2. Identity request and approval.
3. Strong-authentication enrollment.
4. Workstation or virtual-desktop setup.
5. Mobile-device setup.
6. Handoff to additional onboarding resources.
7. Optional password setup where policy permits.

The existing Node.js portal currently covers items 2 and 3, plus credential issuance and presentation. It does not implement device setup, mobile setup, or a broader onboarding-resource hub.

Adding a managed portal would require a separate design decision for:

- A dedicated non-default low-code environment.
- Dataverse capacity and environment licensing.
- Environment region and type.
- Security group and authenticated/anonymous page boundaries.
- Data ownership, retention, and table permissions.
- Integration pattern with the existing Node.js API.
- A site web address and, for production, a custom domain.

### Safe subdomain availability check

First clarify whether `forgetfulpotato` means:

- the low-code **environment organization URL**, or
- the managed **website address**.

These are different names and are validated in different creation flows.

For a website address, the safe check is:

1. Sign in with an authorized maker or administrator.
2. Select the intended dedicated environment.
3. Start the create-site wizard and select a blank or starter layout.
4. Enter `forgetfulpotato` in the web-address field and let the wizard validate it.
5. Record only whether the name is accepted.
6. Cancel before selecting **Done** so no site is provisioned.

For an environment organization URL, start the new-environment flow, enter the proposed organization URL, let the admin center validate uniqueness, and cancel before **Save**.

Do not infer availability from DNS. Names can be reserved, recently released names can remain unavailable for at least 24 hours, and availability can depend on the selected environment and datacenter.

Changing an existing environment URL is not an availability-testing mechanism: saving a change can disrupt flows, connections, embedded apps, bookmarks, and user access.

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

**Quota status:** Within documented limits. A successful what-if does not guarantee transient Container Apps capacity, so actual provisioning still needs normal capacity-error recovery.

---

## 8. Required Inputs Before Live End-to-End Testing

1. **Identity-proofing provider contract:** provide the real endpoint, authentication method, request/response schema, callback-signing rules, and test credentials through an approved secret channel.
2. **Test tenant user:** provide an existing non-production user UPN whose HR/proofing claims can be matched. The account must be pre-created before the flow starts.
3. **TAP/FIDO2 pilot scope:** provide or approve creation of a dedicated pilot group containing only the test user.
4. **Administrative operators:** confirm access to an Authentication Policy Administrator for policy changes and an Authentication Administrator or equivalent application-permission grant path for TAP/passkey operations.
5. **TAP policy:** use one-time, 60-minute TAP for the first test unless the test includes device enrollment likely to exceed the ten-minute post-sign-in authentication-method registration window.
6. **Claim matching:** define the minimum exact-match claims used to bind the presented credential to the tenant user.
7. **Public URL:** use the generated Container App hostname for the proof-of-concept unless the identity-proofing provider requires a pre-registered custom callback domain.
8. **Credential issuer decision:** confirm that the proofing partner issues the credential. If this tenant must issue its own credential, a trusted domain and signing-key setup become required.

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
- [x] Receive region, proof-of-concept, live-flow, and portal-scope decisions
- [x] Validate regional quotas and documented limits
- [x] Complete deployment architecture decisions
- [x] Receive approval to proceed with implementation and validation

### Phase 2: Implementation and validation

- [x] Research and confirm service-specific requirements for the selected region
- [ ] Correct the live identity-proofing, TAP, and tenant-passkey flow
- [ ] Add focused tests for the corrected flow
- [ ] Obtain the live provider contract and test credentials
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

---

## 12. Evidence

| Finding | Repository evidence |
|---------|---------------------|
| Container Apps is the deployment target | `infra/main.bicep`, `infra/modules/container-app.bicep`, `.squad/decisions.md` |
| Private registry with managed-identity pull | `infra/modules/container-registry.bicep`, `.github/workflows/deploy.yml`, `scripts/07-bootstrap-github-actions-uami.ps1` |
| Real image arrives after infrastructure | `README.md`, `azuredeploy.json`, `.github/workflows/deploy.yml` |
| Runtime and deployment identities are separate | `infra/modules/user-assigned-identity.bicep`, `scripts/07-bootstrap-github-actions-uami.ps1`, `scripts/08-grant-app-uami-graph-permissions.ps1` |
| Current state is in memory | `src/app.js`, `src/routes/issuance.js`, `src/routes/verification.js` |
| Low-code portal is not a deployment dependency | No matching dependency, parameter, resource, workflow, or script in the repository |
| Node.js runtime contract | `package.json`, `package-lock.json`, `Dockerfile`, `src/config.js` |

---

## 13. Next Step

Correct and validate the live onboarding flow, obtain the provider contract and test user, then invoke `azure-validate` before any deployment.
