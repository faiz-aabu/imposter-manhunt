import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { GameSessionId, GameStatus, RoomCode } from "@impostor/api";
import {
  RoomPersistenceCommands,
} from "./room-persistence-commands.js";
import { RoomPersistenceCoordinator } from "./room-persistence-coordinator.js";
import {
  RoomService,
} from "./room-service.js";
import {
  DurableRoomExpirationWorker,
} from "./durable-room-expiration-worker.js";
import {
  RoomJoinError,
  RoomRuntimeFencingError,
} from "./postgres-room-repository.js";
import type {
  DueWaitingRoomExpiration,
  ExpiredWaitingRoom,
  JoinRoomInput,
  PostgresRoomRepository,
} from "./postgres-room-repository.js";

interface FakeExpirationRoom {
  roomId: string;
  roomCode: RoomCode;
  lifecycleStatus: "active" | "expired";
  gameStatus: GameStatus;
  currentGameId: GameSessionId | null;
  expiresAtMs: number | null;
  version: string;
}

class FakeExpirationDatabase {
  nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  fencingEpoch = "7";
  readonly rooms = new Map<string, FakeExpirationRoom>();
  readonly memoryRooms = new Set<string>();
  readonly reservedMemoryRooms = new Set<string>();
  expireWrites = 0;
  cleanupCalls = 0;
  listCalls = 0;
  failBeforeCommit = false;
  failAfterCommit = false;
  beforeExpire?: () => Promise<void>;

  addRoom(input: {
    roomCode: string;
    expiresAtMs: number | null;
    gameStatus?: GameStatus;
    currentGameId?: GameSessionId | null;
    lifecycleStatus?: "active" | "expired";
  }): FakeExpirationRoom {
    const room: FakeExpirationRoom = {
      roomId: randomUUID(),
      roomCode: input.roomCode as RoomCode,
      lifecycleStatus: input.lifecycleStatus ?? "active",
      gameStatus: input.gameStatus ?? "waiting",
      currentGameId: input.currentGameId ?? null,
      expiresAtMs: input.expiresAtMs,
      version: "1",
    };
    this.rooms.set(room.roomId, room);
    this.memoryRooms.add(room.roomId);
    return room;
  }

  async listDue(limit: number): Promise<DueWaitingRoomExpiration[]> {
    this.listCalls += 1;
    return [...this.rooms.values()]
      .filter((room) =>
        room.lifecycleStatus === "active"
        && room.gameStatus === "waiting"
        && room.currentGameId === null
        && room.expiresAtMs !== null
        && room.expiresAtMs <= this.nowMs)
      .sort((left, right) =>
        left.expiresAtMs! - right.expiresAtMs!
        || left.roomId.localeCompare(right.roomId))
      .slice(0, limit)
      .map((room) => ({
        roomId: room.roomId,
        roomCode: room.roomCode,
        expectedVersion: room.version,
      }));
  }

  async expire(
    candidate: DueWaitingRoomExpiration,
    epoch = this.fencingEpoch,
  ): Promise<ExpiredWaitingRoom | undefined> {
    await this.beforeExpire?.();
    if (epoch !== this.fencingEpoch) {
      throw new RoomRuntimeFencingError();
    }
    const room = this.rooms.get(candidate.roomId);
    if (!room || room.roomCode !== candidate.roomCode) {
      return undefined;
    }
    const nextVersion = (BigInt(candidate.expectedVersion) + 1n).toString();
    const due =
      room.expiresAtMs !== null && room.expiresAtMs <= this.nowMs;
    if (
      room.lifecycleStatus === "expired"
      && room.gameStatus === "waiting"
      && room.currentGameId === null
      && room.version === nextVersion
      && due
    ) {
      return {
        roomId: room.roomId,
        roomCode: room.roomCode,
        version: room.version,
      };
    }
    if (
      room.lifecycleStatus !== "active"
      || room.gameStatus !== "waiting"
      || room.currentGameId !== null
      || room.version !== candidate.expectedVersion
      || !due
    ) {
      return undefined;
    }
    if (this.failBeforeCommit) {
      this.failBeforeCommit = false;
      throw new Error("expiration rejected before commit");
    }
    room.lifecycleStatus = "expired";
    room.version = nextVersion;
    this.expireWrites += 1;
    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw new Error("expiration commit response was lost");
    }
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      version: room.version,
    };
  }

  async completeCleanup(expired: ExpiredWaitingRoom): Promise<boolean> {
    this.cleanupCalls += 1;
    if (this.reservedMemoryRooms.has(expired.roomId)) {
      return false;
    }
    this.memoryRooms.delete(expired.roomId);
    return true;
  }

  createActiveRoomWithCode(roomCode: RoomCode): FakeExpirationRoom {
    if ([...this.rooms.values()].some((room) =>
      room.roomCode === roomCode && room.lifecycleStatus === "active")) {
      throw new Error("active room code collision");
    }
    return this.addRoom({ roomCode, expiresAtMs: null });
  }
}

