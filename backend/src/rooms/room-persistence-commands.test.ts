import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import type {
  CreateRoomPayload,
  GameMode,
  GameSessionId,
  GameStatus,
  JoinRoomPayload,
  PlayerId,
  RoomCode,
  RoomSettings,
} from "@impostor/api";
import { RoomPersistenceCoordinator } from "./room-persistence-coordinator.js";
import { RoomPersistenceCommands } from "./room-persistence-commands.js";
import type {
  CreatedRoomInfo,
  CreateRoomWithHostInput,
  JoinedRoomInfo,
  JoinRoomInput,
  LeftRoomInfo,
  MarkDisconnectedInput,
  ReconnectPlayerInput,
  RemoveDisconnectedPlayerInput,
  TransitionRoomGameStatusInput,
  TransitionedRoomGameStatusInfo,
  UpdateWaitingRoomSettingsInput,
} from "./postgres-room-repository.js";
import {
  RoomConnectionError,
  RoomGameStatusTransitionError,
  RoomJoinError,
  RoomRuntimeFencingError,
} from "./postgres-room-repository.js";
import { RoomService } from "./room-service.js";
import type { PreparedRoomCreation, PreparedRoomJoin } from "./room-service.js";
import { AppError } from "../utils/app-error.js";

const CREATE_PAYLOAD: CreateRoomPayload = { nickname: "Host" };

function createdInfo(
  input: CreateRoomWithHostInput,
  version = "1",
): CreatedRoomInfo {
  return {
    roomId: input.roomId,
    roomCode: input.roomCode,
    gameMode: input.gameMode,
    hostPlayerId: input.hostPlayerId,
    lifecycleStatus: "active",
    currentGameId: null,
    version,
  };
}

function joinedInfo(input: JoinRoomInput, version: string): JoinedRoomInfo {
  if (!input.expectedRoomId) {
    throw new Error("Expected room ID is required in persistence tests.");
  }
  return {
    roomId: input.expectedRoomId,
    roomCode: input.roomCode,
    gameMode: "impostor-classic",
    playerId: input.playerId,
    lifecycleStatus: "active",
    currentGameId: null,
    version,
  };
}

function roomService(codes: string[]): RoomService {
  let nextCode = 0;
  return new RoomService(
    () => codes[Math.min(nextCode++, codes.length - 1)] as RoomCode,
  );
}

function unusedJoin(): Promise<never> {
  return Promise.reject(new Error("Unexpected repository join."));
}

function collisionError(): Error & { code: string; constraint: string } {
  return Object.assign(new Error("duplicate active room code"), {
    code: "23505",
    constraint: "rooms_active_room_code_key",
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

type TerminalOutcome =
  | "retry-after-no-commit"
  | "commit-then-error"
  | "ambiguous"
  | "stale-version"
  | "lease-loss";

function terminalRoomSettings(gameMode: GameMode): RoomSettings {
  const base = { gameMode, maxPlayers: 8, isPrivate: false };
  if (gameMode === "impostor-classic") {
    return {
      ...base,
      classicImpostor: {
        impostorCount: 1,
        discussionDurationSeconds: 30,
        votingDurationSeconds: 10,
      },
    };
  }
  if (gameMode === "manhunt") {
    return {
      ...base,
      manhunt: {
        hunterCount: 1,
        boundary: {
          center: { latitude: 51.5, longitude: -0.1 },
          radiusMeters: 500,
        },
      },
    };
  }
  return base;
}

async function createTerminalFixture(
  gameMode: GameMode,
  outcome: TerminalOutcome,
) {
  const roomCode = ({
    "impostor-classic": "CAAA",
    "impostor-word": "WAAA",
    manhunt: "MAAA",
  } as const)[gameMode] as RoomCode;
  const hostSocket = `host-${gameMode}`;
  const rooms = roomService([roomCode]);
  const created = rooms.createRoom(
    { nickname: "Host", settings: terminalRoomSettings(gameMode) },
    hostSocket,
  );
  const coordinator = new RoomPersistenceCoordinator();
  const roomId = randomUUID();
  coordinator.registerCreatedRoom({
    roomCode,
    roomId,
    gameMode,
    hostPlayerId: created.playerId,
    lifecycleStatus: "active",
    currentGameId: null,
    version: "1",
  });
  const database = {
    gameStatus: "waiting" as GameStatus,
    currentGameId: null as GameSessionId | null,
    version: "1",
  };
  let finishWrites = 0;
  let canonicalReads = 0;
  const persist = (input: TransitionRoomGameStatusInput) => {
    database.gameStatus = input.nextStatus;
    database.currentGameId = input.nextGameId;
    database.version = (BigInt(input.expectedVersion) + 1n).toString();
    return {
      roomId: input.expectedRoomId,
      roomCode: input.roomCode,
      gameMode,
      gameStatus: database.gameStatus,
      lifecycleStatus: "active" as const,
      currentGameId: database.currentGameId,
      version: database.version,
    };
  };
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost() {
        throw new Error("Unexpected room creation.");
      },
      joinRoom: unusedJoin,
      async transitionRoomGameStatus(input) {
        if (input.nextStatus === "finished") {
          finishWrites += 1;
          if (outcome === "retry-after-no-commit" && finishWrites === 1) {
            throw new Error("Database rejected before commit.");
          }
          if (outcome === "commit-then-error" && finishWrites === 1) {
            persist(input);
            throw new Error("Commit succeeded but the response was lost.");
          }
          if (outcome === "ambiguous" && finishWrites === 1) {
            database.version = (BigInt(input.expectedVersion) + 1n).toString();
            throw new Error("Database outcome is ambiguous.");
          }
          if (outcome === "stale-version") {
            throw new RoomGameStatusTransitionError(
              "STALE_VERSION",
              "Room version changed.",
            );
          }
          if (outcome === "lease-loss") {
            throw new RoomRuntimeFencingError();
          }
        }
        return persist(input);
      },
      async readDeferredRoomMutationState() {
        canonicalReads += 1;
        return {
          room: {
            roomId,
            roomCode,
            lifecycleStatus: "active",
            gameStatus: database.gameStatus,
            currentGameId: database.currentGameId,
            version: database.version,
            hostPlayerId: created.playerId,
            activeMemberCount: 1,
          },
        };
      },
    },
    coordinator,
  );
  const gameId = randomUUID() as GameSessionId;
  const reservation = await commands.acquireGameStatusReservation(
    roomCode,
    "waiting",
    null,
    hostSocket,
  );
  await commands.transitionRoomGameStatus({
    roomCode,
    expectedStatus: "waiting",
    nextStatus: "starting",
    expectedCurrentGameId: null,
    nextGameId: gameId,
    initiatedBy: { kind: "host", playerId: created.playerId },
    reservation,
  });
  await commands.transitionRoomGameStatus({
    roomCode,
    expectedStatus: "starting",
    nextStatus: "in_progress",
    expectedCurrentGameId: gameId,
    nextGameId: gameId,
    initiatedBy: { kind: "game-service" },
    reservation,
  });

  return {
    rooms,
    commands,
    coordinator,
    database,
    roomCode,
    gameId,
    reservation,
    get finishWrites() {
      return finishWrites;
    },
    get canonicalReads() {
      return canonicalReads;
    },
  };
}

function transitionedInfo(
  input: TransitionRoomGameStatusInput,
  version: string,
  roomId = input.expectedRoomId,
): TransitionedRoomGameStatusInfo {
  return {
    roomId,
    roomCode: input.roomCode,
    gameMode: "impostor-classic",
    gameStatus: input.nextStatus,
    lifecycleStatus: "active",
    currentGameId: input.nextGameId,
    version,
  };
}

test("durable creation commits before memory and reuses the prepared identity and token", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  let persisted: CreateRoomWithHostInput | undefined;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        persisted = input;
        assert.equal(rooms.getPublicRoom(input.roomCode), undefined);
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
    },
    coordinator,
  );

  const response = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  assert.ok(persisted);
  assert.equal(response.room.code, persisted.roomCode);
  assert.equal(response.playerId, persisted.hostPlayerId);
  assert.deepEqual(
    persisted.reconnectTokenHash,
    createHash("sha256").update(response.reconnectToken).digest(),
  );
  assert.equal(rooms.getPublicRoom(response.room.code)?.players[0]?.id, response.playerId);
  assert.equal(coordinator.getMetadata(response.room.code)?.version, "1");

  rooms.disconnectSocket("host-socket");
  assert.equal(
    rooms.reconnect(
      {
        roomCode: response.room.code,
        playerId: response.playerId,
        reconnectToken: response.reconnectToken,
      },
      "reconnected-host",
    ).payload.player.id,
    response.playerId,
  );
});

