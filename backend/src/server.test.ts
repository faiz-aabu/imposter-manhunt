import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  CLOCK_EVENTS,
  CONNECTION_EVENTS,
  ERROR_EVENTS,
  GAME_EVENTS,
  IMPOSTOR_EVENTS,
  MANHUNT_EVENTS,
  ROOM_EVENTS,
  WORD_IMPOSTOR_EVENTS,
} from "@impostor/api";
import type {
  CreateRoomResponse,
  CatchConfirmedPayload,
  CatchConfirmationRequestPayload,
  ClockSyncResponsePayload,
  CountdownPayload,
  CountdownSyncResponsePayload,
  GameStateUpdatePayload,
  GameStartedPayload,
  GameSessionId,
  JoinRoomResponse,
  ManhuntFreezeWarningPayload,
  ManhuntBoundaryUpdatePayload,
  ManhuntCountdownCancelledPayload,
  ManhuntLocationAcknowledgementPayload,
  ManhuntSettingsUpdatePayload,
  LocationFlashPayload,
  ManhuntMissionAssignmentPayload,
  ManhuntFootstepsStatePayload,
  ManhuntSmokeBombStatePayload,
  ManhuntGhostStatePayload,
  ManhuntFreezeDecoyStatePayload,
  ManhuntFreezeDecoyUsageStatePayload,
  ManhuntLateGameClueStatePayload,
  ManhuntLateGameWarningStatePayload,
  ManhuntTeamAssignmentPayload,
  ImpostorRoleAssignmentPayload,
  PlayerJoinedPayload,
  PlayerId,
  PlayerLeftPayload,
  PlayerFrozenPayload,
  PlayerReconnectedPayload,
  RoomUpdatePayload,
  RoomCode,
  RoomSettings,
  ValidationErrorPayload,
  WordImpostorRoleAssignmentPayload,
} from "@impostor/api";
import { io as createSocketClient } from "socket.io-client";
import type { Socket } from "socket.io-client";
import type { Pool, PoolConfig } from "pg";
import { createBackendServer } from "./server.js";
import { createDurableBackendServer } from "./server.js";
import type { BackendServer } from "./server.js";
import type { GameRuntime, GameTimer } from "./games/imposter/classic-game-service.js";
import { loadConfig } from "./config/env.js";
import type { BackendConfig } from "./config/env.js";
import type { SocketAcknowledgement } from "./sockets/socket-types.js";
import { RoomPersistenceCoordinator } from "./rooms/room-persistence-coordinator.js";
import { RoomPersistenceCommands } from "./rooms/room-persistence-commands.js";
import type {
  CreatedRoomInfo,
  CreateRoomWithHostInput,
  RecoverableWaitingRoom,
  LeftRoomInfo,
  JoinedRoomInfo,
  JoinRoomInput,
  TransitionRoomGameStatusInput,
  TransitionedRoomGameStatusInfo,
} from "./rooms/postgres-room-repository.js";
import { RoomService } from "./rooms/room-service.js";
import { PostgresRoomRepository } from "./rooms/postgres-room-repository.js";
import { attachRoomSocketHandlers } from "./sockets/room-handlers.js";
import type {
  PrepareForRuntimeRecoveryInput,
  RuntimeRecoverySummary,
} from "./rooms/postgres-room-repository.js";
import type { DurableRoomRuntimeDependencies } from "./rooms/durable-room-runtime.js";
import { RoomRuntimeLeaseLostError } from "./db/postgres.js";
import type { RoomRuntimeLease } from "./db/postgres.js";
import type { GameSocketServer } from "./sockets/socket-types.js";

type TestClient = Socket;

const TEST_CONFIG: BackendConfig = {
  port: 0,
  allowedOrigins: ["*"],
  reconnectGracePeriodMs: 5_000,
  nodeEnv: "test",
  clientIpMode: "socket",
  trustProxyHops: 0,
  requireHttps: false,
  guestProfiles: null,
  lateGameExposureDurations: null,
};

const TEST_ONLY_FREEZE_RANGE_METERS = 50;
const TEST_RUNTIME_POOL_CONFIG: PoolConfig = {
  host: "127.0.0.1",
  port: 55432,
  database: "unused_server_runtime_test",
  user: "unused_server_runtime_test",
};

class ServerTestRepository extends PostgresRoomRepository {
  override async expireDueWaitingRooms(_limit?: number): Promise<number> {
    return 0;
  }

  override async prepareForRuntimeRecovery(
    _input: PrepareForRuntimeRecoveryInput,
  ): Promise<RuntimeRecoverySummary> {
    return {
      waitingRoomsPreserved: 0,
      connectedMembershipsMarkedDisconnected: 0,
      alreadyOverdueMembershipsRemoved: 0,
      legacyDisconnectedMembershipsRemoved: 0,
      nonWaitingRoomsClosed: 0,
      emptyWaitingRoomsDeleted: 0,
      closedRooms: [],
      deletedRooms: [],
    };
  }

  override async loadRecoverableWaitingRooms() {
    return [];
  }
}

function createServerTestRuntimeDependencies(
  commands: RoomPersistenceCommands,
  overrides: Partial<DurableRoomRuntimeDependencies> = {},
): Partial<DurableRoomRuntimeDependencies> {
  const pool = {
    async end() {},
  } as unknown as Pool;
  const lease: RoomRuntimeLease = {
    fencingEpoch: "1",
    async checkOwnership() {},
    onLost() {
      return () => {};
    },
    async release() {},
  };
  return {
    createPool: () => pool,
    createRepository: (createdPool) =>
      new ServerTestRepository(createdPool),
    acquireLease: async () => lease,
    createCommands: () => commands,
    closePool: async () => {},
    scheduleHealthChecks: () => () => {},
    scheduleReconciliationRetry: () => () => {},
    scheduleExpirationCleanup: () => () => {},
    ...overrides,
  };
}

class DeferredGameRuntime implements GameRuntime {
  private currentTime = Date.now();
  private readonly timers: Array<{
    dueAt: number;
    callback: () => void;
    cancelled: boolean;
  }> = [];
  callbacksRun = 0;

  now(): Date {
    return new Date(this.currentTime);
  }

  schedule(callback: () => void, delayMs: number): GameTimer {
    const timer = {
      dueAt: this.currentTime + delayMs,
      callback,
      cancelled: false,
    };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  setTime(timestamp: number): void {
    this.currentTime = timestamp;
  }

  runNextCallback(): void {
    const timer = this.timers
      .filter((scheduled) => !scheduled.cancelled)
      .sort((first, second) => first.dueAt - second.dueAt)[0];
    assert.ok(timer);
    timer.cancelled = true;
    this.currentTime = Math.max(this.currentTime, timer.dueAt);
    this.callbacksRun += 1;
    timer.callback();
  }
}

async function createTestServer(
  testContext: TestContext,
  configOverrides: Partial<BackendConfig> = {},
  dependencies: {
    roomService?: RoomService;
    roomPersistenceCommands?: RoomPersistenceCommands;
    runtimeDependencies?: Partial<DurableRoomRuntimeDependencies>;
  } = {},
): Promise<{ server: BackendServer; url: string }> {
  const config = { ...TEST_CONFIG, ...configOverrides };
  const server = dependencies.roomPersistenceCommands
    ? await createDurableBackendServer(config, {
        poolConfig: TEST_RUNTIME_POOL_CONFIG,
        roomService: dependencies.roomService,
        runtimeDependencies: {
          ...createServerTestRuntimeDependencies(
            dependencies.roomPersistenceCommands,
          ),
          ...dependencies.runtimeDependencies,
        },
      })
    : createBackendServer(
        config,
        dependencies.roomService,
        undefined,
      );
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Test HTTP server did not bind to a TCP port.");
  }

  const clients: TestClient[] = [];
  testContext.after(async () => {
    for (const client of clients) {
      client.disconnect();
    }
    await server.close();
  });

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

test("production config supplies approved late-game durations to ManhuntGameService", async (t) => {
  const configuredDurations = loadConfig({}).lateGameExposureDurations;
  assert.deepEqual(configuredDurations, {
    clueDurationSeconds: 15,
    warningDurationSeconds: 5,
  });
  const { server } = await createTestServer(t, {
    lateGameExposureDurations: configuredDurations,
  });
  assert.deepEqual(
    Reflect.get(server.manhuntGameService, "lateGameExposureDurations"),
    configuredDurations,
  );
});

async function connectClient(
  url: string,
  clients: TestClient[],
  extraHeaders?: Record<string, string>,
  transports: ("polling" | "websocket")[] = ["websocket"],
): Promise<TestClient> {
  const client = createSocketClient(url, {
    autoConnect: false,
    reconnection: false,
    timeout: 3_000,
    transports,
    extraHeaders,
  });
  clients.push(client);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error("Socket.IO client connection timed out."));
    }, 5_000);
    client.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.connect();
  });

  return client;
}

function emitWithAck<T>(
  client: TestClient,
  eventName: string,
  payload: unknown,
): Promise<SocketAcknowledgement<T>> {
  return new Promise((resolve, reject) => {
    client.timeout(3_000).emit(
      eventName,
      payload,
      (error: Error | null, response: SocketAcknowledgement<T>) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(response);
      },
    );
  });
}

function waitForEvent<T>(client: TestClient, eventName: string): Promise<T> {
  return new Promise((resolve) => {
    client.once(eventName, (payload: T) => resolve(payload));
  });
}

function waitForEventWhere<T>(
  client: TestClient,
  eventName: string,
  predicate: (payload: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      client.off(eventName, handler);
      resolve(payload);
    };
    client.on(eventName, handler);
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

async function assertNoEventDuring<T>(
  client: TestClient,
  eventName: string,
  action: () => Promise<T>,
): Promise<T> {
  let received = false;
  const handler = () => {
    received = true;
  };
  client.on(eventName, handler);
  try {
    const result = await action();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(received, false);
    return result;
  } finally {
    client.off(eventName, handler);
  }
}

test("normal server keeps room creation in memory without durable commands", async (t) => {
  const { server, url } = await createTestServer(t);
  const clients: TestClient[] = [];
  const host = await connectClient(url, clients);
  const created = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Memory Host" },
  );

  assert.equal(created.ok, true);
  if (!created.ok) return;
  const room = server.roomService.getPublicRoom(created.data.room.code);
  assert.equal(room?.hostId, created.data.playerId);
  assert.equal(room?.players.length, 1);
});

test("durable server is returned only after lease and waiting-room recovery", async (t) => {
  const events: string[] = [];
  const rooms = new RoomService();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost() {
        throw new Error("Unexpected room creation.");
      },
      async joinRoom() {
        throw new Error("Unexpected room join.");
      },
    },
    new RoomPersistenceCoordinator(),
  );
  const pool = { async end() {} } as unknown as Pool;
  const recoveryStarted = deferred<void>();
  const finishRecovery = deferred<void>();
  class DelayedRecoveryRepository extends ServerTestRepository {
    override async expireDueWaitingRooms(): Promise<number> {
      events.push("expired-room-cleanup");
      return 0;
    }

    override async prepareForRuntimeRecovery(): Promise<RuntimeRecoverySummary> {
      events.push("prepare-recovery");
      return super.prepareForRuntimeRecovery({
        now: new Date("2026-01-01T00:00:00.000Z"),
        reconnectGracePeriodMs: 5_000,
      });
    }

    override async loadRecoverableWaitingRooms() {
      events.push("recovery-started");
      recoveryStarted.resolve(undefined);
      await finishRecovery.promise;
      events.push("recovery-completed");
      return [];
    }
  }
  const lease: RoomRuntimeLease = {
    fencingEpoch: "1",
    async checkOwnership() {
      events.push("lease-check");
    },
    onLost() {
      return () => {};
    },
    async release() {
      events.push("lease-release");
    },
  };
  let factoryResolved = false;
  const serverPromise = createDurableBackendServer(TEST_CONFIG, {
    poolConfig: TEST_RUNTIME_POOL_CONFIG,
    roomService: rooms,
    runtimeDependencies: createServerTestRuntimeDependencies(commands, {
      createPool: () => {
        events.push("pool-create");
        return pool;
      },
      createRepository: () => new DelayedRecoveryRepository(pool),
      acquireLease: async () => {
        events.push("lease-acquire");
        return lease;
      },
      closePool: async () => {
        events.push("pool-close");
      },
      scheduleExpirationCleanup: () => {
        events.push("expiration-scheduling-started");
        return () => events.push("expiration-scheduling-stopped");
      },
    }),
  }).then((server) => {
    factoryResolved = true;
    return server;
  });

  await recoveryStarted.promise;
  assert.equal(factoryResolved, false);
  assert.ok(events.indexOf("lease-acquire") < events.indexOf("recovery-started"));
  assert.ok(events.includes("expired-room-cleanup"));
  assert.equal(events.includes("expiration-scheduling-started"), false);
  finishRecovery.resolve(undefined);
  const server = await serverPromise;
  t.after(() => server.close());
  assert.ok(
    events.indexOf("recovery-completed")
      < events.indexOf("expiration-scheduling-started"),
  );
  assert.equal(server.getReadiness().acceptingTraffic, false);
  assert.equal(server.getReadiness().databaseLeaseOwned, true);
  assert.equal(server.getReadiness().waitingRoomRecoveryCompleted, true);

  const address = await server.listen();
  const readyResponse = await fetch(`http://127.0.0.1:${address.port}/ready`);
  assert.equal(readyResponse.status, 200);
  const readiness: unknown = await readyResponse.json();
  assert.equal(
    typeof readiness === "object"
      && readiness !== null
      && "durableRuntimeReadiness" in readiness
      && readiness.durableRuntimeReadiness === "serving_ready",
    true,
  );
  assert.equal(
    typeof readiness === "object"
      && readiness !== null
      && "unresolved" in readiness
      && typeof readiness.unresolved === "object"
      && readiness.unresolved !== null
      && !("roomCode" in readiness.unresolved)
      && !("playerId" in readiness.unresolved),
    true,
  );
  await server.close();
  assert.ok(
    events.indexOf("lease-release") < events.indexOf("pool-close"),
  );
  assert.ok(events.includes("expiration-scheduling-stopped"));
});

test("durable startup failure rejects and cleans its partially initialized resources", async () => {
  const events: string[] = [];
  const pool = { async end() {} } as unknown as Pool;
  const leaseFailure = new Error("test lease acquisition failure");
  await assert.rejects(
    createDurableBackendServer(TEST_CONFIG, {
      poolConfig: TEST_RUNTIME_POOL_CONFIG,
      runtimeDependencies: {
        createPool: () => {
          events.push("pool-create");
          return pool;
        },
        closePool: async () => {
          events.push("pool-close");
        },
        acquireLease: async () => {
          events.push("lease-acquire");
          throw leaseFailure;
        },
      },
    }),
    (error: unknown) => error === leaseFailure,
  );
  assert.deepEqual(events, ["pool-create", "lease-acquire", "pool-close"]);

  events.length = 0;
  const lease: RoomRuntimeLease = {
    fencingEpoch: "2",
    async checkOwnership() {},
    onLost() {
      return () => {};
    },
    async release() {
      events.push("lease-release");
    },
  };
  class FailedRecoveryRepository extends ServerTestRepository {
    override async prepareForRuntimeRecovery(): Promise<RuntimeRecoverySummary> {
      events.push("recovery-failed");
      throw new Error("test room recovery failure");
    }
  }
  await assert.rejects(
    createDurableBackendServer(TEST_CONFIG, {
      poolConfig: TEST_RUNTIME_POOL_CONFIG,
      runtimeDependencies: {
        createPool: () => {
          events.push("pool-create");
          return pool;
        },
        createRepository: () => new FailedRecoveryRepository(pool),
        acquireLease: async () => {
          events.push("lease-acquire");
          return lease;
        },
        closePool: async () => {
          events.push("pool-close");
        },
      },
    }),
    /test room recovery failure/,
  );
  assert.ok(events.indexOf("recovery-failed") < events.indexOf("lease-release"));
  assert.ok(events.indexOf("lease-release") < events.indexOf("pool-close"));
});

