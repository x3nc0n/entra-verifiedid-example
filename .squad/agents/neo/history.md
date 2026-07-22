# Project Context

- **Owner:** x3nc0n
- **Project:** entra-verifiedid-example — Microsoft Entra Verified ID employee/guest onboarding demo portal
- **Stack:** Node.js/Express, EJS views, Azure Bicep (Container Apps, Key Vault), GitHub Actions CI/CD
- **Created:** 2026-07-21T13:45:50.478-04:00

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->
- 2026-07-21: `src/config.js` is the canonical runtime env contract; Container Apps and README should use `VC_*`, `IDENTITYPASS_API_ENDPOINT`, `AZURE_*`, and `FIDO2_*` names exactly as defined there.
- 2026-07-21T15:18:12.548-04:00: Fixed Tank's app-runtime findings in `src/` by wiring `POST /api/identitypass/callback` with HMAC validation, making demo approval unmistakably simulated in the UI/API, keeping VC claims minimal, and switching Graph/Verified ID auth code to `DefaultAzureCredential`.
- 2026-07-21T16:01:13.239-04:00: Pinned `DefaultAzureCredential` in `src/services/graph-service.js` and `src/services/verified-id-service.js` with `managedIdentityClientId` sourced from `config.azure.clientId` (`AZURE_CLIENT_ID` assumption because Switch's app-UAMI contract file was not present), and updated `README.md`/`src/config.js` to document the runtime UAMI purpose.

- 2026-07-22T01:38:53.5354045-04:00: Neo handled the app/runtime stabilization work around the real deployment chain by reconciling the runtime env contract to `src/config.js`, fixing the IdentityPass callback contract and webhook validation path, pinning `DefaultAzureCredential` to the runtime UAMI, and clearing the blocking `npm audit --audit-level=high` failure with safe dependency updates. Those changes were needed so the live Container App revision matched the actual app config/auth expectations and the CI gate stopped failing on dependency advisories. Neo's work left the app deployable in demo mode even though tenant-admin Graph consent for the runtime UAMI is still outstanding for real Verified ID flows. Final deployment-fix commit before Scribe merge: `8493ed112276980699000969eddc27a454bc211e`.