test("durable game-status transition commits through coordinator metadata without mutating RoomService", async () => {
  const rooms = roomService(["STAT"]);
  const coordinator = new RoomPersistenceCoordinator();
  let persisted: TransitionRoomGameStatusInput | undefined;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async transitionRoomGameStatus(input) {
        persisted = input;
        const before = coordinator.getMetadata(input.roomCode);
        assert.equal(before?.version, "1");
        assert.equal(before?.gameStatus, "waiting");
        assert.equal(rooms.getPublicRoom(input.roomCode)?.gameStatus, "waiting");
        return transitionedInfo(input, "2");
      },
    },
    coordinator,
  );
  const created = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const gameId = "game-status-command-test" as GameSessionId;

  const committed = await commands.transitionRoomGameStatus({
    roomCode: created.room.code,
    expectedStatus: "waiting",
    nextStatus: "starting",
    expectedCurrentGameId: null,
    nextGameId: gameId,
    initiatedBy: { kind: "host", playerId: created.playerId },
  });

  assert.ok(persisted);
  assert.equal(persisted.expectedRoomId, coordinator.getMetadata(created.room.code)?.roomId);
  assert.equal(persisted.expectedVersion, "1");
  assert.equal(committed.gameStatus, "starting");
  assert.equal(committed.currentGameId, gameId);
  assert.equal(committed.version, "2");
  assert.deepEqual(coordinator.getMetadata(created.room.code), {
    roomCode: created.room.code,
    roomId: persisted.expectedRoomId,
    version: "2",
    gameStatus: "starting",
    currentGameId: gameId,
    lifecycleStatus: "active",
  });
  assert.equal(rooms.getPublicRoom(created.room.code)?.gameStatus, "waiting");
});

test("durable game-status transition requires the active reservation token", async () => {
  const rooms = roomService(["RSRV"]);
  const coordinator = new RoomPersistenceCoordinator();
  let repositoryCalls = 0;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async transitionRoomGameStatus(input) {
        repositoryCalls += 1;
        return transitionedInfo(input, "2");
      },
    },
    coordinator,
  );
  const created = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const gameId = "reserved-transition-test" as GameSessionId;
  const reservation = await commands.acquireGameStatusReservation(
    created.room.code,
    "waiting",
    null,
    "host-socket",
  );
  const transition = {
    roomCode: created.room.code,
    expectedStatus: "waiting" as const,
    nextStatus: "starting" as const,
    expectedCurrentGameId: null,
    nextGameId: gameId,
    initiatedBy: { kind: "host" as const, playerId: created.playerId },
  };

  try {
    await assert.rejects(
      commands.transitionRoomGameStatus(transition),
      (error: unknown) =>
        error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
    );
    assert.equal(repositoryCalls, 0);
    assert.equal(coordinator.getMetadata(created.room.code)?.version, "1");

    const committed = await commands.transitionRoomGameStatus({
      ...transition,
      reservation,
    });
    assert.equal(committed.gameStatus, "starting");
    assert.equal(repositoryCalls, 1);
    assert.equal(coordinator.getMetadata(created.room.code)?.version, "2");
  } finally {
    rooms.releaseGameStatusReservation(reservation);
  }
});

test("durable game-status transition rejects stale coordinator status and game identity", async () => {
  const rooms = roomService(["STAL"]);
  const coordinator = new RoomPersistenceCoordinator();
  let repositoryCalls = 0;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async transitionRoomGameStatus(input) {
        repositoryCalls += 1;
        return transitionedInfo(input, "2");
      },
    },
    coordinator,
  );
  const created = await commands.createRoom(CREATE_PAYLOAD, "host-socket");

  await assert.rejects(
    commands.transitionRoomGameStatus({
      roomCode: created.room.code,
      expectedStatus: "starting",
      nextStatus: "in_progress",
      expectedCurrentGameId: null,
      nextGameId: "game" as GameSessionId,
      initiatedBy: { kind: "game-service" },
    }),
    (error: unknown) =>
      error instanceof RoomGameStatusTransitionError
      && error.code === "STALE_STATUS",
  );
  await assert.rejects(
    commands.transitionRoomGameStatus({
      roomCode: created.room.code,
      expectedStatus: "waiting",
      nextStatus: "starting",
      expectedCurrentGameId: "stale-game" as GameSessionId,
      nextGameId: "next-game" as GameSessionId,
      initiatedBy: { kind: "host", playerId: created.playerId },
    }),
    (error: unknown) =>
      error instanceof RoomGameStatusTransitionError
      && error.code === "STALE_GAME_ID",
  );

  assert.equal(repositoryCalls, 0);
  assert.equal(coordinator.getMetadata(created.room.code)?.version, "1");
  assert.equal(coordinator.getMetadata(created.room.code)?.gameStatus, "waiting");
  assert.equal(coordinator.isFenced(created.room.code), false);
});

test("serializes competing game-status transitions and advances each confirmed version once", async () => {
  const rooms = roomService(["SERL"]);
  const coordinator = new RoomPersistenceCoordinator();
  const firstRepositoryCall = deferred<void>();
  const releaseFirstRepositoryCall = deferred<void>();
  const repositoryInputs: TransitionRoomGameStatusInput[] = [];
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async transitionRoomGameStatus(input) {
        repositoryInputs.push(input);
        if (repositoryInputs.length === 1) {
          firstRepositoryCall.resolve();
          await releaseFirstRepositoryCall.promise;
          return transitionedInfo(input, "2");
        }
        return transitionedInfo(input, "3");
      },
    },
    coordinator,
  );
  const created = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const firstGameId = "first-game" as GameSessionId;
  const firstTransition = commands.transitionRoomGameStatus({
    roomCode: created.room.code,
    expectedStatus: "waiting",
    nextStatus: "starting",
    expectedCurrentGameId: null,
    nextGameId: firstGameId,
    initiatedBy: { kind: "host", playerId: created.playerId },
  });
  await firstRepositoryCall.promise;
  const secondTransition = commands.transitionRoomGameStatus({
    roomCode: created.room.code,
    expectedStatus: "starting",
    nextStatus: "in_progress",
    expectedCurrentGameId: firstGameId,
    nextGameId: firstGameId,
    initiatedBy: { kind: "game-service" },
  });

  await Promise.resolve();
  assert.equal(repositoryInputs.length, 1);
  releaseFirstRepositoryCall.resolve();
  const [first, second] = await Promise.all([firstTransition, secondTransition]);

  assert.equal(first.version, "2");
  assert.equal(second.version, "3");
  assert.equal(repositoryInputs[1]?.expectedVersion, "2");
  assert.equal(repositoryInputs[1]?.expectedStatus, "starting");
  assert.equal(repositoryInputs[1]?.expectedCurrentGameId, firstGameId);
  assert.deepEqual(coordinator.getMetadata(created.room.code), {
    roomCode: created.room.code,
    roomId: repositoryInputs[1]?.expectedRoomId,
    version: "3",
    gameStatus: "in_progress",
    currentGameId: firstGameId,
    lifecycleStatus: "active",
  });
});

