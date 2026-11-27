import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import type { GameSessionId, RoomCode } from "@impostor/api";
import {
  PostgresRoomRepository,
  RoomRuntimeFencingError,
} from "./postgres-room-repository.js";
import type { DueWaitingRoomExpiration } from "./postgres-room-repository.js";

interface FakeRoom {
  id: string;
  room_code: RoomCode;
  lifecycle_status: "active" | "expired";
  game_status: "waiting" | "starting" | "in_progress" | "finished";
  current_game_id: GameSessionId | null;
  version: string;
  expires_at_ms: number | null;
}

class ExpirationFakeDatabase {
  nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  epoch = "9";
  readonly rooms: FakeRoom[] = [];
  readonly statements: string[] = [];

  addRoom(
    roomCode: string,
    options: Partial<Pick<
      FakeRoom,
      | "lifecycle_status"
      | "game_status"
      | "current_game_id"
      | "version"
      | "expires_at_ms"
    >> = {},
  ): FakeRoom {
    const room: FakeRoom = {
      id: randomUUID(),
      room_code: roomCode as RoomCode,
      lifecycle_status: options.lifecycle_status ?? "active",
      game_status: options.game_status ?? "waiting",
      current_game_id: options.current_game_id ?? null,
      version: options.version ?? "1",
      expires_at_ms: options.expires_at_ms ?? null,
    };
    this.rooms.push(room);
    return room;
  }

  pool(): Pool {
    let transactionSnapshot: FakeRoom[] | undefined;
    const client = {
      query: async <Row extends QueryResultRow>(
        sql: string,
        values: unknown[] = [],
      ): Promise<QueryResult<Row>> => {
        this.statements.push(sql);
        const normalized = sql.replace(/\s+/g, " ").trim();
        let rows: QueryResultRow[] = [];
        if (normalized === "BEGIN") {
          transactionSnapshot = this.rooms.map((room) => ({ ...room }));
        } else if (normalized === "COMMIT") {
          transactionSnapshot = undefined;
        } else if (normalized === "ROLLBACK") {
          if (transactionSnapshot) {
            this.rooms.splice(
              0,
              this.rooms.length,
              ...transactionSnapshot.map((room) => ({ ...room })),
            );
          }
          transactionSnapshot = undefined;
        } else if (normalized.includes("FROM public.room_runtime_fencing")) {
          rows = [{ epoch: this.epoch }];
        } else if (normalized.startsWith("WITH due_rooms AS")) {
          assert.match(normalized, /lifecycle_status = 'active'/);
          assert.match(normalized, /game_status = 'waiting'/);
          assert.match(normalized, /current_game_id IS NULL/);
          assert.match(normalized, /expires_at IS NOT NULL/);
          assert.match(normalized, /expires_at <= clock_timestamp\(\)/);
          const due = this.dueWaitingRooms()
            .slice(0, Number(values[0]));
          for (const room of due) {
            room.lifecycle_status = "expired";
            room.version = (BigInt(room.version) + 1n).toString();
          }
          rows = due.map((room) => ({
            id: room.id,
            room_code: room.room_code,
            version: room.version,
          }));
        } else if (
          normalized.startsWith("SELECT id::text, room_code, version::text")
        ) {
          assert.match(normalized, /lifecycle_status = 'active'/);
          assert.match(normalized, /game_status = 'waiting'/);
          assert.match(normalized, /current_game_id IS NULL/);
          assert.match(normalized, /expires_at IS NOT NULL/);
          assert.match(normalized, /expires_at <= clock_timestamp\(\)/);
          rows = this.dueWaitingRooms()
            .slice(0, Number(values[0]))
            .map((room) => ({
              id: room.id,
              room_code: room.room_code,
              version: room.version,
            }));
        } else if (normalized.startsWith("SELECT id::text, room_code, lifecycle_status")) {
          const room = this.rooms.find(
            (entry) => entry.id === values[0] && entry.room_code === values[1],
          );
          rows = room
            ? [{
                id: room.id,
                room_code: room.room_code,
                lifecycle_status: room.lifecycle_status,
                game_status: room.game_status,
                current_game_id: room.current_game_id,
                version: room.version,
                expiry_passed:
                  room.expires_at_ms !== null && room.expires_at_ms <= this.nowMs,
              }]
            : [];
        } else if (normalized.startsWith("UPDATE public.rooms SET lifecycle_status = 'expired'")) {
          const room = this.rooms.find(
            (entry) =>
              entry.id === values[0]
              && entry.room_code === values[1]
              && entry.version === values[2],
          );
          if (
            room
            && room.lifecycle_status === "active"
            && room.game_status === "waiting"
            && room.current_game_id === null
            && room.expires_at_ms !== null
            && room.expires_at_ms <= this.nowMs
          ) {
            room.lifecycle_status = "expired";
            room.version = (BigInt(room.version) + 1n).toString();
            rows = [{
              id: room.id,
              room_code: room.room_code,
              version: room.version,
            }];
          }
        } else {
          assert.fail(`Unexpected SQL in expiration test fake: ${normalized}`);
        }
        return {
          rows: rows as Row[],
          rowCount: rows.length,
          command: "SELECT",
          oid: 0,
          fields: [],
        };
      },
      release() {},
    } as unknown as PoolClient;
    return {
      connect: async () => client,
      query: async (sql: string) => {
        this.statements.push(sql);
        assert.match(
          sql.replace(/\s+/g, " ").trim(),
          /r\.expires_at IS NULL OR r\.expires_at > clock_timestamp\(\)/,
        );
        return {
          rows: [],
          rowCount: 0,
          command: "SELECT",
          oid: 0,
          fields: [],
        };
      },
    } as unknown as Pool;
  }

