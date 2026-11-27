import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import type { PoolClient, PoolConfig } from "pg";
import {
  DEFAULT_DISCUSSION_DURATION_SECONDS,
  DEFAULT_IMPOSTOR_COUNT,
  DEFAULT_VOTING_DURATION_SECONDS,
} from "@impostor/api";
import type {
  GameSessionId,
  PlayerId,
  RoomCode,
  RoomSettings,
} from "@impostor/api";
import {
  acquireRoomRuntimeLease,
  createPostgresPool,
  RoomRuntimeLeaseLostError,
  RoomRuntimeLeaseUnavailableError,
  type RoomRuntimeLease,
} from "../db/postgres.js";
import { PostgresRoomRepository } from "./postgres-room-repository.js";
import type {
  CreatedRoomInfo,
  CreateRoomWithHostInput,
  PrepareForRuntimeRecoveryInput,
  RecoverableWaitingRoom,
  RuntimeRecoverySummary,
} from "./postgres-room-repository.js";
import {
  RoomJoinError,
  RoomRuntimeFencingError,
} from "./postgres-room-repository.js";
import { RoomPersistenceCommands } from "./room-persistence-commands.js";
import { RoomPersistenceCoordinator } from "./room-persistence-coordinator.js";
import {
  DurableRoomRuntime,
  type DurableRoomRuntimeDependencies,
  type DurableRoomRuntimeServices,
} from "./durable-room-runtime.js";
import { RoomService } from "./room-service.js";
import { AppError } from "../utils/app-error.js";

const TEST_POOL_CONFIG: PoolConfig = {
  host: "127.0.0.1",
  port: 55432,
  database: "unused_runtime_test",
  user: "unused_runtime_test",
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const ROOM_RUNTIME_LOCK_KEY_1 = 0x524F4F4D;
const ROOM_RUNTIME_LOCK_KEY_2 = 0x52554E54;

function runtimeIntegrationPoolConfig(
  database: string,
  user: string,
): PoolConfig {
  return {
    host: "127.0.0.1",
    port: 55432,
    database,
    user,
    password: "local-trust-auth-only",
    max: 8,
  };
}

async function waitForNextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForRuntimeReadiness(
  runtime: DurableRoomRuntime,
  expected: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (runtime.readiness === expected) {
      return;
    }
    await waitForNextEventLoopTurn();
  }
  assert.fail(`Runtime did not reach readiness state ${expected}.`);
}

async function waitForPostgresLockWait(
  pool: Pool,
  queryPattern: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const waiting = await pool.query<{ pid: number }>(
      `SELECT pid
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'
         AND query LIKE $1
       ORDER BY pid
       LIMIT 1`,
      [`%${queryPattern}%`],
    );
    if (waiting.rowCount && waiting.rowCount > 0) {
      return;
    }
    await waitForNextEventLoopTurn();
  }
  assert.fail(`No PostgreSQL lock wait observed for ${queryPattern}.`);
}

async function currentRuntimeFencingEpoch(pool: Pool): Promise<bigint> {
  const result = await pool.query<{ epoch: string }>(
    `SELECT epoch::text
     FROM public.room_runtime_fencing
     WHERE singleton_id = 1`,
  );
  const epoch = result.rows[0]?.epoch;
  assert.ok(epoch);
  return BigInt(epoch);
}

function createdInfo(input: CreateRoomWithHostInput): CreatedRoomInfo {
  return {
    roomId: input.roomId,
    roomCode: input.roomCode,
    gameMode: input.gameMode,
    hostPlayerId: input.hostPlayerId,
    lifecycleStatus: "active",
    currentGameId: null,
    version: "1",
  };
}

class LifecycleTestPool extends Pool {
  endCalls = 0;

  override async end(): Promise<void> {
    this.endCalls += 1;
  }
}

class LifecycleTestRepository extends PostgresRoomRepository {
  readonly recoveryInputs: PrepareForRuntimeRecoveryInput[] = [];
  prepareBarrier?: Promise<void>;
  onPrepare?: () => void;
  loadFailure?: Error;
  recoveredRooms: RecoverableWaitingRoom[] = [];
  prepareCalls = 0;
  loadCalls = 0;
  readonly recoveryOrder: string[] = [];
  readonly expirationBatchSizes: number[] = [];
  readonly expiredRoomCodes = new Set<RoomCode>();
  expiredRowsRemaining = 0;

  override async prepareForRuntimeRecovery(
    input: PrepareForRuntimeRecoveryInput,
  ): Promise<RuntimeRecoverySummary> {
    this.prepareCalls += 1;
    this.recoveryOrder.push("prepare");
    this.recoveryInputs.push(input);
    this.onPrepare?.();
    await this.prepareBarrier;
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

  override async loadRecoverableWaitingRooms(): Promise<RecoverableWaitingRoom[]> {
    this.loadCalls += 1;
    this.recoveryOrder.push("load");
    if (this.loadFailure) {
      throw this.loadFailure;
    }
    return this.recoveredRooms.filter(
      (room) => !this.expiredRoomCodes.has(room.roomCode),
    );
  }

  override async expireDueWaitingRooms(limit: number): Promise<number> {
    this.recoveryOrder.push("expire");
    this.expirationBatchSizes.push(limit);
    const expired = Math.min(limit, this.expiredRowsRemaining);
    this.expiredRowsRemaining -= expired;
    return expired;
  }
}

const RECOVERY_INPUT: PrepareForRuntimeRecoveryInput = {
  now: new Date("2026-01-01T00:00:00.000Z"),
  reconnectGracePeriodMs: 60_000,
};

function createLease(
  events: string[],
  releaseError?: Error,
  checkOwnership: () => Promise<void> = async () => {},
): {
  lease: RoomRuntimeLease;
  get releaseCalls(): number;
  notifyLost(error?: RoomRuntimeLeaseLostError): void;
} {
  let releaseCalls = 0;
  const listeners = new Set<(error: RoomRuntimeLeaseLostError) => void>();
  return {
    lease: {
      fencingEpoch: "1",
      checkOwnership,
      onLost(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async release() {
        releaseCalls += 1;
        events.push("lease:release");
        if (releaseError) {
          throw releaseError;
        }
      },
    },
    get releaseCalls() {
      return releaseCalls;
    },
    notifyLost(error = new RoomRuntimeLeaseLostError("test_lease_loss")) {
      for (const listener of listeners) {
        listener(error);
      }
    },
  };
}

function createDependencies(
  events: string[],
  pool: Pool,
  lease: RoomRuntimeLease,
  overrides: Partial<DurableRoomRuntimeDependencies> = {},
): DurableRoomRuntimeDependencies {
  return {
    createPool: () => {
      events.push("pool:create");
      return pool;
    },
    createRepository: (createdPool) => {
      events.push("repository:create");
      return new LifecycleTestRepository(createdPool);
    },
    createCoordinator: () => {
      events.push("coordinator:create");
      return new RoomPersistenceCoordinator();
    },
    acquireLease: async () => {
      events.push("lease:acquire");
      return lease;
    },
    createCommands: (rooms, repository, coordinator) => {
      events.push("commands:create");
      return new RoomPersistenceCommands(rooms, repository, coordinator);
    },
    closePool: async (createdPool) => {
      events.push("pool:close");
      await createdPool.end();
    },
    scheduleHealthChecks: () => () => {},
    scheduleReconciliationRetry: () => () => {},
    scheduleExpirationCleanup: () => () => {},
    healthCheckIntervalMs: 1_000,
    ...overrides,
  };
}

function createRecoveredWaitingRoom(
  reconnectDeadlineAt: Date,
): RecoverableWaitingRoom {
  const roomCode = "RCRV" as RoomCode;
  const hostId = "recovered-timeout-host" as PlayerId;
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  return {
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
        impostorCount: DEFAULT_IMPOSTOR_COUNT,
        discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
        votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
      },
    },
    maxPlayers: 8,
    hostPlayerId: hostId,
    createdAt,
    updatedAt: createdAt,
    expiresAt: null,
    version: "1",
    currentGameId: null,
    members: [
      {
        playerId: hostId,
        nickname: "Recovered host",
        membershipStatus: "active",
        connectionStatus: "disconnected",
        joinedAt: createdAt,
        disconnectGeneration: "4",
        reconnectDeadlineAt,
        reconnectTokenHash: Buffer.alloc(32),
      },
    ],
    privateManhuntBoundary: null,
  };
}

function statusTransitionCommand(roomCode: RoomCode = "ABCD" as RoomCode) {
  return {
    roomCode,
    expectedStatus: "waiting" as const,
    nextStatus: "starting" as const,
    expectedCurrentGameId: null,
    nextGameId: "runtime-gated-game" as GameSessionId,
    initiatedBy: {
      kind: "host" as const,
      playerId: "runtime-gated-host" as PlayerId,
    },
  };
}

test("constructs resources before recovery and exposes commands only after recovery", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  let resolveLease!: (lease: RoomRuntimeLease) => void;
  const leasePromise = new Promise<RoomRuntimeLease>((resolve) => {
    resolveLease = resolve;
  });
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      acquireLease: () => {
        events.push("lease:acquire");
        return leasePromise;
      },
    }),
  );

  const initialization = runtime.initialize();
  await Promise.resolve();
  assert.deepEqual(events, [
    "pool:create",
    "repository:create",
    "coordinator:create",
    "lease:acquire",
  ]);
  assert.equal(runtime.readiness, "initializing");
  assert.equal(runtime.isResourceReady, false);
  assert.throws(() => runtime.services, /not ready/);
  assert.throws(
    () => runtime.services.commands.transitionRoomGameStatus(
      statusTransitionCommand(),
    ),
    /not ready/,
  );

  resolveLease(lease.lease);
  await initialization;
  assert.deepEqual(events, [
    "pool:create",
    "repository:create",
    "coordinator:create",
    "lease:acquire",
    "commands:create",
  ]);
  assert.equal(runtime.readiness, "resources_ready");
  assert.equal(runtime.isResourceReady, true);
  assert.equal(runtime.isServingReady, false);
  assert.throws(() => runtime.services, /not ready/);
  assert.throws(
    () => runtime.services.commands.transitionRoomGameStatus(
      statusTransitionCommand(),
    ),
    /not ready/,
  );

  const services = await runtime.recover(RECOVERY_INPUT);
  assert.deepEqual(events, [
    "pool:create",
    "repository:create",
    "coordinator:create",
    "lease:acquire",
    "commands:create",
  ]);
  assert.equal(runtime.readiness, "serving_ready");
  assert.equal(runtime.isServingReady, true);
  assert.strictEqual(runtime.services, services);
  assert.ok(services.commands instanceof RoomPersistenceCommands);

  await runtime.close();
});