test("uncertain game-status commit fails closed without advancing coordinator metadata", async () => {
  const rooms = roomService(["UNKN"]);
  const coordinator = new RoomPersistenceCoordinator();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async transitionRoomGameStatus() {
        throw new Error("connection lost after commit");
      },
    },
    coordinator,
  );
  const created = await commands.createRoom(CREATE_PAYLOAD, "host-socket");

  await assert.rejects(
    commands.transitionRoomGameStatus({
      roomCode: created.room.code,
      expectedStatus: "waiting",
      nextStatus: "starting",
      expectedCurrentGameId: null,
      nextGameId: "uncertain-game" as GameSessionId,
      initiatedBy: { kind: "host", playerId: created.playerId },
    }),
    /could not be confirmed/,
  );

  assert.equal(coordinator.getMetadata(created.room.code)?.version, "1");
  assert.equal(coordinator.getMetadata(created.room.code)?.gameStatus, "waiting");
  assert.equal(coordinator.isFenced(created.room.code), true);
  assert.equal(rooms.getPublicRoom(created.room.code)?.gameStatus, "waiting");
});

test("stale durable game-status version fences the room without advancing metadata", async () => {
  const rooms = roomService(["VERS"]);
  const coordinator = new RoomPersistenceCoordinator();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async transitionRoomGameStatus() {
        throw new RoomGameStatusTransitionError(
          "STALE_VERSION",
          "Room version changed.",
        );
      },
    },
    coordinator,
  );
  const created = await commands.createRoom(CREATE_PAYLOAD, "host-socket");

  await assert.rejects(
    commands.transitionRoomGameStatus({
      roomCode: created.room.code,
      expectedStatus: "waiting",
      nextStatus: "starting",
      expectedCurrentGameId: null,
      nextGameId: "stale-version-game" as GameSessionId,
      initiatedBy: { kind: "host", playerId: created.playerId },
    }),
    (error: unknown) =>
      error instanceof RoomGameStatusTransitionError
      && error.code === "STALE_VERSION",
  );

  assert.equal(coordinator.getMetadata(created.room.code)?.version, "1");
  assert.equal(coordinator.getMetadata(created.room.code)?.gameStatus, "waiting");
  assert.equal(coordinator.isFenced(created.room.code), true);
});

test("durable game-status command fences a repository result for a different room identity", async () => {
  const rooms = roomService(["DIFF"]);
  const coordinator = new RoomPersistenceCoordinator();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async transitionRoomGameStatus(input) {
        return transitionedInfo(
          input,
          "2",
          "20000000-0000-4000-8000-000000000001",
        );
      },
    },
    coordinator,
  );
  const created = await commands.createRoom(CREATE_PAYLOAD, "host-socket");

  await assert.rejects(
    commands.transitionRoomGameStatus({
      roomCode: created.room.code,
      expectedStatus: "waiting",
      nextStatus: "starting",
      expectedCurrentGameId: null,
      nextGameId: "wrong-identity-game" as GameSessionId,
      initiatedBy: { kind: "host", playerId: created.playerId },
    }),
    /could not be synchronized safely/,
  );

  assert.equal(coordinator.getMetadata(created.room.code)?.version, "1");
  assert.equal(coordinator.isFenced(created.room.code), true);
});

test("durable Manhunt settings commit privately before the in-memory boundary changes", async () => {
  const rooms = roomService(["HUNT"]);
  const coordinator = new RoomPersistenceCoordinator();
  let settingsInput: UpdateWaitingRoomSettingsInput | undefined;
  const originalSettings: RoomSettings = {
    gameMode: "manhunt",
    maxPlayers: 8,
    isPrivate: false,
    manhunt: {
      hunterCount: 1,
      boundary: {
        center: { latitude: 51.5, longitude: -0.1 },
        radiusMeters: 500,
      },
    },
  };
  const nextBoundary = {
    center: { latitude: 51.6, longitude: -0.2 },
    radiusMeters: 650,
  };
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async updateWaitingRoomSettings(input) {
        settingsInput = input;
        assert.deepEqual(
          rooms.getManhuntBoundary(input.roomCode),
          originalSettings.manhunt?.boundary,
        );
        assert.equal(input.expectedVersion, "1");
        assert.ok(input.expectedRoomId);
        assert.deepEqual(input.settings.manhunt?.boundary, nextBoundary);
        return {
          roomId: input.expectedRoomId,
          roomCode: input.roomCode,
          gameMode: "manhunt",
          lifecycleStatus: "active",
          currentGameId: null,
          version: "2",
        };
      },
    },
    coordinator,
  );
  const created = await commands.createRoom(
    { nickname: "Host", settings: originalSettings },
    "host-socket",
  );

  const updated = await commands.updateManhuntSettings(
    created.room.code,
    "host-socket",
    {
      hunterCount: 2,
      gameDurationSeconds: 1_800,
      boundary: nextBoundary,
    },
  );

  assert.ok(settingsInput);
  assert.equal(settingsInput.requestingPlayerId, created.playerId);
  assert.deepEqual(rooms.getManhuntBoundary(created.room.code), nextBoundary);
  assert.equal(updated.settings.manhunt?.hunterCount, 2);
  assert.equal(JSON.stringify(updated).includes("boundary"), false);
  assert.equal(coordinator.getMetadata(created.room.code)?.version, "2");
});

test("uncertain durable settings failure leaves memory unchanged and fences the room", async () => {
  const rooms = roomService(["HUNT"]);
  const settings: RoomSettings = {
    gameMode: "manhunt",
    maxPlayers: 8,
    isPrivate: false,
    manhunt: {
      hunterCount: 1,
      boundary: {
        center: { latitude: 51.5, longitude: -0.1 },
        radiusMeters: 500,
      },
    },
  };
  const coordinator = new RoomPersistenceCoordinator();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async updateWaitingRoomSettings() {
        throw new Error("uncertain database failure");
      },
    },
    coordinator,
  );
  const created = await commands.createRoom(
    { nickname: "Host", settings },
    "host-socket",
  );

  await assert.rejects(
    commands.updateManhuntSettings(created.room.code, "host-socket", {
      hunterCount: 2,
      boundary: {
        center: { latitude: 51.6, longitude: -0.2 },
        radiusMeters: 650,
      },
    }),
    (error: unknown) => error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.deepEqual(
    rooms.getManhuntBoundary(created.room.code),
    settings.manhunt?.boundary,
  );
  assert.equal(rooms.getPublicRoom(created.room.code)?.settings.manhunt?.hunterCount, 1);
  assert.equal(coordinator.getMetadata(created.room.code)?.version, "1");
  assert.equal(coordinator.isFenced(created.room.code), true);
});

test("failed durable creation leaves no in-memory room", async () => {
  const rooms = roomService(["ABCD"]);
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost() {
        throw new Error("database unavailable");
      },
      joinRoom: unusedJoin,
    },
    new RoomPersistenceCoordinator(),
  );

  await assert.rejects(
    commands.createRoom(CREATE_PAYLOAD, "host-socket"),
    (error: unknown) => error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.equal(rooms.getPublicRoom("ABCD" as RoomCode), undefined);
});

test("room-code collisions retry with a new code and fixed identities within a bound", async () => {
  const rooms = roomService(["AAAA", "BBBB", "CCCC"]);
  const coordinator = new RoomPersistenceCoordinator();
  const attempts: CreateRoomWithHostInput[] = [];
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        attempts.push(input);
        if (attempts.length < 3) {
          throw collisionError();
        }
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
    },
    coordinator,
  );

  const response = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map(({ roomCode }) => roomCode), ["AAAA", "BBBB", "CCCC"]);
  assert.equal(new Set(attempts.map(({ roomId }) => roomId)).size, 1);
  assert.equal(new Set(attempts.map(({ hostPlayerId }) => hostPlayerId)).size, 1);
  assert.equal(
    new Set(attempts.map(({ reconnectTokenHash }) => reconnectTokenHash.toString("hex"))).size,
    1,
  );
  assert.equal(response.room.code, "CCCC");
});

