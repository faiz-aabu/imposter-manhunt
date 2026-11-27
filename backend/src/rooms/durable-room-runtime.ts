import type { Pool, PoolConfig } from "pg";
import type { RoomCode } from "@impostor/api";
import {
  acquireRoomRuntimeLease,
  createPostgresPool,
} from "../db/postgres.js";
import type { RoomRuntimeLease } from "../db/postgres.js";
import { PostgresRoomRepository } from "./postgres-room-repository.js";
import type { PrepareForRuntimeRecoveryInput } from "./postgres-room-repository.js";
import { RoomPersistenceCommands } from "./room-persistence-commands.js";
import { RoomPersistenceCoordinator } from "./room-persistence-coordinator.js";
import { RoomMutationReconciliationWorker } from "./room-mutation-reconciliation-worker.js";
import type {
  RoomMutationReconciliationDiagnostics,
} from "./room-mutation-reconciliation-worker.js";
import {
  DurableRoomExpirationWorker,
} from "./durable-room-expiration-worker.js";
import type {
  DurableRoomExpirationDiagnostics,
} from "./durable-room-expiration-worker.js";
import { MAX_ROOM_EXPIRATION_BATCH_SIZE } from "./postgres-room-repository.js";
import { RoomService } from "./room-service.js";

export type DurableRoomRuntimeReadiness =
  | "uninitialized"
  | "initializing"
  | "resources_ready"
  | "recovering"
  | "serving_ready"
  | "lease_lost"
  | "draining"
  | "closed"
  | "failed";

export interface DurableRoomRuntimeServices {
  readonly repository: PostgresRoomRepository;
  readonly coordinator: RoomPersistenceCoordinator;
  readonly commands: RoomPersistenceCommands;
}

export interface DurableRoomRuntimeDiagnostics {
  readonly roomReconciliation: RoomMutationReconciliationDiagnostics;
  readonly roomExpiration: DurableRoomExpirationDiagnostics;
}

export interface DurableRoomRuntimeDependencies {
  createPool(config: PoolConfig): Pool | Promise<Pool>;
  createRepository(pool: Pool): PostgresRoomRepository;
  createCoordinator(): RoomPersistenceCoordinator;
  acquireLease(pool: Pool): Promise<RoomRuntimeLease>;
  createCommands(
    rooms: RoomService,
    repository: PostgresRoomRepository,
    coordinator: RoomPersistenceCoordinator,
  ): RoomPersistenceCommands;
  closePool(pool: Pool): Promise<void>;
  scheduleHealthChecks(
    callback: () => void,
    intervalMs: number,
  ): () => void;
  scheduleReconciliationRetry(
    callback: () => void,
    delayMs: number,
  ): () => void;
  scheduleExpirationCleanup(
    callback: () => void,
    delayMs: number,
  ): () => void;
  healthCheckIntervalMs: number;
  shutdownDrainTimeoutMs?: number;
}

const ROOM_RUNTIME_HEALTH_CHECK_INTERVAL_MS = 5_000;
const ROOM_RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

class RoomRuntimeShutdownTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Durable room runtime shutdown exceeded ${timeoutMs} milliseconds.`);
    this.name = "RoomRuntimeShutdownTimeoutError";
  }
}

function scheduleHealthChecks(
  callback: () => void,
  intervalMs: number,
): () => void {
  const timer = setInterval(callback, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function scheduleReconciliationRetry(
  callback: () => void,
  delayMs: number,
): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

function scheduleExpirationCleanup(
  callback: () => void,
  delayMs: number,
): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

const defaultDependencies: DurableRoomRuntimeDependencies = {
  createPool: createPostgresPool,
  createRepository: (pool) => new PostgresRoomRepository(pool),
  createCoordinator: () => new RoomPersistenceCoordinator(),
  acquireLease: acquireRoomRuntimeLease,
  createCommands: (rooms, repository, coordinator) =>
    new RoomPersistenceCommands(rooms, repository, coordinator),
  closePool: (pool) => pool.end(),
  scheduleHealthChecks,
  scheduleReconciliationRetry,
  scheduleExpirationCleanup,
  healthCheckIntervalMs: ROOM_RUNTIME_HEALTH_CHECK_INTERVAL_MS,
};

const GUARDED_COMMAND_METHODS = new Set<PropertyKey>([
  "createRoom",
  "joinRoom",
  "leaveRoom",
  "updateRoomSettings",
  "updateManhuntSettings",
  "acquireGameStatusReservation",
  "transitionRoomGameStatus",
  "finishGame",
  "returnFinishedGameToLobby",
  "disconnectSocket",
  "reconnect",
  "removeDisconnectedPlayer",
  "reconcileDeferredRoomMutations",
  "listDueWaitingRoomExpirations",
  "expireWaitingRoom",
  "completeExpiredRoomCleanup",
  "fenceRoom",
]);

const runtimeGuardedCommands = new WeakSet<object>();

export function isRuntimeGuardedRoomPersistenceCommands(
  commands: RoomPersistenceCommands,
): boolean {
  return runtimeGuardedCommands.has(commands);
}

class PersistenceOperationGate {
  private state: "closed" | "accepting" | "draining" = "closed";
  private readonly inFlight = new Set<Promise<unknown>>();

  startAccepting(): void {
    if (this.state !== "closed") {
      throw new Error("Persistence operations cannot be enabled in this state.");
    }
    this.state = "accepting";
  }

  beginDraining(): void {
    this.state = "draining";
  }

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state !== "accepting") {
      return Promise.reject(
        new Error("Durable room runtime is not accepting persistence operations."),
      );
    }

    let resolveOperation!: (value: T | PromiseLike<T>) => void;
    let rejectOperation!: (reason?: unknown) => void;
    const operationPromise = new Promise<T>((resolve, reject) => {
      resolveOperation = resolve;
      rejectOperation = reject;
    });
    this.inFlight.add(operationPromise);
    void operationPromise.then(
      () => this.inFlight.delete(operationPromise),
      () => this.inFlight.delete(operationPromise),
    );
    try {
      resolveOperation(operation());
    } catch (error) {
      rejectOperation(error);
    }
    return operationPromise;
  }

  runSync<T>(operation: () => T): T {
    if (this.state !== "accepting") {
      throw new Error("Durable room runtime is not accepting persistence operations.");
    }
    return operation();
  }

  async drain(): Promise<void> {
    this.beginDraining();
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }
}

function guardPersistenceCommands(
  commands: RoomPersistenceCommands,
  gate: PersistenceOperationGate,
): RoomPersistenceCommands {
  const guarded = new Proxy(commands, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (!GUARDED_COMMAND_METHODS.has(property) || typeof method !== "function") {
        return method;
      }
      if (property === "fenceRoom") {
        return (...args: unknown[]) =>
          gate.runSync(() => Reflect.apply(method, target, args));
      }
      return (...args: unknown[]) =>
        gate.run(() => Promise.resolve(Reflect.apply(method, target, args)));
    },
  });
  runtimeGuardedCommands.add(guarded);
  return guarded;
}

async function disposeResources(
  lease: RoomRuntimeLease | undefined,
  pool: Pool | undefined,
  closePool: (pool: Pool) => Promise<void>,
): Promise<unknown[]> {
  const errors: unknown[] = [];
  if (lease) {
    try {
      await lease.release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (pool) {
    try {
      await closePool(pool);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function throwCleanupErrors(
  errors: unknown[],
  message: string,
  cause?: unknown,
): void {
  if (errors.length === 1 && cause === undefined) {
    throw errors[0];
  }
  if (errors.length > 0) {
    throw new AggregateError(
      cause === undefined ? errors : [cause, ...errors],
      message,
      cause === undefined ? undefined : { cause },
    );
  }
}

/**
 * Owns durable-room resources only. `resources_ready` means the pool,
 * repository, coordinator, commands, and runtime lease are initialized; it
 * does not mean recovery is complete or that the backend may serve clients.
 * This owner is intentionally not wired into the live backend startup.
 */
export class DurableRoomRuntime {
  private readonly dependencies: DurableRoomRuntimeDependencies;
  private readonly operationGate = new PersistenceOperationGate();
  private readinessValue: DurableRoomRuntimeReadiness = "uninitialized";
  private initializationPromise?: Promise<void>;
  private recoveryPromise?: Promise<DurableRoomRuntimeServices>;
  private closePromise?: Promise<void>;
  private resources?: DurableRoomRuntimeServices;
  private pool?: Pool;
  private lease?: RoomRuntimeLease;
  private closeRequested = false;
  private initializationCleanupFailure?: AggregateError;
  private healthCheckCancel?: () => void;
  private readonly reconciliationWorker: RoomMutationReconciliationWorker;
  private readonly expirationWorker: DurableRoomExpirationWorker;
  private readonly shutdownDrainTimeoutMs: number;
  private removeLeaseLostListener?: () => void;
  private removeDeferredMutationBlockedListener?: () => void;
  private pendingHealthCheck?: Promise<void>;
  private leaseLoss?: Error;
  private readonly leaseLostListeners = new Set<(error: Error) => void>();

  constructor(
    private readonly rooms: RoomService,
    private readonly poolConfig: PoolConfig,
    dependencies: Partial<DurableRoomRuntimeDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
    this.shutdownDrainTimeoutMs =
      this.dependencies.shutdownDrainTimeoutMs
      ?? ROOM_RUNTIME_SHUTDOWN_DRAIN_TIMEOUT_MS;
    if (
      !Number.isInteger(this.shutdownDrainTimeoutMs)
      || this.shutdownDrainTimeoutMs < 1
    ) {
      throw new RangeError("Durable runtime shutdown timeout must be a positive integer.");
    }
    this.reconciliationWorker = new RoomMutationReconciliationWorker({
      isServingReady: () => this.isServingReady && !this.leaseLoss,
      hasBlockedWork: (roomCode) =>
        this.rooms.hasBlockedDeferredRoomMutations(roomCode),
      reconcile: async (roomCode) => {
        const commands = this.resources?.commands;
        if (!commands) {
          throw new Error("Durable room commands are unavailable for reconciliation.");
        }
        return commands.reconcileDeferredRoomMutations(roomCode);
      },
      now: () => Date.now(),
      scheduleTimeout: this.dependencies.scheduleReconciliationRetry,
      report: (event, roomCode, attempt, error) => {
        console.error(
          JSON.stringify({
            level: event === "started" ? "info" : "error",
            event: `deferred_room_reconciliation_${event}`,
            roomCode,
            attempt,
            ...(error instanceof Error
              ? { error: error.name }
              : error === undefined
                ? {}
                : { error: "unknown" }),
          }),
        );
      },
    });
    this.expirationWorker = new DurableRoomExpirationWorker({
      isServingReady: () => this.isServingReady && !this.leaseLoss,
      scheduleTimeout: this.dependencies.scheduleExpirationCleanup,
      listDue: async (limit) => {
        const commands = this.resources?.commands;
        if (!commands) {
          throw new Error("Durable room commands are unavailable for expiration.");
        }
        return commands.listDueWaitingRoomExpirations(limit);
      },
      expire: async (candidate) => {
        const commands = this.resources?.commands;
        if (!commands) {
          throw new Error("Durable room commands are unavailable for expiration.");
        }
        return commands.expireWaitingRoom(candidate);
      },
      completeCleanup: async (expired) => {
        const commands = this.resources?.commands;
        if (!commands) {
          throw new Error("Durable room commands are unavailable for expiration.");
        }
        return commands.completeExpiredRoomCleanup(expired);
      },
      reportFailure: (error, roomCode) => {
        console.error(
          JSON.stringify({
            level: "error",
            event: "durable_room_expiration_failed",
            ...(roomCode ? { roomCode } : {}),
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      },
    });
    this.removeDeferredMutationBlockedListener =
      this.rooms.onDeferredRoomMutationBlocked((roomCode) => {
        if (this.closeRequested) {
          this.rooms.rejectBlockedDeferredRoomMutations(
            new Error("Durable room runtime is shutting down."),
          );
        } else if (this.leaseLoss) {
          this.rooms.rejectBlockedDeferredRoomMutations(this.leaseLoss);
        } else {
          this.reconciliationWorker.request(roomCode);
        }
      });
  }

  get readiness(): DurableRoomRuntimeReadiness {
    return this.readinessValue;
  }

  get isResourceReady(): boolean {
    return (
      this.readinessValue === "resources_ready" ||
      this.readinessValue === "recovering" ||
      this.readinessValue === "serving_ready"
    );
  }

  get isServingReady(): boolean {
    return this.readinessValue === "serving_ready";
  }

  get leaseFailure(): Error | undefined {
    return this.leaseLoss;
  }

  get isLeaseOwned(): boolean {
    return this.lease !== undefined && this.leaseLoss === undefined;
  }

  getDiagnostics(): DurableRoomRuntimeDiagnostics {
    return {
      roomReconciliation: this.reconciliationWorker.getDiagnostics(),
      roomExpiration: this.expirationWorker.getDiagnostics(),
    };
  }

  onLeaseLost(listener: (error: Error) => void): () => void {
    if (this.leaseLoss) {
      listener(this.leaseLoss);
      return () => {};
    }
    this.leaseLostListeners.add(listener);
    return () => this.leaseLostListeners.delete(listener);
  }

  get services(): DurableRoomRuntimeServices {
    if (!this.isServingReady || !this.resources) {
      throw new Error(
        "Durable room runtime services are not ready until recovery completes.",
      );
    }
    return this.resources;
  }

  initialize(): Promise<void> {
    if (
      this.readinessValue === "resources_ready" ||
      this.readinessValue === "recovering" ||
      this.readinessValue === "serving_ready"
    ) {
      return Promise.resolve();
    }
    if (this.readinessValue === "initializing" && this.initializationPromise) {
      return this.initializationPromise;
    }
    if (this.readinessValue === "failed" && this.initializationPromise) {
      return this.initializationPromise;
    }
    if (this.readinessValue !== "uninitialized") {
      return Promise.reject(
        new Error("Durable room runtime cannot be initialized in its current state."),
      );
    }

    this.readinessValue = "initializing";
    this.initializationPromise = this.initializeResources();
    return this.initializationPromise;
  }

  recover(
    input: PrepareForRuntimeRecoveryInput,
  ): Promise<DurableRoomRuntimeServices> {
    if (this.recoveryPromise) {
      return this.recoveryPromise;
    }
    if (
      this.readinessValue !== "resources_ready" ||
      !this.resources ||
      !this.lease
    ) {
      return Promise.reject(
        new Error("Durable room runtime resources are not ready for recovery."),
      );
    }

    this.readinessValue = "recovering";
    this.recoveryPromise = this.recoverWaitingRooms(input);
    return this.recoveryPromise;
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closeRequested = true;
    this.reconciliationWorker.stop();
    this.expirationWorker.stop();
    this.rooms.rejectBlockedDeferredRoomMutations(
      new Error("Durable room runtime is shutting down."),
    );
    if (this.readinessValue !== "closed") {
      this.readinessValue = "draining";
    }
    this.operationGate.beginDraining();
    this.stopHealthMonitoring();
    this.closePromise = this.closeWithinDeadline();
    return this.closePromise;
  }

  private async closeWithinDeadline(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const cleanup = this.closeResources();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new RoomRuntimeShutdownTimeoutError(this.shutdownDrainTimeoutMs)),
        this.shutdownDrainTimeoutMs,
      );
    });
    try {
      await Promise.race([cleanup, timeout]);
    } catch (error) {
      if (error instanceof RoomRuntimeShutdownTimeoutError) {
        void cleanup.catch((cleanupError: unknown) => {
          console.error(
            JSON.stringify({
              level: "error",
              event: "durable_runtime_delayed_shutdown_cleanup_failed",
              error:
                cleanupError instanceof Error
                  ? cleanupError.name
                  : "unknown",
            }),
          );
        });
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async initializeResources(): Promise<void> {
    let pool: Pool | undefined;
    let lease: RoomRuntimeLease | undefined;
    try {
      pool = await this.dependencies.createPool(this.poolConfig);
      if (this.closeRequested) {
        throw new Error("Durable room runtime closed during initialization.");
      }
      const repository = this.dependencies.createRepository(pool);
      const coordinator = this.dependencies.createCoordinator();
      lease = await this.dependencies.acquireLease(pool);
      if (this.closeRequested) {
        throw new Error("Durable room runtime closed during initialization.");
      }
      repository.setRuntimeFencingEpoch(lease.fencingEpoch);
      await lease.checkOwnership();
      if (this.closeRequested || this.leaseLoss) {
        throw new Error("Durable room runtime lease became unavailable during initialization.");
      }
      this.startHealthMonitoring(lease);
      if (this.leaseLoss) {
        throw new Error("Durable room runtime lease became unavailable during initialization.");
      }
      const commands = this.dependencies.createCommands(
        this.rooms,
        repository,
        coordinator,
      );

      if (this.closeRequested || this.leaseLoss) {
        throw new Error("Durable room runtime closed during initialization.");
      }

      const resources: DurableRoomRuntimeServices = {
        repository,
        coordinator,
        commands: guardPersistenceCommands(commands, this.operationGate),
      };
      this.pool = pool;
      this.lease = lease;
      this.resources = resources;
      this.readinessValue = "resources_ready";
    } catch (initializationError) {
      this.stopHealthMonitoring();
      if (this.pendingHealthCheck) {
        await this.pendingHealthCheck;
      }
      const cleanupErrors = await disposeResources(
        lease,
        pool,
        this.dependencies.closePool,
      );
      if (!this.closeRequested) {
        this.readinessValue = "failed";
      }
      if (cleanupErrors.length > 0) {
        this.initializationCleanupFailure = new AggregateError(
          [initializationError, ...cleanupErrors],
          "Durable room runtime initialization failed and cleanup was incomplete.",
          { cause: initializationError },
        );
        throw this.initializationCleanupFailure;
      }
      throw initializationError;
    }
  }

  private async closeResources(): Promise<void> {
    if (this.initializationPromise) {
      try {
        await this.initializationPromise;
      } catch {
        // Initialization owns cleanup of resources created before it failed.
      }
    }
    if (this.recoveryPromise) {
      try {
        await this.recoveryPromise;
      } catch {
        // Recovery never owns resource cleanup.
      }
    }
    if (this.pendingHealthCheck) {
      await this.pendingHealthCheck;
    }
    await this.operationGate.drain();
    await this.reconciliationWorker.drain();
    await this.expirationWorker.drain();

    const lease = this.lease;
    const pool = this.pool;
    this.lease = undefined;
    this.pool = undefined;
    this.resources = undefined;

    const shutdownCleanupErrors = await disposeResources(
      lease,
      pool,
      this.dependencies.closePool,
    );
    this.removeDeferredMutationBlockedListener?.();
    this.removeDeferredMutationBlockedListener = undefined;
    const cleanupErrors = [
      ...(this.initializationCleanupFailure
        ? [this.initializationCleanupFailure]
        : []),
      ...shutdownCleanupErrors,
    ];
    this.readinessValue = "closed";
    throwCleanupErrors(
      cleanupErrors,
      "Durable room runtime shutdown was incomplete.",
    );
  }

  private startHealthMonitoring(lease: RoomRuntimeLease): void {
    this.removeLeaseLostListener = lease.onLost((error) =>
      this.handleLeaseLost(error),
    );
    this.healthCheckCancel = this.dependencies.scheduleHealthChecks(
      () => this.runHealthCheck(lease),
      this.dependencies.healthCheckIntervalMs,
    );
  }

  private async recoverWaitingRooms(
    input: PrepareForRuntimeRecoveryInput,
  ): Promise<DurableRoomRuntimeServices> {
    const lease = this.lease;
    const resources = this.resources;
    if (!lease || !resources) {
      throw new Error("Durable room runtime resources are not ready for recovery.");
    }

    try {
      await lease.checkOwnership();
      this.assertRecoveryCanContinue();
      let expiredCount: number;
      do {
        await lease.checkOwnership();
        this.assertRecoveryCanContinue();
        expiredCount = await resources.repository.expireDueWaitingRooms(
          MAX_ROOM_EXPIRATION_BATCH_SIZE,
        );
      } while (expiredCount === MAX_ROOM_EXPIRATION_BATCH_SIZE);
      this.assertRecoveryCanContinue();
      await resources.repository.prepareForRuntimeRecovery(input);
      this.assertRecoveryCanContinue();
      const recoveredRooms =
        await resources.repository.loadRecoverableWaitingRooms();
      this.assertRecoveryCanContinue();

      for (const recoveredRoom of recoveredRooms) {
        resources.coordinator.registerRecoveredRoom(recoveredRoom);
        this.rooms.restoreWaitingRoom(recoveredRoom);
      }

      await lease.checkOwnership();
      this.assertRecoveryCanContinue();
      this.operationGate.startAccepting();
      this.readinessValue = "serving_ready";
      this.expirationWorker.start();
      return resources;
    } catch (error) {
      if (this.readinessValue === "recovering" && !this.closeRequested) {
        this.readinessValue = "failed";
      }
      throw error;
    }
  }

  private assertRecoveryCanContinue(): void {
    if (this.leaseLoss) {
      throw this.leaseLoss;
    }
    if (this.closeRequested || this.readinessValue !== "recovering") {
      throw new Error("Durable room runtime recovery was interrupted.");
    }
  }

  private runHealthCheck(lease: RoomRuntimeLease): void {
    if (this.closeRequested || this.leaseLoss || this.pendingHealthCheck) {
      return;
    }

    const check = lease.checkOwnership().catch((error: unknown) => {
      if (error instanceof Error) {
        this.handleLeaseLost(error);
      } else {
        this.handleLeaseLost(
          new Error("Room runtime lease health check failed."),
        );
      }
    });
    this.pendingHealthCheck = check;
    void check.then(() => {
      if (this.pendingHealthCheck === check) {
        this.pendingHealthCheck = undefined;
      }
    });
  }

  private handleLeaseLost(error: Error): void {
    if (this.leaseLoss) {
      return;
    }
    this.leaseLoss =
      error instanceof Error
        ? error
        : new Error("Room runtime lease ownership is uncertain.");
    this.stopHealthMonitoring();
    this.operationGate.beginDraining();
    this.reconciliationWorker.stop();
    this.expirationWorker.stop();
    this.rooms.rejectBlockedDeferredRoomMutations(this.leaseLoss);
    for (const listener of this.leaseLostListeners) {
      try {
        listener(this.leaseLoss);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "durable_runtime_lease_loss_listener_failed",
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    }
    this.leaseLostListeners.clear();
    if (!this.closeRequested) {
      this.readinessValue = "lease_lost";
    }
  }

  private stopHealthMonitoring(): void {
    this.healthCheckCancel?.();
    this.healthCheckCancel = undefined;
    this.removeLeaseLostListener?.();
    this.removeLeaseLostListener = undefined;
  }

}