test("recovery restores disconnected deadlines for the socket timeout owner", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const repository = new LifecycleTestRepository(pool);
  repository.recoveredRooms = [
    createRecoveredWaitingRoom(
      new Date(RECOVERY_INPUT.now.getTime() + 60_000),
    ),
  ];
  const recoveryBarrier = deferred<void>();
  const preparationStarted = deferred<void>();
  repository.prepareBarrier = recoveryBarrier.promise;
  repository.onPrepare = () => preparationStarted.resolve();
  const rooms = new RoomService();
  const runtime = new DurableRoomRuntime(
    rooms,
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createRepository: () => repository,
    }),
  );
  await runtime.initialize();

  const recovery = runtime.recover(RECOVERY_INPUT);
  await preparationStarted.promise;
  assert.equal(runtime.readiness, "recovering");
  assert.equal(rooms.getPublicRoom("RCRV" as RoomCode), undefined);

  recoveryBarrier.resolve();
  await recovery;
  assert.equal(runtime.readiness, "serving_ready");
  assert.ok(rooms.getPublicRoom("RCRV" as RoomCode));
  assert.deepEqual(rooms.listDisconnectedPlayerTimeouts().map((timeout) => ({
    roomCode: timeout.roomCode,
    playerId: timeout.playerId,
    disconnectGeneration: timeout.disconnectGeneration,
    reconnectDeadlineAt: timeout.reconnectDeadlineAt,
  })), [{
    roomCode: "RCRV",
    playerId: "recovered-timeout-host",
    disconnectGeneration: "4",
    reconnectDeadlineAt: new Date(RECOVERY_INPUT.now.getTime() + 60_000),
  }]);

  await runtime.close();
});

test("startup recovery does not restore an interrupted active-room snapshot", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const repository = new LifecycleTestRepository(pool);
  const waitingRoom = createRecoveredWaitingRoom(
    new Date(RECOVERY_INPUT.now.getTime() + 60_000),
  );
  repository.recoveredRooms = [waitingRoom];
  const interruptedRoomCode = "OLDG" as RoomCode;
  let interruptedLifecycleStatus = "active";
  const prepareForRuntimeRecovery =
    repository.prepareForRuntimeRecovery.bind(repository);
  repository.prepareForRuntimeRecovery = async (input) => {
    const summary = await prepareForRuntimeRecovery(input);
    interruptedLifecycleStatus = "closed";
    return {
      ...summary,
      nonWaitingRoomsClosed: 1,
      closedRooms: [{
        roomId: "10000000-0000-4000-8000-000000000002",
        roomCode: interruptedRoomCode,
      }],
    };
  };
  repository.loadRecoverableWaitingRooms = async () => {
    repository.loadCalls += 1;
    repository.recoveryOrder.push("load");
    assert.equal(interruptedLifecycleStatus, "closed");
    return repository.recoveredRooms;
  };
  const rooms = new RoomService();
  const runtime = new DurableRoomRuntime(
    rooms,
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createRepository: () => repository,
    }),
  );
  await runtime.initialize();
  await runtime.recover(RECOVERY_INPUT);

  assert.deepEqual(repository.recoveryOrder, ["expire", "prepare", "load"]);
  assert.equal(rooms.getPublicRoom(interruptedRoomCode), undefined);
  assert.equal(
    rooms.getPublicRoom(waitingRoom.roomCode)?.gameStatus,
    "waiting",
  );
  await runtime.close();
});

test("recovery expires due waiting rooms in bounded batches before loading rooms", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const repository = new LifecycleTestRepository(pool);
  const expiredRoom = createRecoveredWaitingRoom(
    new Date(RECOVERY_INPUT.now.getTime() + 60_000),
  );
  expiredRoom.expiresAt = new Date(RECOVERY_INPUT.now.getTime() - 1);
  repository.recoveredRooms = [expiredRoom];
  repository.expiredRoomCodes.add(expiredRoom.roomCode);
  repository.expiredRowsRemaining = 51;
  const rooms = new RoomService();
  const runtime = new DurableRoomRuntime(
    rooms,
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createRepository: () => repository,
    }),
  );
  await runtime.initialize();
  await runtime.recover(RECOVERY_INPUT);

  assert.deepEqual(repository.expirationBatchSizes, [50, 50]);
  assert.deepEqual(repository.recoveryOrder, [
    "expire",
    "expire",
    "prepare",
    "load",
  ]);
  assert.equal(rooms.getPublicRoom(expiredRoom.roomCode), undefined);
  assert.equal(runtime.isServingReady, true);
  await runtime.close();
});

test("lease loss cancels the sole scheduled room expiration cleanup", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  let cleanupCallback: (() => void) | undefined;
  let cancelCalls = 0;
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      scheduleExpirationCleanup: (callback) => {
        cleanupCallback = callback;
        return () => {
          cancelCalls += 1;
        };
      },
    }),
  );
  await runtime.initialize();
  await runtime.recover(RECOVERY_INPUT);
  assert.ok(cleanupCallback);

  lease.notifyLost();
  assert.equal(cancelCalls, 1);
  await runtime.close();
  assert.equal(cancelCalls, 1);
});

test("lease loss preserves recovered timeout metadata while closing command admission", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const repository = new LifecycleTestRepository(pool);
  repository.recoveredRooms = [
    createRecoveredWaitingRoom(
      new Date(RECOVERY_INPUT.now.getTime() + 60_000),
    ),
  ];
  const rooms = new RoomService();
  const runtime = new DurableRoomRuntime(
    rooms,
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createRepository: () => repository,
    }),
  );
  await runtime.initialize();
  await runtime.recover(RECOVERY_INPUT);
  assert.equal(rooms.listDisconnectedPlayerTimeouts().length, 1);

  lease.notifyLost();
  assert.equal(runtime.readiness, "lease_lost");
  assert.equal(rooms.listDisconnectedPlayerTimeouts().length, 1);
  await runtime.close();
});

test("recovery is single-flight and commands remain unavailable until it completes", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const repository = new LifecycleTestRepository(pool);
  const recoveryBarrier = deferred<void>();
  const preparationStarted = deferred<void>();
  repository.prepareBarrier = recoveryBarrier.promise;
  repository.onPrepare = () => preparationStarted.resolve();
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createRepository: () => repository,
    }),
  );
  await runtime.initialize();

  const firstRecovery = runtime.recover(RECOVERY_INPUT);
  const duplicateRecovery = runtime.recover(RECOVERY_INPUT);
  assert.strictEqual(duplicateRecovery, firstRecovery);
  await preparationStarted.promise;
  assert.equal(runtime.readiness, "recovering");
  assert.throws(() => runtime.services, /not ready/);
  assert.equal(repository.prepareCalls, 1);
  assert.equal(repository.loadCalls, 0);

  recoveryBarrier.resolve();
  const services = await firstRecovery;
  assert.equal(runtime.readiness, "serving_ready");
  assert.equal(repository.prepareCalls, 1);
  assert.equal(repository.loadCalls, 1);
  assert.strictEqual(await runtime.recover(RECOVERY_INPUT), services);
  await runtime.close();
});

test("partial recovery failure never exposes serving commands", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const repository = new LifecycleTestRepository(pool);
  const failure = new Error("recovery preparation failed");
  repository.loadFailure = failure;
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createRepository: () => repository,
    }),
  );
  await runtime.initialize();

  await assert.rejects(runtime.recover(RECOVERY_INPUT), (error) => error === failure);
  assert.equal(runtime.readiness, "failed");
  assert.equal(runtime.isServingReady, false);
  assert.throws(() => runtime.services, /not ready/);
  assert.equal(repository.prepareCalls, 1);
  assert.equal(repository.loadCalls, 1);
  await runtime.close();
});

test("shutdown during recovery prevents serving readiness", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const repository = new LifecycleTestRepository(pool);
  const recoveryBarrier = deferred<void>();
  repository.prepareBarrier = recoveryBarrier.promise;
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createRepository: () => repository,
    }),
  );
  await runtime.initialize();

  const recovery = runtime.recover(RECOVERY_INPUT);
  const shutdown = runtime.close();
  assert.equal(runtime.readiness, "draining");
  recoveryBarrier.resolve();
  await assert.rejects(recovery, /interrupted/);
  await shutdown;

  assert.equal(runtime.readiness, "closed");
  assert.equal(runtime.isServingReady, false);
  assert.equal(lease.releaseCalls, 1);
  assert.equal(pool.endCalls, 1);
});

test("lease loss during recovery prevents serving readiness", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const repository = new LifecycleTestRepository(pool);
  const recoveryBarrier = deferred<void>();
  repository.prepareBarrier = recoveryBarrier.promise;
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createRepository: () => repository,
    }),
  );
  await runtime.initialize();

  const recovery = runtime.recover(RECOVERY_INPUT);
  const failure = new RoomRuntimeLeaseLostError("lease_lost_during_recovery");
  lease.notifyLost(failure);
  recoveryBarrier.resolve();
  await assert.rejects(recovery, (error) => error === failure);

  assert.equal(runtime.readiness, "lease_lost");
  assert.equal(runtime.isServingReady, false);
  assert.throws(() => runtime.services, /not ready/);
  assert.equal(repository.loadCalls, 0);
  await runtime.close();
});

test("pool creation failure leaves no resources or usable commands", async () => {
  const failure = new Error("pool construction failed");
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createPool: () => {
        events.push("pool:create");
        throw failure;
      },
    }),
  );

  await assert.rejects(runtime.initialize(), (error) => error === failure);
  assert.equal(runtime.readiness, "failed");
  assert.throws(() => runtime.services, /not ready/);
  assert.equal(pool.endCalls, 0);
  assert.equal(lease.releaseCalls, 0);
  assert.deepEqual(events, ["pool:create"]);
});

test("failed initialization cannot be reused as a ready runtime", async () => {
  const failure = new Error("pool construction failed");
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createPool: () => {
        events.push("pool:create");
        throw failure;
      },
    }),
  );

  const firstInitialization = runtime.initialize();
  await assert.rejects(firstInitialization, (error) => error === failure);
  const retry = runtime.initialize();

  assert.strictEqual(retry, firstInitialization);
  await assert.rejects(retry, (error) => error === failure);
  assert.equal(runtime.readiness, "failed");
  assert.equal(events.filter((event) => event === "pool:create").length, 1);
});

test("repository construction failure closes the pool and exposes no commands", async () => {
  const failure = new Error("repository construction failed");
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createRepository: () => {
        events.push("repository:create");
        throw failure;
      },
    }),
  );

  await assert.rejects(runtime.initialize(), (error) => error === failure);
  assert.equal(runtime.readiness, "failed");
  assert.throws(() => runtime.services, /not ready/);
  assert.equal(pool.endCalls, 1);
  assert.equal(lease.releaseCalls, 0);
  assert.deepEqual(events, [
    "pool:create",
    "repository:create",
    "pool:close",
  ]);
});

test("lease acquisition failure closes the pool without constructing commands", async () => {
  const failure = new Error("lease acquisition failed");
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      acquireLease: async () => {
        events.push("lease:acquire");
        throw failure;
      },
    }),
  );

  await assert.rejects(runtime.initialize(), (error) => error === failure);
  assert.equal(runtime.readiness, "failed");
  assert.throws(() => runtime.services, /not ready/);
  assert.equal(pool.endCalls, 1);
  assert.equal(lease.releaseCalls, 0);
  assert.deepEqual(events, [
    "pool:create",
    "repository:create",
    "coordinator:create",
    "lease:acquire",
    "pool:close",
  ]);
});

