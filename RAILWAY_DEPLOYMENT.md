# Railway backend deployment guide

This repository is an npm-workspaces monorepo. Deploy one backend service from
the repository root; the frontend is not a Railway service in this setup.
This guide prepares dashboard settings only. It does not connect a repository,
create a Railway project, or deploy anything.

## Why there is no Railway config file

Railway's current documentation marks `railway.toml` and `railway.json`
Config-as-Code as deprecated; new services cannot opt into that system, and
existing files stop being read after 2026-12-01. Railway's replacement,
Infrastructure as Code, currently requires the Railway CLI and a linked
project. Neither is appropriate for this preparation-only task. Configure the
single service in Railway's dashboard using the settings below.

References:

- [Railway shared monorepos](https://docs.railway.com/deployments/monorepo)
- [Railway build and start commands](https://docs.railway.com/builds/build-and-start-commands)
- [Railway health checks](https://docs.railway.com/deployments/healthchecks)
- [Railway public domains and SSL](https://docs.railway.com/networking/domains/working-with-domains)
- [Railway Infrastructure as Code status](https://docs.railway.com/infrastructure-as-code)

## Create one backend service later

1. In Railway, create an empty project and one empty service. Do not use the
   automatic monorepo import flow, which may propose services for multiple
   workspaces.
2. When ready to connect source, connect the GitHub repository to that service.
   Do not create a separate frontend or API service.
3. Keep the service **Root Directory** at the repository root/default. Do not
   set it to `/backend`: the backend imports the local `@impostor/api`
   workspace and depends on the root `package-lock.json`.
4. Leave dependency installation at Railpack's npm workspace detection. The
   root `package.json` and `package-lock.json` define all workspaces. If the
   service settings require an explicit install command, use `npm ci` from the
   repository root.
5. Set the following commands in the service:

   **Build command**

   ```sh
   npm run build --workspace=backend
   ```

   The backend's existing `prebuild` lifecycle runs `npm run build:api`
   first, then the backend TypeScript build emits `backend/dist/index.js`.

   **Start command**

   ```sh
   npm run start --workspace=backend
   ```

   This starts only `backend/dist/index.js`; it does not start Expo or serve
   the frontend.
6. Set the service's **Healthcheck Path** to `/health`. The endpoint returns
   HTTP 200 with a minimal status and timestamp and is exempt from the
   backend's production HTTPS redirect/rejection middleware, so Railway's
   internal health probe can reach it.
7. Leave the service at one replica. Do not enable multi-region or multiple
   replicas until room/game state, rate limits, and Socket.IO delivery are
   coordinated across instances.

Railway injects `PORT`; the backend reads it and binds to `0.0.0.0`. Socket.IO
uses its normal Engine.IO defaults, which support HTTP long-polling and upgrade
to WebSocket. Do not configure a custom transport restriction or a second
port.

## Environment variables

Configure production variables in the Railway service's Variables settings.
Do not commit production values to this repository.

### Provided by Railway

| Variable | Use |
| --- | --- |
| `PORT` | Railway-provided listening and health-check port. Do not hard-code it or add a competing value unless Railway specifically requires a manual target-port setting. |
| `RAILWAY_PUBLIC_DOMAIN` | Available after a public domain is generated. The backend does not read it automatically; use its actual value when configuring allowed origins and the mobile client's API URL. |

Other `RAILWAY_*` variables are not required by this backend.

### Configure ourselves

| Variable | Required value |
| --- | --- |
| `NODE_ENV` | `production`. This automatically enables HTTPS enforcement; there is no separate `REQUIRE_HTTPS` variable. |
| `ALLOWED_ORIGINS` | Required by production startup. Set to a comma-separated list of exact HTTPS origins. The value cannot be finalized until the Railway domain is generated. If only native mobile clients are used initially, use the actual HTTPS API origin to satisfy startup validation; add any browser frontend's exact HTTPS origin if one is deployed later. |
| `CLIENT_IP_MODE` | Set explicitly to `railway`. The backend also checks Railway's `RAILWAY_SERVICE_ID` marker and refuses startup if Railway is detected but this mode is not selected. |
| `TRUST_PROXY_HOPS` | Do not set this in Railway mode; the backend rejects it if present. It is only for the existing numeric-hop behavior on other reverse-proxy providers. |
| `SUPABASE_URL` | Optional. Set to the Supabase project URL to enable persistent guest profiles. |
| `SUPABASE_SERVICE_ROLE_KEY` | Optional server-only secret. Set together with `SUPABASE_URL`; store only in Railway's backend Variables settings. Never put it in frontend environment variables, commit it to Git, or expose it through an `EXPO_PUBLIC_` variable. |

`RECONNECT_GRACE_PERIOD_MS` is optional and defaults to `120000`. Do not set it
unless the reconnect window is intentionally being changed.

Configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` together only if
persistent guest-profile creation and restoration are being enabled. Both the
initial player-data migration and the guest-profile RPC migration must be
applied before enabling this feature. If these variables are absent, only the
persistent guest-profile endpoints remain unavailable; room creation, joining,
Socket.IO, and existing guest gameplay continue to work normally.

The guest-profile rate limiter is in memory and per instance. Keep the
single-replica recommendation above unless rate limiting and the rest of the
backend's in-memory state are coordinated across instances. Never commit
Railway account/project tokens, GitHub credentials, signing keys, or other
secrets. `EXPO_PUBLIC_API_URL` is a public frontend setting, not a secret and
not a backend variable.

### Railway client-IP trust boundary

In the explicit `CLIENT_IP_MODE=railway` production mode, the backend uses
`X-Real-IP` for Socket.IO connection and IP-based room-operation rate limits.
It accepts only one header value that parses as a bare IPv4 or IPv6 address.
Missing, invalid, comma-separated, or repeated values cause the Socket.IO
handshake to be rejected. `X-Forwarded-For` is not used for client-IP
identification in this mode. Express `trust proxy` is disabled, so the app does
not use Express's numeric hop interpretation.

This trust is valid **only** when the request reaches the backend through
Railway's public HTTP edge, which overwrites `X-Real-IP` and the forwarded
headers. It is not safe for direct private-network access or Railway raw TCP
proxy traffic. Ensure that no untrusted Railway service or other client can
connect directly to the backend listener and supply its own `X-Real-IP`.
Railway mode also uses the public edge's `X-Forwarded-Proto` for HTTPS
enforcement; it does not use that header for IP attribution. If the public-edge
trust boundary cannot be guaranteed, do not enable this mode or expose the
service.

The Railway mode does not need or infer a proxy hop count. `TRUST_PROXY_HOPS`
remains relevant only for non-Railway deployments using `CLIENT_IP_MODE=socket`;
there, configure it only from that provider's verified topology. Railway mode
is never enabled implicitly on another provider.

### Values available only after domain generation

After the backend is deployed and listening, open its service **Settings →
Networking → Public Networking** and choose **Generate Domain**. Railway-provided
public domains receive automatic SSL certificates. Copy the generated
hostname without inventing or reserving a domain:

- Set `ALLOWED_ORIGINS` to the actual HTTPS origin(s), including the scheme
  (for example, `https://` plus the generated hostname).
- Set the frontend's `EXPO_PUBLIC_API_URL` to `https://` plus that hostname.
  The app will use secure WebSockets (`wss://`) for Socket.IO.

HTTPS enforcement is enabled solely by `NODE_ENV=production`. The backend
does not require or accept `TRUST_PROXY_HOPS` in Railway mode.

## Verify the deployment later

After configuration and deployment:

1. **Health and TLS:** open `https://<actual-generated-hostname>/health` or run
   `curl -i https://<actual-generated-hostname>/health`. Confirm a valid
   certificate and HTTP 200 JSON response. A Railway-provided public domain
   uses Railway-managed SSL. Do not use insecure TLS bypass flags.
2. **HTTPS enforcement:** use the HTTPS URL in the app. A direct unencrypted
   request that reaches the backend is rejected for non-health routes; Railway
   may also handle HTTP-to-HTTPS behavior at its edge.
3. **Socket.IO:** configure the mobile app's `EXPO_PUBLIC_API_URL` with the
   generated HTTPS URL, open the app, and verify it reaches the connected state
   and can create/join a room. Socket.IO's default client/server transport
   sequence uses polling and upgrades to WebSocket. For focused checks, use a
   Socket.IO client with `transports: ["polling"]` and then
   `transports: ["websocket"]` against the generated HTTPS URL.
4. **Logs:** in Railway, open the backend service's Deployments, select the
   active deployment, and inspect its build/deploy logs. Confirm the
   structured “Backend server listening” entry and investigate errors without
   printing tokens, raw forwarded headers, or GPS coordinates.
5. **Redeploy:** after future GitHub updates are connected, pushes to the
   configured deployment branch trigger Railway deployments according to the
   service's source settings. To redeploy the same source, use the service's
   deployment action in the dashboard. Review logs and health before relying
   on the new version.

## State and scaling limitations

Rooms, reconnect credentials (stored as hashes), game sessions, timers, and
Manhunt's private location state are in memory. Restarting or redeploying loses
active rooms and games. Active games cannot safely resume after a restart;
players must create or join a new room. No database or Redis has been added.

Use exactly one backend instance for the initial deployment. Do not enable
multiple replicas until shared state, distributed rate limiting, and Socket.IO
cross-instance coordination are implemented and tested.
