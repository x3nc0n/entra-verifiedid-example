# Trinity: split Container Apps region from base infra region

- Date: 2026-07-21
- Context: Central US successfully provisioned the shared infra resources, but repeated deployments failed to create `Microsoft.App/managedEnvironments` with `ManagedEnvironmentCapacityHeavyUsageError`, blocking the Container Apps layer only.
- Decision: Keep the top-level `location` parameter for the shared stack, add a dedicated `containerAppLocation` parameter in `infra/main.bicep`, and route the workflow's existing optional `location` input to that new parameter instead of overriding the whole deployment region.
- Consequence: Existing centralus resources remain unchanged while the Container Apps managed environment and app can be retried in another supported region such as `eastus2`, `westus3`, or `swedencentral`.