test("command construction failure releases the acquired lease before closing the pool", async () => {
  const failure = new Error("command construction failed");
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createCommands: () => {
        events.push("commands:create");
        throw failure;
      },
    }),
  );

  await assert.rejects(runtime.initialize(), (error) => error === failure);
  assert.equal(runtime.readiness, "failed");
  assert.throws(() => runtime.services, /not ready/);
  assert.deepEqual(events, [
    "pool:create",
    "repository:create",
    "coordinator:create",
    "lease:acquire",
    "commands:create",
    "lease:release",
    "pool:close",
  ]);
  assert.equal(lease.releaseCalls, 1);
  assert.equal(pool.endCalls, 1);
});

test("shutdown releases the lease and closes the pool once", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease),
  );
  await runtime.initialize();

  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.strictEqual(secondClose, firstClose);
  await Promise.all([firstClose, secondClose]);

  assert.equal(runtime.readiness, "closed");
  assert.equal(runtime.isResourceReady, false);
  assert.throws(() => runtime.services, /not ready/);
  assert.equal(lease.releaseCalls, 1);
  assert.equal(pool.endCalls, 1);
  assert.deepEqual(events.slice(-2), ["lease:release", "pool:close"]);
});

test("pool closure is attempted even when lease release fails", async () => {
  const releaseFailure = new Error("lease release failed");
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events, releaseFailure);
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease),
  );
  await runtime.initialize();

  await assert.rejects(runtime.close(), (error) => error === releaseFailure);
  assert.equal(runtime.readiness, "closed");
  assert.equal(lease.releaseCalls, 1);
  assert.equal(pool.endCalls, 1);
  assert.deepEqual(events.slice(-2), ["lease:release", "pool:close"]);
});

test("shutdown drains admitted commands and rejects every retained command path", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const repositoryStarted = deferred<void>();
  const repositoryResult = deferred<CreatedRoomInfo>();
  let createInput: CreateRoomWithHostInput | undefined;
  let mutationCalls = 0;
  const rooms = new RoomService(() => "ABCD" as RoomCode);
  const runtime = new DurableRoomRuntime(
    rooms,
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createCommands: (roomService, _repository, coordinator) =>
        new RoomPersistenceCommands(
          roomService,
          {
            async createRoomWithHost(input) {
              mutationCalls += 1;
              createInput = input;
              events.push("database:start");
              repositoryStarted.resolve();
              const result = await repositoryResult.promise;
              events.push("database:finish");
              return result;
            },
            async joinRoom() {
              throw new Error("Unexpected join.");
            },
          },
          coordinator,
        ),
    }),
  );
  await runtime.initialize();
  const services = await runtime.recover(RECOVERY_INPUT);
  const retainedCommands = services.commands;
  const admittedOperation = retainedCommands.createRoom(
    { nickname: "Host" },
    "host-socket",
  );
  await repositoryStarted.promise;

  const shutdown = runtime.close();
  assert.equal(runtime.readiness, "draining");
  assert.equal(events.includes("lease:release"), false);

  const roomCode = "ABCD" as RoomCode;
  const playerId = "late-player" as PlayerId;
  const rejectedCommands = [
    retainedCommands.createRoom({ nickname: "Late" }, "late-socket"),
    retainedCommands.joinRoom({ roomCode, nickname: "Late" }, "late-socket"),
    retainedCommands.leaveRoom(roomCode, "late-socket"),
    retainedCommands.disconnectSocket("late-socket", 30_000),
    retainedCommands.reconnect(
      { roomCode, playerId, reconnectToken: "unused" },
      "late-socket",
    ),
    retainedCommands.removeDisconnectedPlayer(
      roomCode,
      playerId,
      "1",
      new Date(),
      new Date(),
    ),
    retainedCommands.transitionRoomGameStatus(
      statusTransitionCommand(roomCode),
    ),
    retainedCommands.reconcileDeferredRoomMutations(roomCode),
  ];
  await Promise.all(
    rejectedCommands.map((command) =>
      assert.rejects(command, /not accepting persistence operations/),
    ),
  );
  assert.throws(
    () => retainedCommands.fenceRoom(roomCode),
    /not accepting persistence operations/,
  );
  assert.equal(mutationCalls, 1);
  assert.equal(events.includes("lease:release"), false);

  assert.ok(createInput);
  repositoryResult.resolve(createdInfo(createInput));
  const result = await admittedOperation;
  assert.equal(result.room.code, "ABCD");
  assert.equal(rooms.getPublicRoom("ABCD")?.players.length, 1);
  await shutdown;
  await assert.rejects(
    retainedCommands.transitionRoomGameStatus(
      statusTransitionCommand(roomCode),
    ),
    /not accepting persistence operations/,
  );
  await assert.rejects(
    retainedCommands.reconcileDeferredRoomMutations(roomCode),
    /not accepting persistence operations/,
  );

  assert.deepEqual(events.slice(-4), [
    "database:start",
    "database:finish",
    "lease:release",
    "pool:close",
  ]);
  assert.equal(lease.releaseCalls, 1);
  assert.equal(pool.endCalls, 1);
});

test("shutdown returns after its drain deadline but retains the lease until admitted writes settle", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const repositoryStarted = deferred<void>();
  const repositoryResult = deferred<CreatedRoomInfo>();
  const poolClosed = deferred<void>();
  let createInput: CreateRoomWithHostInput | undefined;
  const rooms = new RoomService(() => "DLAY" as RoomCode);
  const runtime = new DurableRoomRuntime(
    rooms,
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      shutdownDrainTimeoutMs: 5,
      createCommands: (roomService, _repository, coordinator) =>
        new RoomPersistenceCommands(
          roomService,
          {
            async createRoomWithHost(input) {
              createInput = input;
              repositoryStarted.resolve();
              return repositoryResult.promise;
            },
            async joinRoom() {
              throw new Error("Unexpected join.");
            },
          },
          coordinator,
        ),
      closePool: async (createdPool) => {
        events.push("pool:close");
        await createdPool.end();
        poolClosed.resolve();
      },
    }),
  );
  await runtime.initialize();
  const services = await runtime.recover(RECOVERY_INPUT);
  const admittedOperation = services.commands.createRoom(
    { nickname: "Delayed Host" },
    "delayed-host-socket",
  );
  await repositoryStarted.promise;

  const shutdown = runtime.close();
  assert.strictEqual(runtime.close(), shutdown);
  await assert.rejects(shutdown, /shutdown exceeded 5 milliseconds/);
  assert.equal(lease.releaseCalls, 0);
  assert.equal(pool.endCalls, 0);
  assert.equal(runtime.readiness, "draining");
  assert.equal(runtime.isLeaseOwned, true);

  assert.ok(createInput);
  repositoryResult.resolve(createdInfo(createInput));
  await admittedOperation;
  await poolClosed.promise;
  await waitForRuntimeReadiness(runtime, "closed");
  assert.deepEqual(events.slice(-2), ["lease:release", "pool:close"]);
  assert.equal(runtime.isLeaseOwned, false);
});

test("shutdown during pending pool creation closes the pool without exposing commands", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const pendingPool = deferred<Pool>();
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      createPool: () => {
        events.push("pool:create");
        return pendingPool.promise;
      },
    }),
  );

  const initialization = runtime.initialize();
  assert.deepEqual(events, ["pool:create"]);
  const shutdown = runtime.close();
  assert.equal(runtime.readiness, "draining");
  assert.throws(() => runtime.services, /not ready/);

  pendingPool.resolve(pool);
  await assert.rejects(initialization, /closed during initialization/);
  await shutdown;

  assert.equal(runtime.readiness, "closed");
  assert.equal(lease.releaseCalls, 0);
  assert.equal(pool.endCalls, 1);
  assert.deepEqual(events, ["pool:create", "pool:close"]);
});

test("runtime shutdown releases a blocked deferred caller without clearing its fence", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const rooms = new RoomService();
  const runtime = new DurableRoomRuntime(
    rooms,
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease),
  );
  await runtime.initialize();
  await runtime.recover(RECOVERY_INPUT);
  const host = rooms.createRoom({ nickname: "Host" }, "host-socket");
  const reservation = rooms.reserveGameStatusTransition(
    host.room.code,
    "waiting",
    null,
    "host-socket",
  );
  const pending = rooms.deferRoomMutation(host.room.code, async () => {
    throw new Error("uncertain deferred operation");
  });
  rooms.releaseGameStatusReservation(reservation);
  await new Promise<void>((resolve) => setImmediate(resolve));

  const shutdown = runtime.close();
  await assert.rejects(pending, /shutting down/);
  await shutdown;
  assert.throws(
    () => rooms.joinRoom({ roomCode: host.room.code, nickname: "Late" }, "late"),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNKNOWN",
  );
});

test("runtime automatically reconciles a blocked deferred room mutation", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const rooms = new RoomService();
  const runtime = new DurableRoomRuntime(
    rooms,
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease),
  );
  await runtime.initialize();
  await runtime.recover(RECOVERY_INPUT);
  const host = rooms.createRoom({ nickname: "Host" }, "host-socket");
  let operationAttempts = 0;
  const pending = rooms.deferRoomMutation<string>(
    host.room.code,
    async () => {
      operationAttempts += 1;
      throw new Error("uncertain deferred operation");
    },
    async (_reservation, resolve) => {
      resolve("reconciled");
      return "complete";
    },
  );

  assert.equal(await pending, "reconciled");
  assert.equal(operationAttempts, 1);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!rooms.hasBlockedDeferredRoomMutations(host.room.code)) {
      break;
    }
    await waitForNextEventLoopTurn();
  }
  assert.equal(rooms.hasBlockedDeferredRoomMutations(host.room.code), false);
  await runtime.close();
});

