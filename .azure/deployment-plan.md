# Azure Deployment Plan

> **Status:** Deployed — application infrastructure and the real portal image are live in `rg-entra-verifiedid-example` (see Sections 14 and 16). The approved pilot user is assigned, manual invitation triggering/delivery is approved, and the runtime UAMI has the exact three required Microsoft Graph application roles. TAP and FIDO2 tenant policy are already enabled tenant-wide and require no mutation. Section 17 defines the approved v2 self-service Verified ID architecture; it is design-only and no v2 tenant or Azure mutation has occurred.

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

The local Azure CLI context matches the requested tenant, subscription, and operator. After explicit approval, the resource group and dedicated empty pilot security group recorded below were created. No application infrastructure, tenant policy, group membership, Power Platform resource, or Power Pages resource was created.

---

## 2. Requirements

| Attribute | Value |
|-----------|-------|
| Classification | End-to-end pilot with manager-approved invitations to known users |
| Runtime scale | Small baseline: 0.5 vCPU, 1 GiB, zero to two replicas |
| Budget posture | Cost-optimized baseline |
| Subscription | Confirmed above |
| Location | West US 2 |
| Data residency or compliance | Not supplied |
| Pilot identity gate | Manager approval plus a one-time invitation sent to the known personal email of a pre-created tenant user |
| Managed low-code portal | Conditionally in scope after a controlled one-time bootstrap; ongoing configuration must deploy through GitHub Actions |
| Verified credential integration | Future extension; not a pilot deployment gate |
| Public trusted domain | Not required for the invitation pilot; required only if a future credential issuer is added |

### Approved proof-of-concept defaults

- The initial target remains a demo or proof of concept. Invitation and Express session state are now Azure Table-backed; the future Verified ID callback state remains process-local and is production-blocked.
- Existing low-cost defaults are acceptable: Basic container registry, consumption-style container hosting, locally redundant storage, and scale-to-zero.
- A single region is acceptable.
- The deployment will use the existing GitHub Actions environments and repository-bound OIDC model.
- Resource group: `rg-entra-verifiedid-example`.
- Pilot security group: `sg-entra-verifiedid-pilot` (`6619d891-1a00-4a4b-aace-b6850a10985f`).
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
| Legacy identity request and approval | Placeholder workflow integration | HTTP API, signed webhook callback, simulated mode | `src/services/identitypass-service.js`, `src/routes/identitypass.js` |
| Pilot invitation approval | Planned backend workflow | Manager authorization, immutable user binding, opaque one-time token | Not yet implemented |
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
| Invitation state | Storage account table service | Planned durable records with atomic one-time redemption and managed-identity access |
| Central logs | Log Analytics workspace | 30-day retention |
| Platform monitoring | Application Insights | Workspace-based |
| Cloud-resource access | System-assigned managed identity | Registry pull and Key Vault secret resolution |
| Directory APIs and future credential APIs | User-assigned managed identity | Dedicated runtime identity; app roles granted separately |
| CI/CD deployment | User-assigned managed identity with OIDC federation | Resource-group-scoped deployment identity |
| Managed portal frontend | Power Pages | Separate user experience backed by the existing Container App APIs |
| Managed portal ALM | Power Platform GitHub Actions and CLI | Upload versioned website configuration with a target deployment profile |

### Delivery chain

1. Deploy Bicep into a resource group. The first container revision is a public bootstrap placeholder.
2. Create or verify the repository-bound deployment identity and federated credentials.
3. Grant the container application's system identity registry pull access.
4. Grant the runtime user-assigned identity only the directory application roles required for the pilot. Credential-service roles remain disabled unless the future extension is approved.
5. Build the real image in the private registry.
6. Configure registry identity and Key Vault-backed runtime secrets after the container app exists.
7. Update the container app to the immutable commit-tagged image.
8. Verify `GET /health` over HTTPS.
9. After the controlled Power Pages bootstrap is complete, deploy versioned website configuration through a protected GitHub Actions environment.
10. Verify the managed portal resolves at its approved URL and can reach only the approved Container App API origin.

### Identity boundary

- The system-assigned identity is for Azure resource access.
- The runtime user-assigned identity is for directory API calls and, only if later approved, credential-service API calls.
- The GitHub deployment identity is for infrastructure and application delivery.
- The Power Platform deployment service principal is a separate Dataverse application user for website-configuration deployment.
- Directory app-role consent is an explicit local administrator action and must not run in GitHub Actions.
- Do not reuse the Azure resource deployment identity for Dataverse deployment unless the platform explicitly supports that authentication path and the identity is separately configured as an application user.

### Tenant-level services

The following are not fully provisioned by the Bicep deployment and require separate, privileged setup after approval:

- Runtime identity directory application-role assignments.
- Manager approver scope and pilot-user group.
- Invitation delivery sender and personal-email handling policy.

Credential-service authority, contract, trusted-domain binding, and any signing-key vault are deferred future-extension requirements. If that extension is approved later, do not assume the application's RBAC-enabled secret vault can also serve as the signing-key vault.

### Current authentication-method policy

The user's live Microsoft Entra admin-center policy view on 2026-09-10 is the
authoritative current-state evidence:

| Method | State | Target | Restrictions | Pilot impact |
|--------|-------|--------|--------------|--------------|
| Temporary Access Pass | **Enabled** | **All users** | No additional target restriction shown | `sg-entra-verifiedid-pilot` is included through the `all_users` target |
| Passkey (FIDO2) | **Enabled** | **All users** | Attestation enforced; no AAGUID/key-model restriction is enforced | `sg-entra-verifiedid-pilot` is included through the `all_users` target |

No authentication-method policy mutation is needed for the current pilot. A
prior read through the Entra admin center's internal backend returned numeric
TAP state `0`, which was interpreted as disabled. That result conflicts with
the user's live authenticated admin-center screenshot showing TAP as **Yes**.
The discrepancy is retained here for auditability, but the live admin-center
view overrides that stale or ambiguous backend result.

The same screenshot shows the **Verified ID authentication method** as disabled.
That policy entry is distinct from the Microsoft Entra Verified ID service,
decentralized-identity authority, credential issuance, and credential
presentation work contemplated by the future v2 design. It does not block TAP
or FIDO2 for the current pilot.

### Known implementation constraints

- Invitation records and Express sessions use separate Azure Tables.
- Invitation consumption uses ETag compare-and-set semantics across replicas.
- The storage connection-string output has been removed; the runtime uses the UAMI and the Table service HTTPS endpoint.
- The runtime UAMI receives `Storage Table Data Contributor` separately at the invitation and session table scopes.
- Verified ID presentation callbacks remain process-local, so production startup blocks `ASSURANCE_MODE=verified-id`.
- `docs/architecture.md` still describes a legacy App Service/Cosmos shape. Use the Bicep, ARM template, workflows, and current README as deployment evidence instead.
- The tenant bootstrap script performs multiple cloud and directory mutations. It must not be used as a single unattended command before each mutation and scope are reviewed.
- The FIDO2/TAP script refuses implicit tenant-wide rollout unless an explicit override is passed. The tenant is already enabled for all users, so the script must not be run merely to "fix" the current pilot policy. Any later narrowing to a dedicated group is a separate hardening change requiring approval.
- The credential setup script requires a real trusted domain. A generated container hostname or managed portal hostname must not be assumed suitable until it can serve the exact well-known file over HTTPS without redirects.

### Required pilot onboarding sequence

The approved end-to-end proof-of-concept sequence is:

