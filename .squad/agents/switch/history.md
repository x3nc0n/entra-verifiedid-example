# Project Context

- **Owner:** x3nc0n
- **Project:** entra-verifiedid-example — Microsoft Entra Verified ID employee/guest onboarding demo portal
- **Stack:** Node.js/Express, EJS views, Azure Bicep (Container Apps, Key Vault), GitHub Actions CI/CD
- **Created:** 2026-07-21T13:45:50.478-04:00 (joined mid-assignment, casting universe: The Matrix)

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->
- Joined after Morpheus rejected Trinity's Container Apps migration (2026-07-21): registry strategy was broken (GHCR image not pullable by ACA, no AcrPull wiring), and `azuredeploy.json` shipped a placeholder `node:20-alpine` image instead of the real app. Full verdict: `.squad/decisions/inbox/morpheus-container-apps-review.md` (once merged, `.squad/decisions.md`).
- Per Reviewer Rejection Lockout: Trinity is locked out of this specific artifact set (deploy.yml, azuredeploy.json, validate.yml, infra registry config) — I own the revision, not Trinity.
- 2026-07-21: Reworked delivery onto Azure Container Registry with managed-identity pull, moved deploy-time GitHub variables to environment scope, and made ARM/Bicep deploys explicitly bootstrap-only until CI publishes the real app image.

- 2026-07-21: FYI from Neo — runtime env names are now standardized on `src/config.js`; Container App docs/vars should use `VC_*`, `IDENTITYPASS_API_ENDPOINT`, and the existing `AZURE_*` / `FIDO2_*` contract.
- 2026-07-21: Live Azure bootstrap exposed two PowerShell/Azure CLI edge cases in `scripts/07-bootstrap-github-actions-uami.ps1`: `"$var:suffix"` inside double-quoted strings must use `${var}` to avoid drive-qualified parsing, and `az role assignment list` must not be passed `--assignee-principal-type` even though `create` accepts it.
- 2026-07-21: Follow-up bootstrap hardening added required non-interactive confirmation flags to destructive delete/cleanup commands so reruns do not hang in headless sessions.
- 2026-07-21: Bootstrap-chain alignment follow-up — `scripts/05-deploy-infrastructure.ps1` is now infra/runtime-config only for Container Apps + ACR; no ZIP/App Service deploy path remains, and `.env` generation follows `src/config.js` names.
- 2026-07-21: Applied Tank's Entra script security fixes in `scripts/01-04` — app-only Graph permission corrected to `User.Read.All`, stale `/signin-oidc` config removed, IdentityPass callback aligned to `/api/identitypass/callback`, DID domain validation tightened, contract minimized to issuance claims, and FIDO2/TAP all-users rollout now requires `-AllowAllUsers`.
- 2026-07-21: Followed Neo's runtime-auth decision — stopped generating/injecting `AZURE_CLIENT_SECRET` for the Container App managed-identity path, and updated `scripts/05-deploy-infrastructure.ps1` to grant Graph + Verified ID request app roles directly to the Container App managed identity.
- 2026-07-21: Split runtime Graph auth onto a dedicated app UAMI (`uami-entra-vid-app`) while keeping the Container App system identity for ACR/Key Vault, added `scripts/08-grant-app-uami-graph-permissions.ps1`, and standardized the runtime contract on `AZURE_CLIENT_ID=<app UAMI clientId>` so Neo can pin `managedIdentityClientId`.
- 2026-07-21: Fixed DemoMode bootstrap regressions by swapping the invalid `<env-hash>` DID placeholder for a valid demo hostname, skipping runtime-UAMI app-role grants in DemoMode, and correcting the `New-Guid` TAP syntax bug in `scripts/06-seed-demo-data.ps1`.
- 2026-07-21: Templatized the public-repo Azure bootstrap story by removing real tenant/subscription defaults from scripts, requiring explicit live-run IDs, and replacing README/examples with `<your-tenant-id>` / `<your-subscription-id>` placeholders.
- 2026-07-21: Fixed the second DemoMode bootstrap regressions by guarding `Get-MgContext` behind DemoMode in `scripts/02-configure-verified-id.ps1` (with a clear disconnected-Graph error for real runs) and by making the `$schema` demo-data key literal in `scripts/06-seed-demo-data.ps1`.
- 2026-07-21: Privileged GitHub Actions workflows in this repo must not mention manual Graph-consent steps at all; `scripts/08-grant-app-uami-graph-permissions.ps1` guidance belongs only in README/local runbooks, not workflow output or comments.
- 2026-07-21: Fixed stale IdentityPass callback drift in `scripts/06-seed-demo-data.ps1` by replacing the obsolete `/api/identitypass/approval*` and `/api/identitypass/webhook` demo config endpoints with the single canonical `/api/identitypass/callback` route used by `scripts/03-configure-identitypass.ps1` and `src/routes/identitypass.js`.