test("runtime exhaustion keeps the failed room fenced while other rooms remain usable", async (t) => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const retryTimers: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
    fired: boolean;
  }> = [];
  const rooms = new RoomService();
  const runtime = new DurableRoomRuntime(
    rooms,
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      scheduleReconciliationRetry: (callback, delayMs) => {
        const timer = { callback, delayMs, cancelled: false, fired: false };
        retryTimers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    }),
  );
  await runtime.initialize();
  await runtime.recover(RECOVERY_INPUT);
  const originalDateNow = Date.now;
  let controlledNow = originalDateNow();
  Date.now = () => controlledNow;
  t.after(async () => {
    Date.now = originalDateNow;
    await runtime.close();
  });

  const affected = rooms.createRoom({ nickname: "Affected host" }, "affected-host");
  const unaffected = rooms.createRoom({ nickname: "Unaffected host" }, "unaffected-host");
  const suspensionScope = rooms.getGameplaySuspensionScope(affected.room.code, null);
  assert.ok(suspensionScope);
  const reservation = rooms.reserveGameStatusTransition(
    affected.room.code,
    "waiting",
    null,
    "affected-host",
  );
  let writeAttempts = 0;
  let reconciliationAttempts = 0;
  const pendingMutation = rooms.deferRoomMutation(
    affected.room.code,
    async () => {
      writeAttempts += 1;
      throw new Error("Uncertain committed removal side effect.");
    },
    async () => {
      reconciliationAttempts += 1;
      throw new Error("Reconciliation state is still uncertain.");
    },
  );
  void pendingMutation.catch(() => {});
  rooms.releaseGameStatusReservation(reservation);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (rooms.hasBlockedDeferredRoomMutations(affected.room.code)) {
      break;
    }
    await waitForNextEventLoopTurn();
  }
  assert.equal(rooms.hasBlockedDeferredRoomMutations(affected.room.code), true);
  rooms.suspendGameplay(
    affected.room.code,
    suspensionScope,
    "durable_timeout_post_commit_side_effect_failure",
  );

  for (const maximumDelayMs of [250, 500, 1_000, 2_000]) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (retryTimers.some((timer) => !timer.cancelled && !timer.fired)) {
        break;
      }
      await waitForNextEventLoopTurn();
    }
    const timer = retryTimers.find(
      (candidate) => !candidate.cancelled && !candidate.fired,
    );
    assert.ok(timer);
    assert.equal(timer.delayMs, maximumDelayMs);
    timer.fired = true;
    controlledNow += timer.delayMs;
    timer.callback();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        retryTimers.some((candidate) => !candidate.cancelled && !candidate.fired)
        || runtime.getDiagnostics().roomReconciliation.exhaustedRooms === 1
      ) {
        break;
      }
      await waitForNextEventLoopTurn();
    }
  }

  assert.equal(reconciliationAttempts, 5);
  assert.equal(writeAttempts, 1);
  assert.deepEqual(runtime.getDiagnostics().roomReconciliation, {
    trackedRooms: 1,
    pendingRooms: 0,
    exhaustedRooms: 1,
  });
  assert.equal(rooms.hasBlockedDeferredRoomMutations(affected.room.code), true);
  assert.equal(rooms.isGameplaySuspended(affected.room.code), true);
  assert.throws(
    () => rooms.joinRoom(
      { roomCode: affected.room.code, nickname: "Late guest" },
      "late-guest",
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.throws(
    () => rooms.assertGameplayAvailable(affected.room.code),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  assert.equal(
    rooms.joinRoom(
      { roomCode: unaffected.room.code, nickname: "Unaffected guest" },
      "unaffected-guest",
    ).room.players.length,
    2,
  );
  await runtime.close();
});

test("replacement runtime waits for lease release and does not inherit old suspension", async () => {
  const events: string[] = [];
  let leaseOwner: string | undefined;
  const createExclusiveDependencies = (
    owner: string,
    pool: LifecycleTestPool,
    repository: LifecycleTestRepository,
  ): DurableRoomRuntimeDependencies => {
    const lease = createLease(events).lease;
    return createDependencies(events, pool, lease, {
      createRepository: () => repository,
      acquireLease: async () => {
        events.push(`${owner}:lease:acquire`);
        if (leaseOwner) {
          throw new RoomRuntimeLeaseUnavailableError();
        }
        leaseOwner = owner;
        return {
          ...lease,
          async release() {
            await lease.release();
            assert.equal(leaseOwner, owner);
            leaseOwner = undefined;
          },
        };
      },
    });
  };

  const recoveredRoom = createRecoveredWaitingRoom(
    new Date(RECOVERY_INPUT.now.getTime() + 60_000),
  );
  const oldPool = new LifecycleTestPool();
  const oldRepository = new LifecycleTestRepository(oldPool);
  oldRepository.recoveredRooms = [recoveredRoom];
  const oldRooms = new RoomService();
  const oldRuntime = new DurableRoomRuntime(
    oldRooms,
    TEST_POOL_CONFIG,
    createExclusiveDependencies("old", oldPool, oldRepository),
  );
  await oldRuntime.initialize();
  await oldRuntime.recover(RECOVERY_INPUT);
  const oldScope = oldRooms.getGameplaySuspensionScope(
    recoveredRoom.roomCode,
    null,
  );
  assert.ok(oldScope);
  oldRooms.fenceRoom(recoveredRoom.roomCode);
  oldRooms.suspendGameplay(
    recoveredRoom.roomCode,
    oldScope,
    "durable_timeout_post_commit_side_effect_failure",
  );

  const blockedPool = new LifecycleTestPool();
  const blockedRepository = new LifecycleTestRepository(blockedPool);
  const blockedRuntime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createExclusiveDependencies("blocked-replacement", blockedPool, blockedRepository),
  );
  await assert.rejects(
    blockedRuntime.initialize(),
    RoomRuntimeLeaseUnavailableError,
  );
  assert.equal(leaseOwner, "old");
  assert.equal(blockedRuntime.isServingReady, false);
  await blockedRuntime.close();

  await oldRuntime.close();
  assert.equal(leaseOwner, undefined);
  assert.equal(oldRooms.isGameplaySuspended(recoveredRoom.roomCode), true);

  const replacementPool = new LifecycleTestPool();
  const replacementRepository = new LifecycleTestRepository(replacementPool);
  replacementRepository.recoveredRooms = [recoveredRoom];
  const replacementRooms = new RoomService();
  const replacementRuntime = new DurableRoomRuntime(
    replacementRooms,
    TEST_POOL_CONFIG,
    createExclusiveDependencies(
      "replacement",
      replacementPool,
      replacementRepository,
    ),
  );
  await replacementRuntime.initialize();
  await replacementRuntime.recover(RECOVERY_INPUT);

  assert.equal(leaseOwner, "replacement");
  assert.equal(replacementRuntime.isServingReady, true);
  assert.equal(replacementRooms.isGameplaySuspended(recoveredRoom.roomCode), false);
  assert.equal(
    replacementRooms.getPublicRoom(recoveredRoom.roomCode)?.gameStatus,
    "waiting",
  );
  assert.doesNotThrow(() =>
    replacementRooms.assertGameplayAvailable(recoveredRoom.roomCode),
  );
  await replacementRuntime.close();
  assert.equal(leaseOwner, undefined);
});

test("shutdown during pending lease acquisition releases the lease exactly once", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const pendingLease = deferred<RoomRuntimeLease>();
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      acquireLease: () => {
        events.push("lease:acquire");
        return pendingLease.promise;
      },
    }),
  );

  const initialization = runtime.initialize();
  await Promise.resolve();
  assert.deepEqual(events, [
    "pool:create",
    "repository:create",
    "coordinator:create",
    "lease:acquire",
  ]);
  const shutdown = runtime.close();
  assert.equal(runtime.readiness, "draining");
  assert.throws(() => runtime.services, /not ready/);

  pendingLease.resolve(lease.lease);
  await assert.rejects(initialization, /closed during initialization/);
  await shutdown;

  assert.equal(runtime.readiness, "closed");
  assert.equal(lease.releaseCalls, 1);
  assert.equal(pool.endCalls, 1);
  assert.equal(events.includes("commands:create"), false);
  assert.deepEqual(events.slice(-2), ["lease:release", "pool:close"]);
});

test("pool closure failure is reported after lease release", async () => {
  const poolFailure = new Error("pool close failed");
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      closePool: async () => {
        events.push("pool:close");
        throw poolFailure;
      },
    }),
  );
  await runtime.initialize();

  await assert.rejects(runtime.close(), (error) => error === poolFailure);
  assert.equal(lease.releaseCalls, 1);
  assert.deepEqual(events.slice(-2), ["lease:release", "pool:close"]);
});

test("shutdown preserves both lease-release and pool-closure failures", async () => {
  const releaseFailure = new Error("lease release failed");
  const poolFailure = new Error("pool close failed");
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events, releaseFailure);
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      closePool: async () => {
        events.push("pool:close");
        throw poolFailure;
      },
    }),
  );
  await runtime.initialize();

  await assert.rejects(runtime.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [releaseFailure, poolFailure]);
    return true;
  });
  assert.equal(lease.releaseCalls, 1);
  assert.deepEqual(events.slice(-2), ["lease:release", "pool:close"]);
});

test("lease loss immediately disables retained commands without reacquiring", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const lease = createLease(events);
  let acquireCalls = 0;
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      acquireLease: async () => {
        acquireCalls += 1;
        return lease.lease;
      },
    }),
  );
  await runtime.initialize();
  const services = await runtime.recover(RECOVERY_INPUT);
  const retainedCommands = services.commands;

  lease.notifyLost(new RoomRuntimeLeaseLostError("lease_connection_ended"));
  lease.notifyLost(new RoomRuntimeLeaseLostError("duplicate_lease_loss"));

  assert.equal(runtime.readiness, "lease_lost");
  assert.equal(runtime.leaseFailure?.message.includes("lease_connection_ended"), true);
  assert.equal(runtime.isResourceReady, false);
  assert.throws(() => runtime.services, /not ready/);
  await assert.rejects(
    retainedCommands.joinRoom(
      { roomCode: "ABCD" as RoomCode, nickname: "Late" },
      "late-socket",
    ),
    /not accepting persistence operations/,
  );
  await assert.rejects(
    retainedCommands.transitionRoomGameStatus(statusTransitionCommand()),
    /not accepting persistence operations/,
  );
  assert.equal(acquireCalls, 1);

  await runtime.close();
  await assert.rejects(
    retainedCommands.transitionRoomGameStatus(statusTransitionCommand()),
    /not accepting persistence operations/,
  );
  assert.equal(lease.releaseCalls, 1);
  assert.equal(pool.endCalls, 1);
});

test("health-check failure transitions the runtime to a non-writable state", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const checkFailure = new RoomRuntimeLeaseLostError(
    "lease_health_check_failed",
    "08006",
  );
  let checkCount = 0;
  let runHealthCheck: (() => void) | undefined;
  const lease = createLease(events, undefined, async () => {
    checkCount += 1;
    if (checkCount > 4) {
      throw checkFailure;
    }
  });
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      scheduleHealthChecks: (callback) => {
        runHealthCheck = callback;
        return () => {};
      },
    }),
  );
  await runtime.initialize();
  const services = await runtime.recover(RECOVERY_INPUT);
  assert.equal(runtime.readiness, "serving_ready");
  assert.ok(runHealthCheck);

  runHealthCheck();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.readiness, "lease_lost");
  await assert.rejects(
    services.commands.createRoom({ nickname: "Blocked" }, "blocked-socket"),
    /not accepting persistence operations/,
  );
  await runtime.close();
});

test("shutdown waits for a pending health check before releasing the lease", async () => {
  const events: string[] = [];
  const pool = new LifecycleTestPool();
  const pendingCheck = deferred<void>();
  let checkCount = 0;
  let runHealthCheck: (() => void) | undefined;
  let cancelHealthChecks = 0;
  const lease = createLease(events, undefined, () => {
    checkCount += 1;
    return checkCount === 1 ? Promise.resolve() : pendingCheck.promise;
  });
  const runtime = new DurableRoomRuntime(
    new RoomService(),
    TEST_POOL_CONFIG,
    createDependencies(events, pool, lease.lease, {
      scheduleHealthChecks: (callback) => {
        runHealthCheck = callback;
        return () => {
          cancelHealthChecks += 1;
        };
      },
    }),
  );
  await runtime.initialize();
  assert.ok(runHealthCheck);
  runHealthCheck();

  const shutdown = runtime.close();
  assert.equal(cancelHealthChecks, 1);
  assert.equal(events.includes("lease:release"), false);
  pendingCheck.resolve();
  await shutdown;

  assert.equal(lease.releaseCalls, 1);
  assert.deepEqual(events.slice(-2), ["lease:release", "pool:close"]);
});

