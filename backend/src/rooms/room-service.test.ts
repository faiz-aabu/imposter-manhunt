import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import type {
  GameSessionId,
  PlayerId,
  RoomCode,
  RoomSettings,
} from "@impostor/api";
import {
  DeferredRoomMutationCapacityError,
  RoomService,
} from "./room-service.js";
import { AppError } from "../utils/app-error.js";
import { InMemoryRateLimiter } from "../services/rate-limiter.js";
import type { RecoverableWaitingRoom } from "./postgres-room-repository.js";

test("room service creates unique rooms and enforces room capacity", () => {
  const rooms = new RoomService();
  const created = rooms.createRoom(
    {
      nickname: "Host",
      settings: {
        gameMode: "impostor-classic",
        maxPlayers: 2,
        isPrivate: false,
      },
    },
    "host-socket",
  );
  const anotherRoom = rooms.createRoom(
    { nickname: "Another Host" },
    "another-host-socket",
  );
  const joined = rooms.joinRoom(
    { roomCode: created.room.code, nickname: "Guest" },
    "guest-socket",
  );

  assert.match(created.room.code, /^[A-Z]{4}$/);
  assert.notEqual(created.room.code, anotherRoom.room.code);
  assert.equal(joined.room.players.length, 2);
  assert.throws(
    () =>
      rooms.joinRoom(
        { roomCode: created.room.code, nickname: "Third" },
        "third-socket",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "ROOM_FULL",
  );
  assert.throws(
    () =>
      rooms.joinRoom(
        { roomCode: created.room.code, nickname: "Duplicate" },
        "guest-socket",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );
});

test("game-status reservation blocks room mutations until released", () => {
  const rooms = new RoomService();
  const host = rooms.createRoom({ nickname: "Host" }, "host-socket");
  const guest = rooms.joinRoom(
    { roomCode: host.room.code, nickname: "Guest" },
    "guest-socket",
  );
  const disconnected = rooms.joinRoom(
    { roomCode: host.room.code, nickname: "Disconnected" },
    "disconnected-socket",
  );
  rooms.disconnectSocket("disconnected-socket");

  const reservation = rooms.reserveGameStatusTransition(
    host.room.code,
    "waiting",
    null,
    "host-socket",
  );
  const blocked = (operation: () => unknown) =>
    assert.throws(
      operation,
      (error: unknown) =>
        error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
    );

  try {
    blocked(() =>
      rooms.joinRoom(
        { roomCode: host.room.code, nickname: "Late Joiner" },
        "late-socket",
      ),
    );
    blocked(() => rooms.leaveRoom(host.room.code, "guest-socket"));
    blocked(() => rooms.disconnectSocket("guest-socket"));
    blocked(() =>
      rooms.reconnect(
        {
          roomCode: host.room.code,
          playerId: disconnected.playerId,
          reconnectToken: disconnected.reconnectToken,
        },
        "replacement-socket",
      ),
    );
    blocked(() =>
      rooms.updateRoomSettings(
        {
          roomCode: host.room.code,
          settings: {
            gameMode: "impostor-classic",
            maxPlayers: 8,
            isPrivate: true,
          },
        },
        "host-socket",
      ),
    );
    blocked(() =>
      rooms.removeDisconnectedPlayer(
        host.room.code,
        disconnected.playerId,
      ),
    );
    blocked(() =>
      rooms.reserveGameStatusTransition(
        host.room.code,
        "waiting",
        null,
        "host-socket",
      ),
    );

    const secondRoom = rooms.createRoom(
      { nickname: "Other Host" },
      "other-host-socket",
    );
    assert.equal(
      rooms.joinRoom(
        { roomCode: secondRoom.room.code, nickname: "Other Guest" },
        "other-guest-socket",
      ).room.players.length,
      2,
    );
    assert.equal(
      rooms.getPublicRoom(host.room.code)?.players.find(
        (player) => player.id === guest.playerId,
      )?.connectionStatus,
      "connected",
    );
  } finally {
    rooms.releaseGameStatusReservation(reservation);
  }

  assert.equal(
    rooms.joinRoom(
      { roomCode: host.room.code, nickname: "Late Joiner" },
      "late-socket",
    ).room.players.length,
    4,
  );
});

test("gameplay suspension is idempotent and isolated by durable room identity", () => {
  const rooms = new RoomService();
  const first = rooms.createRoom({ nickname: "First" }, "first-host");
  const second = rooms.createRoom({ nickname: "Second" }, "second-host");
  const scope = rooms.getGameplaySuspensionScope(first.room.code, null);
  assert.ok(scope);

  const suspension = rooms.suspendGameplay(
    first.room.code,
    scope,
    "durable_timeout_post_commit_side_effect_failure",
  );
  assert.equal(
    rooms.suspendGameplay(
      first.room.code,
      scope,
      "durable_timeout_post_commit_side_effect_failure",
    ),
    suspension,
  );
  assert.equal(rooms.isGameplaySuspended(first.room.code), true);
  assert.equal(rooms.isGameplaySuspended(second.room.code), false);
  assert.throws(
    () => rooms.joinRoom({ roomCode: first.room.code, nickname: "Guest" }, "guest"),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  assert.equal(rooms.getGameplaySuspensions().length, 1);
});

test("a reused room code is not suspended when its durable room identity changes", async () => {
  const rooms = new RoomService();
  const created = rooms.createRoom({ nickname: "Old host" }, "old-host");
  const oldGameId = "old-game" as GameSessionId;
  const oldScope = rooms.getGameplaySuspensionScope(
    created.room.code,
    oldGameId,
  );
  assert.ok(oldScope);
  rooms.suspendGameplay(
    created.room.code,
    oldScope,
    "durable_timeout_post_commit_side_effect_failure",
  );

  rooms.fenceRoom(created.room.code);
  assert.deepEqual(
    await rooms.removeExpiredWaitingRoom(created.room.code, oldScope.roomId),
    { status: "removed" },
  );

  const reconnectToken = "new-room-reconnect-token";
  const newRoomId = randomUUID();
  const settings: RoomSettings = {
    gameMode: "impostor-classic",
    maxPlayers: 8,
    isPrivate: false,
    classicImpostor: {
      impostorCount: 1,
      discussionDurationSeconds: 30,
      votingDurationSeconds: 10,
    },
  };
  rooms.restoreWaitingRoom({
    roomId: newRoomId,
    roomCode: created.room.code,
    gameMode: "impostor-classic",
    lifecycleStatus: "active",
    gameStatus: "waiting",
    settings,
    maxPlayers: settings.maxPlayers,
    hostPlayerId: created.playerId,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: null,
    version: "1",
    currentGameId: null,
    members: [{
      playerId: created.playerId,
      nickname: "New host",
      membershipStatus: "active",
      connectionStatus: "disconnected",
      joinedAt: new Date(),
      disconnectGeneration: "1",
      reconnectDeadlineAt: new Date(Date.now() + 60_000),
      reconnectTokenHash: createHash("sha256").update(reconnectToken).digest(),
    }],
    privateManhuntBoundary: null,
  });
  const reconnected = rooms.reconnect(
    {
      roomCode: created.room.code,
      playerId: created.playerId,
      reconnectToken,
    },
    "new-host",
  );
  const newGameId = "new-game" as GameSessionId;
  rooms.beginImpostorGame(
    created.room.code,
    "new-host",
    newGameId,
    "impostor-classic",
  );

  assert.equal(reconnected.payload.player.id, created.playerId);
  assert.equal(
    rooms.getGameplaySuspensionScope(created.room.code, newGameId)?.roomId,
    newRoomId,
  );
  assert.equal(rooms.isGameplaySuspended(created.room.code, newGameId), false);
  assert.equal(rooms.isGameplaySuspended(created.room.code), false);
});

test("suspended rooms permit safe reconnect without clearing gameplay suspension", () => {
  const rooms = new RoomService();
  const created = rooms.createRoom({ nickname: "Host" }, "old-socket");
  rooms.disconnectSocket("old-socket");
  const scope = rooms.getGameplaySuspensionScope(created.room.code, null);
  assert.ok(scope);
  rooms.suspendGameplay(
    created.room.code,
    scope,
    "durable_timeout_post_commit_side_effect_failure",
  );

  const reconnected = rooms.reconnect(
    {
      roomCode: created.room.code,
      playerId: created.playerId,
      reconnectToken: created.reconnectToken,
    },
    "new-socket",
  );
  assert.equal(reconnected.payload.player.id, created.playerId);
  assert.equal(rooms.isGameplaySuspended(created.room.code), true);
  assert.throws(
    () => rooms.updateRoomSettings(
      {
        roomCode: created.room.code,
        settings: {
          gameMode: "impostor-classic",
          maxPlayers: 8,
          isPrivate: false,
        },
      },
      "new-socket",
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
});

test("a failed deferred mutation remains at the FIFO head and fences its room", async () => {
  const rooms = new RoomService();
  const host = rooms.createRoom({ nickname: "Host" }, "host-socket");
  const reservation = rooms.reserveGameStatusTransition(
    host.room.code,
    "waiting",
    null,
    "host-socket",
  );
  const executed: string[] = [];

  const failed = rooms.deferRoomMutation<string>(
    host.room.code,
    async () => {
      executed.push("first");
      throw new Error("uncertain persistence result");
    },
    async (reconciliation, resolve) => {
      rooms.clearPersistenceFence(host.room.code, reconciliation);
      resolve("reconciled");
      return "complete";
    },
  );
  const later = rooms.deferRoomMutation(host.room.code, async () => {
    executed.push("second");
  });
  rooms.releaseGameStatusReservation(reservation);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(executed, ["first"]);
  const queues = Reflect.get(rooms, "deferredRoomMutations") as Map<
    RoomCode,
    { pending: unknown[]; blocked: boolean }
  >;
  assert.equal(queues.get(host.room.code)?.pending.length, 2);
  assert.equal(queues.get(host.room.code)?.blocked, true);
  assert.throws(
    () => rooms.joinRoom({ roomCode: host.room.code, nickname: "Late" }, "late"),
    (failure: unknown) =>
      failure instanceof AppError && failure.code === "UNKNOWN",
  );
  assert.equal(await rooms.reconcileDeferredRoomMutations(host.room.code), true);
  assert.equal(await failed, "reconciled");
  await later;
  assert.deepEqual(executed, ["first", "second"]);
});

test("deferred mutation capacity rejects admission without fencing or reordering the room", async () => {
  const rooms = new RoomService();
  const host = rooms.createRoom({ nickname: "Host" }, "host-socket");
  const reservation = rooms.reserveGameStatusTransition(
    host.room.code,
    "waiting",
    null,
    "host-socket",
  );
  const executed: number[] = [];
  const queued = Array.from({ length: 128 }, (_, index) =>
    rooms.deferRoomMutation(host.room.code, async () => {
      executed.push(index);
    }),
  );

  assert.throws(
    () => rooms.deferRoomMutation(host.room.code, async () => {}),
    DeferredRoomMutationCapacityError,
  );
  rooms.releaseGameStatusReservation(reservation);
  await Promise.all(queued);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(executed.length, 128);
  assert.deepEqual(executed, Array.from({ length: 128 }, (_, index) => index));
  assert.equal(
    rooms.joinRoom(
      { roomCode: host.room.code, nickname: "Guest" },
      "guest-socket",
    ).room.players.length,
    2,
  );
});

test("runtime shutdown rejects blocked deferred callers without un-fencing the room", async () => {
  const rooms = new RoomService();
  const host = rooms.createRoom({ nickname: "Host" }, "host-socket");
  const reservation = rooms.reserveGameStatusTransition(
    host.room.code,
    "waiting",
    null,
    "host-socket",
  );
  const pending = rooms.deferRoomMutation(host.room.code, async () => {
    throw new Error("database outcome unknown");
  });
  rooms.releaseGameStatusReservation(reservation);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const rejected = assert.rejects(pending, /shutting down/);
  rooms.rejectBlockedDeferredRoomMutations(
    new Error("Durable room runtime is shutting down."),
  );
  await rejected;
  assert.throws(
    () => rooms.joinRoom({ roomCode: host.room.code, nickname: "Late" }, "late"),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNKNOWN",
  );
});

test("host transfer and empty-room deletion follow membership changes", () => {
  const rooms = new RoomService();
  const host = rooms.createRoom({ nickname: "Host" }, "host-socket");
  const guest = rooms.joinRoom(
    { roomCode: host.room.code, nickname: "Guest" },
    "guest-socket",
  );

  const hostLeave = rooms.leaveRoom(host.room.code, "host-socket");
  assert.equal(hostLeave.room?.hostId, guest.playerId);
  assert.equal(hostLeave.hostChanged, true);

  const lastPlayerLeave = rooms.leaveRoom(host.room.code, "guest-socket");
  assert.equal(lastPlayerLeave.deleted, true);
  assert.equal(rooms.getPublicRoom(host.room.code), undefined);
});

test("Manhunt boundaries stay out of public room snapshots and are stored separately", () => {
  const rooms = new RoomService();
  const settings: RoomSettings = {
    gameMode: "manhunt",
    maxPlayers: 8,
    isPrivate: false,
    manhunt: {
      hunterCount: 1,
      boundary: {
        center: { latitude: 51.5074, longitude: -0.1278 },
        radiusMeters: 500,
      },
    },
  };
  const created = rooms.createRoom(
    { nickname: "Host", settings },
    "host-socket",
  );

  assert.deepEqual(created.room.settings.manhunt, {
    hunterCount: 1,
    gameDurationSeconds: 3_600,
  });
  assert.equal(JSON.stringify(created.room).includes("boundary"), false);
  assert.deepEqual(
    rooms.getManhuntBoundary(created.room.code),
    settings.manhunt?.boundary,
  );

  const joined = rooms.joinRoom(
    { roomCode: created.room.code, nickname: "Guest" },
    "guest-socket",
  );
  assert.equal(JSON.stringify(joined.room).includes("boundary"), false);
  assert.deepEqual(
    rooms.getManhuntBoundary(joined.room.code),
    settings.manhunt?.boundary,
  );
});

test("recovered Manhunt waiting rooms restore disconnected members and private data", () => {
  const rooms = new RoomService();
  const roomCode = "RCRV" as RoomCode;
  const hostId = "recovered-host" as PlayerId;
  const reconnectToken = "recovered-host-token";
  const boundary = {
    center: { latitude: 51.5074, longitude: -0.1278 },
    radiusMeters: 500,
  };
  const recovered: RecoverableWaitingRoom = {
    roomId: "10000000-0000-4000-8000-000000000001",
    roomCode,
    gameMode: "manhunt",
    lifecycleStatus: "active",
    gameStatus: "waiting",
    settings: {
      gameMode: "manhunt",
      maxPlayers: 8,
      isPrivate: true,
      manhunt: { hunterCount: 1, gameDurationSeconds: 3_600 },
    },
    maxPlayers: 8,
    hostPlayerId: hostId,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: null,
    version: "7",
    currentGameId: null,
    members: [
      {
        playerId: hostId,
        nickname: "Recovered Host",
        membershipStatus: "active",
        connectionStatus: "disconnected",
        joinedAt: new Date("2026-01-01T00:00:00.000Z"),
        disconnectGeneration: "4",
        reconnectDeadlineAt: new Date(Date.now() + 60_000),
        reconnectTokenHash: createHash("sha256")
          .update(reconnectToken)
          .digest(),
      },
    ],
    privateManhuntBoundary: boundary,
  };

  const room = rooms.restoreWaitingRoom(recovered);
  assert.equal(room.gameStatus, "waiting");
  assert.equal(room.createdAt, recovered.createdAt.toISOString());
  assert.equal(room.players[0]?.connectionStatus, "disconnected");
  assert.equal(rooms.getSocketIdForPlayer(roomCode, hostId), undefined);
  assert.deepEqual(rooms.listDisconnectedPlayerTimeouts(), [{
    roomCode,
    playerId: hostId,
    disconnectGeneration: "4",
    reconnectDeadlineAt: recovered.members[0]!.reconnectDeadlineAt!,
  }]);
  assert.deepEqual(room.settings.manhunt, {
    hunterCount: 1,
    gameDurationSeconds: 3_600,
  });
  assert.deepEqual(rooms.getManhuntBoundary(roomCode), boundary);
  assert.equal(JSON.stringify(room).includes("boundary"), false);
  assert.equal(JSON.stringify(room).includes("reconnectTokenHash"), false);

  assert.throws(
    () =>
      rooms.reconnect(
        { roomCode, playerId: hostId, reconnectToken: "invalid-token" },
        "invalid-socket",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );
  const reconnected = rooms.reconnect(
    { roomCode, playerId: hostId, reconnectToken },
    "new-host-socket",
  );
  assert.equal(reconnected.room.players[0]?.connectionStatus, "connected");
  assert.equal(rooms.getSocketIdForPlayer(roomCode, hostId), "new-host-socket");
  assert.deepEqual(rooms.listDisconnectedPlayerTimeouts(), []);
});

test("only the host updates settings and cannot lower the limit below occupancy", () => {
  const rooms = new RoomService();
  const host = rooms.createRoom({ nickname: "Host" }, "host-socket");
  const guest = rooms.joinRoom(
    { roomCode: host.room.code, nickname: "Guest" },
    "guest-socket",
  );
  const settings: RoomSettings = {
    gameMode: "manhunt",
    maxPlayers: 3,
    isPrivate: true,
  };

  assert.throws(
    () =>
      rooms.updateRoomSettings(
        { roomCode: host.room.code, settings },
        "guest-socket",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );

  const updated = rooms.updateRoomSettings(
    { roomCode: host.room.code, settings },
    "host-socket",
  );
  assert.deepEqual(updated.settings, settings);

  assert.throws(
    () =>
      rooms.updateRoomSettings(
        {
          roomCode: host.room.code,
          settings: { ...settings, maxPlayers: 1 },
        },
        "host-socket",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "INVALID_PAYLOAD",
  );
  assert.notEqual(guest.playerId, host.playerId);
});

test("reconnection restores the same player without exposing its token", () => {
  const rooms = new RoomService();
  const created = rooms.createRoom({ nickname: "Host" }, "old-socket");
  const disconnected = rooms.disconnectSocket("old-socket");

  assert.ok(disconnected);
  assert.equal(
    disconnected.room.players[0]?.connectionStatus,
    "disconnected",
  );
  assert.equal(JSON.stringify(disconnected.room).includes("reconnectToken"), false);
  assert.throws(
    () =>
      rooms.reconnect(
        {
          roomCode: created.room.code,
          playerId: created.playerId,
          reconnectToken: "wrong-token",
        },
        "invalid-socket",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );

  const reconnected = rooms.reconnect(
    {
      roomCode: created.room.code,
      playerId: created.playerId,
      reconnectToken: created.reconnectToken,
    },
    "new-socket",
  );
  assert.equal(reconnected.payload.player.id, created.playerId);
  assert.equal(reconnected.room.players.length, 1);
  assert.equal(reconnected.room.players[0]?.connectionStatus, "connected");
  assert.equal(
    rooms.removeDisconnectedPlayer(created.room.code, created.playerId),
    undefined,
  );
});

test("rate limiter expires attempts outside the configured window", () => {
  const limiter = new InMemoryRateLimiter();
  assert.equal(limiter.consume("client", 2, 1_000, 10_000), true);
  assert.equal(limiter.consume("client", 2, 1_000, 10_100), true);
  assert.equal(limiter.consume("client", 2, 1_000, 10_200), false);
  assert.equal(limiter.consume("client", 2, 1_000, 11_001), true);
});

test("expired-room cleanup is identity-checked, retryable, and clears socket membership", async () => {
  const roomCode = "EXPR" as RoomCode;
  const rooms = new RoomService(() => roomCode);
  const prepared = rooms.prepareRoomCreation(
    { nickname: "Host" },
    "expiration-host",
  );
  rooms.commitPreparedRoomCreation(prepared, "expiration-host");
  let failCleanup = true;
  const cleanupSnapshots: Array<{ roomId: string; socketIds: readonly string[] }> = [];
  rooms.onExpiredRoom(async (snapshot) => {
    cleanupSnapshots.push({
      roomId: snapshot.roomId,
      socketIds: snapshot.socketIds,
    });
    if (failCleanup) {
      throw new Error("socket cleanup failed");
    }
  });
  rooms.fenceRoom(roomCode);

  assert.deepEqual(
    await rooms.removeExpiredWaitingRoom(roomCode, randomUUID()),
    { status: "replaced" },
  );
  await assert.rejects(
    rooms.removeExpiredWaitingRoom(roomCode, prepared.roomId),
    /socket cleanup failed/,
  );
  assert.ok(rooms.getPublicRoom(roomCode));
  assert.equal(rooms.getRoomCodeForSocket("expiration-host"), roomCode);

  failCleanup = false;
  assert.deepEqual(
    await rooms.removeExpiredWaitingRoom(roomCode, prepared.roomId),
    { status: "removed" },
  );
  assert.equal(rooms.getPublicRoom(roomCode), undefined);
  assert.equal(rooms.getRoomCodeForSocket("expiration-host"), undefined);
  assert.deepEqual(cleanupSnapshots, [
    { roomId: prepared.roomId, socketIds: ["expiration-host"] },
    { roomId: prepared.roomId, socketIds: ["expiration-host"] },
  ]);
});

test("expired-room cleanup never removes a reserved or active game", async () => {
  const waitingCode = "WAIT" as RoomCode;
  const waitingRooms = new RoomService(() => waitingCode);
  const waiting = waitingRooms.prepareRoomCreation(
    { nickname: "Host" },
    "waiting-host",
  );
  waitingRooms.commitPreparedRoomCreation(waiting, "waiting-host");
  const reservation = waitingRooms.reserveGameStatusTransition(
    waitingCode,
    "waiting",
    null,
    "waiting-host",
  );
  waitingRooms.fenceRoom(waitingCode);
  assert.deepEqual(
    await waitingRooms.removeExpiredWaitingRoom(waitingCode, waiting.roomId),
    { status: "blocked" },
  );
  waitingRooms.releaseGameStatusReservation(reservation);
  assert.deepEqual(
    await waitingRooms.removeExpiredWaitingRoom(waitingCode, waiting.roomId),
    { status: "removed" },
  );

  const activeCode = "GAME" as RoomCode;
  const activeRooms = new RoomService(() => activeCode);
  const active = activeRooms.prepareRoomCreation(
    { nickname: "Host" },
    "active-host",
  );
  activeRooms.commitPreparedRoomCreation(active, "active-host");
  activeRooms.beginGame(
    activeCode,
    "active-host",
    randomUUID() as GameSessionId,
  );
  activeRooms.fenceRoom(activeCode);
  assert.deepEqual(
    await activeRooms.removeExpiredWaitingRoom(activeCode, active.roomId),
    { status: "blocked" },
  );
  assert.equal(activeRooms.getPublicRoom(activeCode)?.gameStatus, "starting");
});