test("room-code collision retries stop after the configured attempt bound", async () => {
  const rooms = roomService(["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"]);
  let attempts = 0;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost() {
        attempts += 1;
        throw collisionError();
      },
      joinRoom: unusedJoin,
    },
    new RoomPersistenceCoordinator(),
  );

  await assert.rejects(commands.createRoom(CREATE_PAYLOAD, "host-socket"));
  assert.equal(attempts, 5);
  assert.equal(rooms.getPublicRoom("AAAA" as RoomCode), undefined);
});

test("durable joining commits in PostgreSQL before adding the prepared player", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  let persistedJoin: JoinRoomInput | undefined;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      async joinRoom(input) {
        persistedJoin = input;
        assert.equal(rooms.getPublicRoom(input.roomCode)?.players.length, 1);
        assert.equal(input.expectedVersion, "1");
        assert.equal(
          input.expectedRoomId,
          coordinator.getMetadata(input.roomCode)?.roomId,
        );
        return joinedInfo(input, "2");
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const response = await commands.joinRoom(
    { roomCode: host.room.code, nickname: "Guest" },
    "guest-socket",
  );

  assert.ok(persistedJoin);
  assert.equal(response.playerId, persistedJoin.playerId);
  assert.equal(response.room.players.length, 2);
  assert.deepEqual(
    persistedJoin.reconnectTokenHash,
    createHash("sha256").update(response.reconnectToken).digest(),
  );
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "2");
  rooms.disconnectSocket("guest-socket");
  assert.equal(
    rooms.reconnect(
      {
        roomCode: host.room.code,
        playerId: response.playerId,
        reconnectToken: response.reconnectToken,
      },
      "reconnected-guest",
    ).payload.player.id,
    response.playerId,
  );
});

test("failed durable joining leaves membership and version unchanged", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      async joinRoom() {
        throw new RoomJoinError("ROOM_FULL", "Room is full.");
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");

  await assert.rejects(
    commands.joinRoom(
      { roomCode: host.room.code, nickname: "Guest" },
      "guest-socket",
    ),
    (error: unknown) => error instanceof AppError && error.code === "ROOM_FULL",
  );
  assert.equal(rooms.getPublicRoom(host.room.code)?.players.length, 1);
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "1");
  assert.equal(coordinator.isFenced(host.room.code), false);
});

test("stale durable joins are rejected and fence the room for reconciliation", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      async joinRoom() {
        throw new RoomJoinError("STALE_VERSION", "Room version changed.");
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");

  await assert.rejects(
    commands.joinRoom(
      { roomCode: host.room.code, nickname: "Guest" },
      "guest-socket",
    ),
    (error: unknown) => error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.equal(rooms.getPublicRoom(host.room.code)?.players.length, 1);
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "1");
  assert.equal(coordinator.isFenced(host.room.code), true);
});