test("lease loss makes the durable server unready and disconnects gameplay clients", async (t) => {
  const clients: TestClient[] = [];
  const rooms = new RoomService();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost() {
        throw new Error("Unexpected room creation.");
      },
      async joinRoom() {
        throw new Error("Unexpected room join.");
      },
    },
    new RoomPersistenceCoordinator(),
  );
  let notifyLeaseLost:
    | Parameters<RoomRuntimeLease["onLost"]>[0]
    | undefined;
  const lease: RoomRuntimeLease = {
    fencingEpoch: "4",
    async checkOwnership() {},
    onLost(listener) {
      notifyLeaseLost = listener;
      return () => {
        notifyLeaseLost = undefined;
      };
    },
    async release() {},
  };
  const server = await createDurableBackendServer(TEST_CONFIG, {
    poolConfig: TEST_RUNTIME_POOL_CONFIG,
    runtimeDependencies: createServerTestRuntimeDependencies(commands, {
      acquireLease: async () => lease,
    }),
  });
  t.after(() => server.close());
  const address = await server.listen();
  const client = await connectClient(
    `http://127.0.0.1:${address.port}`,
    clients,
  );
  const disconnected = new Promise<void>((resolve) => {
    client.once("disconnect", () => resolve());
  });

  assert.equal((await fetch(`http://127.0.0.1:${address.port}/ready`)).status, 200);
  assert.ok(notifyLeaseLost);
  notifyLeaseLost?.(new RoomRuntimeLeaseLostError("test lease loss"));
  await disconnected;
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/ready`)).status, 503);
  assert.equal(client.connected, false);
});

test("socket handlers reject unguarded persistence commands", () => {
  const rooms = new RoomService();
  const unguardedCommands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost() {
        throw new Error("Unexpected room creation.");
      },
      async joinRoom() {
        throw new Error("Unexpected room join.");
      },
    },
    new RoomPersistenceCoordinator(),
  );
  assert.throws(
    () =>
      attachRoomSocketHandlers(
        {} as GameSocketServer,
        rooms,
        {} as never,
        {} as never,
        {} as never,
        {
          reconnectGracePeriodMs: TEST_CONFIG.reconnectGracePeriodMs,
          nodeEnv: TEST_CONFIG.nodeEnv,
          clientIpMode: TEST_CONFIG.clientIpMode,
          trustProxyHops: TEST_CONFIG.trustProxyHops,
          roomPersistenceCommands: unguardedCommands,
        },
      ),
    /runtime-gated durable room commands/,
  );
});

test("durable shutdown is shared, stops admission, drains writes, then releases the lease", async (t) => {
  const clients: TestClient[] = [];
  const events: string[] = [];
  const rooms = new RoomService(() => "DCLS" as RoomCode);
  const coordinator = new RoomPersistenceCoordinator();
  const writeStarted = deferred<void>();
  const finishWrite = deferred<void>();
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input: CreateRoomWithHostInput): Promise<CreatedRoomInfo> {
        events.push("database-write-start");
        writeStarted.resolve(undefined);
        await finishWrite.promise;
        events.push("database-write-finish");
        return {
          roomId: input.roomId,
          roomCode: input.roomCode,
          gameMode: input.gameMode,
          hostPlayerId: input.hostPlayerId,
          lifecycleStatus: "active",
          currentGameId: null,
          version: "1",
        };
      },
      async joinRoom() {
        throw new Error("Unexpected room join.");
      },
    },
    coordinator,
  );
  const pool = { async end() {} } as unknown as Pool;
  const lease: RoomRuntimeLease = {
    fencingEpoch: "3",
    async checkOwnership() {},
    onLost() {
      return () => {};
    },
    async release() {
      events.push("lease-release");
    },
  };
  const server = await createDurableBackendServer(TEST_CONFIG, {
    poolConfig: TEST_RUNTIME_POOL_CONFIG,
    roomService: rooms,
    runtimeDependencies: createServerTestRuntimeDependencies(commands, {
      createPool: () => pool,
      acquireLease: async () => lease,
      closePool: async () => {
        events.push("pool-close");
      },
      scheduleExpirationCleanup: () => () => events.push("expiration-cancel"),
    }),
  });
  t.after(() => server.close());
  const address = await server.listen();
  const client = await connectClient(`http://127.0.0.1:${address.port}`, clients);
  client.emit(ROOM_EVENTS.CREATE, { nickname: "Shutdown Host" });
  t.after(() => {
    for (const connectedClient of clients) {
      connectedClient.disconnect();
    }
  });
  await writeStarted.promise;

  const firstClose = server.close();
  const secondClose = server.close();
  assert.strictEqual(firstClose, secondClose);
  let closeFinished = false;
  void firstClose.then(() => {
    closeFinished = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closeFinished, false);
  finishWrite.resolve(undefined);
  await firstClose;
  assert.ok(events.indexOf("database-write-finish") < events.indexOf("lease-release"));
  assert.ok(events.indexOf("lease-release") < events.indexOf("pool-close"));
  assert.ok(events.includes("expiration-cancel"));
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}/health`));
});

test("socket handlers use explicitly injected durable create and join commands", async (t) => {
  const rooms = new RoomService(() => "DURB" as RoomCode);
  const coordinator = new RoomPersistenceCoordinator();
  let createCommits = 0;
  let joinCommits = 0;
  let settingsCommits = 0;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input: CreateRoomWithHostInput): Promise<CreatedRoomInfo> {
        createCommits += 1;
        return {
          roomId: input.roomId,
          roomCode: input.roomCode,
          gameMode: input.gameMode,
          hostPlayerId: input.hostPlayerId,
          lifecycleStatus: "active",
          currentGameId: null,
          version: "1",
        };
      },
      async joinRoom(input: JoinRoomInput): Promise<JoinedRoomInfo> {
        joinCommits += 1;
        assert.ok(input.expectedRoomId);
        return {
          roomId: input.expectedRoomId,
          roomCode: input.roomCode,
          gameMode: "impostor-classic",
          playerId: input.playerId,
          lifecycleStatus: "active",
          currentGameId: null,
          version: "2",
        };
      },
      async updateWaitingRoomSettings(input) {
        settingsCommits += 1;
        assert.ok(input.expectedRoomId);
        assert.equal(input.expectedVersion, "2");
        return {
          roomId: input.expectedRoomId,
          roomCode: input.roomCode,
          gameMode: input.settings.gameMode,
          lifecycleStatus: "active",
          currentGameId: null,
          version: "3",
        };
      },
    },
    coordinator,
  );
  const { url } = await createTestServer(t, {}, {
    roomService: rooms,
    roomPersistenceCommands: commands,
  });
  const clients: TestClient[] = [];
  const host = await connectClient(url, clients);
  const created = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Durable Host" },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const guest = await connectClient(url, clients);
  const joined = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    { roomCode: created.data.room.code, nickname: "Durable Guest" },
  );
  assert.equal(joined.ok, true);
  assert.equal(createCommits, 1);
  assert.equal(joinCommits, 1);
  const updatedSettings = await emitWithAck<RoomUpdatePayload>(
    host,
    ROOM_EVENTS.UPDATE_SETTINGS,
    {
      roomCode: created.data.room.code,
      settings: {
        gameMode: "impostor-classic",
        maxPlayers: 8,
        isPrivate: true,
        classicImpostor: {
          impostorCount: 2,
          discussionDurationSeconds: 180,
          votingDurationSeconds: 60,
        },
      },
    },
  );
  assert.equal(updatedSettings.ok, true);
  assert.equal(settingsCommits, 1);
  if (updatedSettings.ok) {
    assert.equal(updatedSettings.data.room.settings.isPrivate, true);
    assert.equal(
      updatedSettings.data.room.settings.classicImpostor?.impostorCount,
      2,
    );
  }
  assert.equal(
    coordinator.getMetadata(created.data.room.code)?.version,
    "3",
  );
});

test("durable game start persists before committing memory or emitting start events", async (t) => {
  const rooms = new RoomService(() => "STRT" as RoomCode);
  const coordinator = new RoomPersistenceCoordinator();
  const transitionEntered = deferred<void>();
  const finishTransition = deferred<TransitionedRoomGameStatusInfo>();
  let transitionInput: TransitionRoomGameStatusInput | undefined;
  let markDisconnectedCalls = 0;
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input: CreateRoomWithHostInput): Promise<CreatedRoomInfo> {
        return {
          roomId: input.roomId,
          roomCode: input.roomCode,
          gameMode: input.gameMode,
          hostPlayerId: input.hostPlayerId,
          lifecycleStatus: "active",
          currentGameId: null,
          version: "1",
        };
      },
      async joinRoom(input: JoinRoomInput): Promise<JoinedRoomInfo> {
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          gameMode: "impostor-classic",
          playerId: input.playerId,
          lifecycleStatus: "active",
          currentGameId: null,
          version: (BigInt(input.expectedVersion!) + 1n).toString(),
        };
      },
      async transitionRoomGameStatus(input) {
        transitionInput = input;
        transitionEntered.resolve();
        return finishTransition.promise;
      },
      async markDisconnected(input) {
        markDisconnectedCalls += 1;
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "1",
          reconnectDeadlineAt: input.reconnectDeadlineAt,
          lifecycleStatus: "active" as const,
          gameStatus: "starting" as const,
          currentGameId: transitionInput?.nextGameId ?? null,
          version: (BigInt(input.expectedVersion!) + 1n).toString(),
        };
      },
    },
    coordinator,
  );
  const { url, server } = await createTestServer(t, {}, {
    roomService: rooms,
    roomPersistenceCommands: commands,
  });
  const clients: TestClient[] = [];
  const host = await connectClient(url, clients);
  let disconnectingGuest: TestClient | undefined;
  const created = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Durable Start Host" },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;

  for (const nickname of ["Start Guest One", "Start Guest Two"]) {
    const guest = await connectClient(url, clients);
    disconnectingGuest ??= guest;
    const joined: SocketAcknowledgement<JoinRoomResponse> = await emitWithAck<JoinRoomResponse>(
      guest,
      ROOM_EVENTS.JOIN,
      { roomCode: created.data.room.code, nickname },
    );
    assert.equal(joined.ok, true);
  }

  await new Promise((resolve) => setTimeout(resolve, 30));
  const emitted: string[] = [];
  host.on(GAME_EVENTS.GAME_STARTED, () => emitted.push("game-started"));
  host.on(ROOM_EVENTS.UPDATE, () => emitted.push("room-updated"));
  const startAcknowledgement = emitWithAck<void>(
    host,
    GAME_EVENTS.START_GAME,
    { roomCode: created.data.room.code },
  );

  await transitionEntered.promise;
  assert.equal(transitionInput?.expectedStatus, "waiting");
  assert.equal(transitionInput?.nextStatus, "starting");
  assert.equal(transitionInput?.expectedVersion, "3");
  assert.equal(transitionInput?.initiatedBy.kind, "host");
  assert.equal(
    server.roomService.getPublicRoom(created.data.room.code)?.gameStatus,
    "waiting",
  );
  assert.equal(Reflect.get(server.classicImpostorService, "currentGames").size, 0);
  assert.ok(disconnectingGuest);
  const disconnectedUpdate = waitForEventWhere<RoomUpdatePayload>(
    host,
    ROOM_EVENTS.UPDATE,
    (payload) =>
      payload.room.code === created.data.room.code
      && payload.room.players.some(
        (player) =>
          player.connectionStatus === "disconnected"
          && player.nickname === "Start Guest One",
      ),
  );
  disconnectingGuest.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(markDisconnectedCalls, 0);
  assert.equal(
    server.roomService.getPublicRoom(created.data.room.code)?.players.find(
      (player) => player.nickname === "Start Guest One",
    )?.connectionStatus,
    "connected",
  );
  await assertNoEventDuring(host, GAME_EVENTS.GAME_STARTED, async () => undefined);
  assert.deepEqual(emitted, []);

  assert.ok(transitionInput);
  const started = waitForEvent<GameStartedPayload>(
    host,
    GAME_EVENTS.GAME_STARTED,
  );
  finishTransition.resolve({
    roomId: transitionInput.expectedRoomId,
    roomCode: transitionInput.roomCode,
    gameMode: "impostor-classic",
    gameStatus: transitionInput.nextStatus,
    lifecycleStatus: "active",
    currentGameId: transitionInput.nextGameId,
    version: "4",
  });

  const acknowledgement = await startAcknowledgement;
  assert.equal(acknowledgement.ok, true);
  await started;
  assert.deepEqual(emitted.slice(0, 2), ["room-updated", "game-started"]);
  assert.equal(
    server.roomService.getPublicRoom(created.data.room.code)?.gameStatus,
    "starting",
  );
  await disconnectedUpdate;
  assert.deepEqual(emitted, [
    "room-updated",
    "game-started",
    "room-updated",
  ]);
  assert.equal(markDisconnectedCalls, 1);
  assert.equal(coordinator.getMetadata(created.data.room.code)?.version, "5");
  assert.equal(
    server.roomService.getPublicRoom(created.data.room.code)?.players.find(
      (player) => player.nickname === "Start Guest One",
    )?.connectionStatus,
    "disconnected",
  );
});

test("rejected durable game start leaves no committed game state or start events", async (t) => {
  const rooms = new RoomService(() => "FAIL" as RoomCode);
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input: CreateRoomWithHostInput): Promise<CreatedRoomInfo> {
        return {
          roomId: input.roomId,
          roomCode: input.roomCode,
          gameMode: input.gameMode,
          hostPlayerId: input.hostPlayerId,
          lifecycleStatus: "active",
          currentGameId: null,
          version: "1",
        };
      },
      async joinRoom(input: JoinRoomInput): Promise<JoinedRoomInfo> {
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          gameMode: "impostor-classic",
          playerId: input.playerId,
          lifecycleStatus: "active",
          currentGameId: null,
          version: (BigInt(input.expectedVersion!) + 1n).toString(),
        };
      },
      async transitionRoomGameStatus() {
        throw new Error("injected durable transition failure");
      },
    },
    new RoomPersistenceCoordinator(),
  );
  const { url, server } = await createTestServer(t, {}, {
    roomService: rooms,
    roomPersistenceCommands: commands,
  });
  const clients: TestClient[] = [];
  const host = await connectClient(url, clients);
  const created = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Failed Start Host" },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;

  for (const nickname of ["Failed Guest One", "Failed Guest Two"]) {
    const guest = await connectClient(url, clients);
    const joined: SocketAcknowledgement<JoinRoomResponse> = await emitWithAck<JoinRoomResponse>(
      guest,
      ROOM_EVENTS.JOIN,
      { roomCode: created.data.room.code, nickname },
    );
    assert.equal(joined.ok, true);
  }

  await new Promise((resolve) => setTimeout(resolve, 30));
  const publishedEvents: string[] = [];
  host.on(GAME_EVENTS.GAME_STARTED, () => publishedEvents.push("game-started"));
  host.on(ROOM_EVENTS.UPDATE, () => publishedEvents.push("room-updated"));
  const acknowledgement = await emitWithAck<void>(
    host,
    GAME_EVENTS.START_GAME,
    { roomCode: created.data.room.code },
  );

  assert.equal(acknowledgement.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(publishedEvents, []);
  assert.equal(
    server.roomService.getPublicRoom(created.data.room.code)?.gameStatus,
    "waiting",
  );
  assert.equal(Reflect.get(server.classicImpostorService, "currentGames").size, 0);
});

test("failed durable Manhunt settings writes do not publish or mutate settings", async (t) => {
  const rooms = new RoomService(() => "HUNT" as RoomCode);
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input: CreateRoomWithHostInput): Promise<CreatedRoomInfo> {
        return {
          roomId: input.roomId,
          roomCode: input.roomCode,
          gameMode: input.gameMode,
          hostPlayerId: input.hostPlayerId,
          lifecycleStatus: "active",
          currentGameId: null,
          version: "1",
        };
      },
      async joinRoom(_input: JoinRoomInput): Promise<JoinedRoomInfo> {
        throw new Error("Unexpected repository join.");
      },
      async updateWaitingRoomSettings() {
        throw new Error("injected settings persistence failure");
      },
    },
    new RoomPersistenceCoordinator(),
  );
  const { url, server } = await createTestServer(t, {}, {
    roomService: rooms,
    roomPersistenceCommands: commands,
  });
  const clients: TestClient[] = [];
  const host = await connectClient(url, clients);
  const originalBoundary = {
    center: { latitude: 51.5, longitude: -0.1 },
    radiusMeters: 500,
  };
  const created = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Durable Manhunt Host",
      settings: {
        gameMode: "manhunt",
        maxPlayers: 8,
        isPrivate: false,
        manhunt: { hunterCount: 1, boundary: originalBoundary },
      },
    },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const publishedEvents: string[] = [];
  for (const eventName of [
    ROOM_EVENTS.UPDATE,
    MANHUNT_EVENTS.SETTINGS_UPDATE,
    MANHUNT_EVENTS.BOUNDARY_UPDATE,
  ]) {
    host.on(eventName, () => publishedEvents.push(eventName));
  }
  const update = await emitWithAck<RoomUpdatePayload>(
    host,
    MANHUNT_EVENTS.UPDATE_SETTINGS,
    {
      roomCode: created.data.room.code,
      settings: {
        hunterCount: 2,
        boundary: {
          center: { latitude: 51.6, longitude: -0.2 },
          radiusMeters: 650,
        },
      },
    },
  );

  assert.equal(update.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(publishedEvents, []);
  assert.deepEqual(
    rooms.getManhuntBoundary(created.data.room.code),
    originalBoundary,
  );
  assert.equal(
    server.roomService.getPublicRoom(created.data.room.code)?.settings.manhunt?.hunterCount,
    1,
  );
});

test("leave handler waits for Manhunt cancellation before publishing removal", async (t) => {
  const { url, server } = await createTestServer(t);
  const clients: TestClient[] = [];
  const host = await connectClient(url, clients);
  const guest = await connectClient(url, clients);
  const created = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Cancellation Host",
      settings: {
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
      },
    },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const joined = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    { roomCode: created.data.room.code, nickname: "Cancellation Guest" },
  );
  assert.equal(joined.ok, true);
  if (!joined.ok) return;

  const cancellationEntered = deferred<void>();
  const finishCancellation = deferred<void>();
  Reflect.set(
    server.manhuntGameService,
    "onPlayerRemoved",
    async () => {
      cancellationEntered.resolve();
      await finishCancellation.promise;
      throw new Error("injected countdown cancellation failure");
    },
  );
  const playerLeft = waitForEvent<PlayerLeftPayload>(
    host,
    ROOM_EVENTS.PLAYER_LEFT,
  );
  let acknowledgementSettled = false;
  const leaveAcknowledgement = emitWithAck<void>(guest, ROOM_EVENTS.LEAVE, {
    roomCode: created.data.room.code,
  }).then((result) => {
    acknowledgementSettled = true;
    return result;
  });

  await cancellationEntered.promise;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(acknowledgementSettled, false);

  finishCancellation.resolve();
  const [acknowledgement, removalEvent] = await Promise.all([
    leaveAcknowledgement,
    playerLeft,
  ]);
  assert.equal(acknowledgement.ok, true);
  assert.equal(removalEvent.playerId, joined.data.playerId);
});

test("injected durable lifecycle commands persist disconnect, reconnect, and leave before runtime mutation", async (t) => {
  const rooms = new RoomService(() => "LIFE" as RoomCode);
  const coordinator = new RoomPersistenceCoordinator();
  let guestPlayerId: string | undefined;
  let disconnectPersisted!: () => void;
  const disconnectCalled = new Promise<void>((resolve) => {
    disconnectPersisted = resolve;
  });
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost(input: CreateRoomWithHostInput): Promise<CreatedRoomInfo> {
        return {
          roomId: input.roomId,
          roomCode: input.roomCode,
          gameMode: input.gameMode,
          hostPlayerId: input.hostPlayerId,
          lifecycleStatus: "active",
          currentGameId: null,
          version: "1",
        };
      },
      async joinRoom(input: JoinRoomInput): Promise<JoinedRoomInfo> {
        guestPlayerId = input.playerId;
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          gameMode: "impostor-classic",
          playerId: input.playerId,
          lifecycleStatus: "active",
          currentGameId: null,
          version: "2",
        };
      },
      async markDisconnected(input) {
        assert.equal(
          rooms.getPublicRoom(input.roomCode)?.players.find(
            (player) => player.id === input.playerId,
          )?.connectionStatus,
          "connected",
        );
        disconnectPersisted();
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
      async reconnectPlayer(input) {
        assert.equal(
          rooms.getPublicRoom(input.roomCode)?.players.find(
            (player) => player.id === input.playerId,
          )?.connectionStatus,
          "disconnected",
        );
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          disconnectGeneration: "2",
          lifecycleStatus: "active",
          currentGameId: null,
          version: (BigInt(input.expectedVersion!) + 1n).toString(),
        };
      },
      async leaveRoom(input): Promise<LeftRoomInfo> {
        assert.equal(rooms.getPublicRoom(input.roomCode)?.players.length, 2);
        assert.equal(input.expectedVersion, "4");
        return {
          roomId: input.expectedRoomId!,
          roomCode: input.roomCode,
          playerId: input.playerId,
          deleted: false,
          hostChanged: true,
          hostPlayerId: guestPlayerId!,
          lifecycleStatus: "active",
          currentGameId: null,
          version: "5",
        };
      },
    },
    coordinator,
  );
  const { url } = await createTestServer(t, {}, {
    roomService: rooms,
    roomPersistenceCommands: commands,
  });
  const clients: TestClient[] = [];
  const host = await connectClient(url, clients);
  const created = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Durable Host" },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const guest = await connectClient(url, clients);
  const joined = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    { roomCode: created.data.room.code, nickname: "Durable Guest" },
  );
  assert.equal(joined.ok, true);
  if (!joined.ok) return;

  guest.disconnect();
  await disconnectCalled;
  const reconnected = await connectClient(url, clients);
  const reconnectAck = await emitWithAck<PlayerReconnectedPayload>(
    reconnected,
    CONNECTION_EVENTS.RECONNECT,
    {
      roomCode: created.data.room.code,
      playerId: joined.data.playerId,
      reconnectToken: joined.data.reconnectToken,
    },
  );
  assert.equal(reconnectAck.ok, true);

  const left = await emitWithAck<void>(host, ROOM_EVENTS.LEAVE, {
    roomCode: created.data.room.code,
  });
  assert.equal(left.ok, true);
  assert.equal(coordinator.getMetadata(created.data.room.code)?.version, "5");
  assert.ok(reconnected.id);
  rooms.assertHost(created.data.room.code, reconnected.id);
});

test("socket handlers schedule recovered disconnect deadlines through the persisted-removal path", async (t) => {
  const rooms = new RoomService();
  const roomCode = "RCDL" as RoomCode;
  const playerId = "recovered-timeout-player" as PlayerId;
  const reconnectDeadlineAt = new Date(Date.now() + 200);
  const recovered: RecoverableWaitingRoom = {
    roomId: "10000000-0000-4000-8000-000000000001",
    roomCode,
    gameMode: "impostor-classic",
    lifecycleStatus: "active",
    gameStatus: "waiting",
    settings: {
      gameMode: "impostor-classic",
      maxPlayers: 8,
      isPrivate: false,
      classicImpostor: {
        impostorCount: 1,
        discussionDurationSeconds: 60,
        votingDurationSeconds: 30,
      },
    },
    maxPlayers: 8,
    hostPlayerId: playerId,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    expiresAt: null,
    version: "1",
    currentGameId: null,
    members: [{
      playerId,
      nickname: "Recovered",
      membershipStatus: "active",
      connectionStatus: "disconnected",
      joinedAt: new Date("2026-01-01T00:00:00.000Z"),
      disconnectGeneration: "1",
      reconnectDeadlineAt,
      reconnectTokenHash: Buffer.alloc(32),
    }],
    privateManhuntBoundary: null,
  };
  rooms.restoreWaitingRoom(recovered);
  const coordinator = new RoomPersistenceCoordinator();
  coordinator.registerRecoveredRoom({
    roomCode,
    roomId: recovered.roomId,
    version: recovered.version,
    gameStatus: "waiting",
    currentGameId: null,
    lifecycleStatus: "active",
  });
  let removeCalls = 0;
  let resolveRemoval!: () => void;
  const removalCalled = new Promise<void>((resolve) => {
    resolveRemoval = resolve;
  });
  const commands = new RoomPersistenceCommands(
    rooms,
    {
      async createRoomWithHost() {
        throw new Error("Unexpected room creation.");
      },
      async joinRoom() {
        throw new Error("Unexpected room join.");
      },
      async removeDisconnectedPlayer(input) {
        removeCalls += 1;
        resolveRemoval();
        return {
          status: "stale",
          roomCode: input.roomCode,
          playerId: input.playerId,
          reason: "generation_mismatch",
        };
      },
    },
    coordinator,
  );
  await createTestServer(t, {}, {
    roomService: rooms,
    roomPersistenceCommands: commands,
  });

  await removalCalled;
  assert.equal(removeCalls, 1);
});

test("socket timeout post-commit failures suspend Classic, Word, and Manhunt", async (t) => {
  for (const gameMode of [
    "impostor-classic",
    "impostor-word",
    "manhunt",
  ] as const) {
    await t.test(gameMode, async (subtest) => {
      const rooms = new RoomService();
      const coordinator = new RoomPersistenceCoordinator();
      const records = new Map<RoomCode, {
        roomId: string;
        gameMode: RoomSettings["gameMode"];
        version: string;
        gameStatus: "waiting" | "starting" | "in_progress" | "finished";
        currentGameId: GameSessionId | null;
      }>();
      let timeoutRemovals = 0;
      let failedSideEffectTransitions = 0;
      const repository = {
        async createRoomWithHost(input: CreateRoomWithHostInput): Promise<CreatedRoomInfo> {
          records.set(input.roomCode, {
            roomId: input.roomId,
            gameMode: input.gameMode,
            version: "1",
            gameStatus: "waiting",
            currentGameId: null,
          });
          return {
            roomId: input.roomId,
            roomCode: input.roomCode,
            gameMode: input.gameMode,
            hostPlayerId: input.hostPlayerId,
            lifecycleStatus: "active",
            currentGameId: null,
            version: "1",
          };
        },
        async joinRoom(input: JoinRoomInput): Promise<JoinedRoomInfo> {
          const record = records.get(input.roomCode);
          assert.ok(record);
          record.version = (BigInt(record.version) + 1n).toString();
          return {
            roomId: record.roomId,
            roomCode: input.roomCode,
            gameMode: record.gameMode,
            playerId: input.playerId,
            lifecycleStatus: "active",
            currentGameId: record.currentGameId,
            version: record.version,
          };
        },
        async transitionRoomGameStatus(
          input: TransitionRoomGameStatusInput,
        ): Promise<TransitionedRoomGameStatusInfo> {
          const record = records.get(input.roomCode);
          assert.ok(record);
          if (
            gameMode === "manhunt"
              ? input.expectedStatus === "starting" && input.nextStatus === "waiting"
              : input.expectedStatus === "starting" && input.nextStatus === "finished"
          ) {
            failedSideEffectTransitions += 1;
            throw new Error("Injected post-commit gameplay side-effect failure.");
          }
          assert.equal(record.roomId, input.expectedRoomId);
          assert.equal(record.version, input.expectedVersion);
          assert.equal(record.gameStatus, input.expectedStatus);
          assert.equal(record.currentGameId, input.expectedCurrentGameId);
          record.version = (BigInt(record.version) + 1n).toString();
          record.gameStatus = input.nextStatus;
          record.currentGameId = input.nextGameId;
          return {
            roomId: record.roomId,
            roomCode: input.roomCode,
            gameMode: record.gameMode,
            gameStatus: record.gameStatus,
            lifecycleStatus: "active",
            currentGameId: record.currentGameId,
            version: record.version,
          };
        },
        async markDisconnected(input: {
          roomCode: RoomCode;
          playerId: PlayerId;
          reconnectDeadlineAt: Date;
          expectedRoomId?: string;
          expectedVersion?: string;
        }) {
          const record = records.get(input.roomCode);
          assert.ok(record);
          record.version = (BigInt(record.version) + 1n).toString();
          return {
            roomId: record.roomId,
            roomCode: input.roomCode,
            playerId: input.playerId,
            disconnectGeneration: "1",
            reconnectDeadlineAt: input.reconnectDeadlineAt,
            lifecycleStatus: "active" as const,
            currentGameId: record.currentGameId,
            version: record.version,
          };
        },
        async removeDisconnectedPlayer(input: {
          roomCode: RoomCode;
          playerId: PlayerId;
        }) {
          timeoutRemovals += 1;
          const record = records.get(input.roomCode);
          assert.ok(record);
          record.version = (BigInt(record.version) + 1n).toString();
          return {
            status: "removed" as const,
            roomId: record.roomId,
            roomCode: input.roomCode,
            playerId: input.playerId,
            deleted: false as const,
            hostChanged: false,
            lifecycleStatus: "active" as const,
            currentGameId: record.currentGameId,
            version: record.version,
          };
        },
      };
      const commands = new RoomPersistenceCommands(
        rooms,
        repository,
        coordinator,
      );
      const { server, url } = await createTestServer(
        subtest,
        { reconnectGracePeriodMs: 1 },
        { roomService: rooms, roomPersistenceCommands: commands },
      );
      const clients: TestClient[] = [];
      const host = await connectClient(url, clients);
      const settings: RoomSettings = gameMode === "manhunt"
        ? {
          gameMode,
          maxPlayers: 8,
          isPrivate: false,
          manhunt: {
            hunterCount: 1,
            boundary: {
              center: { latitude: 51.5074, longitude: -0.1278 },
              radiusMeters: 500,
            },
          },
        }
        : { gameMode, maxPlayers: 8, isPrivate: false };
      const created = await emitWithAck<CreateRoomResponse>(
        host,
        ROOM_EVENTS.CREATE,
        { nickname: "Suspension Host", settings },
      );
      assert.equal(created.ok, true);
      if (!created.ok) return;

      const guests: TestClient[] = [];
      let playerId: PlayerId | undefined;
      for (let index = 0; index < 3; index += 1) {
        const guest = await connectClient(url, clients);
        const joined: SocketAcknowledgement<JoinRoomResponse> =
          await emitWithAck<JoinRoomResponse>(
          guest,
          ROOM_EVENTS.JOIN,
          {
            roomCode: created.data.room.code,
            nickname: `Suspension Guest ${index}`,
          },
        );
        assert.equal(joined.ok, true);
        if (!joined.ok) return;
        guests.push(guest);
        if (index === 2) {
          playerId = joined.data.playerId;
        }
      }
      if (!playerId) {
        throw new Error("The timeout test requires a removable player.");
      }
      const removedPlayerId: PlayerId = playerId;

      const roomCode = created.data.room.code;
      let playerLeftEvents = 0;
      let startedEvents = 0;
      host.on(ROOM_EVENTS.PLAYER_LEFT, () => {
        playerLeftEvents += 1;
      });
      host.on(GAME_EVENTS.GAME_STARTED, () => {
        startedEvents += 1;
      });

      const service = gameMode === "impostor-classic"
        ? server.classicImpostorService
        : gameMode === "impostor-word"
          ? server.wordImpostorService
          : server.manhuntGameService;
      const gameRuntime = (service as unknown as {
        runtime: GameRuntime;
      }).runtime;
      const scheduledCallbacks: Array<() => void> = [];
      const originalSchedule = gameRuntime.schedule.bind(gameRuntime);
      gameRuntime.schedule = (callback, delayMs) => {
        scheduledCallbacks.push(callback);
        return originalSchedule(callback, delayMs);
      };

      const startedEvent = waitForEvent<GameStartedPayload>(
        host,
        GAME_EVENTS.GAME_STARTED,
      );
      const started = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
        roomCode,
      });
      assert.equal(started.ok, true);
      const game = await startedEvent;
      assert.equal(startedEvents, 1);

      guests[2]!.disconnect();
      const deadline = Date.now() + 3_000;
      while (
        !rooms.isGameplaySuspended(roomCode, game.session.id)
        && Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal(rooms.isGameplaySuspended(roomCode, game.session.id), true);
      assert.equal(timeoutRemovals, 1);
      assert.equal(failedSideEffectTransitions, 1);
      assert.equal(
        server.getReadiness().unresolved.pendingTimeoutSideEffects,
        1,
      );
      assert.equal(
        rooms.getGameplaySuspensions().find(
          (suspension) => suspension.roomCode === roomCode,
        )?.gameId,
        game.session.id,
      );
      assert.equal(rooms.getPublicRoom(roomCode)?.currentGameId, game.session.id);

      if (gameMode === "impostor-classic") {
        assert.throws(
          () => server.classicImpostorService.requestRole(
            roomCode,
            game.session.id,
            created.data.playerId,
          ),
          (error: unknown) =>
            error instanceof Error
            && "code" in error
            && error.code === "GAME_NOT_ACTIVE",
        );
      } else if (gameMode === "impostor-word") {
        assert.throws(
          () => server.wordImpostorService.requestRole(
            roomCode,
            game.session.id,
            created.data.playerId,
          ),
          (error: unknown) =>
            error instanceof Error
            && "code" in error
            && error.code === "GAME_NOT_ACTIVE",
        );
      } else {
        assert.throws(
          () => server.manhuntGameService.recordLocation(
            roomCode,
            created.data.playerId,
            { latitude: 51.5074, longitude: -0.1278 },
          ),
          (error: unknown) =>
            error instanceof Error
            && "code" in error
            && error.code === "GAME_NOT_ACTIVE",
        );
        assert.throws(
          () => server.manhuntGameService.attemptCatch(
            roomCode,
            created.data.playerId,
            removedPlayerId,
          ),
          (error: unknown) =>
            error instanceof Error
            && "code" in error
            && error.code === "GAME_NOT_ACTIVE",
        );
        assert.throws(
          () => server.manhuntGameService.respondToCatch(
            roomCode,
            created.data.playerId,
            "catch-request",
            true,
          ),
          (error: unknown) =>
            error instanceof Error
            && "code" in error
            && error.code === "GAME_NOT_ACTIVE",
        );
        assert.ok(server.manhuntGameService.getCurrentBoundary(roomCode));
      }

      const gameStatusBeforeStaleTimers = rooms.getPublicRoom(roomCode)?.gameStatus;
      for (const callback of scheduledCallbacks) {
        callback();
      }
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(rooms.getPublicRoom(roomCode)?.gameStatus, gameStatusBeforeStaleTimers);
      assert.equal(startedEvents, 1);
      assert.equal(playerLeftEvents, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(timeoutRemovals, 1);
      assert.equal(failedSideEffectTransitions, 1);
    });
  }
});

test("Manhunt boundaries are host-only in setup and Hider-only after team assignment", async (t) => {
  const { server, url } = await createTestServer(t);
  const clients: TestClient[] = [];
  const host = await connectClient(url, clients);
  const guestOne = await connectClient(url, clients);
  const guestTwo = await connectClient(url, clients);
  const outsider = await connectClient(url, clients);
  let outsiderReceivedBoundary = false;
  outsider.on(MANHUNT_EVENTS.BOUNDARY_UPDATE, () => {
    outsiderReceivedBoundary = true;
  });
  const initialBoundary = {
    center: { latitude: 51.5074, longitude: -0.1278 },
    radiusMeters: 500,
  };
  const hostBoundary = waitForEvent<ManhuntBoundaryUpdatePayload>(
    host,
    MANHUNT_EVENTS.BOUNDARY_UPDATE,
  );
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Boundary Host",
      settings: {
        gameMode: "manhunt",
        maxPlayers: 8,
        isPrivate: false,
        manhunt: { hunterCount: 1, boundary: initialBoundary },
      },
    },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) return;
  const roomCode = createResult.data.room.code;
  assert.deepEqual(await hostBoundary, {
    roomCode,
    boundary: initialBoundary,
  });
  assert.equal(
    JSON.stringify(createResult.data).includes("boundary"),
    false,
  );

  const guestOneBoundary = waitForEvent<ManhuntBoundaryUpdatePayload>(
    guestOne,
    MANHUNT_EVENTS.BOUNDARY_UPDATE,
  );
  const guestOneJoin = await emitWithAck<JoinRoomResponse>(
    guestOne,
    ROOM_EVENTS.JOIN,
    { roomCode, nickname: "Boundary Guest One" },
  );
  assert.equal(guestOneJoin.ok, true);
  if (!guestOneJoin.ok) return;
  assert.deepEqual(await guestOneBoundary, { roomCode, boundary: null });
  assert.equal(JSON.stringify(guestOneJoin.data).includes("boundary"), false);

  const guestTwoBoundary = waitForEvent<ManhuntBoundaryUpdatePayload>(
    guestTwo,
    MANHUNT_EVENTS.BOUNDARY_UPDATE,
  );
  const guestTwoJoin = await emitWithAck<JoinRoomResponse>(
    guestTwo,
    ROOM_EVENTS.JOIN,
    { roomCode, nickname: "Boundary Guest Two" },
  );
  assert.equal(guestTwoJoin.ok, true);
  if (!guestTwoJoin.ok) return;
  assert.deepEqual(await guestTwoBoundary, { roomCode, boundary: null });
  assert.equal(JSON.stringify(guestTwoJoin.data).includes("boundary"), false);

  const updatedBoundary = {
    center: { latitude: 40.7128, longitude: -74.006 },
    radiusMeters: 420,
  };
  const hostUpdatedBoundary = waitForEventWhere<ManhuntBoundaryUpdatePayload>(
    host,
    MANHUNT_EVENTS.BOUNDARY_UPDATE,
    (payload) => payload.boundary?.radiusMeters === 420,
  );
  const guestOneSettingsBoundary = waitForEvent<ManhuntBoundaryUpdatePayload>(
    guestOne,
    MANHUNT_EVENTS.BOUNDARY_UPDATE,
  );
  const guestTwoSettingsBoundary = waitForEvent<ManhuntBoundaryUpdatePayload>(
    guestTwo,
    MANHUNT_EVENTS.BOUNDARY_UPDATE,
  );
  const settingsEvent = waitForEvent<ManhuntSettingsUpdatePayload>(
    host,
    MANHUNT_EVENTS.SETTINGS_UPDATE,
  );
  const updatedRoomEvent = waitForEvent<RoomUpdatePayload>(
    host,
    ROOM_EVENTS.UPDATE,
  );
  const settingsResult = await emitWithAck<RoomUpdatePayload>(
    host,
    MANHUNT_EVENTS.UPDATE_SETTINGS,
    {
      roomCode,
      settings: { hunterCount: 1, boundary: updatedBoundary },
    },
  );
  assert.equal(settingsResult.ok, true);
  if (!settingsResult.ok) return;
  assert.deepEqual((await hostUpdatedBoundary).boundary, updatedBoundary);
  assert.deepEqual(await guestOneSettingsBoundary, {
    roomCode,
    boundary: null,
  });
  assert.deepEqual(await guestTwoSettingsBoundary, {
    roomCode,
    boundary: null,
  });
  const updatedSettings = await settingsEvent;
  const updatedRoom = await updatedRoomEvent;
  assert.equal(JSON.stringify(settingsResult.data).includes("boundary"), false);
  assert.equal(JSON.stringify(updatedSettings).includes("boundary"), false);
  assert.equal(JSON.stringify(updatedRoom).includes("boundary"), false);

  const startedEvent = waitForEvent<GameStartedPayload>(
    host,
    GAME_EVENTS.GAME_STARTED,
  );
  const gameStateEvent = waitForEvent<GameStateUpdatePayload>(
    host,
    GAME_EVENTS.STATE_UPDATE,
  );
  const members = [
    {
      client: host,
      playerId: createResult.data.playerId,
      reconnectToken: createResult.data.reconnectToken,
    },
    {
      client: guestOne,
      playerId: guestOneJoin.data.playerId,
      reconnectToken: guestOneJoin.data.reconnectToken,
    },
    {
      client: guestTwo,
      playerId: guestTwoJoin.data.playerId,
      reconnectToken: guestTwoJoin.data.reconnectToken,
    },
  ];
  const assignmentEvents = members.map(({ client }) =>
    waitForEvent<ManhuntTeamAssignmentPayload>(
      client,
      MANHUNT_EVENTS.TEAM_ASSIGNMENT,
    ),
  );
  const roleBoundaryEvents = members.map(({ client }) =>
    waitForEvent<ManhuntBoundaryUpdatePayload>(
      client,
      MANHUNT_EVENTS.BOUNDARY_UPDATE,
    ),
  );
  const startResult = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
    roomCode,
  });
  assert.equal(startResult.ok, true);
  const started = await startedEvent;
  const gameState = await gameStateEvent;
  const assignments = await Promise.all(assignmentEvents);
  const roleBoundaries = await Promise.all(roleBoundaryEvents);
  assert.equal(JSON.stringify(started).includes("boundary"), false);
  assert.equal(JSON.stringify(gameState).includes("boundary"), false);
  assert.equal(assignments.filter(({ team }) => team === "hunter").length, 1);
  assert.equal(assignments.filter(({ team }) => team === "runner").length, 2);
  for (let index = 0; index < members.length; index += 1) {
    assert.equal(assignments[index]?.playerId, members[index]?.playerId);
    assert.deepEqual(roleBoundaries[index], {
      roomCode,
      boundary:
        assignments[index]?.team === "runner" ? updatedBoundary : null,
    });
  }

  const currentGames = Reflect.get(
    server.manhuntGameService,
    "currentGames",
  ) as Map<
    string,
    {
      boundary: {
        center: { latitude: number; longitude: number };
        radiusMeters: number;
      };
    }
  >;
  const currentGame = currentGames.get(roomCode);
  assert.ok(currentGame);
  currentGame.boundary.radiusMeters = 390;

  const serviceEvents = Reflect.get(server.manhuntGameService, "events") as {
    boundaryUpdated(
      eventRoomCode: RoomCode,
      payload: ManhuntBoundaryUpdatePayload,
    ): void;
  };
  const shrinkBoundaryEvents = members.map(({ client }) =>
    waitForEvent<ManhuntBoundaryUpdatePayload>(
      client,
      MANHUNT_EVENTS.BOUNDARY_UPDATE,
    ),
  );
  serviceEvents.boundaryUpdated(roomCode, {
    roomCode,
    boundary: { ...updatedBoundary, radiusMeters: 390 },
  });
  const shrinkBoundaries = await Promise.all(shrinkBoundaryEvents);
  for (let index = 0; index < members.length; index += 1) {
    assert.deepEqual(shrinkBoundaries[index], {
      roomCode,
      boundary:
        assignments[index]?.team === "runner"
          ? { ...updatedBoundary, radiusMeters: 390 }
          : null,
    });
  }

  const publicResponse = await fetch(`${url}/rooms/${roomCode}`);
  assert.equal(publicResponse.status, 200);
  assert.equal(
    JSON.stringify(await publicResponse.json()).includes("boundary"),
    false,
  );

  const hider = members.find((member, index) =>
    assignments[index]?.team === "runner",
  );
  const hunter = members.find((member, index) =>
    assignments[index]?.team === "hunter",
  );
  assert.ok(hider);
  assert.ok(hunter);
  if (!hider || !hunter) return;

  const invalidReconnect = await connectClient(url, clients);
  const invalidResult = await assertNoEventDuring(
    invalidReconnect,
    MANHUNT_EVENTS.BOUNDARY_UPDATE,
    () =>
      emitWithAck<PlayerReconnectedPayload>(
        invalidReconnect,
        CONNECTION_EVENTS.RECONNECT,
        {
          roomCode,
          playerId: hider.playerId,
          reconnectToken: `${hider.reconnectToken}invalid`,
        },
      ),
  );
  assert.equal(invalidResult.ok, false);

  const reconnectMember = async (
    member: (typeof members)[number],
  ): Promise<ManhuntBoundaryUpdatePayload> => {
    const watcher = members.find(
      (candidate) =>
        candidate.playerId !== member.playerId && candidate.client.connected,
    );
    assert.ok(watcher);
    if (!watcher) throw new Error("No connected room member can observe disconnect.");
    const disconnectedUpdate = waitForEventWhere<RoomUpdatePayload>(
      watcher.client,
      ROOM_EVENTS.UPDATE,
      (payload) =>
        payload.room.code === roomCode &&
        payload.room.players.some(
          (player) =>
            player.id === member.playerId &&
            player.connectionStatus === "disconnected",
        ),
    );
    member.client.disconnect();
    await disconnectedUpdate;

    const reconnected = await connectClient(url, clients);
    const boundaryEvent = waitForEvent<ManhuntBoundaryUpdatePayload>(
      reconnected,
      MANHUNT_EVENTS.BOUNDARY_UPDATE,
    );
    const reconnectResult = await emitWithAck<PlayerReconnectedPayload>(
      reconnected,
      CONNECTION_EVENTS.RECONNECT,
      {
        roomCode,
        playerId: member.playerId,
        reconnectToken: member.reconnectToken,
      },
    );
    assert.equal(reconnectResult.ok, true);
    if (!reconnectResult.ok) {
      throw new Error("A valid Manhunt reconnect credential was rejected.");
    }
    assert.equal(JSON.stringify(reconnectResult.data).includes("boundary"), false);
    member.client = reconnected;
    return boundaryEvent;
  };

  assert.deepEqual(await reconnectMember(hider), {
    roomCode,
    boundary: { ...updatedBoundary, radiusMeters: 390 },
  });
  assert.deepEqual(await reconnectMember(hunter), {
    roomCode,
    boundary: null,
  });

  const hostMember = members[0];
  const memberToLeave = members.find(
    (member) => member.playerId !== hostMember?.playerId,
  );
  const remainingGuest = members.find(
    (member) =>
      member.playerId !== hostMember?.playerId &&
      member.playerId !== memberToLeave?.playerId,
  );
  assert.ok(hostMember);
  assert.ok(memberToLeave);
  assert.ok(remainingGuest);
  if (!hostMember || !memberToLeave || !remainingGuest) return;
  const cancellation = waitForEvent<ManhuntCountdownCancelledPayload>(
    hostMember.client,
    MANHUNT_EVENTS.COUNTDOWN_CANCELLED,
  );
  const hostAfterReset = waitForEvent<ManhuntBoundaryUpdatePayload>(
    hostMember.client,
    MANHUNT_EVENTS.BOUNDARY_UPDATE,
  );
  const guestAfterReset = waitForEvent<ManhuntBoundaryUpdatePayload>(
    remainingGuest.client,
    MANHUNT_EVENTS.BOUNDARY_UPDATE,
  );
  const leaveResult = await emitWithAck<void>(
    memberToLeave.client,
    ROOM_EVENTS.LEAVE,
    { roomCode },
  );
  assert.equal(leaveResult.ok, true);
  assert.equal((await cancellation).roomCode, roomCode);
  assert.deepEqual(await hostAfterReset, {
    roomCode,
    boundary: updatedBoundary,
  });
  assert.deepEqual(await guestAfterReset, { roomCode, boundary: null });

  assert.equal(
    JSON.stringify(server.roomService.getPublicRoom(roomCode)).includes(
      "boundary",
    ),
    false,
  );

  await assertNoEventDuring(
    outsider,
    MANHUNT_EVENTS.BOUNDARY_UPDATE,
    async () => undefined,
  );
  assert.equal(outsiderReceivedBoundary, false);
});

test("clock synchronization responds privately with server time and validates requests", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  const requester = await connectClient(url, clients);
  const observer = await connectClient(url, clients);
  let observerReceivedClockEvent = false;
  observer.on(CLOCK_EVENTS.SYNC, () => {
    observerReceivedClockEvent = true;
  });

  const sentAt = Date.now();
  const response = await emitWithAck<ClockSyncResponsePayload>(
    requester,
    CLOCK_EVENTS.SYNC,
    { requestId: 7 },
  );
  const receivedAt = Date.now();
  assert.equal(response.ok, true);
  if (response.ok) {
    assert.equal(response.data.requestId, 7);
    const serverTime = Date.parse(response.data.serverTime);
    assert.ok(Number.isFinite(serverTime));
    assert.ok(serverTime >= sentAt - 1_000);
    assert.ok(serverTime <= receivedAt + 1_000);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observerReceivedClockEvent, false);

  const invalidPayload = waitForEvent<ValidationErrorPayload>(
    requester,
    ERROR_EVENTS.VALIDATION_ERROR,
  );
  requester.emit(CLOCK_EVENTS.SYNC, { requestId: "7" });
  assert.equal((await invalidPayload).code, "INVALID_PAYLOAD");

  const untrustedTime = waitForEvent<ValidationErrorPayload>(
    requester,
    ERROR_EVENTS.VALIDATION_ERROR,
  );
  requester.emit(CLOCK_EVENTS.SYNC, {
    requestId: 8,
    serverTime: "2099-01-01T00:00:00.000Z",
  });
  assert.equal((await untrustedTime).code, "INVALID_PAYLOAD");
});

test("HTTP health and room routes return structured public responses", async (t) => {
  const { server, url } = await createTestServer(t);
  const address = server.httpServer.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, "string");
  if (!address || typeof address === "string") {
    throw new Error("Backend server did not bind to a TCP address.");
  }
  assert.equal(address.address, "0.0.0.0");

  const healthResponse = await fetch(`${url}/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(healthResponse.headers.get("x-frame-options"), "DENY");
  assert.equal(healthResponse.headers.get("referrer-policy"), "no-referrer");
  const healthBody: unknown = await healthResponse.json();
  assert.equal(
    typeof healthBody === "object" &&
      healthBody !== null &&
      "status" in healthBody &&
      healthBody.status === "ok",
    true,
  );
  assert.equal(
    typeof healthBody === "object" &&
      healthBody !== null &&
      "timestamp" in healthBody &&
      typeof healthBody.timestamp === "string",
    true,
  );

  const missingRoomResponse = await fetch(`${url}/rooms/NOPE`);
  assert.equal(missingRoomResponse.status, 404);

  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  const host = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Host" },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }

  const roomResponse = await fetch(
    `${url}/rooms/${createResult.data.room.code.toLowerCase()}`,
  );
  assert.equal(roomResponse.status, 200);
  const publicRoom = await roomResponse.json();
  assert.equal(publicRoom.code, createResult.data.room.code);
  assert.equal(JSON.stringify(publicRoom).includes("reconnectToken"), false);
  assert.equal(
    JSON.stringify(publicRoom).includes(createResult.data.reconnectToken),
    false,
  );
  assert.equal(server.roomService.getPublicRoom(createResult.data.room.code)?.hostId, createResult.data.playerId);
});