const runtimeIntegrationEnabled =
  process.env.DURABLE_ROOM_CI_DATABASE === "1";
const runtimeIntegrationDatabase = runtimeIntegrationEnabled
  ? process.env.ROOM_RUNTIME_FENCING_TEST_DATABASE
  : undefined;
const runtimeIntegrationUser = runtimeIntegrationEnabled
  ? process.env.ROOM_RUNTIME_FENCING_TEST_USER
  : undefined;

test(
  "PostgreSQL recovered reconnect deadlines serialize with reconnect and honor generations",
  {
    skip: !runtimeIntegrationDatabase || !runtimeIntegrationUser,
  },
  async (t) => {
    assert.ok(runtimeIntegrationDatabase, "runtime integration database is required");
    assert.ok(runtimeIntegrationUser, "runtime integration user is required");

    const config = runtimeIntegrationPoolConfig(
      runtimeIntegrationDatabase,
      runtimeIntegrationUser,
    );
    const adminPool = createPostgresPool({
      host: "127.0.0.1",
      port: 55432,
      database: runtimeIntegrationDatabase,
      user: "postgres",
      max: 8,
    });
    const roomCodes: RoomCode[] = [];
    let runtimeA: DurableRoomRuntime | undefined;
    let runtimeB: DurableRoomRuntime | undefined;
    let raceLockClient: PoolClient | undefined;
    const initialTime = Date.now();

    const createRuntime = (rooms: RoomService) =>
      new DurableRoomRuntime(
        rooms,
        config,
        { scheduleHealthChecks: () => () => {} },
      );

    t.after(async () => {
      if (raceLockClient) {
        await raceLockClient.query("ROLLBACK");
        raceLockClient.release();
        raceLockClient = undefined;
      }
      if (runtimeB && runtimeB.readiness !== "closed") {
        await runtimeB.close();
      }
      if (runtimeA && runtimeA.readiness !== "closed") {
        await runtimeA.close();
      }
      for (const roomCode of roomCodes) {
        await adminPool.query(
          "DELETE FROM public.rooms WHERE room_code = $1",
          [roomCode],
        );
      }
      await adminPool.end();
    });

    const setDeadline = async (
      roomCode: RoomCode,
      playerId: PlayerId,
      deadline: Date,
    ): Promise<void> => {
      const result = await adminPool.query(
        `UPDATE public.room_players AS player
         SET reconnect_deadline_at = $1
         FROM public.rooms AS room
         WHERE room.id = player.room_id
           AND room.room_code = $2
           AND player.player_id = $3
           AND player.membership_status = 'active'`,
        [deadline, roomCode, playerId],
      );
      assert.equal(result.rowCount, 1);
    };

    const readMembership = async (
      roomCode: RoomCode,
      playerId: PlayerId,
    ): Promise<{
      membership_status: string;
      connection_status: string;
      disconnect_generation: string;
      reconnect_deadline_at: Date | null;
    } | undefined> => {
      const result = await adminPool.query<{
        membership_status: string;
        connection_status: string;
        disconnect_generation: string;
        reconnect_deadline_at: Date | null;
      }>(
        `SELECT player.membership_status, player.connection_status,
                player.disconnect_generation::text, player.reconnect_deadline_at
         FROM public.room_players AS player
         JOIN public.rooms AS room ON room.id = player.room_id
         WHERE room.room_code = $1 AND player.player_id = $2`,
        [roomCode, playerId],
      );
      return result.rows[0];
    };

    const waitForMembership = async (
      roomCode: RoomCode,
      playerId: PlayerId,
      predicate: (membership: Awaited<ReturnType<typeof readMembership>>) => boolean,
    ): Promise<Awaited<ReturnType<typeof readMembership>>> => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const membership = await readMembership(roomCode, playerId);
        if (predicate(membership)) {
          return membership;
        }
        await waitForNextEventLoopTurn();
      }
      assert.fail(`Membership ${roomCode}/${playerId} did not reach its expected state.`);
    };

    runtimeA = createRuntime(new RoomService());
    await runtimeA.initialize();
    const servicesA = await runtimeA.recover({
      now: new Date(initialTime),
      reconnectGracePeriodMs: 3_600_000,
    });

    const hostTimeoutRoom = await servicesA.commands.createRoom(
      { nickname: "Timeout host" },
      "timeout-host-socket",
    );
    roomCodes.push(hostTimeoutRoom.room.code);
    const hostTimeoutGuest = await servicesA.commands.joinRoom(
      { roomCode: hostTimeoutRoom.room.code, nickname: "Timeout guest" },
      "timeout-guest-socket",
    );
    await servicesA.commands.disconnectSocket("timeout-host-socket", 3_600_000);
    await servicesA.commands.disconnectSocket("timeout-guest-socket", 3_600_000);
    await setDeadline(
      hostTimeoutRoom.room.code,
      hostTimeoutRoom.playerId,
      new Date(initialTime + 1),
    );
    await setDeadline(
      hostTimeoutRoom.room.code,
      hostTimeoutGuest.playerId,
      new Date(initialTime + 4_000),
    );

    const reconnectRoom = await servicesA.commands.createRoom(
      { nickname: "Reconnect host" },
      "reconnect-host-socket",
    );
    roomCodes.push(reconnectRoom.room.code);
    const reconnectPlayer = await servicesA.commands.joinRoom(
      { roomCode: reconnectRoom.room.code, nickname: "Reconnect player" },
      "reconnect-player-socket",
    );
    await servicesA.commands.disconnectSocket("reconnect-player-socket", 3_600_000);
    const reconnectDeadline = new Date(initialTime + 2_000);
    await setDeadline(
      reconnectRoom.room.code,
      reconnectPlayer.playerId,
      reconnectDeadline,
    );

    const generationRoom = await servicesA.commands.createRoom(
      { nickname: "Generation host" },
      "generation-host-socket",
    );
    roomCodes.push(generationRoom.room.code);
    const generationPlayer = await servicesA.commands.joinRoom(
      { roomCode: generationRoom.room.code, nickname: "Generation player" },
      "generation-player-socket",
    );
    await servicesA.commands.disconnectSocket("generation-player-socket", 3_600_000);
    const oldGenerationDeadline = new Date(initialTime + 3_000);
    await setDeadline(
      generationRoom.room.code,
      generationPlayer.playerId,
      oldGenerationDeadline,
    );

    const raceRoom = await servicesA.commands.createRoom(
      { nickname: "Race host" },
      "race-host-socket",
    );
    roomCodes.push(raceRoom.room.code);
    const racePlayer = await servicesA.commands.joinRoom(
      { roomCode: raceRoom.room.code, nickname: "Race player" },
      "race-player-socket",
    );
    await servicesA.commands.disconnectSocket("race-player-socket", 3_600_000);
    const raceDeadline = new Date(initialTime + 5_000);
    await setDeadline(raceRoom.room.code, racePlayer.playerId, raceDeadline);

    const lastMemberRoom = await servicesA.commands.createRoom(
      { nickname: "Last member" },
      "last-member-socket",
    );
    roomCodes.push(lastMemberRoom.room.code);
    await servicesA.commands.disconnectSocket("last-member-socket", 3_600_000);
    await setDeadline(
      lastMemberRoom.room.code,
      lastMemberRoom.playerId,
      new Date(initialTime + 6_000),
    );

    const expiredRoom = await servicesA.commands.createRoom(
      { nickname: "Expired member" },
      "expired-member-socket",
    );
    roomCodes.push(expiredRoom.room.code);
    await servicesA.commands.disconnectSocket("expired-member-socket", 3_600_000);
    await setDeadline(
      expiredRoom.room.code,
      expiredRoom.playerId,
      new Date(initialTime - 1_000),
    );

    await runtimeA.close();
    runtimeA = undefined;

    const recoveredRooms = new RoomService();
    runtimeB = createRuntime(recoveredRooms);
    await runtimeB.initialize();
    const servicesB = await runtimeB.recover({
      now: new Date(initialTime),
      reconnectGracePeriodMs: 3_600_000,
    });
    assert.equal(runtimeB.readiness, "serving_ready");
    assert.equal(recoveredRooms.listDisconnectedPlayerTimeouts().length, 6);
    assert.equal(recoveredRooms.getPublicRoom(expiredRoom.room.code), undefined);
    assert.equal(
      (await adminPool.query(
        "SELECT id FROM public.rooms WHERE room_code = $1",
        [expiredRoom.room.code],
      )).rowCount,
      0,
    );

    await servicesB.commands.reconnect(
      {
        roomCode: reconnectRoom.room.code,
        playerId: reconnectPlayer.playerId,
        reconnectToken: reconnectPlayer.reconnectToken,
      },
      "reconnected-before-timeout",
    );
    assert.equal(
      await servicesB.commands.removeDisconnectedPlayer(
        reconnectRoom.room.code,
        reconnectPlayer.playerId,
        "1",
        reconnectDeadline,
        new Date(reconnectDeadline.getTime() + 1),
      ),
      undefined,
    );
    const stillConnected = await readMembership(
      reconnectRoom.room.code,
      reconnectPlayer.playerId,
    );
    assert.equal(stillConnected?.membership_status, "active");
    assert.equal(stillConnected?.connection_status, "connected");
    assert.equal(stillConnected?.disconnect_generation, "2");

    await servicesB.commands.reconnect(
      {
        roomCode: generationRoom.room.code,
        playerId: generationPlayer.playerId,
        reconnectToken: generationPlayer.reconnectToken,
      },
      "generation-reconnected",
    );
    const newDisconnect = await servicesB.commands.disconnectSocket(
      "generation-reconnected",
      3_600_000,
    );
    assert.equal(newDisconnect?.disconnectGeneration, "3");
    assert.equal(
      await servicesB.commands.removeDisconnectedPlayer(
        generationRoom.room.code,
        generationPlayer.playerId,
        "1",
        oldGenerationDeadline,
        new Date(oldGenerationDeadline.getTime() + 1),
      ),
      undefined,
    );
    assert.equal(
      (await readMembership(generationRoom.room.code, generationPlayer.playerId))
        ?.disconnect_generation,
      "3",
    );

    const hostRemoval = await servicesB.commands.removeDisconnectedPlayer(
      hostTimeoutRoom.room.code,
      hostTimeoutRoom.playerId,
      "1",
      new Date(initialTime + 1),
      new Date(initialTime + 2),
    );
    assert.ok(hostRemoval && !("retryAt" in hostRemoval));
    assert.equal(
      recoveredRooms.getPublicRoom(hostTimeoutRoom.room.code)?.hostId,
      hostTimeoutGuest.playerId,
    );

    const guestRemoval = await servicesB.commands.removeDisconnectedPlayer(
      hostTimeoutRoom.room.code,
      hostTimeoutGuest.playerId,
      "1",
      new Date(initialTime + 4_000),
      new Date(initialTime + 4_001),
    );
    assert.ok(guestRemoval && !("retryAt" in guestRemoval));
    assert.equal(guestRemoval.deleted, true);
    assert.equal(
      (await adminPool.query(
        "SELECT id FROM public.rooms WHERE room_code = $1",
        [hostTimeoutRoom.room.code],
      )).rowCount,
      0,
    );
    assert.equal(
      recoveredRooms.getPublicRoom(hostTimeoutRoom.room.code),
      undefined,
    );

    raceLockClient = await adminPool.connect();
    await raceLockClient.query("BEGIN");
    await raceLockClient.query(
      "SELECT id FROM public.rooms WHERE room_code = $1 FOR UPDATE",
      [raceRoom.room.code],
    );
    const raceTimeout = servicesB.commands.removeDisconnectedPlayer(
      raceRoom.room.code,
      racePlayer.playerId,
      "1",
      raceDeadline,
      new Date(raceDeadline.getTime() + 1),
    );
    await waitForPostgresLockWait(adminPool, "SELECT id::text, room_code");
    const reconnectDuringTimeout = servicesB.commands.reconnect(
      {
        roomCode: raceRoom.room.code,
        playerId: racePlayer.playerId,
        reconnectToken: racePlayer.reconnectToken,
      },
      "reconnect-after-timeout-start",
    );
    const reconnectRejection = assert.rejects(
      reconnectDuringTimeout,
      (error) => error instanceof AppError && error.code === "NOT_AUTHORIZED",
    );
    await waitForNextEventLoopTurn();
    await raceLockClient.query("COMMIT");
    raceLockClient.release();
    raceLockClient = undefined;
    await reconnectRejection;
    const raceRemoval = await raceTimeout;
    assert.ok(raceRemoval && !("retryAt" in raceRemoval));
    assert.equal(raceRemoval.deleted, true);
    await waitForMembership(
      raceRoom.room.code,
      racePlayer.playerId,
      (membership) => membership?.membership_status === "removed",
    );

    const lastMemberRemoval = await servicesB.commands.removeDisconnectedPlayer(
      lastMemberRoom.room.code,
      lastMemberRoom.playerId,
      "1",
      new Date(initialTime + 6_000),
      new Date(initialTime + 6_001),
    );
    assert.ok(lastMemberRemoval && !("retryAt" in lastMemberRemoval));
    assert.equal(lastMemberRemoval.deleted, true);
    assert.equal(
      (await adminPool.query(
        "SELECT id FROM public.rooms WHERE room_code = $1",
        [lastMemberRoom.room.code],
      )).rowCount,
      0,
    );
  },
);