test("registration and in-memory commit failures after durable creation fence the room", async () => {
  const registrationRooms = roomService(["ABCD"]);
  const registrationCoordinator = new RoomPersistenceCoordinator();
  const registrationCommands = new RoomPersistenceCommands(
    registrationRooms,
    {
      async createRoomWithHost(input) {
        registrationCoordinator.registerCreatedRoom({
          ...createdInfo(input),
          roomCode: "WXYZ",
        });
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
    },
    registrationCoordinator,
  );
  await assert.rejects(
    registrationCommands.createRoom(CREATE_PAYLOAD, "host-socket"),
    (error: unknown) => error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.equal(registrationRooms.getPublicRoom("ABCD" as RoomCode), undefined);
  assert.equal(registrationCoordinator.isFenced("ABCD" as RoomCode), true);

  class FailingCreationRoomService extends RoomService {
    override commitPreparedRoomCreation(
      _prepared: PreparedRoomCreation,
      _socketId: string,
    ): never {
      throw new Error("simulated in-memory failure");
    }
  }
  const failingRooms = new FailingCreationRoomService(() => "EFGH" as RoomCode);
  const failingCoordinator = new RoomPersistenceCoordinator();
  const failingCommands = new RoomPersistenceCommands(
    failingRooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
    },
    failingCoordinator,
  );
  await assert.rejects(
    failingCommands.createRoom(CREATE_PAYLOAD, "host-socket"),
    (error: unknown) => error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.equal(failingRooms.getPublicRoom("EFGH" as RoomCode), undefined);
  assert.equal(failingCoordinator.isFenced("EFGH" as RoomCode), true);
});

test("in-memory join failure after a successful durable commit fences the room", async () => {
  class FailingJoinRoomService extends RoomService {
    override commitPreparedRoomJoin(
      _prepared: PreparedRoomJoin,
      _socketId: string,
    ): never {
      throw new Error("simulated in-memory failure");
    }
  }
  let codeIndex = 0;
  const rooms = new FailingJoinRoomService(
    () => ["ABCD", "ABCD"][Math.min(codeIndex++, 1)] as RoomCode,
  );
  const coordinator = new RoomPersistenceCoordinator();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      async joinRoom(input) {
        return joinedInfo(input, "2");
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");

  await assert.rejects(
    commands.joinRoom(
      { roomCode: host.room.code, nickname: "Guest" },
      "guest-socket",
    ),
    (error: unknown) => error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "2");
  assert.equal(coordinator.isFenced(host.room.code), true);
  assert.equal(rooms.getPublicRoom(host.room.code)?.players.length, 1);
  assert.throws(
    () => rooms.leaveRoom(host.room.code, "host-socket"),
    (error: unknown) => error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.equal(rooms.getPublicRoom(host.room.code)?.players.length, 1);
});

test("terminal completion rejects stale versions and wrong game IDs in every mode", async () => {
  const modes: GameMode[] = [
    "impostor-classic",
    "impostor-word",
    "manhunt",
  ];
  for (const mode of modes) {
    const fixture = await createTerminalFixture(mode, "stale-version");
    try {
      await assert.rejects(
        fixture.commands.finishGame(
          fixture.roomCode,
          "wrong-game-id" as GameSessionId,
          "in_progress",
          fixture.reservation,
        ),
        (error: unknown) =>
          error instanceof RoomGameStatusTransitionError
          && error.code === "STALE_GAME_ID",
      );
      assert.equal(fixture.finishWrites, 0);
      assert.equal(fixture.database.gameStatus, "in_progress");

      await assert.rejects(
        fixture.commands.finishGame(
          fixture.roomCode,
          fixture.gameId,
          "in_progress",
          fixture.reservation,
        ),
        (error: unknown) =>
          error instanceof RoomGameStatusTransitionError
          && error.code === "STALE_VERSION",
      );
      assert.equal(fixture.finishWrites, 1);
      assert.equal(fixture.canonicalReads, 0);
      assert.equal(fixture.coordinator.isFenced(fixture.roomCode), true);
      assert.equal(fixture.database.gameStatus, "in_progress");
      assert.equal(
        fixture.coordinator.getMetadata(fixture.roomCode)?.currentGameId,
        fixture.gameId,
      );
    } finally {
      fixture.rooms.releaseGameStatusReservation(fixture.reservation);
    }
  }
});

test("terminal completion reconciles canonical outcomes without blindly retrying in every mode", async () => {
  const modes: GameMode[] = [
    "impostor-classic",
    "impostor-word",
    "manhunt",
  ];
  const scenarios: Array<{
    outcome: Extract<
      TerminalOutcome,
      "retry-after-no-commit" | "commit-then-error" | "ambiguous"
    >;
    expectedWrites: number;
    expectedReads: number;
  }> = [
    {
      outcome: "retry-after-no-commit",
      expectedWrites: 2,
      expectedReads: 1,
    },
    {
      outcome: "commit-then-error",
      expectedWrites: 1,
      expectedReads: 1,
    },
    {
      outcome: "ambiguous",
      expectedWrites: 1,
      expectedReads: 1,
    },
  ];

  for (const mode of modes) {
    for (const scenario of scenarios) {
      const fixture = await createTerminalFixture(mode, scenario.outcome);
      try {
        if (scenario.outcome === "ambiguous") {
          await assert.rejects(
            fixture.commands.finishGame(
              fixture.roomCode,
              fixture.gameId,
              "in_progress",
              fixture.reservation,
            ),
            /remains fenced pending reconciliation/,
          );
          assert.equal(fixture.coordinator.isFenced(fixture.roomCode), true);
          assert.throws(
            () => fixture.rooms.assertRoomNotReserved(fixture.roomCode),
            (error: unknown) =>
              error instanceof AppError && error.code === "UNKNOWN",
          );
          assert.equal(fixture.database.gameStatus, "in_progress");
          assert.equal(fixture.database.version, "4");
          assert.equal(
            fixture.coordinator.getMetadata(fixture.roomCode)?.gameStatus,
            "in_progress",
          );
        } else {
          const completed = await fixture.commands.finishGame(
            fixture.roomCode,
            fixture.gameId,
            "in_progress",
            fixture.reservation,
          );
          assert.equal(completed.gameStatus, "finished");
          assert.equal(completed.currentGameId, fixture.gameId);
          assert.equal(fixture.database.gameStatus, "finished");
          assert.equal(fixture.database.currentGameId, fixture.gameId);

          await fixture.commands.finishGame(
            fixture.roomCode,
            fixture.gameId,
            "in_progress",
            fixture.reservation,
          );
          assert.equal(fixture.finishWrites, scenario.expectedWrites);
          assert.equal(fixture.coordinator.isFenced(fixture.roomCode), false);
        }
        assert.equal(fixture.finishWrites, scenario.expectedWrites);
        assert.equal(fixture.canonicalReads, scenario.expectedReads);
      } finally {
        fixture.rooms.releaseGameStatusReservation(fixture.reservation);
      }
    }
  }
});

test("terminal completion stops on runtime lease loss in every mode", async () => {
  const modes: GameMode[] = [
    "impostor-classic",
    "impostor-word",
    "manhunt",
  ];
  for (const mode of modes) {
    const fixture = await createTerminalFixture(mode, "lease-loss");
    try {
      await assert.rejects(
        fixture.commands.finishGame(
          fixture.roomCode,
          fixture.gameId,
          "in_progress",
          fixture.reservation,
        ),
        RoomRuntimeFencingError,
      );
      assert.equal(fixture.finishWrites, 1);
      assert.equal(fixture.canonicalReads, 0);
      assert.equal(fixture.coordinator.isFenced(fixture.roomCode), true);
      assert.equal(fixture.database.gameStatus, "in_progress");
    } finally {
      fixture.rooms.releaseGameStatusReservation(fixture.reservation);
    }
  }
});

test("same-room joins serialize in FIFO order and consume committed versions", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  const firstRepositoryCall = deferred<void>();
  const releaseFirstCall = deferred<void>();
  const versions: string[] = [];
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      async joinRoom(input) {
        versions.push(input.expectedVersion!);
        if (versions.length === 1) {
          firstRepositoryCall.resolve();
          await releaseFirstCall.promise;
        }
        return joinedInfo(input, (BigInt(input.expectedVersion!) + 1n).toString());
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const firstJoin = commands.joinRoom(
    { roomCode: host.room.code, nickname: "First" },
    "first-socket",
  );
  await firstRepositoryCall.promise;
  const secondJoin = commands.joinRoom(
    { roomCode: host.room.code, nickname: "Second" },
    "second-socket",
  );
  assert.deepEqual(versions, ["1"]);

  releaseFirstCall.resolve();
  await Promise.all([firstJoin, secondJoin]);
  assert.deepEqual(versions, ["1", "2"]);
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "3");
});

test("different rooms can join concurrently and duplicate socket operations are rejected", async () => {
  const rooms = roomService(["ABCD", "EFGH"]);
  const coordinator = new RoomPersistenceCoordinator();
  const bothJoinCalls = deferred<void>();
  const releaseJoins = deferred<void>();
  let joinCalls = 0;
  const createInputs: CreateRoomWithHostInput[] = [];
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        createInputs.push(input);
        return createdInfo(input);
      },
      async joinRoom(input) {
        joinCalls += 1;
        if (joinCalls === 2) {
          bothJoinCalls.resolve();
        }
        await releaseJoins.promise;
        return joinedInfo(input, "2");
      },
    },
    coordinator,
  );
  const firstHost = await commands.createRoom(CREATE_PAYLOAD, "first-host");
  const secondHost = await commands.createRoom(CREATE_PAYLOAD, "second-host");
  const firstJoin = commands.joinRoom(
    { roomCode: firstHost.room.code, nickname: "First Guest" },
    "first-guest",
  );
  const duplicateOnSameSocket = commands.joinRoom(
    { roomCode: firstHost.room.code, nickname: "Duplicate" },
    "first-guest",
  );
  const secondJoin = commands.joinRoom(
    { roomCode: secondHost.room.code, nickname: "Second Guest" },
    "second-guest",
  );

  await bothJoinCalls.promise;
  await assert.rejects(duplicateOnSameSocket, AppError);
  assert.equal(joinCalls, 2);
  releaseJoins.resolve();
  await Promise.all([firstJoin, secondJoin]);
  assert.equal(createInputs.length, 2);
});

test("a failed queued join does not advance version or block the next operation", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  let shouldFail = true;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      async joinRoom(input) {
        if (shouldFail) {
          shouldFail = false;
          throw new RoomJoinError("ROOM_FULL", "Room is full.");
        }
        return joinedInfo(input, (BigInt(input.expectedVersion!) + 1n).toString());
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const payload: JoinRoomPayload = {
    roomCode: host.room.code,
    nickname: "Guest",
  };

  await assert.rejects(commands.joinRoom(payload, "first-guest"));
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "1");
  const joined = await commands.joinRoom(payload, "second-guest");
  assert.equal(joined.room.players.length, 2);
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "2");
});

test("server-only durable metadata never contains reconnect credentials", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
    },
    coordinator,
  );
  const response = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const metadata = coordinator.getMetadata(response.room.code);
  assert.ok(metadata);
  assert.deepEqual(Object.keys(metadata).sort(), [
    "currentGameId",
    "gameStatus",
    "lifecycleStatus",
    "roomCode",
    "roomId",
    "version",
  ]);
  assert.equal(JSON.stringify(metadata).includes(response.reconnectToken), false);
  assert.equal(
    JSON.stringify(metadata).includes(
      createHash("sha256").update(response.reconnectToken).digest("hex"),
    ),
    false,
  );
});

test("durable leave commits before removing memory membership and applies the committed host transfer", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  let guestId: PlayerId | undefined;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      async joinRoom(input) {
        guestId = input.playerId;
        return joinedInfo(input, "2");
      },
      async leaveRoom(input) {
        assert.equal(rooms.getPublicRoom(input.roomCode)?.players.length, 2);
        assert.equal(input.expectedVersion, "2");
        assert.equal(input.expectedRoomId, coordinator.getMetadata(input.roomCode)?.roomId);
        const result: LeftRoomInfo = {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          deleted: false,
          hostChanged: true,
          hostPlayerId: guestId!,
          lifecycleStatus: "active",
          currentGameId: null,
          version: "3",
        };
        return result;
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const guest = await commands.joinRoom(
    { roomCode: host.room.code, nickname: "Guest" },
    "guest-socket",
  );
  const removed = await commands.leaveRoom(host.room.code, "host-socket");

  assert.equal(removed.hostChanged, true);
  assert.equal(removed.room?.players.length, 1);
  assert.equal(removed.room?.players[0]?.id, guest.playerId);
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "3");
  rooms.assertHost(host.room.code, "guest-socket");
  assert.throws(() => rooms.assertHost(host.room.code, "host-socket"), AppError);
});

