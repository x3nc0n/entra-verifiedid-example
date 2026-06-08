# Cost Transparency

This document provides full transparency on the costs involved in this project —
both the one-time AI-assisted development cost and the ongoing Azure run-rate for
a real deployment.

---

## AI-Assisted Development Cost (One-Time)

This entire project — infrastructure, application code, scripts, documentation, and
CI/CD pipelines — was built in a single GitHub Copilot CLI session using an AI team
(Squad) of specialized agents. The cost below reflects what this work would cost at
raw API pricing; under a GitHub Copilot subscription it is covered by the subscription.

| Agent | Role | Model | Est. Input Tokens | Est. Output Tokens |
|-------|------|-------|------------------:|-------------------:|
| Coordinator | Orchestration & routing | Claude Opus 4.6 | ~120,000 | ~35,000 |
| Kima (×2 spawns) | Application code & frontend | Claude Sonnet 4.6 | ~130,000 | ~60,000 |
| Sydnor (×1) | Infrastructure (Bicep/ARM/Docker/CI-CD) | Claude Sonnet 4.6 | ~65,000 | ~30,000 |
| Herc (×2 spawns) | PowerShell bootstrapping scripts | Claude Sonnet 4.6 | ~100,000 | ~50,000 |
| McNulty (×1) | Documentation & README | Claude Sonnet 4.6 | ~65,000 | ~30,000 |
| Research | GitHub API reads (reference repo) | — | ~20,000 | — |
| **Total** | | | **~500,000** | **~205,000** |

**Estimated API-equivalent cost:**

| Model | Input Cost | Output Cost | Subtotal |
|-------|-----------|------------|----------|
| Claude Opus 4.6 | $1.80 | $2.63 | $4.43 |
| Claude Sonnet 4.6 (all agents) | $1.08 | $2.55 | $3.63 |
| **Total** | | | **~$8–10** |

> **Note:** This is the estimated equivalent cost if the work had been done via direct
> API calls. Under a GitHub Copilot subscription, this is included in the subscription
> fee. The session also included a refinement pass incorporating proven patterns from
> Microsoft's [ENTRA-verifiable-credentials-dotnet](https://github.com/japortes/ENTRA-verifiable-credentials-dotnet)
> reference implementation.

---

## Azure Deployment Run-Rate (Monthly)

The costs below are **separate from the AI development cost above**. These represent
the expected monthly Azure bill for running a real deployment of this solution.

### Resource Breakdown

| Resource | SKU / Tier | Est. Monthly Cost | Notes |
|----------|-----------|------------------:|-------|
| App Service Plan | B1 (Basic) | $13.14 | 1 core, 1.75 GB RAM; sufficient for demo/pilot |
| App Service | (included in plan) | — | Linux container on the B1 plan |
| Key Vault | Standard | $0.03–0.50 | Per-transaction pricing; demo volume is negligible |
| Application Insights | Pay-as-you-go | $0.00–2.00 | Free up to 5 GB/month; demo stays well under |
| Storage Account | Standard LRS | $0.10–0.50 | Session state and logs; minimal volume |
| Container Registry | Basic | $5.00 | If using Docker deployment (optional) |
| **Total (Demo/Pilot)** | | **~$19–21/mo** | |

### Scaling Notes

| Scenario | Recommended SKU | Est. Monthly Cost |
|----------|----------------|------------------:|
| **Demo / PoC** (1–50 users) | B1 Basic | ~$19–21 |
| **Pilot** (50–500 users) | S1 Standard | ~$55–70 |
| **Production** (500+ users) | P1v3 Premium | ~$120–160 |

### Cost Optimization Tips

- **Use App Service B1** for demos — it includes a custom domain and SSL.
- **Application Insights** has a 5 GB/month free tier — more than enough for demos.
- **Key Vault** charges per-operation (~$0.03/10K operations) — demo traffic is effectively free.
- **Auto-shutdown** is not applicable to App Service, but you can scale down to the Free tier (F1)
  when not actively demoing.
- **Container Registry** is only needed if deploying via Docker; zip deployment avoids this cost.

### What's NOT Included

These costs are for the demo portal infrastructure only. The following Entra ID services
used by the solution are part of your Microsoft Entra ID licensing:

- **Verified ID** — included with Entra ID P1/P2
- **Temporary Access Pass (TAP)** — included with Entra ID P1/P2
- **FIDO2 Security Key registration** — included with Entra ID
- **IdentityPass** — separate Microsoft service (contact your Microsoft representative)

---

*Last updated: 2026-06-08*