function createWorker(
  database: FakeExpirationDatabase,
  options: {
    epoch?: string;
    ready?: () => boolean;
    schedule?: (callback: () => void, delayMs: number) => () => void;
    onReport?: (error: unknown, roomCode?: RoomCode) => void;
    batchSize?: number;
  } = {},
): {
  worker: DurableRoomExpirationWorker;
  scheduled: Array<{ callback: () => void; delayMs: number; cancelled: boolean }>;
  reports: Array<{ error: unknown; roomCode?: RoomCode }>;
} {
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  const reports: Array<{ error: unknown; roomCode?: RoomCode }> = [];
  const worker = new DurableRoomExpirationWorker({
    isServingReady: options.ready ?? (() => true),
    intervalMs: 100,
    batchSize: options.batchSize ?? 10,
    scheduleTimeout: options.schedule ?? ((callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false };
      scheduled.push(timer);
      return () => {
        timer.cancelled = true;
      };
    }),
    listDue: (limit) => database.listDue(limit),
    expire: (candidate) => database.expire(candidate, options.epoch),
    completeCleanup: (expired) => database.completeCleanup(expired),
    reportFailure: (error, roomCode) => {
      reports.push({ error, ...(roomCode ? { roomCode } : {}) });
      options.onReport?.(error, roomCode);
    },
  });
  return { worker, scheduled, reports };
}

function createCommandFixture(
  database: FakeExpirationDatabase,
  room: FakeExpirationRoom,
  repositoryOverrides: Partial<Pick<
    PostgresRoomRepository,
    "joinRoom" | "transitionRoomGameStatus"
  >> = {},
) {
  let roomCodes = [room.roomCode];
  const rooms = new RoomService(() => roomCodes.shift() ?? "ZZZZ" as RoomCode);
  const prepared = rooms.prepareRoomCreation(
    { nickname: "Host" },
    "expiration-host-socket",
  );
  const durablePrepared = {
    ...prepared,
    roomCode: room.roomCode,
    roomId: room.roomId,
  };
  rooms.commitPreparedRoomCreation(durablePrepared, "expiration-host-socket");
  const coordinator = new RoomPersistenceCoordinator();
  coordinator.registerCreatedRoom({
    roomCode: room.roomCode,
    roomId: room.roomId,
    gameMode: "impostor-classic",
    hostPlayerId: prepared.hostPlayerId,
    lifecycleStatus: "active",
    currentGameId: null,
    version: room.version,
  });
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost() {
        throw new Error("Unexpected room creation.");
      },
      async joinRoom(input: JoinRoomInput) {
        if (repositoryOverrides.joinRoom) {
          return repositoryOverrides.joinRoom(input);
        }
        throw new Error("Unexpected room join.");
      },
      async listDueWaitingRoomExpirations(limit) {
        return database.listDue(limit ?? 50);
      },
      async expireWaitingRoom(candidate) {
        return database.expire(candidate);
      },
      async transitionRoomGameStatus(input) {
        if (repositoryOverrides.transitionRoomGameStatus) {
          return repositoryOverrides.transitionRoomGameStatus(input);
        }
        throw new Error("Unexpected game-status transition.");
      },
    },
    coordinator,
  );
  return { rooms, coordinator, commands, prepared };
}