1. A tenant user account is pre-created and placed in the dedicated pilot group.
2. An authorized manager selects that exact directory user and confirms the known personal email delivery address.
3. The backend creates an invitation record whose tenant ID and user object ID are immutable. The personal email is a delivery attribute, never the lookup key used during redemption; if retained, it is encrypted at rest and removed when no longer required.
4. Only after manager approval, the backend generates an opaque token with at least 256 bits of cryptographic randomness, stores only its SHA-256 digest, assigns a short expiration, and sends the one-time link to the approved personal email.
5. The one-time link carries the token in the URL fragment. The Power Pages frontend posts it directly to the Container App over HTTPS, immediately clears the fragment, and does not write the token to Dataverse, analytics, telemetry, page content, local storage, or session storage.
6. The backend atomically consumes the token, rejects replay or expiry, reloads the bound user by immutable object ID, and confirms the account remains enabled and in the pilot group.
7. The backend creates a one-time Temporary Access Pass for that bound tenant user through the directory API.
8. The TAP is returned once with no-store headers and rendered transiently. It is never written to Power Pages or Dataverse data, logs, analytics, telemetry, durable invitation records, or callback payloads.
9. The user signs in with the TAP and registers a tenant passkey.
10. The backend confirms the tenant authentication method exists and records only non-secret completion and audit metadata.

This differs from the current application. The following corrections are mandatory before live deployment:

- Replace the self-service onboarding form and placeholder external approval request with an authenticated manager-only invitation workflow.
- Bind every invitation to the pre-created user's tenant ID and immutable directory object ID before generating a token. Redemption must never resolve a user from submitted email, employee ID, UPN, or credential claims.
- Generate opaque tokens with at least 256 bits of cryptographic randomness, store only a SHA-256 digest, set a short configurable lifetime, and consume them once through an atomic compare-and-set operation.
- Add rate limiting, generic redemption failures, replay protection, audit events, and redaction for invitation paths and request bodies.
- Add TAP creation only after successful invitation redemption and pilot-group revalidation.
- Retrieve passkey `creationOptions` from the directory API; do not generate an application-domain WebAuthn challenge and submit it as a tenant passkey.
- Complete passkey registration with the directory API and verify the created authentication method.
- Use least-privilege TAP and passkey application permissions for the runtime identity.
- Add a protected, one-time TAP display and avoid logging or persisting the TAP value.
- Leave the currently enabled tenant-wide TAP and FIDO2 policies unchanged for the pilot. Because both target all users, the pilot group is already covered; any future scope narrowing is optional hardening and requires separate approval.
- Keep the existing credential issuance, presentation, and callback code disabled behind a future-extension flag. If re-enabled later, callback authentication and payload minimization require a separate review.

### Future Verified ID extension

Third-party identity verification and credential presentation remain a future extension, not a pilot prerequisite. The extension may insert a credential-presentation check between invitation redemption and TAP creation, but it must preserve the immutable pre-created user binding. A presented credential can corroborate the invitation; it must not select or replace the bound tenant user.

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
- Keep invitation secrets, personal-email values, TAP values, credential callbacks, and callback payloads out of portal configuration and Dataverse tables. The Container App owns the invitation, TAP, passkey, and future credential workflows.
- Use Power Pages only for the manager/user experience and transient API rendering. Portal persistence is limited to non-secret site configuration and explicitly approved non-sensitive status data.

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
9. Reject portal source or solution changes that add columns, logging, analytics, flows, or connection mappings for invitation tokens, token digests, personal email, TAP values, or callback bodies.
10. Sync or restart only through supported tooling when required, then verify the public URL and an application-specific health page.
11. Never create, rename, delete, or select a fallback website in the routine content-deployment workflow.

### GitHub Actions and Power Platform prerequisites

1. A dedicated non-default Power Platform environment with a Dataverse database, environment type, geography, base language, currency, security group, capacity, and licensing explicitly approved. West US 2 must not be assumed to map to the Power Platform geography.
2. An authorized Power Pages administrator or maker for the one-time site template, address, activation, visibility, and authentication bootstrap.
3. A dedicated app registration and service principal for CI/CD.
4. A Dataverse application user for that service principal in each target environment. The official setup path assigns the System Administrator role; any later least-privilege replacement must be proven to support website and solution deployment before reducing it.
5. GitHub environment variables for the Dataverse environment URL, approved website ID, approved site URL, deployment profile, and data-model version.
6. GitHub environment secrets for the Power Platform client ID, tenant ID, and client secret. Current official GitHub Actions authentication uses a client secret; repository secrets and personal-user credentials are not approved.
7. Power Pages authenticated-user or pay-as-you-go capacity appropriate for the test, plus Dataverse database capacity.
8. Exact authentication, CORS, API base URL, manager web-role, user invitation page, table-permission, and site-visibility decisions for the frontend-to-Container-App boundary.
9. An original portal content baseline authored for this project. No external business-process data, copied wording, screenshots, logos, personal data, or attribution may be committed.
10. A separately approved site bootstrap and address decision before any workflow can upload content.
11. A portal data classification that explicitly prohibits invitation tokens, token digests, personal email, TAP values, and credential callback bodies in Dataverse, flows, analytics, or portal telemetry.

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
| Deployment user-assigned identity | 1 | 1 planned | Same managed identity rate limit | Resource group exists in West US 2; deployment identity does not yet exist |
| Role assignments | At least 2 in Bicep, plus deployment/bootstrap assignments | Planned set only | Subscription/RG authorization limits not approached | Operator permission still must allow role-assignment writes |
| Power Platform environment and Power Pages site | 1 environment and 1 site | Unknown until bootstrap | Separate licensing, Dataverse, and Power Pages capacity | Not an Azure regional quota; requires explicit geography, capacity, license, and site-address approval |

**Quota status:** Within documented limits. A successful what-if does not guarantee transient Container Apps capacity, so actual provisioning still needs normal capacity-error recovery.

---

## 8. Required Inputs Before Live End-to-End Testing

1. **Pilot tenant user:** provide the pre-created non-production user's tenant ID, immutable directory object ID, display UPN, and known personal email delivery address.
2. **Manager approvers:** provide a dedicated manager-approver group or explicit approver object IDs. Only authenticated members of this scope may approve and issue invitations.
3. **Pilot policy group:** `sg-entra-verifiedid-pilot` exists with object ID `6619d891-1a00-4a4b-aace-b6850a10985f` and currently has no members. Add only the approved pilot user before targeting TAP and FIDO2 policies; tenant-wide targeting is not approved.
4. **Invitation policy:** approve the short token lifetime, maximum outstanding invitations per user, resend/reissue behavior, approval expiry, and failure-lockout thresholds.
5. **Invitation delivery:** select an approved outbound email service and sender identity for delivery to personal email. The current repository has no real email-delivery implementation.
6. **Administrative operators:** confirm access to configure group-scoped authentication policies and grant the runtime application's TAP/passkey permissions.
7. **TAP policy:** use a one-time TAP with an approved lifetime for the pilot and define the reissue path if the first TAP expires or is lost.
8. **Passkey experience:** confirm whether the user registers through the tenant security-information experience or an application-embedded flow using directory-provided creation options.
9. **Power Platform environment:** provide or approve the environment type, Power Platform geography, base language, currency, security group, Dataverse database, capacity, and licensing.
10. **Power Pages bootstrap:** approve the site template, enhanced data model, authentication mode, site visibility, and one-time authorized address check for `forgetfulpotato`.
11. **Portal CI/CD identity:** approve a dedicated app registration, Dataverse application user, GitHub environment, and client-secret lifecycle.
12. **Frontend integration:** define the manager and invitee authentication flows, exact Container App APIs, allowed portal origin, web roles, table permissions, and non-sensitive status data.
13. **Future Verified ID extension:** keep credential issuance, presentation, and callbacks disabled for the pilot. Provider selection, trusted domain, credential contract, and callback authentication are deferred to a separately approved phase.

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
- [x] Replace the third-party proofing gate with manager-approved one-time invitations
- [x] Define immutable user binding, opaque-token, portal-data, and group-scope requirements
- [x] Receive region, proof-of-concept, live-flow, and portal-scope decisions
- [x] Validate regional quotas and documented limits
- [x] Complete deployment architecture decisions
- [x] Receive approval to proceed with implementation and validation

