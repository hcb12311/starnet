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

Open `/factory` after signing in to submit a background product build. The
gateway calls the existing Tesseract DBOS executor over Railway's private network;
it returns a durable job ID before generation begins. Two shared workers build
supplier-file checkers and original SVG vector-art packs. Jobs retain their source,
generation usage and verified artifact hashes. Downloads use expiring private
bucket URLs directly, so delivered media does not pass through the gateway.

Configure `SLOPCANNON_CODEX_MODEL` with an account-supported model slug
(default `gpt-6.1-sol`). Configure `SLOPCANNON_FACTORY_URL` with the executor's private HTTP origin and
`SLOPCANNON_API_TOKEN` with its dedicated service credential. The token stays in
the gateway and is removed from the upstream sidecar environment. The executor
owns its bucket credentials and a daily job limit. StarNet alone owns Codex
OAuth tokens, refresh and generation. Connect ChatGPT from `/factory` or the
station's existing sign-in screen. Generation uses the included subscription
allowance with standard speed and medium reasoning; it has no API-key or paid
media fallback. The default rolling 24-hour limit is 20 builds. Actual token
usage is retained; included allowance is finite. Historical API proof receipts
remain labelled with their actual provider and priced usage.

Factory submissions preserve their request ID until acceptance is confirmed.
Closing the browser after acceptance leaves those jobs running. Ordinary StarNet
interactive agent runs retain their upstream connection-bound behavior. Shipped
static assets require authentication on every revalidation, with versioned ETags
and zero-body 304 responses. HTML, APIs and workspace files remain `no-store`.

Connect interactive providers through the station after signing in. Store
publication, checkout, paid demand and automatic capture import require their
actual adapters and readback. Desktop control, desktop OAuth callbacks and
local-model access retain their upstream host requirements.

Deployment uses the fork's `main` branch. Daily source review watches the original
`androoAGI/starnet` `feat/harness-backend` branch in the existing pinned UI chat;
compatible adoption and `origin main` pushes are authorized by Harry on 7 October 2026 through the shared Sasines upstream register. `node hosting/check.cjs` checks the
gateway against the real sidecar with an isolated workspace and no provider key.

The executor calls the gateway’s dedicated Bearer-gated `/internal/slopcannon/`
routes over the private network. The gateway forwards to native token-gated
sidecar handlers; OAuth tokens never leave StarNet. Responses are checkpointed
on its protected persistent volume before returning, then retained and verified
in the product bucket. A missing ChatGPT connection refuses new build admission.
