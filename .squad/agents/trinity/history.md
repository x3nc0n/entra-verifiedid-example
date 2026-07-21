# Project Context

- **Owner:** x3nc0n
- **Project:** entra-verifiedid-example — Microsoft Entra Verified ID employee/guest onboarding demo portal
- **Stack:** Node.js/Express, EJS views, Azure Bicep (Container Apps, Key Vault), GitHub Actions CI/CD
- **Created:** 2026-07-21T13:45:50.478-04:00

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->
- Deploy workflow has failed on every run since 2026-06-08 — `azure/login@v2` with `auth-type: SERVICE_PRINCIPAL` is missing `client-id`/`tenant-id` secrets/vars.
- Directive (2026-07-21, x3nc0n): switch GitHub Actions Azure auth from Service Principal secrets to a User-Assigned Managed Identity (UAMI) with OIDC federated credentials. Bootstrap the UAMI + federated credential + RBAC once via `az` CLI script in-repo; scope role assignments to the resource group; no further direct `az` mutations after bootstrap.
- Target deployment tenant: project tenant `<tenant-id>`. Subscription to confirm before first deploy (per user's convention of pre-creating the RG in the target Landing Zone/subscription).
- 2026-07-21: `deploy.yml` uses GitHub Environments (`staging`, `production`), so the OIDC bootstrap must create environment-subject federated credentials for those jobs; a plain branch subject alone is not sufficient.

- 2026-07-21: Finished the App Service → Azure Container Apps cleanup by moving `deploy.yml` to Docker+GHCR+`az containerapp update`, rebuilding `azuredeploy.json` around Container Apps/Key Vault placeholders, and documenting the GHCR registry caveat.

- 2026-07-21: FYI from Neo — runtime env names are now standardized on `src/config.js`; Container App docs/vars should use `VC_*`, `IDENTITYPASS_API_ENDPOINT`, and the existing `AZURE_*` / `FIDO2_*` contract.
- 2026-07-21: Added `.github/workflows/deploy-infrastructure.yml` as a manual-only OIDC/UAMI infra workflow for `infra/main.bicep` with `whatIf` support, output-to-summary reporting, printed `gh variable set --env ... --body ...` follow-up commands, README updates, and an explicit non-goal that Graph consent (`scripts/08-grant-app-uami-graph-permissions.ps1`) stays manual/local.