### Phase 2: Implementation and validation

- [x] Research and confirm service-specific requirements for the selected region
- [x] Replace the placeholder identity-proofing flow with authenticated manager invitation approval
- [x] Implement durable invitation records and atomic one-time token redemption
- [x] Add invitation/session tables and runtime table-data RBAC; remove the secret-bearing storage connection-string output
- [ ] Add approved personal-email delivery and secret-safe observability
- [x] Bind redemption to the pre-created user's tenant and immutable object ID
- [x] Add group-scoped TAP creation and tenant-passkey registration
- [x] Add focused tests for the corrected flow
- [x] Disable credential issuance, presentation, and callbacks behind a future-extension production gate
- [ ] Approve the Power Platform environment, capacity, licensing, and site bootstrap inputs
- [ ] Author original Power Pages frontend content and its deployment profile
- [ ] Add the protected Power Pages preflight and deployment workflows
- [ ] Run the authorized `forgetfulpotato` availability check without provisioning
- [ ] Receive explicit approval before creating the Power Pages site
- [x] Create the approved resource group in West US 2
- [x] Create the approved dedicated empty pilot security group
- [x] Run `azure-validate`
  - [x] Confirm Azure CLI authentication, subscription, tenant, and operator
  - [x] Compile and lint the Bicep source
  - [x] Run the Node.js test, parse, package, and dependency checks
  - [x] Run resource-group template validation
  - [x] Run the non-mutating resource-group what-if
  - [x] Review applicable Azure Policy assignments
  - [x] Perform static least-privilege RBAC review
  - [x] Validate the Docker build context statically; local Docker daemon availability is a known non-blocking workstation limitation
- [x] Run infrastructure what-if
- [x] Provision approved infrastructure
- [x] Add the approved pilot user to the dedicated pilot group
- [ ] Perform separately approved group-scoped TAP/FIDO2 tenant policy changes
- [x] Configure repository environments and OIDC
- [x] Publish the real application image
- [x] Configure final application base URL, origin, and relying-party values
- [x] Verify application health and API-key enforcement
- [ ] Verify end-to-end onboarding after the group-scoped TAP/FIDO2 policy is approved and configured

---

## 10. Validation Proof

Local and Azure control-plane preflight validation completed on 2026-09-09:

| Validation | Result |
|------------|--------|
| Approved resource group | `rg-entra-verifiedid-example` created successfully in `westus2`; resource ID `/subscriptions/7e1b60b8-d616-4396-9de2-fc917930d02e/resourceGroups/rg-entra-verifiedid-example`; the group contains no Azure resources |
| Approved pilot group | `sg-entra-verifiedid-pilot` created successfully as a mail-disabled, security-enabled Entra group; object ID `6619d891-1a00-4a4b-aace-b6850a10985f`; membership is empty |
| Authentication | Azure CLI resolved subscription `7e1b60b8-d616-4396-9de2-fc917930d02e`, tenant `3b14ce70-8bea-4d11-9e2c-6b4a04c8010d`, and operator `JohnSpaid@nerdypotato.onmicrosoft.com` |
| `npm test` | 21/21 tests passed, including fragment activation, token-free route contracts, concurrent one-time redemption, pre-TAP pilot revalidation, durable sessions, fail-closed startup, Graph role contracts, and infrastructure contracts |
| `node --check` | All 19 application and test JavaScript files parsed successfully |
| Package validation | `npm pack --dry-run --json` succeeded with 238 package entries; `npm audit --audit-level=high` reported 0 vulnerabilities |
| `az bicep build --file infra/main.bicep --stdout` | Compiled successfully; only the two pre-existing unused compatibility-parameter warnings remain |
| `az bicep lint --file infra/main.bicep` | Succeeded with the same two non-blocking unused compatibility-parameter warnings |
| ARM and script parsing | `azuredeploy.json` parsed as JSON; changed PowerShell scripts parsed successfully |
| Template validation | `az deployment group validate` returned `provisioningState: Succeeded` and `error: null` |
| What-if | Returned `status: Succeeded` and `error: null`; 13 resources are proposed for creation, with no modifications or deletions. Four role assignments are reported as `Unsupported` because their principal IDs are deployment-time outputs; their definitions were verified statically. The existing duplicate-Key-Vault-module diagnostic remains a warning, not an apply or policy failure |
| Azure Policy | `az policy assignment list` returned no applicable assignments visible at subscription scope; the West US 2 template validation and what-if both succeeded |
| RBAC inspection | Runtime UAMI receives `Storage Table Data Contributor` separately at the invitation and session table scopes. The Container App system identity receives `AcrPull` at the registry scope and `Key Vault Secrets User` at the vault scope. No subscription- or resource-group-wide application data role is declared |
| Local smoke test | Demo-mode `/health` returned 200 and `/onboarding/demo` returned a fragment-bearing, token-free-request invitation redirect |
| Docker build context | `Dockerfile` uses `npm ci` and the required root `package-lock.json` exists. Docker client 29.6.2 is installed, but the local Docker Desktop Linux daemon is not running, so `docker buildx build --check .` could not execute. No ACR exists yet, so a cloud build check would require an unapproved resource or image push; this is recorded as a workstation limitation, not a deployment-plan blocker |

Exact approved mutation commands:

```powershell
az group create --name 'rg-entra-verifiedid-example' --location 'westus2' --subscription '7e1b60b8-d616-4396-9de2-fc917930d02e'
az ad group create --display-name 'sg-entra-verifiedid-pilot' --mail-nickname 'entra-verifiedid-pilot' --description 'Dedicated pilot group for the Entra Verified ID example.'
```

Exact Azure validation commands:

```powershell
az bicep build --file '.\infra\main.bicep' --stdout
az bicep lint --file '.\infra\main.bicep'
az deployment group validate --resource-group 'rg-entra-verifiedid-example' --template-file '.\infra\main.bicep' --parameters location='westus2' containerAppLocation='westus2' appName='entra-vid' azureTenantId='3b14ce70-8bea-4d11-9e2c-6b4a04c8010d' pilotGroupId='6619d891-1a00-4a4b-aace-b6850a10985f' demoMode=false
az deployment group what-if --resource-group 'rg-entra-verifiedid-example' --template-file '.\infra\main.bicep' --parameters location='westus2' containerAppLocation='westus2' appName='entra-vid' azureTenantId='3b14ce70-8bea-4d11-9e2c-6b4a04c8010d' pilotGroupId='6619d891-1a00-4a4b-aace-b6850a10985f' demoMode=false --result-format ResourceIdOnly --no-pretty-print
az policy assignment list --scope '/subscriptions/7e1b60b8-d616-4396-9de2-fc917930d02e' --disable-scope-strict-match
```

No placeholder GUIDs or fabricated secrets were used. The validation used the approved tenant ID and the newly created pilot group object ID. No application infrastructure was deployed, no secrets were created, no group members were added, and no Power Platform or Power Pages action was performed.

---

## 11. Files

| File | Purpose | Status |
|------|---------|--------|
| `.azure/deployment-plan.md` | Deployment source of truth | Validated; deployment gates documented |
| `infra/main.bicep` | Existing infrastructure source | Durable state, pilot-group input, and runtime-RBAC wiring implemented |
| `infra/modules/storage.bicep` | Existing storage module | Invitation/session tables and managed-identity data role implemented |
| `azuredeploy.json` | Existing evaluation-only fallback | Aligned with non-demo defaults and durable table state |
| `.github/workflows/deploy-infrastructure.yml` | Existing what-if/apply workflow | Requires pilot-group input and explicitly disables demo mode |
| `.github/workflows/deploy.yml` | Existing image delivery workflow | Explicitly disables demo mode and passes pilot/durable-state settings |
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
| Invitation/session state is durable | `src/services/invitation-service.js`, `src/services/table-session-store.js`, `infra/modules/storage.bicep` |
| Browser cannot select the Entra account | `src/routes/invitations.js`, `src/routes/onboarding.js`, `src/services/graph-service.js` |
| Fragment activation avoids token-bearing request URLs | `src/public/js/invitation.js`, `src/routes/onboarding.js` |
| Managed portal is a separate frontend | No existing dependency, parameter, resource, workflow, or portal source is present in the repository |
| Power Pages website configuration supports GitHub Actions delivery | Official ALM documentation lists website upload actions, deployment profiles, and CLI upload/list/download commands |
| Initial site URL remains a controlled bootstrap | The current generally available CLI reference lacks a documented create-site or read-only global URL availability command |
| Node.js runtime contract | `package.json`, `package-lock.json`, `Dockerfile`, `src/config.js` |