test("production enforces HTTPS and exact browser origins", async (t) => {
  const { url } = await createTestServer(t, {
    nodeEnv: "production",
    allowedOrigins: ["https://game.example"],
    trustProxyHops: 1,
    requireHttps: true,
  });

  const insecureResponse = await fetch(`${url}/rooms/NOPE`);
  assert.equal(insecureResponse.status, 426);
  assert.equal(insecureResponse.headers.get("strict-transport-security"), null);

  const spoofedForwardingChain = await fetch(`${url}/rooms/NOPE`, {
    headers: { "x-forwarded-proto": "https,http" },
  });
  assert.equal(spoofedForwardingChain.status, 426);

  const secureResponse = await fetch(`${url}/rooms/NOPE`, {
    headers: {
      "x-forwarded-proto": "https",
      origin: "https://game.example",
    },
  });
  assert.equal(secureResponse.status, 404);
  assert.equal(
    secureResponse.headers.get("strict-transport-security"),
    "max-age=31536000",
  );
  assert.equal(
    secureResponse.headers.get("access-control-allow-origin"),
    "https://game.example",
  );

  const rejectedOrigin = await fetch(`${url}/rooms/NOPE`, {
    headers: {
      "x-forwarded-proto": "https",
      origin: "https://untrusted.example",
    },
  });
  assert.equal(rejectedOrigin.status, 403);

  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
  });
  await connectClient(url, clients, {
    "x-forwarded-proto": "https",
    origin: "https://game.example",
  });
  await assert.rejects(
    connectClient(url, clients, { origin: "https://game.example" }),
  );
});

