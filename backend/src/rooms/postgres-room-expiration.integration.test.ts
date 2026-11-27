import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { acquireRoomRuntimeLease, createPostgresPool } from "../db/postgres.js";
import type { Pool } from "pg";
import type { RoomCode, RoomSettings } from "@impostor/api";
import { PostgresRoomRepository } from "./postgres-room-repository.js";
import type { DueWaitingRoomExpiration } from "./postgres-room-repository.js";

type ExpirationKind = "past" | "future" | "none";
type GameStatus = "waiting" | "starting" | "in_progress" | "finished";

interface SeededExpirationRoom {
  readonly roomId: string;
  readonly hostId: string;
  readonly roomCode: RoomCode;
  readonly gameStatus: GameStatus;
  readonly version: string;
}

const CLASSIC_SETTINGS: RoomSettings = {
  gameMode: "impostor-classic",
  maxPlayers: 4,
  isPrivate: false,
};

function createIntegrationPool(): Pool {
  const database = process.env.ROOM_REPOSITORY_TEST_DATABASE;
  const user = process.env.ROOM_REPOSITORY_TEST_USER;
  if (
    process.env.DURABLE_ROOM_CI_DATABASE !== "1"
    || database !== "durable_room_test"
    || user !== "postgres"
  ) {
    throw new Error(
      "PostgreSQL expiration integration tests require the guarded disposable durable_room_test database.",
    );
  }

  return createPostgresPool({
    host: "127.0.0.1",
    port: 55432,
    database,
    user,
    password: "local-trust-auth-only",
    max: 8,
  });
}

function uniqueRoomCode(used: Set<string>): RoomCode {
  while (true) {
    const code = [...randomBytes(4)]
      .map((byte) => String.fromCharCode(65 + (byte % 26)))
      .join("");
    if (!used.has(code)) {
      used.add(code);
      return code as RoomCode;
    }
  }
}