---

## 13. Next Step

Deployment and application authorization prerequisites are complete for the approved manual-invitation pilot. TAP and FIDO2 authentication-method policies are already enabled tenant-wide (all users) and require no mutation for `sg-entra-verifiedid-pilot` — see the "Current authentication-method policy" table above. Power Platform, Power Pages, and the future Verified ID extension remain outside this deployment.

---

## 14. Deployment Execution Record

Application infrastructure and the real portal image were deployed end-to-end via GitHub Actions on 2026-09-10, following user approval to proceed past validation.

### What was deployed

| Step | Detail |
|------|--------|
| GitHub Actions OIDC identity | `uami-entra-verifiedid-example-deploy` (client ID `2f14c498-18e0-47f3-8748-12f06ea2e1e4`) with federated credentials for `staging`, `production`, and `refs/heads/main`; `Contributor` + `Role Based Access Control Administrator` on `rg-entra-verifiedid-example` |
| Infrastructure apply | `Deploy Infrastructure` workflow (`whatIf=false`, `location=westus2`) — created ACR `entravid27qmm4aqwwpfy`, Container Apps environment `entra-vid-cae`, Container App `entra-vid-app`, Key Vault `entra-vid-kv-feyizvcseko`, storage account `entravidfeyizvcsekofw`, Log Analytics `entra-vid-law`, App Insights `entra-vid-ai`, runtime UAMI `uami-entra-vid-app` (client ID `46c272db-888e-4d74-86b0-771757a8fbcb`) |
| Key Vault secrets | `session-secret` and `onboarding-approval-key` created with randomly generated values (required temporarily granting the operator `Key Vault Secrets Officer` on the vault) |
| GitHub Environment variables | `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `PILOT_GROUP_ID`, `AZURE_CONTAINER_APP_NAME`, `AZURE_CONTAINER_APP_FQDN`, `AZURE_CONTAINER_REGISTRY_NAME`, `AZURE_CONTAINER_REGISTRY_LOGIN_SERVER`, `KEY_VAULT_URL`, `AZURE_STORAGE_TABLE_ENDPOINT` set for both `staging` and `production` |
| Application deploy | `Deploy` workflow built the real image via `az acr build`, pushed to ACR, and updated the Container App — run [`34492465021`](https://github.com/x3nc0n/entra-verifiedid-example/actions/runs/34492465021) succeeded for both `Deploy → Staging` and `Deploy → Production`, including smoke/health checks |

### Live endpoint

`https://entra-vid-app.happyglacier-cbe8dde8.westus2.azurecontainerapps.io` — returns HTTP 200, serves the real Express/EJS onboarding portal with the shared layout and CSS applied (current revision `entra-vid-app--0000006`).

### Post-deploy fixes required

Two defects surfaced only once the real image was live and were fixed and merged before this state was reached:

