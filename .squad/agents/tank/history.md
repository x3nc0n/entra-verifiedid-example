# Project Context

- **Owner:** x3nc0n
- **Project:** entra-verifiedid-example — Microsoft Entra Verified ID employee/guest onboarding demo portal
- **Stack:** Node.js/Express, EJS views, Azure Bicep (Container Apps, Key Vault), GitHub Actions CI/CD
- **Created:** 2026-07-21T13:45:50.478-04:00

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->
- 2026-07-21: The Entra bootstrap scripts still need security hardening before a real tenant run: script 01/03 return plaintext secrets, script 02's VC contract mismatches issuance claims, and script 03's IdentityPass webhook contract is not wired in the app.
