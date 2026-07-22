# Trinity: workflow-level infra region override for capacity fallback

- Date: 2026-07-21
- Scope: `.github/workflows/deploy-infrastructure.yml`

## Decision

Add an optional `workflow_dispatch` `location` input to the infrastructure deployment workflow and pass it through to the Bicep deployment only when provided.

## Why

`infra/main.bicep` already supports a `location` parameter and correctly defaults to `resourceGroup().location`, but live deployments can fail when a specific service has temporary regional capacity exhaustion. A workflow-level override lets operators retry a single deployment in an alternate Azure region without changing the resource group's home region or editing IaC defaults.
