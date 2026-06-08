# Security Policy

## Supported Versions

This is a **demo and example repository**. It is provided as a reference implementation and is not versioned for long-term security support. The `main` branch reflects the current supported state.

| Branch | Supported |
|--------|-----------|
| `main` | ✅ Yes |
| All others | ❌ No |

---

## Demo Mode vs. Production

> ⚠️ **Critical:** This repository ships with a `DEMO_MODE` flag that bypasses cryptographic verification. **Never deploy with `DEMO_MODE=true` in any environment accessible to real users.**

### What Demo Mode Bypasses

- Entra Verified ID cryptographic credential verification
- Manager approval workflow (auto-approves)
- WebAuthn attestation validation
- Email delivery (logs to console only)
- Session persistence (in-memory only)

### Production Hardening Checklist

Before using this code as a basis for a production deployment:

- [ ] `DEMO_MODE=false` (verify this — do not rely on the default)
- [ ] All secrets stored in Azure Key Vault; App Service uses Managed Identity
- [ ] `SESSION_SECRET` is a cryptographically random value of at least 32 characters
- [ ] HTTPS enforced via App Service TLS settings; HTTP redirect enabled
- [ ] `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` locked to your production domain
- [ ] `VERIFIED_ID_CALLBACK_API_KEY` is a cryptographically random secret
- [ ] App Service access restrictions configured (if internal deployment)
- [ ] Entra Conditional Access policy applied to the app registration
- [ ] Logging and monitoring enabled (App Insights or equivalent)
- [ ] Dependency audit run (`npm audit`) and issues resolved before deployment

---

## Reporting a Vulnerability

We take security seriously. If you discover a security vulnerability in this repository, **please do not open a public GitHub issue.**

### How to Report

**Email:** Please report security vulnerabilities to the repository owner via GitHub's private vulnerability reporting feature:

1. Navigate to the [Security tab](https://github.com/x3nc0n/entra-verifiedid-example/security) of this repository
2. Click **"Report a vulnerability"**
3. Fill in the details of the vulnerability

Alternatively, you may contact the maintainer directly through their [GitHub profile](https://github.com/x3nc0n).

### What to Include

A good vulnerability report includes:

- **Description:** Clear description of the vulnerability and its potential impact
- **Steps to reproduce:** Exact steps to reproduce the issue
- **Affected component:** Which file(s), endpoint(s), or configuration is affected
- **Suggested fix:** If you have one (optional but appreciated)
- **Environment:** Node.js version, OS, deployment context

### Response Commitment

| Timeline | Commitment |
|----------|-----------|
| **48 hours** | Acknowledgement of receipt |
| **7 days** | Initial assessment and severity classification |
| **30 days** | Resolution or public disclosure timeline agreed |

We will credit reporters in the fix commit and changelog unless they prefer anonymity.

---

## Scope

The following are **in scope** for vulnerability reports:

- Authentication/authorization bypass in the onboarding flow
- Credential issuance or presentation manipulation
- Session hijacking or fixation
- Server-side injection (SQL, command, template)
- Secrets exposure (hardcoded credentials, leaked Key Vault values)
- Insecure WebAuthn implementation

The following are **out of scope**:

- Vulnerabilities in Microsoft Entra Verified ID service itself (report to [MSRC](https://msrc.microsoft.com/))
- Issues that only reproduce with `DEMO_MODE=true`
- Theoretical vulnerabilities without a proof-of-concept
- Best-practice suggestions unrelated to security (open a regular issue instead)

---

## Microsoft Security Resources

- [Microsoft Security Response Center (MSRC)](https://msrc.microsoft.com/)
- [Entra Verified ID Security Guidance](https://learn.microsoft.com/en-us/entra/verified-id/verifiable-credentials-configure-tenant#security-considerations)
- [Azure Security Baseline for App Service](https://learn.microsoft.com/en-us/security/benchmark/azure/baselines/app-service-security-baseline)
