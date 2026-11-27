import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type { QueryResultRow } from "pg";
import {
  DEFAULT_DISCUSSION_DURATION_SECONDS,
  DEFAULT_IMPOSTOR_COUNT,
  DEFAULT_VOTING_DURATION_SECONDS,
  WORD_IMPOSTOR_CATEGORIES,
} from "@impostor/api";
import type {
  GameMode,
  GameSessionId,
  GameStatus,
  ManhuntBoundary,
  RoomSettings,
} from "@impostor/api";
import {
  acquireRoomRuntimeLease,
  createPostgresPool,
} from "../db/postgres.js";
import type { Pool } from "pg";
import {
  PostgresRoomRepository,
  type CreateRoomWithHostInput,
  type TransitionRoomGameStatusInput,
  type JoinRoomInput,
  type LeaveRoomInput,
  type ListDueDisconnectedMembersInput,
  type MarkDisconnectedInput,
  type RemoveDisconnectedPlayerInput,
  type ReconnectPlayerInput,
  RoomConnectionError,
  RoomRuntimeFencingError,
  RoomJoinError,
  RoomLeaveError,
  RoomGameStatusTransitionError,
  RoomSettingsUpdateError,
} from "./postgres-room-repository.js";

interface RoomRow extends QueryResultRow {
  room_code: string;
  game_mode: string;
  max_players: number;
  host_player_id: string | null;
  expires_at: Date | null;
}

interface MembershipRow extends QueryResultRow {
  player_id: string;
  nickname: string;
  connection_status: string;
  membership_status: string;
  hash_length: number;
  hash_matches?: boolean;
}

interface ArtifactCounts extends QueryResultRow {
  room_count: number;
  member_count: number;
  boundary_count: number;
}

interface JoinStateRow extends QueryResultRow {
  version: number;
  active_count: number;
  matching_player_count: number;
}

interface JoinedMembershipRow extends QueryResultRow {
  player_id: string;
  nickname: string;
  connection_status: string;
  membership_status: string;
  hash_length: number;
  hash_matches: boolean;
  reconnect_deadline_is_null: boolean;
  disconnect_generation: number;
}

interface LeftMembershipRow extends QueryResultRow {
  membership_status: string;
  hash_is_null: boolean;
  deadline_is_null: boolean;
  removed_at_is_set: boolean;
}

function createTestPool(max = 2): Pool {
  const database = process.env.ROOM_REPOSITORY_TEST_DATABASE;
  const user = process.env.ROOM_REPOSITORY_TEST_USER;
  if (
    process.env.DURABLE_ROOM_CI_DATABASE !== "1"
    || database !== "durable_room_test"
    || user !== "postgres"
  ) {
    throw new Error(
      "Repository integration tests require the guarded disposable durable_room_test database.",
    );
  }

  return createPostgresPool({
    host: "127.0.0.1",
    port: 55432,
    database,
    user,
    password: "local-trust-auth-only",
    max,
  });
}

function createFencingTestPool(max = 3): Pool {
  const database = process.env.ROOM_RUNTIME_FENCING_TEST_DATABASE;
  const user = process.env.ROOM_RUNTIME_FENCING_TEST_USER;
  if (
    process.env.DURABLE_ROOM_CI_DATABASE !== "1"
    || database !== "durable_room_test"
    || user !== "postgres"
  ) {
    throw new Error(
      "Fencing integration tests require the guarded disposable durable_room_test database.",
    );
  }
  return createPostgresPool({
    host: "127.0.0.1",
    port: 55432,
    database,
    user,
    password: "local-trust-auth-only",
    max,
  });
}

let repositoryFencingEpoch = "0";

function createTestRepository(
  pool: Pool,
  epoch = repositoryFencingEpoch,
): PostgresRoomRepository {
  const repository = new PostgresRoomRepository(pool);
  repository.setRuntimeFencingEpoch(epoch);
  return repository;
}

function createInput(
  roomId: string,
  hostPlayerId: string,
  roomCode: string,
  settings: RoomSettings,
): CreateRoomWithHostInput {
  return {
    roomId,
    roomCode,
    gameMode: settings.gameMode,
    settings,
    maxPlayers: settings.maxPlayers,
    hostPlayerId,
    hostNickname: "Test Host",
    reconnectTokenHash: Buffer.alloc(32, 0x5a),
  };
}

function manhuntSettings(boundary: ManhuntBoundary): RoomSettings {
  return {
    gameMode: "manhunt",
    maxPlayers: 4,
    isPrivate: true,
    manhunt: {
      hunterCount: 1,
      boundary,
      gameDurationSeconds: 1_800,
    },
  };
}

function joinInput(
  roomCode: string,
  playerId: string,
  nickname = "Test Joiner",
  reconnectTokenHash = Buffer.alloc(32, 0x6b),
): JoinRoomInput {
  return { roomCode, playerId, nickname, reconnectTokenHash };
}

function leaveInput(roomCode: string, playerId: string): LeaveRoomInput {
  return { roomCode, playerId };
}

function markDisconnectedInput(
  roomCode: string,
  playerId: string,
  reconnectDeadlineAt: Date,
): MarkDisconnectedInput {
  return { roomCode, playerId, reconnectDeadlineAt };
}

function reconnectInput(
  roomCode: string,
  playerId: string,
  reconnectToken: string,
): ReconnectPlayerInput {
  return { roomCode, playerId, reconnectToken };
}

async function addActiveMember(
  pool: Pool,
  roomId: string,
  playerId: string,
  connectionStatus: "connected" | "disconnected" | "reconnecting",
  nickname: string,
  joinedAt?: string,
  reconnectTokenHash: Buffer = Buffer.alloc(32, 0x7c),
): Promise<void> {
  const reconnectDeadline = connectionStatus === "disconnected"
    ? new Date(Date.now() + 5 * 60 * 1000)
    : null;
  await pool.query(
    `INSERT INTO public.room_players (
       player_id, room_id, nickname, connection_status, membership_status,
       reconnect_token_hash, reconnect_deadline_at, joined_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))`,
    [
      playerId,
      roomId,
      nickname,
      connectionStatus,
      "active",
      reconnectTokenHash,
      reconnectDeadline,
      joinedAt ?? null,
    ],
  );
}

function hashReconnectToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

async function seedRoom(
  repository: PostgresRoomRepository,
  roomId: string,
  hostPlayerId: string,
  roomCode: string,
  settings: RoomSettings,
): Promise<CreateRoomWithHostInput> {
  const input = createInput(roomId, hostPlayerId, roomCode, settings);
  await repository.createRoomWithHost(input);
  return input;
}

let transitionRoomSequence = 0;

function transitionRoomCode(): string {
  const index = transitionRoomSequence++;
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const suffix = Array.from({ length: 3 }, (_, position) => {
    const divisor = 26 ** (2 - position);
    return letters[Math.floor(index / divisor) % 26]!;
  }).join("");
  return `G${suffix}`;
}

function settingsForGameMode(gameMode: GameMode): RoomSettings {
  if (gameMode === "impostor-classic") {
    return {
      gameMode,
      maxPlayers: 4,
      isPrivate: false,
      classicImpostor: {
        impostorCount: DEFAULT_IMPOSTOR_COUNT,
        discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
        votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
      },
    };
  }
  if (gameMode === "impostor-word") {
    return {
      gameMode,
      maxPlayers: 4,
      isPrivate: false,
      wordImpostor: {
        category: WORD_IMPOSTOR_CATEGORIES[0],
        impostorCount: DEFAULT_IMPOSTOR_COUNT,
        discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
        votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
      },
    };
  }
  return manhuntSettings({
    center: { latitude: 10, longitude: 20 },
    radiusMeters: 300,
  });
}

async function createTransitionFixture(
  pool: Pool,
  repository: PostgresRoomRepository,
  gameMode: GameMode,
): Promise<CreateRoomWithHostInput> {
  const input = createInput(
    randomUUID(),
    randomUUID(),
    transitionRoomCode(),
    settingsForGameMode(gameMode),
  );
  await repository.createRoomWithHost(input);
  return input;
}

async function setTransitionState(
  pool: Pool,
  roomId: string,
  gameStatus: GameStatus,
  currentGameId: GameSessionId | null,
  version: string,
): Promise<void> {
  await pool.query(
    `UPDATE public.rooms
     SET game_status = $2, current_game_id = $3, version = $4::bigint
     WHERE id = $1`,
    [roomId, gameStatus, currentGameId, version],
  );
}

async function assertJoinState(
  pool: Pool,
  roomId: string,
  playerId: string,
  expectedVersion: number,
  expectedActiveCount: number,
  expectedPlayerCount = 0,
): Promise<void> {
  const result = await pool.query<JoinStateRow>(
    `SELECT r.version::int AS version,
            (SELECT count(*)::int
             FROM public.room_players AS active_member
             WHERE active_member.room_id = r.id
               AND active_member.membership_status = 'active') AS active_count,
            (SELECT count(*)::int
             FROM public.room_players AS joined_member
             WHERE joined_member.room_id = r.id
               AND joined_member.player_id = $2) AS matching_player_count
     FROM public.rooms AS r
     WHERE r.id = $1`,
    [roomId, playerId],
  );
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0]?.version, expectedVersion);
  assert.equal(result.rows[0]?.active_count, expectedActiveCount);
  assert.equal(result.rows[0]?.matching_player_count, expectedPlayerCount);
}

async function cleanupRoom(pool: Pool, roomId: string): Promise<void> {
  await pool.query("DELETE FROM public.rooms WHERE id = $1", [roomId]);
}

