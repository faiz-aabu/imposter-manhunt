import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../../supabase/migrations/20261125203600_create_durable_rooms.sql",
    import.meta.url,
  ),
  "utf8",
);
const migrationDirectory = new URL(
  "../../../supabase/migrations/",
  import.meta.url,
);
const durableReconnectMigrationName = readdirSync(migrationDirectory).find(
  (fileName) =>
    fileName.endsWith("_durable_room_reconnect_and_private_boundary.sql"),
);
assert.ok(durableReconnectMigrationName);
const durableReconnectMigration = readFileSync(
  new URL(durableReconnectMigrationName, migrationDirectory),
  "utf8",
);
const gameStatusMigrationName = readdirSync(migrationDirectory).find(
  (fileName) =>
    fileName.endsWith("_durable_room_game_status_transitions.sql"),
);
assert.ok(gameStatusMigrationName);
const gameStatusMigration = readFileSync(
  new URL(gameStatusMigrationName, migrationDirectory),
  "utf8",
);

test("room schema validates unique normalized codes, settings, lifecycle, expiry, and version", () => {
  const roomsTable = migration.match(
    /CREATE TABLE public\.rooms\s*\(([\s\S]*?)\n\);/i,
  )?.[1];
  assert.ok(roomsTable);

  assert.match(migration, /id uuid PRIMARY KEY/i);
  assert.match(migration, /room_code = upper\(btrim\(room_code\)\)/i);
  assert.match(migration, /room_code ~ '\^\[A-Z\]\{4\}\$'/i);
  assert.match(
    migration,
    /CREATE UNIQUE INDEX rooms_active_room_code_key[\s\S]*?WHERE lifecycle_status = 'active'/i,
  );
  assert.match(
    migration,
    /lifecycle_status IN \('active', 'expired', 'closed'\)/i,
  );
  assert.match(
    migration,
    /game_status IN \('waiting', 'starting', 'in_progress', 'finished'\)/i,
  );
  assert.match(migration, /created_at timestamptz NOT NULL/i);
  assert.match(migration, /updated_at timestamptz NOT NULL/i);
  assert.match(migration, /expires_at timestamptz NOT NULL/i);
  assert.match(migration, /expires_at > created_at/i);
  assert.match(migration, /version bigint NOT NULL DEFAULT 1/i);
  assert.match(migration, /CHECK \(version > 0\)/i);
  assert.match(migration, /max_players BETWEEN 2 AND 12/i);
  assert.match(migration, /settings jsonb NOT NULL/i);
  assert.match(migration, /settings ->> 'gameMode' = game_mode/i);
  assert.match(migration, /jsonb_typeof\(settings -> 'maxPlayers'\) = 'number'/i);
  assert.match(migration, /CONSTRAINT rooms_manhunt_settings_shape/i);
  assert.match(
    migration,
    /\(settings -> 'classicImpostor'\) - ARRAY\[/i,
  );
  assert.match(
    migration,
    /\(settings -> 'wordImpostor'\) - ARRAY\[/i,
  );
  assert.match(
    migration,
    /\(settings -> 'manhunt'\) - ARRAY\[\s*'hunterCount',\s*'gameDurationSeconds'/i,
  );
  assert.doesNotMatch(
    migration,
    /settings -> '(?:classicImpostor|wordImpostor|manhunt)' - ARRAY/i,
  );
  assert.doesNotMatch(roomsTable, /\b(?:boundary|latitude|longitude|coordinates)\b/i);
});

test("room player schema enforces membership keys, foreign keys, and hashed reconnect credentials", () => {
  const roomPlayersTable = migration.match(
    /CREATE TABLE public\.room_players\s*\(([\s\S]*?)\n\);/i,
  )?.[1];
  assert.ok(roomPlayersTable);

  assert.match(roomPlayersTable, /player_id uuid PRIMARY KEY/i);
  assert.match(
    roomPlayersTable,
    /room_id uuid NOT NULL REFERENCES public\.rooms \(id\)/i,
  );
  assert.match(roomPlayersTable, /UNIQUE \(room_id, player_id\)/i);
  assert.match(roomPlayersTable, /membership_status IN \('active', 'removed'\)/i);
  assert.match(
    roomPlayersTable,
    /connection_status IN \('connected', 'disconnected', 'reconnecting'\)/i,
  );
  assert.match(roomPlayersTable, /joined_at timestamptz NOT NULL/i);
  assert.match(roomPlayersTable, /last_activity_at timestamptz NOT NULL/i);
  assert.match(roomPlayersTable, /removed_at timestamptz/i);
  assert.match(roomPlayersTable, /reconnect_token_hash bytea/i);
  assert.match(roomPlayersTable, /octet_length\(reconnect_token_hash\) = 32/i);
  assert.match(roomPlayersTable, /reconnect_token_hash IS NULL/i);
  assert.doesNotMatch(roomPlayersTable, /^\s*reconnect_token\s/m);
  assert.doesNotMatch(roomPlayersTable, /^\s*socket_id\b/m);
  assert.match(
    migration,
    /FOREIGN KEY \(id, host_player_id\)\s+REFERENCES public\.room_players \(room_id, player_id\)\s+DEFERRABLE INITIALLY DEFERRED/i,
  );
  assert.match(
    migration,
    /CREATE CONSTRAINT TRIGGER room_players_active_host_membership_check[\s\S]*?DEFERRABLE INITIALLY DEFERRED/i,
  );
});

test("room tables exclude game-private fields and deny direct client access", () => {
  assert.doesNotMatch(
    migration,
    /^\s*(?:secret_word|role|roles|vote|votes|latitude|longitude|coordinates|ability_state|socket_id)\s+/im,
  );
  assert.match(migration, /ALTER TABLE public\.rooms ENABLE ROW LEVEL SECURITY/i);
  assert.match(
    migration,
    /ALTER TABLE public\.room_players ENABLE ROW LEVEL SECURITY/i,
  );
  assert.match(
    migration,
    /REVOKE ALL ON TABLE public\.rooms, public\.room_players\s+FROM PUBLIC, anon, authenticated/i,
  );
  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.rooms, public\.room_players\s+TO service_role/i,
  );
  assert.doesNotMatch(migration, /CREATE POLICY/i);
});

test("durable reconnect state has guarded deadlines and an indexed recovery path", () => {
  assert.match(
    durableReconnectMigration,
    /ADD COLUMN reconnect_deadline_at timestamptz/i,
  );
  assert.match(
    durableReconnectMigration,
    /ADD COLUMN disconnect_generation bigint NOT NULL DEFAULT 0/i,
  );
  assert.match(
    durableReconnectMigration,
    /CHECK \(disconnect_generation >= 0\)/i,
  );
  assert.match(
    durableReconnectMigration,
    /CHECK \(\s*reconnect_deadline_at IS NULL\s+OR\s*\(\s*membership_status = 'active'\s+AND\s+connection_status = 'disconnected'\s*\)\s*\)/i,
  );
  assert.match(
    durableReconnectMigration,
    /CHECK \(\s*membership_status <> 'active'\s+OR\s+connection_status <> 'disconnected'\s+OR\s+reconnect_deadline_at IS NOT NULL\s*\) NOT VALID/i,
  );
  assert.match(
    durableReconnectMigration,
    /CREATE INDEX room_players_due_reconnect_idx\s+ON public\.room_players \(reconnect_deadline_at, room_id, player_id\)\s+WHERE membership_status = 'active'\s+AND connection_status = 'disconnected'\s+AND reconnect_deadline_at IS NOT NULL/i,
  );
});

test("room expiry is optional while configured expiry remains after creation", () => {
  assert.match(
    durableReconnectMigration,
    /ALTER COLUMN expires_at DROP NOT NULL/i,
  );
  assert.match(migration, /CONSTRAINT rooms_expiry_after_creation CHECK \(expires_at > created_at\)/i);
  assert.match(
    durableReconnectMigration,
    /NULL means automatic timed expiry is not configured/i,
  );
});

test("durable game identity is nullable text and leaves legacy status rows valid", () => {
  assert.match(
    gameStatusMigration,
    /ALTER TABLE public\.rooms\s+ADD COLUMN current_game_id text;/i,
  );
  assert.doesNotMatch(gameStatusMigration, /NOT NULL|CHECK\s*\(/i);
});

test("private Manhunt boundaries enforce association, ranges, and backend-only access", () => {
  const boundariesTable = durableReconnectMigration.match(
    /CREATE TABLE public\.room_private_manhunt_boundaries\s*\(([\s\S]*?)\n\);/i,
  )?.[1];
  assert.ok(boundariesTable);

  assert.match(
    durableReconnectMigration,
    /ADD CONSTRAINT rooms_id_game_mode_unique UNIQUE \(id, game_mode\)/i,
  );
  assert.match(boundariesTable, /room_id uuid PRIMARY KEY/i);
  assert.match(boundariesTable, /room_game_mode text NOT NULL DEFAULT 'manhunt'/i);
  assert.match(boundariesTable, /CHECK \(room_game_mode = 'manhunt'\)/i);
  assert.match(
    boundariesTable,
    /FOREIGN KEY \(room_id, room_game_mode\)\s+REFERENCES public\.rooms \(id, game_mode\)\s+ON DELETE CASCADE/i,
  );
  assert.match(boundariesTable, /center_latitude numeric NOT NULL/i);
  assert.match(boundariesTable, /center_longitude numeric NOT NULL/i);
  assert.match(boundariesTable, /radius_meters numeric NOT NULL/i);
  assert.match(
    boundariesTable,
    /CHECK \(center_latitude BETWEEN -90 AND 90\)/i,
  );
  assert.match(
    boundariesTable,
    /CHECK \(center_longitude BETWEEN -180 AND 180\)/i,
  );
  assert.match(boundariesTable, /CHECK \(radius_meters BETWEEN 100 AND 1000\)/i);
  assert.match(boundariesTable, /created_at timestamptz NOT NULL DEFAULT now\(\)/i);
  assert.match(boundariesTable, /updated_at timestamptz NOT NULL DEFAULT now\(\)/i);
  assert.match(
    durableReconnectMigration,
    /ALTER TABLE public\.room_private_manhunt_boundaries ENABLE ROW LEVEL SECURITY/i,
  );
  assert.match(
    durableReconnectMigration,
    /REVOKE ALL ON TABLE public\.room_private_manhunt_boundaries\s+FROM PUBLIC, anon, authenticated/i,
  );
  assert.match(
    durableReconnectMigration,
    /GRANT SELECT, INSERT, UPDATE, DELETE\s+ON TABLE public\.room_private_manhunt_boundaries\s+TO service_role/i,
  );
  assert.doesNotMatch(durableReconnectMigration, /CREATE POLICY/i);
});