async function seedExpirationRoom(
  pool: Pool,
  roomCode: RoomCode,
  gameStatus: GameStatus,
  expiration: ExpirationKind,
  version: string,
  currentGameId = gameStatus === "waiting" ? null : randomUUID(),
): Promise<SeededExpirationRoom> {
  const roomId = randomUUID();
  const hostId = randomUUID();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO public.rooms (
         id, room_code, game_mode, settings, max_players, host_player_id,
         game_status, lifecycle_status, created_at, updated_at, expires_at,
         version, current_game_id
       )
       VALUES (
         $1, $2, 'impostor-classic', $3::jsonb, 4, $4, $5, 'active',
         clock_timestamp() - interval '1 day',
         clock_timestamp() - interval '1 day',
         CASE $6::text
           WHEN 'past' THEN clock_timestamp() - interval '1 minute'
           WHEN 'future' THEN clock_timestamp() + interval '1 hour'
           ELSE NULL
         END,
         $7::bigint, $8
       )`,
      [
        roomId,
        roomCode,
        JSON.stringify(CLASSIC_SETTINGS),
        hostId,
        gameStatus,
        expiration,
        version,
        currentGameId,
      ],
    );
    await client.query(
      `INSERT INTO public.room_players (
         room_id, player_id, nickname, reconnect_token_hash
       )
       VALUES ($1, $2, 'Expiration Host', $3)`,
      [roomId, hostId, Buffer.alloc(32, 0x5a)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return { roomId, hostId, roomCode, gameStatus, version };
}

test("PostgreSQL room expiration uses the database clock and preserves lifecycle invariants", async (t) => {
  const pool = createIntegrationPool();
  const usedRoomCodes = new Set<string>();
  const roomIds: string[] = [];
  let releaseLease: (() => Promise<void>) | undefined;

  try {
    const lease = await acquireRoomRuntimeLease(pool);
    releaseLease = () => lease.release();
    const repository = new PostgresRoomRepository(pool);
    repository.setRuntimeFencingEpoch(lease.fencingEpoch);

    const due = await seedExpirationRoom(
      pool,
      uniqueRoomCode(usedRoomCodes),
      "waiting",
      "past",
      "17",
    );
    roomIds.push(due.roomId);
    const noExpiry = await seedExpirationRoom(
      pool,
      uniqueRoomCode(usedRoomCodes),
      "waiting",
      "none",
      "21",
    );
    roomIds.push(noExpiry.roomId);
    const future = await seedExpirationRoom(
      pool,
      uniqueRoomCode(usedRoomCodes),
      "waiting",
      "future",
      "22",
    );
    roomIds.push(future.roomId);
    const nonWaiting = await Promise.all(
      (["starting", "in_progress", "finished"] as const).map(
        (gameStatus, index) =>
          seedExpirationRoom(
            pool,
            uniqueRoomCode(usedRoomCodes),
            gameStatus,
            "past",
            String(30 + index),
            null,
          ),
      ),
    );
    roomIds.push(...nonWaiting.map((room) => room.roomId));

    const candidates = await repository.listDueWaitingRoomExpirations(50);
    const fixtureCandidates = candidates.filter((candidate) =>
      roomIds.includes(candidate.roomId),
    );
    let dueCandidate: DueWaitingRoomExpiration | undefined;

    await t.test("selects only expired, active waiting rooms using PostgreSQL time", () => {
      assert.deepEqual(fixtureCandidates, [{
        roomId: due.roomId,
        roomCode: due.roomCode,
        expectedVersion: due.version,
      }]);
      dueCandidate = fixtureCandidates[0];
    });

    let expiredVersion: string | undefined;
    let firstUpdatedAt: Date | undefined;
    await t.test("marks the eligible room expired and increments its version once", async () => {
      assert.ok(dueCandidate);
      const expired = await repository.expireWaitingRoom(dueCandidate);
      assert.deepEqual(expired, {
        roomId: due.roomId,
        roomCode: due.roomCode,
        version: "18",
      });
      expiredVersion = expired.version;

      const result = await pool.query<{
        lifecycle_status: string;
        game_status: string;
        version: string;
        updated_at: Date;
        expiry_passed: boolean;
      }>(
        `SELECT lifecycle_status, game_status, version::text, updated_at,
                expires_at <= clock_timestamp() AS expiry_passed
         FROM public.rooms WHERE id = $1`,
        [due.roomId],
      );
      assert.deepEqual(
        {
          lifecycleStatus: result.rows[0]?.lifecycle_status,
          gameStatus: result.rows[0]?.game_status,
          version: result.rows[0]?.version,
          expiryPassed: result.rows[0]?.expiry_passed,
        },
        {
          lifecycleStatus: "expired",
          gameStatus: "waiting",
          version: "18",
          expiryPassed: true,
        },
      );
      firstUpdatedAt = result.rows[0]?.updated_at;
      assert.ok(firstUpdatedAt instanceof Date);
    });

    await t.test("repeated cleanup is idempotent and does not change the row again", async () => {
      assert.ok(dueCandidate);
      assert.ok(expiredVersion);
      assert.ok(firstUpdatedAt);
      assert.deepEqual(
        await repository.expireWaitingRoom(dueCandidate),
        {
          roomId: due.roomId,
          roomCode: due.roomCode,
          version: expiredVersion,
        },
      );

      const result = await pool.query<{
        lifecycle_status: string;
        version: string;
        updated_at: Date;
      }>(
        `SELECT lifecycle_status, version::text, updated_at
         FROM public.rooms WHERE id = $1`,
        [due.roomId],
      );
      assert.equal(result.rows[0]?.lifecycle_status, "expired");
      assert.equal(result.rows[0]?.version, expiredVersion);
      assert.equal(result.rows[0]?.updated_at.toISOString(), firstUpdatedAt.toISOString());
    });

    await t.test("expired room code can be reused by a new active room", async () => {
      const newRoomId = randomUUID();
      const newHostId = randomUUID();
      const created = await repository.createRoomWithHost({
        roomId: newRoomId,
        roomCode: due.roomCode,
        gameMode: CLASSIC_SETTINGS.gameMode,
        settings: CLASSIC_SETTINGS,
        maxPlayers: CLASSIC_SETTINGS.maxPlayers,
        hostPlayerId: newHostId,
        hostNickname: "Replacement Host",
        reconnectTokenHash: Buffer.alloc(32, 0x6b),
      });
      roomIds.push(newRoomId);

      assert.equal(created.roomCode, due.roomCode);
      assert.equal(created.lifecycleStatus, "active");
      assert.equal(created.version, "1");
      const rows = await pool.query<{
        id: string;
        lifecycle_status: string;
        version: string;
      }>(
        `SELECT id::text, lifecycle_status, version::text
         FROM public.rooms WHERE room_code = $1 ORDER BY lifecycle_status`,
        [due.roomCode],
      );
      assert.deepEqual(rows.rows, [
        { id: newRoomId, lifecycle_status: "active", version: "1" },
        { id: due.roomId, lifecycle_status: "expired", version: "18" },
      ]);
    });

    await t.test("NULL, future, and nonwaiting expirations remain unchanged", async () => {
      const result = await pool.query<{
        id: string;
        lifecycle_status: string;
        game_status: string;
        version: string;
        expires_at: Date | null;
        deadline_passed: boolean | null;
      }>(
        `SELECT id::text, lifecycle_status, game_status, version::text,
                expires_at,
                CASE WHEN expires_at IS NULL THEN NULL
                     ELSE expires_at <= clock_timestamp()
                END AS deadline_passed
         FROM public.rooms
         WHERE id = ANY($1::uuid[])`,
        [[noExpiry.roomId, future.roomId, ...nonWaiting.map((room) => room.roomId)]],
      );
      const byId = new Map(result.rows.map((row) => [row.id, row]));

      assert.equal(byId.get(noExpiry.roomId)?.lifecycle_status, "active");
      assert.equal(byId.get(noExpiry.roomId)?.version, "21");
      assert.equal(byId.get(noExpiry.roomId)?.expires_at, null);
      assert.equal(byId.get(future.roomId)?.lifecycle_status, "active");
      assert.equal(byId.get(future.roomId)?.version, "22");
      assert.equal(byId.get(future.roomId)?.deadline_passed, false);
      for (const [index, room] of nonWaiting.entries()) {
        assert.equal(byId.get(room.roomId)?.lifecycle_status, "active");
        assert.equal(byId.get(room.roomId)?.game_status, room.gameStatus);
        assert.equal(byId.get(room.roomId)?.version, String(30 + index));
        assert.equal(byId.get(room.roomId)?.deadline_passed, true);
      }
    });
  } finally {
    try {
      if (roomIds.length > 0) {
        await pool.query(
          "DELETE FROM public.rooms WHERE id = ANY($1::uuid[])",
          [roomIds],
        );
      }
    } finally {
      try {
        await releaseLease?.();
      } finally {
        await pool.end();
      }
    }
  }
});