test("Socket.IO supports HTTP long-polling and WebSocket transports", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
  });

  await connectClient(url, clients, undefined, ["polling"]);
  await connectClient(url, clients, undefined, ["websocket"]);
});

test("two clients receive room updates; leaving transfers host status", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });
  const host = await connectClient(url, clients);
  const guest = await connectClient(url, clients);

  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Host" },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }

  const joinedEvent = waitForEvent<PlayerJoinedPayload>(
    host,
    ROOM_EVENTS.PLAYER_JOINED,
  );
  const updateEvent = waitForEvent<RoomUpdatePayload>(
    host,
    ROOM_EVENTS.UPDATE,
  );
  const joinResult = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    { roomCode: createResult.data.room.code, nickname: "Guest" },
  );
  assert.equal(joinResult.ok, true);
  if (!joinResult.ok) {
    return;
  }

  assert.equal((await joinedEvent).player.id, joinResult.data.playerId);
  assert.equal((await updateEvent).room.players.length, 2);

  const playerLeftEvent = waitForEvent<PlayerLeftPayload>(
    guest,
    ROOM_EVENTS.PLAYER_LEFT,
  );
  const hostTransferUpdate = waitForEvent<RoomUpdatePayload>(
    guest,
    ROOM_EVENTS.UPDATE,
  );
  const leaveResult = await emitWithAck<void>(host, ROOM_EVENTS.LEAVE, {
    roomCode: createResult.data.room.code,
  });
  assert.equal(leaveResult.ok, true);
  assert.equal((await playerLeftEvent).playerId, createResult.data.playerId);
  assert.equal(
    (await hostTransferUpdate).room.hostId,
    joinResult.data.playerId,
  );
});

test("only the host starts a game and role responses are private to the requester", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });
  const host = await connectClient(url, clients);
  const guest = await connectClient(url, clients);
  const thirdPlayer = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Host" },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }
  const joinResult = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    {
      roomCode: createResult.data.room.code,
      nickname: "Guest",
    },
  );
  assert.equal(joinResult.ok, true);
  if (!joinResult.ok) {
    return;
  }
  const thirdJoinResult = await emitWithAck<JoinRoomResponse>(
    thirdPlayer,
    ROOM_EVENTS.JOIN,
    {
      roomCode: createResult.data.room.code,
      nickname: "Third",
    },
  );
  assert.equal(thirdJoinResult.ok, true);
  if (!thirdJoinResult.ok) {
    return;
  }

  const guestResult = await emitWithAck<void>(guest, GAME_EVENTS.START_GAME, {
    roomCode: createResult.data.room.code,
  });
  assert.equal(guestResult.ok, false);
  if (!guestResult.ok) {
    assert.equal(guestResult.error.code, "NOT_AUTHORIZED");
  }

  const hostStartedEvent = waitForEvent<GameStartedPayload>(
    host,
    GAME_EVENTS.GAME_STARTED,
  );
  const guestStartedEvent = waitForEvent<GameStartedPayload>(
    guest,
    GAME_EVENTS.GAME_STARTED,
  );
  const hostResult = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
    roomCode: createResult.data.room.code,
  });
  assert.equal(hostResult.ok, true);
  const started = (await hostStartedEvent).session;
  assert.equal(started.status, "starting");
  assert.equal((await guestStartedEvent).session.id, started.id);
  assert.equal(JSON.stringify(started).includes("impostorPlayerIds"), false);

  let guestRoleAssignmentCount = 0;
  guest.on(IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, () => {
    guestRoleAssignmentCount += 1;
  });
  const hostRoleAssignment = waitForEvent<ImpostorRoleAssignmentPayload>(
    host,
    IMPOSTOR_EVENTS.ROLE_ASSIGNMENT,
  );
  host.emit(IMPOSTOR_EVENTS.ROLE_REQUEST, {
    roomCode: createResult.data.room.code,
    sessionId: started.id,
  });
  const assignedRole = await hostRoleAssignment;
  assert.equal(assignedRole.sessionId, started.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(guestRoleAssignmentCount, 0);

  const validationEvent = waitForEvent<ValidationErrorPayload>(
    guest,
    ERROR_EVENTS.VALIDATION_ERROR,
  );
  guest.emit(IMPOSTOR_EVENTS.ROLE_REQUEST, {
    roomCode: createResult.data.room.code,
    sessionId: started.id,
    playerId: createResult.data.playerId,
  });
  assert.equal((await validationEvent).code, "INVALID_PAYLOAD");
});

test("reconnecting players receive only their own active-game role", async (t) => {
  const { server, url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });
  const host = await connectClient(url, clients);
  const guest = await connectClient(url, clients);
  const thirdPlayer = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Host" },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }
  const guestJoin = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    { roomCode: createResult.data.room.code, nickname: "Guest" },
  );
  const thirdJoin = await emitWithAck<JoinRoomResponse>(
    thirdPlayer,
    ROOM_EVENTS.JOIN,
    { roomCode: createResult.data.room.code, nickname: "Third" },
  );
  assert.equal(guestJoin.ok, true);
  assert.equal(thirdJoin.ok, true);
  if (!guestJoin.ok || !thirdJoin.ok) {
    return;
  }

  const startedEvent = waitForEvent<GameStartedPayload>(
    guest,
    GAME_EVENTS.GAME_STARTED,
  );
  const startResult = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
    roomCode: createResult.data.room.code,
  });
  assert.equal(startResult.ok, true);
  const sessionId = (await startedEvent).session.id;

  let hostRoleAssignmentCount = 0;
  host.on(IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, () => {
    hostRoleAssignmentCount += 1;
  });
  guest.disconnect();
  const replacement = await connectClient(url, clients);
  const resumedGame = waitForEvent<GameStartedPayload>(
    replacement,
    GAME_EVENTS.GAME_STARTED,
  );
  const resumedState = waitForEvent<GameStateUpdatePayload>(
    replacement,
    GAME_EVENTS.STATE_UPDATE,
  );
  const resumedRole = waitForEvent<ImpostorRoleAssignmentPayload>(
    replacement,
    IMPOSTOR_EVENTS.ROLE_ASSIGNMENT,
  );
  const reconnectResult = await emitWithAck<PlayerReconnectedPayload>(
    replacement,
    CONNECTION_EVENTS.RECONNECT,
    {
      roomCode: createResult.data.room.code,
      playerId: guestJoin.data.playerId,
      reconnectToken: guestJoin.data.reconnectToken,
    },
  );
  assert.equal(reconnectResult.ok, true);
  assert.equal((await resumedGame).session.id, sessionId);
  assert.equal((await resumedState).sessionId, sessionId);
  assert.deepEqual(await resumedRole, server.classicImpostorService.requestRole(
    createResult.data.room.code,
    sessionId,
    guestJoin.data.playerId,
  ));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hostRoleAssignmentCount, 0);
});

test("room capacity is enforced and valid reconnect restores the same member", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  const host = await connectClient(url, clients);
  const guest = await connectClient(url, clients);
  const thirdPlayer = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Host",
      settings: {
        gameMode: "impostor-word",
        maxPlayers: 2,
        isPrivate: false,
      },
    },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }

  const joinResult = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    { roomCode: createResult.data.room.code, nickname: "Guest" },
  );
  assert.equal(joinResult.ok, true);
  const fullResult = await emitWithAck<JoinRoomResponse>(
    thirdPlayer,
    ROOM_EVENTS.JOIN,
    { roomCode: createResult.data.room.code, nickname: "Third" },
  );
  assert.equal(fullResult.ok, false);
  if (fullResult.ok) {
    return;
  }
  assert.equal(fullResult.error.code, "ROOM_FULL");

  const disconnectedUpdate = waitForEvent<RoomUpdatePayload>(
    guest,
    ROOM_EVENTS.UPDATE,
  );
  host.disconnect();
  const disconnectedRoom = (await disconnectedUpdate).room;
  assert.equal(
    disconnectedRoom.players.find(
      (player) => player.id === createResult.data.playerId,
    )?.connectionStatus,
    "disconnected",
  );

  const replacement = await connectClient(url, clients);
  const reconnectedNotice = waitForEvent<PlayerReconnectedPayload>(
    guest,
    CONNECTION_EVENTS.PLAYER_RECONNECTED,
  );
  const restoredUpdate = waitForEvent<RoomUpdatePayload>(
    guest,
    ROOM_EVENTS.UPDATE,
  );
  const reconnectResult = await emitWithAck<PlayerReconnectedPayload>(
    replacement,
    CONNECTION_EVENTS.RECONNECT,
    {
      roomCode: createResult.data.room.code,
      playerId: createResult.data.playerId,
      reconnectToken: createResult.data.reconnectToken,
    },
  );
  assert.equal(reconnectResult.ok, true);
  if (!reconnectResult.ok) {
    return;
  }

  assert.equal((await reconnectedNotice).player.id, createResult.data.playerId);
  const restoredRoom = (await restoredUpdate).room;
  assert.equal(restoredRoom.players.length, 2);
  assert.equal(
    restoredRoom.players.find(
      (player) => player.id === createResult.data.playerId,
    )?.connectionStatus,
    "connected",
  );
  assert.equal(JSON.stringify(restoredRoom).includes("reconnectToken"), false);
});

test("configured CORS origins are allowed and other browser origins are rejected", async (t) => {
  const { url } = await createTestServer(t, {
    allowedOrigins: ["https://game.example"],
  });
  const allowedResponse = await fetch(`${url}/health`, {
    headers: { Origin: "https://game.example" },
  });
  assert.equal(allowedResponse.status, 200);
  assert.equal(
    allowedResponse.headers.get("access-control-allow-origin"),
    "https://game.example",
  );

  const rejectedResponse = await fetch(`${url}/health`, {
    headers: { Origin: "https://untrusted.example" },
  });
  assert.equal(rejectedResponse.status, 403);
});

test("disconnected players are removed after the reconnect grace period", async (t) => {
  const { url } = await createTestServer(t, {
    reconnectGracePeriodMs: 100,
  });
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });
  const host = await connectClient(url, clients);
  const guest = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Host" },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }
  const joinResult = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    { roomCode: createResult.data.room.code, nickname: "Guest" },
  );
  assert.equal(joinResult.ok, true);

  const disconnectedUpdate = waitForEvent<RoomUpdatePayload>(
    guest,
    ROOM_EVENTS.UPDATE,
  );
  host.disconnect();
  assert.equal(
    (await disconnectedUpdate).room.players.find(
      (player) => player.id === createResult.data.playerId,
    )?.connectionStatus,
    "disconnected",
  );

  const leftEvent = waitForEvent<PlayerLeftPayload>(
    guest,
    ROOM_EVENTS.PLAYER_LEFT,
  );
  const updatedRoom = waitForEvent<RoomUpdatePayload>(
    guest,
    ROOM_EVENTS.UPDATE,
  );
  assert.equal((await leftEvent).playerId, createResult.data.playerId);
  const remainingRoom = (await updatedRoom).room;
  assert.equal(remainingRoom.players.length, 1);
  assert.equal(remainingRoom.hostId, joinResult.data.playerId);
});

test("room creation is rate-limited per remote address", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const client = await connectClient(url, clients);
    const result = await emitWithAck<CreateRoomResponse>(
      client,
      ROOM_EVENTS.CREATE,
      { nickname: `Player ${attempt}` },
    );
    if (attempt < 5) {
      assert.equal(result.ok, true);
    } else {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error.message, /Too many attempts/);
      }
    }
  }
});

test("Railway mode validates X-Real-IP and rate-limits without X-Forwarded-For", async (t) => {
  const { url } = await createTestServer(t, {
    nodeEnv: "production",
    allowedOrigins: ["https://game.example"],
    clientIpMode: "railway",
    trustProxyHops: 0,
    requireHttps: true,
  });
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
  });

  await assert.rejects(
    connectClient(url, clients, { "x-forwarded-proto": "https" }),
  );
  await assert.rejects(
    connectClient(url, clients, {
      "x-real-ip": "203.0.113.8, 198.51.100.2",
      "x-forwarded-proto": "https",
    }),
  );

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const client = await connectClient(url, clients, {
      "x-real-ip": "203.0.113.8",
      "x-forwarded-for": `198.51.100.${attempt + 1}`,
      "x-forwarded-proto": "https",
    });
    const result = await emitWithAck<CreateRoomResponse>(
      client,
      ROOM_EVENTS.CREATE,
      { nickname: `Railway player ${attempt}` },
    );
    assert.equal(result.ok, attempt < 5);
    if (!result.ok && attempt === 5) {
      assert.match(result.error.message, /Too many attempts/);
    }
  }
});

test("Manhunt location updates are rate-limited per player", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
  });
  const client = await connectClient(url, clients);
  const created = await emitWithAck<CreateRoomResponse>(
    client,
    ROOM_EVENTS.CREATE,
    { nickname: "Player" },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result: SocketAcknowledgement<ManhuntLocationAcknowledgementPayload> =
      await emitWithAck<ManhuntLocationAcknowledgementPayload>(
        client,
        MANHUNT_EVENTS.LOCATION_UPDATE,
        { roomCode: created.data.room.code },
      );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_PAYLOAD");
  }

  const limited = await emitWithAck<ManhuntLocationAcknowledgementPayload>(
    client,
    MANHUNT_EVENTS.LOCATION_UPDATE,
    { roomCode: created.data.room.code },
  );
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.match(limited.error.message, /Too many attempts/);
});

test("invalid game modes are rejected with a shared validation error", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });
  const client = await connectClient(url, clients);
  const validationEvent = waitForEvent<ValidationErrorPayload>(
    client,
    ERROR_EVENTS.VALIDATION_ERROR,
  );
  const result = await emitWithAck<CreateRoomResponse>(
    client,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Player",
      settings: {
        gameMode: "infection",
        maxPlayers: 8,
        isPrivate: false,
      },
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_PAYLOAD");
  }
  assert.equal((await validationEvent).code, "INVALID_PAYLOAD");
});