test("only explicit due waiting rooms expire; active games wait until lobby return", async () => {
  const database = new FakeExpirationDatabase();
  const due = database.addRoom({
    roomCode: "DUEA",
    expiresAtMs: database.nowMs - 1,
  });
  const noExpiry = database.addRoom({
    roomCode: "NULL",
    expiresAtMs: null,
  });
  const future = database.addRoom({
    roomCode: "FUTR",
    expiresAtMs: database.nowMs + 1,
  });
  const starting = database.addRoom({
    roomCode: "STRT",
    expiresAtMs: database.nowMs - 1,
    gameStatus: "starting",
    currentGameId: "starting-game" as GameSessionId,
  });
  const active = database.addRoom({
    roomCode: "ACTV",
    expiresAtMs: database.nowMs - 1,
    gameStatus: "in_progress",
    currentGameId: "active-game" as GameSessionId,
  });
  const { worker } = createWorker(database);
  worker.start();
  await worker.runNow();

  assert.equal(due.lifecycleStatus, "expired");
  assert.equal(database.memoryRooms.has(due.roomId), false);
  assert.equal(noExpiry.lifecycleStatus, "active");
  assert.equal(database.memoryRooms.has(noExpiry.roomId), true);
  assert.equal(future.lifecycleStatus, "active");
  assert.equal(database.memoryRooms.has(future.roomId), true);
  assert.equal(starting.lifecycleStatus, "active");
  assert.equal(database.memoryRooms.has(starting.roomId), true);
  assert.equal(active.lifecycleStatus, "active");
  assert.equal(database.memoryRooms.has(active.roomId), true);

  active.gameStatus = "waiting";
  active.currentGameId = null;
  const returnedToLobby = await database.listDue(10);
  assert.ok(returnedToLobby.some((candidate) => candidate.roomId === active.roomId));
  await worker.runNow();
  assert.equal(active.lifecycleStatus, "expired");
  worker.stop();
});

test("pre-commit failures retry safely and uncertain commits are reconciled without a second write", async () => {
  const database = new FakeExpirationDatabase();
  const room = database.addRoom({
    roomCode: "RETR",
    expiresAtMs: database.nowMs - 1,
  });
  const { worker } = createWorker(database);
  worker.start();

  database.failBeforeCommit = true;
  await worker.runNow();
  assert.equal(room.lifecycleStatus, "active");
  assert.equal(database.memoryRooms.has(room.roomId), true);
  assert.equal(worker.pendingCount, 1);

  await worker.runNow();
  assert.equal(room.lifecycleStatus, "expired");
  assert.equal(database.expireWrites, 1);
  assert.equal(database.memoryRooms.has(room.roomId), false);
  worker.stop();

  const uncertainDatabase = new FakeExpirationDatabase();
  const uncertainRoom = uncertainDatabase.addRoom({
    roomCode: "UNCR",
    expiresAtMs: uncertainDatabase.nowMs - 1,
  });
  const uncertainWorker = createWorker(uncertainDatabase).worker;
  uncertainWorker.start();
  uncertainDatabase.failAfterCommit = true;
  await uncertainWorker.runNow();
  assert.equal(uncertainRoom.lifecycleStatus, "expired");
  assert.equal(uncertainDatabase.memoryRooms.has(uncertainRoom.roomId), true);
  assert.equal(uncertainDatabase.expireWrites, 1);
  await uncertainWorker.runNow();
  assert.equal(uncertainDatabase.expireWrites, 1);
  assert.equal(uncertainDatabase.cleanupCalls, 1);
  assert.equal(uncertainDatabase.memoryRooms.has(uncertainRoom.roomId), false);
  uncertainWorker.stop();
});