  private dueWaitingRooms(): FakeRoom[] {
    return this.rooms
      .filter((room) =>
        room.lifecycle_status === "active"
        && room.game_status === "waiting"
        && room.current_game_id === null
        && room.expires_at_ms !== null
        && room.expires_at_ms <= this.nowMs)
      .sort((left, right) =>
        left.expires_at_ms! - right.expires_at_ms!
        || left.id.localeCompare(right.id));
  }
}

function createRepository(database: ExpirationFakeDatabase): PostgresRoomRepository {
  const repository = new PostgresRoomRepository(database.pool());
  repository.setRuntimeFencingEpoch("9");
  return repository;
}

test("fake-backed repository expiry models database-time eligibility", async () => {
  const database = new ExpirationFakeDatabase();
  const due = database.addRoom("DUEA", {
    expires_at_ms: database.nowMs - 1,
  });
  const noExpiry = database.addRoom("NULL");
  const future = database.addRoom("FUTR", {
    expires_at_ms: database.nowMs + 1,
  });
  const starting = database.addRoom("STRT", {
    game_status: "starting",
    current_game_id: "starting-game" as GameSessionId,
    expires_at_ms: database.nowMs - 1,
  });
  const active = database.addRoom("ACTV", {
    game_status: "in_progress",
    current_game_id: "active-game" as GameSessionId,
    expires_at_ms: database.nowMs - 1,
  });
  const repository = createRepository(database);

  assert.deepEqual(await repository.loadRecoverableWaitingRooms(), []);
  const candidates = await repository.listDueWaitingRoomExpirations(10);
  assert.deepEqual(candidates, [{
    roomId: due.id,
    roomCode: due.room_code,
    expectedVersion: "1",
  }]);
  const stale = await repository.expireWaitingRoom({
    ...candidates[0]!,
    expectedVersion: "2",
  });
  assert.equal(stale, undefined);
  assert.equal(due.lifecycle_status, "active");

  const expired = await repository.expireWaitingRoom(candidates[0]!);
  assert.deepEqual(expired, {
    roomId: due.id,
    roomCode: due.room_code,
    version: "2",
  });
  assert.deepEqual(
    await repository.expireWaitingRoom(candidates[0]!),
    expired,
  );
  assert.equal(
    database.statements.filter((sql) =>
      sql.includes("SET lifecycle_status = 'expired'")).length,
    1,
  );
  assert.equal(noExpiry.lifecycle_status, "active");
  assert.equal(future.lifecycle_status, "active");
  assert.equal(starting.lifecycle_status, "active");
  assert.equal(active.lifecycle_status, "active");
});

test("fake-backed batch expiry is bounded and respects fencing", async () => {
  const database = new ExpirationFakeDatabase();
  const due = [
    database.addRoom("BAAA", { expires_at_ms: database.nowMs - 2 }),
    database.addRoom("BAAB", { expires_at_ms: database.nowMs - 1 }),
  ];
  const repository = createRepository(database);

  assert.equal(await repository.expireDueWaitingRooms(1), 1);
  assert.equal(due[0]!.lifecycle_status, "expired");
  assert.equal(due[1]!.lifecycle_status, "active");
  assert.equal(await repository.expireDueWaitingRooms(1), 1);
  assert.equal(database.rooms.length, 2);
  await assert.rejects(
    repository.expireDueWaitingRooms(51),
    /batch size must be between 1 and 50/,
  );

  database.epoch = "10";
  await assert.rejects(
    repository.expireDueWaitingRooms(1),
    RoomRuntimeFencingError,
  );
  assert.equal(due.every((room) => room.lifecycle_status === "expired"), true);
});