test("Manhunt catch confirmation is private and announcements reach only the same game", async (t) => {
    const { url } = await createTestServer(t);
    const clients: TestClient[] = [];
    t.after(() => {
      for (const client of clients) {
        client.disconnect();
      }
    });

    const hunterCandidate = await connectClient(url, clients);
    const runnerCandidate = await connectClient(url, clients);
    const thirdPlayer = await connectClient(url, clients);
    const otherRoomHost = await connectClient(url, clients);
    const otherRoomGuest = await connectClient(url, clients);

    const createResult = await emitWithAck<CreateRoomResponse>(
      hunterCandidate,
      ROOM_EVENTS.CREATE,
      {
        nickname: "Hunter Candidate",
        settings: {
          gameMode: "manhunt",
          maxPlayers: 8,
          isPrivate: false,
        },
      },
    );
    assert.equal(createResult.ok, true);
    if (!createResult.ok) return;
    const roomCode = createResult.data.room.code;
    const runnerJoin = await emitWithAck<JoinRoomResponse>(
      runnerCandidate,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: "Runner Candidate" },
    );
    const thirdJoin = await emitWithAck<JoinRoomResponse>(
      thirdPlayer,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: "Third Player" },
    );
    assert.equal(runnerJoin.ok, true);
    assert.equal(thirdJoin.ok, true);
    if (!runnerJoin.ok || !thirdJoin.ok) return;

    const otherRoomCreate = await emitWithAck<CreateRoomResponse>(
      otherRoomHost,
      ROOM_EVENTS.CREATE,
      {
        nickname: "Other Room Host",
        settings: {
          gameMode: "manhunt",
          maxPlayers: 8,
          isPrivate: false,
        },
      },
    );
    assert.equal(otherRoomCreate.ok, true);
    if (!otherRoomCreate.ok) return;
    const otherRoomJoin = await emitWithAck<JoinRoomResponse>(
      otherRoomGuest,
      ROOM_EVENTS.JOIN,
      {
        roomCode: otherRoomCreate.data.room.code,
        nickname: "Other Room Guest",
      },
    );
    assert.equal(otherRoomJoin.ok, true);
    if (!otherRoomJoin.ok) return;

    const settingsResult = await emitWithAck<RoomUpdatePayload>(
      hunterCandidate,
      MANHUNT_EVENTS.UPDATE_SETTINGS,
      {
        roomCode,
        settings: {
          hunterCount: 1,
          boundary: {
            center: { latitude: 0, longitude: 0 },
            radiusMeters: 500,
          },
        },
      },
    );
    assert.equal(settingsResult.ok, true);

    const gameStarted = [
      waitForEvent<GameStartedPayload>(
        hunterCandidate,
        GAME_EVENTS.GAME_STARTED,
      ),
      waitForEvent<GameStartedPayload>(
        runnerCandidate,
        GAME_EVENTS.GAME_STARTED,
      ),
      waitForEvent<GameStartedPayload>(thirdPlayer, GAME_EVENTS.GAME_STARTED),
    ];
    const countdownEvents = [
      waitForEvent<CountdownPayload>(hunterCandidate, MANHUNT_EVENTS.COUNTDOWN),
      waitForEvent<CountdownPayload>(runnerCandidate, MANHUNT_EVENTS.COUNTDOWN),
      waitForEvent<CountdownPayload>(thirdPlayer, MANHUNT_EVENTS.COUNTDOWN),
    ];
    const roleAssignments = [
      hunterCandidate,
      runnerCandidate,
      thirdPlayer,
    ].map((client) =>
      waitForEvent<ManhuntTeamAssignmentPayload>(
        client,
        MANHUNT_EVENTS.TEAM_ASSIGNMENT,
      ),
    );
    const activeStateUpdates = [
      hunterCandidate,
      runnerCandidate,
    ].map((client) =>
      waitForEventWhere<GameStateUpdatePayload>(
        client,
        GAME_EVENTS.STATE_UPDATE,
        (payload) =>
          payload.roomCode === roomCode &&
          "settings" in payload.state &&
          payload.state.phase === "active",
      ),
    );
    const startResult = await emitWithAck<void>(
      hunterCandidate,
      GAME_EVENTS.START_GAME,
      { roomCode },
    );
    assert.equal(startResult.ok, true);
    const started = await Promise.all(gameStarted);
    const session = started[0]?.session;
    if (!session || session.gameMode !== "manhunt") {
      throw new Error("Manhunt start did not return a Manhunt session.");
    }
    assert.deepEqual(
      started.map((event) => event.session.id),
      [session.id, session.id, session.id],
    );
    assert.equal(session.state.phase, "countdown");
    assert.equal("teams" in session.state, false);
    const assignments = await Promise.all(roleAssignments);
    assert.deepEqual(
      assignments.map((assignment) => assignment.playerId),
      [
        createResult.data.playerId,
        runnerJoin.data.playerId,
        thirdJoin.data.playerId,
      ],
    );
    const countdowns = await Promise.all(countdownEvents);
    assert.deepEqual(
      countdowns.map((event) => event.endsAt),
      [
        session.state.countdownEndsAt,
        session.state.countdownEndsAt,
        session.state.countdownEndsAt,
      ],
    );
    assert.equal(
      new Set(countdowns.map((event) => event.sessionId)).size,
      1,
    );
    const thirdDisconnected = waitForEventWhere<RoomUpdatePayload>(
      hunterCandidate,
      ROOM_EVENTS.UPDATE,
      (payload) =>
        payload.room.code === roomCode &&
        payload.room.players.some(
          (player) =>
            player.id === thirdJoin.data.playerId &&
            player.connectionStatus === "disconnected",
        ),
    );
    thirdPlayer.disconnect();
    await thirdDisconnected;
    const replacementThird = await connectClient(url, clients);
    const restoredStarted = waitForEvent<GameStartedPayload>(
      replacementThird,
      GAME_EVENTS.GAME_STARTED,
    );
    const restoredState = waitForEvent<GameStateUpdatePayload>(
      replacementThird,
      GAME_EVENTS.STATE_UPDATE,
    );
    const restoredCountdown = waitForEvent<CountdownPayload>(
      replacementThird,
      MANHUNT_EVENTS.COUNTDOWN,
    );
    const restoredAssignment = waitForEvent<ManhuntTeamAssignmentPayload>(
      replacementThird,
      MANHUNT_EVENTS.TEAM_ASSIGNMENT,
    );
    const reconnectResult = await emitWithAck<PlayerReconnectedPayload>(
      replacementThird,
      CONNECTION_EVENTS.RECONNECT,
      {
        roomCode,
        playerId: thirdJoin.data.playerId,
        reconnectToken: thirdJoin.data.reconnectToken,
      },
    );
    assert.equal(reconnectResult.ok, true);
    const resumed = await restoredStarted;
    const resumedState = await restoredState;
    const resumedCountdown = await restoredCountdown;
    const resumedAssignment = await restoredAssignment;
    assert.equal(resumed.session.id, session.id);
    assert.equal(resumed.session.state.phase, "countdown");
    assert.equal(resumedState.state.phase, "countdown");
    assert.equal(resumedCountdown.endsAt, session.state.countdownEndsAt);
    assert.deepEqual(resumedAssignment, assignments[2]);
    const replacementActiveState = waitForEventWhere<GameStateUpdatePayload>(
      replacementThird,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.roomCode === roomCode &&
        payload.sessionId === session.id &&
        "settings" in payload.state &&
        payload.state.phase === "active",
    );

    const participants = [
      {
        client: hunterCandidate,
        playerId: createResult.data.playerId,
        nickname: "Hunter Candidate",
      },
      {
        client: runnerCandidate,
        playerId: runnerJoin.data.playerId,
        nickname: "Runner Candidate",
      },
      {
        client: replacementThird,
        playerId: thirdJoin.data.playerId,
        nickname: "Third Player",
      },
    ];
    const hunter = participants.find(({ playerId }) =>
      assignments.some(
        (assignment) =>
          assignment.playerId === playerId && assignment.team === "hunter",
      ),
    );
    const runner = participants.find(({ playerId }) =>
      assignments.some(
        (assignment) =>
          assignment.playerId === playerId && assignment.team === "runner",
      ),
    );
    assert.ok(hunter);
    assert.ok(runner);
    if (!hunter || !runner) return;

    const earlyLocation = await emitWithAck<ManhuntLocationAcknowledgementPayload>(
      hunter.client,
      MANHUNT_EVENTS.LOCATION_UPDATE,
      {
        roomCode,
        coordinates: { latitude: 0, longitude: 0 },
      },
    );
    assert.equal(earlyLocation.ok, false);
    if (!earlyLocation.ok) {
      assert.equal(earlyLocation.error.code, "GAME_NOT_ACTIVE");
    }

    const sync = await emitWithAck<CountdownSyncResponsePayload>(
      hunter.client,
      MANHUNT_EVENTS.COUNTDOWN_SYNC,
      { roomCode, sessionId: session.id },
    );
    assert.equal(sync.ok, true);
    if (sync.ok) {
      assert.equal(sync.data.endsAt, session.state.countdownEndsAt);
    }
    const invalidSyncPayload = waitForEvent<ValidationErrorPayload>(
      hunter.client,
      ERROR_EVENTS.VALIDATION_ERROR,
    );
    hunter.client.emit(MANHUNT_EVENTS.COUNTDOWN_SYNC, {
      roomCode,
      sessionId: session.id,
      endsAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal((await invalidSyncPayload).code, "INVALID_PAYLOAD");

    const officialStarts = await Promise.all([
      ...activeStateUpdates,
      replacementActiveState,
    ]);
    assert.equal(
      officialStarts.every((event) => event.state.phase === "active"),
      true,
    );

    const expectedMissionAssignmentCount = assignments.filter(
      ({ team }) => team === "runner",
    ).length;
    const missionAssignmentsByPlayer = new Map<
      string,
      ManhuntMissionAssignmentPayload[]
    >();
    let missionAssignmentDelivered = false;
    let resolveMissionAssignments: (() => void) | undefined;
    const missionAssignmentsReceived = new Promise<void>((resolve) => {
      resolveMissionAssignments = resolve;
    });
    let missionAssignmentCount = 0;
    const missionAssignmentListeners = participants.map(({ client, playerId }) => {
      const received: ManhuntMissionAssignmentPayload[] = [];
      missionAssignmentsByPlayer.set(playerId, received);
      const listener = (payload: ManhuntMissionAssignmentPayload) => {
        received.push(payload);
        missionAssignmentCount += 1;
        if (missionAssignmentCount >= expectedMissionAssignmentCount) {
          missionAssignmentDelivered = true;
          resolveMissionAssignments?.();
        }
      };
      client.on(MANHUNT_EVENTS.MISSION_ASSIGNMENT, listener);
      return { client, listener };
    });
    const otherRoomMissionAssignments: ManhuntMissionAssignmentPayload[] = [];
    const otherRoomMissionListener = (
      payload: ManhuntMissionAssignmentPayload,
    ) => otherRoomMissionAssignments.push(payload);
    otherRoomHost.on(
      MANHUNT_EVENTS.MISSION_ASSIGNMENT,
      otherRoomMissionListener,
    );
    otherRoomGuest.on(
      MANHUNT_EVENTS.MISSION_ASSIGNMENT,
      otherRoomMissionListener,
    );

    for (const participant of participants) {
      const locationResult =
        await emitWithAck<ManhuntLocationAcknowledgementPayload>(
          participant.client,
          MANHUNT_EVENTS.LOCATION_UPDATE,
          {
            roomCode,
            coordinates: { latitude: 0, longitude: 0 },
            accuracyMeters: 1,
          },
        );
      assert.equal(locationResult.ok, true);
    }
    const locationRefreshTask = (async () => {
      while (!missionAssignmentDelivered) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        if (missionAssignmentDelivered) {
          break;
        }
        for (const participant of participants) {
          const result =
            await emitWithAck<ManhuntLocationAcknowledgementPayload>(
              participant.client,
              MANHUNT_EVENTS.LOCATION_UPDATE,
              {
                roomCode,
                coordinates: { latitude: 0, longitude: 0 },
                accuracyMeters: 1,
              },
            );
          assert.equal(result.ok, true);
        }
      }
    })();
    let missionAssignmentTimeout: ReturnType<typeof setTimeout> | undefined;
    const missionAssignmentTimedOut = new Promise<never>((_resolve, reject) => {
      missionAssignmentTimeout = setTimeout(
        () => reject(new Error("Private mission assignment was not delivered.")),
        61_000,
      );
    });
    try {
      await Promise.race([
        missionAssignmentsReceived,
        missionAssignmentTimedOut,
      ]);
    } finally {
      missionAssignmentDelivered = true;
      if (missionAssignmentTimeout) {
        clearTimeout(missionAssignmentTimeout);
      }
      await locationRefreshTask;
    }
    const receivedMissionAssignments = participants.flatMap(
        ({ playerId }) => missionAssignmentsByPlayer.get(playerId) ?? [],
    );
    assert.equal(
      receivedMissionAssignments.length,
      expectedMissionAssignmentCount,
    );
    assert.deepEqual(
      receivedMissionAssignments.map(({ playerId }) => playerId).sort(),
      assignments
        .filter(({ team }) => team === "runner")
        .map(({ playerId }) => playerId)
        .sort(),
    );
    for (const payload of receivedMissionAssignments) {
      const { playerId } = payload;
      assert.ok(participants.some(({ playerId: id }) => id === playerId));
      assert.equal(
        assignments.find((assignment) => assignment.playerId === playerId)
          ?.team,
        "runner",
      );
      assert.equal(
        missionAssignmentsByPlayer.get(playerId)?.length,
        1,
      );
    }
    assert.equal(
        missionAssignmentsByPlayer.get(hunter.playerId)?.length,
        0,
    );
    for (const assignedMission of receivedMissionAssignments) {
      assert.deepEqual(Object.keys(assignedMission).sort(), [
          "center",
          "deadlineAt",
          "playerId",
          "radiusMeters",
          "revealedAt",
          "sessionId",
          "status",
      ]);
    }
    assert.equal(otherRoomMissionAssignments.length, 0);
    for (const { client, listener } of missionAssignmentListeners) {
        client.off(MANHUNT_EVENTS.MISSION_ASSIGNMENT, listener);
    }
    otherRoomHost.off(
        MANHUNT_EVENTS.MISSION_ASSIGNMENT,
        otherRoomMissionListener,
    );
    otherRoomGuest.off(
        MANHUNT_EVENTS.MISSION_ASSIGNMENT,
        otherRoomMissionListener,
    );

    const confirmation = waitForEvent<CatchConfirmationRequestPayload>(
      runner.client,
      MANHUNT_EVENTS.CATCH_CONFIRMATION_REQUEST,
    );
    let thirdPlayerReceivedPrivateRequest = false;
    const onUnexpectedPrivateRequest = () => {
      thirdPlayerReceivedPrivateRequest = true;
    };
    thirdPlayer.on(
      MANHUNT_EVENTS.CATCH_CONFIRMATION_REQUEST,
      onUnexpectedPrivateRequest,
    );
    hunter.client.emit(MANHUNT_EVENTS.CATCH, {
      roomCode,
      targetPlayerId: runner.playerId,
    });
    const request = await confirmation;
    assert.equal(request.sessionId, session.id);
    assert.equal(request.roomCode, roomCode);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(thirdPlayerReceivedPrivateRequest, false);
    thirdPlayer.off(
      MANHUNT_EVENTS.CATCH_CONFIRMATION_REQUEST,
      onUnexpectedPrivateRequest,
    );

    let otherRoomAnnouncementCount = 0;
    const onOtherRoomAnnouncement = () => {
      otherRoomAnnouncementCount += 1;
    };
    otherRoomHost.on(MANHUNT_EVENTS.CATCH_CONFIRMED, onOtherRoomAnnouncement);
    otherRoomGuest.on(MANHUNT_EVENTS.CATCH_CONFIRMED, onOtherRoomAnnouncement);
    const announcements = participants.map(({ client }) =>
      waitForEvent<CatchConfirmedPayload>(
        client,
        MANHUNT_EVENTS.CATCH_CONFIRMED,
      ),
    );
    const responseResult = await emitWithAck<void>(
      runner.client,
      MANHUNT_EVENTS.CATCH_CONFIRMATION_RESPONSE,
      {
        roomCode,
        requestId: request.requestId,
        accepted: true,
      },
    );
    assert.equal(responseResult.ok, true);
    const receivedAnnouncements = await Promise.all(announcements);
    assert.equal(
      receivedAnnouncements.every(
        (announcement) =>
          announcement.roomCode === roomCode &&
          announcement.sessionId === session.id &&
          announcement.caughtNickname === runner.nickname,
      ),
      true,
    );
    for (const announcement of receivedAnnouncements) {
      assert.deepEqual(Object.keys(announcement).sort(), [
        "caughtAt",
        "caughtNickname",
        "requestId",
        "roomCode",
        "sessionId",
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(otherRoomAnnouncementCount, 0);
    otherRoomHost.off(
      MANHUNT_EVENTS.CATCH_CONFIRMED,
      onOtherRoomAnnouncement,
    );
    otherRoomGuest.off(
      MANHUNT_EVENTS.CATCH_CONFIRMED,
      onOtherRoomAnnouncement,
    );
  });

test("Manhunt Freeze sockets authorize Hunters and privately deliver effects", async (t) => {
  const { server, url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  const players = await Promise.all(
    Array.from({ length: 4 }, () => connectClient(url, clients)),
  );
  const createResult = await emitWithAck<CreateRoomResponse>(
    players[0]!,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Freeze Host",
      settings: {
        gameMode: "manhunt",
        maxPlayers: 8,
        isPrivate: false,
      },
    },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) return;

  const roomCode = createResult.data.room.code;
  const playerIds = [createResult.data.playerId];
  for (const [index, client] of players.slice(1).entries()) {
    const joinResult = await emitWithAck<JoinRoomResponse>(
      client,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: `Freeze Player ${index + 1}` },
    );
    assert.equal(joinResult.ok, true);
    if (!joinResult.ok) return;
    playerIds.push(joinResult.data.playerId);
  }

  const settingsResult = await emitWithAck<RoomUpdatePayload>(
    players[0]!,
    MANHUNT_EVENTS.UPDATE_SETTINGS,
    {
      roomCode,
      settings: {
        hunterCount: 1,
        boundary: {
          center: { latitude: 0, longitude: 0 },
          radiusMeters: 500,
        },
      },
    },
  );
  assert.equal(settingsResult.ok, true);
  assert.equal(
    Reflect.set(
      server.manhuntGameService,
      "freezeRangeMeters",
      TEST_ONLY_FREEZE_RANGE_METERS,
    ),
    true,
  );

  const startedEvents = players.map((client) =>
    waitForEvent<GameStartedPayload>(client, GAME_EVENTS.GAME_STARTED),
  );
  const teamAssignments = players.map((client) =>
    waitForEvent<ManhuntTeamAssignmentPayload>(
      client,
      MANHUNT_EVENTS.TEAM_ASSIGNMENT,
    ),
  );
  const startResult = await emitWithAck<void>(
    players[0]!,
    GAME_EVENTS.START_GAME,
    { roomCode },
  );
  assert.equal(startResult.ok, true);
  const started = await Promise.all(startedEvents);
  const assignments = await Promise.all(teamAssignments);
  const sessionId = started[0]!.session.id;
  const hunterIndex = assignments.findIndex(
    (assignment) => assignment.team === "hunter",
  );
  const runnerIndices = assignments.flatMap((assignment, index) =>
    assignment.team === "runner" ? [index] : [],
  );
  assert.notEqual(hunterIndex, -1);
  assert.equal(runnerIndices.length, 3);

  const hunter = players[hunterIndex]!;
  const countdownActivation = await emitWithAck<void>(
    hunter,
    MANHUNT_EVENTS.FREEZE,
    {
      roomCode,
      sessionId,
      requestId: "00000000-0000-4000-8000-000000000101",
    },
  );
  assert.equal(countdownActivation.ok, false);

  const activeState = waitForEventWhere<GameStateUpdatePayload>(
    hunter,
    GAME_EVENTS.STATE_UPDATE,
    (payload) =>
      payload.roomCode === roomCode &&
      payload.sessionId === sessionId &&
      "settings" in payload.state &&
      payload.state.phase === "active",
  );
  const activateCountdown = Reflect.get(
    server.manhuntGameService,
    "activateCountdown",
  );
  if (typeof activateCountdown !== "function") {
    throw new Error("Manhunt countdown activation method is unavailable.");
  }
  activateCountdown.call(server.manhuntGameService, roomCode, sessionId);
  await activeState;

  const runnerActivation = await emitWithAck<void>(
    players[runnerIndices[0]!]!,
    MANHUNT_EVENTS.FREEZE,
    {
      roomCode,
      sessionId,
      requestId: "00000000-0000-4000-8000-000000000102",
    },
  );
  assert.equal(runnerActivation.ok, false);

  const eligibleRunnerIndices = runnerIndices.slice(0, 2);
  const outOfRangeRunnerIndex = runnerIndices[2]!;
  const locationResults = await Promise.all(
    players.map((client, index) =>
      emitWithAck<ManhuntLocationAcknowledgementPayload>(
        client,
        MANHUNT_EVENTS.LOCATION_UPDATE,
        {
          roomCode,
          coordinates: {
            latitude:
              index === hunterIndex
                ? 0
                : eligibleRunnerIndices.includes(index)
                  ? 0.00005
                  : 0.001,
            longitude: 0,
          },
          accuracyMeters: 1,
        },
      ),
    ),
  );
  assert.equal(locationResults.every((result) => result.ok), true);

  const received = players.map(() => ({
    warnings: [] as ManhuntFreezeWarningPayload[],
    frozen: [] as PlayerFrozenPayload[],
  }));
  players.forEach((client, index) => {
    client.on(
      MANHUNT_EVENTS.FREEZE_WARNING,
      (payload: ManhuntFreezeWarningPayload) =>
        received[index]!.warnings.push(payload),
    );
    client.on(
      MANHUNT_EVENTS.PLAYER_FROZEN,
      (payload: PlayerFrozenPayload) =>
        received[index]!.frozen.push(payload),
    );
  });
  const warningEvents = eligibleRunnerIndices.map((index) =>
    waitForEvent<ManhuntFreezeWarningPayload>(
      players[index]!,
      MANHUNT_EVENTS.FREEZE_WARNING,
    ),
  );
  const frozenEvents = eligibleRunnerIndices.map((index) =>
    waitForEvent<PlayerFrozenPayload>(
      players[index]!,
      MANHUNT_EVENTS.PLAYER_FROZEN,
    ),
  );
  const freezePayload = {
    roomCode,
    sessionId,
    requestId: "00000000-0000-4000-8000-000000000103",
  };
  const activation = await emitWithAck<void>(
    hunter,
    MANHUNT_EVENTS.FREEZE,
    freezePayload,
  );
  assert.equal(activation.ok, true);
  const duplicateActivation = await emitWithAck<void>(
    hunter,
    MANHUNT_EVENTS.FREEZE,
    freezePayload,
  );
  assert.equal(duplicateActivation.ok, false);

  const warnings = await Promise.all(warningEvents);
  assert.deepEqual(
    warnings.map((warning) => warning.playerId).sort(),
    eligibleRunnerIndices.map((index) => playerIds[index]!).sort(),
  );
  assert.ok(
    warnings.every(
      (warning) =>
        warning.roomCode === roomCode &&
        warning.sessionId === sessionId &&
        warning.requestId === freezePayload.requestId &&
        Date.parse(warning.warningEndsAt) -
          Date.parse(warning.warningStartedAt) ===
          3_000,
    ),
  );

  const frozen = await Promise.all(frozenEvents);
  assert.deepEqual(
    frozen.map((event) => event.playerId).sort(),
    eligibleRunnerIndices.map((index) => playerIds[index]!).sort(),
  );
  assert.ok(
    frozen.every(
      (event) =>
        event.roomCode === roomCode &&
        event.sessionId === sessionId &&
        event.requestId === freezePayload.requestId &&
        Date.parse(event.frozenUntil) - Date.parse(event.frozenAt) === 7_000,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (let index = 0; index < players.length; index += 1) {
    const expectedEvents = eligibleRunnerIndices.includes(index) ? 1 : 0;
    assert.equal(received[index]!.warnings.length, expectedEvents);
    assert.equal(received[index]!.frozen.length, expectedEvents);
  }
  assert.equal(received[outOfRangeRunnerIndex]!.warnings.length, 0);
  assert.equal(received[outOfRangeRunnerIndex]!.frozen.length, 0);
});

test("Manhunt Footsteps sockets authorize Hunters and privately deliver direction-only state", async (t) => {
  const { server, url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  const players = await Promise.all(
    Array.from({ length: 3 }, () => connectClient(url, clients)),
  );
  const createResult = await emitWithAck<CreateRoomResponse>(
    players[0]!,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Footsteps Host",
      settings: {
        gameMode: "manhunt",
        maxPlayers: 8,
        isPrivate: false,
      },
    },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) return;

  const roomCode = createResult.data.room.code;
  for (const [index, client] of players.slice(1).entries()) {
    const joinResult = await emitWithAck<JoinRoomResponse>(
      client,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: `Footsteps Player ${index + 1}` },
    );
    assert.equal(joinResult.ok, true);
    if (!joinResult.ok) return;
  }
  const settingsResult = await emitWithAck<RoomUpdatePayload>(
    players[0]!,
    MANHUNT_EVENTS.UPDATE_SETTINGS,
    {
      roomCode,
      settings: {
        hunterCount: 1,
        boundary: {
          center: { latitude: 0, longitude: 0 },
          radiusMeters: 500,
        },
      },
    },
  );
  assert.equal(settingsResult.ok, true);

  const startedEvents = players.map((client) =>
    waitForEvent<GameStartedPayload>(client, GAME_EVENTS.GAME_STARTED),
  );
  const teamAssignments = players.map((client) =>
    waitForEvent<ManhuntTeamAssignmentPayload>(
      client,
      MANHUNT_EVENTS.TEAM_ASSIGNMENT,
    ),
  );
  const startResult = await emitWithAck<void>(
    players[0]!,
    GAME_EVENTS.START_GAME,
    { roomCode },
  );
  assert.equal(startResult.ok, true);
  const started = await Promise.all(startedEvents);
  const assignments = await Promise.all(teamAssignments);
  const sessionId = started[0]!.session.id;
  const hunterIndex = assignments.findIndex(
    (assignment) => assignment.team === "hunter",
  );
  const hiderIndices = assignments.flatMap((assignment, index) =>
    assignment.team === "runner" ? [index] : [],
  );
  assert.notEqual(hunterIndex, -1);
  assert.equal(hiderIndices.length, 2);

  const received = players.map(() => [] as ManhuntFootstepsStatePayload[]);
  players.forEach((client, index) => {
    client.on(MANHUNT_EVENTS.FOOTSTEPS_STATE, (payload) =>
      received[index]!.push(payload),
    );
  });
  const countdownActivation = await emitWithAck<void>(
    players[hunterIndex]!,
    MANHUNT_EVENTS.FOOTSTEPS,
    {
      roomCode,
      sessionId,
      requestId: "00000000-0000-4000-8000-000000000301",
    },
  );
  assert.equal(countdownActivation.ok, false);

  const activeState = waitForEventWhere<GameStateUpdatePayload>(
    players[hunterIndex]!,
    GAME_EVENTS.STATE_UPDATE,
    (payload) =>
      payload.roomCode === roomCode &&
      payload.sessionId === sessionId &&
      "settings" in payload.state &&
      payload.state.phase === "active",
  );
  const activateCountdown = Reflect.get(
    server.manhuntGameService,
    "activateCountdown",
  );
  if (typeof activateCountdown !== "function") {
    throw new Error("Manhunt countdown activation method is unavailable.");
  }
  activateCountdown.call(server.manhuntGameService, roomCode, sessionId);
  await activeState;

  const hunter = players[hunterIndex]!;
  const runnerActivation = await emitWithAck<void>(
    players[hiderIndices[0]!]!,
    MANHUNT_EVENTS.FOOTSTEPS,
    {
      roomCode,
      sessionId,
      requestId: "00000000-0000-4000-8000-000000000302",
    },
  );
  assert.equal(runnerActivation.ok, false);

  const locations = players.map((client, index) =>
    emitWithAck<ManhuntLocationAcknowledgementPayload>(
      client,
      MANHUNT_EVENTS.LOCATION_UPDATE,
      {
        roomCode,
        coordinates: {
          latitude:
            index === hunterIndex
              ? 0
              : index === hiderIndices[0]
                ? 0.00005
                : 0.001,
          longitude: 0,
        },
        accuracyMeters: 1,
      },
    ),
  );
  const locationResults = await Promise.all(locations);
  assert.equal(locationResults.every((result) => result.ok), true);

  const requestId = "00000000-0000-4000-8000-000000000303";
  const guidanceEvent = waitForEventWhere<ManhuntFootstepsStatePayload>(
    hunter,
    MANHUNT_EVENTS.FOOTSTEPS_STATE,
    (payload) =>
      payload.sessionId === sessionId &&
      payload.guidances.some((guidance) => guidance.requestId === requestId),
  );
  const activation = await emitWithAck<void>(
    hunter,
    MANHUNT_EVENTS.FOOTSTEPS,
    { roomCode, sessionId, requestId },
  );
  assert.equal(activation.ok, true);
  const state = await guidanceEvent;
  const guidance = state.guidances[0]!;
  assert.equal(state.playerId, assignments[hunterIndex]!.playerId);
  assert.equal(state.remainingUses, 2);
  assert.equal(
    Date.parse(guidance.expiresAt) - Date.parse(guidance.startedAt),
    3_000,
  );
  assert.deepEqual(
    Object.keys(guidance).sort(),
    ["bearingDegrees", "expiresAt", "requestId", "startedAt"].sort(),
  );
  assert.equal(
    JSON.stringify(state).includes(assignments[hiderIndices[0]!]!.playerId),
    false,
  );
  assert.equal(JSON.stringify(state).includes("coordinates"), false);

  const duplicate = await emitWithAck<void>(
    hunter,
    MANHUNT_EVENTS.FOOTSTEPS,
    { roomCode, sessionId, requestId },
  );
  assert.equal(duplicate.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(received[hiderIndices[0]!]!.length, 0);
  assert.equal(received[hiderIndices[1]!]!.length, 0);
  assert.ok(received[hunterIndex]!.length >= 2);
});

test("Smoke Bomb sockets authorize only Hiders and filter Hunter location flashes", async (t) => {
  const { server, url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  const players = await Promise.all(
    Array.from({ length: 4 }, () => connectClient(url, clients)),
  );
  const createResult = await emitWithAck<CreateRoomResponse>(
    players[0]!,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Smoke Bomb Host",
      settings: {
        gameMode: "manhunt",
        maxPlayers: 8,
        isPrivate: false,
      },
    },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) return;

  const roomCode = createResult.data.room.code;
  for (const [index, client] of players.slice(1).entries()) {
    const joinResult = await emitWithAck<JoinRoomResponse>(
      client,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: `Smoke Bomb Player ${index + 1}` },
    );
    assert.equal(joinResult.ok, true);
    if (!joinResult.ok) return;
  }
  const settingsResult = await emitWithAck<RoomUpdatePayload>(
    players[0]!,
    MANHUNT_EVENTS.UPDATE_SETTINGS,
    {
      roomCode,
      settings: {
        hunterCount: 1,
        boundary: {
          center: { latitude: 0, longitude: 0 },
          radiusMeters: 500,
        },
      },
    },
  );
  assert.equal(settingsResult.ok, true);

  const startedEvents = players.map((client) =>
    waitForEvent<GameStartedPayload>(client, GAME_EVENTS.GAME_STARTED),
  );
  const teamAssignments = players.map((client) =>
    waitForEvent<ManhuntTeamAssignmentPayload>(
      client,
      MANHUNT_EVENTS.TEAM_ASSIGNMENT,
    ),
  );
  const startResult = await emitWithAck<void>(
    players[0]!,
    GAME_EVENTS.START_GAME,
    { roomCode },
  );
  assert.equal(startResult.ok, true);
  const started = await Promise.all(startedEvents);
  const assignments = await Promise.all(teamAssignments);
  const sessionId = started[0]!.session.id;
  const hunterIndex = assignments.findIndex(
    ({ team }) => team === "hunter",
  );
  const hiderIndices = assignments.flatMap((assignment, index) =>
    assignment.team === "runner" ? [index] : [],
  );
  assert.notEqual(hunterIndex, -1);
  assert.equal(hiderIndices.length, 3);

  const smokeStates = players.map(
    () => [] as ManhuntSmokeBombStatePayload[],
  );
  const flashes = players.map(() => [] as LocationFlashPayload[]);
  players.forEach((client, index) => {
    client.on(MANHUNT_EVENTS.SMOKE_BOMB_STATE, (payload) =>
      smokeStates[index]!.push(payload),
    );
    client.on(MANHUNT_EVENTS.LOCATION_FLASH, (payload) =>
      flashes[index]!.push(payload),
    );
  });
  const initialSmokeStates = hiderIndices.map((index) =>
    waitForEventWhere<ManhuntSmokeBombStatePayload>(
      players[index]!,
      MANHUNT_EVENTS.SMOKE_BOMB_STATE,
      (payload) =>
        payload.playerId === assignments[index]!.playerId &&
        payload.remainingUses === 3,
    ),
  );

  const hider = players[hiderIndices[0]!]!;
  const requestId = "00000000-0000-4000-8000-000000000501";
  const duringCountdown = await emitWithAck<void>(
    hider,
    MANHUNT_EVENTS.SMOKE_BOMB,
    { roomCode, sessionId, requestId },
  );
  assert.equal(duringCountdown.ok, false);

  const activeState = waitForEventWhere<GameStateUpdatePayload>(
    players[hunterIndex]!,
    GAME_EVENTS.STATE_UPDATE,
    (payload) =>
      payload.roomCode === roomCode &&
      payload.sessionId === sessionId &&
      "settings" in payload.state &&
      payload.state.phase === "active",
  );
  const activateCountdown = Reflect.get(
    server.manhuntGameService,
    "activateCountdown",
  );
  if (typeof activateCountdown !== "function") {
    throw new Error("Manhunt countdown activation method is unavailable.");
  }
  activateCountdown.call(server.manhuntGameService, roomCode, sessionId);
  await activeState;
  await Promise.all(initialSmokeStates);
  for (const received of smokeStates) {
    received.length = 0;
  }

  const locationResults = await Promise.all(
    players.map((client, index) =>
      emitWithAck<ManhuntLocationAcknowledgementPayload>(
        client,
        MANHUNT_EVENTS.LOCATION_UPDATE,
        {
          roomCode,
          coordinates: {
            latitude:
              index === hunterIndex
                ? 0
                : index === hiderIndices[0]
                  ? 0.00005
                  : 0.001,
            longitude: 0,
          },
          accuracyMeters: 1,
        },
      ),
    ),
  );
  assert.equal(locationResults.every((result) => result.ok), true);

  const privateState = waitForEventWhere<ManhuntSmokeBombStatePayload>(
    hider,
    MANHUNT_EVENTS.SMOKE_BOMB_STATE,
    (payload) => payload.activeEffects.some(
      (effect) => effect.requestId === requestId,
    ),
  );
  const activation = await emitWithAck<void>(
    hider,
    MANHUNT_EVENTS.SMOKE_BOMB,
    { roomCode, sessionId, requestId },
  );
  assert.equal(activation.ok, true);
  const state = await privateState;
  assert.equal(state.playerId, assignments[hiderIndices[0]!]!.playerId);
  assert.equal(state.remainingUses, 2);
  assert.equal(
    Date.parse(state.activeEffects[0]!.expiresAt) -
      Date.parse(state.activeEffects[0]!.startedAt),
    10_000,
  );

  const duplicate = await emitWithAck<void>(
    hider,
    MANHUNT_EVENTS.SMOKE_BOMB,
    { roomCode, sessionId, requestId },
  );
  assert.equal(duplicate.ok, false);

  const openRevealWindow = Reflect.get(
    server.manhuntGameService,
    "openRevealWindow",
  );
  if (typeof openRevealWindow !== "function") {
    throw new Error("Manhunt location reveal method is unavailable.");
  }
  const hunterFlashEvent = waitForEventWhere<LocationFlashPayload>(
    players[hunterIndex]!,
    MANHUNT_EVENTS.LOCATION_FLASH,
    (payload) => payload.sessionId === sessionId,
  );
  const hiderFlashEvent = waitForEventWhere<LocationFlashPayload>(
    players[hiderIndices[0]!]!,
    MANHUNT_EVENTS.LOCATION_FLASH,
    (payload) => payload.sessionId === sessionId,
  );
  openRevealWindow.call(server.manhuntGameService, roomCode);
  const [hunterFlash, hiderFlash] = await Promise.all([
    hunterFlashEvent,
    hiderFlashEvent,
  ]);
  assert.equal(
    hunterFlash.locations.some(
      ({ playerId }) =>
        playerId === assignments[hiderIndices[0]!]!.playerId,
    ),
    false,
  );
  assert.equal(
    hunterFlash.locations.some(
      ({ playerId }) =>
        playerId === assignments[hiderIndices[1]!]!.playerId,
    ),
    true,
  );
  assert.equal(
    hiderFlash.locations.some(
      ({ playerId }) =>
        playerId === assignments[hiderIndices[0]!]!.playerId,
    ),
    true,
  );

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(smokeStates[hunterIndex]!.length, 0);
  assert.equal(smokeStates[hiderIndices[1]!]!.length, 0);
  assert.equal(smokeStates[hiderIndices[2]!]!.length, 0);
  assert.equal(smokeStates[hiderIndices[0]!]!.length, 1);
});

test("Ghost socket requests are Hider-only, private, and fail closed by default", async (t) => {
  const { server, url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  const players = await Promise.all(
    Array.from({ length: 2 }, () => connectClient(url, clients)),
  );
  const createResult = await emitWithAck<CreateRoomResponse>(
    players[0]!,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Ghost Host",
      settings: {
        gameMode: "manhunt",
        maxPlayers: 4,
        isPrivate: false,
      },
    },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) return;

  const roomCode = createResult.data.room.code;
  const joinResult = await emitWithAck<JoinRoomResponse>(
    players[1]!,
    ROOM_EVENTS.JOIN,
    { roomCode, nickname: "Ghost Player" },
  );
  assert.equal(joinResult.ok, true);
  if (!joinResult.ok) return;

  const settingsResult = await emitWithAck<RoomUpdatePayload>(
    players[0]!,
    MANHUNT_EVENTS.UPDATE_SETTINGS,
    {
      roomCode,
      settings: {
        hunterCount: 1,
        boundary: {
          center: { latitude: 0, longitude: 0 },
          radiusMeters: 500,
        },
      },
    },
  );
  assert.equal(settingsResult.ok, true);

  const startedEvents = players.map((client) =>
    waitForEvent<GameStartedPayload>(client, GAME_EVENTS.GAME_STARTED),
  );
  const assignmentEvents = players.map((client) =>
    waitForEvent<ManhuntTeamAssignmentPayload>(
      client,
      MANHUNT_EVENTS.TEAM_ASSIGNMENT,
    ),
  );
  const startResult = await emitWithAck<void>(
    players[0]!,
    GAME_EVENTS.START_GAME,
    { roomCode },
  );
  assert.equal(startResult.ok, true);
  const [started] = await Promise.all(startedEvents);
  const assignments = await Promise.all(assignmentEvents);
  const sessionId = started!.session.id;
  const hiderIndex = assignments.findIndex(({ team }) => team === "runner");
  const hunterIndex = assignments.findIndex(({ team }) => team === "hunter");
  assert.notEqual(hiderIndex, -1);
  assert.notEqual(hunterIndex, -1);

  const countdownResult = await emitWithAck<void>(
    players[hiderIndex]!,
    MANHUNT_EVENTS.GHOST,
    {
      roomCode,
      sessionId,
      requestId: "00000000-0000-4000-8000-000000000701",
    },
  );
  assert.equal(countdownResult.ok, false);
  if (!countdownResult.ok) {
    assert.equal(countdownResult.error.code, "GAME_NOT_ACTIVE");
  }

  const ghostStates = players.map(
    () => [] as ManhuntGhostStatePayload[],
  );
  players.forEach((client, index) => {
    client.on(MANHUNT_EVENTS.GHOST_STATE, (payload) =>
      ghostStates[index]!.push(payload),
    );
  });
  const activeState = waitForEventWhere<GameStateUpdatePayload>(
    players[hunterIndex]!,
    GAME_EVENTS.STATE_UPDATE,
    (payload) =>
      payload.roomCode === roomCode &&
      payload.sessionId === sessionId &&
      "settings" in payload.state &&
      payload.state.phase === "active",
  );
  const privateInitialState = waitForEventWhere<ManhuntGhostStatePayload>(
    players[hiderIndex]!,
    MANHUNT_EVENTS.GHOST_STATE,
    (payload) => payload.sessionId === sessionId,
  );
  const activateCountdown = Reflect.get(
    server.manhuntGameService,
    "activateCountdown",
  );
  if (typeof activateCountdown !== "function") {
    throw new Error("Manhunt countdown activation method is unavailable.");
  }
  activateCountdown.call(server.manhuntGameService, roomCode, sessionId);
  await Promise.all([activeState, privateInitialState]);

  const initialGhostState = ghostStates[hiderIndex]![0]!;
  assert.equal(initialGhostState.playerId, assignments[hiderIndex]!.playerId);
  assert.equal(initialGhostState.usageLimit, null);
  assert.equal(initialGhostState.remainingUses, null);
  assert.deepEqual(initialGhostState.activeEffects, []);

  const hunterResult = await emitWithAck<void>(
    players[hunterIndex]!,
    MANHUNT_EVENTS.GHOST,
    {
      roomCode,
      sessionId,
      requestId: "00000000-0000-4000-8000-000000000702",
    },
  );
  assert.equal(hunterResult.ok, false);
  if (!hunterResult.ok) {
    assert.equal(hunterResult.error.code, "NOT_AUTHORIZED");
  }

  const unavailableResult = await emitWithAck<void>(
    players[hiderIndex]!,
    MANHUNT_EVENTS.GHOST,
    {
      roomCode,
      sessionId,
      requestId: "00000000-0000-4000-8000-000000000703",
    },
  );
  assert.equal(unavailableResult.ok, false);
  if (!unavailableResult.ok) {
    assert.equal(unavailableResult.error.code, "GAME_NOT_READY");
  }

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ghostStates[hunterIndex]!.length, 0);
});

test("Freeze Decoy sockets privately deliver synthetic signals and restore active Hunter snapshots", async (t) => {
  const { server, url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
  });

  const members = await Promise.all(
    Array.from({ length: 4 }, () => connectClient(url, clients)),
  );
  const outsider = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    members[0],
    ROOM_EVENTS.CREATE,
    {
      nickname: "DecoyHost",
      settings: { gameMode: "manhunt", maxPlayers: 4, isPrivate: false },
    },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) return;

  const joins: JoinRoomResponse[] = [];
  for (const [index, member] of members.slice(1).entries()) {
    const joinResult: SocketAcknowledgement<JoinRoomResponse> =
      await emitWithAck<JoinRoomResponse>(
        member,
        ROOM_EVENTS.JOIN,
        {
          roomCode: createResult.data.room.code,
          nickname: `DecoyPlayer${index}`,
        },
      );
    assert.equal(joinResult.ok, true);
    if (!joinResult.ok) return;
    joins.push(joinResult.data);
  }

  const playerIds = [createResult.data.playerId, ...joins.map((join) => join.playerId)];
  const assignmentsByPlayer = new Map<string, ManhuntTeamAssignmentPayload>();
  const freezeDecoyEvents = members.map(() => [] as ManhuntFreezeDecoyStatePayload[]);
  const outsiderDecoyEvents: ManhuntFreezeDecoyStatePayload[] = [];
  outsider.on(MANHUNT_EVENTS.FREEZE_DECOY_STATE, (payload: ManhuntFreezeDecoyStatePayload) => {
    outsiderDecoyEvents.push(payload);
  });
  members.forEach((member, index) => {
    member.on(MANHUNT_EVENTS.TEAM_ASSIGNMENT, (payload: ManhuntTeamAssignmentPayload) => {
      assignmentsByPlayer.set(playerIds[index], payload);
    });
    member.on(MANHUNT_EVENTS.FREEZE_DECOY_STATE, (payload: ManhuntFreezeDecoyStatePayload) => {
      freezeDecoyEvents[index].push(payload);
    });
  });

  const settingsResult = await emitWithAck<RoomUpdatePayload>(
    members[0],
    MANHUNT_EVENTS.UPDATE_SETTINGS,
    {
      roomCode: createResult.data.room.code,
      settings: {
        hunterCount: 2,
        boundary: {
          center: { latitude: 0, longitude: 0 },
          radiusMeters: 500,
        },
      },
    },
  );
  assert.equal(settingsResult.ok, true);
  const startedEvents = members.map((member) =>
    waitForEvent<GameStartedPayload>(member, GAME_EVENTS.GAME_STARTED),
  );
  const assignmentEvents = members.map((member) =>
    waitForEvent<ManhuntTeamAssignmentPayload>(
      member,
      MANHUNT_EVENTS.TEAM_ASSIGNMENT,
    ),
  );
  const startResult = await emitWithAck<void>(
    members[0],
    GAME_EVENTS.START_GAME,
    { roomCode: createResult.data.room.code },
  );
  assert.equal(startResult.ok, true);
  const [started, assignments] = await Promise.all([
    Promise.all(startedEvents),
    Promise.all(assignmentEvents),
  ]);
  assignments.forEach((assignment) => {
    assignmentsByPlayer.set(assignment.playerId, assignment);
  });
  assert.equal(assignmentsByPlayer.size, members.length);

  const hiderIndexes = members
    .map((_, index) => index)
    .filter((index) => assignmentsByPlayer.get(playerIds[index])?.team === "runner");
  const hunterIndexes = members
    .map((_, index) => index)
    .filter((index) => assignmentsByPlayer.get(playerIds[index])?.team === "hunter");
  assert.equal(hiderIndexes.length, 2);
  assert.equal(hunterIndexes.length, 2);
  const sessionId = started[0]!.session.id;
  assert.notEqual(sessionId, "");

  const activeState = waitForEventWhere<GameStateUpdatePayload>(
    members[hunterIndexes[0]],
    GAME_EVENTS.STATE_UPDATE,
    (payload) =>
      payload.sessionId === sessionId &&
      "settings" in payload.state &&
      payload.state.phase === "active",
  );
  const initialUsageStates = hiderIndexes.map((index) =>
    waitForEventWhere<ManhuntFreezeDecoyUsageStatePayload>(
      members[index],
      MANHUNT_EVENTS.FREEZE_DECOY_USAGE_STATE,
      (payload) => payload.remainingUses === 3,
    ),
  );
  const activateCountdown = Reflect.get(
    server.manhuntGameService,
    "activateCountdown",
  );
  assert.equal(typeof activateCountdown, "function");
  if (typeof activateCountdown !== "function") return;
  activateCountdown.call(
    server.manhuntGameService,
    createResult.data.room.code,
    sessionId,
  );
  await Promise.all([activeState, ...initialUsageStates]);

  const hiderIndex = hiderIndexes[0];
  const hunterSnapshots = hunterIndexes.map((index) =>
    waitForEventWhere<ManhuntFreezeDecoyStatePayload>(
      members[index],
      MANHUNT_EVENTS.FREEZE_DECOY_STATE,
      (payload) => payload.sessionId === sessionId && payload.decoys.length === 1,
    ),
  );
  const sourceUsage = waitForEventWhere<ManhuntFreezeDecoyUsageStatePayload>(
    members[hiderIndex],
    MANHUNT_EVENTS.FREEZE_DECOY_USAGE_STATE,
    (payload) => payload.remainingUses === 2,
  );

  const malformedResult = await emitWithAck<void>(
    members[hiderIndex],
    MANHUNT_EVENTS.FREEZE_DECOY,
    {
      roomCode: createResult.data.room.code,
      sessionId,
      requestId: "00000000-0000-4000-8000-00000000a000",
      playerId: playerIds[hiderIndex],
      coordinates: { latitude: 100, longitude: 100 },
    },
  );
  assert.equal(malformedResult.ok, false);

  const hunterResult = await emitWithAck<void>(
    members[hunterIndexes[0]],
    MANHUNT_EVENTS.FREEZE_DECOY,
    {
      roomCode: createResult.data.room.code,
      sessionId,
      requestId: "00000000-0000-4000-8000-00000000a001",
    },
  );
  assert.equal(hunterResult.ok, false);

  const outsiderResult = await emitWithAck<void>(
    outsider,
    MANHUNT_EVENTS.FREEZE_DECOY,
    {
      roomCode: createResult.data.room.code,
      sessionId,
      requestId: "00000000-0000-4000-8000-00000000a002",
    },
  );
  assert.equal(outsiderResult.ok, false);

  const realCoordinates = { latitude: 0.004, longitude: 0 };
  const locationResult = await emitWithAck<ManhuntLocationAcknowledgementPayload>(
    members[hiderIndex],
    MANHUNT_EVENTS.LOCATION_UPDATE,
    {
      roomCode: createResult.data.room.code,
      coordinates: realCoordinates,
      accuracyMeters: 1,
    },
  );
  assert.equal(locationResult.ok, true);

  const activationResult = await emitWithAck<void>(
    members[hiderIndex],
    MANHUNT_EVENTS.FREEZE_DECOY,
    {
      roomCode: createResult.data.room.code,
      sessionId,
      requestId: "00000000-0000-4000-8000-00000000a003",
    },
  );
  assert.equal(activationResult.ok, true);
  const replayResult = await emitWithAck<void>(
    members[hiderIndex],
    MANHUNT_EVENTS.FREEZE_DECOY,
    {
      roomCode: createResult.data.room.code,
      sessionId,
      requestId: "00000000-0000-4000-8000-00000000a003",
    },
  );
  assert.equal(replayResult.ok, false);
  const [hunterPayloads, usagePayload] = await Promise.all([
    Promise.all(hunterSnapshots),
    sourceUsage,
  ]);
  const decoy = hunterPayloads[0].decoys[0];
  assert.ok(decoy);
  assert.deepEqual(hunterPayloads[1].decoys[0], decoy);
  assert.equal(
    new Date(decoy.expiresAt).getTime() - new Date(decoy.startedAt).getTime(),
    10_000,
  );
  assert.equal(usagePayload.remainingUses, 2);
  assert.equal(freezeDecoyEvents[hunterIndexes[0]].length, 1);
  assert.equal(freezeDecoyEvents[hunterIndexes[1]].length, 1);
  assert.equal("playerId" in decoy, false);
  const serializedDecoy = JSON.stringify(decoy);
  assert.equal(serializedDecoy.includes(playerIds[hiderIndex]), false);
  assert.notDeepEqual(decoy.coordinates, realCoordinates);
  for (const index of hiderIndexes) {
    assert.equal(freezeDecoyEvents[index].length, 0);
  }
  assert.equal(outsiderDecoyEvents.length, 0);

  const reconnectIndex = hunterIndexes[0];
  const reconnectCredentials = reconnectIndex === 0
    ? createResult.data
    : joins[reconnectIndex - 1];
  members[reconnectIndex].disconnect();
  const replacementHunter = await connectClient(url, clients);
  const restoredDecoys = waitForEventWhere<ManhuntFreezeDecoyStatePayload>(
    replacementHunter,
    MANHUNT_EVENTS.FREEZE_DECOY_STATE,
    (payload) => payload.sessionId === sessionId && payload.decoys.length === 1,
  );
  const reconnectResult = await emitWithAck<PlayerReconnectedPayload>(
    replacementHunter,
    CONNECTION_EVENTS.RECONNECT,
    {
      roomCode: createResult.data.room.code,
      playerId: playerIds[reconnectIndex],
      reconnectToken: reconnectCredentials.reconnectToken,
    },
  );
  assert.equal(reconnectResult.ok, true);
  const restoredPayload = await restoredDecoys;
  assert.equal(restoredPayload.decoys[0].decoyId, decoy.decoyId);
  assert.equal(restoredPayload.decoys[0].expiresAt, decoy.expiresAt);
});