test(
  "simultaneous PostgreSQL runtime starts grant one owner and consecutive epochs",
  {
    skip: !runtimeIntegrationDatabase || !runtimeIntegrationUser,
  },
  async (t) => {
    if (!runtimeIntegrationDatabase || !runtimeIntegrationUser) {
      return;
    }

    const config = runtimeIntegrationPoolConfig(
      runtimeIntegrationDatabase,
      runtimeIntegrationUser,
    );
    const adminPool = createPostgresPool({
      host: "127.0.0.1",
      port: 55432,
      database: runtimeIntegrationDatabase,
      user: "postgres",
      max: 2,
    });
    const runtimes: DurableRoomRuntime[] = [];
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let acquisitionAttempts = 0;
    const dependencies: Partial<DurableRoomRuntimeDependencies> = {
      acquireLease: async (pool) => {
        acquisitionAttempts += 1;
        arrivals += 1;
        if (arrivals === 2) {
          releaseBarrier();
        }
        await barrier;
        return acquireRoomRuntimeLease(pool);
      },
      scheduleHealthChecks: () => () => {},
    };
    const createRuntime = () => {
      const runtime = new DurableRoomRuntime(
        new RoomService(),
        config,
        dependencies,
      );
      runtimes.push(runtime);
      return runtime;
    };

    t.after(async () => {
      for (const runtime of runtimes) {
        if (runtime.readiness !== "closed") {
          await runtime.close();
        }
      }
      await adminPool.end();
    });

    const epochBeforeRace = await currentRuntimeFencingEpoch(adminPool);
    const first = createRuntime();
    const second = createRuntime();
    const outcomes = await Promise.allSettled([
      first.initialize(),
      second.initialize(),
    ]);

    const winnerIndex = outcomes.findIndex(
      (outcome) => outcome.status === "fulfilled",
    );
    const loserIndex = outcomes.findIndex(
      (outcome) => outcome.status === "rejected",
    );
    assert.notEqual(winnerIndex, -1);
    assert.notEqual(loserIndex, -1);
    assert.notEqual(winnerIndex, loserIndex);
    const winner = runtimes[winnerIndex];
    const loser = runtimes[loserIndex];
    const losingOutcome = outcomes[loserIndex];
    assert.ok(winner);
    assert.ok(loser);
    assert.ok(losingOutcome?.status === "rejected");
    assert.ok(losingOutcome.reason instanceof RoomRuntimeLeaseUnavailableError);
    assert.equal(winner.readiness, "resources_ready");
    assert.equal(loser.readiness, "failed");
    assert.throws(() => loser.services, /not ready/);
    assert.equal(acquisitionAttempts, 2);
    assert.equal(
      await currentRuntimeFencingEpoch(adminPool),
      epochBeforeRace + 1n,
    );

    await assert.rejects(
      loser.initialize(),
      RoomRuntimeLeaseUnavailableError,
    );
    assert.equal(acquisitionAttempts, 2);

    await winner.close();
    await loser.close();
    const retry = createRuntime();
    await retry.initialize();
    assert.equal(retry.readiness, "resources_ready");
    assert.equal(
      await currentRuntimeFencingEpoch(adminPool),
      epochBeforeRace + 2n,
    );
    await retry.close();
  },
);