test("concurrent cleanup triggers share one bounded batch", async () => {
  const database = new FakeExpirationDatabase();
  const rooms = Array.from({ length: 3 }, (_, index) =>
    database.addRoom({
      roomCode: `BCH${String.fromCharCode(65 + index)}`,
      expiresAtMs: database.nowMs - index - 1,
    }));
  const { worker } = createWorker(database, {
    batchSize: 2,
  });
  worker.start();
  const first = worker.runNow();
  const second = worker.runNow();
  assert.strictEqual(second, first);
  await first;
  assert.equal(database.listCalls, 1);
  assert.equal(rooms.filter((room) => room.lifecycleStatus === "expired").length, 2);
  assert.equal(rooms.filter((room) => room.lifecycleStatus === "active").length, 1);

  await worker.runNow();
  assert.equal(database.listCalls, 2);
  assert.equal(rooms.every((room) => room.lifecycleStatus === "expired"), true);
  worker.stop();
});

test("stale versions and fencing epochs cannot expire or remove a room", async () => {
  const database = new FakeExpirationDatabase();
  const room = database.addRoom({
    roomCode: "STAL",
    expiresAtMs: database.nowMs - 1,
  });
  const candidate = (await database.listDue(1))[0]!;
  room.version = "2";
  assert.equal(await database.expire(candidate), undefined);
  assert.equal(room.lifecycleStatus, "active");

  room.version = "1";
  const { worker, reports } = createWorker(database, { epoch: "6" });
  worker.start();
  await worker.runNow();
  assert.equal(room.lifecycleStatus, "active");
  assert.equal(database.memoryRooms.has(room.roomId), true);
  assert.equal(reports.length, 1);
  assert.ok(reports[0]?.error instanceof RoomRuntimeFencingError);
  worker.stop();
});

test("a stopped worker settles in-flight discovery without starting another cleanup", async () => {
  const database = new FakeExpirationDatabase();
  const room = database.addRoom({
    roomCode: "STOP",
    expiresAtMs: database.nowMs - 1,
  });
  const discovered = await database.listDue(1);
  let releaseExpire!: () => void;
  const expireBarrier = new Promise<void>((resolve) => {
    releaseExpire = resolve;
  });
  let expireEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    expireEntered = resolve;
  });
  database.beforeExpire = async () => {
    expireEntered();
    await expireBarrier;
  };
  const scheduled: Array<{ callback: () => void; cancelled: boolean }> = [];
  const worker = new DurableRoomExpirationWorker({
    isServingReady: () => true,
    intervalMs: 100,
    scheduleTimeout: (callback) => {
      const timer = { callback, cancelled: false };
      scheduled.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    listDue: async () => discovered,
    expire: (candidate) => database.expire(candidate),
    completeCleanup: (expired) => database.completeCleanup(expired),
    reportFailure: () => {},
  });
  worker.start();
  const pending = worker.runNow();
  await entered;
  worker.stop();
  releaseExpire();
  await pending;

  assert.equal(room.lifecycleStatus, "expired");
  assert.equal(database.memoryRooms.has(room.roomId), true);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.cancelled, true);
  assert.equal(worker.pendingCount, 1);
});

test("confirmed expiry preserves history and permits the active room code to be reused", async () => {
  const database = new FakeExpirationDatabase();
  const expiredRoom = database.addRoom({
    roomCode: "REUS",
    expiresAtMs: database.nowMs - 1,
  });
  const { rooms, coordinator, commands } = createCommandFixture(
    database,
    expiredRoom,
  );
  const candidate = (await commands.listDueWaitingRoomExpirations(10))[0]!;
  const expired = await commands.expireWaitingRoom(candidate);
  assert.ok(expired);
  assert.equal(coordinator.getMetadata("REUS" as RoomCode)?.lifecycleStatus, "expired");
  assert.equal(coordinator.isFenced("REUS" as RoomCode), true);
  assert.ok(rooms.getPublicRoom("REUS" as RoomCode));

  assert.equal(await commands.completeExpiredRoomCleanup(expired), true);
  assert.equal(rooms.getPublicRoom("REUS" as RoomCode), undefined);
  assert.equal(coordinator.getMetadata("REUS" as RoomCode), undefined);
  assert.equal(database.rooms.get(expiredRoom.roomId)?.lifecycleStatus, "expired");

  const replacement = rooms.prepareRoomCreation(
    { nickname: "Next Host" },
    "next-host-socket",
  );
  const reused = {
    ...replacement,
    roomCode: expiredRoom.roomCode,
  };
  rooms.commitPreparedRoomCreation(reused, "next-host-socket");
  assert.equal(rooms.getPublicRoom(expiredRoom.roomCode)?.players.length, 1);
  const newMetadata = coordinator.registerCreatedRoom({
    roomCode: expiredRoom.roomCode,
    roomId: replacement.roomId,
    gameMode: replacement.settings.gameMode,
    hostPlayerId: replacement.hostPlayerId,
    lifecycleStatus: "active",
    currentGameId: null,
    version: "1",
  });
  assert.equal(newMetadata.lifecycleStatus, "active");
  const replacementRow = database.createActiveRoomWithCode(expiredRoom.roomCode);
  assert.equal(database.rooms.size, 2);
  assert.equal(database.rooms.get(expiredRoom.roomId)?.lifecycleStatus, "expired");
  assert.equal(replacementRow.lifecycleStatus, "active");
});