test("late-game exposure sockets privately deliver identity-free clues and authorized reconnect snapshots", async (t) => {
  const { server, url } = await createTestServer(t, {
    lateGameExposureDurations: {
      clueDurationSeconds: 30,
      warningDurationSeconds: 30,
    },
  });
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
  });
  const members = await Promise.all(
    Array.from({ length: 6 }, () => connectClient(url, clients)),
  );
  const outsider = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    members[0]!,
    ROOM_EVENTS.CREATE,
    {
      nickname: "ExposureHost",
      settings: { gameMode: "manhunt", maxPlayers: 6, isPrivate: false },
    },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) return;

  const joins: JoinRoomResponse[] = [];
  for (const [index, member] of members.slice(1).entries()) {
    const joinResult: SocketAcknowledgement<JoinRoomResponse> =
      await emitWithAck<JoinRoomResponse>(
        member,
        ROOM_EVENTS.JOIN,
        {
          roomCode: createResult.data.room.code,
          nickname: `ExposurePlayer${index}`,
        },
      );
    assert.equal(joinResult.ok, true);
    if (!joinResult.ok) return;
    joins.push(joinResult.data);
  }
  const playerIds = [
    createResult.data.playerId,
    ...joins.map(({ playerId }) => playerId),
  ];
  const assignments = new Map<string, ManhuntTeamAssignmentPayload>();
  const clueEvents = members.map(
    () => [] as ManhuntLateGameClueStatePayload[],
  );
  const warningEvents = members.map(
    () => [] as ManhuntLateGameWarningStatePayload[],
  );
  const outsiderClues: ManhuntLateGameClueStatePayload[] = [];
  const outsiderWarnings: ManhuntLateGameWarningStatePayload[] = [];
  members.forEach((member, index) => {
    member.on(MANHUNT_EVENTS.TEAM_ASSIGNMENT, (payload: ManhuntTeamAssignmentPayload) => {
      assignments.set(playerIds[index]!, payload);
    });
    member.on(MANHUNT_EVENTS.LATE_GAME_CLUE_STATE, (payload: ManhuntLateGameClueStatePayload) => {
      clueEvents[index]!.push(payload);
    });
    member.on(MANHUNT_EVENTS.LATE_GAME_WARNING_STATE, (payload: ManhuntLateGameWarningStatePayload) => {
      warningEvents[index]!.push(payload);
    });
  });
  outsider.on(MANHUNT_EVENTS.LATE_GAME_CLUE_STATE, (payload: ManhuntLateGameClueStatePayload) => {
    outsiderClues.push(payload);
  });
  outsider.on(MANHUNT_EVENTS.LATE_GAME_WARNING_STATE, (payload: ManhuntLateGameWarningStatePayload) => {
    outsiderWarnings.push(payload);
  });

  const settingsResult = await emitWithAck<RoomUpdatePayload>(
    members[0]!,
    MANHUNT_EVENTS.UPDATE_SETTINGS,
    {
      roomCode: createResult.data.room.code,
      settings: {
        hunterCount: 2,
        boundary: {
          center: { latitude: 0, longitude: 0 },
          radiusMeters: 500,
        },
      },
    },
  );
  assert.equal(settingsResult.ok, true);
  const startedEvents = members.map((member) =>
    waitForEvent<GameStartedPayload>(member, GAME_EVENTS.GAME_STARTED),
  );
  const assignmentEvents = members.map((member) =>
    waitForEvent<ManhuntTeamAssignmentPayload>(
      member,
      MANHUNT_EVENTS.TEAM_ASSIGNMENT,
    ),
  );
  const startResult = await emitWithAck<void>(
    members[0]!,
    GAME_EVENTS.START_GAME,
    { roomCode: createResult.data.room.code },
  );
  assert.equal(startResult.ok, true);
  const [started, receivedAssignments] = await Promise.all([
    Promise.all(startedEvents),
    Promise.all(assignmentEvents),
  ]);
  receivedAssignments.forEach((assignment) =>
    assignments.set(assignment.playerId, assignment),
  );
  const hiderIndexes = members
    .map((_, index) => index)
    .filter((index) => assignments.get(playerIds[index]!)?.team === "runner");
  const hunterIndexes = members
    .map((_, index) => index)
    .filter((index) => assignments.get(playerIds[index]!)?.team === "hunter");
  assert.equal(hiderIndexes.length, 4);
  assert.equal(hunterIndexes.length, 2);

  const activateCountdown = Reflect.get(
    server.manhuntGameService,
    "activateCountdown",
  );
  assert.equal(typeof activateCountdown, "function");
  if (typeof activateCountdown !== "function") return;
  activateCountdown.call(
    server.manhuntGameService,
    createResult.data.room.code,
    started[0]!.session.id,
  );

  const locations = hiderIndexes.map((index, locationIndex) =>
    emitWithAck<ManhuntLocationAcknowledgementPayload>(
      members[index]!,
      MANHUNT_EVENTS.LOCATION_UPDATE,
      {
        roomCode: createResult.data.room.code,
        coordinates: {
          latitude: 0.001 + locationIndex * 0.0001,
          longitude: 0,
        },
        accuracyMeters: 1,
      },
    ),
  );
  const locationResults = await Promise.all(locations);
  assert.ok(locationResults.every(({ ok }) => ok));

  const currentGames = Reflect.get(
    server.manhuntGameService,
    "currentGames",
  ) as Map<
    string,
    {
      lateGameLocationHistory: Map<
        string,
        Array<{ recordedAtMs: number }>
      >;
    }
  >;
  const game = currentGames.get(createResult.data.room.code);
  assert.ok(game);
  for (const playerId of playerIds) {
    const history = game.lateGameLocationHistory.get(playerId);
    if (history) {
      history[0]!.recordedAtMs = Date.now() - 60_000;
    }
  }

  const cluePromises = hunterIndexes.map((index) =>
    waitForEventWhere<ManhuntLateGameClueStatePayload>(
      members[index]!,
      MANHUNT_EVENTS.LATE_GAME_CLUE_STATE,
      (payload) => payload.sessionId === started[0]!.session.id && payload.clue !== null,
    ),
  );
  const warningPromises = hiderIndexes.slice(0, 2).map((index) =>
    waitForEventWhere<ManhuntLateGameWarningStatePayload>(
      members[index]!,
      MANHUNT_EVENTS.LATE_GAME_WARNING_STATE,
      (payload) =>
        payload.sessionId === started[0]!.session.id &&
        payload.warning !== null,
    ),
  );
  members[hiderIndexes[2]!]!.disconnect();
  members[hiderIndexes[3]!]!.disconnect();
  const [clues, selectedWarning] = await Promise.all([
    Promise.all(cluePromises),
    Promise.race(warningPromises),
  ]);
  if (!selectedWarning.warning) {
    throw new Error("No connected Hider received the exposure warning.");
  }
  const warning = selectedWarning.warning;
  const selectedHiderIndex = hiderIndexes.find(
    (index) => playerIds[index] === selectedWarning.playerId,
  );
  assert.ok(selectedHiderIndex !== undefined);
  assert.deepEqual(
    clues.map(({ clue }) => clue?.clueId),
    [warning.exposureId, warning.exposureId],
  );
  for (const { clue } of clues) {
    assert.ok(clue);
    assert.equal("playerId" in clue, false);
    assert.equal("nickname" in clue, false);
    assert.equal(JSON.stringify(clue).includes(selectedWarning.playerId), false);
  }
  for (const index of hiderIndexes) {
    assert.equal(warningEvents[index]!.length, index === selectedHiderIndex ? 1 : 0);
    assert.equal(clueEvents[index]!.length, 0);
  }
  for (const index of hunterIndexes) {
    assert.equal(clueEvents[index]!.length, 1);
    assert.equal(warningEvents[index]!.length, 0);
  }
  assert.equal(outsiderClues.length, 0);
  assert.equal(outsiderWarnings.length, 0);

  const reconnectIndex = hunterIndexes[0]!;
  const reconnectCredentials = reconnectIndex === 0
    ? createResult.data
    : joins[reconnectIndex - 1]!;
  members[reconnectIndex]!.disconnect();
  const replacementHunter = await connectClient(url, clients);
  const restoredClue = waitForEventWhere<ManhuntLateGameClueStatePayload>(
    replacementHunter,
    MANHUNT_EVENTS.LATE_GAME_CLUE_STATE,
    (payload) =>
      payload.sessionId === started[0]!.session.id &&
      payload.clue?.clueId === clues[0]!.clue!.clueId,
  );
  const reconnectResult = await emitWithAck<PlayerReconnectedPayload>(
    replacementHunter,
    CONNECTION_EVENTS.RECONNECT,
    {
      roomCode: createResult.data.room.code,
      playerId: playerIds[reconnectIndex],
      reconnectToken: reconnectCredentials.reconnectToken,
    },
  );
  assert.equal(reconnectResult.ok, true);
  const restoredPayload = await restoredClue;
  assert.equal(restoredPayload.clue?.expiresAt, clues[0]!.clue!.expiresAt);
  assert.equal("playerId" in restoredPayload.clue!, false);

  const selectedCredentials = selectedHiderIndex === 0
    ? createResult.data
    : joins[selectedHiderIndex - 1]!;
  members[selectedHiderIndex]!.disconnect();
  const replacementHider = await connectClient(url, clients);
  const restoredWarning = waitForEventWhere<ManhuntLateGameWarningStatePayload>(
    replacementHider,
    MANHUNT_EVENTS.LATE_GAME_WARNING_STATE,
    (payload) =>
      payload.sessionId === started[0]!.session.id &&
      payload.warning?.exposureId === warning.exposureId,
  );
  const hiderReconnectResult = await emitWithAck<PlayerReconnectedPayload>(
    replacementHider,
    CONNECTION_EVENTS.RECONNECT,
    {
      roomCode: createResult.data.room.code,
      playerId: selectedWarning.playerId,
      reconnectToken: selectedCredentials.reconnectToken,
    },
  );
  assert.equal(hiderReconnectResult.ok, true);
  const restoredWarningPayload = await restoredWarning;
  assert.equal(
    restoredWarningPayload.warning?.expiresAt,
    warning.expiresAt,
  );
});

