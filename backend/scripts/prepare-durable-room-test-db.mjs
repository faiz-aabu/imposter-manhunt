import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../..");
const database = process.env.ROOM_REPOSITORY_TEST_DATABASE;
const user = process.env.ROOM_REPOSITORY_TEST_USER;

if (
  process.env.DURABLE_ROOM_CI_DATABASE !== "1"
  || database !== "durable_room_test"
  || user !== "postgres"
) {
  throw new Error(
    "Database preparation is restricted to the explicitly selected disposable durable_room_test database.",
  );
}

const migrations = [
  "20261125203600_create_durable_rooms.sql",
  "20261125211523_durable_room_reconnect_and_private_boundary.sql",
  "20261125211600_durable_room_game_status_transitions.sql",
  "20261126172000_durable_room_runtime_fencing.sql",
];
const pool = new Pool({
  host: "127.0.0.1",
  port: 55432,
  database,
  user,
  connectionTimeoutMillis: 5_000,
});
let client;

async function applyAtomically(label, operation) {
  await client.query("BEGIN");
  try {
    await operation();
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Failed to roll back ${label}.`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function ensureSupabaseRoles() {
  for (const role of ["anon", "authenticated", "service_role"]) {
    await client.query(`CREATE ROLE ${role} NOLOGIN`);
  }
}

async function insertFixtureRoom(idSuffix, roomCode, gameMode, settings) {
  const roomId = `a8100000-0000-4000-8000-${idSuffix}`;
  const hostId = `a8200000-0000-4000-8000-${idSuffix}`;
  await applyAtomically(`fixture room ${roomCode}`, async () => {
    await client.query(
      `INSERT INTO public.rooms (
         id, room_code, game_mode, settings, max_players, host_player_id,
         expires_at
       )
       VALUES ($1, $2, $3, $4::jsonb, 4, $5, clock_timestamp() + interval '1 day')`,
      [roomId, roomCode, gameMode, JSON.stringify(settings), hostId],
    );
    await client.query(
      `INSERT INTO public.room_players (
         player_id, room_id, nickname, reconnect_token_hash
       )
       VALUES ($1, $2, 'Migration Host', decode(repeat('5a', 32), 'hex'))`,
      [hostId, roomId],
    );
  });
  return { roomId, hostId };
}

try {
  client = await pool.connect();
  const existingTables = await client.query(
    `SELECT
       to_regclass('public.rooms') AS rooms,
       to_regclass('public.room_players') AS room_players,
       to_regclass('public.room_private_manhunt_boundaries') AS boundaries,
       to_regclass('public.room_runtime_fencing') AS fencing`,
  );
  assert.deepEqual(existingTables.rows[0], {
    rooms: null,
    room_players: null,
    boundaries: null,
    fencing: null,
  });
  await ensureSupabaseRoles();

  // Timestamped migrations are applied once to a fresh database; each file is atomic.
  let partialMigrationRejected = false;
  try {
    await applyAtomically("partial migration rollback probe", async () => {
      await client.query(
        "CREATE TABLE public._durable_migration_rollback_probe (id integer);",
      );
      await client.query("SELECT 1 / 0");
    });
  } catch {
    partialMigrationRejected = true;
  }
  assert.equal(partialMigrationRejected, true);
  const rollbackProbe = await client.query(
    "SELECT to_regclass('public._durable_migration_rollback_probe') AS relation",
  );
  assert.equal(rollbackProbe.rows[0]?.relation, null);

  const [initialMigration, ...additiveMigrations] = migrations;
  assert.ok(initialMigration);
  const initialSql = await readFile(
    resolve(repositoryRoot, "supabase/migrations", initialMigration),
    "utf8",
  );
  await applyAtomically(initialMigration, () => client.query(initialSql));
  console.info(`Applied ${initialMigration}`);

  const classic = await insertFixtureRoom(
    "000000000001",
    "MIGR",
    "impostor-classic",
    {
      gameMode: "impostor-classic",
      maxPlayers: 4,
      isPrivate: false,
    },
  );
  const manhunt = await insertFixtureRoom(
    "000000000002",
    "MIGM",
    "manhunt",
    {
      gameMode: "manhunt",
      maxPlayers: 4,
      isPrivate: true,
      manhunt: { hunterCount: 1, gameDurationSeconds: 1800 },
    },
  );
  const originalRoom = await client.query(
    `SELECT created_at, expires_at, version::text AS version
     FROM public.rooms WHERE id = $1`,
    [classic.roomId],
  );

  for (const migration of additiveMigrations) {
    const sql = await readFile(
      resolve(repositoryRoot, "supabase/migrations", migration),
      "utf8",
    );
    await applyAtomically(migration, () => client.query(sql));
    console.info(`Applied ${migration}`);
  }

  const preservedRoom = await client.query(
    `SELECT room_code, lifecycle_status, game_status, created_at,
            version::text AS version, current_game_id
     FROM public.rooms WHERE id = $1`,
    [classic.roomId],
  );
  assert.deepEqual(preservedRoom.rows[0], {
    room_code: "MIGR",
    lifecycle_status: "active",
    game_status: "waiting",
    created_at: originalRoom.rows[0].created_at,
    version: originalRoom.rows[0].version,
    current_game_id: null,
  });
  const preservedPlayer = await client.query(
    `SELECT player_id::text AS player_id, nickname, membership_status,
            connection_status, reconnect_deadline_at,
            disconnect_generation::text AS disconnect_generation,
            octet_length(reconnect_token_hash) AS token_hash_length
     FROM public.room_players WHERE room_id = $1`,
    [classic.roomId],
  );
  assert.deepEqual(preservedPlayer.rows[0], {
    player_id: classic.hostId,
    nickname: "Migration Host",
    membership_status: "active",
    connection_status: "connected",
    reconnect_deadline_at: null,
    disconnect_generation: "0",
    token_hash_length: 32,
  });

  await client.query(
    "UPDATE public.rooms SET expires_at = NULL WHERE id = $1",
    [classic.roomId],
  );
  const optionalExpiry = await client.query(
    "SELECT expires_at FROM public.rooms WHERE id = $1",
    [classic.roomId],
  );
  assert.equal(optionalExpiry.rows[0]?.expires_at, null);

  await client.query(
    `INSERT INTO public.room_private_manhunt_boundaries (
       room_id, center_latitude, center_longitude, radius_meters
     )
     VALUES ($1, 37.5, -122.2, 300)`,
    [manhunt.roomId],
  );
  const privateBoundary = await client.query(
    `SELECT center_latitude::text, center_longitude::text, radius_meters::text
     FROM public.room_private_manhunt_boundaries WHERE room_id = $1`,
    [manhunt.roomId],
  );
  assert.deepEqual(privateBoundary.rows[0], {
    center_latitude: "37.5",
    center_longitude: "-122.2",
    radius_meters: "300",
  });

  await assert.rejects(
    client.query(
      "UPDATE public.rooms SET game_status = 'invalid' WHERE id = $1",
      [classic.roomId],
    ),
    /rooms_game_status_valid/,
  );
  const fencingState = await client.query(
    `SELECT singleton_id, epoch::text AS epoch
     FROM public.room_runtime_fencing`,
  );
  assert.deepEqual(fencingState.rows, [{ singleton_id: 1, epoch: "0" }]);

  await applyAtomically("migration fixtures cleanup", async () => {
    await client.query("DELETE FROM public.rooms WHERE id = ANY($1::uuid[])", [
      [classic.roomId, manhunt.roomId],
    ]);
  });
  console.info("Durable-room migration compatibility checks passed.");
} finally {
  client?.release();
  await pool.end();
}
