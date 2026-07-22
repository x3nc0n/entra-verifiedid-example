Date: 2026-07-22
By: Trinity

Decision:
- Update the bootstrap placeholder Container App image tag from `mcr.microsoft.com/mirror/docker/library/node:20-alpine` to `mcr.microsoft.com/mirror/docker/library/node:20-bookworm-slim` in both `infra/modules/container-app.bicep` and `azuredeploy.json`.

Why:
- The MCR Docker Hub mirror does not publish the `20-alpine` tag for `library/node`, which causes `MANIFEST_UNKNOWN` during bootstrap deployments.
- `20-bookworm-slim` is published on the MCR mirror and remains a small Node 20 base image suitable for the existing inline placeholder HTTP server.