test("a due-room join cannot overtake expiration after its database check", async () => {
  const database = new FakeExpirationDatabase();
  const room = database.addRoom({
    roomCode: "JOIN",
    expiresAtMs: database.nowMs - 1,
  });
  let releaseJoin!: () => void;
  let signalJoinEntered!: () => void;
  const joinEntered = new Promise<void>((resolve) => {
    signalJoinEntered = resolve;
  });
  const joinBarrier = new Promise<void>((resolve) => {
    releaseJoin = resolve;
  });
  const fixture = createCommandFixture(database, room, {
    joinRoom: async () => {
      signalJoinEntered();
      await joinBarrier;
      throw new RoomJoinError(
        "ROOM_EXPIRED_OR_CLOSED",
        "Room expiry has passed.",
      );
    },
  });
  const candidate = (await fixture.commands.listDueWaitingRoomExpirations(10))[0]!;
  const join = fixture.commands.joinRoom(
    { roomCode: room.roomCode, nickname: "Late joiner" },
    "late-join-socket",
  );
  await joinEntered;
  const expiration = fixture.commands.expireWaitingRoom(candidate);
  releaseJoin();

  await assert.rejects(join, /no longer accepting players/);
  const expired = await expiration;
  assert.equal(expired?.roomId, room.roomId);
  assert.equal(database.rooms.get(room.roomId)?.lifecycleStatus, "expired");
  assert.equal(
    fixture.rooms.getPublicRoom(room.roomCode)?.players.length,
    1,
  );
});

test("expiration fences a competing durable game start", async () => {
  const database = new FakeExpirationDatabase();
  const room = database.addRoom({
    roomCode: "STRT",
    expiresAtMs: database.nowMs - 1,
  });
  let releaseExpiration!: () => void;
  let signalExpirationEntered!: () => void;
  const expirationEntered = new Promise<void>((resolve) => {
    signalExpirationEntered = resolve;
  });
  const expirationBarrier = new Promise<void>((resolve) => {
    releaseExpiration = resolve;
  });
  database.beforeExpire = async () => {
    signalExpirationEntered();
    await expirationBarrier;
  };
  let startWrites = 0;
  const fixture = createCommandFixture(database, room, {
    async transitionRoomGameStatus() {
      startWrites += 1;
      throw new Error("A start transition must not reach persistence.");
    },
  });
  const reservation = fixture.rooms.reserveGameStatusTransition(
    room.roomCode,
    "waiting",
    null,
    "expiration-host-socket",
  );
  const candidate = (await fixture.commands.listDueWaitingRoomExpirations(10))[0]!;
  const expiration = fixture.commands.expireWaitingRoom(candidate);
  await expirationEntered;
  const start = fixture.commands.transitionRoomGameStatus({
    roomCode: room.roomCode,
    expectedStatus: "waiting",
    nextStatus: "starting",
    expectedCurrentGameId: null,
    nextGameId: "expiration-race-game" as GameSessionId,
    initiatedBy: {
      kind: "host",
      playerId: fixture.prepared.hostPlayerId,
    },
    reservation,
  });
  releaseExpiration();

  const expired = await expiration;
  assert.equal(expired?.roomId, room.roomId);
  await assert.rejects(start, /fenced pending reconciliation/);
  assert.equal(startWrites, 0);
  assert.equal(database.rooms.get(room.roomId)?.lifecycleStatus, "expired");
  assert.equal(database.rooms.get(room.roomId)?.gameStatus, "waiting");
  fixture.rooms.releaseGameStatusReservation(reservation);
});

