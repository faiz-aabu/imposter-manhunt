# Backend operations and deployment

The backend is a Node.js HTTP and Socket.IO service. It supports WebSocket
connections and exposes `GET /health` for a basic hosting health check.

For Railway's monorepo root, service commands, environment variables, public
domain setup, and verification steps, see the
[Railway deployment guide](../RAILWAY_DEPLOYMENT.md).

## Local development

Copy `.env.example` to `.env`. The development configuration permits HTTP for
localhost and private LAN testing. Start it from the repository root with:

```sh
npm run dev:backend
```

The default port is `3000`. If `PORT` is set by the environment, that port is
used instead. The Expo app's `EXPO_PUBLIC_API_URL` must point to an address
reachable from the device. Development wildcard CORS is intentionally not
used to authenticate clients; game actions still validate room membership and
player permissions.

## Production configuration

Deploy the repository as a single Node.js service. The runtime requires Node
`>=20.6.0`. From the repository root, install the workspaces, build the shared
API and backend, then start the backend workspace:

```sh
npm ci
npm run build:api
npm run build --workspace=backend
npm run start --workspace=backend
```

The service reads the hosting provider's `PORT` value. Configure these
environment variables in the hosting control panel rather than committing
production values:

| Variable | Production guidance |
| --- | --- |
| `NODE_ENV` | Set to `production`; only `development`, `test`, and `production` are accepted. |
| `PORT` | Let the provider assign it, or set a valid port from 1 to 65535. |
| `ALLOWED_ORIGINS` | A comma-separated list of exact HTTPS browser origins; wildcard and HTTP origins are rejected in production. |
| `CLIENT_IP_MODE` | Set explicitly to `railway` on Railway; it is not enabled automatically on other providers. |
| `TRUST_PROXY_HOPS` | Used only with `CLIENT_IP_MODE=socket` on other reverse-proxy providers. Do not set it in Railway mode. |
| `RECONNECT_GRACE_PERIOD_MS` | Optional reconnect window in milliseconds; defaults to 120000. |

Terminate TLS at the hosting provider or a reverse proxy. The frontend must use
an `https://` public API URL; Socket.IO then uses secure WebSockets. The backend
checks the forwarded protocol for production requests. Restrict network access
so clients cannot reach the backend port around the TLS proxy: forwarded
headers are trustworthy only when they are set by the configured proxy chain.
Do not invent a production domain in configuration; use the actual origin
assigned to the deployment.

On Railway, set `CLIENT_IP_MODE=railway` and leave `TRUST_PROXY_HOPS` unset.
The backend validates a single bare IPv4/IPv6 `X-Real-IP` value for Socket.IO
IP-based limits and rejects missing or malformed values. It ignores
`X-Forwarded-For` for client-IP identification and disables Express
`trust proxy`. This is trustworthy only through Railway's public HTTP edge,
which overwrites the header; it is not safe for raw TCP proxy or direct private
service access. Ensure no untrusted Railway service can connect directly to
the backend listener. See the [Railway deployment guide](../RAILWAY_DEPLOYMENT.md)
for the exact boundary and setup.

The proxy and hosting plan must support long-lived WebSocket upgrades and keep
the connection open for normal gameplay. Start with one service instance.
Multiple instances would require shared room/game state, coordinated rate
limits, and Socket.IO cross-instance delivery; the current in-memory
implementation does not provide these.

`GET /health` returns only an `ok` status and timestamp. Configure the provider
to use it as its health-check path. HTTPS enforcement intentionally exempts
this endpoint for hosting health probes; it reveals no room or game data.

## Shutdown and logs

`SIGINT` and `SIGTERM` initiate graceful shutdown. The server stops accepting
new Socket.IO connections, clears room disconnect timers and game timers, and
closes active sockets. Production HTTP and Socket.IO errors return generic
messages rather than stack traces. Logs are structured JSON; do not add
coordinates, reconnect tokens, or other player secrets to log statements.

The rate limiter is process-local and in-memory. It is suitable only as a
single-instance baseline, not as a distributed abuse-prevention control.
Continue to use hosting-level network protections and monitor logs and service
health before opening the service publicly.

