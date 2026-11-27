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

The normal backend entry point keeps the room service and all game services in
memory. It is not wired to the durable-room runtime, so a normal process
restart loses:

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

The separately constructed `DurableRoomRuntime` has an explicit, isolated
recovery path for waiting-room metadata and reconnect credentials. It runs only
after acquiring the fenced runtime lease, restores members as disconnected,
and does not resume active games or broadcast recovered state. This recovery
path is not connected to normal backend startup or live socket handlers; it
does not change the in-memory behavior above.

If a durable disconnected-player removal commits but its gameplay or socket
side effects fail, that room's gameplay is suspended for the remainder of the
running process. Reconnect and read-only room state may remain available, but
game actions and game-state resume snapshots are blocked. The suspension is
process-local and is not an active-game recovery mechanism: controlled runtime
recovery must close any interrupted active game rather than restore its
in-memory state or reuse its game ID. There is no public operator endpoint or
automatic replay of the committed removal or its public events.

## Durable-runtime reconciliation exhaustion recovery

This procedure applies only to a deployment that explicitly constructs and
injects `DurableRoomRuntime`. The normal backend entry point and the documented
Railway start command do not enable that runtime. Confirm that the actual
deployment is intentionally running the durable runtime before using these
steps; the repository does not define a durable-runtime-specific deployment
command or process configuration.

### Identify an exhausted room

Inspect `GET /ready` and the structured backend logs together. The readiness
response's `unresolved.exhaustedReconciliations` is an aggregate count, not a
room list. A room-level exhaustion does not by itself stop the runtime from
accepting traffic, so `/ready` may still return HTTP 200. The structured log
event `deferred_room_reconciliation_exhausted` includes the room code and
attempt count; exhaustion occurs after attempt 5. Related
`deferred_room_reconciliation_failed` logs include an error class, not the
pending mutation contents.

The worker and deferred mutation queue retain the blocked mutation in process
memory. For the post-commit timeout-side-effect failure described above, the
room also remains persistence-fenced and gameplay-suspended. There is no
public endpoint to inspect or clear that state. Do not clear the fence, remove
lease records, or attempt to replay the mutation or its public events.

### Normal recovery

1. Use the deployment platform's supported process-management controls to
   gracefully stop the affected durable-runtime process. Do not invent or
   reuse a command from a deployment configuration that starts only the normal
   in-memory backend. The current Railway guide documents a dashboard
   redeployment action for that normal backend, but does not configure or
   operate `DurableRoomRuntime`; the exact action for a durable deployment is
   an operational prerequisite.
2. Wait for the platform to confirm that the old process has exited before
   starting or routing traffic to a replacement. Graceful shutdown stops
   admission and drains admitted operations and workers before releasing the
   database lease. The lease is a connection-scoped PostgreSQL advisory lock;
   the runtime will not become serving-ready unless it acquires that lock and
   verifies ownership. A replacement that cannot acquire the lease must not
   serve traffic.
3. If shutdown exceeds its 30-second drain deadline, treat the lease as still
   held: the close operation reports a timeout while draining continues, and
   the runtime retains ownership until the admitted work settles. Do not infer
   release from the timeout. If the process does not finish graceful shutdown,
   use only the platform's approved termination control after confirming the
   old process is the one being stopped. If process exit or lease release
   cannot be established, stop and escalate to the platform/database
   operator; do not launch a concurrent runtime or manually change fencing or
   lease records.
4. Start the replacement only after the previous process is confirmed stopped.
   The code does not emit a separate durable "lease released" operator event,
   and the old HTTP server is closed as shutdown proceeds. A successful
   replacement lease acquisition followed by `/ready` reporting
   `databaseLeaseOwned: true` and `durableRuntimeReadiness: "serving_ready"`
   confirms that the database lock is no longer held by the previous runtime.
   If startup reports that the lease is unavailable, do not route traffic;
   escalate rather than bypassing the lease.
5. Wait for startup recovery to finish, then verify `/ready` reports
   `acceptingTraffic: true`, `databaseLeaseOwned: true`,
   `waitingRoomRecoveryCompleted: true`, and
   `durableRuntimeReadiness: "serving_ready"`. A zero
   `unresolved.exhaustedReconciliations` after restart is not proof that the
   old mutation was replayed or resolved: reconciliation diagnostics and the
   in-memory queue are process-local and start fresh.

### What startup recovery does

While holding the lease, startup expires due active waiting rooms before
loading recoverable rooms. For remaining active waiting rooms, it removes
already-overdue disconnected members, marks connected members disconnected
with a new reconnect deadline, and preserves rooms that still have active
members. Empty waiting rooms are deleted. Only active waiting rooms are loaded
back into memory; reconnect credentials and persisted waiting-room metadata
are restored, but no socket events are replayed.

Active rooms whose game status is `starting`, `in_progress`, or `finished` are
closed rather than resumed. Recovery clears the host, increments the room
version, removes active memberships and their reconnect credentials, and
preserves the recorded game status rather than claiming the game completed.
Their prior in-memory roles, votes, timers, locations, and other game state
are not reconstructed. Users should expect an interrupted active game to end;
they must create or join a new room rather than resume that game. Already
closed or expired rooms are not restored as active rooms.

### Escalation case

Escalate when the old process cannot be confirmed stopped, the lease remains
unavailable after confirmed process exit, shutdown cleanup reports a lease or
pool-release error, or startup recovery fails. Keep the replacement out of
service until the platform/database operator confirms the owner is gone and
the replacement acquires the lease. Never delete or edit fencing/lease
records, clear a room suspension manually, or resume a game from incomplete
in-memory state.

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