test("both Impostor modes publish disconnect and reconnect eligibility updates", async (t) => {
  const { url, server } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  const runMode = async (
    gameMode: "impostor-classic" | "impostor-word",
  ): Promise<void> => {
    const host = await connectClient(url, clients);
    const guest = await connectClient(url, clients);
    const observer = await connectClient(url, clients);
    const settings =
      gameMode === "impostor-word"
        ? {
            gameMode,
            maxPlayers: 4,
            isPrivate: false,
            wordImpostor: {
              category: "animals",
              impostorCount: 1,
              discussionDurationSeconds: 30,
              votingDurationSeconds: 10,
            },
          }
        : {
            gameMode,
            maxPlayers: 4,
            isPrivate: false,
            classicImpostor: {
              impostorCount: 1,
              discussionDurationSeconds: 30,
              votingDurationSeconds: 10,
            },
          };
    const created = await emitWithAck<CreateRoomResponse>(
      host,
      ROOM_EVENTS.CREATE,
      { nickname: "Host", settings },
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) {
      return;
    }

    const guestJoin = await emitWithAck<JoinRoomResponse>(
      guest,
      ROOM_EVENTS.JOIN,
      { roomCode: created.data.room.code, nickname: "Guest" },
    );
    assert.equal(guestJoin.ok, true);
    if (!guestJoin.ok) {
      return;
    }
    const observerJoin = await emitWithAck<JoinRoomResponse>(
      observer,
      ROOM_EVENTS.JOIN,
      { roomCode: created.data.room.code, nickname: "Observer" },
    );
    assert.equal(observerJoin.ok, true);
    if (!observerJoin.ok) {
      return;
    }

    const discussionState = waitForEventWhere<GameStateUpdatePayload>(
      host,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.roomCode === created.data.room.code &&
        payload.state.phase === "discussion",
    );
    const start = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
      roomCode: created.data.room.code,
    });
    assert.equal(start.ok, true);
    const discussion = await discussionState;
    assert.ok("roundNumber" in discussion.state);
    const discussionDeadline = discussion.state.discussionEndsAt;
    assert.ok(discussionDeadline);
    assert.equal(discussion.state.eligibleVoters, 3);

    const disconnectedState = waitForEventWhere<GameStateUpdatePayload>(
      host,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.sessionId === discussion.sessionId &&
        payload.state.phase === "discussion" &&
        payload.state.eligibleVoters === 2,
    );
    guest.disconnect();
    const afterDisconnect = await disconnectedState;
    assert.ok("roundNumber" in afterDisconnect.state);
    assert.equal(afterDisconnect.state.discussionEndsAt, discussionDeadline);
    assert.equal(server.roomService.getPublicRoom(created.data.room.code)?.gameStatus, "in_progress");

    const replacement = await connectClient(url, clients);
    const restoredState = waitForEventWhere<GameStateUpdatePayload>(
      replacement,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.sessionId === discussion.sessionId &&
        payload.state.phase === "discussion" &&
        payload.state.eligibleVoters === 3,
    );
    const reconnected = await emitWithAck<PlayerReconnectedPayload>(
      replacement,
      CONNECTION_EVENTS.RECONNECT,
      {
        roomCode: created.data.room.code,
        playerId: guestJoin.data.playerId,
        reconnectToken: guestJoin.data.reconnectToken,
      },
    );
    assert.equal(reconnected.ok, true);
    const afterReconnect = await restoredState;
    assert.ok("roundNumber" in afterReconnect.state);
    assert.equal(afterReconnect.state.discussionEndsAt, discussionDeadline);
    assert.equal(afterReconnect.state.votesSubmitted, 0);
    assert.equal(server.roomService.getPublicRoom(created.data.room.code)?.gameStatus, "in_progress");

    const service =
      gameMode === "impostor-word"
        ? server.wordImpostorService
        : server.classicImpostorService;
    const snapshot = service.getResumeSnapshot(
      created.data.room.code,
      guestJoin.data.playerId,
    );
    const snapshotState = snapshot?.state.state;
    assert.ok(snapshotState && "roundNumber" in snapshotState);
    assert.equal(snapshotState.discussionEndsAt, discussionDeadline);
    assert.equal(snapshotState.eligibleVoters, 3);

    const votingState = waitForEventWhere<GameStateUpdatePayload>(
      host,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.sessionId === discussion.sessionId &&
        payload.state.phase === "voting",
    );
    const openedVoting = await votingState;
    assert.ok("roundNumber" in openedVoting.state);
    const votingEndsAt = openedVoting.state.votingEndsAt;
    assert.ok(votingEndsAt);
    const votingPhaseId = openedVoting.state.votingPhaseId;
    assert.ok(votingPhaseId);

    const voteEvent =
      gameMode === "impostor-word"
        ? WORD_IMPOSTOR_EVENTS.VOTE_SUBMISSION
        : IMPOSTOR_EVENTS.VOTE_SUBMISSION;
    const acceptedVote = waitForEventWhere<GameStateUpdatePayload>(
      host,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.sessionId === discussion.sessionId &&
        payload.state.phase === "voting" &&
        payload.state.votesSubmitted === 1,
    );
    replacement.emit(voteEvent, {
      roomCode: created.data.room.code,
      sessionId: discussion.sessionId,
      votingEndsAt,
      votingPhaseId,
      targetPlayerId: created.data.playerId,
    });
    await acceptedVote;

    const disconnectedVoteState = waitForEventWhere<GameStateUpdatePayload>(
      host,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.sessionId === discussion.sessionId &&
        payload.state.phase === "voting" &&
        payload.state.eligibleVoters === 2,
    );
    replacement.disconnect();
    const afterVotingDisconnect = await disconnectedVoteState;
    assert.ok("roundNumber" in afterVotingDisconnect.state);
    assert.equal(afterVotingDisconnect.state.votingEndsAt, votingEndsAt);
    assert.equal(afterVotingDisconnect.state.votesSubmitted, 0);

    const unauthorizedSocket = await connectClient(url, clients);
    const unauthorizedVote = waitForEventWhere<{ code: string }>(
      unauthorizedSocket,
      ERROR_EVENTS.SERVER_ERROR,
      (payload) => payload.code === "NOT_AUTHORIZED",
    );
    unauthorizedSocket.emit(voteEvent, {
      roomCode: created.data.room.code,
      sessionId: discussion.sessionId,
      votingEndsAt,
      votingPhaseId,
      targetPlayerId: created.data.playerId,
    });
    assert.equal((await unauthorizedVote).code, "NOT_AUTHORIZED");

    const votingReplacement = await connectClient(url, clients);
    const restoredVotingState = waitForEventWhere<GameStateUpdatePayload>(
      votingReplacement,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.sessionId === discussion.sessionId &&
        payload.state.phase === "voting" &&
        payload.state.eligibleVoters === 3 &&
        payload.state.votesSubmitted === 1,
    );
    const votingReconnect = await emitWithAck<PlayerReconnectedPayload>(
      votingReplacement,
      CONNECTION_EVENTS.RECONNECT,
      {
        roomCode: created.data.room.code,
        playerId: guestJoin.data.playerId,
        reconnectToken: guestJoin.data.reconnectToken,
      },
    );
    assert.equal(votingReconnect.ok, true);
    const afterVotingReconnect = await restoredVotingState;
    assert.ok("roundNumber" in afterVotingReconnect.state);
    assert.equal(afterVotingReconnect.state.votingEndsAt, votingEndsAt);

    const duplicateVote = waitForEventWhere<{ code: string }>(
      votingReplacement,
      ERROR_EVENTS.SERVER_ERROR,
      (payload) => payload.code === "DUPLICATE_VOTE",
    );
    votingReplacement.emit(voteEvent, {
      roomCode: created.data.room.code,
      sessionId: discussion.sessionId,
      votingEndsAt,
      votingPhaseId,
      targetPlayerId: created.data.playerId,
    });
    assert.equal((await duplicateVote).code, "DUPLICATE_VOTE");
  };

  await Promise.all([
    runMode("impostor-classic"),
    runMode("impostor-word"),
  ]);
});