test("durable final-member leave removes runtime and metadata without inventing a next version", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async leaveRoom(input) {
        assert.equal(rooms.getPublicRoom(input.roomCode)?.players.length, 1);
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          deleted: true as const,
          hostChanged: true,
          currentGameId: null,
        };
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const removal = await commands.leaveRoom(host.room.code, "host-socket");

  assert.equal(removal.deleted, true);
  assert.equal(rooms.getPublicRoom(host.room.code), undefined);
  assert.equal(coordinator.getMetadata(host.room.code), undefined);
  assert.equal(coordinator.pendingRoomQueueCount, 0);
});

test("durable disconnect and reconnect commit before changing runtime connection state", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  let rawToken: string | undefined;
  let deadline: Date | undefined;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      async joinRoom(input) {
        const result = joinedInfo(input, "2");
        return result;
      },
      async markDisconnected(input: MarkDisconnectedInput) {
        const player = rooms.getPublicRoom(input.roomCode)?.players.find(
          (entry) => entry.id === input.playerId,
        );
        assert.equal(player?.connectionStatus, "connected");
        assert.equal(input.expectedVersion, "2");
        deadline = input.reconnectDeadlineAt;
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "1",
          reconnectDeadlineAt: input.reconnectDeadlineAt,
          lifecycleStatus: "active" as const,
          currentGameId: null,
          version: "3",
        };
      },
      async reconnectPlayer(input: ReconnectPlayerInput) {
        rawToken = input.reconnectToken;
        const player = rooms.getPublicRoom(input.roomCode)?.players.find(
          (entry) => entry.id === input.playerId,
        );
        assert.equal(player?.connectionStatus, "disconnected");
        assert.equal(input.expectedVersion, "3");
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "2",
          lifecycleStatus: "active" as const,
          currentGameId: null,
          version: "4",
        };
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const guest = await commands.joinRoom(
    { roomCode: host.room.code, nickname: "Guest" },
    "guest-socket",
  );
  const disconnected = await commands.disconnectSocket(
    "guest-socket",
    60_000,
  );

  assert.ok(disconnected);
  assert.ok(deadline);
  assert.equal(disconnected.disconnectGeneration, "1");
  assert.equal(disconnected.reconnectDeadlineAt?.getTime(), deadline.getTime());
  assert.equal(
    rooms.getPublicRoom(host.room.code)?.players.find(
      (entry) => entry.id === guest.playerId,
    )?.connectionStatus,
    "disconnected",
  );
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "3");

  const result = await commands.reconnect(
    {
      roomCode: host.room.code,
      playerId: guest.playerId,
      reconnectToken: guest.reconnectToken,
    },
    "reconnected-guest",
  );
  assert.equal(rawToken, guest.reconnectToken);
  assert.equal(result.payload.player.id, guest.playerId);
  assert.equal(result.room.players.find((player) => player.id === guest.playerId)?.connectionStatus, "connected");
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "4");
});

test("disconnects during a game-status reservation drain once in FIFO order", async () => {
  const rooms = roomService(["DFRQ"]);
  const coordinator = new RoomPersistenceCoordinator();
  const disconnectedPlayerIds: PlayerId[] = [];
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      async joinRoom(input) {
        return joinedInfo(
          input,
          (BigInt(input.expectedVersion ?? "1") + 1n).toString(),
        );
      },
      async markDisconnected(input: MarkDisconnectedInput) {
        disconnectedPlayerIds.push(input.playerId);
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "1",
          reconnectDeadlineAt: input.reconnectDeadlineAt,
          lifecycleStatus: "active" as const,
          currentGameId: null,
          gameStatus: "waiting" as const,
          version: (BigInt(input.expectedVersion!) + 1n).toString(),
        };
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const firstGuest = await commands.joinRoom(
    { roomCode: host.room.code, nickname: "First" },
    "first-socket",
  );
  const secondGuest = await commands.joinRoom(
    { roomCode: host.room.code, nickname: "Second" },
    "second-socket",
  );
  const reservation = await commands.acquireGameStatusReservation(
    host.room.code,
    "waiting",
    null,
    "host-socket",
  );

  const firstDisconnect = commands.disconnectSocket("first-socket", 60_000);
  const secondDisconnect = commands.disconnectSocket("second-socket", 60_000);
  await Promise.resolve();
  assert.deepEqual(disconnectedPlayerIds, []);
  assert.equal(
    rooms.getPublicRoom(host.room.code)?.players.find(
      (player) => player.id === firstGuest.playerId,
    )?.connectionStatus,
    "connected",
  );

  rooms.releaseGameStatusReservation(reservation);
  const [firstResult, secondResult] = await Promise.all([
    firstDisconnect,
    secondDisconnect,
  ]);
  assert.equal(firstResult?.playerId, firstGuest.playerId);
  assert.equal(secondResult?.playerId, secondGuest.playerId);
  assert.deepEqual(disconnectedPlayerIds, [
    firstGuest.playerId,
    secondGuest.playerId,
  ]);
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "5");
});

test("timeout removal during a game-status reservation is deferred and preserves its deadline", async () => {
  const rooms = roomService(["TMDF"]);
  const coordinator = new RoomPersistenceCoordinator();
  let persistedDeadline: Date | undefined;
  let removed = 0;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      async joinRoom(input) {
        return joinedInfo(input, "2");
      },
      async markDisconnected(input: MarkDisconnectedInput) {
        persistedDeadline = input.reconnectDeadlineAt;
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "1",
          reconnectDeadlineAt: input.reconnectDeadlineAt,
          lifecycleStatus: "active" as const,
          currentGameId: null,
          gameStatus: "waiting" as const,
          version: "3",
        };
      },
      async removeDisconnectedPlayer(input: RemoveDisconnectedPlayerInput) {
        removed += 1;
        assert.equal(input.expectedDisconnectGeneration, "1");
        assert.equal(
          input.expectedReconnectDeadlineAt?.getTime(),
          persistedDeadline?.getTime(),
        );
        return {
          status: "removed" as const,
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          deleted: false as const,
          hostChanged: false,
          lifecycleStatus: "active" as const,
          currentGameId: null,
          gameStatus: "waiting" as const,
          version: "4",
        };
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const guest = await commands.joinRoom(
    { roomCode: host.room.code, nickname: "Guest" },
    "guest-socket",
  );
  const disconnected = await commands.disconnectSocket("guest-socket", 1);
  assert.ok(disconnected?.reconnectDeadlineAt);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reservation = await commands.acquireGameStatusReservation(
    host.room.code,
    "waiting",
    null,
    "host-socket",
  );

  const timeout = commands.removeDisconnectedPlayer(
    host.room.code,
    guest.playerId,
    disconnected.disconnectGeneration!,
    disconnected.reconnectDeadlineAt,
    new Date(disconnected.reconnectDeadlineAt.getTime() + 1),
  );
  await Promise.resolve();
  assert.equal(removed, 0);
  rooms.releaseGameStatusReservation(reservation);

  const result = await timeout;
  assert.equal(removed, 1);
  assert.ok(result && !("retryAt" in result));
  assert.equal(
    rooms.getPublicRoom(host.room.code)?.players.some(
      (player) => player.id === guest.playerId,
    ),
    false,
  );
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "4");
});

