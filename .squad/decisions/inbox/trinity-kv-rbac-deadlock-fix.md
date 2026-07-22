# Trinity: decouple Container App Key Vault secret wiring from initial provisioning

## Context

The initial `Microsoft.App/containerApps` deployment wired `IDENTITYPASS_SUBSCRIPTION_KEY` through a Key Vault-backed Container Apps secret (`identitypass-key`) resolved with the container app's own system-assigned managed identity.

At the same time, the template granted the `Key Vault Secrets User` role to that same system-assigned identity by computing the `principalId` from the container app resource itself. ARM therefore could not create the role assignment until the container app reached a terminal provisioning state.

## Problem

This created a circular dependency:

1. Container App startup needed to resolve `identitypass-key` from Key Vault.
2. That secret resolution required the container app's system identity to already have `Key Vault Secrets User`.
3. The role assignment could only be created after ARM finished provisioning the container app and could resolve its `principalId`.

In practice, the container app never reached `Succeeded`; it hung until Azure timed the operation out with `ContainerAppOperationError` / `Operation expired`.

## Decision

Bootstrap infra must not require the container app to resolve Key Vault-backed secrets during initial creation.

- Removed the Key Vault-backed `identitypass-key` secret from the bootstrap Container App definition.
- Removed the bootstrap `IDENTITYPASS_SUBSCRIPTION_KEY` secretRef env var from the initial Container App definition.
- Kept the Key Vault RBAC role assignment exactly as-is so it still lands after the container app exists.
- Updated post-image deployment workflow steps to configure the Key Vault-backed secret and set `IDENTITYPASS_SUBSCRIPTION_KEY=secretref:identitypass-key` with Azure CLI after the app already exists.
- Added `KEY_VAULT_URL` to the infra deployment output summary / `gh variable set` guidance so deploy workflows can wire the secret later.
- Mirrored the same bootstrap fix in `azuredeploy.json` to keep ARM-template-based deployment paths aligned.

## Consequences

- Initial infra deployment can now complete without the Key Vault RBAC deadlock.
- The later app deployment workflow remains responsible for attaching the real Key Vault-backed secret after infra has finished and RBAC exists.
- Future bootstrap secrets should avoid any design that requires a resource to fetch a secret before the identity permissions needed for that fetch can exist.