async function assertNoRoomArtifacts(
  pool: Pool,
  roomId: string,
  hostPlayerId: string,
): Promise<void> {
  const counts = await pool.query<ArtifactCounts>(
    `SELECT
       (SELECT count(*)::int FROM public.rooms WHERE id = $1) AS room_count,
       (SELECT count(*)::int FROM public.room_players WHERE player_id = $2) AS member_count,
       (SELECT count(*)::int FROM public.room_private_manhunt_boundaries WHERE room_id = $1) AS boundary_count`,
    [roomId, hostPlayerId],
  );
  assert.deepEqual(counts.rows[0], {
    room_count: 0,
    member_count: 0,
    boundary_count: 0,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "23505"
  );
}

test("PostgresRoomRepository creates a room and host atomically", async (t) => {
  const pool = createTestPool();
  const suiteLease = await acquireRoomRuntimeLease(pool);
  repositoryFencingEpoch = suiteLease.fencingEpoch;
  t.after(async () => {
    await suiteLease.release();
    await pool.end();
  });
  const repository = createTestRepository(pool, suiteLease.fencingEpoch);

  const existingRows = await pool.query<{ count: number }>(
    `SELECT
       (SELECT count(*)::int FROM public.rooms) +
       (SELECT count(*)::int FROM public.room_players) +
       (SELECT count(*)::int FROM public.room_private_manhunt_boundaries)
       AS count`,
  );
  assert.equal(existingRows.rows[0]?.count, 0);

  await t.test("creates Classic settings and its active connected host", async (st) => {
    const input = createInput(
      "51000000-0000-4000-8000-000000000001",
      "52000000-0000-4000-8000-000000000001",
      "TCLA",
      {
        gameMode: "impostor-classic",
        maxPlayers: 4,
        isPrivate: false,
        classicImpostor: {
          impostorCount: DEFAULT_IMPOSTOR_COUNT,
          discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
          votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
        },
      },
    );
    st.after(() => cleanupRoom(pool, input.roomId));

    const created = await repository.createRoomWithHost(input);
    assert.deepEqual(created, {
      roomId: input.roomId,
      roomCode: input.roomCode,
      gameMode: "impostor-classic",
      hostPlayerId: input.hostPlayerId,
      lifecycleStatus: "active",
      currentGameId: null,
      version: "1",
    });
    assert.equal("reconnectTokenHash" in created, false);

    const rooms = await pool.query<RoomRow>(
      `SELECT room_code, game_mode, max_players, host_player_id::text,
              expires_at
       FROM public.rooms WHERE id = $1`,
      [input.roomId],
    );
    assert.equal(rooms.rowCount, 1);
    assert.deepEqual(rooms.rows[0], {
      room_code: "TCLA",
      game_mode: "impostor-classic",
      max_players: 4,
      host_player_id: input.hostPlayerId,
      expires_at: null,
    });

    const members = await pool.query<MembershipRow>(
      `SELECT player_id::text, nickname, connection_status,
              membership_status, octet_length(reconnect_token_hash)::int AS hash_length,
              reconnect_token_hash = $2 AS hash_matches
       FROM public.room_players WHERE room_id = $1`,
      [input.roomId, input.reconnectTokenHash],
    );
    assert.equal(members.rowCount, 1);
    assert.deepEqual(members.rows[0], {
      player_id: input.hostPlayerId,
      nickname: input.hostNickname,
      connection_status: "connected",
      membership_status: "active",
      hash_length: 32,
      hash_matches: true,
    });
  });

  test("PostgresRoomRepository updates waiting-room settings atomically", async (t) => {
    const pool = createTestPool(12);
    const repository = createTestRepository(pool);
    let roomSequence = 0;
    t.after(async () => {
      await pool.end();
    });

    const existingRows = await pool.query<{ count: number }>(
      `SELECT
         (SELECT count(*)::int FROM public.rooms) +
         (SELECT count(*)::int FROM public.room_players) +
         (SELECT count(*)::int FROM public.room_private_manhunt_boundaries)
         AS count`,
    );
    assert.equal(existingRows.rows[0]?.count, 0);

    async function createFixture(
      settings: RoomSettings,
    ): Promise<CreateRoomWithHostInput> {
      const suffix = String.fromCharCode(65 + roomSequence++);
      const input = createInput(
        randomUUID(),
        randomUUID(),
        `S${suffix}AA`,
        settings,
      );
      await repository.createRoomWithHost(input);
      return input;
    }

    async function stateFor(roomId: string): Promise<{
      settings: Record<string, unknown>;
      settings_text: string;
      game_mode: string;
      game_status: string;
      lifecycle_status: string;
      max_players: number;
      host_player_id: string | null;
      version: string;
      updated_at: Date;
      boundary_latitude: number | null;
      boundary_longitude: number | null;
      boundary_radius: number | null;
    }> {
      const result = await pool.query<{
        settings: Record<string, unknown>;
        settings_text: string;
        game_mode: string;
        game_status: string;
        lifecycle_status: string;
        max_players: number;
        host_player_id: string;
        version: string;
        updated_at: Date;
        boundary_latitude: number | null;
        boundary_longitude: number | null;
        boundary_radius: number | null;
      }>(
        `SELECT r.settings, r.settings::text AS settings_text,
                r.game_mode, r.game_status, r.lifecycle_status,
                r.max_players, r.host_player_id::text, r.version::text,
                r.updated_at,
                boundary.center_latitude::float8 AS boundary_latitude,
                boundary.center_longitude::float8 AS boundary_longitude,
                boundary.radius_meters::float8 AS boundary_radius
         FROM public.rooms AS r
         LEFT JOIN public.room_private_manhunt_boundaries AS boundary
           ON boundary.room_id = r.id
         WHERE r.id = $1`,
        [roomId],
      );
      assert.equal(result.rowCount, 1);
      const state = result.rows[0];
      assert.ok(state);
      return state;
    }

    function classicSettings(
      overrides: Partial<NonNullable<RoomSettings["classicImpostor"]>> = {},
    ): RoomSettings {
      return {
        gameMode: "impostor-classic",
        maxPlayers: 6,
        isPrivate: false,
        classicImpostor: {
          impostorCount: DEFAULT_IMPOSTOR_COUNT,
          discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
          votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
          ...overrides,
        },
      };
    }

    function wordSettings(
      overrides: Partial<NonNullable<RoomSettings["wordImpostor"]>> = {},
    ): RoomSettings {
      return {
        gameMode: "impostor-word",
        maxPlayers: 6,
        isPrivate: false,
        wordImpostor: {
          category: WORD_IMPOSTOR_CATEGORIES[0],
          impostorCount: DEFAULT_IMPOSTOR_COUNT,
          discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
          votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
          ...overrides,
        },
      };
    }

    function expectedPublicSettings(settings: RoomSettings): Record<string, unknown> {
      const publicSettings: Record<string, unknown> = { ...settings };
      if (settings.manhunt) {
        const { boundary, ...publicManhuntSettings } = settings.manhunt;
        void boundary;
        publicSettings.manhunt = publicManhuntSettings;
      }
      return publicSettings;
    }

    function assertBoundary(
      state: Awaited<ReturnType<typeof stateFor>>,
      boundary: ManhuntBoundary,
    ): void {
      assert.deepEqual(
        {
          center_latitude: state.boundary_latitude,
          center_longitude: state.boundary_longitude,
          radius_meters: state.boundary_radius,
        },
        {
          center_latitude: boundary.center.latitude,
          center_longitude: boundary.center.longitude,
          radius_meters: boundary.radiusMeters,
        },
      );
    }

    await t.test("host updates ordinary Impostor settings and increments version once", async (st) => {
      const initial = classicSettings();
      const fixture = await createFixture(initial);
      st.after(() => cleanupRoom(pool, fixture.roomId));
      const before = await stateFor(fixture.roomId);
      const updated = classicSettings({
        impostorCount: 2,
        discussionDurationSeconds: 180,
        votingDurationSeconds: 45,
      });

      const result = await repository.updateWaitingRoomSettings({
        roomCode: fixture.roomCode,
        requestingPlayerId: fixture.hostPlayerId,
        settings: updated,
      });

      const after = await stateFor(fixture.roomId);
      assert.deepEqual(result, {
        roomId: fixture.roomId,
        roomCode: fixture.roomCode,
        gameMode: "impostor-classic",
        lifecycleStatus: "active",
        currentGameId: null,
        version: "2",
      });
      assert.deepEqual(after.settings, updated);
      assert.equal(after.version, "2");
      assert.ok(after.updated_at > before.updated_at);
      assert.equal(after.game_status, "waiting");
      assert.equal(after.lifecycle_status, "active");
      assert.equal(after.host_player_id, fixture.hostPlayerId);
      assert.equal(after.boundary_radius, null);
    });

    await t.test("settings updates reject stale room identity and version", async (st) => {
      const fixture = await createFixture(classicSettings());
      st.after(() => cleanupRoom(pool, fixture.roomId));
      const firstUpdate = await repository.updateWaitingRoomSettings({
        roomCode: fixture.roomCode,
        requestingPlayerId: fixture.hostPlayerId,
        settings: classicSettings({ impostorCount: 2 }),
        expectedRoomId: fixture.roomId,
        expectedVersion: "1",
      });
      assert.equal(firstUpdate.version, "2");
      const before = await stateFor(fixture.roomId);

      await assert.rejects(
        repository.updateWaitingRoomSettings({
          roomCode: fixture.roomCode,
          requestingPlayerId: fixture.hostPlayerId,
          settings: classicSettings({ impostorCount: 3 }),
          expectedRoomId: randomUUID(),
          expectedVersion: "1",
        }),
        (error: unknown) =>
          error instanceof RoomSettingsUpdateError
          && error.code === "STALE_VERSION",
      );
      assert.deepEqual(await stateFor(fixture.roomId), before);
    });

    await t.test("host updates all supported Word Impostor settings", async (st) => {
      const fixture = await createFixture(wordSettings());
      st.after(() => cleanupRoom(pool, fixture.roomId));
      const updated = wordSettings({
        category: WORD_IMPOSTOR_CATEGORIES[1],
        impostorCount: 2,
        discussionDurationSeconds: 210,
        votingDurationSeconds: 50,
      });

      await repository.updateWaitingRoomSettings({
        roomCode: fixture.roomCode,
        requestingPlayerId: fixture.hostPlayerId,
        settings: updated,
      });

      const after = await stateFor(fixture.roomId);
      assert.deepEqual(after.settings, updated);
      assert.equal(after.version, "2");
      assert.equal(after.boundary_radius, null);
    });

    await t.test("host updates Manhunt settings and its separate private boundary", async (st) => {
      const initialBoundary: ManhuntBoundary = {
        center: { latitude: 40.7128, longitude: -74.006 },
        radiusMeters: 350,
      };
      const fixture = await createFixture(manhuntSettings(initialBoundary));
      st.after(() => cleanupRoom(pool, fixture.roomId));
      const updatedBoundary: ManhuntBoundary = {
        center: { latitude: 37.7749, longitude: -122.4194 },
        radiusMeters: 420,
      };
      const updated = manhuntSettings(updatedBoundary);

      const result = await repository.updateWaitingRoomSettings({
        roomCode: fixture.roomCode,
        requestingPlayerId: fixture.hostPlayerId,
        settings: updated,
      });

      const after = await stateFor(fixture.roomId);
      assert.equal(result.version, "2");
      assert.deepEqual(after.settings, expectedPublicSettings(updated));
      assertBoundary(after, updatedBoundary);
      assert.equal(after.version, "2");
    });

    await t.test("Manhunt settings JSON never contains boundary coordinates", async (st) => {
      const boundary: ManhuntBoundary = {
        center: { latitude: 34.0522, longitude: -118.2437 },
        radiusMeters: 380,
      };
      const fixture = await createFixture(manhuntSettings({
        center: { latitude: 40.7128, longitude: -74.006 },
        radiusMeters: 350,
      }));
      st.after(() => cleanupRoom(pool, fixture.roomId));

      await repository.updateWaitingRoomSettings({
        roomCode: fixture.roomCode,
        requestingPlayerId: fixture.hostPlayerId,
        settings: manhuntSettings(boundary),
      });

      const after = await stateFor(fixture.roomId);
      assert.equal(after.settings_text.includes("boundary"), false);
      assert.equal(after.settings_text.includes(String(boundary.center.latitude)), false);
      assert.equal(after.settings_text.includes(String(boundary.center.longitude)), false);
      assert.equal("boundary" in (after.settings.manhunt as object), false);
      assertBoundary(after, boundary);
    });

    await t.test("private boundary changes from the previous host selection", async (st) => {
      const initialBoundary: ManhuntBoundary = {
        center: { latitude: 48.8566, longitude: 2.3522 },
        radiusMeters: 500,
      };
      const fixture = await createFixture(manhuntSettings(initialBoundary));
      st.after(() => cleanupRoom(pool, fixture.roomId));
      const before = await stateFor(fixture.roomId);
      const updatedBoundary: ManhuntBoundary = {
        center: { latitude: 35.6762, longitude: 139.6503 },
        radiusMeters: 260,
      };
      assertBoundary(before, initialBoundary);

      await repository.updateWaitingRoomSettings({
        roomCode: fixture.roomCode,
        requestingPlayerId: fixture.hostPlayerId,
        settings: manhuntSettings(updatedBoundary),
      });

      assertBoundary(await stateFor(fixture.roomId), updatedBoundary);
    });

    await t.test("active non-host settings updates are rejected without mutation", async (st) => {
      const fixture = await createFixture(classicSettings());
      st.after(() => cleanupRoom(pool, fixture.roomId));
      const guestPlayerId = randomUUID();
      await addActiveMember(pool, fixture.roomId, guestPlayerId, "connected", "Guest");
      const before = await stateFor(fixture.roomId);

      await assert.rejects(
        repository.updateWaitingRoomSettings({
          roomCode: fixture.roomCode,
          requestingPlayerId: guestPlayerId,
          settings: classicSettings({ impostorCount: 2 }),
        }),
        (error: unknown) =>
          error instanceof RoomSettingsUpdateError && error.code === "NOT_HOST",
      );
      assert.deepEqual(await stateFor(fixture.roomId), before);
    });

    await t.test("removed former host membership cannot update settings", async (st) => {
      const fixture = await createFixture(classicSettings());
      st.after(() => cleanupRoom(pool, fixture.roomId));
      const successorId = randomUUID();
      await addActiveMember(pool, fixture.roomId, successorId, "connected", "Successor");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE public.rooms SET host_player_id = $2 WHERE id = $1",
          [fixture.roomId, successorId],
        );
        await client.query(
          `UPDATE public.room_players
           SET membership_status = 'removed',
               connection_status = 'disconnected',
               reconnect_token_hash = NULL,
               reconnect_deadline_at = NULL,
               removed_at = clock_timestamp()
           WHERE room_id = $1 AND player_id = $2`,
          [fixture.roomId, fixture.hostPlayerId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      const before = await stateFor(fixture.roomId);

      await assert.rejects(
        repository.updateWaitingRoomSettings({
          roomCode: fixture.roomCode,
          requestingPlayerId: fixture.hostPlayerId,
          settings: classicSettings({ impostorCount: 2 }),
        }),
        (error: unknown) =>
          error instanceof RoomSettingsUpdateError &&
          error.code === "MEMBERSHIP_NOT_ACTIVE",
      );
      assert.deepEqual(await stateFor(fixture.roomId), before);
    });

    await t.test("missing and inactive lifecycle states reject settings updates", async (st) => {
      await assert.rejects(
        repository.updateWaitingRoomSettings({
          roomCode: "ZZZZ",
          requestingPlayerId: randomUUID(),
          settings: classicSettings(),
        }),
        (error: unknown) =>
          error instanceof RoomSettingsUpdateError && error.code === "ROOM_NOT_FOUND",
      );

      for (const lifecycleStatus of ["closed", "expired"]) {
        const fixture = await createFixture(classicSettings());
        st.after(() => cleanupRoom(pool, fixture.roomId));
        await pool.query(
          `UPDATE public.rooms
           SET lifecycle_status = $2,
               host_player_id = CASE WHEN $2 = 'closed' THEN NULL ELSE host_player_id END
           WHERE id = $1`,
          [fixture.roomId, lifecycleStatus],
        );
        const before = await stateFor(fixture.roomId);
        await assert.rejects(
          repository.updateWaitingRoomSettings({
            roomCode: fixture.roomCode,
            requestingPlayerId: fixture.hostPlayerId,
            settings: classicSettings({ impostorCount: 2 }),
          }),
          (error: unknown) =>
            error instanceof RoomSettingsUpdateError && error.code === "ROOM_NOT_ACTIVE",
        );
        assert.deepEqual(await stateFor(fixture.roomId), before);
      }
    });

    await t.test("non-waiting game statuses reject settings updates", async (st) => {
      for (const [index, gameStatus] of [
        "starting",
        "in_progress",
        "finished",
      ].entries()) {
        const fixture = await createFixture(classicSettings());
        st.after(() => cleanupRoom(pool, fixture.roomId));
        await pool.query(
          "UPDATE public.rooms SET game_status = $2 WHERE id = $1",
          [fixture.roomId, gameStatus],
        );
        const before = await stateFor(fixture.roomId);

        await assert.rejects(
          repository.updateWaitingRoomSettings({
            roomCode: fixture.roomCode,
            requestingPlayerId: fixture.hostPlayerId,
            settings: classicSettings({ impostorCount: 2 }),
          }),
          (error: unknown) =>
            error instanceof RoomSettingsUpdateError &&
            error.code === "GAME_ALREADY_STARTED",
          `status case ${index}: ${gameStatus}`,
        );
        assert.deepEqual(await stateFor(fixture.roomId), before);
      }
    });

    await t.test("settings game-mode mismatch is rejected without mutation", async (st) => {
      const fixture = await createFixture(classicSettings());
      st.after(() => cleanupRoom(pool, fixture.roomId));
      const before = await stateFor(fixture.roomId);

      await assert.rejects(
        repository.updateWaitingRoomSettings({
          roomCode: fixture.roomCode,
          requestingPlayerId: fixture.hostPlayerId,
          settings: wordSettings(),
        }),
        (error: unknown) =>
          error instanceof RoomSettingsUpdateError &&
          error.code === "ROOM_MODE_MISMATCH",
      );
      assert.deepEqual(await stateFor(fixture.roomId), before);
    });

    await t.test("invalid or missing Manhunt boundary settings are rejected", async (st) => {
      const fixture = await createFixture(manhuntSettings({
        center: { latitude: 40.7128, longitude: -74.006 },
        radiusMeters: 350,
      }));
      st.after(() => cleanupRoom(pool, fixture.roomId));
      const before = await stateFor(fixture.roomId);
      const invalid = manhuntSettings({
        center: { latitude: 90.01, longitude: 0 },
        radiusMeters: 350,
      });

      await assert.rejects(
        repository.updateWaitingRoomSettings({
          roomCode: fixture.roomCode,
          requestingPlayerId: fixture.hostPlayerId,
          settings: invalid,
        }),
        TypeError,
      );
      await assert.rejects(
        repository.updateWaitingRoomSettings({
          roomCode: fixture.roomCode,
          requestingPlayerId: fixture.hostPlayerId,
          settings: {
            gameMode: "manhunt",
            maxPlayers: 4,
            isPrivate: true,
          },
        }),
        TypeError,
      );
      assert.deepEqual(await stateFor(fixture.roomId), before);
    });

    await t.test("boundary persistence failure rolls back public settings and version", async (st) => {
      const initialBoundary: ManhuntBoundary = {
        center: { latitude: 40.7128, longitude: -74.006 },
        radiusMeters: 350,
      };
      const fixture = await createFixture(manhuntSettings(initialBoundary));
      st.after(async () => {
        await pool.query(
          "DROP TRIGGER IF EXISTS fail_settings_boundary_for_test ON public.room_private_manhunt_boundaries",
        );
        await pool.query(
          "DROP FUNCTION IF EXISTS public.fail_settings_boundary_for_test()",
        );
        await cleanupRoom(pool, fixture.roomId);
      });
      const before = await stateFor(fixture.roomId);
      await pool.query(
        `CREATE OR REPLACE FUNCTION public.fail_settings_boundary_for_test()
         RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
           RAISE EXCEPTION 'injected boundary persistence failure';
         END;
         $$`,
      );
      await pool.query(
        `CREATE TRIGGER fail_settings_boundary_for_test
         BEFORE INSERT OR UPDATE ON public.room_private_manhunt_boundaries
         FOR EACH ROW
         EXECUTE FUNCTION public.fail_settings_boundary_for_test()`,
      );

      await assert.rejects(
        repository.updateWaitingRoomSettings({
          roomCode: fixture.roomCode,
          requestingPlayerId: fixture.hostPlayerId,
          settings: manhuntSettings({
            center: { latitude: 37.7749, longitude: -122.4194 },
            radiusMeters: 420,
          }),
        }),
        /injected boundary persistence failure/,
      );

      await pool.query(
        "DROP TRIGGER fail_settings_boundary_for_test ON public.room_private_manhunt_boundaries",
      );
      await pool.query(
        "DROP FUNCTION public.fail_settings_boundary_for_test()",
      );
      assert.deepEqual(await stateFor(fixture.roomId), before);
    });

    await t.test("concurrent updates on independent connections remain atomic", async (st) => {
      const fixture = await createFixture(manhuntSettings({
        center: { latitude: 40.7128, longitude: -74.006 },
        radiusMeters: 350,
      }));
      st.after(() => cleanupRoom(pool, fixture.roomId));
      const poolA = createTestPool(1);
      const poolB = createTestPool(1);
      st.after(async () => {
        await Promise.all([poolA.end(), poolB.end()]);
      });

      const [pidA, pidB] = await Promise.all([
        poolA.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
        poolB.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
      ]);
      assert.notEqual(pidA.rows[0]?.pid, pidB.rows[0]?.pid);

      const settingsA = manhuntSettings({
        center: { latitude: 35.6762, longitude: 139.6503 },
        radiusMeters: 280,
      });
      settingsA.manhunt!.hunterCount = 2;
      const settingsB = manhuntSettings({
        center: { latitude: 51.5074, longitude: -0.1278 },
        radiusMeters: 640,
      });
      settingsB.manhunt!.hunterCount = 3;
      const results = await Promise.all([
        createTestRepository(poolA).updateWaitingRoomSettings({
          roomCode: fixture.roomCode,
          requestingPlayerId: fixture.hostPlayerId,
          settings: settingsA,
        }),
        createTestRepository(poolB).updateWaitingRoomSettings({
          roomCode: fixture.roomCode,
          requestingPlayerId: fixture.hostPlayerId,
          settings: settingsB,
        }),
      ]);
      assert.deepEqual(
        results.map((result) => result.version).sort(),
        ["2", "3"],
      );

      const after = await stateFor(fixture.roomId);
      const hunterCount = (after.settings.manhunt as { hunterCount: number }).hunterCount;
      assert.equal(after.version, "3");
      if (hunterCount === settingsA.manhunt?.hunterCount) {
        assertBoundary(after, settingsA.manhunt.boundary);
      } else {
        assert.equal(hunterCount, settingsB.manhunt?.hunterCount);
        assertBoundary(after, settingsB.manhunt!.boundary);
      }
    });
  });

  test("PostgresRoomRepository persists authorized game-status transitions", async (t) => {
    const pool = createTestPool(12);
    const repository = createTestRepository(pool);
    const roomIds: string[] = [];
    t.after(async () => {
      try {
        for (const roomId of roomIds) {
          await cleanupRoom(pool, roomId);
        }
      } finally {
        await pool.end();
      }
    });

    const makeRoom = async (mode: GameMode) => {
      const fixture = await createTransitionFixture(pool, repository, mode);
      roomIds.push(fixture.roomId);
      return fixture;
    };
    const transition = (
      fixture: CreateRoomWithHostInput,
      expectedStatus: GameStatus,
      nextStatus: GameStatus,
      expectedVersion: string,
      expectedCurrentGameId: GameSessionId | null,
      nextGameId: GameSessionId | null,
      initiatedBy: TransitionRoomGameStatusInput["initiatedBy"],
      expectedRoomId = fixture.roomId,
    ) => {
      const fields = {
        roomCode: fixture.roomCode,
        expectedRoomId,
        expectedStatus,
        nextStatus,
        expectedVersion,
        expectedCurrentGameId,
        nextGameId,
      };
      return initiatedBy.kind === "host"
        ? repository.transitionRoomGameStatus({ ...fields, initiatedBy })
        : repository.transitionRoomGameStatus({ ...fields, initiatedBy });
    };
    const host = (fixture: CreateRoomWithHostInput) => ({
      kind: "host" as const,
      playerId: fixture.hostPlayerId,
    });
    const gameService = { kind: "game-service" as const };
    const assertTransitionError = async (
      promise: Promise<unknown>,
      code: string,
    ) => {
      await assert.rejects(
        promise,
        (error: unknown) =>
          error instanceof RoomGameStatusTransitionError
          && error.code === code,
      );
    };
    const assertState = async (
      fixture: CreateRoomWithHostInput,
      expected: {
        game_status: GameStatus;
        current_game_id: string | null;
        lifecycle_status: string;
        version: string;
      },
    ) => {
      const result = await pool.query<{
        game_status: GameStatus;
        current_game_id: string | null;
        lifecycle_status: string;
        version: string;
      }>(
        `SELECT game_status, current_game_id, lifecycle_status, version::text
         FROM public.rooms WHERE id = $1`,
        [fixture.roomId],
      );
      assert.deepEqual(result.rows[0], expected);
    };

    await t.test("rejects a stale durable room UUID even when the code and version match", async () => {
      const fixture = await makeRoom("impostor-classic");
      await assertTransitionError(
        transition(
          fixture,
          "waiting",
          "starting",
          "1",
          null,
          randomUUID(),
          host(fixture),
          randomUUID(),
        ),
        "STALE_ROOM_ID",
      );
      await assertState(fixture, {
        game_status: "waiting",
        current_game_id: null,
        lifecycle_status: "active",
        version: "1",
      });
    });

    await t.test("rejects a stale runtime fencing epoch without changing the room", async () => {
      const fixture = await makeRoom("impostor-classic");
      const staleEpoch = (BigInt(repositoryFencingEpoch) - 1n).toString();
      const staleRepository = createTestRepository(pool, staleEpoch);
      await assert.rejects(
        staleRepository.transitionRoomGameStatus({
          roomCode: fixture.roomCode,
          expectedRoomId: fixture.roomId,
          expectedStatus: "waiting",
          nextStatus: "starting",
          expectedVersion: "1",
          expectedCurrentGameId: null,
          nextGameId: randomUUID(),
          initiatedBy: host(fixture),
        }),
        RoomRuntimeFencingError,
      );
      await assertState(fixture, {
        game_status: "waiting",
        current_game_id: null,
        lifecycle_status: "active",
        version: "1",
      });
    });

    for (const gameMode of ["impostor-classic", "impostor-word"] as const) {
      await t.test(`${gameMode} supports its complete start, finish, and lobby transitions`, async () => {
        const fixture = await makeRoom(gameMode);
        const firstGameId = randomUUID();
        const before = await pool.query<{ updated_at: Date }>(
          "SELECT updated_at FROM public.rooms WHERE id = $1",
          [fixture.roomId],
        );
        const start = await transition(
          fixture,
          "waiting",
          "starting",
          "1",
          null,
          firstGameId,
          host(fixture),
        );
        assert.deepEqual(JSON.parse(JSON.stringify(start)), {
          roomId: fixture.roomId,
          roomCode: fixture.roomCode,
          gameMode,
          gameStatus: "starting",
          lifecycleStatus: "active",
          currentGameId: firstGameId,
          version: "2",
        });
        const after = await pool.query<{ updated_at: Date }>(
          "SELECT updated_at FROM public.rooms WHERE id = $1",
          [fixture.roomId],
        );
        assert.ok(after.rows[0]!.updated_at > before.rows[0]!.updated_at);

        const active = await transition(
          fixture,
          "starting",
          "in_progress",
          "2",
          firstGameId,
          firstGameId,
          gameService,
        );
        assert.equal(active.version, "3");
        assert.equal(active.currentGameId, firstGameId);
        const finished = await transition(
          fixture,
          "in_progress",
          "finished",
          "3",
          firstGameId,
          firstGameId,
          gameService,
        );
        assert.equal(finished.version, "4");
        assert.equal(finished.currentGameId, firstGameId);

        const lobby = await transition(
          fixture,
          "finished",
          "waiting",
          "4",
          firstGameId,
          null,
          host(fixture),
        );
        assert.equal(lobby.version, "5");
        assert.equal(lobby.currentGameId, null);

        const cancelledGameId = randomUUID();
        await transition(
          fixture,
          "waiting",
          "starting",
          "5",
          null,
          cancelledGameId,
          host(fixture),
        );
        const cancelled = await transition(
          fixture,
          "starting",
          "finished",
          "6",
          cancelledGameId,
          cancelledGameId,
          gameService,
        );
        assert.equal(cancelled.version, "7");
        assert.equal(cancelled.currentGameId, cancelledGameId);
        await assertState(fixture, {
          game_status: "finished",
          current_game_id: cancelledGameId,
          lifecycle_status: "active",
          version: "7",
        });
      });

      await t.test(
        "database fencing serializes an in-flight old owner before rejecting stale writes",
        {
          skip:
            !process.env.ROOM_RUNTIME_FENCING_TEST_DATABASE
            || !process.env.ROOM_RUNTIME_FENCING_TEST_USER,
        },
        async () => {
          const poolA = createFencingTestPool(4);
          const poolB = createFencingTestPool(3);
          let leaseA: Awaited<ReturnType<typeof acquireRoomRuntimeLease>> | undefined;
          let leaseB: Awaited<ReturnType<typeof acquireRoomRuntimeLease>> | undefined;
          let leaseBPromise:
            | Promise<Awaited<ReturnType<typeof acquireRoomRuntimeLease>>>
            | undefined;
          let mutationPromise:
            | ReturnType<PostgresRoomRepository["updateWaitingRoomSettings"]>
            | undefined;
          let cleanupBlocker: (() => Promise<void>) | undefined;
          let roomId: string | undefined;

          const waitForLockWait = async (needle: string): Promise<void> => {
            for (let attempt = 0; attempt < 300; attempt += 1) {
              const waiting = await poolA.query<{ pid: number }>(
                `SELECT pid
                 FROM pg_stat_activity
                 WHERE datname = current_database()
                   AND wait_event_type = 'Lock'
                   AND query LIKE $1`,
                [`%${needle}%`],
              );
              if (waiting.rowCount && waiting.rowCount > 0) {
                return;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.fail(`No PostgreSQL lock wait observed for ${needle}.`);
          };

          try {
            leaseA = await acquireRoomRuntimeLease(poolA);
            const epochA = leaseA.fencingEpoch;
            const oldRepository = createTestRepository(poolA, leaseA.fencingEpoch);
            const roomCode = randomUUID()
              .replace(/-/g, "")
              .split("")
              .map((character) =>
                String.fromCharCode(65 + (Number.parseInt(character, 16) % 26)),
              )
              .join("")
              .slice(0, 4);
            const input = createInput(
              randomUUID(),
              randomUUID(),
              roomCode,
              {
                gameMode: "impostor-classic",
                maxPlayers: 4,
                isPrivate: false,
                classicImpostor: {
                  impostorCount: DEFAULT_IMPOSTOR_COUNT,
                  discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
                  votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
                },
              },
            );
            roomId = input.roomId;
            await oldRepository.createRoomWithHost(input);

            const lockBlocker = await poolA.connect();
            let blockerTransactionOpen = false;
            cleanupBlocker = async () => {
              if (blockerTransactionOpen) {
                await lockBlocker.query("ROLLBACK");
                blockerTransactionOpen = false;
              }
              lockBlocker.release();
            };
            await lockBlocker.query("BEGIN");
            blockerTransactionOpen = true;
            await lockBlocker.query(
              "SELECT id FROM public.rooms WHERE id = $1 FOR UPDATE",
              [input.roomId],
            );
            mutationPromise = oldRepository.updateWaitingRoomSettings({
              roomCode: input.roomCode,
              requestingPlayerId: input.hostPlayerId,
              settings: {
                ...input.settings,
                maxPlayers: 5,
              },
            });
            await waitForLockWait("FROM public.rooms");

            await leaseA.release();
            leaseA = undefined;
            let leaseBResolved = false;
            leaseBPromise = acquireRoomRuntimeLease(poolB).then((lease) => {
              leaseBResolved = true;
              return lease;
            });
            await waitForLockWait("UPDATE public.room_runtime_fencing");
            assert.equal(leaseBResolved, false);

            await lockBlocker.query("COMMIT");
            blockerTransactionOpen = false;
            lockBlocker.release();
            cleanupBlocker = undefined;
            const oldMutationResult = await mutationPromise;
            assert.equal(oldMutationResult.version, "2");
            leaseB = await leaseBPromise;
            assert.ok(BigInt(leaseB.fencingEpoch) > BigInt(epochA));

            const newRepository = createTestRepository(poolB, leaseB.fencingEpoch);
            await assert.rejects(
              oldRepository.updateWaitingRoomSettings({
                roomCode: input.roomCode,
                requestingPlayerId: input.hostPlayerId,
                settings: {
                  ...input.settings,
                  maxPlayers: 6,
                },
              }),
              RoomRuntimeFencingError,
            );
            const afterStaleAttempt = await poolA.query<{
              max_players: number;
              version: string;
            }>(
              "SELECT max_players, version::text FROM public.rooms WHERE id = $1",
              [input.roomId],
            );
            assert.deepEqual(afterStaleAttempt.rows[0], {
              max_players: 5,
              version: "2",
            });

            const newMutation = await newRepository.updateWaitingRoomSettings({
              roomCode: input.roomCode,
              requestingPlayerId: input.hostPlayerId,
              settings: {
                ...input.settings,
                maxPlayers: 6,
              },
            });
            assert.equal(newMutation.version, "3");

            assert.throws(
              () => oldRepository.setRuntimeFencingEpoch(leaseB!.fencingEpoch),
              /already been assigned/,
            );
            await assert.rejects(
              oldRepository.updateWaitingRoomSettings({
                roomCode: input.roomCode,
                requestingPlayerId: input.hostPlayerId,
                settings: {
                  ...input.settings,
                  maxPlayers: 7,
                },
              }),
              RoomRuntimeFencingError,
            );

            await newRepository.prepareForRuntimeRecovery({
              now: new Date(),
              reconnectGracePeriodMs: 60_000,
            });
            const postRecoveryMutation =
              await newRepository.updateWaitingRoomSettings({
                roomCode: input.roomCode,
                requestingPlayerId: input.hostPlayerId,
                settings: {
                  ...input.settings,
                  maxPlayers: 7,
                },
              });
            assert.ok(BigInt(postRecoveryMutation.version) > BigInt(newMutation.version));
            await assert.rejects(
              oldRepository.updateWaitingRoomSettings({
                roomCode: input.roomCode,
                requestingPlayerId: input.hostPlayerId,
                settings: {
                  ...input.settings,
                  maxPlayers: 8,
                },
              }),
              RoomRuntimeFencingError,
            );
          } finally {
            if (cleanupBlocker) {
              await cleanupBlocker();
            }
            if (mutationPromise) {
              await mutationPromise.catch(() => undefined);
            }
            if (leaseBPromise) {
              const pendingLease = await leaseBPromise.catch(() => undefined);
              if (pendingLease && pendingLease !== leaseB) {
                await pendingLease.release();
              }
            }
            if (leaseB) {
              await leaseB.release();
            }
            if (leaseA) {
              await leaseA.release();
            }
            if (roomId) {
              await poolA.query("DELETE FROM public.rooms WHERE id = $1", [roomId]);
            }
            await Promise.all([poolA.end(), poolB.end()]);
          }
        },
      );
    }

    await t.test("Manhunt supports finish-to-lobby before rematch and countdown cancellation", async () => {
      const fixture = await makeRoom("manhunt");
      const firstGameId = randomUUID();
      const start = await transition(
        fixture,
        "waiting",
        "starting",
        "1",
        null,
        firstGameId,
        host(fixture),
      );
      assert.equal(start.version, "2");
      const active = await transition(
        fixture,
        "starting",
        "in_progress",
        "2",
        firstGameId,
        firstGameId,
        gameService,
      );
      assert.equal(active.version, "3");
      const finished = await transition(
        fixture,
        "in_progress",
        "finished",
        "3",
        firstGameId,
        firstGameId,
        gameService,
      );
      assert.equal(finished.version, "4");

      await assertTransitionError(
        transition(
          fixture,
          "finished",
          "starting",
          "4",
          firstGameId,
          randomUUID(),
          host(fixture),
        ),
        "INVALID_TRANSITION",
      );
      const lobby = await transition(
        fixture,
        "finished",
        "waiting",
        "4",
        firstGameId,
        null,
        host(fixture),
      );
      assert.equal(lobby.version, "5");
      assert.equal(lobby.currentGameId, null);

      const rematchGameId = randomUUID();
      const rematch = await transition(
        fixture,
        "waiting",
        "starting",
        "5",
        null,
        rematchGameId,
        host(fixture),
      );
      assert.equal(rematch.version, "6");
      assert.equal(rematch.currentGameId, rematchGameId);
      const cancelled = await transition(
        fixture,
        "starting",
        "waiting",
        "6",
        rematchGameId,
        null,
        gameService,
      );
      assert.equal(cancelled.version, "7");
      assert.equal(cancelled.currentGameId, null);
      await assertState(fixture, {
        game_status: "waiting",
        current_game_id: null,
        lifecycle_status: "active",
        version: "7",
      });
    });

    await t.test("rejects every mode, status, and initiator combination outside the matrix", async () => {
      const modes: GameMode[] = [
        "impostor-classic",
        "impostor-word",
        "manhunt",
      ];
      const statuses: GameStatus[] = [
        "waiting",
        "starting",
        "in_progress",
        "finished",
      ];
      const initiators = ["host", "game-service"] as const;
      const isAllowed = (
        mode: GameMode,
        initiator: typeof initiators[number],
        from: GameStatus,
        to: GameStatus,
      ): boolean => {
        if (initiator === "host") {
          return (
            (from === "waiting" && to === "starting")
            || (from === "finished" && to === "waiting")
          );
        }
        return (
          (from === "starting" && to === "in_progress")
          || (
            from === "starting"
            && to === "finished"
            && mode !== "manhunt"
          )
          || (from === "in_progress" && to === "finished")
          || (
            mode === "manhunt"
            && from === "starting"
            && to === "waiting"
          )
        );
      };

      for (const mode of modes) {
        const fixture = await makeRoom(mode);
        for (const initiatorKind of initiators) {
          for (const from of statuses) {
            for (const to of statuses) {
              if (isAllowed(mode, initiatorKind, from, to)) {
                continue;
              }
              const currentGameId = from === "waiting" ? null : "matrix-current";
              const nextGameId = to === "waiting"
                ? null
                : to === "starting"
                  ? "matrix-next"
                  : currentGameId ?? "matrix-next";
              await setTransitionState(
                pool,
                fixture.roomId,
                from,
                currentGameId,
                "1",
              );
              await assertTransitionError(
                transition(
                  fixture,
                  from,
                  to,
                  "1",
                  currentGameId,
                  nextGameId,
                  initiatorKind === "host" ? host(fixture) : gameService,
                ),
                "INVALID_TRANSITION",
              );
              await assertState(fixture, {
                game_status: from,
                current_game_id: currentGameId,
                lifecycle_status: "active",
                version: "1",
              });
            }
          }
        }
      }
    });

    await t.test("checks current host membership, connection, and active room lifecycle", async () => {
      const fixture = await makeRoom("impostor-classic");
      const memberId = randomUUID();
      await addActiveMember(
        pool,
        fixture.roomId,
        memberId,
        "connected",
        "Active Member",
      );
      await assertTransitionError(
        transition(
          fixture,
          "waiting",
          "starting",
          "1",
          null,
          randomUUID(),
          { kind: "host", playerId: memberId },
        ),
        "NOT_HOST",
      );

      await pool.query(
        `UPDATE public.room_players
         SET connection_status = 'disconnected',
             reconnect_deadline_at = clock_timestamp() + interval '1 minute'
         WHERE room_id = $1 AND player_id = $2`,
        [fixture.roomId, fixture.hostPlayerId],
      );
      await assertTransitionError(
        transition(
          fixture,
          "waiting",
          "starting",
          "1",
          null,
          randomUUID(),
          host(fixture),
        ),
        "HOST_NOT_CONNECTED",
      );
      await pool.query(
        `UPDATE public.room_players
         SET connection_status = 'connected', reconnect_deadline_at = NULL
         WHERE room_id = $1 AND player_id = $2`,
        [fixture.roomId, fixture.hostPlayerId],
      );

      await pool.query(
        "UPDATE public.rooms SET lifecycle_status = 'closed' WHERE id = $1",
        [fixture.roomId],
      );
      await assertTransitionError(
        transition(
          fixture,
          "waiting",
          "starting",
          "1",
          null,
          randomUUID(),
          host(fixture),
        ),
        "ROOM_NOT_ACTIVE",
      );
      await assertState(fixture, {
        game_status: "waiting",
        current_game_id: null,
        lifecycle_status: "closed",
        version: "1",
      });
    });

    await t.test("rejects removed hosts and stale status, version, or game identity without mutation", async () => {
      const fixture = await makeRoom("impostor-word");
      const newHostId = randomUUID();
      await addActiveMember(
        pool,
        fixture.roomId,
        newHostId,
        "connected",
        "New Host",
      );
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE public.rooms SET host_player_id = $2 WHERE id = $1",
          [fixture.roomId, newHostId],
        );
        await client.query(
          `UPDATE public.room_players
           SET membership_status = 'removed',
               reconnect_token_hash = NULL,
               removed_at = clock_timestamp()
           WHERE room_id = $1 AND player_id = $2`,
          [fixture.roomId, fixture.hostPlayerId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      await assertTransitionError(
        transition(
          fixture,
          "waiting",
          "starting",
          "1",
          null,
          randomUUID(),
          host(fixture),
        ),
        "MEMBERSHIP_NOT_ACTIVE",
      );

      await setTransitionState(
        pool,
        fixture.roomId,
        "waiting",
        null,
        "1",
      );
      await assertTransitionError(
        transition(
          fixture,
          "starting",
          "in_progress",
          "1",
          null,
          randomUUID(),
          gameService,
        ),
        "STALE_STATUS",
      );
      await assertTransitionError(
        transition(
          fixture,
          "waiting",
          "starting",
          "2",
          null,
          randomUUID(),
          { kind: "host", playerId: newHostId },
        ),
        "STALE_VERSION",
      );
      await assertTransitionError(
        transition(
          fixture,
          "waiting",
          "starting",
          "1",
          "stale-game",
          randomUUID(),
          { kind: "host", playerId: newHostId },
        ),
        "STALE_GAME_ID",
      );
      await setTransitionState(
        pool,
        fixture.roomId,
        "starting",
        "actual-game",
        "1",
      );
      await assertTransitionError(
        transition(
          fixture,
          "starting",
          "in_progress",
          "1",
          "different-game",
          "different-game",
          gameService,
        ),
        "STALE_GAME_ID",
      );
      await assertState(fixture, {
        game_status: "starting",
        current_game_id: "actual-game",
        lifecycle_status: "active",
        version: "1",
      });
      await setTransitionState(pool, fixture.roomId, "waiting", null, "1");
      await assertState(fixture, {
        game_status: "waiting",
        current_game_id: null,
        lifecycle_status: "active",
        version: "1",
      });
    });

    await t.test("duplicate and concurrent requests apply exactly one version increment", async (st) => {
      const fixture = await makeRoom("impostor-classic");
      const gameId = randomUUID();
      const request = {
        roomCode: fixture.roomCode,
        expectedRoomId: fixture.roomId,
        expectedStatus: "waiting" as const,
        nextStatus: "starting" as const,
        expectedVersion: "1",
        expectedCurrentGameId: null,
        nextGameId: gameId,
        initiatedBy: host(fixture),
      };
      const first = await repository.transitionRoomGameStatus(request);
      assert.equal(first.version, "2");
      await assertTransitionError(
        repository.transitionRoomGameStatus(request),
        "STALE_STATUS",
      );
      await assertState(fixture, {
        game_status: "starting",
        current_game_id: gameId,
        lifecycle_status: "active",
        version: "2",
      });

      const concurrentFixture = await makeRoom("impostor-classic");
      const poolA = createTestPool(1);
      const poolB = createTestPool(1);
      st.after(async () => {
        await Promise.all([poolA.end(), poolB.end()]);
      });
      const concurrentRequest = {
        roomCode: concurrentFixture.roomCode,
        expectedRoomId: concurrentFixture.roomId,
        expectedStatus: "waiting" as const,
        nextStatus: "starting" as const,
        expectedVersion: "1",
        expectedCurrentGameId: null,
        nextGameId: randomUUID(),
        initiatedBy: host(concurrentFixture),
      };
      const outcomes = await Promise.allSettled([
        createTestRepository(poolA).transitionRoomGameStatus(
          concurrentRequest,
        ),
        createTestRepository(poolB).transitionRoomGameStatus(
          concurrentRequest,
        ),
      ]);
      assert.equal(
        outcomes.filter((outcome) => outcome.status === "fulfilled").length,
        1,
      );
      const rejected = outcomes.find(
        (outcome): outcome is PromiseRejectedResult =>
          outcome.status === "rejected",
      );
      assert.ok(rejected);
      assert.ok(rejected.reason instanceof RoomGameStatusTransitionError);
      assert.ok(
        ["STALE_STATUS", "STALE_VERSION"].includes(rejected.reason.code),
      );
      await assertState(concurrentFixture, {
        game_status: "starting",
        current_game_id: concurrentRequest.nextGameId,
        lifecycle_status: "active",
        version: "2",
      });
    });

    await t.test("startup recovery closes a legacy non-waiting room with no game ID", async () => {
      const fixture = await makeRoom("impostor-classic");
      await setTransitionState(
        pool,
        fixture.roomId,
        "in_progress",
        null,
        "1",
      );
      const summary = await repository.prepareForRuntimeRecovery({
        now: new Date(),
        reconnectGracePeriodMs: 60_000,
      });
      assert.ok(summary.nonWaitingRoomsClosed > 0);
      await assertState(fixture, {
        game_status: "in_progress",
        current_game_id: null,
        lifecycle_status: "closed",
        version: "2",
      });
    });
  });

  test("PostgresRoomRepository loads recoverable waiting rooms without mutation", async (t) => {
    const pool = createTestPool(12);
    const repository = createTestRepository(pool, suiteLease.fencingEpoch);
    const roomIds: string[] = [];
    t.after(async () => {
      try {
        for (const roomId of roomIds) {
          await cleanupRoom(pool, roomId);
        }
      } finally {
        await pool.end();
      }
    });

    const initial = await repository.loadRecoverableWaitingRooms();
    assert.deepEqual(initial, []);
    const initialCounts = await pool.query<{ count: number }>(
      `SELECT
         (SELECT count(*)::int FROM public.rooms) +
         (SELECT count(*)::int FROM public.room_players) +
         (SELECT count(*)::int FROM public.room_private_manhunt_boundaries)
         AS count`,
    );
    assert.equal(initialCounts.rows[0]?.count, 0);

    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const encodeRoomCode = (value: number): string => {
      let remaining = value;
      let encoded = "";
      for (let position = 0; position < 3; position += 1) {
        encoded = letters[remaining % letters.length] + encoded;
        remaining = Math.floor(remaining / letters.length);
      }
      return `W${encoded}`;
    };
    const makeRoom = async (
      index: number,
      settings: RoomSettings,
      gameStatus: "waiting" | "starting" = "waiting",
    ) => {
      const suffix = index.toString().padStart(12, "0");
      const roomId = `96000000-0000-4000-8000-${suffix}`;
      const hostPlayerId = `97000000-0000-4000-8000-${suffix}`;
      const input = createInput(roomId, hostPlayerId, encodeRoomCode(index), settings);
      roomIds.push(roomId);
      const room = await repository.createRoomWithHost(input);
      if (gameStatus !== "waiting") {
        await pool.query(
          "UPDATE public.rooms SET game_status = $2 WHERE id = $1",
          [roomId, gameStatus],
        );
      }
      return { ...room, settings };
    };
    const classicSettings: RoomSettings = {
      gameMode: "impostor-classic",
      maxPlayers: 8,
      isPrivate: false,
    };

    const normalRoom = await makeRoom(1, classicSettings);
    const olderMemberId = "98000000-0000-4000-8000-000000000001";
    const laterMemberId = "98000000-0000-4000-8000-000000000002";
    const expectedReconnectHash = Buffer.alloc(32, 0x31);
    await addActiveMember(
      pool,
      normalRoom.roomId,
      olderMemberId,
      "connected",
      "Older Member",
      "2026-01-01T00:00:00.000Z",
      expectedReconnectHash,
    );
    await addActiveMember(
      pool,
      normalRoom.roomId,
      laterMemberId,
      "connected",
      "Later Member",
      "2026-01-01T00:00:00.000Z",
    );
    await repository.markDisconnected(
      markDisconnectedInput(
        normalRoom.roomCode,
        olderMemberId,
        new Date(Date.now() + 10 * 60 * 1000),
      ),
    );

    const privateBoundary: ManhuntBoundary = {
      center: { latitude: 12.3456, longitude: -45.6789 },
      radiusMeters: 350,
    };
    const manhuntRoom = await makeRoom(2, manhuntSettings(privateBoundary));
    const nonManhuntRoom = await makeRoom(3, classicSettings);
    const closedRoom = await makeRoom(4, classicSettings);
    await pool.query(
      "UPDATE public.rooms SET lifecycle_status = 'closed' WHERE id = $1",
      [closedRoom.roomId],
    );
    const activeGameRoom = await makeRoom(5, classicSettings, "starting");
    const removedMemberRoom = await makeRoom(6, classicSettings);
    const removedMemberId = "98000000-0000-4000-8000-000000000006";
    await addActiveMember(
      pool,
      removedMemberRoom.roomId,
      removedMemberId,
      "connected",
      "Departed Member",
    );
    await repository.leaveRoom({
      roomCode: removedMemberRoom.roomCode,
      playerId: removedMemberId,
    });

    const snapshot = async () => {
      const result = await pool.query<{
        room_id: string;
        version: string;
        lifecycle_status: string;
        game_status: string;
        player_id: string | null;
        membership_status: string | null;
        connection_status: string | null;
        generation: string | null;
        deadline: Date | null;
        hash_present: boolean | null;
        boundary_updated_at: Date | null;
      }>(
        `SELECT r.id::text AS room_id, r.version::text,
                r.lifecycle_status, r.game_status,
                rp.player_id::text, rp.membership_status, rp.connection_status,
                rp.disconnect_generation::text AS generation,
                rp.reconnect_deadline_at AS deadline,
                rp.reconnect_token_hash IS NOT NULL AS hash_present,
                boundary.updated_at AS boundary_updated_at
         FROM public.rooms AS r
         LEFT JOIN public.room_players AS rp ON rp.room_id = r.id
         LEFT JOIN public.room_private_manhunt_boundaries AS boundary
           ON boundary.room_id = r.id
         ORDER BY r.room_code, r.id, rp.joined_at NULLS LAST, rp.player_id NULLS LAST`,
      );
      return result.rows;
    };
    const beforeLoad = await snapshot();
    const loaded = await repository.loadRecoverableWaitingRooms();

    assert.deepEqual(
      loaded.map((room) => room.roomCode),
      [
        normalRoom.roomCode,
        manhuntRoom.roomCode,
        nonManhuntRoom.roomCode,
        removedMemberRoom.roomCode,
      ],
    );
    const loadedNormal = loaded[0];
    assert.ok(loadedNormal);
    assert.deepEqual(
      loadedNormal.members.map((member) => member.playerId),
      [olderMemberId, laterMemberId, normalRoom.hostPlayerId],
    );
    assert.equal(loadedNormal.roomId, normalRoom.roomId);
    assert.equal(loadedNormal.gameMode, "impostor-classic");
    assert.equal(loadedNormal.lifecycleStatus, "active");
    assert.equal(loadedNormal.gameStatus, "waiting");
    assert.equal(loadedNormal.version, "2");
    assert.equal(loadedNormal.currentGameId, null);
    const disconnectedMember = loadedNormal.members[0];
    assert.ok(disconnectedMember);
    assert.equal(disconnectedMember.nickname, "Older Member");
    assert.equal(disconnectedMember.membershipStatus, "active");
    assert.equal(disconnectedMember.connectionStatus, "disconnected");
    assert.equal(disconnectedMember.disconnectGeneration, "1");
    assert.equal(disconnectedMember.joinedAt.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(Buffer.compare(disconnectedMember.reconnectTokenHash, expectedReconnectHash), 0);
    assert.ok(disconnectedMember.reconnectDeadlineAt instanceof Date);
    assert.equal("socketId" in disconnectedMember, false);

    const loadedManhunt = loaded[1];
    assert.ok(loadedManhunt);
    assert.deepEqual(loadedManhunt.privateManhuntBoundary, privateBoundary);
    assert.deepEqual(loadedManhunt.settings.manhunt, {
      hunterCount: 1,
      gameDurationSeconds: 1_800,
    });
    assert.equal(
      loadedManhunt.settings.manhunt
        ? "boundary" in loadedManhunt.settings.manhunt
        : false,
      false,
    );
    assert.equal(loaded[2]?.privateManhuntBoundary, null);
    assert.deepEqual(
      loaded.find((room) => room.roomId === removedMemberRoom.roomId)?.members
        .map((member) => member.playerId),
      [removedMemberRoom.hostPlayerId],
    );
    assert.equal(loaded.some((room) => room.roomId === closedRoom.roomId), false);
    assert.equal(loaded.some((room) => room.roomId === activeGameRoom.roomId), false);

    const poolA = createTestPool(1);
    const poolB = createTestPool(1);
    try {
      const [pidA, pidB] = await Promise.all([
        poolA.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
        poolB.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
      ]);
      assert.notEqual(pidA.rows[0]?.pid, pidB.rows[0]?.pid);
      const [loadedA, loadedB] = await Promise.all([
        createTestRepository(poolA).loadRecoverableWaitingRooms(),
        createTestRepository(poolB).loadRecoverableWaitingRooms(),
      ]);
      const withoutReconnectHashes = (rooms: typeof loaded) =>
        rooms.map(({ members, ...room }) => ({
          ...room,
          members: members.map(({ reconnectTokenHash, ...member }) => ({
            ...member,
            reconnectTokenHashLength: reconnectTokenHash.length,
          })),
        }));
      assert.deepEqual(
        withoutReconnectHashes(loadedA),
        withoutReconnectHashes(loaded),
      );
      assert.deepEqual(
        withoutReconnectHashes(loadedB),
        withoutReconnectHashes(loaded),
      );
      for (let roomIndex = 0; roomIndex < loaded.length; roomIndex += 1) {
        const expectedRoom = loaded[roomIndex];
        const actualRoomA = loadedA[roomIndex];
        const actualRoomB = loadedB[roomIndex];
        assert.ok(expectedRoom && actualRoomA && actualRoomB);
        for (let memberIndex = 0; memberIndex < expectedRoom.members.length; memberIndex += 1) {
          const expectedMember = expectedRoom.members[memberIndex];
          const memberA = actualRoomA.members[memberIndex];
          const memberB = actualRoomB.members[memberIndex];
          assert.ok(expectedMember && memberA && memberB);
          assert.equal(
            Buffer.compare(memberA.reconnectTokenHash, expectedMember.reconnectTokenHash),
            0,
          );
          assert.equal(
            Buffer.compare(memberB.reconnectTokenHash, expectedMember.reconnectTokenHash),
            0,
          );
        }
      }
    } finally {
      await Promise.all([poolA.end(), poolB.end()]);
    }
    assert.deepEqual(await snapshot(), beforeLoad);

    await t.test("does not invent a player for a room with no active membership", async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "DELETE FROM public.room_players WHERE room_id = $1",
          [normalRoom.roomId],
        );
        const clientPool = {
          query: client.query.bind(client),
        } as unknown as Pool;
        const withNoMembers = await createTestRepository(
          clientPool,
        ).loadRecoverableWaitingRooms();
        const emptyRoom = withNoMembers.find(
          (room) => room.roomId === normalRoom.roomId,
        );
        assert.ok(emptyRoom);
        assert.equal(emptyRoom.hostPlayerId, normalRoom.hostPlayerId);
        assert.deepEqual(emptyRoom.members, []);
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    });

    await t.test("fails safely when a Manhunt waiting room lacks its private boundary", async () => {
      const incompleteManhunt = await makeRoom(
        7,
        manhuntSettings({
          center: { latitude: 1, longitude: 2 },
          radiusMeters: 250,
        }),
      );
      await pool.query(
        "DELETE FROM public.room_private_manhunt_boundaries WHERE room_id = $1",
        [incompleteManhunt.roomId],
      );
      await assert.rejects(
        repository.loadRecoverableWaitingRooms(),
        /missing valid private recovery data/,
      );
    });
  });

  await t.test("joins rooms atomically", async (t) => {
    const pool = createTestPool();
    t.after(async () => {
      await pool.end();
    });
    const repository = createTestRepository(pool);

    const existingRows = await pool.query<{ count: number }>(
      `SELECT
         (SELECT count(*)::int FROM public.rooms) +
         (SELECT count(*)::int FROM public.room_players) +
         (SELECT count(*)::int FROM public.room_private_manhunt_boundaries)
         AS count`,
    );
    assert.equal(existingRows.rows[0]?.count, 0);

    await t.test("joins a waiting Classic room with a complete membership", async (st) => {
      const room = await seedRoom(
        repository,
        "61000000-0000-4000-8000-000000000001",
        "62000000-0000-4000-8000-000000000001",
        "JCLA",
        {
          gameMode: "impostor-classic",
          maxPlayers: 4,
          isPrivate: false,
        },
      );
      const playerId = "63000000-0000-4000-8000-000000000001";
      const input = joinInput(room.roomCode, playerId);
      st.after(() => cleanupRoom(pool, room.roomId));

      const joined = await repository.joinRoom(input);
      assert.deepEqual(joined, {
        roomId: room.roomId,
        roomCode: room.roomCode,
        gameMode: "impostor-classic",
        playerId,
        lifecycleStatus: "active",
        currentGameId: null,
        version: "2",
      });
      const membership = await pool.query<JoinedMembershipRow>(
        `SELECT player_id::text, nickname, connection_status, membership_status,
                octet_length(reconnect_token_hash)::int AS hash_length,
                reconnect_token_hash = $2 AS hash_matches,
                reconnect_deadline_at IS NULL AS reconnect_deadline_is_null,
                disconnect_generation::int
         FROM public.room_players
         WHERE room_id = $1 AND player_id = $3`,
        [room.roomId, input.reconnectTokenHash, playerId],
      );
      assert.deepEqual(membership.rows[0], {
        player_id: playerId,
        nickname: input.nickname,
        connection_status: "connected",
        membership_status: "active",
        hash_length: 32,
        hash_matches: true,
        reconnect_deadline_is_null: true,
        disconnect_generation: 0,
      });
      await assertJoinState(pool, room.roomId, playerId, 2, 2, 1);
    });

    await t.test("checks durable room identity and expected version before joining", async (st) => {
      const room = await seedRoom(
        repository,
        "61000000-0000-4000-8000-000000000011",
        "62000000-0000-4000-8000-000000000011",
        "JVER",
        {
          gameMode: "impostor-classic",
          maxPlayers: 4,
          isPrivate: false,
        },
      );
      st.after(() => cleanupRoom(pool, room.roomId));
      const wrongIdentityId = randomUUID();

      await assert.rejects(
        repository.joinRoom({
          ...joinInput(room.roomCode, "63000000-0000-4000-8000-000000000011"),
          expectedRoomId: wrongIdentityId,
          expectedVersion: "1",
        }),
        (error: unknown) =>
          error instanceof RoomJoinError && error.code === "STALE_VERSION",
      );
      await assertJoinState(
        pool,
        room.roomId,
        "63000000-0000-4000-8000-000000000011",
        1,
        1,
        0,
      );

      const playerId = "63000000-0000-4000-8000-000000000012";
      const joined = await repository.joinRoom({
        ...joinInput(room.roomCode, playerId),
        expectedRoomId: room.roomId,
        expectedVersion: "1",
      });
      assert.equal(joined.version, "2");
      assert.equal(joined.roomId, room.roomId);

      const stalePlayerId = "63000000-0000-4000-8000-000000000013";
      await assert.rejects(
        repository.joinRoom({
          ...joinInput(room.roomCode, stalePlayerId),
          expectedRoomId: room.roomId,
          expectedVersion: "1",
        }),
        (error: unknown) =>
          error instanceof RoomJoinError && error.code === "STALE_VERSION",
      );
      await assertJoinState(
        pool,
        room.roomId,
        stalePlayerId,
        2,
        2,
        0,
      );
    });

    await t.test("joins a waiting Word room", async (st) => {
      const room = await seedRoom(
        repository,
        "61000000-0000-4000-8000-000000000002",
        "62000000-0000-4000-8000-000000000002",
        "JWRD",
        {
          gameMode: "impostor-word",
          maxPlayers: 5,
          isPrivate: false,
          wordImpostor: {
            category: WORD_IMPOSTOR_CATEGORIES[0],
            impostorCount: DEFAULT_IMPOSTOR_COUNT,
            discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
            votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
          },
        },
      );
      const playerId = "63000000-0000-4000-8000-000000000002";
      st.after(() => cleanupRoom(pool, room.roomId));

      const joined = await repository.joinRoom(joinInput(room.roomCode, playerId));
      assert.equal(joined.gameMode, "impostor-word");
      assert.equal(joined.playerId, playerId);
      await assertJoinState(pool, room.roomId, playerId, 2, 2, 1);
    });

    await t.test("joins a waiting Manhunt room without returning its private boundary", async (st) => {
      const boundary = {
        center: { latitude: 40.7128, longitude: -74.006 },
        radiusMeters: 350,
      };
      const room = await seedRoom(
        repository,
        "61000000-0000-4000-8000-000000000003",
        "62000000-0000-4000-8000-000000000003",
        "JMHN",
        manhuntSettings(boundary),
      );
      const playerId = "63000000-0000-4000-8000-000000000003";
      st.after(() => cleanupRoom(pool, room.roomId));

      const joined = await repository.joinRoom(joinInput(room.roomCode, playerId));
      assert.equal(joined.gameMode, "manhunt");
      assert.equal(joined.playerId, playerId);
      assert.equal(JSON.stringify(joined).includes("40.7128"), false);
      assert.equal(JSON.stringify(joined).includes("-74.006"), false);
      await assertJoinState(pool, room.roomId, playerId, 2, 2, 1);
    });

    await t.test("disconnected active members occupy room capacity", async (st) => {
      const room = await seedRoom(
        repository,
        "61000000-0000-4000-8000-000000000004",
        "62000000-0000-4000-8000-000000000004",
        "JDSC",
        {
          gameMode: "impostor-classic",
          maxPlayers: 2,
          isPrivate: false,
        },
      );
      const disconnectedId = "64000000-0000-4000-8000-000000000001";
      const attemptedId = "63000000-0000-4000-8000-000000000004";
      st.after(() => cleanupRoom(pool, room.roomId));
      await pool.query(
        `INSERT INTO public.room_players (
           player_id, room_id, nickname, connection_status,
           membership_status, reconnect_token_hash, reconnect_deadline_at
         ) VALUES ($1, $2, $3, $4, $5, $6, now() + interval '2 minutes')`,
        [
          disconnectedId,
          room.roomId,
          "Disconnected",
          "disconnected",
          "active",
          Buffer.alloc(32, 0x7a),
        ],
      );

      await assert.rejects(
        repository.joinRoom(joinInput(room.roomCode, attemptedId)),
        (error: unknown) =>
          error instanceof RoomJoinError && error.code === "ROOM_FULL",
      );
      await assertJoinState(pool, room.roomId, attemptedId, 1, 2);
    });

    await t.test("rejects a full room without changing its version or memberships", async (st) => {
      const room = await seedRoom(
        repository,
        "61000000-0000-4000-8000-000000000005",
        "62000000-0000-4000-8000-000000000005",
        "JFUL",
        {
          gameMode: "impostor-classic",
          maxPlayers: 2,
          isPrivate: false,
        },
      );
      const existingPlayerId = "64000000-0000-4000-8000-000000000002";
      const attemptedId = "63000000-0000-4000-8000-000000000005";
      st.after(() => cleanupRoom(pool, room.roomId));
      await pool.query(
        `INSERT INTO public.room_players (
           player_id, room_id, nickname, reconnect_token_hash
         ) VALUES ($1, $2, $3, $4)`,
        [
          existingPlayerId,
          room.roomId,
          "Existing",
          Buffer.alloc(32, 0x7b),
        ],
      );

      await assert.rejects(
        repository.joinRoom(joinInput(room.roomCode, attemptedId)),
        (error: unknown) =>
          error instanceof RoomJoinError && error.code === "ROOM_FULL",
      );
      await assertJoinState(pool, room.roomId, attemptedId, 1, 2);
    });

    await t.test("rejects a nonexistent room", async () => {
      await assert.rejects(
        repository.joinRoom(joinInput("JNOF", "63000000-0000-4000-8000-000000000006")),
        (error: unknown) =>
          error instanceof RoomJoinError && error.code === "ROOM_NOT_FOUND",
      );
    });

    await t.test("rejects closed and expired lifecycle states", async (st) => {
      const cases = [
        {
          roomId: "61000000-0000-4000-8000-000000000006",
          hostId: "62000000-0000-4000-8000-000000000006",
          playerId: "63000000-0000-4000-8000-000000000007",
          roomCode: "JCLS",
          lifecycle: "closed",
          errorCode: "ROOM_NOT_ACCEPTING_JOINS",
        },
        {
          roomId: "61000000-0000-4000-8000-000000000007",
          hostId: "62000000-0000-4000-8000-000000000007",
          playerId: "63000000-0000-4000-8000-000000000008",
          roomCode: "JEXP",
          lifecycle: "expired",
          errorCode: "ROOM_EXPIRED_OR_CLOSED",
        },
      ] as const;

      for (const scenario of cases) {
        await st.test(`${scenario.lifecycle} room rejects a join`, async (caseTest) => {
          const room = await seedRoom(
            repository,
            scenario.roomId,
            scenario.hostId,
            scenario.roomCode,
            {
              gameMode: "impostor-classic",
              maxPlayers: 4,
              isPrivate: false,
            },
          );
          caseTest.after(() => cleanupRoom(pool, room.roomId));
          await pool.query(
            "UPDATE public.rooms SET lifecycle_status = $2 WHERE id = $1",
            [room.roomId, scenario.lifecycle],
          );
          await assert.rejects(
            repository.joinRoom(joinInput(room.roomCode, scenario.playerId)),
            (error: unknown) =>
              error instanceof RoomJoinError && error.code === scenario.errorCode,
          );
          await assertJoinState(pool, room.roomId, scenario.playerId, 1, 1);
        });
      }
    });

    await t.test("rejects a room whose configured expiry has passed", async (st) => {
      const room = await seedRoom(
        repository,
        "61000000-0000-4000-8000-000000000008",
        "62000000-0000-4000-8000-000000000008",
        "JTIM",
        {
          gameMode: "impostor-classic",
          maxPlayers: 4,
          isPrivate: false,
        },
      );
      const playerId = "63000000-0000-4000-8000-000000000009";
      st.after(() => cleanupRoom(pool, room.roomId));
      await pool.query(
        `UPDATE public.rooms
         SET created_at = now() - interval '1 hour',
             expires_at = now() - interval '1 minute'
         WHERE id = $1`,
        [room.roomId],
      );

      await assert.rejects(
        repository.joinRoom(joinInput(room.roomCode, playerId)),
        (error: unknown) =>
          error instanceof RoomJoinError && error.code === "ROOM_EXPIRED_OR_CLOSED",
      );
      await assertJoinState(pool, room.roomId, playerId, 1, 1);
    });

    await t.test("accepts a room with NULL expiry", async (st) => {
      const room = await seedRoom(
        repository,
        "61000000-0000-4000-8000-000000000009",
        "62000000-0000-4000-8000-000000000009",
        "JNUL",
        {
          gameMode: "impostor-classic",
          maxPlayers: 4,
          isPrivate: false,
        },
      );
      const playerId = "63000000-0000-4000-8000-000000000010";
      st.after(() => cleanupRoom(pool, room.roomId));
      const expiry = await pool.query<{ is_null: boolean }>(
        "SELECT expires_at IS NULL AS is_null FROM public.rooms WHERE id = $1",
        [room.roomId],
      );
      assert.equal(expiry.rows[0]?.is_null, true);

      const joined = await repository.joinRoom(joinInput(room.roomCode, playerId));
      assert.equal(joined.playerId, playerId);
      await assertJoinState(pool, room.roomId, playerId, 2, 2, 1);
    });

    await t.test("rejects games that are no longer waiting", async (st) => {
      const statuses = [
        { gameStatus: "starting", suffix: "1", roomCode: "JGSA" },
        { gameStatus: "in_progress", suffix: "2", roomCode: "JGSB" },
        { gameStatus: "finished", suffix: "3", roomCode: "JGSC" },
      ] as const;
      for (const { gameStatus, suffix, roomCode } of statuses) {
        await st.test(`${gameStatus} game rejects a join`, async (caseTest) => {
          const room = await seedRoom(
            repository,
            `61000000-0000-4000-8000-00000000001${suffix}`,
            `62000000-0000-4000-8000-00000000001${suffix}`,
            roomCode,
            {
              gameMode: "impostor-classic",
              maxPlayers: 4,
              isPrivate: false,
            },
          );
          const playerId = `63000000-0000-4000-8000-00000000001${suffix}`;
          caseTest.after(() => cleanupRoom(pool, room.roomId));
          await pool.query(
            "UPDATE public.rooms SET game_status = $2 WHERE id = $1",
            [room.roomId, gameStatus],
          );
          await assert.rejects(
            repository.joinRoom(joinInput(room.roomCode, playerId)),
            (error: unknown) =>
              error instanceof RoomJoinError && error.code === "GAME_ALREADY_STARTED",
          );
          await assertJoinState(pool, room.roomId, playerId, 1, 1);
        });
      }
    });

    await t.test("rejects a duplicate player UUID without changing the existing member", async (st) => {
      const room = await seedRoom(
        repository,
        "61000000-0000-4000-8000-000000000013",
        "62000000-0000-4000-8000-000000000013",
        "JDUP",
        {
          gameMode: "impostor-classic",
          maxPlayers: 4,
          isPrivate: false,
        },
      );
      st.after(() => cleanupRoom(pool, room.roomId));

      await assert.rejects(
        repository.joinRoom(joinInput(room.roomCode, room.hostPlayerId, "Changed Host")),
        (error: unknown) =>
          error instanceof RoomJoinError && error.code === "PLAYER_ALREADY_EXISTS",
      );
      const host = await pool.query<{
        nickname: string;
        connection_status: string;
        membership_status: string;
        hash_length: number;
      }>(
        `SELECT nickname, connection_status, membership_status,
                octet_length(reconnect_token_hash)::int AS hash_length
         FROM public.room_players WHERE player_id = $1`,
        [room.hostPlayerId],
      );
      assert.deepEqual(host.rows[0], {
        nickname: room.hostNickname,
        connection_status: "connected",
        membership_status: "active",
        hash_length: 32,
      });
      await assertJoinState(pool, room.roomId, room.hostPlayerId, 1, 1, 1);
    });

    await t.test("serializes simultaneous joins on two independent PostgreSQL connections", async (st) => {
      const room = await seedRoom(
        repository,
        "61000000-0000-4000-8000-000000000014",
        "62000000-0000-4000-8000-000000000014",
        "JCON",
        {
          gameMode: "impostor-classic",
          maxPlayers: 2,
          isPrivate: false,
        },
      );
      const poolA = createTestPool(1);
      const poolB = createTestPool(1);
      st.after(async () => {
        await Promise.all([poolA.end(), poolB.end()]);
      });
      st.after(() => cleanupRoom(pool, room.roomId));

      const [backendA, backendB] = await Promise.all([
        poolA.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
        poolB.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
      ]);
      assert.notEqual(backendA.rows[0]?.pid, backendB.rows[0]?.pid);

      const playerA = "63000000-0000-4000-8000-000000000014";
      const playerB = "63000000-0000-4000-8000-000000000015";
      const results = await Promise.allSettled([
        createTestRepository(poolA).joinRoom(joinInput(room.roomCode, playerA)),
        createTestRepository(poolB).joinRoom(joinInput(room.roomCode, playerB)),
      ]);
      const successful = results.filter((result) => result.status === "fulfilled");
      const failed = results.filter((result) => result.status === "rejected");
      assert.equal(successful.length, 1);
      assert.equal(failed.length, 1);
      if (failed[0]?.status !== "rejected") {
        assert.fail("Expected one concurrent join to be rejected.");
      }
      assert.ok(failed[0].reason instanceof RoomJoinError);
      assert.equal(failed[0].reason.code, "ROOM_FULL");

      const winnerId = successful[0]?.status === "fulfilled"
        ? successful[0].value.playerId
        : "";
      const loserId = winnerId === playerA ? playerB : playerA;
      await assertJoinState(pool, room.roomId, winnerId, 2, 2, 1);
      const loser = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM public.room_players
         WHERE room_id = $1 AND player_id = $2`,
        [room.roomId, loserId],
      );
      assert.equal(loser.rows[0]?.count, 0);
    });
  });

  await t.test("creates a Word room with its host", async (st) => {
    const input = createInput(
      "51000000-0000-4000-8000-000000000002",
      "52000000-0000-4000-8000-000000000002",
      "TWRD",
      {
        gameMode: "impostor-word",
        maxPlayers: 5,
        isPrivate: false,
        wordImpostor: {
          category: WORD_IMPOSTOR_CATEGORIES[0],
          impostorCount: DEFAULT_IMPOSTOR_COUNT,
          discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
          votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
        },
      },
    );
    st.after(() => cleanupRoom(pool, input.roomId));

    const created = await repository.createRoomWithHost(input);
    assert.equal(created.gameMode, "impostor-word");
    const members = await pool.query<MembershipRow>(
      `SELECT player_id::text, nickname, connection_status,
              membership_status, octet_length(reconnect_token_hash)::int AS hash_length
       FROM public.room_players WHERE room_id = $1`,
      [input.roomId],
    );
    assert.equal(members.rows[0]?.player_id, input.hostPlayerId);
    assert.equal(members.rows[0]?.membership_status, "active");
  });

  await t.test("stores Manhunt boundary separately from room settings", async (st) => {
    const boundary: ManhuntBoundary = {
      center: { latitude: 40.7128, longitude: -74.006 },
      radiusMeters: 350,
    };
    const input = createInput(
      "51000000-0000-4000-8000-000000000003",
      "52000000-0000-4000-8000-000000000003",
      "TMNH",
      manhuntSettings(boundary),
    );
    st.after(() => cleanupRoom(pool, input.roomId));

    const created = await repository.createRoomWithHost(input);
    assert.equal(created.gameMode, "manhunt");

    const roomSettings = await pool.query<{
      boundary_is_absent: boolean;
      hunter_count: number;
    }>(
      `SELECT settings #> '{manhunt,boundary}' IS NULL AS boundary_is_absent,
              (settings #>> '{manhunt,hunterCount}')::int AS hunter_count
       FROM public.rooms WHERE id = $1`,
      [input.roomId],
    );
    assert.deepEqual(roomSettings.rows[0], {
      boundary_is_absent: true,
      hunter_count: 1,
    });

    const boundaries = await pool.query<{
      center_latitude: number;
      center_longitude: number;
      radius_meters: number;
    }>(
      `SELECT center_latitude::float8 AS center_latitude,
              center_longitude::float8 AS center_longitude,
              radius_meters::float8 AS radius_meters
       FROM public.room_private_manhunt_boundaries WHERE room_id = $1`,
      [input.roomId],
    );
    assert.deepEqual(boundaries.rows[0], {
      center_latitude: boundary.center.latitude,
      center_longitude: boundary.center.longitude,
      radius_meters: boundary.radiusMeters,
    });
  });

  await t.test("rejects Manhunt creation without a boundary", async (st) => {
    const input = createInput(
      "51000000-0000-4000-8000-000000000004",
      "52000000-0000-4000-8000-000000000004",
      "TNOB",
      {
        gameMode: "manhunt",
        maxPlayers: 4,
        isPrivate: false,
      },
    );
    st.after(() => cleanupRoom(pool, input.roomId));

    await assert.rejects(
      repository.createRoomWithHost(input),
      TypeError,
    );
    await assertNoRoomArtifacts(pool, input.roomId, input.hostPlayerId);
  });

  await t.test("rejects Impostor rooms with Manhunt settings", async (st) => {
    const boundary = {
      center: { latitude: 40, longitude: -74 },
      radiusMeters: 350,
    };
    const inputs = [
      createInput(
        "51000000-0000-4000-8000-000000000005",
        "52000000-0000-4000-8000-000000000005",
        "TIMB",
        {
          gameMode: "impostor-classic",
          maxPlayers: 4,
          isPrivate: false,
          manhunt: { hunterCount: 1, boundary },
        },
      ),
      createInput(
        "51000000-0000-4000-8000-000000000011",
        "52000000-0000-4000-8000-000000000011",
        "TWMB",
        {
          gameMode: "impostor-word",
          maxPlayers: 4,
          isPrivate: false,
          wordImpostor: {
            category: WORD_IMPOSTOR_CATEGORIES[0],
            impostorCount: DEFAULT_IMPOSTOR_COUNT,
            discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
            votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
          },
          manhunt: { hunterCount: 1, boundary },
        },
      ),
    ];

    for (const input of inputs) {
      st.after(() => cleanupRoom(pool, input.roomId));
      await assert.rejects(
        repository.createRoomWithHost(input),
        TypeError,
      );
      await assertNoRoomArtifacts(pool, input.roomId, input.hostPlayerId);
    }
  });

  await t.test("rejects boundary values outside the shared API limits", async (st) => {
    const invalidBoundaries: Array<{
      roomId: string;
      hostPlayerId: string;
      roomCode: string;
      boundary: ManhuntBoundary;
    }> = [
      {
        roomId: "51000000-0000-4000-8000-000000000006",
        hostPlayerId: "52000000-0000-4000-8000-000000000006",
        roomCode: "TBLA",
        boundary: {
          center: { latitude: 90.01, longitude: 0 },
          radiusMeters: 350,
        },
      },
      {
        roomId: "51000000-0000-4000-8000-000000000007",
        hostPlayerId: "52000000-0000-4000-8000-000000000007",
        roomCode: "TBLO",
        boundary: {
          center: { latitude: 0, longitude: -180.01 },
          radiusMeters: 350,
        },
      },
      {
        roomId: "51000000-0000-4000-8000-000000000008",
        hostPlayerId: "52000000-0000-4000-8000-000000000008",
        roomCode: "TBRD",
        boundary: {
          center: { latitude: 0, longitude: 0 },
          radiusMeters: 1_001,
        },
      },
    ];

    for (const invalid of invalidBoundaries) {
      const input = createInput(
        invalid.roomId,
        invalid.hostPlayerId,
        invalid.roomCode,
        manhuntSettings(invalid.boundary),
      );
      st.after(() => cleanupRoom(pool, input.roomId));
      await assert.rejects(
        repository.createRoomWithHost(input),
        TypeError,
      );
      await assertNoRoomArtifacts(pool, input.roomId, input.hostPlayerId);
    }
  });

  await t.test("duplicate active room code rolls back all attempted artifacts", async (st) => {
    const existing = createInput(
      "51000000-0000-4000-8000-000000000009",
      "52000000-0000-4000-8000-000000000009",
      "TDUP",
      {
        gameMode: "impostor-classic",
        maxPlayers: 4,
        isPrivate: false,
      },
    );
    const attempted = createInput(
      "51000000-0000-4000-8000-000000000010",
      "52000000-0000-4000-8000-000000000010",
      "TDUP",
      manhuntSettings({
        center: { latitude: 40, longitude: -74 },
        radiusMeters: 350,
      }),
    );
    st.after(async () => {
      await cleanupRoom(pool, existing.roomId);
      await cleanupRoom(pool, attempted.roomId);
    });

    await repository.createRoomWithHost(existing);
    await assert.rejects(
      repository.createRoomWithHost(attempted),
      isUniqueViolation,
    );
    await assertNoRoomArtifacts(
      pool,
      attempted.roomId,
      attempted.hostPlayerId,
    );
    const existingRoom = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM public.rooms WHERE id = $1",
      [existing.roomId],
    );
    assert.equal(existingRoom.rows[0]?.count, 1);
  });

  await t.test("leaves rooms atomically", async (leaveTest) => {
    const pool = createTestPool();
    leaveTest.after(async () => {
      await pool.end();
    });
    const repository = createTestRepository(pool);
    const existingRows = await pool.query<{ count: number }>(
      `SELECT
         (SELECT count(*)::int FROM public.rooms) +
         (SELECT count(*)::int FROM public.room_players) +
         (SELECT count(*)::int FROM public.room_private_manhunt_boundaries)
         AS count`,
    );
    assert.equal(existingRows.rows[0]?.count, 0);

    await leaveTest.test("a non-host leaves and the room version increments once", async (st) => {
      const room = await seedRoom(
        repository,
        "71000000-0000-4000-8000-000000000001",
        "72000000-0000-4000-8000-000000000001",
        "LNON",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const playerId = "73000000-0000-4000-8000-000000000001";
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(pool, room.roomId, playerId, "connected", "Leaver");

      const result = await repository.leaveRoom(leaveInput(room.roomCode, playerId));
      assert.deepEqual(result, {
        roomId: room.roomId,
        roomCode: room.roomCode,
        playerId,
        deleted: false,
        hostChanged: false,
        lifecycleStatus: "active",
        currentGameId: null,
        version: "2",
      });
      const member = await pool.query<LeftMembershipRow>(
        `SELECT membership_status,
                reconnect_token_hash IS NULL AS hash_is_null,
                reconnect_deadline_at IS NULL AS deadline_is_null,
                removed_at IS NOT NULL AS removed_at_is_set
         FROM public.room_players WHERE player_id = $1`,
        [playerId],
      );
      assert.deepEqual(member.rows[0], {
        membership_status: "removed",
        hash_is_null: true,
        deadline_is_null: true,
        removed_at_is_set: true,
      });
      const state = await pool.query<{
        host_player_id: string;
        version: number;
      }>(
        "SELECT host_player_id::text, version::int FROM public.rooms WHERE id = $1",
        [room.roomId],
      );
      assert.deepEqual(state.rows[0], {
        host_player_id: room.hostPlayerId,
        version: 2,
      });
    });

    await leaveTest.test("leaving clears a disconnected member's hash and deadline", async (st) => {
      const room = await seedRoom(
        repository,
        "71000000-0000-4000-8000-000000000002",
        "72000000-0000-4000-8000-000000000002",
        "LDIS",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const playerId = "73000000-0000-4000-8000-000000000002";
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(
        pool,
        room.roomId,
        playerId,
        "disconnected",
        "Disconnected",
      );
      const before = await pool.query<{
        hash_is_set: boolean;
        deadline_is_set: boolean;
      }>(
        `SELECT reconnect_token_hash IS NOT NULL AS hash_is_set,
                reconnect_deadline_at IS NOT NULL AS deadline_is_set
         FROM public.room_players WHERE player_id = $1`,
        [playerId],
      );
      assert.deepEqual(before.rows[0], {
        hash_is_set: true,
        deadline_is_set: true,
      });

      await repository.leaveRoom(leaveInput(room.roomCode, playerId));
      const after = await pool.query<LeftMembershipRow>(
        `SELECT membership_status,
                reconnect_token_hash IS NULL AS hash_is_null,
                reconnect_deadline_at IS NULL AS deadline_is_null,
                removed_at IS NOT NULL AS removed_at_is_set
         FROM public.room_players WHERE player_id = $1`,
        [playerId],
      );
      assert.deepEqual(after.rows[0], {
        membership_status: "removed",
        hash_is_null: true,
        deadline_is_null: true,
        removed_at_is_set: true,
      });
    });

    await leaveTest.test("a departing host transfers ownership to a connected active member", async (st) => {
      const room = await seedRoom(
        repository,
        "71000000-0000-4000-8000-000000000003",
        "72000000-0000-4000-8000-000000000003",
        "LHST",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const nextHostId = "73000000-0000-4000-8000-000000000003";
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(pool, room.roomId, nextHostId, "connected", "Next Host");

      const result = await repository.leaveRoom(
        leaveInput(room.roomCode, room.hostPlayerId),
      );
      assert.equal(result.hostChanged, true);
      assert.equal(result.deleted, false);
      if (!result.deleted) {
        assert.equal(result.version, "2");
        assert.equal(result.hostPlayerId, nextHostId);
        assert.equal(result.currentGameId, null);
      }
      const host = await pool.query<{ host_player_id: string; version: number }>(
        "SELECT host_player_id::text, version::int FROM public.rooms WHERE id = $1",
        [room.roomId],
      );
      assert.deepEqual(host.rows[0], {
        host_player_id: nextHostId,
        version: 2,
      });
    });

    await leaveTest.test("rejects a stale expected room identity and version without mutation", async (st) => {
      const room = await seedRoom(
        repository,
        "71000000-0000-4000-8000-000000000008",
        "72000000-0000-4000-8000-000000000008",
        "LSTA",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      st.after(() => cleanupRoom(pool, room.roomId));
      const host = await pool.query<{ version: string }>(
        "SELECT version::text FROM public.rooms WHERE id = $1",
        [room.roomId],
      );
      assert.equal(host.rows[0]?.version, "1");

      await assert.rejects(
        repository.leaveRoom({
          ...leaveInput(room.roomCode, room.hostPlayerId),
          expectedRoomId: room.roomId,
          expectedVersion: "2",
        }),
        (error: unknown) =>
          error instanceof RoomLeaveError && error.code === "STALE_VERSION",
      );
      await assert.rejects(
        repository.leaveRoom({
          ...leaveInput(room.roomCode, room.hostPlayerId),
          expectedRoomId: "71000000-0000-4000-8000-000000000009",
          expectedVersion: "1",
        }),
        (error: unknown) =>
          error instanceof RoomLeaveError && error.code === "STALE_VERSION",
      );
      const after = await pool.query<{ version: string; member_count: number }>(
        `SELECT version::text,
                (SELECT count(*)::int FROM public.room_players WHERE room_id = $1) AS member_count
         FROM public.rooms WHERE id = $1`,
        [room.roomId],
      );
      assert.deepEqual(after.rows[0], { version: "1", member_count: 1 });
    });

    await leaveTest.test("a connected member is preferred over an older disconnected member", async (st) => {
      const room = await seedRoom(
        repository,
        "71000000-0000-4000-8000-000000000004",
        "72000000-0000-4000-8000-000000000004",
        "LPRE",
        { gameMode: "impostor-classic", maxPlayers: 5, isPrivate: false },
      );
      const olderDisconnectedId = "73000000-0000-4000-8000-000000000004";
      const connectedId = "73000000-0000-4000-8000-000000000005";
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(
        pool,
        room.roomId,
        olderDisconnectedId,
        "disconnected",
        "Older Disconnected",
        "2024-01-01T00:00:00Z",
      );
      await addActiveMember(
        pool,
        room.roomId,
        connectedId,
        "connected",
        "Connected",
        "2025-01-01T00:00:00Z",
      );

      await repository.leaveRoom(leaveInput(room.roomCode, room.hostPlayerId));
      const host = await pool.query<{ host_player_id: string }>(
        "SELECT host_player_id::text FROM public.rooms WHERE id = $1",
        [room.roomId],
      );
      assert.equal(host.rows[0]?.host_player_id, connectedId);
    });

    await leaveTest.test("earliest joined disconnected active member is the fallback host", async (st) => {
      const room = await seedRoom(
        repository,
        "71000000-0000-4000-8000-000000000005",
        "72000000-0000-4000-8000-000000000005",
        "LDIS",
        { gameMode: "impostor-classic", maxPlayers: 5, isPrivate: false },
      );
      const earliestId = "73000000-0000-4000-8000-000000000006";
      const laterId = "73000000-0000-4000-8000-000000000007";
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(
        pool,
        room.roomId,
        earliestId,
        "disconnected",
        "Earliest",
        "2024-01-01T00:00:00Z",
      );
      await addActiveMember(
        pool,
        room.roomId,
        laterId,
        "disconnected",
        "Later",
        "2025-01-01T00:00:00Z",
      );

      await repository.leaveRoom(leaveInput(room.roomCode, room.hostPlayerId));
      const host = await pool.query<{ host_player_id: string }>(
        "SELECT host_player_id::text FROM public.rooms WHERE id = $1",
        [room.roomId],
      );
      assert.equal(host.rows[0]?.host_player_id, earliestId);
    });

    await leaveTest.test("the final Manhunt member deletes its room, members, and boundary and frees the code", async (st) => {
      const original = await seedRoom(
        repository,
        "71000000-0000-4000-8000-000000000006",
        "72000000-0000-4000-8000-000000000006",
        "LFNL",
        manhuntSettings({
          center: { latitude: 40, longitude: -74 },
          radiusMeters: 350,
        }),
      );
      const replacement = createInput(
        "71000000-0000-4000-8000-000000000007",
        "72000000-0000-4000-8000-000000000007",
        original.roomCode,
        manhuntSettings({
          center: { latitude: 41, longitude: -73 },
          radiusMeters: 400,
        }),
      );
      st.after(async () => {
        await cleanupRoom(pool, original.roomId);
        await cleanupRoom(pool, replacement.roomId);
      });

      const result = await repository.leaveRoom(
        leaveInput(original.roomCode, original.hostPlayerId),
      );
      assert.deepEqual(result, {
        roomId: original.roomId,
        roomCode: original.roomCode,
        playerId: original.hostPlayerId,
        deleted: true,
        hostChanged: true,
        currentGameId: null,
      });
      await assertNoRoomArtifacts(
        pool,
        original.roomId,
        original.hostPlayerId,
      );

      const recreated = await repository.createRoomWithHost(replacement);
      assert.equal(recreated.roomCode, original.roomCode);
      const replacementBoundary = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM public.room_private_manhunt_boundaries
         WHERE room_id = $1`,
        [replacement.roomId],
      );
      assert.equal(replacementBoundary.rows[0]?.count, 1);
    });

    await leaveTest.test("rejects a nonexistent room", async () => {
      await assert.rejects(
        repository.leaveRoom(
          leaveInput("LNOF", "73000000-0000-4000-8000-000000000008"),
        ),
        (error: unknown) =>
          error instanceof RoomLeaveError && error.code === "ROOM_NOT_FOUND",
      );
    });

    await leaveTest.test("rejects an inactive member without changing room state", async (st) => {
      const room = await seedRoom(
        repository,
        "71000000-0000-4000-8000-000000000008",
        "72000000-0000-4000-8000-000000000008",
        "LNAM",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const absentPlayerId = "73000000-0000-4000-8000-000000000009";
      st.after(() => cleanupRoom(pool, room.roomId));

      await assert.rejects(
        repository.leaveRoom(leaveInput(room.roomCode, absentPlayerId)),
        (error: unknown) =>
          error instanceof RoomLeaveError
          && error.code === "MEMBERSHIP_NOT_ACTIVE",
      );
      const state = await pool.query<{ version: number; host_player_id: string }>(
        "SELECT version::int, host_player_id::text FROM public.rooms WHERE id = $1",
        [room.roomId],
      );
      assert.deepEqual(state.rows[0], {
        version: 1,
        host_player_id: room.hostPlayerId,
      });
      const membership = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM public.room_players WHERE player_id = $1",
        [absentPlayerId],
      );
      assert.equal(membership.rows[0]?.count, 0);
    });

    await leaveTest.test("repeated leave is rejected without changing the prior removal", async (st) => {
      const room = await seedRoom(
        repository,
        "71000000-0000-4000-8000-000000000009",
        "72000000-0000-4000-8000-000000000009",
        "LREP",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const playerId = "73000000-0000-4000-8000-000000000010";
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(pool, room.roomId, playerId, "connected", "Repeat");

      await repository.leaveRoom(leaveInput(room.roomCode, playerId));
      await assert.rejects(
        repository.leaveRoom(leaveInput(room.roomCode, playerId)),
        (error: unknown) =>
          error instanceof RoomLeaveError
          && error.code === "MEMBERSHIP_NOT_ACTIVE",
      );
      const state = await pool.query<{
        version: number;
        membership_status: string;
        hash_is_null: boolean;
      }>(
        `SELECT r.version::int, rp.membership_status,
                rp.reconnect_token_hash IS NULL AS hash_is_null
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [room.roomId, playerId],
      );
      assert.deepEqual(state.rows[0], {
        version: 2,
        membership_status: "removed",
        hash_is_null: true,
      });
    });

    await leaveTest.test("a failed host transfer rolls back removal and version changes", async (st) => {
      const room = await seedRoom(
        repository,
        "71000000-0000-4000-8000-000000000010",
        "72000000-0000-4000-8000-000000000010",
        "LERR",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const candidateId = "73000000-0000-4000-8000-000000000011";
      st.after(async () => {
        await pool.query(
          "DROP TRIGGER IF EXISTS fail_leave_host_transfer_for_test ON public.rooms",
        );
        await pool.query(
          "DROP FUNCTION IF EXISTS public.fail_leave_host_transfer_for_test()",
        );
      });
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(pool, room.roomId, candidateId, "connected", "Candidate");
      await pool.query(
        `CREATE FUNCTION public.fail_leave_host_transfer_for_test()
         RETURNS trigger
         LANGUAGE plpgsql
         AS $function$
         BEGIN
           IF NEW.id = '71000000-0000-4000-8000-000000000010'::uuid
             AND NEW.host_player_id IS DISTINCT FROM OLD.host_player_id THEN
             RAISE EXCEPTION 'Injected test host transfer failure';
           END IF;
           RETURN NEW;
         END;
         $function$`,
      );
      await pool.query(
        `CREATE TRIGGER fail_leave_host_transfer_for_test
         BEFORE UPDATE OF host_player_id ON public.rooms
         FOR EACH ROW
         EXECUTE FUNCTION public.fail_leave_host_transfer_for_test()`,
      );

      await assert.rejects(
        repository.leaveRoom(leaveInput(room.roomCode, room.hostPlayerId)),
        /Injected test host transfer failure/,
      );
      const state = await pool.query<{
        host_player_id: string;
        version: number;
        departing_status: string;
        departing_hash_length: number;
        active_count: number;
      }>(
        `SELECT r.host_player_id::text, r.version::int,
                departing.membership_status AS departing_status,
                octet_length(departing.reconnect_token_hash)::int AS departing_hash_length,
                (SELECT count(*)::int FROM public.room_players AS active_member
                 WHERE active_member.room_id = r.id
                   AND active_member.membership_status = 'active') AS active_count
         FROM public.rooms AS r
         JOIN public.room_players AS departing
           ON departing.room_id = r.id AND departing.player_id = $2
         WHERE r.id = $1`,
        [room.roomId, room.hostPlayerId],
      );
      assert.deepEqual(state.rows[0], {
        host_player_id: room.hostPlayerId,
        version: 1,
        departing_status: "active",
        departing_hash_length: 32,
        active_count: 2,
      });
    });
  });

  await t.test("tracks durable disconnects and reconnects atomically", async (connectionTest) => {
    const pool = createTestPool();
    connectionTest.after(async () => {
      await pool.end();
    });
    const repository = createTestRepository(pool);
    const existingRows = await pool.query<{ count: number }>(
      `SELECT
         (SELECT count(*)::int FROM public.rooms) +
         (SELECT count(*)::int FROM public.room_players) +
         (SELECT count(*)::int FROM public.room_private_manhunt_boundaries)
         AS count`,
    );
    assert.equal(existingRows.rows[0]?.count, 0);

    await connectionTest.test("disconnects and reconnects with one generation change each", async (st) => {
      const room = await seedRoom(
        repository,
        "81000000-0000-4000-8000-000000000001",
        "82000000-0000-4000-8000-000000000001",
        "DREC",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const playerId = "83000000-0000-4000-8000-000000000001";
      const token = "test-reconnect-token-success";
      const storedHash = hashReconnectToken(token);
      const deadline = new Date(Date.now() + 60_000);
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(
        pool,
        room.roomId,
        playerId,
        "connected",
        "Reconnect",
        undefined,
        storedHash,
      );

      const disconnected = await repository.markDisconnected(
        markDisconnectedInput(room.roomCode, playerId, deadline),
      );
      assert.deepEqual(disconnected, {
        roomId: room.roomId,
        roomCode: room.roomCode,
        playerId,
        disconnectGeneration: "1",
        reconnectDeadlineAt: deadline,
        lifecycleStatus: "active",
        currentGameId: null,
        version: "2",
      });
      const afterDisconnect = await pool.query<{
        room_version: number;
        connection_status: string;
        generation: string;
        reconnect_deadline_at: Date | null;
        hash_matches: boolean;
      }>(
        `SELECT r.version::int AS room_version,
                rp.connection_status,
                rp.disconnect_generation::text AS generation,
                rp.reconnect_deadline_at,
                rp.reconnect_token_hash = $3 AS hash_matches
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [room.roomId, playerId, storedHash],
      );
      assert.deepEqual(afterDisconnect.rows[0], {
        room_version: 2,
        connection_status: "disconnected",
        generation: "1",
        reconnect_deadline_at: deadline,
        hash_matches: true,
      });

      const reconnected = await repository.reconnectPlayer(
        reconnectInput(room.roomCode, playerId, token),
      );
      assert.deepEqual(reconnected, {
        roomId: room.roomId,
        roomCode: room.roomCode,
        playerId,
        disconnectGeneration: "2",
        lifecycleStatus: "active",
        currentGameId: null,
        version: "3",
      });
      const serializedResults = JSON.stringify({ disconnected, reconnected });
      assert.equal(serializedResults.includes(token), false);
      assert.equal(serializedResults.includes(storedHash.toString("hex")), false);
      const afterReconnect = await pool.query<{
        room_version: number;
        connection_status: string;
        generation: string;
        reconnect_deadline_at: Date | null;
        hash_matches: boolean;
      }>(
        `SELECT r.version::int AS room_version,
                rp.connection_status,
                rp.disconnect_generation::text AS generation,
                rp.reconnect_deadline_at,
                rp.reconnect_token_hash = $3 AS hash_matches
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [room.roomId, playerId, storedHash],
      );
      assert.deepEqual(afterReconnect.rows[0], {
        room_version: 3,
        connection_status: "connected",
        generation: "2",
        reconnect_deadline_at: null,
        hash_matches: true,
      });
    });

    await connectionTest.test("rejects reconnects from non-active rooms without changing credentials or membership state", async (st) => {
      const scenarios = [
        {
          roomId: "81000000-0000-4000-8000-000000000011",
          hostPlayerId: "82000000-0000-4000-8000-000000000011",
          playerId: "83000000-0000-4000-8000-000000000011",
          roomCode: "DCLD",
          lifecycleStatus: "closed",
        },
        {
          roomId: "81000000-0000-4000-8000-000000000012",
          hostPlayerId: "82000000-0000-4000-8000-000000000012",
          playerId: "83000000-0000-4000-8000-000000000012",
          roomCode: "DEXD",
          lifecycleStatus: "expired",
        },
      ] as const;

      for (const [index, scenario] of scenarios.entries()) {
        const room = await seedRoom(
          repository,
          scenario.roomId,
          scenario.hostPlayerId,
          scenario.roomCode,
          { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
        );
        const token = `lifecycle-token-${index}`;
        const storedHash = hashReconnectToken(token);
        const deadline = new Date(Date.now() + 60_000);
        st.after(() => cleanupRoom(pool, room.roomId));
        await addActiveMember(
          pool,
          room.roomId,
          scenario.playerId,
          "connected",
          "Lifecycle Check",
          undefined,
          storedHash,
        );
        await repository.markDisconnected(
          markDisconnectedInput(room.roomCode, scenario.playerId, deadline),
        );
        await pool.query(
          "UPDATE public.rooms SET lifecycle_status = $2 WHERE id = $1",
          [room.roomId, scenario.lifecycleStatus],
        );

        const getState = async () => {
          const result = await pool.query<{
            lifecycle_status: string;
            room_version: number;
            membership_status: string;
            connection_status: string;
            generation: string;
            reconnect_deadline_at: Date | null;
            hash_matches: boolean;
          }>(
            `SELECT r.lifecycle_status, r.version::int AS room_version,
                    rp.membership_status, rp.connection_status,
                    rp.disconnect_generation::text AS generation,
                    rp.reconnect_deadline_at,
                    rp.reconnect_token_hash = $3 AS hash_matches
             FROM public.rooms AS r
             JOIN public.room_players AS rp ON rp.room_id = r.id
             WHERE r.id = $1 AND rp.player_id = $2`,
            [room.roomId, scenario.playerId, storedHash],
          );
          return result.rows[0];
        };
        const before = await getState();
        assert.deepEqual(before, {
          lifecycle_status: scenario.lifecycleStatus,
          room_version: 2,
          membership_status: "active",
          connection_status: "disconnected",
          generation: "1",
          reconnect_deadline_at: deadline,
          hash_matches: true,
        });

        await assert.rejects(
          repository.reconnectPlayer(
            reconnectInput(room.roomCode, scenario.playerId, token),
          ),
          (error: unknown) => {
            if (!(error instanceof RoomConnectionError)) {
              return false;
            }
            assert.equal(error.code, "ROOM_NOT_ACTIVE");
            assert.equal(error.message.includes(token), false);
            assert.equal(error.message.includes(storedHash.toString("hex")), false);
            return true;
          },
        );
        assert.deepEqual(await getState(), before);
      }
    });

    await connectionTest.test("a repeated disconnect does not extend the deadline or advance counters", async (st) => {
      const room = await seedRoom(
        repository,
        "81000000-0000-4000-8000-000000000002",
        "82000000-0000-4000-8000-000000000002",
        "DREP",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const playerId = "83000000-0000-4000-8000-000000000002";
      const firstDeadline = new Date(Date.now() + 30_000);
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(pool, room.roomId, playerId, "connected", "Repeat");
      await repository.markDisconnected(
        markDisconnectedInput(room.roomCode, playerId, firstDeadline),
      );

      await assert.rejects(
        repository.markDisconnected(
          markDisconnectedInput(
            room.roomCode,
            playerId,
            new Date(Date.now() + 90_000),
          ),
        ),
        (error: unknown) =>
          error instanceof RoomConnectionError
          && error.code === "MEMBERSHIP_NOT_CONNECTED",
      );
      const state = await pool.query<{
        room_version: number;
        generation: string;
        reconnect_deadline_at: Date;
      }>(
        `SELECT r.version::int AS room_version,
                rp.disconnect_generation::text AS generation,
                rp.reconnect_deadline_at
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [room.roomId, playerId],
      );
      assert.deepEqual(state.rows[0], {
        room_version: 2,
        generation: "1",
        reconnect_deadline_at: firstDeadline,
      });
    });

    await connectionTest.test("an invalid disconnect deadline leaves state unchanged", async (st) => {
      const room = await seedRoom(
        repository,
        "81000000-0000-4000-8000-000000000003",
        "82000000-0000-4000-8000-000000000003",
        "DINV",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const playerId = "83000000-0000-4000-8000-000000000003";
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(pool, room.roomId, playerId, "connected", "Invalid Deadline");

      await assert.rejects(
        repository.markDisconnected(
          markDisconnectedInput(
            room.roomCode,
            playerId,
            new Date(Date.now() - 1_000),
          ),
        ),
        (error: unknown) =>
          error instanceof RoomConnectionError
          && error.code === "INVALID_RECONNECT_DEADLINE",
      );
      await assert.rejects(
        repository.markDisconnected(
          markDisconnectedInput(
            room.roomCode,
            playerId,
            new Date(Number.NaN),
          ),
        ),
        (error: unknown) =>
          error instanceof RoomConnectionError
          && error.code === "INVALID_RECONNECT_DEADLINE",
      );
      const state = await pool.query<{
        room_version: number;
        generation: string;
        connection_status: string;
      }>(
        `SELECT r.version::int AS room_version,
                rp.disconnect_generation::text AS generation,
                rp.connection_status
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [room.roomId, playerId],
      );
      assert.deepEqual(state.rows[0], {
        room_version: 1,
        generation: "0",
        connection_status: "connected",
      });
    });

    await connectionTest.test("missing rooms and memberships have distinct errors", async (st) => {
      const playerId = "83000000-0000-4000-8000-000000000004";
      const token = "test-missing-member-token";
      const deadline = new Date(Date.now() + 60_000);
      await assert.rejects(
        repository.markDisconnected(
          markDisconnectedInput("DMIS", playerId, deadline),
        ),
        (error: unknown) =>
          error instanceof RoomConnectionError && error.code === "ROOM_NOT_FOUND",
      );
      await assert.rejects(
        repository.reconnectPlayer(reconnectInput("DMIS", playerId, token)),
        (error: unknown) =>
          error instanceof RoomConnectionError && error.code === "ROOM_NOT_FOUND",
      );

      const room = await seedRoom(
        repository,
        "81000000-0000-4000-8000-000000000004",
        "82000000-0000-4000-8000-000000000004",
        "DMEM",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      st.after(() => cleanupRoom(pool, room.roomId));
      await assert.rejects(
        repository.markDisconnected(
          markDisconnectedInput(room.roomCode, playerId, deadline),
        ),
        (error: unknown) =>
          error instanceof RoomConnectionError
          && error.code === "MEMBERSHIP_NOT_FOUND",
      );
      await assert.rejects(
        repository.reconnectPlayer(
          reconnectInput(room.roomCode, playerId, token),
        ),
        (error: unknown) =>
          error instanceof RoomConnectionError
          && error.code === "MEMBERSHIP_NOT_FOUND",
      );
      const version = await pool.query<{ version: number }>(
        "SELECT version::int FROM public.rooms WHERE id = $1",
        [room.roomId],
      );
      assert.equal(version.rows[0]?.version, 1);
    });

    await connectionTest.test("removed memberships cannot disconnect or reconnect", async (st) => {
      const room = await seedRoom(
        repository,
        "81000000-0000-4000-8000-000000000005",
        "82000000-0000-4000-8000-000000000005",
        "DREM",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const playerId = "83000000-0000-4000-8000-000000000005";
      const token = "test-removed-member-token";
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(
        pool,
        room.roomId,
        playerId,
        "connected",
        "Leaving",
        undefined,
        hashReconnectToken(token),
      );
      await repository.leaveRoom(leaveInput(room.roomCode, playerId));

      await assert.rejects(
        repository.markDisconnected(
          markDisconnectedInput(
            room.roomCode,
            playerId,
            new Date(Date.now() + 60_000),
          ),
        ),
        (error: unknown) =>
          error instanceof RoomConnectionError
          && error.code === "MEMBERSHIP_NOT_ACTIVE",
      );
      await assert.rejects(
        repository.reconnectPlayer(
          reconnectInput(room.roomCode, playerId, token),
        ),
        (error: unknown) =>
          error instanceof RoomConnectionError
          && error.code === "MEMBERSHIP_NOT_ACTIVE",
      );
      const state = await pool.query<{ version: number; status: string }>(
        `SELECT r.version::int, rp.membership_status AS status
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [room.roomId, playerId],
      );
      assert.deepEqual(state.rows[0], {
        version: 2,
        status: "removed",
      });
    });

    await connectionTest.test("a connected member cannot reconnect twice", async (st) => {
      const room = await seedRoom(
        repository,
        "81000000-0000-4000-8000-000000000006",
        "82000000-0000-4000-8000-000000000006",
        "DCON",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const playerId = "83000000-0000-4000-8000-000000000006";
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(pool, room.roomId, playerId, "connected", "Connected");

      await assert.rejects(
        repository.reconnectPlayer(
          reconnectInput(room.roomCode, playerId, "test-connected-token"),
        ),
        (error: unknown) =>
          error instanceof RoomConnectionError
          && error.code === "MEMBERSHIP_NOT_DISCONNECTED",
      );
      const state = await pool.query<{
        version: number;
        generation: string;
        connection_status: string;
      }>(
        `SELECT r.version::int, rp.disconnect_generation::text AS generation,
                rp.connection_status
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [room.roomId, playerId],
      );
      assert.deepEqual(state.rows[0], {
        version: 1,
        generation: "0",
        connection_status: "connected",
      });
    });

    await connectionTest.test("an invalid token does not mutate state or leak credentials", async (st) => {
      const room = await seedRoom(
        repository,
        "81000000-0000-4000-8000-000000000007",
        "82000000-0000-4000-8000-000000000007",
        "DTOK",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const playerId = "83000000-0000-4000-8000-000000000007";
      const correctToken = "test-correct-secret-token";
      const wrongToken = "test-wrong-secret-token";
      const storedHash = hashReconnectToken(correctToken);
      const deadline = new Date(Date.now() + 60_000);
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(
        pool,
        room.roomId,
        playerId,
        "connected",
        "Token Check",
        undefined,
        storedHash,
      );
      await repository.markDisconnected(
        markDisconnectedInput(room.roomCode, playerId, deadline),
      );

      await assert.rejects(
        repository.reconnectPlayer(
          reconnectInput(room.roomCode, playerId, wrongToken),
        ),
        (error: unknown) => {
          if (!(error instanceof RoomConnectionError)) {
            return false;
          }
          assert.equal(error.code, "INVALID_RECONNECT_CREDENTIALS");
          assert.equal(error.message.includes(wrongToken), false);
          assert.equal(error.message.includes(correctToken), false);
          assert.equal(error.message.includes(storedHash.toString("hex")), false);
          return true;
        },
      );
      const state = await pool.query<{
        version: number;
        generation: string;
        connection_status: string;
        reconnect_deadline_at: Date;
        hash_matches: boolean;
      }>(
        `SELECT r.version::int, rp.disconnect_generation::text AS generation,
                rp.connection_status, rp.reconnect_deadline_at,
                rp.reconnect_token_hash = $3 AS hash_matches
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [room.roomId, playerId, storedHash],
      );
      assert.deepEqual(state.rows[0], {
        version: 2,
        generation: "1",
        connection_status: "disconnected",
        reconnect_deadline_at: deadline,
        hash_matches: true,
      });
    });

    await connectionTest.test("an expired reconnect deadline fails without mutation", async (st) => {
      const room = await seedRoom(
        repository,
        "81000000-0000-4000-8000-000000000008",
        "82000000-0000-4000-8000-000000000008",
        "DEXP",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const playerId = "83000000-0000-4000-8000-000000000008";
      const token = "test-expired-token";
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(
        pool,
        room.roomId,
        playerId,
        "connected",
        "Expired",
        undefined,
        hashReconnectToken(token),
      );
      await repository.markDisconnected(
        markDisconnectedInput(
          room.roomCode,
          playerId,
          new Date(Date.now() + 60_000),
        ),
      );
      await pool.query(
        `UPDATE public.room_players
         SET reconnect_deadline_at = clock_timestamp() - interval '1 second'
         WHERE player_id = $1`,
        [playerId],
      );

      await assert.rejects(
        repository.reconnectPlayer(
          reconnectInput(room.roomCode, playerId, token),
        ),
        (error: unknown) =>
          error instanceof RoomConnectionError
          && error.code === "RECONNECT_DEADLINE_EXPIRED",
      );
      const state = await pool.query<{
        version: number;
        generation: string;
        connection_status: string;
      }>(
        `SELECT r.version::int, rp.disconnect_generation::text AS generation,
                rp.connection_status
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [room.roomId, playerId],
      );
      assert.deepEqual(state.rows[0], {
        version: 2,
        generation: "1",
        connection_status: "disconnected",
      });
    });

    await connectionTest.test("a legacy disconnected member with NULL deadline fails closed", async (st) => {
      const room = await seedRoom(
        repository,
        "81000000-0000-4000-8000-000000000009",
        "82000000-0000-4000-8000-000000000009",
        "DLEG",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const playerId = "83000000-0000-4000-8000-000000000009";
      const token = "test-legacy-token";
      st.after(() => cleanupRoom(pool, room.roomId));
      st.after(async () => {
        const constraint = await pool.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.room_players'::regclass
               AND conname = 'room_players_disconnected_deadline_required'
           ) AS exists`,
        );
        if (!constraint.rows[0]?.exists) {
          await pool.query(
            `ALTER TABLE public.room_players
             ADD CONSTRAINT room_players_disconnected_deadline_required
             CHECK (
               membership_status <> 'active'
               OR connection_status <> 'disconnected'
               OR reconnect_deadline_at IS NOT NULL
             ) NOT VALID`,
          );
        }
      });
      await addActiveMember(
        pool,
        room.roomId,
        playerId,
        "connected",
        "Legacy",
        undefined,
        hashReconnectToken(token),
      );
      await pool.query(
        "ALTER TABLE public.room_players DROP CONSTRAINT room_players_disconnected_deadline_required",
      );
      await pool.query(
        `UPDATE public.room_players
         SET connection_status = 'disconnected',
             reconnect_deadline_at = NULL
         WHERE player_id = $1`,
        [playerId],
      );
      await pool.query(
        `ALTER TABLE public.room_players
         ADD CONSTRAINT room_players_disconnected_deadline_required
         CHECK (
           membership_status <> 'active'
           OR connection_status <> 'disconnected'
           OR reconnect_deadline_at IS NOT NULL
         ) NOT VALID`,
      );

      await assert.rejects(
        repository.reconnectPlayer(
          reconnectInput(room.roomCode, playerId, token),
        ),
        (error: unknown) =>
          error instanceof RoomConnectionError
          && error.code === "RECONNECT_DEADLINE_MISSING",
      );
      const state = await pool.query<{
        version: number;
        generation: string;
        connection_status: string;
        reconnect_deadline_at: Date | null;
      }>(
        `SELECT r.version::int, rp.disconnect_generation::text AS generation,
                rp.connection_status, rp.reconnect_deadline_at
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [room.roomId, playerId],
      );
      assert.deepEqual(state.rows[0], {
        version: 1,
        generation: "0",
        connection_status: "disconnected",
        reconnect_deadline_at: null,
      });
    });

    await connectionTest.test("two concurrent reconnects serialize on independent database connections", async (st) => {
      const room = await seedRoom(
        repository,
        "81000000-0000-4000-8000-000000000010",
        "82000000-0000-4000-8000-000000000010",
        "DRAC",
        { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
      );
      const playerId = "83000000-0000-4000-8000-000000000010";
      const token = "test-concurrent-reconnect-token";
      st.after(() => cleanupRoom(pool, room.roomId));
      await addActiveMember(
        pool,
        room.roomId,
        playerId,
        "connected",
        "Concurrent",
        undefined,
        hashReconnectToken(token),
      );
      await repository.markDisconnected(
        markDisconnectedInput(
          room.roomCode,
          playerId,
          new Date(Date.now() + 60_000),
        ),
      );

      const poolA = createTestPool(1);
      const poolB = createTestPool(1);
      st.after(async () => {
        await Promise.all([poolA.end(), poolB.end()]);
      });
      const [backendA, backendB] = await Promise.all([
        poolA.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
        poolB.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
      ]);
      assert.notEqual(backendA.rows[0]?.pid, backendB.rows[0]?.pid);

      const results = await Promise.allSettled([
        createTestRepository(poolA).reconnectPlayer(
          reconnectInput(room.roomCode, playerId, token),
        ),
        createTestRepository(poolB).reconnectPlayer(
          reconnectInput(room.roomCode, playerId, token),
        ),
      ]);
      const successful = results.filter((result) => result.status === "fulfilled");
      const failed = results.filter((result) => result.status === "rejected");
      assert.equal(successful.length, 1);
      assert.equal(failed.length, 1);
      if (failed[0]?.status !== "rejected") {
        assert.fail("Expected one concurrent reconnect to be rejected.");
      }
      assert.ok(failed[0].reason instanceof RoomConnectionError);
      assert.equal(
        failed[0].reason.code,
        "MEMBERSHIP_NOT_DISCONNECTED",
      );
      const state = await pool.query<{
        version: number;
        generation: string;
        connection_status: string;
        reconnect_deadline_at: Date | null;
      }>(
        `SELECT r.version::int, rp.disconnect_generation::text AS generation,
                rp.connection_status, rp.reconnect_deadline_at
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [room.roomId, playerId],
      );
      assert.deepEqual(state.rows[0], {
        version: 3,
        generation: "2",
        connection_status: "connected",
        reconnect_deadline_at: null,
      });
    });
  });
});

test("PostgresRoomRepository discovers and removes due disconnected members", async (t) => {
  const pool = createTestPool(6);
  const suiteLease = await acquireRoomRuntimeLease(pool);
  repositoryFencingEpoch = suiteLease.fencingEpoch;
  const repository = createTestRepository(pool, suiteLease.fencingEpoch);
  const createdRoomIds: string[] = [];
  t.after(async () => {
    for (const roomId of createdRoomIds) {
      await cleanupRoom(pool, roomId);
    }
    await suiteLease.release();
    await pool.end();
  });

  const makeFixture = async (
    index: number,
    options: {
      targetIsHost?: boolean;
      manhunt?: boolean;
      reconnectToken?: string;
      deadline?: Date;
    } = {},
  ) => {
    const suffix = index.toString().padStart(12, "0");
    const roomId = `81000000-0000-4000-8000-${suffix}`;
    const hostPlayerId = `82000000-0000-4000-8000-${suffix}`;
    const targetPlayerId = `83000000-0000-4000-8000-${suffix}`;
    const roomCode = `T${String.fromCharCode(65 + Math.floor(index / 676) % 26)}${String.fromCharCode(65 + Math.floor(index / 26) % 26)}${String.fromCharCode(65 + index % 26)}`;
    const settings = options.manhunt
      ? manhuntSettings({
        center: { latitude: 10, longitude: 20 },
        radiusMeters: 300,
      })
      : {
        gameMode: "impostor-classic" as const,
        maxPlayers: 8,
        isPrivate: false,
      };
    const roomInput = createInput(roomId, hostPlayerId, roomCode, settings);
    createdRoomIds.push(roomId);
    await repository.createRoomWithHost(roomInput);

    const playerId = options.targetIsHost ? hostPlayerId : targetPlayerId;
    const token = options.reconnectToken ?? `timeout-token-${index}`;
    if (!options.targetIsHost) {
      await addActiveMember(
        pool,
        roomId,
        playerId,
        "connected",
        `Timeout Target ${index}`,
        undefined,
        hashReconnectToken(token),
      );
    }

    const markDeadline = new Date(Date.now() + 10 * 60 * 1000);
    await repository.markDisconnected(
      markDisconnectedInput(roomCode, playerId, markDeadline),
    );
    const deadline = options.deadline ?? markDeadline;
    if (deadline.getTime() !== markDeadline.getTime()) {
      await pool.query(
        `UPDATE public.room_players
         SET reconnect_deadline_at = $3
         WHERE room_id = $1 AND player_id = $2`,
        [roomId, playerId, deadline],
      );
    }
    return { roomId, roomCode, hostPlayerId, playerId, token, deadline, settings };
  };

  const queryMemberState = async (roomId: string, playerId: string) => {
    const result = await pool.query<{
      version: number;
      host_player_id: string;
      membership_status: string;
      connection_status: string;
      generation: string;
      hash_is_null: boolean;
      deadline: Date | null;
      removed_at_is_set: boolean;
    }>(
      `SELECT r.version::int, r.host_player_id::text,
              rp.membership_status, rp.connection_status,
              rp.disconnect_generation::text AS generation,
              rp.reconnect_token_hash IS NULL AS hash_is_null,
              rp.reconnect_deadline_at AS deadline,
              rp.removed_at IS NOT NULL AS removed_at_is_set
       FROM public.rooms AS r
       JOIN public.room_players AS rp ON rp.room_id = r.id
       WHERE r.id = $1 AND rp.player_id = $2`,
      [roomId, playerId],
    );
    return result.rows[0];
  };

  const remove = (
    fixture: { roomCode: string; playerId: string },
    expectedDisconnectGeneration: string,
    now: Date,
  ) => repository.removeDisconnectedPlayer({
    roomCode: fixture.roomCode as RemoveDisconnectedPlayerInput["roomCode"],
    playerId: fixture.playerId as RemoveDisconnectedPlayerInput["playerId"],
    expectedDisconnectGeneration,
    now,
  });
  const setLegacyDeadlineNull = async (fixture: {
    roomId: string;
    playerId: string;
  }) => {
    await pool.query(
      "ALTER TABLE public.room_players DROP CONSTRAINT IF EXISTS room_players_disconnected_deadline_required",
    );
    await pool.query(
      `UPDATE public.room_players
       SET reconnect_deadline_at = NULL
       WHERE room_id = $1 AND player_id = $2`,
      [fixture.roomId, fixture.playerId],
    );
    await pool.query(
      `ALTER TABLE public.room_players
       ADD CONSTRAINT room_players_disconnected_deadline_required
       CHECK (
         membership_status <> 'active'
         OR connection_status <> 'disconnected'
         OR reconnect_deadline_at IS NOT NULL
       ) NOT VALID`,
    );
  };

  await t.test("lists only due active disconnected members in deterministic order and respects its limit", async () => {
    const now = new Date(Date.now() + 1_000);
    const dueDeadline = new Date(now.getTime() - 1_000);
    const first = await makeFixture(1, { deadline: dueDeadline });
    const second = await makeFixture(2, { deadline: dueDeadline });
    const future = await makeFixture(3, { deadline: new Date(now.getTime() + 60_000) });
    const closed = await makeFixture(4, { deadline: dueDeadline });
    const removed = await makeFixture(5, { deadline: dueDeadline });
    const connected = await makeFixture(6);
    const expired = await makeFixture(19, { deadline: dueDeadline });
    const noDeadline = await makeFixture(20, { deadline: dueDeadline });

    await repository.reconnectPlayer(
      reconnectInput(connected.roomCode, connected.playerId, connected.token),
    );

    const lowerPlayerId = "80000000-0000-4000-8000-000000000001";
    await addActiveMember(pool, first.roomId, lowerPlayerId, "connected", "Earlier Player");
    await repository.markDisconnected(
      markDisconnectedInput(
        first.roomCode,
        lowerPlayerId,
        new Date(Date.now() + 10 * 60 * 1000),
      ),
    );
    await pool.query(
      `UPDATE public.room_players
       SET reconnect_deadline_at = $3
       WHERE room_id = $1 AND player_id = $2`,
      [first.roomId, lowerPlayerId, dueDeadline],
    );
    await pool.query(
      "UPDATE public.rooms SET lifecycle_status = 'closed' WHERE id = $1",
      [closed.roomId],
    );
    await pool.query(
      "UPDATE public.rooms SET lifecycle_status = 'expired' WHERE id = $1",
      [expired.roomId],
    );
    await setLegacyDeadlineNull(noDeadline);
    await repository.leaveRoom(leaveInput(removed.roomCode, removed.playerId));

    const all = await repository.listDueDisconnectedMembers({
      now,
      limit: 100,
    } satisfies ListDueDisconnectedMembersInput);
    assert.deepEqual(
      all.map((member) => [member.roomCode, member.playerId]),
      [
        [first.roomCode, lowerPlayerId],
        [first.roomCode, first.playerId],
        [second.roomCode, second.playerId],
      ],
    );
    const limited = await repository.listDueDisconnectedMembers({ now, limit: 2 });
    assert.deepEqual(limited, all.slice(0, 2));
    assert.equal(JSON.stringify(all).includes("reconnect_token_hash"), false);
    assert.equal(JSON.stringify(all).includes("private"), false);
    assert.ok(future && connected);
  });

  await t.test("rejects stale disconnect and reconnect versions before mutation", async (st) => {
    const room = await seedRoom(
      repository,
      "81000000-0000-4000-8000-000000000022",
      "82000000-0000-4000-8000-000000000022",
      "DCAS",
      { gameMode: "impostor-classic", maxPlayers: 4, isPrivate: false },
    );
    const playerId = "83000000-0000-4000-8000-000000000022";
    const token = "test-stale-version-token";
    st.after(() => cleanupRoom(pool, room.roomId));
    await addActiveMember(
      pool,
      room.roomId,
      playerId,
      "connected",
      "Stale Version",
      undefined,
      hashReconnectToken(token),
    );

    await assert.rejects(
      repository.markDisconnected({
        ...markDisconnectedInput(
          room.roomCode,
          playerId,
          new Date(Date.now() + 60_000),
        ),
        expectedRoomId: room.roomId,
        expectedVersion: "2",
      }),
      (error: unknown) =>
        error instanceof RoomConnectionError && error.code === "STALE_VERSION",
    );
    const disconnected = await repository.markDisconnected(
      markDisconnectedInput(
        room.roomCode,
        playerId,
        new Date(Date.now() + 60_000),
      ),
    );
    await assert.rejects(
      repository.reconnectPlayer({
        ...reconnectInput(room.roomCode, playerId, token),
        expectedRoomId: room.roomId,
        expectedVersion: "1",
      }),
      (error: unknown) =>
        error instanceof RoomConnectionError && error.code === "STALE_VERSION",
    );
    assert.equal(disconnected.version, "2");
    const state = await pool.query<{
      version: string;
      connection_status: string;
      generation: string;
    }>(
      `SELECT r.version::text, rp.connection_status,
              rp.disconnect_generation::text AS generation
       FROM public.rooms AS r
       JOIN public.room_players AS rp ON rp.room_id = r.id
       WHERE r.id = $1 AND rp.player_id = $2`,
      [room.roomId, playerId],
    );
    assert.deepEqual(state.rows[0], {
      version: "2",
      connection_status: "disconnected",
      generation: "1",
    });
  });

  await t.test("rejects invalid discovery times and unbounded limits", async () => {
    await assert.rejects(
      repository.listDueDisconnectedMembers({ now: new Date(Number.NaN), limit: 1 }),
      TypeError,
    );
    await assert.rejects(
      repository.listDueDisconnectedMembers({ now: new Date(), limit: 1_001 }),
      RangeError,
    );
  });

  await t.test("removes a due member, clears credentials, and increments room version once", async () => {
    const now = new Date(Date.now() + 1_000);
    const fixture = await makeFixture(7, { deadline: new Date(now.getTime() - 1_000) });
    const before = await queryMemberState(fixture.roomId, fixture.playerId);
    assert.equal(before?.version, 2);
    const result = await remove(fixture, "1", now);
    assert.deepEqual(result, {
      status: "removed",
      roomId: fixture.roomId,
      roomCode: fixture.roomCode,
      playerId: fixture.playerId,
      deleted: false,
      lifecycleStatus: "active",
      currentGameId: null,
      version: "3",
    });
    assert.deepEqual(await queryMemberState(fixture.roomId, fixture.playerId), {
      ...before,
      version: 3,
      membership_status: "removed",
      hash_is_null: true,
      deadline: null,
      removed_at_is_set: true,
    });
  });

  await t.test("timeout removal rejects stale room versions and deadlines without mutation", async () => {
    const now = new Date(Date.now() + 1_000);
    const fixture = await makeFixture(22, {
      deadline: new Date(now.getTime() - 1_000),
    });
    const versionMismatch = await repository.removeDisconnectedPlayer({
      roomCode: fixture.roomCode as RemoveDisconnectedPlayerInput["roomCode"],
      playerId: fixture.playerId as RemoveDisconnectedPlayerInput["playerId"],
      expectedDisconnectGeneration: "1",
      expectedReconnectDeadlineAt: fixture.deadline,
      expectedRoomId: fixture.roomId,
      expectedVersion: "1",
      now,
    });
    assert.deepEqual(versionMismatch, {
      status: "stale",
      roomCode: fixture.roomCode,
      playerId: fixture.playerId,
      reason: "version_mismatch",
    });

    const deadlineMismatch = await repository.removeDisconnectedPlayer({
      roomCode: fixture.roomCode as RemoveDisconnectedPlayerInput["roomCode"],
      playerId: fixture.playerId as RemoveDisconnectedPlayerInput["playerId"],
      expectedDisconnectGeneration: "1",
      expectedReconnectDeadlineAt: new Date(fixture.deadline.getTime() + 1),
      expectedRoomId: fixture.roomId,
      expectedVersion: "2",
      now,
    });
    assert.deepEqual(deadlineMismatch, {
      status: "stale",
      roomCode: fixture.roomCode,
      playerId: fixture.playerId,
      reason: "deadline_mismatch",
    });
    assert.equal((await queryMemberState(fixture.roomId, fixture.playerId))?.version, 2);
  });

  for (const roomId of createdRoomIds) {
    await cleanupRoom(pool, roomId);
  }
  createdRoomIds.length = 0;

  await t.test("PostgresRoomRepository prepares rooms for runtime recovery under the lease", async (t) => {
    const pool = createTestPool(12);
    const repository = createTestRepository(pool, suiteLease.fencingEpoch);
    const roomIds: string[] = [];
    t.after(async () => {
      try {
        for (const roomId of roomIds) {
          await cleanupRoom(pool, roomId);
        }
      } finally {
        await pool.end();
      }
    });

    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const encodeRoomCode = (value: number): string => {
      let remaining = value;
      let encoded = "";
      for (let position = 0; position < 3; position += 1) {
        encoded = letters[remaining % letters.length] + encoded;
        remaining = Math.floor(remaining / letters.length);
      }
      return `R${encoded}`;
    };
    const makeFixture = async (
      index: number,
      gameStatus: "waiting" | "starting" | "in_progress" | "finished" = "waiting",
      manhunt = false,
    ) => {
      const suffix = index.toString().padStart(12, "0");
      const roomId = `91000000-0000-4000-8000-${suffix}`;
      const hostPlayerId = `92000000-0000-4000-8000-${suffix}`;
      const roomCode = encodeRoomCode(index);
      const settings = manhunt
        ? manhuntSettings({
          center: { latitude: 10, longitude: 20 },
          radiusMeters: 300,
        })
        : {
          gameMode: "impostor-classic" as const,
          maxPlayers: 8,
          isPrivate: false,
        };
      const room = await seedRoom(repository, roomId, hostPlayerId, roomCode, settings);
      roomIds.push(roomId);
      if (gameStatus !== "waiting") {
        await pool.query(
          "UPDATE public.rooms SET game_status = $2 WHERE id = $1",
          [roomId, gameStatus],
        );
      }
      return { ...room, hostPlayerId };
    };
    const markDisconnectedWithDeadline = async (
      fixture: { roomCode: string; roomId: string },
      playerId: string,
      deadline: Date,
    ) => {
      await repository.markDisconnected(
        markDisconnectedInput(
          fixture.roomCode,
          playerId,
          new Date(Date.now() + 10 * 60 * 1000),
        ),
      );
      await pool.query(
        `UPDATE public.room_players
         SET reconnect_deadline_at = $3
         WHERE room_id = $1 AND player_id = $2`,
        [fixture.roomId, playerId, deadline],
      );
    };
    const recover = (now = new Date(), reconnectGracePeriodMs = 60_000) =>
      repository.prepareForRuntimeRecovery({ now, reconnectGracePeriodMs });

    await t.test("preserves future deadlines and disconnects connected waiting-room members", async (st) => {
      const fixture = await makeFixture(1);
      const connectedPlayerId = "93000000-0000-4000-8000-000000000001";
      const futurePlayerId = "94000000-0000-4000-8000-000000000001";
      await addActiveMember(
        pool,
        fixture.roomId,
        connectedPlayerId,
        "connected",
        "Connected Member",
      );
      await addActiveMember(
        pool,
        fixture.roomId,
        futurePlayerId,
        "connected",
        "Future Member",
      );
      const preservedDeadline = new Date(Date.now() + 5 * 60 * 1000);
      await markDisconnectedWithDeadline(fixture, futurePlayerId, preservedDeadline);

      const now = new Date();
      const summary = await recover(now, 60_000);
      assert.equal(summary.waitingRoomsPreserved, 1);
      assert.equal(summary.connectedMembershipsMarkedDisconnected, 2);
      assert.equal(summary.alreadyOverdueMembershipsRemoved, 0);
      assert.equal(summary.legacyDisconnectedMembershipsRemoved, 0);
      const state = await pool.query<{
        player_id: string;
        connection_status: string;
        generation: string;
        deadline: Date | null;
        version: number;
      }>(
        `SELECT rp.player_id::text, rp.connection_status,
                rp.disconnect_generation::text AS generation,
                rp.reconnect_deadline_at AS deadline,
                r.version::int AS version
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1
         ORDER BY rp.player_id`,
        [fixture.roomId],
      );
      const byPlayer = new Map(state.rows.map((row) => [row.player_id, row]));
      assert.equal(byPlayer.get(fixture.hostPlayerId)?.connection_status, "disconnected");
      assert.equal(byPlayer.get(fixture.hostPlayerId)?.generation, "1");
      assert.equal(byPlayer.get(connectedPlayerId)?.connection_status, "disconnected");
      assert.equal(byPlayer.get(connectedPlayerId)?.generation, "1");
      assert.equal(byPlayer.get(futurePlayerId)?.connection_status, "disconnected");
      assert.equal(byPlayer.get(futurePlayerId)?.generation, "1");
      assert.equal(
        byPlayer.get(futurePlayerId)?.deadline?.getTime(),
        preservedDeadline.getTime(),
      );
      assert.ok(state.rows.every((row) => row.version === 4));
      assert.equal(
        byPlayer.get(fixture.hostPlayerId)?.deadline?.getTime(),
        now.getTime() + 60_000,
      );
    });

    await t.test("removes overdue hosts using connected-first host transfer", async () => {
      const fixture = await makeFixture(2);
      const earlierDisconnectedId = "93000000-0000-4000-8000-000000000002";
      const connectedCandidateId = "94000000-0000-4000-8000-000000000002";
      await addActiveMember(
        pool,
        fixture.roomId,
        earlierDisconnectedId,
        "disconnected",
        "Earlier Disconnected",
        "2020-01-01T00:00:00.000Z",
      );
      await addActiveMember(
        pool,
        fixture.roomId,
        connectedCandidateId,
        "connected",
        "Connected Candidate",
        "2021-01-01T00:00:00.000Z",
      );
      const recoveryNow = new Date();
      await markDisconnectedWithDeadline(
        fixture,
        fixture.hostPlayerId,
        new Date(recoveryNow.getTime() - 1_000),
      );

      const summary = await recover(recoveryNow);
      assert.equal(summary.alreadyOverdueMembershipsRemoved, 1);
      const room = await pool.query<{
        host_player_id: string;
        version: number;
      }>(
        "SELECT host_player_id::text, version::int FROM public.rooms WHERE id = $1",
        [fixture.roomId],
      );
      assert.equal(room.rows[0]?.host_player_id, connectedCandidateId);
      assert.equal(room.rows[0]?.version, 4);
      const members = await pool.query<{
        player_id: string;
        membership_status: string;
        connection_status: string;
      }>(
        `SELECT player_id::text, membership_status, connection_status
         FROM public.room_players
         WHERE room_id = $1
         ORDER BY player_id`,
        [fixture.roomId],
      );
      assert.equal(
        members.rows.find((row) => row.player_id === fixture.hostPlayerId)?.membership_status,
        "removed",
      );
      assert.equal(
        members.rows.find((row) => row.player_id === connectedCandidateId)?.connection_status,
        "disconnected",
      );
    });

    await t.test("removes final overdue Manhunt member and cascades its boundary", async () => {
      const fixture = await makeFixture(3, "waiting", true);
      const recoveryNow = new Date();
      await markDisconnectedWithDeadline(
        fixture,
        fixture.hostPlayerId,
        new Date(recoveryNow.getTime() - 1_000),
      );

      const summary = await recover(recoveryNow);
      assert.equal(summary.alreadyOverdueMembershipsRemoved, 1);
      assert.equal(summary.emptyWaitingRoomsDeleted, 1);
      assert.deepEqual(summary.deletedRooms, [{
        roomId: fixture.roomId,
        roomCode: fixture.roomCode,
      }]);
      await assertNoRoomArtifacts(pool, fixture.roomId, fixture.hostPlayerId);
    });

    await t.test("removes legacy disconnected members without granting grace", async (st) => {
      const fixture = await makeFixture(4);
      const legacyPlayerId = "93000000-0000-4000-8000-000000000004";
      await addActiveMember(
        pool,
        fixture.roomId,
        legacyPlayerId,
        "connected",
        "Legacy Member",
      );
      await repository.markDisconnected(
        markDisconnectedInput(
          fixture.roomCode,
          legacyPlayerId,
          new Date(Date.now() + 10 * 60 * 1000),
        ),
      );
      await pool.query(
        "ALTER TABLE public.room_players DROP CONSTRAINT IF EXISTS room_players_disconnected_deadline_required",
      );
      await pool.query(
        `UPDATE public.room_players
         SET reconnect_deadline_at = NULL
         WHERE room_id = $1 AND player_id = $2`,
        [fixture.roomId, legacyPlayerId],
      );
      await pool.query(
        `ALTER TABLE public.room_players
         ADD CONSTRAINT room_players_disconnected_deadline_required
         CHECK (
           membership_status <> 'active'
           OR connection_status <> 'disconnected'
           OR reconnect_deadline_at IS NOT NULL
         ) NOT VALID`,
      );
      st.after(async () => {
        await pool.query(
          "ALTER TABLE public.room_players DROP CONSTRAINT IF EXISTS room_players_disconnected_deadline_required",
        );
        await pool.query(
          `ALTER TABLE public.room_players
           ADD CONSTRAINT room_players_disconnected_deadline_required
           CHECK (
             membership_status <> 'active'
             OR connection_status <> 'disconnected'
             OR reconnect_deadline_at IS NOT NULL
           ) NOT VALID`,
        );
      });

      const summary = await recover();
      assert.equal(summary.legacyDisconnectedMembershipsRemoved, 1);
      const state = await pool.query<{
        membership_status: string;
        reconnect_token_hash: Buffer | null;
        reconnect_deadline_at: Date | null;
        disconnect_generation: string;
      }>(
        `SELECT membership_status, reconnect_token_hash,
                reconnect_deadline_at, disconnect_generation::text
         FROM public.room_players
         WHERE room_id = $1 AND player_id = $2`,
        [fixture.roomId, legacyPlayerId],
      );
      assert.equal(state.rows[0]?.membership_status, "removed");
      assert.equal(state.rows[0]?.reconnect_token_hash, null);
      assert.equal(state.rows[0]?.reconnect_deadline_at, null);
      assert.equal(state.rows[0]?.disconnect_generation, "1");
    });

    await t.test("closes starting, in-progress, and finished rooms without claiming completion", async () => {
      const statuses = ["starting", "in_progress", "finished"] as const;
      const fixtures: Awaited<ReturnType<typeof makeFixture>>[] = [];
      for (let index = 0; index < statuses.length; index += 1) {
        const fixture = await makeFixture(5 + index, statuses[index]);
        fixtures.push(fixture);
        await addActiveMember(
          pool,
          fixture.roomId,
          `93000000-0000-4000-8000-${(5 + index).toString().padStart(12, "0")}`,
          "disconnected",
          `Interrupted Member ${index}`,
        );
      }
      const now = new Date(Date.now() + 1_000);

      const summary = await recover(now);
      assert.equal(summary.nonWaitingRoomsClosed, 3);
      assert.deepEqual(
        new Set(summary.closedRooms.map(({ roomId }) => roomId)),
        new Set(fixtures.map(({ roomId }) => roomId)),
      );
      const retrySummary = await recover(now);
      assert.equal(retrySummary.nonWaitingRoomsClosed, 0);
      assert.deepEqual(retrySummary.closedRooms, []);
      for (let index = 0; index < statuses.length; index += 1) {
        const fixture = fixtures[index];
        assert.ok(fixture);
        const room = await pool.query<{
          lifecycle_status: string;
          game_status: string;
          host_player_id: string | null;
          version: number;
          updated_at: Date;
        }>(
          `SELECT lifecycle_status, game_status, host_player_id::text,
                  version::int, updated_at
           FROM public.rooms WHERE id = $1`,
          [fixture?.roomId],
        );
        assert.deepEqual(room.rows[0], {
          lifecycle_status: "closed",
          game_status: statuses[index],
          host_player_id: null,
          version: 2,
          updated_at: now,
        });
        const members = await pool.query<{
          membership_status: string;
          connection_status: string;
          hash_is_null: boolean;
          deadline: Date | null;
          removed_at: Date;
        }>(
          `SELECT membership_status, connection_status,
                  reconnect_token_hash IS NULL AS hash_is_null,
                  reconnect_deadline_at AS deadline, removed_at
           FROM public.room_players WHERE room_id = $1`,
          [fixture?.roomId],
        );
        assert.equal(members.rowCount, 2);
        for (const member of members.rows) {
          assert.deepEqual(member, {
            membership_status: "removed",
            connection_status: "disconnected",
            hash_is_null: true,
            deadline: null,
            removed_at: now,
          });
        }
      }
    });

    await t.test("repeating recovery does not extend deadlines or increment versions", async () => {
      const fixture = await makeFixture(8);
      const futurePlayerId = "93000000-0000-4000-8000-000000000008";
      await addActiveMember(
        pool,
        fixture.roomId,
        futurePlayerId,
        "connected",
        "Future Member",
      );
      const now = new Date();
      const preservedDeadline = new Date(now.getTime() + 5 * 60 * 1000);
      await markDisconnectedWithDeadline(fixture, futurePlayerId, preservedDeadline);

      const first = await recover(now, 60_000);
      const beforeRetry = await pool.query<{
        version: number;
        generation: string;
        deadline: Date | null;
      }>(
        `SELECT r.version::int, rp.disconnect_generation::text AS generation,
                rp.reconnect_deadline_at AS deadline
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [fixture.roomId, fixture.hostPlayerId],
      );
      const second = await recover(now, 60_000);
      const afterRetry = await pool.query<{
        version: number;
        generation: string;
        deadline: Date | null;
      }>(
        `SELECT r.version::int, rp.disconnect_generation::text AS generation,
                rp.reconnect_deadline_at AS deadline
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [fixture.roomId, fixture.hostPlayerId],
      );
      assert.equal(first.connectedMembershipsMarkedDisconnected, 1);
      assert.equal(second.connectedMembershipsMarkedDisconnected, 0);
      assert.deepEqual(afterRetry.rows[0], beforeRetry.rows[0]);
      assert.equal(afterRetry.rows[0]?.deadline?.getTime(), now.getTime() + 60_000);
      const future = await pool.query<{ deadline: Date; generation: string }>(
        `SELECT reconnect_deadline_at AS deadline,
                disconnect_generation::text AS generation
         FROM public.room_players
         WHERE room_id = $1 AND player_id = $2`,
        [fixture.roomId, futurePlayerId],
      );
      assert.equal(future.rows[0]?.deadline.getTime(), preservedDeadline.getTime());
      assert.equal(future.rows[0]?.generation, "1");
    });

    await t.test("rejects invalid dates and grace bounds before database mutation", async () => {
      const fixture = await makeFixture(9);
      const before = await pool.query<{
        version: number;
        membership_status: string;
        connection_status: string;
        generation: string;
      }>(
        `SELECT r.version::int, rp.membership_status, rp.connection_status,
                rp.disconnect_generation::text AS generation
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [fixture.roomId, fixture.hostPlayerId],
      );
      await assert.rejects(
        recover(new Date(Number.NaN), 1),
        TypeError,
      );
      await assert.rejects(
        recover(new Date(), 0),
        RangeError,
      );
      await assert.rejects(
        recover(new Date(), 86_400_001),
        RangeError,
      );
      const after = await pool.query<{
        version: number;
        membership_status: string;
        connection_status: string;
        generation: string;
      }>(
        `SELECT r.version::int, rp.membership_status, rp.connection_status,
                rp.disconnect_generation::text AS generation
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [fixture.roomId, fixture.hostPlayerId],
      );
      assert.deepEqual(after.rows[0], before.rows[0]);
    });

    await t.test("accepts the configured inclusive grace-period bounds", async () => {
      const minimumFixture = await makeFixture(11);
      const futureNow = new Date(Date.now() + 60_000);
      await recover(futureNow, 1);
      const maximumFixture = await makeFixture(12);
      await recover(futureNow, 86_400_000);
      const deadlines = await pool.query<{
        player_id: string;
        deadline: Date;
      }>(
        `SELECT player_id::text, reconnect_deadline_at AS deadline
         FROM public.room_players
         WHERE room_id = ANY($1::uuid[])
         ORDER BY player_id`,
        [[minimumFixture.roomId, maximumFixture.roomId]],
      );
      const byPlayer = new Map(deadlines.rows.map((row) => [row.player_id, row.deadline]));
      assert.equal(
        byPlayer.get(minimumFixture.hostPlayerId)?.getTime(),
        futureNow.getTime() + 1,
      );
      assert.equal(
        byPlayer.get(maximumFixture.hostPlayerId)?.getTime(),
        futureNow.getTime() + 86_400_000,
      );
    });

    await t.test("rolls back a room if membership closure fails midway", async () => {
      const fixture = await makeFixture(10, "starting");
      await pool.query(
        `CREATE OR REPLACE FUNCTION public.fail_runtime_recovery_member_update()
         RETURNS trigger
         LANGUAGE plpgsql
         AS $function$
         BEGIN
           RAISE EXCEPTION 'injected recovery transition failure';
         END;
         $function$`,
      );
      await pool.query(
        "DROP TRIGGER IF EXISTS fail_runtime_recovery_member_update ON public.room_players",
      );
      await pool.query(
        `CREATE TRIGGER fail_runtime_recovery_member_update
         BEFORE UPDATE OF membership_status ON public.room_players
         FOR EACH ROW
         EXECUTE FUNCTION public.fail_runtime_recovery_member_update()`,
      );
      try {
        await assert.rejects(recover(), /injected recovery transition failure/);
      } finally {
        await pool.query(
          "DROP TRIGGER IF EXISTS fail_runtime_recovery_member_update ON public.room_players",
        );
        await pool.query(
          "DROP FUNCTION IF EXISTS public.fail_runtime_recovery_member_update()",
        );
      }

      const state = await pool.query<{
        lifecycle_status: string;
        host_player_id: string | null;
        version: number;
        membership_status: string;
        connection_status: string;
        hash_is_null: boolean;
      }>(
        `SELECT r.lifecycle_status, r.host_player_id::text,
                r.version::int, rp.membership_status, rp.connection_status,
                rp.reconnect_token_hash IS NULL AS hash_is_null
         FROM public.rooms AS r
         JOIN public.room_players AS rp ON rp.room_id = r.id
         WHERE r.id = $1 AND rp.player_id = $2`,
        [fixture.roomId, fixture.hostPlayerId],
      );
      assert.deepEqual(state.rows[0], {
        lifecycle_status: "active",
        host_player_id: fixture.hostPlayerId,
        version: 1,
        membership_status: "active",
        connection_status: "connected",
        hash_is_null: false,
      });
    });
  });

  await t.test("stale generations, not-yet-due deadlines, reconnected and removed members do not mutate state", async (st) => {
    const now = new Date();
    const stale = await makeFixture(8, { deadline: new Date(now.getTime() - 1_000) });
    const staleBefore = await queryMemberState(stale.roomId, stale.playerId);
    assert.equal((await remove(stale, "0", now)).status, "stale");
    assert.deepEqual(await queryMemberState(stale.roomId, stale.playerId), staleBefore);

    const future = await makeFixture(9, { deadline: new Date(now.getTime() + 60_000) });
    const futureBefore = await queryMemberState(future.roomId, future.playerId);
    assert.equal((await remove(future, "1", now)).status, "not_due");
    assert.deepEqual(await queryMemberState(future.roomId, future.playerId), futureBefore);

    const reconnected = await makeFixture(10, { deadline: new Date(now.getTime() + 60_000) });
    await repository.reconnectPlayer(
      reconnectInput(reconnected.roomCode, reconnected.playerId, reconnected.token),
    );
    const reconnectedBefore = await queryMemberState(reconnected.roomId, reconnected.playerId);
    assert.equal((await remove(reconnected, "1", new Date(Date.now() + 120_000))).status, "stale");
    assert.deepEqual(await queryMemberState(reconnected.roomId, reconnected.playerId), reconnectedBefore);

    const removed = await makeFixture(11, { deadline: new Date(now.getTime() - 1_000) });
    await repository.leaveRoom(leaveInput(removed.roomCode, removed.playerId));
    const removedBefore = await queryMemberState(removed.roomId, removed.playerId);
    assert.equal((await remove(removed, "1", now)).status, "stale");
    assert.deepEqual(await queryMemberState(removed.roomId, removed.playerId), removedBefore);
    await st.test("the stale outcomes leave room versions and membership state unchanged", () => {
      assert.equal(staleBefore?.version, 2);
      assert.equal(futureBefore?.version, 2);
      assert.equal(reconnectedBefore?.version, 3);
      assert.equal(removedBefore?.membership_status, "removed");
    });
  });

  await t.test("missing rooms, missing memberships, inactive rooms and connected members are stale", async () => {
    const now = new Date(Date.now() + 1_000);
    assert.equal(
      (await remove(
        { roomCode: "ZZZZ", playerId: "83000000-0000-4000-8000-000000000099" },
        "1",
        now,
      )).status,
      "stale",
    );

    const missingMember = await makeFixture(12);
    assert.equal(
      (await remove(
        { roomCode: missingMember.roomCode, playerId: "83000000-0000-4000-8000-000000000099" },
        "1",
        now,
      )).status,
      "stale",
    );
    const inactive = await makeFixture(13, { deadline: new Date(now.getTime() - 1_000) });
    await pool.query(
      "UPDATE public.rooms SET lifecycle_status = 'closed' WHERE id = $1",
      [inactive.roomId],
    );
    assert.equal((await remove(inactive, "1", now)).status, "stale");

    const noDeadline = await makeFixture(21, { deadline: new Date(now.getTime() - 1_000) });
    await setLegacyDeadlineNull(noDeadline);
    assert.equal((await remove(noDeadline, "1", now)).status, "stale");

    const connected = await makeFixture(14);
    await repository.reconnectPlayer(
      reconnectInput(connected.roomCode, connected.playerId, connected.token),
    );
    assert.equal(
      (await remove(connected, "1", new Date(Date.now() + 20 * 60 * 1000))).status,
      "stale",
    );
  });

  await t.test("transfers a disconnected host using connected-first and deterministic ordering", async () => {
    const now = new Date(Date.now() + 1_000);
    const fixture = await makeFixture(15, {
      targetIsHost: true,
      deadline: new Date(now.getTime() - 1_000),
    });
    const firstConnected = "80000000-0000-4000-8000-000000000015";
    const secondConnected = "80000000-0000-4000-8000-000000000014";
    const disconnected = "80000000-0000-4000-8000-000000000013";
    await addActiveMember(pool, fixture.roomId, firstConnected, "connected", "Connected One", "2026-01-01T00:00:00Z");
    await addActiveMember(pool, fixture.roomId, secondConnected, "connected", "Connected Two", "2026-01-01T00:00:00Z");
    await addActiveMember(pool, fixture.roomId, disconnected, "disconnected", "Disconnected", "2025-01-01T00:00:00Z");
    const result = await remove(fixture, "1", now);
    assert.equal(result.status, "removed");
    if (result.status === "removed") {
      assert.equal(result.hostChanged, true);
      assert.equal(result.hostPlayerId, secondConnected);
    }
    const room = await pool.query<{ host_player_id: string; version: number }>(
      "SELECT host_player_id::text, version::int FROM public.rooms WHERE id = $1",
      [fixture.roomId],
    );
    assert.deepEqual(room.rows[0], {
      host_player_id: secondConnected,
      version: 3,
    });
  });

  await t.test("deletes the last-member room, cascades private data, and allows code reuse", async () => {
    const now = new Date(Date.now() + 1_000);
    const fixture = await makeFixture(16, {
      targetIsHost: true,
      manhunt: true,
      deadline: new Date(now.getTime() - 1_000),
    });
    const result = await remove(fixture, "1", now);
    assert.deepEqual(result, {
      status: "room_deleted",
      roomId: fixture.roomId,
      roomCode: fixture.roomCode,
      playerId: fixture.playerId,
      deleted: true,
      currentGameId: null,
    });
    await assertNoRoomArtifacts(pool, fixture.roomId, fixture.playerId);

    const replacement = createInput(
      "84000000-0000-4000-8000-000000000016",
      "85000000-0000-4000-8000-000000000016",
      fixture.roomCode,
      fixture.settings,
    );
    createdRoomIds.push(replacement.roomId);
    const created = await repository.createRoomWithHost(replacement);
    assert.equal(created.roomCode, fixture.roomCode);
  });

  await t.test("serializes reconnect-first and timeout-first races across independent connections", async (st) => {
    await st.test("a reconnect that commits first makes its old timeout stale", async () => {
      const fixture = await makeFixture(17, {
        deadline: new Date(Date.now() + 60_000),
      });
      const timeoutNow = new Date(fixture.deadline.getTime() + 1_000);
      const reconnectPool = createTestPool(1);
      const timeoutPool = createTestPool(1);
      try {
        const [reconnectPid, timeoutPid] = await Promise.all([
          reconnectPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
          timeoutPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
        ]);
        assert.notEqual(reconnectPid.rows[0]?.pid, timeoutPid.rows[0]?.pid);
        await createTestRepository(reconnectPool).reconnectPlayer(
          reconnectInput(fixture.roomCode, fixture.playerId, fixture.token),
        );
        const result = await createTestRepository(timeoutPool).removeDisconnectedPlayer({
          roomCode: fixture.roomCode as RemoveDisconnectedPlayerInput["roomCode"],
          playerId: fixture.playerId as RemoveDisconnectedPlayerInput["playerId"],
          expectedDisconnectGeneration: "1",
          now: timeoutNow,
        });
        assert.equal(result.status, "stale");
        const state = await queryMemberState(fixture.roomId, fixture.playerId);
        assert.equal(state?.connection_status, "connected");
        assert.equal(state?.generation, "2");
      } finally {
        await Promise.all([reconnectPool.end(), timeoutPool.end()]);
      }
    });

    await st.test("a queued timeout that obtains the room lock first prevents reconnect", async () => {
      const fixture = await makeFixture(18, {
        deadline: new Date(Date.now() + 60_000),
      });
      const timeoutNow = new Date(fixture.deadline.getTime() + 1_000);
      const timeoutPool = createTestPool(1);
      const reconnectPool = createTestPool(1);
      const blocker = await pool.connect();
      const waitUntilLocked = async (pid: number) => {
        for (let attempt = 0; attempt < 300; attempt += 1) {
          const waiting = await pool.query<{ wait_event_type: string | null }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
            [pid],
          );
          if (waiting.rows[0]?.wait_event_type === "Lock") return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail(`Backend ${pid} did not reach the expected row-lock wait.`);
      };
      try {
        const [timeoutPidResult, reconnectPidResult] = await Promise.all([
          timeoutPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
          reconnectPool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
        ]);
        const timeoutPid = timeoutPidResult.rows[0]?.pid;
        const reconnectPid = reconnectPidResult.rows[0]?.pid;
        assert.ok(timeoutPid);
        assert.ok(reconnectPid);
        assert.notEqual(timeoutPid, reconnectPid);

        await blocker.query("BEGIN");
        await blocker.query(
          "SELECT id FROM public.rooms WHERE room_code = $1 FOR UPDATE",
          [fixture.roomCode],
        );
        const timeoutPromise = createTestRepository(timeoutPool).removeDisconnectedPlayer({
          roomCode: fixture.roomCode as RemoveDisconnectedPlayerInput["roomCode"],
          playerId: fixture.playerId as RemoveDisconnectedPlayerInput["playerId"],
          expectedDisconnectGeneration: "1",
          now: timeoutNow,
        });
        await waitUntilLocked(timeoutPid);
        const reconnectPromise = createTestRepository(reconnectPool).reconnectPlayer(
          reconnectInput(fixture.roomCode, fixture.playerId, fixture.token),
        );
        await waitUntilLocked(reconnectPid);
        await blocker.query("COMMIT");

        const [timeoutResult, reconnectResult] = await Promise.allSettled([
          timeoutPromise,
          reconnectPromise,
        ]);
        assert.equal(timeoutResult.status, "fulfilled");
        if (timeoutResult.status !== "fulfilled") {
          assert.fail("Expected timeout removal to commit first.");
        }
        assert.equal(timeoutResult.value.status, "removed");
        assert.equal(reconnectResult.status, "rejected");
        if (reconnectResult.status !== "rejected") {
          assert.fail("Reconnect should not restore a removed member.");
        }
        assert.ok(reconnectResult.reason instanceof RoomConnectionError);
        assert.equal(reconnectResult.reason.code, "MEMBERSHIP_NOT_ACTIVE");
        const state = await queryMemberState(fixture.roomId, fixture.playerId);
        assert.equal(state?.membership_status, "removed");
        assert.equal(state?.connection_status, "disconnected");
        assert.equal(state?.generation, "1");
        assert.equal(state?.version, 3);
      } finally {
        await blocker.query("ROLLBACK");
        blocker.release();
        await Promise.all([timeoutPool.end(), reconnectPool.end()]);
      }
    });
  });
});