## Persistent guest profile foundation

The optional backend endpoints `POST /guest-profiles` and
`POST /guest-profiles/restore` create and restore persistent guest profiles.
They are independent of room reconnect credentials; room creation, joining,
leaving, and reconnecting do not require a guest profile.

The feature is disabled unless both backend environment variables are set:

| Variable | Guidance |
| --- | --- |
| `SUPABASE_URL` | Supabase project origin, using HTTPS in production. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase service-role key. Configure it only in the backend host's secret settings or backend `.env`; never put it in frontend configuration, `EXPO_PUBLIC_` variables, source control, or logs. |

Creation returns a random 256-bit base64url credential once. The backend
submits only its SHA-256 digest to the `create_guest_profile` database RPC.
That function inserts the profile and credential in one transaction, so either
both records are created or neither is. Apply the local RPC migration before
deploying a backend version that calls it. Restoration hashes the presented
credential and requires it to be unrevoked, unexpired, and associated with an
active guest profile. Unknown, expired, and revoked credentials receive the
same generic response. Credentials expire after one year; a future
credential-renewal flow is needed before relying on long-lived guest recovery.

A lost response after a creation request has reached the database can leave the
outcome unknown. The endpoint warns that retrying may create a duplicate
profile. The current schema has no durable idempotency key, and raw credentials
are intentionally never stored, so safe replay of a creation request requires
additional idempotency design and schema support. Clients should not
automatically retry this ambiguous outcome.

Both endpoints use the existing trusted client-IP strategy and process-local
rate limiter (5 creation requests and 12 restoration requests per minute per
client IP). Production requests remain subject to the backend's HTTPS
enforcement, CORS policy, security headers, and no-store response header.
Because the limiter is in memory, this protection is per-instance and resets
on restart.

Guest-profile configuration is optional: if both variables are absent, the
backend starts and gameplay is unchanged, while these endpoints return a
feature-unavailable response. Supplying only one variable or an invalid
project URL fails configuration validation.

## Dependency audit note

The current npm audit reports four moderate package entries for one transitive
`minimatch` denial-of-service advisory (affected versions are `>=7.0.0` and
`<11.0.1`). The dependency path is
`frontend -> expo@58.0.26 -> @expo/fingerprint@0.21.10 -> minimatch@10.2.6`;
the finding is also reported against Expo consumers such as MapLibre. The
installed `minimatch` version is within `@expo/fingerprint`'s declared
`^10.2.6` range. npm's proposed remediation downgrades Expo to `52.0.49`, which
is incompatible with the required Expo SDK 58 baseline. Do not apply that
downgrade or force `minimatch` 11 outside the parent package's declared range.
Keep the warning visible and revisit it when Expo ships an SDK 58-compatible
`@expo/fingerprint` update.

## Persistence and restart behavior

The room service and all game services currently keep state in memory. A
process restart loses:

- Rooms, room membership, player connection state, and host assignments.
- Hashed reconnect tokens and the active reconnect window.
- Active game roles, votes, histories, scores, game phases, and results not
  otherwise copied by the clients.
- Manhunt team assignments, readiness, pending catch requests, countdowns,
  proximity state, precise server-held locations, and their timers.

Active games cannot safely resume after a restart. Clients may still have old
room details locally, but the backend has no authoritative room or game state;
users must create or join a new room. Do not persist precise Manhunt GPS
locations. A first release should either clearly treat restarts as ending all
active games or defer public launch until the product's restart expectations
are settled.

For a low-complexity first deployment, use one Node.js instance and no separate
database while rooms are intentionally ephemeral. If durable room metadata,
reconnects, or completed results become a release requirement, managed
PostgreSQL is the simplest next step for durable records. Keep active games
ephemeral initially and cancel them on restart; safely recovering them would
require versioned snapshots, timer reconstruction, session invalidation, and
fresh Manhunt locations. Redis is not needed for a single instance, but would
become relevant for shared rate limits, Socket.IO fanout, or ephemeral shared
state if multiple instances are introduced. Compare current provider pricing
and backup/retention terms before selecting a managed database; no provider
free tier is assumed here.
