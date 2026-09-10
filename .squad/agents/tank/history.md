# Project Context

- **Owner:** x3nc0n
- **Project:** entra-verifiedid-example — Microsoft Entra Verified ID employee/guest onboarding demo portal
- **Stack:** Node.js/Express, EJS views, Azure Bicep (Container Apps, Key Vault), GitHub Actions CI/CD
- **Created:** 2026-07-21T13:45:50.478-04:00

## Learnings

<!-- Append new learnings below. Each entry is something lasting about the project. -->
- 2026-07-21: The Entra bootstrap scripts still need security hardening before a real tenant run: script 01/03 return plaintext secrets, script 02's VC contract mismatches issuance claims, and script 03's IdentityPass webhook contract is not wired in the app.
- 2026-09-10: When an unsupported/internal Entra backend numeric policy state conflicts with the user's live authenticated admin-center view, preserve the discrepancy but treat the live admin-center view as authoritative. For The Spaid Family tenant, TAP and Passkey (FIDO2) are both enabled for All users; FIDO2 enforces attestation but does not enforce AAGUID restrictions. The disabled "Verified ID" authentication-method entry is separate from Verified ID Service/DID issuance and presentation.
- 2026-09-10: The Spaid Family tenant is already onboarded to Entra Verified ID through Quick setup. The read-only Admin API lists authority `92a37e98-dadf-794a-c727-568df01824c8` with DID `did:web:verifiedid.entra.microsoft.com:3b14ce70-8bea-4d11-9e2c-6b4a04c8010d:92a37e98-dadf-794a-c727-568df01824c8`, managed signing keys, verified linked domain `https://spaid.family/`, and the default `Verified employee` contract. The application's RBAC-enabled Key Vault is unrelated to this managed-keystore authority. Microsoft-owned Verified ID resource service principals exist, but no tenant-owned app registration declares or has an app-role grant for either the Request Service or Admin Service API.
- 2026-09-10: The Spaid Family tenant is already onboarded to Entra Verified ID through Quick setup. The read-only Admin API lists authority `92a37e98-dadf-794a-c727-568df01824c8` with DID `did:web:verifiedid.entra.microsoft.com:3b14ce70-8bea-4d11-9e2c-6b4a04c8010d:92a37e98-dadf-794a-c727-568df01824c8`, managed signing keys, verified linked domain `https://spaid.family/`, and the default `Verified employee` contract. The application's RBAC-enabled Key Vault is unrelated to this managed-keystore authority. Microsoft-owned Verified ID resource service principals exist, but no tenant-owned app registration declares or has an app-role grant for either the Request Service or Admin Service API.
