# Durable room storage contract

The `rooms` and `room_players` tables persist room metadata and membership only. The backend must validate complete settings with the API `roomSettingsSchema`, then project the persisted JSON settings. Manhunt public settings may include `hunterCount` and `gameDurationSeconds`, but must not include the boundary or any coordinates; the authoritative boundary belongs in the separate private boundary table. The database checks JSON object shape, mode, capacity, and allowed nested keys/types. Game-specific secrets and state are deliberately out of scope.

All writes are server-only. Row-level security is enabled without client policies, privileges are revoked from `PUBLIC`, `anon`, and `authenticated`, and table access is granted to `service_role` for backend use.

Future backend operations must use transactions:

- **Create:** insert a room and its initial host membership in one transaction. Retry a room-code collision using the unique active-code index.
- **Join:** lock the room row with `FOR UPDATE`; verify it is active and accepting players; count active memberships and compare with `max_players`; insert the player and increment the room version before commit. This serializes simultaneous joins to the same room.
- **Settings/version:** validate with the API schema. The settings operation locks the room row, checks the expected room identity/version, active host, waiting status, room mode, and capacity, and increments `version` in the same transaction. Manhunt public settings exclude the boundary, which is written to the private boundary table in that same transaction.
- **Host transfer/removal:** select the replacement host, update `host_player_id`, mark the departing member `removed`, clear their reconnect-token hash, and increment the room version in one transaction. The deferred foreign key and host-membership trigger reject a committed active room without an active host. When the last member leaves, the current operation deletes the room and its dependent records in that transaction.
- **Reconnect:** locate the room and player, then compare a hash of the supplied high-entropy token in constant time in trusted backend code. The current repository validates the stored hash without rotating it. Any future token rotation/reissue must be a separately designed secure operation that stores only a new hash. Never return the stored hash or persist a socket ID.
- **Expiry:** a backend job locks due active rooms, marks them expired, invalidates member reconnect hashes, and updates versions in one transaction. A later retention policy may delete expired/closed rows; room codes are unique among active rooms and may be reused after closure or expiry.

The schema does not make the running `RoomService` fully durable. The explicitly injected create/join command path persists those operations before committing them to memory, but it is not enabled by the production entry point. Startup recovery and restoration must be integrated and tested before enabling it by default. Expiry duration, closed/expired-row retention, and reconnect-token rotation policy remain product decisions.

## Coordinator ordering and retries

The in-process room persistence coordinator serializes operations for one room and tracks only server-side room identity, lifecycle, game identity, and the committed database version. Its queue is not a distributed lock: PostgreSQL room-row locks, transaction constraints, and expected-version checks remain authoritative across processes.

The opt-in room commands guard overlapping operations on the same socket and serialize mutations for one room. Create retries are limited to confirmed violations of the active room-code unique index; each retry uses a different room code while preserving the prepared room/player identities and reconnect credential. Join, settings, leave, disconnect, reconnect, and timeout removal supply the registered durable room UUID and expected version. The repository locks the room row, checks that identity/version, and returns the committed version; the coordinator updates only from that result. Timeout removal additionally checks the persisted disconnect generation and absolute reconnect deadline. Host-transfer results identify the database-selected replacement host so runtime state cannot independently choose a different member.

For these lifecycle commands the database transaction commits before the corresponding RoomService mutation. A stale result, uncertain repository failure, metadata update failure, or post-commit memory failure must not fall back to an in-memory-only operation; the room is fenced for reconciliation instead. Socket callbacks, room updates, and player-removal events run only after both durable and runtime state have been synchronized. The process-local queue does not replace PostgreSQL row locks and expected-version checks.

The current socket protocol has no durable request ID. Same-socket overlap is rejected and an already joined socket cannot create or join again, but a client retry after losing its acknowledgement on a new connection is not yet idempotent. Do not retry an uncertain create/join by generating new credentials and assuming the previous transaction rolled back. In particular, a reconnect-token hash cannot reproduce the original raw token. A durable request-identity protocol and secure token reissue/rotation operation are required before promising retry-safe acknowledgements.

Future retries must distinguish an operation that definitely failed from one whose transaction committed but whose acknowledgement was lost:

- **Create/join:** use a stable request identity and a durable or otherwise recoverable idempotency protocol before enabling retries. A reconnect-token hash cannot reproduce the original raw token. A retry must not return a fabricated token; secure token reissue/rotation needs its own operation and tests for concurrent retries.
- **Settings:** use the expected room version. A retry after a confirmed commit is stale and must return the current/conflict result rather than incrementing the version and applying the same update again.
- **Game transitions:** use expected status, version, and current game ID. Duplicate transitions must not advance the version again; direct rematches must use a distinct new game ID.
- **Leave/disconnect/reconnect/timeout:** use expected room identity/version plus the reconnect deadline and disconnect generation where applicable. A repeated timeout with an old generation or deadline is stale and must not remove a reconnected member. Leave and timeout host transfers use the host ID returned by the committed transaction.

Do not treat callback success alone as proof that metadata changed. Update coordinator metadata only from a confirmed repository commit result, and remove it only from a confirmed room-deletion result.

## Integration-test migrations

The timestamped durable-room migrations are applied once, in chronological order, to a fresh disposable PostgreSQL database by the CI integration job. Each file runs in its own transaction; a partially applied file rolls back and fails the job. The test setup does not replay migrations or change their history, and creates only the Supabase authorization roles required by the durable-room grants inside that disposable PostgreSQL service.

## Operational limitations

- Deferred room reconciliation stops after five failed attempts. The room remains fenced and is reported in aggregate readiness diagnostics; there is no operator-triggered recovery interface. Do not clear the fence manually or assume a retry has made the room safe.
- A committed timeout removal can leave its public side effects pending if capacity or delivery fails. The runtime reports the pending count but does not replay those effects automatically, because replay could duplicate public events.
- Durable shutdown has a 30-second drain deadline. If admitted database work has not settled by then, shutdown reports a timeout while retaining the lease and pool until the work completes. A permanently stuck operation can therefore retain those resources indefinitely.