test("a stale timeout generation queued during a reservation is discarded", async () => {
  const rooms = roomService(["STQT"]);
  const coordinator = new RoomPersistenceCoordinator();
  let currentGeneration = "1";
  let timeoutCalls = 0;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      async joinRoom(input) {
        return joinedInfo(input, "2");
      },
      async markDisconnected(input: MarkDisconnectedInput) {
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: currentGeneration,
          reconnectDeadlineAt: input.reconnectDeadlineAt,
          lifecycleStatus: "active" as const,
          currentGameId: null,
          gameStatus: "waiting" as const,
          version: (BigInt(input.expectedVersion!) + 1n).toString(),
        };
      },
      async reconnectPlayer(input: ReconnectPlayerInput) {
        currentGeneration = "2";
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: currentGeneration,
          lifecycleStatus: "active" as const,
          currentGameId: null,
          gameStatus: "waiting" as const,
          version: (BigInt(input.expectedVersion!) + 1n).toString(),
        };
      },
      async removeDisconnectedPlayer(input: RemoveDisconnectedPlayerInput) {
        timeoutCalls += 1;
        assert.equal(input.expectedDisconnectGeneration, "1");
        return {
          status: "stale" as const,
          roomCode: input.roomCode,
          playerId: input.playerId,
          reason: "generation_mismatch" as const,
        };
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const guest = await commands.joinRoom(
    { roomCode: host.room.code, nickname: "Guest" },
    "guest-socket",
  );
  const disconnected = await commands.disconnectSocket("guest-socket", 60_000);
  assert.ok(disconnected?.reconnectDeadlineAt);
  const reconnected = await commands.reconnect(
    {
      roomCode: host.room.code,
      playerId: guest.playerId,
      reconnectToken: guest.reconnectToken,
    },
    "replacement-socket",
  );
  assert.equal(reconnected.payload.player.id, guest.playerId);

  const reservation = await commands.acquireGameStatusReservation(
    host.room.code,
    "waiting",
    null,
    "host-socket",
  );
  const timeout = commands.removeDisconnectedPlayer(
    host.room.code,
    guest.playerId,
    disconnected.disconnectGeneration!,
    disconnected.reconnectDeadlineAt,
    new Date(disconnected.reconnectDeadlineAt.getTime() + 1),
  );
  rooms.releaseGameStatusReservation(reservation);

  assert.equal(await timeout, undefined);
  assert.equal(timeoutCalls, 1);
  assert.equal(
    rooms.getPublicRoom(host.room.code)?.players.find(
      (player) => player.id === guest.playerId,
    )?.connectionStatus,
    "connected",
  );
});

test("timeout removal uses persisted generation and deadline and applies the database-selected host", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  let hostId: PlayerId | undefined;
  let guestId: PlayerId | undefined;
  let deadline: Date | undefined;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        hostId = input.hostPlayerId;
        return createdInfo(input);
      },
      async joinRoom(input) {
        guestId = input.playerId;
        return joinedInfo(input, "2");
      },
      async markDisconnected(input) {
        deadline = input.reconnectDeadlineAt;
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "1",
          reconnectDeadlineAt: input.reconnectDeadlineAt,
          lifecycleStatus: "active" as const,
          currentGameId: null,
          version: "3",
        };
      },
      async removeDisconnectedPlayer(input: RemoveDisconnectedPlayerInput) {
        assert.ok(deadline);
        assert.equal(input.expectedDisconnectGeneration, "1");
        assert.equal(input.expectedReconnectDeadlineAt?.getTime(), deadline.getTime());
        assert.equal(input.expectedVersion, "3");
        assert.equal(rooms.getPublicRoom(input.roomCode)?.players.length, 2);
        return {
          status: "removed" as const,
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          deleted: false as const,
          hostChanged: true,
          hostPlayerId: guestId!,
          lifecycleStatus: "active" as const,
          currentGameId: null,
          version: "4",
        };
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  await commands.joinRoom(
    { roomCode: host.room.code, nickname: "Guest" },
    "guest-socket",
  );
  const disconnected = await commands.disconnectSocket("host-socket", 60_000);
  assert.ok(disconnected?.reconnectDeadlineAt);
  assert.ok(deadline);

  const removed = await commands.removeDisconnectedPlayer(
    host.room.code,
    hostId!,
    "1",
    deadline,
    new Date(deadline.getTime() + 1),
  );
  assert.ok(removed && !("retryAt" in removed));
  assert.equal(removed.deleted, false);
  assert.equal(removed.hostChanged, true);
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "4");
  rooms.assertHost(host.room.code, "guest-socket");
  assert.equal(rooms.getPublicRoom(host.room.code)?.players.length, 1);
});

test("timeout deletion removes runtime and coordinator metadata without a version", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  let deadline: Date | undefined;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async markDisconnected(input) {
        deadline = input.reconnectDeadlineAt;
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "1",
          reconnectDeadlineAt: input.reconnectDeadlineAt,
          lifecycleStatus: "active" as const,
          currentGameId: null,
          version: "2",
        };
      },
      async removeDisconnectedPlayer(input) {
        assert.equal(input.expectedVersion, "2");
        return {
          status: "room_deleted" as const,
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          deleted: true as const,
          currentGameId: null,
        };
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  await commands.disconnectSocket("host-socket", 60_000);
  assert.ok(deadline);

  const removal = await commands.removeDisconnectedPlayer(
    host.room.code,
    host.playerId,
    "1",
    deadline,
    new Date(deadline.getTime() + 1),
  );
  assert.ok(removal && !("retryAt" in removal));
  assert.equal(removal.deleted, true);
  assert.equal(rooms.getPublicRoom(host.room.code), undefined);
  assert.equal(coordinator.getMetadata(host.room.code), undefined);
  assert.equal(coordinator.pendingRoomQueueCount, 0);
});