test("expiration commands reconcile commit uncertainty and retain fenced state", async () => {
  for (const outcome of ["before-commit", "after-commit"] as const) {
    const database = new FakeExpirationDatabase();
    const room = database.addRoom({
      roomCode: outcome === "before-commit" ? "EBFC" : "EACM",
      expiresAtMs: database.nowMs - 1,
    });
    const fixture = createCommandFixture(database, room);
    const candidate = (await fixture.commands.listDueWaitingRoomExpirations(10))[0]!;
    if (outcome === "before-commit") {
      database.failBeforeCommit = true;
    } else {
      database.failAfterCommit = true;
    }

    await assert.rejects(fixture.commands.expireWaitingRoom(candidate));
    assert.equal(fixture.coordinator.isFenced(room.roomCode), true);
    assert.ok(fixture.rooms.getPublicRoom(room.roomCode));
    if (outcome === "before-commit") {
      assert.equal(room.lifecycleStatus, "active");
      assert.equal(room.version, "1");
    } else {
      assert.equal(room.lifecycleStatus, "expired");
      assert.equal(room.version, "2");
    }

    const reconciled = await fixture.commands.expireWaitingRoom(candidate);
    assert.ok(reconciled);
    assert.equal(room.lifecycleStatus, "expired");
    assert.equal(room.version, "2");
    assert.equal(database.expireWrites, 1);
    assert.equal(fixture.coordinator.getMetadata(room.roomCode)?.lifecycleStatus, "expired");
    assert.equal(
      await fixture.commands.completeExpiredRoomCleanup(reconciled),
      true,
    );
    assert.equal(fixture.rooms.getPublicRoom(room.roomCode), undefined);
  }
});

test("expiration cleanup waits for a room start reservation before removing memory", async () => {
  const database = new FakeExpirationDatabase();
  const room = database.addRoom({
    roomCode: "RACE",
    expiresAtMs: database.nowMs - 1,
  });
  const fixture = createCommandFixture(database, room);
  const reservation = fixture.rooms.reserveGameStatusTransition(
    room.roomCode,
    "waiting",
    null,
    "expiration-host-socket",
  );
  const candidate = (await fixture.commands.listDueWaitingRoomExpirations(10))[0]!;
  const expired = await fixture.commands.expireWaitingRoom(candidate);
  assert.ok(expired);
  assert.equal(
    await fixture.commands.completeExpiredRoomCleanup(expired),
    false,
  );
  assert.ok(fixture.rooms.getPublicRoom(room.roomCode));
  assert.equal(fixture.coordinator.isFenced(room.roomCode), true);

  fixture.rooms.releaseGameStatusReservation(reservation);
  assert.equal(
    await fixture.commands.completeExpiredRoomCleanup(expired),
    true,
  );
  assert.equal(fixture.rooms.getPublicRoom(room.roomCode), undefined);
});

test("two workers with different fencing epochs cannot both own expiration", async () => {
  const database = new FakeExpirationDatabase();
  const room = database.addRoom({
    roomCode: "TWOW",
    expiresAtMs: database.nowMs - 1,
  });
  const owner = createWorker(database, { epoch: "7" });
  const staleWorker = createWorker(database, { epoch: "6" });
  owner.worker.start();
  staleWorker.worker.start();
  await Promise.all([
    owner.worker.runNow(),
    staleWorker.worker.runNow(),
  ]);
  assert.equal(room.lifecycleStatus, "expired");
  assert.equal(database.expireWrites, 1);
  assert.equal(database.memoryRooms.has(room.roomId), false);
  assert.equal(staleWorker.reports.length, 1);
  owner.worker.stop();
  staleWorker.worker.stop();
});