test(
  "terminating a PostgreSQL lease connection fences the real runtime and drains admitted work",
  {
    skip: !runtimeIntegrationDatabase || !runtimeIntegrationUser,
  },
  async (t) => {
    if (!runtimeIntegrationDatabase || !runtimeIntegrationUser) {
      return;
    }

    const config = runtimeIntegrationPoolConfig(
      runtimeIntegrationDatabase,
      runtimeIntegrationUser,
    );
    const adminPool = createPostgresPool({
      host: "127.0.0.1",
      port: 55432,
      database: runtimeIntegrationDatabase,
      user: "postgres",
      max: 4,
    });
    const allowRuntimePoolClose = deferred<void>();
    const runtimePoolCloseStarted = deferred<void>();
    const runtimeALost = deferred<RoomRuntimeLeaseLostError>();
    let runtimeA: DurableRoomRuntime | undefined;
    let runtimeB: DurableRoomRuntime | undefined;
    let servicesA: DurableRoomRuntimeServices | undefined;
    let runRuntimeAHealthCheck: (() => void) | undefined;
    let runtimeAHealthCheckCancellations = 0;
    let runtimeALeaseLossNotifications = 0;
    let runtimeAAcquisitionAttempts = 0;
    let leaseBackendPid: number | undefined;
    let leaseTerminated = false;
    let rowLockClient: PoolClient | undefined;
    let admittedJoin: ReturnType<
      DurableRoomRuntimeServices["commands"]["joinRoom"]
    > | undefined;
    let runtimeAClose: Promise<void> | undefined;
    let runtimeBClose: Promise<void> | undefined;
    let runtimeBInitialization: Promise<void> | undefined;
    const roomCodes: string[] = [];

    const lockRows = () =>
      adminPool.query<{ pid: number }>(
        `SELECT lock.pid
         FROM pg_catalog.pg_locks AS lock
         WHERE lock.locktype = 'advisory'
           AND lock.database = (
             SELECT oid FROM pg_catalog.pg_database
             WHERE datname = current_database()
           )
           AND lock.classid = $1::oid
           AND lock.objid = $2::oid
           AND lock.objsubid = 2
           AND lock.mode = 'ExclusiveLock'
           AND lock.granted
         ORDER BY lock.pid`,
        [ROOM_RUNTIME_LOCK_KEY_1, ROOM_RUNTIME_LOCK_KEY_2],
      );

    const waitForLeaseBackendExit = async (pid: number): Promise<void> => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const held = await lockRows();
        if (!held.rows.some((row) => row.pid === pid)) {
          return;
        }
        await waitForNextEventLoopTurn();
      }
      assert.fail(`Lease backend ${pid} still holds the advisory lock.`);
    };

    t.after(async () => {
      allowRuntimePoolClose.resolve();
      if (rowLockClient) {
        await rowLockClient.query("ROLLBACK");
        rowLockClient.release();
        rowLockClient = undefined;
      }
      if (admittedJoin) {
        await Promise.allSettled([admittedJoin]);
      }
      if (runtimeAClose) {
        if (leaseTerminated) {
          await assert.rejects(runtimeAClose, (error) => error instanceof Error);
        } else {
          await runtimeAClose;
        }
      } else if (runtimeA && runtimeA.readiness !== "closed") {
        const shutdown = runtimeA.close();
        if (leaseTerminated) {
          await assert.rejects(shutdown, (error) => error instanceof Error);
        } else {
          await shutdown;
        }
      }
      if (runtimeBClose) {
        await runtimeBClose;
      } else if (runtimeB && runtimeB.readiness !== "closed") {
        await runtimeB.close();
      }
      for (const roomCode of roomCodes) {
        await adminPool.query(
          "DELETE FROM public.rooms WHERE room_code = $1",
          [roomCode],
        );
      }
      await adminPool.end();
    });

    const adminIdentity = await adminPool.query<{
      current_user: string;
      rolsuper: boolean;
    }>(
      `SELECT current_user,
              (SELECT rolsuper FROM pg_catalog.pg_roles
               WHERE rolname = current_user) AS rolsuper`,
    );
    assert.equal(adminIdentity.rows[0]?.current_user, "postgres");
    assert.equal(adminIdentity.rows[0]?.rolsuper, true);

    runtimeA = new DurableRoomRuntime(new RoomService(), config, {
      acquireLease: async (pool) => {
        runtimeAAcquisitionAttempts += 1;
        const lease = await acquireRoomRuntimeLease(pool);
        lease.onLost((error) => {
          runtimeALeaseLossNotifications += 1;
          runtimeALost.resolve(error);
        });
        return lease;
      },
      scheduleHealthChecks: (callback) => {
        runRuntimeAHealthCheck = callback;
        return () => {
          runtimeAHealthCheckCancellations += 1;
        };
      },
      healthCheckIntervalMs: 1_000,
      closePool: async (pool) => {
        runtimePoolCloseStarted.resolve();
        await allowRuntimePoolClose.promise;
        await pool.end();
      },
    });

    const epochBeforeA = await currentRuntimeFencingEpoch(adminPool);
    await runtimeA.initialize();
    servicesA = await runtimeA.recover({
      now: new Date(),
      reconnectGracePeriodMs: 60_000,
    });
    const epochA = await currentRuntimeFencingEpoch(adminPool);
    assert.equal(runtimeA.readiness, "serving_ready");
    assert.ok(runRuntimeAHealthCheck);
    assert.equal(epochA, epochBeforeA + 1n);

    const createdA = await servicesA.commands.createRoom(
      { nickname: "Runtime A host" },
      "runtime-a-host",
    );
    roomCodes.push(createdA.room.code);
    const initialRoomState = await adminPool.query<{
      id: string;
      version: string;
      max_players: number;
    }>(
      `SELECT id::text, version::text, max_players
       FROM public.rooms
       WHERE room_code = $1`,
      [createdA.room.code],
    );
    assert.equal(initialRoomState.rowCount, 1);
    assert.equal(initialRoomState.rows[0]?.version, "1");

    const lockClient = await adminPool.connect();
    rowLockClient = lockClient;
    await lockClient.query("BEGIN");
    const lockedRoom = await lockClient.query(
      `SELECT id
       FROM public.rooms
       WHERE room_code = $1
       FOR UPDATE`,
      [createdA.room.code],
    );
    assert.equal(lockedRoom.rowCount, 1);

    admittedJoin = servicesA.commands.joinRoom(
      { roomCode: createdA.room.code, nickname: "Runtime A member" },
      "runtime-a-member",
    );
    const joinSettled = { value: false };
    void admittedJoin.then(
      () => {
        joinSettled.value = true;
      },
      () => {
        joinSettled.value = true;
      },
    );

    const runPostgresRuntimeRecovery = async (
      recoveryTestContext: typeof t,
    ): Promise<void> => {
      if (!runtimeIntegrationDatabase || !runtimeIntegrationUser) {
        return;
      }

      const config = runtimeIntegrationPoolConfig(
        runtimeIntegrationDatabase,
        runtimeIntegrationUser,
      );
      const adminPool = createPostgresPool({
        host: "127.0.0.1",
        port: 55432,
        database: runtimeIntegrationDatabase,
        user: "postgres",
        max: 4,
      });
      const roomCodes: RoomCode[] = [];
      let runtimeA: DurableRoomRuntime | undefined;
      let runtimeB: DurableRoomRuntime | undefined;

      recoveryTestContext.after(async () => {
        try {
          if (runtimeB && runtimeB.readiness !== "closed") {
            await runtimeB.close();
          }
          if (runtimeA && runtimeA.readiness !== "closed") {
            await runtimeA.close();
          }
          for (const roomCode of roomCodes) {
            await adminPool.query(
              "DELETE FROM public.rooms WHERE room_code = $1",
              [roomCode],
            );
          }
        } finally {
          await adminPool.end();
        }
      });

      const initialRecoveryInput = {
        now: new Date(),
        reconnectGracePeriodMs: 3_600_000,
      };
      const roomsA = new RoomService();
      runtimeA = new DurableRoomRuntime(roomsA, config, {
        scheduleHealthChecks: () => () => {},
      });
      await runtimeA.initialize();
      const servicesA = await runtimeA.recover(initialRecoveryInput);

      const mainRoom = await servicesA.commands.createRoom(
        {
          nickname: "Recovery host",
          settings: {
            gameMode: "impostor-classic",
            maxPlayers: 8,
            isPrivate: true,
          },
        },
        "recovery-host-socket",
      );
      roomCodes.push(mainRoom.room.code);
      const futureMember = await servicesA.commands.joinRoom(
        { roomCode: mainRoom.room.code, nickname: "Future member" },
        "future-member-socket",
      );
      const expiredMember = await servicesA.commands.joinRoom(
        { roomCode: mainRoom.room.code, nickname: "Expired member" },
        "expired-member-socket",
      );
      const legacyMember = await servicesA.commands.joinRoom(
        { roomCode: mainRoom.room.code, nickname: "Legacy member" },
        "legacy-member-socket",
      );
      await servicesA.commands.disconnectSocket("future-member-socket", 3_600_000);
      await servicesA.commands.disconnectSocket("expired-member-socket", 3_600_000);
      await servicesA.commands.disconnectSocket("legacy-member-socket", 3_600_000);

      const expiredDeadline = new Date(Date.now() - 1_000);
      await adminPool.query(
        `UPDATE public.room_players AS player
         SET reconnect_deadline_at = $1
         FROM public.rooms AS room
         WHERE room.id = player.room_id
           AND room.room_code = $2
           AND player.player_id = $3`,
        [expiredDeadline, mainRoom.room.code, expiredMember.playerId],
      );
      await adminPool.query(
        "ALTER TABLE public.room_players DROP CONSTRAINT room_players_disconnected_deadline_required",
      );
      try {
        await adminPool.query(
          `UPDATE public.room_players AS player
           SET reconnect_deadline_at = NULL
           FROM public.rooms AS room
           WHERE room.id = player.room_id
             AND room.room_code = $1
             AND player.player_id = $2`,
          [mainRoom.room.code, legacyMember.playerId],
        );
      } finally {
        await adminPool.query(
          `ALTER TABLE public.room_players
           ADD CONSTRAINT room_players_disconnected_deadline_required
           CHECK (
             membership_status <> 'active'
             OR connection_status <> 'disconnected'
             OR reconnect_deadline_at IS NOT NULL
           ) NOT VALID`,
        );
      }

      const manhuntBoundary = {
        center: { latitude: 51.5074, longitude: -0.1278 },
        radiusMeters: 500,
      };
      const manhuntRoom = await servicesA.commands.createRoom(
        {
          nickname: "Manhunt host",
          settings: {
            gameMode: "manhunt",
            maxPlayers: 8,
            isPrivate: true,
            manhunt: { hunterCount: 1, boundary: manhuntBoundary },
          },
        },
        "manhunt-host-socket",
      );
      roomCodes.push(manhuntRoom.room.code);

      const emptyRoom = await servicesA.commands.createRoom(
        { nickname: "Expiring host" },
        "expiring-host-socket",
      );
      roomCodes.push(emptyRoom.room.code);
      await servicesA.commands.disconnectSocket("expiring-host-socket", 3_600_000);
      await adminPool.query(
        `UPDATE public.room_players AS player
         SET reconnect_deadline_at = $1
         FROM public.rooms AS room
         WHERE room.id = player.room_id
           AND room.room_code = $2
           AND player.player_id = $3`,
        [
          expiredDeadline,
          emptyRoom.room.code,
          emptyRoom.playerId,
        ],
      );

      const interruptedRooms: Array<{
        status: "starting" | "in_progress" | "finished";
        gameId: GameSessionId;
      }> = [
        {
          status: "starting",
          gameId: "20000000-0000-4000-8000-000000000001" as GameSessionId,
        },
        {
          status: "in_progress",
          gameId: "20000000-0000-4000-8000-000000000002" as GameSessionId,
        },
        {
          status: "finished",
          gameId: "20000000-0000-4000-8000-000000000003" as GameSessionId,
        },
      ];
      const interruptedRoomCodes: Array<{
        status: "starting" | "in_progress" | "finished";
        roomCode: RoomCode;
      }> = [];
      for (const scenario of interruptedRooms) {
        const created = await servicesA.commands.createRoom(
          { nickname: `${scenario.status} host` },
          `${scenario.status}-host-socket`,
        );
        roomCodes.push(created.room.code);
        interruptedRoomCodes.push({
          status: scenario.status,
          roomCode: created.room.code,
        });
        let transition = await servicesA.repository.transitionRoomGameStatus({
          roomCode: created.room.code,
          expectedRoomId: servicesA.coordinator.getMetadata(created.room.code)!.roomId,
          expectedStatus: "waiting",
          nextStatus: "starting",
          expectedVersion: "1",
          expectedCurrentGameId: null,
          nextGameId: scenario.gameId,
          initiatedBy: { kind: "host", playerId: created.playerId },
        });
        if (scenario.status !== "starting") {
          transition = await servicesA.repository.transitionRoomGameStatus({
            roomCode: created.room.code,
            expectedRoomId: servicesA.coordinator.getMetadata(created.room.code)!.roomId,
            expectedStatus: "starting",
            nextStatus: "in_progress",
            expectedVersion: transition.version,
            expectedCurrentGameId: scenario.gameId,
            nextGameId: scenario.gameId,
            initiatedBy: { kind: "game-service" },
          });
        }
        if (scenario.status === "finished") {
          transition = await servicesA.repository.transitionRoomGameStatus({
            roomCode: created.room.code,
            expectedRoomId: servicesA.coordinator.getMetadata(created.room.code)!.roomId,
            expectedStatus: "in_progress",
            nextStatus: "finished",
            expectedVersion: transition.version,
            expectedCurrentGameId: scenario.gameId,
            nextGameId: scenario.gameId,
            initiatedBy: { kind: "game-service" },
          });
        }
        assert.equal(transition.gameStatus, scenario.status);
      }

      await runtimeA.close();
      const roomsB = new RoomService();
      runtimeB = new DurableRoomRuntime(roomsB, config, {
        scheduleHealthChecks: () => () => {},
      });
      await runtimeB.initialize();
      assert.equal(runtimeB.readiness, "resources_ready");
      assert.throws(() => runtimeB.services, /not ready/);
      const servicesB = await runtimeB.recover({
        now: new Date(),
        reconnectGracePeriodMs: 3_600_000,
      });
      assert.equal(runtimeB.readiness, "serving_ready");

      const recoveredMain = roomsB.getPublicRoom(mainRoom.room.code);
      assert.ok(recoveredMain);
      assert.equal(recoveredMain.hostId, mainRoom.playerId);
      assert.equal(recoveredMain.settings.maxPlayers, 8);
      assert.equal(recoveredMain.settings.isPrivate, true);
      assert.deepEqual(
        recoveredMain.players.map((player) => player.id).sort(),
        [mainRoom.playerId, futureMember.playerId].sort(),
      );
      assert.deepEqual(
        recoveredMain.players
          .map((player) => player.nickname)
          .sort(),
        ["Future member", "Recovery host"],
      );
      assert.ok(
        recoveredMain.players.every(
          (player) => player.connectionStatus === "disconnected",
        ),
      );
      assert.equal(
        roomsB.getSocketIdForPlayer(mainRoom.room.code, mainRoom.playerId),
        undefined,
      );
      assert.equal(
        roomsB.getSocketIdForPlayer(mainRoom.room.code, futureMember.playerId),
        undefined,
      );
      assert.equal(JSON.stringify(recoveredMain).includes("reconnectToken"), false);
      assert.equal(JSON.stringify(recoveredMain).includes("boundary"), false);

      const manhuntRecovered = roomsB.getPublicRoom(manhuntRoom.room.code);
      assert.ok(manhuntRecovered);
      assert.deepEqual(
        roomsB.getManhuntBoundary(manhuntRoom.room.code),
        manhuntBoundary,
      );
      assert.equal(JSON.stringify(manhuntRecovered).includes("boundary"), false);

      const roomState = await adminPool.query<{
        id: string;
        version: string;
        lifecycle_status: string;
        game_status: string;
        current_game_id: string | null;
      }>(
        `SELECT id::text, version::text, lifecycle_status, game_status,
                current_game_id::text
         FROM public.rooms
         WHERE room_code = $1`,
        [mainRoom.room.code],
      );
      assert.equal(roomState.rowCount, 1);
      const metadata = servicesB.coordinator.getMetadata(mainRoom.room.code);
      assert.ok(metadata);
      assert.equal(metadata.roomId, roomState.rows[0]?.id);
      assert.equal(metadata.version, roomState.rows[0]?.version);
      assert.equal(metadata.lifecycleStatus, roomState.rows[0]?.lifecycle_status);
      assert.equal(metadata.currentGameId, roomState.rows[0]?.current_game_id);
      assert.equal(metadata.lifecycleStatus, "active");
      assert.equal(metadata.currentGameId, null);

      const futureMemberState = await adminPool.query<{
        reconnect_deadline_at: Date | null;
        connection_status: string;
      }>(
        `SELECT reconnect_deadline_at, connection_status
         FROM public.room_players
         WHERE room_id = $1 AND player_id = $2`,
        [metadata.roomId, futureMember.playerId],
      );
      assert.equal(futureMemberState.rows[0]?.connection_status, "disconnected");
      assert.ok(
        futureMemberState.rows[0]?.reconnect_deadline_at
          && futureMemberState.rows[0].reconnect_deadline_at > new Date(),
      );

      await assert.rejects(
        servicesB.commands.reconnect(
          {
            roomCode: mainRoom.room.code,
            playerId: mainRoom.playerId,
            reconnectToken: "invalid-token",
          },
          "invalid-reconnect-socket",
        ),
        (error) => error instanceof AppError && error.code === "NOT_AUTHORIZED",
      );
      await servicesB.commands.reconnect(
        {
          roomCode: mainRoom.room.code,
          playerId: mainRoom.playerId,
          reconnectToken: mainRoom.reconnectToken,
        },
        "recovered-host-socket",
      );
      await servicesB.commands.reconnect(
        {
          roomCode: mainRoom.room.code,
          playerId: futureMember.playerId,
          reconnectToken: futureMember.reconnectToken,
        },
        "recovered-future-member-socket",
      );

      const recoveredVersion = servicesB.coordinator.getMetadata(
        mainRoom.room.code,
      )?.version;
      assert.ok(recoveredVersion);
      const staleJoin = roomsB.prepareRoomJoin(
        { roomCode: mainRoom.room.code, nickname: "Stale contender" },
        "stale-contender-socket",
      );
      await assert.rejects(
        servicesB.repository.joinRoom({
          roomCode: staleJoin.roomCode,
          playerId: staleJoin.playerId,
          nickname: staleJoin.nickname,
          reconnectTokenHash: Buffer.from(staleJoin.reconnectTokenHash),
          expectedRoomId: metadata.roomId,
          expectedVersion: (BigInt(recoveredVersion) - 1n).toString(),
        }),
        (error) => error instanceof RoomJoinError && error.code === "STALE_VERSION",
      );
      const joinedAfterRecovery = await servicesB.commands.joinRoom(
        { roomCode: mainRoom.room.code, nickname: "Post-recovery member" },
        "post-recovery-member-socket",
      );
      assert.equal(joinedAfterRecovery.room.players.length, 3);
      const finalMetadata = servicesB.coordinator.getMetadata(mainRoom.room.code);
      assert.ok(finalMetadata);
      assert.equal(finalMetadata.version, (BigInt(recoveredVersion) + 1n).toString());

      const postRecoveryRoom = await servicesB.commands.createRoom(
        { nickname: "Post-recovery host" },
        "post-recovery-host-socket",
      );
      roomCodes.push(postRecoveryRoom.room.code);
      assert.equal(
        servicesB.coordinator.getMetadata(postRecoveryRoom.room.code)?.version,
        "1",
      );
      await servicesB.commands.joinRoom(
        { roomCode: postRecoveryRoom.room.code, nickname: "Post-recovery guest" },
        "post-recovery-guest-socket",
      );
      assert.equal(
        servicesB.coordinator.getMetadata(postRecoveryRoom.room.code)?.version,
        "2",
      );
      await servicesB.commands.leaveRoom(
        postRecoveryRoom.room.code,
        "post-recovery-guest-socket",
      );
      assert.equal(
        servicesB.coordinator.getMetadata(postRecoveryRoom.room.code)?.version,
        "3",
      );

      const removedMembers = await adminPool.query<{
        player_id: string;
        membership_status: string;
      }>(
        `SELECT player_id::text, membership_status
         FROM public.room_players
         WHERE room_id = $1 AND player_id = ANY($2::uuid[])
         ORDER BY player_id`,
        [
          metadata.roomId,
          [expiredMember.playerId, legacyMember.playerId],
        ],
      );
      assert.equal(removedMembers.rowCount, 2);
      assert.ok(
        removedMembers.rows.every((member) => member.membership_status === "removed"),
      );
      assert.equal(roomsB.getPublicRoom(emptyRoom.room.code), undefined);
      const deletedEmptyRoom = await adminPool.query(
        "SELECT 1 FROM public.rooms WHERE room_code = $1",
        [emptyRoom.room.code],
      );
      assert.equal(deletedEmptyRoom.rowCount, 0);

      for (const scenario of interruptedRoomCodes) {
        const state = await adminPool.query<{
          lifecycle_status: string;
          game_status: string;
          active_members: string;
        }>(
          `SELECT room.lifecycle_status, room.game_status,
                  (SELECT count(*)::text FROM public.room_players AS player
                   WHERE player.room_id = room.id
                     AND player.membership_status = 'active') AS active_members
           FROM public.rooms AS room
           WHERE room.room_code = $1`,
          [scenario.roomCode],
        );
        assert.equal(state.rows[0]?.lifecycle_status, "closed");
        assert.equal(state.rows[0]?.game_status, scenario.status);
        assert.equal(state.rows[0]?.active_members, "0");
      }
    };
    await waitForPostgresLockWait(adminPool, "FROM public.rooms");
    assert.equal(joinSettled.value, false);

    const leaseLocks = await lockRows();
    assert.equal(leaseLocks.rowCount, 1);
    leaseBackendPid = leaseLocks.rows[0]?.pid;
    assert.ok(leaseBackendPid);
    const adminBackend = await adminPool.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    assert.notEqual(leaseBackendPid, adminBackend.rows[0]?.pid);

    const terminated = await adminPool.query<{ terminated: boolean }>(
      "SELECT pg_terminate_backend($1) AS terminated",
      [leaseBackendPid],
    );
    assert.equal(terminated.rows[0]?.terminated, true);
    leaseTerminated = true;

    await runtimeALost.promise;
    await waitForRuntimeReadiness(runtimeA, "lease_lost");
    const firstLeaseFailure = runtimeA.leaseFailure;
    assert.ok(firstLeaseFailure instanceof RoomRuntimeLeaseLostError);
    assert.ok(
      [
        "lease_connection_error",
        "lease_connection_ended",
        "lease_health_check_failed",
      ].includes(firstLeaseFailure.reason),
    );
    assert.equal(runtimeALeaseLossNotifications, 1);
    assert.equal(runtimeAHealthCheckCancellations, 1);
    assert.equal(runtimeA.isResourceReady, false);
    assert.throws(() => runtimeA.services, /not ready/);
    assert.equal(runtimeAAcquisitionAttempts, 1);

    await assert.rejects(
      servicesA.commands.createRoom(
        { nickname: "Rejected after lease loss" },
        "runtime-a-rejected",
      ),
      /not accepting persistence operations/,
    );

    runtimeB = new DurableRoomRuntime(new RoomService(), config, {
      scheduleHealthChecks: () => () => {},
      healthCheckIntervalMs: 1_000,
    });
    await waitForLeaseBackendExit(leaseBackendPid);
    runtimeBInitialization = runtimeB.initialize();
    void runtimeBInitialization.then(
      () => undefined,
      () => undefined,
    );
    await waitForPostgresLockWait(
      adminPool,
      "UPDATE public.room_runtime_fencing",
    );
    assert.equal(runtimeB.readiness, "initializing");
    assert.equal(await currentRuntimeFencingEpoch(adminPool), epochA);

    runtimeAClose = runtimeA.close();
    assert.equal(runtimeA.readiness, "draining");
    const closeSettled = { value: false };
    void runtimeAClose.then(
      () => {
        closeSettled.value = true;
      },
      () => {
        closeSettled.value = true;
      },
    );
    await waitForNextEventLoopTurn();
    assert.equal(closeSettled.value, false);

    await lockClient.query("COMMIT");
    lockClient.release();
    rowLockClient = undefined;

    const [joinedA] = await Promise.all([admittedJoin, runtimeBInitialization]);
    assert.equal(joinedA.room.players.length, 2);
    assert.equal(runtimeB.readiness, "resources_ready");
    const servicesB = await runtimeB.recover({
      now: new Date(),
      reconnectGracePeriodMs: 60_000,
    });
    assert.equal(runtimeB.readiness, "serving_ready");
    const epochB = await currentRuntimeFencingEpoch(adminPool);
    assert.equal(epochB, epochA + 1n);

    const bLeaseLocks = await lockRows();
    assert.equal(bLeaseLocks.rowCount, 1);
    assert.notEqual(bLeaseLocks.rows[0]?.pid, leaseBackendPid);

    const createdB = await servicesB.commands.createRoom(
      { nickname: "Runtime B host" },
      "runtime-b-host",
    );
    roomCodes.push(createdB.room.code);

    await runtimePoolCloseStarted.promise;
    const beforeStaleWrite = await adminPool.query<{
      version: string;
      is_private: boolean;
    }>(
      `SELECT version::text,
              (settings ->> 'isPrivate')::boolean AS is_private
       FROM public.rooms
       WHERE room_code = $1`,
      [createdA.room.code],
    );
    const staleSettings: RoomSettings = {
      gameMode: "impostor-classic",
      maxPlayers: createdA.room.settings.maxPlayers,
      isPrivate: !createdA.room.settings.isPrivate,
      classicImpostor: {
        impostorCount: DEFAULT_IMPOSTOR_COUNT,
        discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
        votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
      },
    };
    await assert.rejects(
      servicesA.repository.updateWaitingRoomSettings({
        roomCode: createdA.room.code,
        requestingPlayerId: createdA.playerId,
        settings: staleSettings,
      }),
      RoomRuntimeFencingError,
    );
    const afterStaleWrite = await adminPool.query<{
      version: string;
      is_private: boolean;
    }>(
      `SELECT version::text,
              (settings ->> 'isPrivate')::boolean AS is_private
       FROM public.rooms
       WHERE room_code = $1`,
      [createdA.room.code],
    );
    assert.deepEqual(afterStaleWrite.rows[0], beforeStaleWrite.rows[0]);

    runRuntimeAHealthCheck?.();
    await waitForNextEventLoopTurn();
    assert.strictEqual(runtimeA.leaseFailure, firstLeaseFailure);
    assert.equal(runtimeALeaseLossNotifications, 1);
    assert.equal(runtimeAAcquisitionAttempts, 1);

    allowRuntimePoolClose.resolve();
    await assert.rejects(
      runtimeAClose,
      (error) => error instanceof Error,
    );
    assert.equal(runtimeA.readiness, "closed");
    assert.equal(runtimeA.isResourceReady, false);
    await assert.rejects(runtimeA.initialize(), /current state/);
    assert.equal(runtimeAAcquisitionAttempts, 1);

    runtimeBClose = runtimeB.close();
    await runtimeBClose;
    assert.equal(runtimeB.readiness, "closed");

    await t.test(
      "PostgreSQL runtime recovery restores only eligible waiting-room state",
      {
        skip: !runtimeIntegrationDatabase || !runtimeIntegrationUser,
      },
      runPostgresRuntimeRecovery,
    );
  },
);