1. **Container kept running the bootstrap placeholder script.** `infra/modules/container-app.bicep` bakes a `command`/`args` override onto the Container App for the first bootstrap deploy (an inline Node.js script printing "Infrastructure is ready..."). `az containerapp update --image ...` only replaces the image reference and does not clear that override, so the real image kept executing the bootstrap script instead of the Dockerfile's `CMD`. Fixed in `.github/workflows/deploy.yml` by adding `--command '' --args ''` to the image-update step (commit `85360e2`, PR #3).
2. **`--command '' --args ''` itself was wrong and caused `CrashLoopBackOff`.** Azure CLI interprets `''` as a one-element list containing an empty string — an invalid exec target — rather than clearing the field. Verified live: `az containerapp show` reported `command: [""]`, and the revision crash-looped (`restartCount` incrementing, `CrashLoopBackOff`). Corrected to bare `--command`/`--args` flags with no value, which the CLI correctly resolves to `null`. Fixed in PR #4 (commit `390141d`), and applied directly to the live Container App first via `az containerapp update --command --args` (no value) to unblock verification before the workflow fix landed.
3. **Rendered pages had no CSS at all.** Views (`index.ejs`, `onboarding.ejs`, `tap.ejs`, `verification.ejs`, `passkey.ejs`, `complete.ejs`) are authored as body-only fragments expecting `src/views/layout.ejs` to wrap them and provide `<head>`/the CSS `<link>`, but no layout engine was wired up in `src/app.js` — `res.render()` rendered fragments standalone. Fixed in `src/app.js` by wrapping `res.render()` to render the requested view to a string and pass it into `layout.ejs` as `body` (PR #4, commit `390141d`). Verified locally (all pages now include `<link rel="stylesheet" href="/css/style.css">`, `npm test` 21/21 pass) and on the live site after the corresponding `Deploy` run.

### Remaining gates before real pilot users onboard

The pilot user assignment, manual invitation triggering/delivery approval, and runtime Graph app roles were completed during the 2026-09-10 reconciliation in Section 16. TAP and FIDO2 authentication-method policies are already enabled tenant-wide (all users) and require no mutation — see the "Current authentication-method policy" table earlier in this document. Power Platform, Power Pages, and the future Verified ID extension remain fully out of scope.

## 15. Account Recovery Feature (App-Level Only, No New Infra)

Added a second use case — recovery for pilot users who lost every registered
authenticator — as a pure application-level change. **No new Azure resource,
Key Vault secret, GitHub Environment variable, or bicep change was introduced.**

### Why no infra change

`.github/workflows/deploy.yml` only builds/pushes the container image and runs
`az containerapp update`/`secret set`/`registry set` — it does not run
`az deployment group create` or `azd provision`. Any new bicep resource (e.g. a
second storage table) would silently NOT be applied by pushing to `main`; it
would require a separate manual provisioning step outside CI/CD. To keep the
feature fully deployable through the existing pipeline, it was designed to
introduce zero new infrastructure:

| Reused resource | How recovery uses it |
|---|---|
| Existing `onboardingInvitations` Azure Table | Recovery requests are stored in the same table under partition key `recovery` instead of `invitation` — full isolation without a new table. |
| Existing `ONBOARDING_APPROVAL_API_KEY` / `onboarding-approval-key` Key Vault secret | Reused unchanged to gate `POST /api/recovery-requests`, mirroring `POST /api/invitations`. |
| Existing pilot group / `PILOT_GROUP_ID` | Recovery reuses `graphService.getEligiblePilotUser`, the same eligibility check as onboarding. |

### What was added

- `src/services/recovery-service.js` — thin reuse of the refactored invitation
  engine (`createInvitationService`) with `entityLabel: 'Recovery request'`
  and partition key `recovery`.
- `graphService.deleteFido2Method` / `revokeAllFido2Methods` — revokes every
  existing tenant passkey for the account before a replacement TAP is issued,
  so the account never holds a stale or potentially compromised authenticator
  once a recovery request is validated.
- `src/routes/recovery.js`, `src/routes/recovery-requests.js`,
  `src/views/recovery.ejs` — mirror the onboarding routes/views; `passkey.ejs`,
  `tap.ejs`, and `complete.ejs` were extended (not duplicated) with a
  `recoveryMode` flag for conditional copy, reusing 100% of the existing
  TAP/passkey registration logic.
- `/recovery` mounted alongside `/onboarding` in `src/app.js`; nav link added
  in `partials/header.ejs`; homepage updated to mention both use cases.
- Tests: `test/recovery-service.test.js` (entity-label isolation, full
  create/activate/consume cycle) and two new cases in
  `test/identity-flow-contracts.test.js` for `revokeAllFido2Methods`.

### Verification

- `npm test` — 27/27 passing (21 pre-existing + 6 new).
- Manual demo-mode smoke test of the full flow (`/recovery/demo` →
  `/recovery/invite/activate` → `/recovery/invite` evidence POST → `tap.ejs`
  recovery copy rendered → `/passkey` recovery title/copy rendered) — all
  steps returned expected status codes and content.

### Deployment path

No manual Azure step is required. Merging to `main` and letting the existing
`Deploy` workflow run is sufficient — same as every other app-level change
in this repository.

## 16. Pilot Deployment Reconciliation

The live deployment was reconciled on 2026-09-10 against the approved pilot scope.

| Check | Live result |
|---|---|
| Azure target | Tenant `3b14ce70-8bea-4d11-9e2c-6b4a04c8010d`, subscription `7e1b60b8-d616-4396-9de2-fc917930d02e`, resource group `rg-entra-verifiedid-example` in `westus2` |
| GitHub OIDC | Deploy UAMI `uami-entra-verifiedid-example-deploy`; federated credentials for `staging`, `production`, and `refs/heads/main`; `Contributor` plus `Role Based Access Control Administrator` at resource-group scope |
| Runtime identity | UAMI `uami-entra-vid-app` (`46c272db-888e-4d74-86b0-771757a8fbcb`) |
| Runtime Graph consent | Exactly `User.Read.All`, `GroupMember.Read.All`, and `UserAuthenticationMethod.ReadWrite.All`; no Verified ID Request Service role was added |
| Pilot group | `sg-entra-verifiedid-pilot` contains only `newhire@spaid.family` |
| Key Vault secrets | `session-secret` and `onboarding-approval-key` are enabled; each contains a 64-character random value and is referenced by the Container App through Key Vault. The operator's temporary `Key Vault Secrets Officer` assignment was removed after population. |
| Durable state | `ONBOARDING_STATE_BACKEND=azure-table`; runtime UAMI has `Storage Table Data Contributor` only on `onboardingInvitations` and `onboardingSessions` |
| Pilot configuration | `ASSURANCE_MODE=invitation`, `DEMO_MODE=false`, approved `PILOT_GROUP_ID`, live `APP_BASE_URL`, and live `FIDO2_RP_ID`/`FIDO2_ORIGIN` |
| Container delivery | ACR `entravid27qmm4aqwwpfy`; Container App `entra-vid-app`; revision `entra-vid-app--0000011` running successfully |
| Smoke tests | `/` returned 200, `/health` returned 200, and unauthenticated POSTs to `/api/invitations` and `/api/recovery-requests` returned 401 |

The Graph-permission bootstrap was narrowed so future runs grant only the three approved Microsoft Graph application roles. Verified ID permissions remain deferred with the rest of that future extension.

## 17. v2 Self-Service Verified ID Architecture

### 17.1 Status, scope, and architectural decision

This section supersedes the earlier "future Verified ID extension" design for
v2 only. It does **not** change the deployed v1 application, its routes, its
tables, or its current `ASSURANCE_MODE=invitation` setting.

The approved v2 trust sequence is:

1. A pre-created employee starts a request without an administrator creating an
   invitation.
2. The application resolves the employee's immutable Entra object ID and the
   employee's current manager relationship from Microsoft Graph.
3. The application emails that manager an opaque, expiring approval link.
4. The manager signs in to this tenant and approves or rejects the exact bound
   employee request.
5. Only after approval, the application asks this tenant's Microsoft Entra
   Verified ID Request Service to issue a tenant credential to Microsoft
   Authenticator.
6. The employee presents that credential back to the portal.
7. The application accepts only the configured tenant issuer DID, configured
   credential type, valid linked domain, non-revoked credential, and claims
   matching the already-bound Entra object ID and employee ID.
8. Only after successful presentation does the application create a one-time
   TAP for that exact Entra object ID.
9. The employee uses the TAP at Microsoft Security Info to register a passkey.
10. The application confirms through Graph that a new passkey method exists,
    then marks onboarding complete.

Manager approval is the pilot's human trust anchor. Verified ID proves later
possession of the credential that the application issued for that approved,
immutable subject. No camera, face check, liveness, fraud-detection service,
PWA, external identity-verification vendor, or self-asserted identity-proofing
component is in scope.

### 17.2 Account posture and intake boundary

The v2 pilot should use a pre-created, `accountEnabled=true` employee who is
unprivileged, has no usable bootstrap credential, and is scoped to the dedicated
pilot group and TAP/FIDO2 policies. A disabled Entra account cannot sign in with
the TAP, so "disabled until verified" is not implementable without an additional
account-enable operation and additional Graph write permission. v2 therefore
does not enable accounts. If the tenant owner requires disabled accounts, that
must be approved as a separate lifecycle design before implementation.

Because the employee cannot authenticate before receiving a TAP, intake is a
low-assurance public operation. It identifies a candidate account; it does not
authorize TAP creation. The manager approval, Verified ID issuance, Verified ID
presentation, and immutable claim comparison are the authorization chain.

The intake form accepts:

- The employee's tenant UPN, used only as the initial Graph locator.
- The employee ID, compared to the authoritative Graph `employeeId`.

The application returns the same `202 Accepted` response whether the user,
employee ID, manager, or manager email exists. It records the detailed reason
only in security audit data. The requester continues in the same protected
server-side session; no employee bearer token is placed in a query string.
Per-IP and per-normalized-UPN throttles, a maximum outstanding request count,
generic responses, CSRF protection, body-size limits, and bot controls prevent
the endpoint from becoming a directory enumeration or manager-spam API.

### 17.3 Exact v2 HTTP surface and security model

All v2 routes use a parallel namespace. Existing `/onboarding`,
`/api/invitations`, `/api/verification`, and `/passkey` routes remain unchanged
until v2 is proven and explicitly promoted.

| Route | Caller and authentication | Purpose and security requirements |
|---|---|---|
| `GET /v2/onboarding` | Public | Render the self-service intake page. `Cache-Control: no-store`, strict CSP, no user-existence data. |
| `POST /api/v2/onboarding/requests` | Public, session cookie plus CSRF | Accept UPN and employee ID, normalize input, load the candidate user, compare Graph `employeeId`, resolve the real manager relationship, create the durable request, and queue manager notification. Always return generic `202`; rate-limit by IP, UPN digest, and employee object ID. |
| `GET /api/v2/onboarding/status` | Employee's server-side session | Return only the current request's coarse state and permitted next action. Never return manager identity, Graph errors, callback payloads, tokens, TAP values after first display, or other users' request IDs. |
| `POST /api/v2/verified-id/issuance/requests` | Employee session; state must be `manager-approved` | Create one issuance request. Generate a fresh Request Service state value and optional out-of-band PIN; persist only durable correlation and a protected PIN value for the short issuance window. Retry is bounded and invalidates the prior active issuance request. |
| `POST /api/v2/verified-id/issuance/callback` | Verified ID Request Service | Require the configured callback `api-key` or `Authorization` header, exact constant-time comparison, exact `requestId` plus state match, body limit, idempotent ETag transition, and accepted statuses only: `request_retrieved`, `issuance_successful`, `issuance_error`. |
| `POST /api/v2/verified-id/presentation/requests` | Employee session; state must be `credential-issued` | Create a presentation request constrained to the bound object ID and employee ID. A new request replaces an expired/error request but never changes the bound user. |
| `POST /api/v2/verified-id/presentation/callback` | Verified ID Request Service | Require callback authentication, exact request/state correlation, one accepted credential, issuer/type/domain/revocation/date/claim validation, and an atomic transition. TAP creation is invoked only from the successful transition and is idempotent. |
| `GET /v2/manager/approval` | Public bootstrap page | Receive the raw manager token only in the URL fragment. Client code posts it once to the activation endpoint, clears the fragment, then starts tenant sign-in. No analytics, referrers, or third-party resources. |
| `POST /api/v2/manager-approvals/activate` | Public bootstrap session | Accept the fragment token in a small JSON body, hash it, find an active unexpired record, and bind only a short-lived pre-auth reference to an HttpOnly session. It does not approve or consume the token. |
| `GET /auth/manager/signin` | Browser | Start tenant-specific Microsoft identity platform authorization-code flow with PKCE, `state`, and `nonce`; scopes are only `openid profile`. |
| `POST /auth/manager/callback` | Microsoft identity platform `form_post` | Validate issuer, audience, signature, tenant ID, nonce, state, and time claims. Atomically redeem the approval token only when the signed-in token's immutable `oid` equals the bound manager object ID. Email/UPN is never the authorization key. |
| `POST /api/v2/manager-approvals/{requestId}/decision` | Authenticated bound manager session plus CSRF | Accept `approve` or `reject`. Re-read the employee and current manager relationship immediately before the decision; require the signed-in `oid` to remain the current manager; commit one terminal decision with ETag compare-and-set. |
| `GET /v2/passkey` | Employee session; state must be `tap-issued` | Display the TAP once and direct the employee to Microsoft Security Info. The TAP is removed from server/session state immediately after the one protected response. |
| `POST /api/v2/passkey/confirm` | Employee session; state must be `tap-issued` | Re-list Graph FIDO2 methods and require a method ID not present in the pre-TAP baseline. Transition once to `passkey-registered`. |
| `GET /v2/complete` | Employee session; state must be `passkey-registered` | Mark `complete`, render non-secret completion evidence, and expire the onboarding session. |

Manager authentication requires a dedicated single-tenant web app registration
because the runtime managed identity cannot perform an interactive browser sign
in. The manager web app needs redirect URI
`https://<approved-host>/auth/manager/callback`, authorization-code flow, and a
certificate or Key Vault-backed client secret. A Conditional Access policy
should require MFA for this manager-approval application. The ID token's `tid`
and `oid` claims are authoritative; display name, mail, and UPN are display-only.

### 17.4 Graph and Verified ID API calls and least privilege

The runtime continues to use the dedicated user-assigned managed identity and
`/.default` app-only tokens. The deploy identity receives no Graph or Verified
ID permissions.

| Operation | Exact call | Required application permission |
|---|---|---|
| Load employee and immediate manager | Candidate app-only query: `GET https://graph.microsoft.com/v1.0/users/{userPrincipalName}?$select=id,displayName,userPrincipalName,employeeId,accountEnabled&$expand=manager($select=id,displayName,mail,userPrincipalName)`. This exact call is an implementation gate and must be proven in the target tenant before coding. | Microsoft Graph `User.Read.All` |
| Revalidate pilot membership before TAP | `POST https://graph.microsoft.com/v1.0/users/{id}/checkMemberGroups` with only `PILOT_GROUP_ID` | Microsoft Graph `GroupMember.Read.All` |
| Create one-time TAP | `POST https://graph.microsoft.com/v1.0/users/{id}/authentication/temporaryAccessPassMethods` with `{"lifetimeInMinutes":<approved>,"isUsableOnce":true}` | Microsoft Graph `UserAuthMethod-TAP.ReadWrite.All` |
| Baseline and confirm passkey | `GET https://graph.microsoft.com/v1.0/users/{id}/authentication/fido2Methods` before TAP and after Microsoft Security Info registration | Microsoft Graph `UserAuthMethod-Passkey.Read.All` |
| Create Verified ID issuance request | `POST https://verifiedid.did.msidentity.com/v1.0/verifiableCredentials/createIssuanceRequest` | Verifiable Credentials Service Request `VerifiableCredential.Create.IssueRequest` |
| Create Verified ID presentation request | `POST https://verifiedid.did.msidentity.com/v1.0/verifiableCredentials/createPresentationRequest` | Verifiable Credentials Service Request `VerifiableCredential.Create.PresentRequest` |

Important permission and contract notes:

- Current Microsoft Graph documentation marks application permission as not
  supported for the direct `GET /users/{id}/manager` navigation operation.
  The only plausible app-only shape for public intake is the user read with
  `$expand=manager`, shown above, under `User.Read.All`; however, the manager
  article's permission table can also be read as applying to that expansion.
  This is therefore a blocking tenant integration test, not an assumed
  contract. If the target tenant rejects both shapes with an app-only token,
  public pre-auth intake cannot meet the real-manager requirement with the
  current runtime identity model. The design must then pause for a separately
  approved delegated lookup component; it must not fall back to caller-supplied
  or hardcoded manager data.
- The current TAP create article's least-privilege table anomalously lists a
  read permission for a write operation. The Graph permission reference defines
  `UserAuthMethod-TAP.ReadWrite.All` as the application permission that reads
  and writes all users' TAP methods; v2 must use that granular write permission,
  not the legacy broad `UserAuthenticationMethod.ReadWrite.All`.
- v2 production passkey registration uses Microsoft Security Info followed by
  Graph read-back. It therefore needs only
  `UserAuthMethod-Passkey.Read.All`. The existing direct
  `creationOptions`/`POST fido2Methods` path is not used by v2 production
  because Graph returns a Microsoft-owned relying-party ID that the portal
  origin cannot satisfy. If a future trusted client uses those write APIs, it
  separately requires `UserAuthMethod-Passkey.ReadWrite.All`.
- `User.ReadWrite.All`, `Directory.Read.All`,
  `UserAuthenticationMethod.ReadWrite.All`, and
  `VerifiableCredential.Create.All` are not required by the planned v2 flow.
- If manager email is sent through Microsoft Graph, `Mail.Send` application
  permission and Exchange application-scoped access are additionally required.
  The preferred design is a separately approved transactional email service so
  the runtime does not gain tenant-wide mailbox send permission.

The Verified ID access token audience remains
`3db474b9-6a0c-4840-96ac-1fceb342124f/.default`. App-role IDs must be resolved
from the live `Verifiable Credentials Service Request` service principal by
role value; they must not be hardcoded.

### 17.5 Verified ID issuance contract

The application will send:

```http
POST https://verifiedid.did.msidentity.com/v1.0/verifiableCredentials/createIssuanceRequest
```

The real payload must be generated from the tenant owner's exported **Issue
credential** payload and must contain:

- `authority`: this tenant's real issuer DID.
- `manifest`: the real manifest URL from the Verified ID admin experience.
- `type`: the exact configured credential type.
- `callback.url`: the public v2 issuance callback.
- `callback.state`: a cryptographically random, one-request state value.
- `callback.headers`: only the approved callback authentication header.
- `claims`: server-supplied values for the immutable Entra object ID and the
  authoritative Graph employee ID.
- `pin`: recommended for this pilot, generated per request and shown only in the
  protected employee session. The credential contract must use the
  `idTokenHints` attestation flow because Request Service `claims` and `pin`
  are supported only for that flow.
- `includeQRCode: true`; the returned QR code or deep link is displayed only to
  the employee session.

The application does not create or sign the credential itself. On
`issuance_successful`, it records only completion metadata and permits the
presentation step. It does not infer issuance success from QR retrieval.

### 17.6 Verified ID authority, manifest, and trust model

The actual DID, manifest URL, credential type, and claim paths for tenant
`3b14ce70-8bea-4d11-9e2c-6b4a04c8010d` are not present in this repository and
must not be fabricated.

The tenant owner must complete one of the supported Verified ID setups:

- **Quick setup:** Microsoft manages the signing key; the DID has the form
  `did:web:verifiedid.entra.microsoft.com:<tenant-id>:<authority-id>`. The exact
  authority ID still must be copied from this tenant. Quick setup has a
  documented two-request-per-second tenant limit and a maximum six-month
  credential validity.
- **Advanced setup:** the tenant owner supplies a direct, non-redirecting HTTPS
  trusted domain and a separate Verified ID signing Key Vault using the
  permission model required by the Verified ID setup experience. The existing
  application Key Vault is RBAC-enabled and must not be assumed suitable as the
  Verified ID signing-key vault.

In the Verified ID admin experience, the tenant owner must create and approve a
custom onboarding credential. This plan deliberately does not invent the
manifest. The real display and rules definitions must:

- Define an approved credential type.
- Use `idTokenHints` mappings for exactly two required output claims:
  immutable Entra object ID and employee ID.
- Accept those claim values only from the server's issuance request, never from
  Authenticator self-attested input.
- Define an approved short validity interval and display/consent text.
- Publish a manifest that Authenticator can retrieve.
- Use the tenant's verified linked domain.

For presentation, the request must set:

- `authority` to this tenant's real verifier DID.
- `requestedCredentials[0].type` to the exact configured type.
- `acceptedIssuers` to an array containing only this tenant's exact issuer DID.
- `allowRevoked: false`.
- `validateLinkedDomain: true`.
- `includeReceipt: false`.
- Exact-value constraints for the bound object ID and employee ID where the
  configured claim names support them.

On `presentation_verified`, the app must still independently validate the
callback API key, request ID, state, issuer DID, credential type, linked-domain
validation result, revocation state, issuance and expiration times, and both
claims. The object ID comparison is a canonical GUID comparison. The employee
ID comparison uses the normalized authoritative Graph value and a timing-safe
hash comparison. The holder `subject` DID is audit metadata only; it is not an
Entra lookup key. A callback can corroborate only the employee object ID already
bound at intake; it can never select another account.

### 17.7 Manager approval token model

- Generate 32 random bytes and encode them as base64url.
- Put the raw token only in the email URL fragment:
  `https://<approved-host>/v2/manager/approval#token=<opaque-token>`.
- Store only `SHA-256(token)` with request ID, tenant ID, employee object ID,
  manager object ID, creation time, expiration, status, attempt count, and ETag.
- Permit only one active manager token per request. Resend atomically invalidates
  the old digest.
- Token activation stores only a short-lived server-side pre-auth reference and
  clears the fragment. It does not approve the request.
- Redemption occurs once, after successful tenant sign-in, and only when ID
  token `oid` equals the bound manager object ID and `tid` equals the configured
  tenant. Use ETag compare-and-set so concurrent opens yield one winner.
- The approval decision requires the redeemed manager session, CSRF token, and
  a fresh Graph check that the employee's manager is still the same object ID.
- A wrong manager, expired token, replay, manager change, missing manager, or
  organizational-contact manager fails closed and is audited. No alternate
  manager may be typed or configured by the requester.
- Approval/rejection is terminal. A later onboarding attempt creates a new
  request and new manager token.

### 17.8 Durable state machine, expiry, retry, and abuse handling

v2 uses a new Azure Table, recommended name `onboardingV2Requests`, rather than
overloading the deployed v1 invitation partition. Every transition uses ETag
compare-and-set, stores a correlation ID, and emits a redacted audit event.
Callback state and Request Service request IDs are durable; no v2 state lives in
a process-local `Map`.

| State | Entry and allowed transition | Expiry, retry, and abuse behavior |
|---|---|---|
| `requested` | Valid Graph user and employee ID are bound to immutable object ID; manager relationship resolved. Transition to `manager-notified`. | Suggested request lifetime: 24 hours, tenant owner to approve. Limit one active request per employee and a small daily creation count. Invalid intake returns generic `202` but records a redacted failure. |
| `manager-notified` | Email provider accepted delivery and active token digest stored. Transition to `manager-approved` or `manager-rejected`. | Token expires with the request. Bounded resend invalidates the old token; exponential backoff for provider errors; no fallback to caller-supplied manager. |
| `manager-approved` | Bound manager authenticated, token redeemed, current manager relationship revalidated, approval committed. Transition when employee creates issuance request. | Approval cannot be replayed or changed. Issuance retries are bounded and allowed only before request expiry; each retry gets new state/request ID/PIN and invalidates the prior active issuance request. |
| `manager-rejected` | Bound manager rejects. Terminal. | Employee sees only a generic rejected/closed message. A new attempt is rate-limited and creates a new request; rejection reason is optional, sanitized, and never emailed to arbitrary addresses. |
| `credential-issued` | Enter only on authenticated, correlated `issuance_successful`. Transition when a presentation request is created/retrieved. | Issuance QR expiry returns to `manager-approved` for a bounded retry. `issuance_error` is recorded without exposing service details. Credential validity must extend through the presentation window. |
| `credential-presented` | Request Service reports `request_retrieved`. Transition to `verified` only on `presentation_verified` plus local validation. | Presentation request expiry permits a bounded new request while the issued credential and onboarding request remain valid. Repeated claim/issuer failures lock the request and alert operations. |
| `verified` | Exact issuer/type/domain/revocation/date/object-ID/employee-ID checks pass atomically. Transition to `tap-issued`. | Verification is single-use. Duplicate callbacks are idempotent. TAP creation failure stays in a protected retryable substate; only the server may retry and must never create TAP for a different object ID. |
| `tap-issued` | Graph returns a one-time TAP for the bound user. Transition to `passkey-registered`. | TAP is displayed once with no-store headers and never persisted or logged. On expiry/loss, require a new manager-approved onboarding request rather than silently issuing another TAP. |
| `passkey-registered` | Graph lists a new FIDO2 method ID absent from the pre-TAP baseline. Transition to `complete`. | Confirmation polling is rate-limited. A method that predates v2 verification cannot satisfy completion. |
| `complete` | Non-secret audit metadata finalized and employee session invalidated. Terminal. | Retain only approved audit fields for the approved retention period; delete token digests, callback states, PIN material, and transient display data promptly. |

Global controls include a 32 KB JSON ceiling or smaller route-specific limits,
strict schemas, CSRF on browser mutations, SameSite/HttpOnly/Secure cookies,
request and callback idempotency, generic public errors, callback allowlisting
where supported, no secrets or PII in URL query strings, no callback bodies in
telemetry, no TAP/PIN/token logging, and operational alerts for notification
failure, callback mismatch, replay, state regression, repeated verification
failure, or Graph permission errors.

### 17.9 Current v1 reuse, replacement, and disablement

| Current file/surface | v2 disposition |
|---|---|
| `src/app.js` | Reuse Express hardening, sessions, layout, and health route. Add v2 routers only behind `SELF_SERVICE_V2_ENABLED`; v2 configuration is validated only when enabled. |
| `src/services/table-client.js` | Reuse managed-identity Table access and ETag error helpers. |
| `src/services/table-session-store.js` | Reuse durable Express sessions, with separate manager pre-auth/auth session keys and fixation-safe regeneration. |
| `infra/modules/storage.bicep` | Reuse the storage account and table service; add a separately scoped `onboardingV2Requests` table and table-level `Storage Table Data Contributor` assignment. |
| `src/services/graph-service.js` | Reuse managed-identity token acquisition, immutable-ID user load, pilot membership, TAP creation, and FIDO2 listing. Add employee/manager expansion and replace broad auth-method permission assumptions with granular TAP/passkey roles. |
| `src/services/verified-id-service.js` | Reuse Request Service token acquisition and presentation payload foundation. Add issuance support, remove partner-provider assumptions, require real tenant inputs, add claim constraints, and make callback correlation durable. |
| `src/services/verified-subject-service.js` | Reuse nested claim reading and timing-safe hash comparison. Replace UPN as the primary binding with immutable object ID plus employee ID; add strict linked-domain, validity, and exact tenant issuer checks. |
| `src/routes/passkey.js`, `src/views/passkey.ejs`, `src/views/tap.ejs`, `src/views/complete.ejs` | Reuse the Security Info handoff and "new method since baseline" confirmation logic through v2-namespaced handlers/views. Do not use the direct portal-origin `creationOptions`/registration path in v2 production. |
| `src/services/invitation-service.js`, `src/routes/invitations.js`, `src/routes/onboarding.js` | Retain unchanged for v1 rollback. They are not called by the v2 namespace and are removed only after a separately approved v1 retirement. |
| `src/routes/verification.js` | Do not extend its process-local `callbackStore`. Keep it disabled for v1; implement new durable v2 issuance and presentation callback routes. |
| `src/config.js` | Preserve `invitation`; add `self-service-verified-id-v2` and independent `SELF_SERVICE_V2_ENABLED=false`. Remove all fabricated/default issuer values from v2 validation. |
| `.github/workflows/deploy.yml` | Keep production pinned to `ASSURANCE_MODE=invitation` until promotion. Add v2 settings only after the corresponding resources/secrets exist; missing disabled-v2 inputs must not fail v1 startup. |
| `scripts/08-grant-app-uami-graph-permissions.ps1` | Resolve and grant `User.Read.All`, `GroupMember.Read.All`, `UserAuthMethod-TAP.ReadWrite.All`, `UserAuthMethod-Passkey.Read.All`, `VerifiableCredential.Create.IssueRequest`, and `VerifiableCredential.Create.PresentRequest`; remove the broad `UserAuthenticationMethod.ReadWrite.All` grant after v1/v2 validation proves it is unused. |
| Existing Container App, ACR, Log Analytics, Application Insights, runtime UAMI, deployment UAMI, Key Vault, and storage account | Reuse. Add only v2-specific table, callback/OIDC secrets, configuration, and optional email resource after explicit approval. |

The admin-triggered v1 endpoint `POST /api/invitations` is not exposed as a v2
operation. It stays enabled only for v1 rollback until retirement. The legacy
`ASSURANCE_MODE=verified-id` path, process-local callback map, partner issuer
defaults, and any documentation implying an external identity provider remain
disabled and must not be promoted as v2.

### 17.10 Deployment and rollback safety

The current GitHub `staging` and `production` jobs have deployed to the same
Container App. That is not sufficient isolation for v2. Before v2 runtime work,
create either a separate staging Container App/environment or an approved
Container Apps multiple-revision preview with an isolated revision label and no
production traffic.

Safe delivery order:

1. Keep the live app on `ASSURANCE_MODE=invitation` and
   `SELF_SERVICE_V2_ENABLED=false`.
2. Add v2 code, tests, and schemas with all v2 startup checks conditional on the
   disabled flag. Deploying this binary must leave every v1 route byte-for-byte
   compatible.
3. Separately provision the v2 table, Key Vault secrets, manager web app
   registration, redirect URI, email integration, Graph/Verified ID app roles,
   Verified ID authority/credential, and pilot policies.
4. Test v2 only on the isolated staging host/revision with synthetic or approved
   pilot identities. Confirm issuance and presentation callbacks reach the
   isolated v2 callback URLs.
5. Deploy the same tested image to production with v2 still disabled. Run v1
   smoke tests.
6. Enable the `/v2` namespace for a small approved pilot while the homepage and
   all v1 links still use `invitation`.
7. After end-to-end evidence and security review, set
   `ASSURANCE_MODE=self-service-verified-id-v2` to make v2 the default. Keep v1
   routes, table, secret, and last known-good container revision available for a
   defined rollback window.

Rollback is configuration/traffic only: set `SELF_SERVICE_V2_ENABLED=false`,
restore `ASSURANCE_MODE=invitation`, or route traffic to the last known-good v1
revision. Rollback never deletes v2 records mid-flow; they are marked suspended
and expire normally. Do not remove v1 code, invitation storage, approval secret,
or permissions until a separate retirement decision after v2 is stable.

### 17.11 Required user and tenant-owner inputs before implementation

Implementation must not start until the following are supplied or explicitly
decided:

1. **Verified ID setup:** Quick or Advanced setup for tenant
   `3b14ce70-8bea-4d11-9e2c-6b4a04c8010d`.
2. **Real authority values:** exact issuer/verifier DID copied from this tenant,
   exact manifest URL, exact credential type, and exact tenant ID shown by the
   Verified ID **Issue credential** experience.
3. **Credential contract:** approved display definition, rules definition using
   `idTokenHints`, exact object-ID and employee-ID output claim names, validity
   interval, consent text, logo/domain assets, and whether issuance PIN is
   mandatory.
4. **Trusted domain:** registered custom domain and linked-domain result. For
   Advanced setup, identify the separate access-policy-based signing Key Vault;
   do not assume the deployed RBAC application vault can be reused.
5. **Directory data readiness:** every pilot employee has a unique populated
   `employeeId`, a real `manager` relationship whose target is an enabled tenant
   user, and that manager has a routable approved email address.
6. **Account posture:** approve `accountEnabled=true` but unprivileged for the
   pilot, or request a separate disabled-account enablement design with its
   additional permission and rollback implications.
7. **Manager notification:** choose Azure Communication Services Email, another
   transactional provider, or Graph mail; provide sender domain/identity,
   delivery and bounce handling, and decide whether manager UPN may be used when
   `mail` is empty.
8. **Manager sign-in:** approve the dedicated single-tenant web app registration,
   exact public host and redirect URI, certificate/secret lifecycle, and MFA/
   Conditional Access requirement.
9. **Runtime consent:** authorize the granular Graph and Verified ID application
   roles listed in Section 16.4 for `uami-entra-vid-app`; confirm removal timing
   for legacy `UserAuthenticationMethod.ReadWrite.All`.
10. **Pilot policies:** approved pilot-group members and group-scoped TAP/FIDO2
    policies, one-time TAP lifetime, FIDO2 **Allow self-service setup** setting,
    and supported passkey types.
11. **Workflow limits:** request lifetime, manager-token lifetime, resend count,
    issuance/presentation retry count, per-IP/per-user rate limits, lockout
    duration, and support escalation path.
12. **Data governance:** audit fields, retention period, employee-ID hashing/
    keying approach, privacy notice, and operational recipients for abuse and
    failure alerts.
13. **Environment isolation:** approve a real staging Container App/environment
    or a multiple-revision labeled preview before enabling any v2 route against
    the live app.
14. **Public callback origin:** final HTTPS host, DNS/certificate ownership, and
    confirmation that both Verified ID callback endpoints are directly
    internet-reachable without authentication redirects.
15. **Manager API proof:** a read-only target-tenant proof that the runtime UAMI
    can return the immediate `manager` relationship with `User.Read.All` using
    the candidate `$expand=manager` query. If not, approve a delegated lookup
    design or stop v2; do not substitute a separate manager input.

### 17.12 Official contract references used for this design

- [Verified ID issuance request API](https://learn.microsoft.com/entra/verified-id/issuance-request-api)
- [Verified ID presentation request API](https://learn.microsoft.com/entra/verified-id/presentation-request-api)
- [Quick Verified ID setup](https://learn.microsoft.com/entra/verified-id/verifiable-credentials-configure-tenant-quick)
- [Advanced Verified ID setup](https://learn.microsoft.com/entra/verified-id/verifiable-credentials-configure-tenant)
- [Verified ID rules and display definitions](https://learn.microsoft.com/entra/verified-id/rules-and-display-definitions-model)
- [Microsoft Graph user manager relationship](https://learn.microsoft.com/graph/api/user-list-manager?view=graph-rest-1.0)
- [Create Temporary Access Pass](https://learn.microsoft.com/graph/api/authentication-post-temporaryaccesspassmethods?view=graph-rest-1.0)
- [List FIDO2 authentication methods](https://learn.microsoft.com/graph/api/fido2authenticationmethod-list?view=graph-rest-1.0)
