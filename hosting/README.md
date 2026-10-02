# SlopCannon on Railway

Harry selected StarNet as the SlopCannon interface on 2 October 2026.
This fork retains the upstream MIT licence and the complete station/runtime.
`hosting/server.cjs` adds a single-user login gateway; the original sidecar remains
bound to loopback, with its existing API tokens and capability checks.

Start with `npm run start:railway`. Railway terminates HTTPS. Configure:

- `PORT`: external gateway port, normally `8080`.
- `STARNET_LOGIN_USER` and `STARNET_LOGIN_PASSWORD`: private login credentials.
- `STARNET_PUBLIC_ORIGIN`: exact HTTPS origin; alternatively Railway supplies
  `RAILWAY_PUBLIC_DOMAIN`.
- `STARNET_WORKSPACES`: `/data/workspaces` on a Railway persistent volume.
- `STARNET_CONNECTOR_ENCRYPTION_KEY`: stable 32-byte hex key in Railway variables,
  consumed by the upstream connector vault. Preserve it across deployments.

`/healthz` exposes only runtime readiness. Every other route, including static
files, provider setup, files, API calls and event streams, requires the login.
Foreign Host/Origin requests are rejected before forwarding. Login secrets are
removed from the runtime environment. The gateway does not buffer streaming runs.

Connect providers through the station after signing in. This deployment does not
connect Etsy, launch businesses, import the Mac capture archive, or connect the
existing SlopCannon preparation worker. Those require their actual adapters and
readback. Desktop control, desktop OAuth callbacks and local-model access retain
their upstream host requirements; they are not verified cloud capabilities.

Deployment uses the fork's `main` branch. Daily source review watches the original
`androoAGI/starnet` `feat/harness-backend` branch in the existing pinned UI chat;
it never merges or deploys automatically. `node hosting/check.cjs` checks the
gateway against the real sidecar with an isolated workspace and no provider key.