test("both Impostor socket handlers reject late votes before delayed timers run", async (t) => {
  const { url, server } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  const runMode = async (
    gameMode: "impostor-classic" | "impostor-word",
  ): Promise<void> => {
    const runtime = new DeferredGameRuntime();
    const service =
      gameMode === "impostor-word"
        ? server.wordImpostorService
        : server.classicImpostorService;
    assert.equal(Reflect.set(service, "runtime", runtime), true);

    const host = await connectClient(url, clients);
    const guest = await connectClient(url, clients);
    const observer = await connectClient(url, clients);
    const settings =
      gameMode === "impostor-word"
        ? {
            gameMode,
            maxPlayers: 3,
            isPrivate: false,
            wordImpostor: {
              category: "animals",
              impostorCount: 1,
              discussionDurationSeconds: 30,
              votingDurationSeconds: 10,
            },
          }
        : {
            gameMode,
            maxPlayers: 3,
            isPrivate: false,
            classicImpostor: {
              impostorCount: 1,
              discussionDurationSeconds: 30,
              votingDurationSeconds: 10,
            },
          };
    const created = await emitWithAck<CreateRoomResponse>(
      host,
      ROOM_EVENTS.CREATE,
      { nickname: "Host", settings },
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) return;

    const guestJoin = await emitWithAck<JoinRoomResponse>(
      guest,
      ROOM_EVENTS.JOIN,
      { roomCode: created.data.room.code, nickname: "Guest" },
    );
    assert.equal(guestJoin.ok, true);
    if (!guestJoin.ok) return;
    const observerJoin = await emitWithAck<JoinRoomResponse>(
      observer,
      ROOM_EVENTS.JOIN,
      { roomCode: created.data.room.code, nickname: "Observer" },
    );
    assert.equal(observerJoin.ok, true);
    if (!observerJoin.ok) return;

    const votingState = waitForEventWhere<GameStateUpdatePayload>(
      host,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.roomCode === created.data.room.code &&
        payload.state.phase === "voting",
    );
    const started = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
      roomCode: created.data.room.code,
    });
    assert.equal(started.ok, true, JSON.stringify(started));
    runtime.runNextCallback();
    runtime.runNextCallback();

    const voting = await votingState;
    assert.ok("roundNumber" in voting.state);
    const votingEndsAt = voting.state.votingEndsAt;
    const votingPhaseId = voting.state.votingPhaseId;
    assert.ok(votingEndsAt);
    assert.ok(votingPhaseId);

    const voteEvent =
      gameMode === "impostor-word"
        ? WORD_IMPOSTOR_EVENTS.VOTE_SUBMISSION
        : IMPOSTOR_EVENTS.VOTE_SUBMISSION;
    const acceptedVoteState = waitForEventWhere<GameStateUpdatePayload>(
      host,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.sessionId === voting.sessionId &&
        payload.state.phase === "voting" &&
        payload.state.votesSubmitted === 1,
    );
    runtime.setTime(Date.parse(votingEndsAt) - 1);
    host.emit(voteEvent, {
      roomCode: created.data.room.code,
      sessionId: voting.sessionId,
      votingEndsAt,
      votingPhaseId,
      targetPlayerId: guestJoin.data.playerId,
    });
    await acceptedVoteState;

    runtime.setTime(Date.parse(votingEndsAt));
    const rejectedVote = waitForEventWhere<{ code: string }>(
      host,
      ERROR_EVENTS.SERVER_ERROR,
      (payload) => payload.code === "GAME_NOT_ACTIVE",
    );
    host.emit(voteEvent, {
      roomCode: created.data.room.code,
      sessionId: voting.sessionId,
      votingEndsAt,
      votingPhaseId,
      targetPlayerId: guestJoin.data.playerId,
    });
    assert.equal((await rejectedVote).code, "GAME_NOT_ACTIVE");
    assert.equal(runtime.callbacksRun, 2);
    const history = service.getHistory(voting.sessionId);
    assert.equal(history?.voting.length, 1);
    assert.deepEqual(history?.voting[0]?.votes, [
      {
        voterId: created.data.playerId,
        targetPlayerId: guestJoin.data.playerId,
      },
    ]);
  };

  await Promise.all([
    runMode("impostor-classic"),
    runMode("impostor-word"),
  ]);
});

test("Classic and Word Impostor rooms support host-authorized same-room rematches", async (t) => {
  const { server, url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  const runMode = async (
    gameMode: "impostor-classic" | "impostor-word",
  ): Promise<void> => {
    const host = await connectClient(url, clients);
    const guest = await connectClient(url, clients);
    const observer = await connectClient(url, clients);
    const settings =
      gameMode === "impostor-word"
        ? {
            gameMode,
            maxPlayers: 4,
            isPrivate: false,
            wordImpostor: {
              category: "food" as const,
              impostorCount: 1,
              discussionDurationSeconds: 30,
              votingDurationSeconds: 10,
            },
          }
        : {
            gameMode,
            maxPlayers: 4,
            isPrivate: false,
            classicImpostor: {
              impostorCount: 1,
              discussionDurationSeconds: 30,
              votingDurationSeconds: 10,
            },
          };
    const created = await emitWithAck<CreateRoomResponse>(
      host,
      ROOM_EVENTS.CREATE,
      { nickname: "Host", settings },
    );
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) return;

    const roomCode = created.data.room.code;
    const guestJoin = await emitWithAck<JoinRoomResponse>(
      guest,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: "Guest" },
    );
    const observerJoin = await emitWithAck<JoinRoomResponse>(
      observer,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: "Observer" },
    );
    assert.equal(guestJoin.ok, true);
    assert.equal(observerJoin.ok, true);
    if (!guestJoin.ok || !observerJoin.ok) return;

    const firstStartedEvent = waitForEvent<GameStartedPayload>(
      host,
      GAME_EVENTS.GAME_STARTED,
    );
    const firstVotingState = waitForEventWhere<GameStateUpdatePayload>(
      host,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.roomCode === roomCode && payload.state.phase === "voting",
    );
    const startFirst = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
      roomCode,
    });
    assert.equal(startFirst.ok, true);
    const firstStarted = await firstStartedEvent;
    const oldSessionId = firstStarted.session.id;
    const activeReset = await emitWithAck<RoomUpdatePayload>(
      host,
      ROOM_EVENTS.RETURN_TO_LOBBY,
      { roomCode },
    );
    assert.equal(activeReset.ok, false);
    if (!activeReset.ok) {
      assert.equal(activeReset.error.code, "GAME_NOT_ACTIVE");
    }
    const firstVoting = await firstVotingState;
    assert.ok("roundNumber" in firstVoting.state);
    const oldVotingEndsAt = firstVoting.state.votingEndsAt;
    assert.ok(oldVotingEndsAt);
    const oldVotingPhaseId = firstVoting.state.votingPhaseId;
    assert.ok(oldVotingPhaseId);

    const voteEvent =
      gameMode === "impostor-word"
        ? WORD_IMPOSTOR_EVENTS.VOTE_SUBMISSION
        : IMPOSTOR_EVENTS.VOTE_SUBMISSION;
    const firstGameEnded = waitForEvent<{
      result: { gameId: string; gameMode: string };
    }>(host, GAME_EVENTS.GAME_ENDED);
    host.emit(voteEvent, {
      roomCode,
      sessionId: oldSessionId,
      votingEndsAt: oldVotingEndsAt,
      votingPhaseId: oldVotingPhaseId,
      targetPlayerId: guestJoin.data.playerId,
    });
    guest.emit(voteEvent, {
      roomCode,
      sessionId: oldSessionId,
      votingEndsAt: oldVotingEndsAt,
      votingPhaseId: oldVotingPhaseId,
      targetPlayerId: created.data.playerId,
    });
    observer.emit(voteEvent, {
      roomCode,
      sessionId: oldSessionId,
      votingEndsAt: oldVotingEndsAt,
      votingPhaseId: oldVotingPhaseId,
      targetPlayerId: guestJoin.data.playerId,
    });
    assert.equal((await firstGameEnded).result.gameMode, gameMode);

    const directRestart = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
      roomCode,
    });
    assert.equal(directRestart.ok, false);
    if (!directRestart.ok) {
      assert.equal(directRestart.error.code, "GAME_NOT_ACTIVE");
    }

    const nonHostReset = await emitWithAck<RoomUpdatePayload>(
      guest,
      ROOM_EVENTS.RETURN_TO_LOBBY,
      { roomCode },
    );
    assert.equal(nonHostReset.ok, false);
    if (!nonHostReset.ok) {
      assert.equal(nonHostReset.error.code, "NOT_AUTHORIZED");
    }

    const waitingUpdates = [host, guest, observer].map((client) =>
      waitForEventWhere<RoomUpdatePayload>(
        client,
        ROOM_EVENTS.UPDATE,
        (payload) =>
          payload.room.code === roomCode &&
          payload.room.gameStatus === "waiting",
      ),
    );
    const hostReset = await emitWithAck<RoomUpdatePayload>(
      host,
      ROOM_EVENTS.RETURN_TO_LOBBY,
      { roomCode },
    );
    assert.equal(hostReset.ok, true, JSON.stringify(hostReset));
    if (!hostReset.ok) return;
    const lobby = hostReset.data.room;
    assert.equal(lobby.code, roomCode);
    assert.equal(lobby.hostId, created.data.playerId);
    assert.equal(lobby.gameStatus, "waiting");
    assert.equal(lobby.currentGameId, undefined);
    assert.deepEqual(
      lobby.players.map((player) => player.id),
      [
        created.data.playerId,
        guestJoin.data.playerId,
        observerJoin.data.playerId,
      ],
    );
    assert.deepEqual(lobby.settings, created.data.room.settings);
    for (const update of await Promise.all(waitingUpdates)) {
      assert.equal(update.room.currentGameId, undefined);
      assert.ok(update.room.players.every((player) => player.status === "waiting"));
    }

    observer.disconnect();
    const replacement = await connectClient(url, clients);
    const reconnect = await emitWithAck<PlayerReconnectedPayload>(
      replacement,
      CONNECTION_EVENTS.RECONNECT,
      {
        roomCode,
        playerId: observerJoin.data.playerId,
        reconnectToken: observerJoin.data.reconnectToken,
      },
    );
    assert.equal(reconnect.ok, true);
    assert.equal(
      server.roomService.getPublicRoom(roomCode)?.players.find(
        (player) => player.id === observerJoin.data.playerId,
      )?.connectionStatus,
      "connected",
    );

    const changedSettings =
      gameMode === "impostor-word"
        ? {
            ...lobby.settings,
            wordImpostor: {
              ...lobby.settings.wordImpostor!,
              votingDurationSeconds: 15,
            },
          }
        : {
            ...lobby.settings,
            classicImpostor: {
              ...lobby.settings.classicImpostor!,
              votingDurationSeconds: 15,
            },
          };
    const settingsUpdate = await emitWithAck<RoomUpdatePayload>(
      host,
      ROOM_EVENTS.UPDATE_SETTINGS,
      { roomCode, settings: changedSettings },
    );
    assert.equal(settingsUpdate.ok, true, JSON.stringify(settingsUpdate));

    const secondStartedEvents = [
      waitForEvent<GameStartedPayload>(host, GAME_EVENTS.GAME_STARTED),
      waitForEvent<GameStartedPayload>(guest, GAME_EVENTS.GAME_STARTED),
      waitForEvent<GameStartedPayload>(replacement, GAME_EVENTS.GAME_STARTED),
    ];
    const secondVotingState = waitForEventWhere<GameStateUpdatePayload>(
      host,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.roomCode === roomCode &&
        payload.state.phase === "voting" &&
        payload.sessionId !== oldSessionId,
    );
    const startSecond = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
      roomCode,
    });
    assert.equal(startSecond.ok, true);
    const [hostStarted, guestStarted, replacementStarted] = await Promise.all(
      secondStartedEvents,
    );
    const newSessionId = hostStarted.session.id;
    assert.notEqual(newSessionId, oldSessionId);
    assert.equal(hostStarted.session.gameMode, gameMode);
    assert.equal(guestStarted.session.id, newSessionId);
    assert.equal(replacementStarted.session.id, newSessionId);
    const secondVoting = await secondVotingState;
    assert.ok("roundNumber" in secondVoting.state);
    const newVotingEndsAt = secondVoting.state.votingEndsAt;
    assert.ok(newVotingEndsAt);
    const newVotingPhaseId = secondVoting.state.votingPhaseId;
    assert.ok(newVotingPhaseId);

    const staleVoteError = waitForEventWhere<{ code: string }>(
      host,
      ERROR_EVENTS.SERVER_ERROR,
      (payload) => payload.code === "GAME_NOT_ACTIVE",
    );
    host.emit(voteEvent, {
      roomCode,
      sessionId: oldSessionId,
      votingEndsAt: oldVotingEndsAt,
      votingPhaseId: oldVotingPhaseId,
      targetPlayerId: guestJoin.data.playerId,
    });
    assert.equal((await staleVoteError).code, "GAME_NOT_ACTIVE");
    const activeService =
      gameMode === "impostor-word"
        ? server.wordImpostorService
        : server.classicImpostorService;
    const activeGameState = activeService.getResumeSnapshot(
      roomCode,
      created.data.playerId,
    )?.state.state;
    assert.ok(activeGameState && "roundNumber" in activeGameState);
    assert.equal(activeGameState.phase, "voting");
    assert.equal(activeGameState.votesSubmitted, 0);

    const acceptedNewVote = waitForEventWhere<GameStateUpdatePayload>(
      host,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.sessionId === newSessionId &&
        payload.state.phase === "voting" &&
        payload.state.votesSubmitted === 1,
    );
    host.emit(voteEvent, {
      roomCode,
      sessionId: newSessionId,
      votingEndsAt: newVotingEndsAt,
      votingPhaseId: newVotingPhaseId,
      targetPlayerId: guestJoin.data.playerId,
    });
    await acceptedNewVote;
  };

  await Promise.all([
    runMode("impostor-classic"),
    runMode("impostor-word"),
  ]);
});

test("Word Impostor sockets enforce host start and privately restore each player's role", async (t) => {
  const { server, url } = await createTestServer(t);
    const clients: TestClient[] = [];
    t.after(() => {
      for (const client of clients) {
        client.disconnect();
      }
    });
    const host = await connectClient(url, clients);
    const guest = await connectClient(url, clients);
    const thirdPlayer = await connectClient(url, clients);
    const createResult = await emitWithAck<CreateRoomResponse>(
      host,
      ROOM_EVENTS.CREATE,
      {
        nickname: "Host",
        settings: {
          gameMode: "impostor-word",
          maxPlayers: 8,
          isPrivate: false,
          wordImpostor: {
            category: "food",
            impostorCount: 1,
            discussionDurationSeconds: 30,
            votingDurationSeconds: 10,
          },
        },
      },
    );
    assert.equal(createResult.ok, true);
    if (!createResult.ok) {
      return;
    }
    const roomCode = createResult.data.room.code;
    const guestJoin = await emitWithAck<JoinRoomResponse>(
      guest,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: "Guest" },
    );
    assert.equal(guestJoin.ok, true);
    if (!guestJoin.ok) {
      return;
    }

    const tooFewResult = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
      roomCode,
    });
    assert.equal(tooFewResult.ok, false);
    if (!tooFewResult.ok) {
      assert.equal(tooFewResult.error.code, "GAME_NOT_READY");
    }

    const thirdJoin = await emitWithAck<JoinRoomResponse>(
      thirdPlayer,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: "Third" },
    );
    assert.equal(thirdJoin.ok, true);
    if (!thirdJoin.ok) {
      return;
    }
    const nonHostResult = await emitWithAck<void>(
      guest,
      GAME_EVENTS.START_GAME,
      { roomCode },
    );
    assert.equal(nonHostResult.ok, false);
    if (!nonHostResult.ok) {
      assert.equal(nonHostResult.error.code, "NOT_AUTHORIZED");
    }

    const startedEvents = [
      waitForEvent<GameStartedPayload>(host, GAME_EVENTS.GAME_STARTED),
      waitForEvent<GameStartedPayload>(guest, GAME_EVENTS.GAME_STARTED),
      waitForEvent<GameStartedPayload>(thirdPlayer, GAME_EVENTS.GAME_STARTED),
    ];
    const startResult = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
      roomCode,
    });
    assert.equal(startResult.ok, true);
    const [hostStarted, guestStarted, thirdStarted] = await Promise.all(
      startedEvents,
    );
    const sessionId = hostStarted.session.id;
    assert.equal(guestStarted.session.id, sessionId);
    assert.equal(thirdStarted.session.id, sessionId);
    assert.equal(hostStarted.session.gameMode, "impostor-word");

    const roleCounts = [0, 0, 0];
    const roleClients = [host, guest, thirdPlayer];
    roleClients.forEach((client, index) => {
      client.on(WORD_IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, () => {
        roleCounts[index] = (roleCounts[index] ?? 0) + 1;
      });
    });
    const roleEvents = roleClients.map((client) =>
      waitForEvent<WordImpostorRoleAssignmentPayload>(
        client,
        WORD_IMPOSTOR_EVENTS.ROLE_ASSIGNMENT,
      ),
    );
    roleClients.forEach((client) => {
      client.emit(WORD_IMPOSTOR_EVENTS.ROLE_REQUEST, {
        roomCode,
        sessionId,
      });
    });
    const assignments = await Promise.all(roleEvents);
    assert.equal(
      assignments.filter((assignment) => assignment.role === "impostor").length,
      1,
    );
    const civilianWords = assignments.flatMap((assignment) =>
      assignment.role === "civilian" ? [assignment.secretWord] : [],
    );
    assert.equal(new Set(civilianWords).size, 1);
    assert.equal(
      assignments.every(
        (assignment) =>
          assignment.role !== "impostor" || !("secretWord" in assignment),
      ),
      true,
    );
    assert.deepEqual(roleCounts, [1, 1, 1]);
    assert.equal(
      JSON.stringify(server.roomService.getPublicRoom(roomCode)).includes(
        civilianWords[0] ?? "",
      ),
      false,
    );

    const invalidRoleRequest = waitForEvent<ValidationErrorPayload>(
      guest,
      ERROR_EVENTS.VALIDATION_ERROR,
    );
    guest.emit(WORD_IMPOSTOR_EVENTS.ROLE_REQUEST, {
      roomCode,
      sessionId,
      playerId: createResult.data.playerId,
    });
    assert.equal((await invalidRoleRequest).code, "INVALID_PAYLOAD");

    const invalidVotePayload = waitForEvent<ValidationErrorPayload>(
      guest,
      ERROR_EVENTS.VALIDATION_ERROR,
    );
    guest.emit(WORD_IMPOSTOR_EVENTS.VOTE_SUBMISSION, {
      roomCode,
      sessionId,
      targetPlayerId: createResult.data.playerId,
      voterId: createResult.data.playerId,
    });
    assert.equal((await invalidVotePayload).code, "INVALID_PAYLOAD");

    const guestRole = assignments[1];
    assert.ok(guestRole);
    guest.disconnect();
    const replacement = await connectClient(url, clients);
    const resumedStart = waitForEvent<GameStartedPayload>(
      replacement,
      GAME_EVENTS.GAME_STARTED,
    );
    const resumedState = waitForEvent<GameStateUpdatePayload>(
      replacement,
      GAME_EVENTS.STATE_UPDATE,
    );
    const resumedRole = waitForEvent<WordImpostorRoleAssignmentPayload>(
      replacement,
      WORD_IMPOSTOR_EVENTS.ROLE_ASSIGNMENT,
    );
    const reconnectResult = await emitWithAck<PlayerReconnectedPayload>(
      replacement,
      CONNECTION_EVENTS.RECONNECT,
      {
        roomCode,
        playerId: guestJoin.data.playerId,
        reconnectToken: guestJoin.data.reconnectToken,
      },
    );
    assert.equal(reconnectResult.ok, true);
    assert.equal((await resumedStart).session.id, sessionId);
    assert.equal((await resumedState).sessionId, sessionId);
    assert.deepEqual(await resumedRole, guestRole);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(roleCounts, [1, 1, 1]);
  });

test("repeated join attempts are rate-limited independently of room capacity", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });
  const host = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Host",
      settings: {
        gameMode: "impostor-classic",
        maxPlayers: 12,
        isPrivate: false,
      },
    },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }

  for (let attempt = 0; attempt < 13; attempt += 1) {
    const client = await connectClient(url, clients);
    const result: SocketAcknowledgement<JoinRoomResponse> =
      await emitWithAck<JoinRoomResponse>(
      client,
      ROOM_EVENTS.JOIN,
      {
        roomCode: createResult.data.room.code,
        nickname: `Guest ${attempt}`,
      },
    );
    if (attempt < 11) {
      assert.equal(result.ok, true);
    } else if (attempt === 11) {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "ROOM_FULL");
      }
    } else {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error.message, /Too many attempts/);
      }
    }
  }
});
