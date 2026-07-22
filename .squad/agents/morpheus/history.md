# Project Context

- **Owner:** x3nc0n
- **Project:** entra-verifiedid-example — Microsoft Entra Verified ID employee/guest onboarding demo portal
- **Stack:** Node.js/Express, EJS views, Azure Bicep (Container Apps, Key Vault), GitHub Actions CI/CD
- **Created:** 2026-07-21T13:45:50.478-04:00

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->
- The `Deploy` GitHub Actions workflow has been failing since 2026-06-08 at the `azure/login@v2` step: `SERVICE_PRINCIPAL` auth-type is missing `client-id`/`tenant-id`. Team decided (2026-07-21) to switch to a User-Assigned Managed Identity (UAMI) with OIDC federated credentials instead of fixing the SP secrets, per user preference (x3nc0n prefers UAMI+OIDC over app-registration SP secrets for Actions auth, scoped RBAC at the resource group).
- Target deployment tenant: project tenant `<tenant-id>`.
- Container Apps only becomes a coherent reference-architecture path here if the runtime image story is first-class; a placeholder `node:20-alpine` app and unresolved private-registry pull model means the Deploy button is evaluation-only, not a primary deployment path.
- Reviewed `.github/workflows/deploy-infrastructure.yml`: manual-only trigger, default `whatIf`, environment-scoped gating, and `vars.AZURE_*` sourcing are correct, but the workflow must not reference Graph-consent follow-up or `scripts/08-grant-app-uami-graph-permissions.ps1` inside the privileged workflow body.

- 2026-07-21: Final re-review of `.github/workflows/deploy-infrastructure.yml` after Switch revision — **APPROVED**. Confirmed all Graph/script 08 references are removed from the workflow body, README keeps Graph consent as a standalone manual/local step, and prior approved checks (manual trigger, default `whatIf`, `vars.AZURE_*` sourcing, `deploy.yml` variable contract, environment gating) still hold.