test("a failed deferred disconnect fences the room and retains the FIFO head", async () => {
  const rooms = roomService(["DFER"]);
  const coordinator = new RoomPersistenceCoordinator();
  let markDisconnectedCalls = 0;
  let failedInput: MarkDisconnectedInput | undefined;
  let hostPlayerId: PlayerId | undefined;
  let guestPlayerId: PlayerId | undefined;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      async joinRoom(input) {
        return joinedInfo(
          input,
          (BigInt(input.expectedVersion ?? "1") + 1n).toString(),
        );
      },
      async markDisconnected(input) {
        markDisconnectedCalls += 1;
        failedInput = input;
        throw new Error("uncertain disconnect commit");
      },
      async readDeferredRoomMutationState(roomCode, playerId) {
        assert.ok(failedInput);
        return {
          room: {
            roomId: failedInput.expectedRoomId!,
            roomCode,
            lifecycleStatus: "active",
            gameStatus: "waiting",
            currentGameId: null,
            version: "3",
            hostPlayerId: hostPlayerId!,
            activeMemberCount: 2,
          },
          member: {
            membershipStatus: "active",
            connectionStatus: playerId === guestPlayerId ? "disconnected" : "connected",
            disconnectGeneration: playerId === guestPlayerId ? "1" : "0",
            reconnectDeadlineAt: playerId === guestPlayerId
              ? failedInput.reconnectDeadlineAt
              : null,
          },
        };
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  hostPlayerId = host.playerId;
  const guest = await commands.joinRoom(
    { roomCode: host.room.code, nickname: "Guest" },
    "guest-socket",
  );
  guestPlayerId = guest.playerId;
  const reservation = await commands.acquireGameStatusReservation(
    host.room.code,
    "waiting",
    null,
    "host-socket",
  );
  const first = commands.disconnectSocket("guest-socket", 60_000);
  const second = commands.disconnectSocket("host-socket", 60_000);
  let firstSettled = false;
  void first.then(() => {
    firstSettled = true;
  });

  rooms.releaseGameStatusReservation(reservation);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(firstSettled, false);

  assert.equal(markDisconnectedCalls, 1);
  assert.equal(coordinator.isFenced(host.room.code), true);
  const queues = Reflect.get(rooms, "deferredRoomMutations") as Map<
    RoomCode,
    { pending: unknown[]; blocked: boolean }
  >;
  assert.equal(queues.get(host.room.code)?.pending.length, 2);
  assert.equal(queues.get(host.room.code)?.blocked, true);

  assert.equal(await commands.reconcileDeferredRoomMutations(host.room.code), true);
  const disconnected = await first;
  assert.equal(disconnected?.playerId, guest.playerId);
  assert.equal(disconnected?.disconnectGeneration, "1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(markDisconnectedCalls, 2);
  assert.equal(rooms.getPublicRoom(host.room.code)?.players.find(
    (player) => player.id === guest.playerId,
  )?.connectionStatus, "disconnected");
  assert.equal(queues.get(host.room.code)?.pending.length, 1);
  assert.equal(queues.get(host.room.code)?.blocked, true);
  void second;
});

test("reconciliation retries a deferred disconnect only after proving no commit", async () => {
  const rooms = roomService(["NCOM"]);
  const coordinator = new RoomPersistenceCoordinator();
  let markCalls = 0;
  let preparedInput: MarkDisconnectedInput | undefined;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async markDisconnected(input) {
        markCalls += 1;
        preparedInput = input;
        if (markCalls === 1) {
          throw new Error("known rollback");
        }
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "1",
          reconnectDeadlineAt: input.reconnectDeadlineAt,
          lifecycleStatus: "active",
          currentGameId: null,
          version: "2",
        };
      },
      async readDeferredRoomMutationState(roomCode, playerId) {
        assert.ok(preparedInput);
        return {
          room: {
            roomId: preparedInput.expectedRoomId!,
            roomCode,
            lifecycleStatus: "active",
            gameStatus: "waiting",
            currentGameId: null,
            version: "1",
            hostPlayerId: preparedInput.playerId,
            activeMemberCount: 1,
          },
          member: {
            membershipStatus: "active",
            connectionStatus: "connected",
            disconnectGeneration: "0",
            reconnectDeadlineAt: null,
          },
        };
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  const reservation = await commands.acquireGameStatusReservation(
    host.room.code,
    "waiting",
    null,
    "host-socket",
  );
  const disconnect = commands.disconnectSocket("host-socket", 60_000);
  rooms.releaseGameStatusReservation(reservation);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(markCalls, 1);
  assert.equal(coordinator.isFenced(host.room.code), true);
  assert.equal(await commands.reconcileDeferredRoomMutations(host.room.code), true);
  const result = await disconnect;
  assert.equal(result?.disconnectGeneration, "1");
  assert.equal(markCalls, 2);
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "2");
  assert.equal(coordinator.isFenced(host.room.code), false);
});

test("reconciliation completes an uncertain deferred last-player timeout exactly once", async () => {
  const rooms = roomService(["TMOE"]);
  const coordinator = new RoomPersistenceCoordinator();
  let deadline: Date | undefined;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async markDisconnected(input) {
        deadline = input.reconnectDeadlineAt;
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "1",
          reconnectDeadlineAt: input.reconnectDeadlineAt,
          lifecycleStatus: "active",
          currentGameId: null,
          version: (BigInt(input.expectedVersion!) + 1n).toString(),
        };
      },
      async removeDisconnectedPlayer() {
        throw new Error("timeout commit outcome is uncertain");
      },
      async readDeferredRoomMutationState() {
        return { room: null };
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  await commands.disconnectSocket("host-socket", 60_000);
  assert.ok(deadline);
  const reservation = await commands.acquireGameStatusReservation(
    host.room.code,
    "waiting",
    null,
  );
  const timeout = commands.removeDisconnectedPlayer(
    host.room.code,
    host.playerId,
    "1",
    deadline,
    new Date(deadline.getTime() + 1),
  );
  rooms.releaseGameStatusReservation(reservation);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(coordinator.isFenced(host.room.code), true);
  assert.equal(await commands.reconcileDeferredRoomMutations(host.room.code), true);
  const removal = await timeout;
  if (!removal || "retryAt" in removal) {
    assert.fail("Expected timeout reconciliation to return a player removal.");
  }
  assert.equal(removal.deleted, true);
  assert.equal(rooms.getPublicRoom(host.room.code), undefined);
  assert.equal(coordinator.getMetadata(host.room.code), undefined);
  assert.equal(coordinator.isFenced(host.room.code), false);
});

test("failed timeout persistence retains the operation and fences the room", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  let deadline: Date | undefined;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async markDisconnected(input) {
        deadline = input.reconnectDeadlineAt;
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "1",
          reconnectDeadlineAt: input.reconnectDeadlineAt,
          lifecycleStatus: "active" as const,
          currentGameId: null,
          version: "2",
        };
      },
      async removeDisconnectedPlayer() {
        throw new Error("database write failed");
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  await commands.disconnectSocket("host-socket", 60_000);
  assert.ok(deadline);

  const pendingTimeout = commands.removeDisconnectedPlayer(
    host.room.code,
    host.playerId,
    "1",
    deadline,
    new Date(deadline.getTime() + 1),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rooms.hasBlockedDeferredRoomMutations(host.room.code), true);
  assert.equal(rooms.getPublicRoom(host.room.code)?.players.length, 1);
  assert.equal(
    rooms.getPublicRoom(host.room.code)?.players[0]?.connectionStatus,
    "disconnected",
  );
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "2");
  assert.equal(coordinator.isFenced(host.room.code), true);
  rooms.rejectBlockedDeferredRoomMutations(new Error("test shutdown"));
  await assert.rejects(pendingTimeout, /test shutdown/);
});

test("failed durable disconnect does not mutate memory and fences the room", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async markDisconnected() {
        throw new RoomConnectionError("ROOM_NOT_FOUND", "Missing.");
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");

  await assert.rejects(
    commands.disconnectSocket("host-socket", 60_000),
    (error: unknown) => error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.equal(rooms.getPublicRoom(host.room.code)?.players[0]?.connectionStatus, "connected");
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "1");
  assert.equal(coordinator.isFenced(host.room.code), true);
});

test("a stale reconnect-timeout callback does not remove a reconnected player", async () => {
  const rooms = roomService(["ABCD"]);
  const coordinator = new RoomPersistenceCoordinator();
  let deadline: Date | undefined;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input) {
        return createdInfo(input);
      },
      joinRoom: unusedJoin,
      async markDisconnected(input) {
        deadline = input.reconnectDeadlineAt;
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "1",
          reconnectDeadlineAt: input.reconnectDeadlineAt,
          lifecycleStatus: "active" as const,
          currentGameId: null,
          version: "2",
        };
      },
      async reconnectPlayer(input) {
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "2",
          lifecycleStatus: "active" as const,
          currentGameId: null,
          version: "3",
        };
      },
      async removeDisconnectedPlayer() {
        return {
          status: "stale" as const,
          roomCode: "ABCD" as RoomCode,
          playerId: "unused" as PlayerId,
          reason: "generation_mismatch" as const,
        };
      },
    },
    coordinator,
  );
  const host = await commands.createRoom(CREATE_PAYLOAD, "host-socket");
  await commands.disconnectSocket("host-socket", 60_000);
  assert.ok(deadline);
  await commands.reconnect(
    {
      roomCode: host.room.code,
      playerId: host.playerId,
      reconnectToken: host.reconnectToken,
    },
    "reconnected-host",
  );

  const removed = await commands.removeDisconnectedPlayer(
    host.room.code,
    host.playerId,
    "1",
    deadline,
    new Date(deadline.getTime() + 1),
  );
  assert.equal(removed, undefined);
  assert.equal(rooms.getPublicRoom(host.room.code)?.players.length, 1);
  assert.equal(coordinator.getMetadata(host.room.code)?.version, "3");
});
