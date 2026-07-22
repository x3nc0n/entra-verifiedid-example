# Trinity: use MCR Docker Hub mirror for bootstrap placeholder image

- **Date:** 2026-07-22
- **Scope:** `infra/modules/container-app.bicep`, `azuredeploy.json`

## Context

`Microsoft.App/containerApps` was failing to provision the bootstrap revision with:

`ContainerAppOperationError: Failed to provision revision for container app 'entra-vid-app'. Error details: Operation expired.`

The failure pattern was consistent across retries and took about 21–22 minutes each time.

## Root cause

The bootstrap placeholder container pulled `node:20-alpine` directly from Docker Hub (`docker.io`). From Azure datacenters this can hang or rate-limit badly enough that Container Apps never finishes pulling the image before its internal revision provisioning timeout expires.

## Decision

Keep the existing bootstrap placeholder behavior exactly the same, but change the image reference to Microsoft's public Docker Hub mirror on MCR:

- from: `node:20-alpine`
- to: `mcr.microsoft.com/mirror/docker/library/node:20-alpine`

No `registries` config change is required because the MCR mirror is a public anonymous-pull endpoint. The existing ACR registry wiring remains only for the real application image.

## Why

MCR mirrors the same public Docker Hub image content and tags while providing more reliable pull performance from Azure-hosted services. This is the lowest-risk fix because it changes only the registry path, not the container command, args, ports, env, or bootstrap semantics.
