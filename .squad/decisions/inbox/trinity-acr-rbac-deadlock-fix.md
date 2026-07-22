## ACR bootstrap RBAC deadlock fix

- **Bug:** The bootstrap Container App configured `configuration.registries[]` to use its system-assigned identity against ACR during initial creation. That created the same RBAC circular dependency as the prior Key Vault secret issue: the app needed `AcrPull` during provisioning, but the role assignment could only be created after the Container App reached terminal state.
- **Fix:** Remove bootstrap-time ACR registry wiring from the initial Container App definition, then grant `AcrPull` on the ACR to the Container App system identity after the app exists. Wire the registry credential later in GitHub Actions with `az containerapp registry set`, just like we now defer Key Vault-backed secret wiring until post-provisioning.
- **Variables:** No new GitHub variables are required. `AZURE_CONTAINER_REGISTRY_LOGIN_SERVER` and `AZURE_CONTAINER_REGISTRY_NAME` already cover the post-provisioning registry wiring flow.
