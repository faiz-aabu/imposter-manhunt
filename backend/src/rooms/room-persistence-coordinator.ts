import { roomCodeSchema } from "@impostor/api";
import type { GameSessionId, GameStatus, RoomCode } from "@impostor/api";
import type {
  CreatedRoomInfo,
  RecoverableWaitingRoom,
  RoomLifecycleStatus,
} from "./postgres-room-repository.js";

const MAX_TRACKED_ROOMS = 10_000;
const MAX_PENDING_OPERATIONS_PER_ROOM = 128;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION_PATTERN = /^[1-9]\d*$/;

export class RoomPersistenceCoordinatorCapacityError extends Error {
  constructor() {
    super("Room operation queue is full.");
    this.name = "RoomPersistenceCoordinatorCapacityError";
  }
}

export interface RoomPersistenceMetadata {
  readonly roomCode: RoomCode;
  readonly roomId: string;
  readonly version: string;
  readonly gameStatus: GameStatus;
  readonly currentGameId: GameSessionId | null;
  readonly lifecycleStatus: RoomLifecycleStatus;
}

export type RecoveredRoomPersistenceMetadata = Pick<
  RecoverableWaitingRoom,
  | "roomCode"
  | "roomId"
  | "version"
  | "gameStatus"
  | "currentGameId"
  | "lifecycleStatus"
>;

export interface VersionedRoomMutationResult {
  roomCode: RoomCode;
  roomId: string;
  version: string;
  gameStatus?: GameStatus;
  currentGameId?: GameSessionId | null;
  lifecycleStatus?: RoomLifecycleStatus;
}

export interface DeletedRoomMutationResult {
  roomCode: RoomCode;
  roomId: string;
  deleted: true;
}

export type CommittedRoomMutationResult =
  | VersionedRoomMutationResult
  | DeletedRoomMutationResult;

interface RoomQueue {
  pendingCount: number;
  tail: Promise<void>;
}

function validateRoomCode(roomCode: RoomCode): void {
  const parsed = roomCodeSchema.safeParse(roomCode);
  if (!parsed.success || parsed.data !== roomCode) {
    throw new TypeError("Room code must be four uppercase letters.");
  }
}

function validateRoomId(roomId: string): void {
  if (!UUID_PATTERN.test(roomId)) {
    throw new TypeError("Durable room ID must be a UUID.");
  }
}

function validateVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) {
    throw new TypeError("Room version must be a positive decimal string.");
  }
}

function copyMetadata(
  metadata: RoomPersistenceMetadata,
): RoomPersistenceMetadata {
  return { ...metadata };
}

/**
 * Holds server-only durable room identity and serializes operations in this
 * process. PostgreSQL row locks and expected-version checks remain the
 * cross-process concurrency authority. Callers must explicitly record a
 * committed repository result while inside runExclusive; callback return
 * values alone never advance metadata.
 */
export class RoomPersistenceCoordinator {
  private readonly roomsByCode = new Map<RoomCode, RoomPersistenceMetadata>();
  private readonly roomCodesById = new Map<string, RoomCode>();
  private readonly fencedRoomCodes = new Set<RoomCode>();
  private readonly queues = new Map<RoomCode, RoomQueue>();
  private readonly capacityWaiters = new Map<RoomCode, Set<() => void>>();

  get pendingRoomQueueCount(): number {
    return this.queues.size;
  }

  registerCreatedRoom(
    created: CreatedRoomInfo,
  ): RoomPersistenceMetadata {
    return this.register({
      roomCode: created.roomCode,
      roomId: created.roomId,
      version: created.version,
      gameStatus: "waiting",
      currentGameId: created.currentGameId,
      lifecycleStatus: created.lifecycleStatus,
    });
  }

  registerRecoveredRoom(
    recovered: RecoveredRoomPersistenceMetadata,
  ): RoomPersistenceMetadata {
    return this.register(recovered);
  }

  getMetadata(roomCode: RoomCode): RoomPersistenceMetadata | undefined {
    validateRoomCode(roomCode);
    const metadata = this.roomsByCode.get(roomCode);
    return metadata ? copyMetadata(metadata) : undefined;
  }

  isFenced(roomCode: RoomCode): boolean {
    validateRoomCode(roomCode);
    return this.fencedRoomCodes.has(roomCode);
  }

  synchronizeFencedMetadata(metadata: RoomPersistenceMetadata): void {
    validateRoomCode(metadata.roomCode);
    validateRoomId(metadata.roomId);
    validateVersion(metadata.version);
    const current = this.roomsByCode.get(metadata.roomCode);
    if (
      !this.fencedRoomCodes.has(metadata.roomCode)
      || !current
      || current.roomId !== metadata.roomId
    ) {
      throw new Error("Fenced room identity changed during reconciliation.");
    }
    if (
      !["active", "expired", "closed"].includes(metadata.lifecycleStatus)
      || !["waiting", "starting", "in_progress", "finished"].includes(
        metadata.gameStatus,
      )
      || (
        metadata.currentGameId !== null
        && (typeof metadata.currentGameId !== "string" || metadata.currentGameId.length === 0)
      )
    ) {
      throw new TypeError("Reconciled room metadata is invalid.");
    }
    this.roomsByCode.set(metadata.roomCode, copyMetadata(metadata));
  }

  clearFencedRoom(roomCode: RoomCode, roomId: string): void {
    validateRoomCode(roomCode);
    validateRoomId(roomId);
    const current = this.roomsByCode.get(roomCode);
    if (
      !this.fencedRoomCodes.has(roomCode)
      || !current
      || current.roomId !== roomId
    ) {
      throw new Error("Fenced room identity changed before reconciliation completed.");
    }
    this.fencedRoomCodes.delete(roomCode);
  }

  removeFencedDeletedRoom(
    roomCode: RoomCode,
    roomId: string,
    expectedVersion: string,
  ): void {
    validateRoomCode(roomCode);
    validateRoomId(roomId);
    validateVersion(expectedVersion);
    const current = this.roomsByCode.get(roomCode);
    if (
      !this.fencedRoomCodes.has(roomCode)
      || !current
      || current.roomId !== roomId
      || current.version !== expectedVersion
    ) {
      throw new Error("Deleted room identity changed during reconciliation.");
    }
    this.roomsByCode.delete(roomCode);
    this.roomCodesById.delete(roomId);
    this.fencedRoomCodes.delete(roomCode);
  }

  fenceRoom(roomCode: RoomCode, roomId?: string): void {
    validateRoomCode(roomCode);
    if (roomId !== undefined) {
      validateRoomId(roomId);
    }
    if (this.fencedRoomCodes.has(roomCode)) {
      return;
    }
    const trackedCodes = new Set([
      ...this.roomsByCode.keys(),
      ...this.fencedRoomCodes,
    ]);
    if (
      !this.roomsByCode.has(roomCode)
      && trackedCodes.size >= MAX_TRACKED_ROOMS
    ) {
      throw new Error("Durable room metadata capacity has been reached.");
    }
    this.fencedRoomCodes.add(roomCode);
  }

  recordCommittedMutation(
    roomCode: RoomCode,
    expectedVersion: string,
    result: CommittedRoomMutationResult,
  ): RoomPersistenceMetadata | undefined {
    validateRoomCode(roomCode);
    validateVersion(expectedVersion);

    const current = this.roomsByCode.get(roomCode);
    if (!current) {
      throw new Error("Durable room metadata is not registered.");
    }
    if (this.fencedRoomCodes.has(roomCode)) {
      throw new Error("Durable room is fenced pending reconciliation.");
    }
    if (current.version !== expectedVersion) {
      throw new Error("Room metadata has a stale expected version.");
    }
    if (result.roomCode !== roomCode || result.roomId !== current.roomId) {
      throw new Error("Committed result does not match the registered room.");
    }

    if (!("version" in result)) {
      if (result.deleted !== true) {
        throw new Error("Committed room mutation result is invalid.");
      }
      return this.removeDeletedRoom(roomCode, expectedVersion, result);
    }

    validateVersion(result.version);
    const expectedNextVersion = BigInt(expectedVersion) + 1n;
    if (BigInt(result.version) !== expectedNextVersion) {
      throw new Error("Committed room mutation must advance the version exactly once.");
    }

    const next: RoomPersistenceMetadata = {
      ...current,
      version: result.version,
      gameStatus: result.gameStatus ?? current.gameStatus,
      currentGameId: result.currentGameId === undefined
        ? current.currentGameId
        : result.currentGameId,
      lifecycleStatus: result.lifecycleStatus ?? current.lifecycleStatus,
    };
    this.roomsByCode.set(roomCode, next);
    return copyMetadata(next);
  }

  removeDeletedRoom(
    roomCode: RoomCode,
    expectedVersion: string,
    result: DeletedRoomMutationResult,
  ): undefined {
    validateRoomCode(roomCode);
    validateVersion(expectedVersion);

    const current = this.roomsByCode.get(roomCode);
    if (!current) {
      throw new Error("Durable room metadata is not registered.");
    }
    if (current.version !== expectedVersion) {
      throw new Error("Room metadata has a stale expected version.");
    }
    if (
      result.deleted !== true
      || result.roomCode !== roomCode
      || result.roomId !== current.roomId
    ) {
      throw new Error("Deleted result does not match the registered room.");
    }

    this.roomsByCode.delete(roomCode);
    this.roomCodesById.delete(current.roomId);
  }

  removeExpiredRoom(
    roomCode: RoomCode,
    roomId: string,
    version: string,
  ): void {
    validateRoomCode(roomCode);
    validateRoomId(roomId);
    validateVersion(version);
    const current = this.roomsByCode.get(roomCode);
    if (
      !current
      || current.roomId !== roomId
      || current.version !== version
      || current.lifecycleStatus !== "expired"
      || !this.fencedRoomCodes.has(roomCode)
    ) {
      throw new Error("Expired room identity changed before cleanup completed.");
    }
    this.roomsByCode.delete(roomCode);
    this.roomCodesById.delete(roomId);
    this.fencedRoomCodes.delete(roomCode);
  }

  async runExclusive<T>(
    roomCode: RoomCode,
    operation: (metadata: RoomPersistenceMetadata) => T | Promise<T>,
  ): Promise<T> {
    return this.runExclusiveCore(roomCode, operation, false);
  }

  async runExclusiveForReconciliation<T>(
    roomCode: RoomCode,
    operation: (metadata: RoomPersistenceMetadata) => T | Promise<T>,
  ): Promise<T> {
    return this.runExclusiveCore(roomCode, operation, true);
  }

  private async runExclusiveCore<T>(
    roomCode: RoomCode,
    operation: (metadata: RoomPersistenceMetadata) => T | Promise<T>,
    allowFenced: boolean,
  ): Promise<T> {
    validateRoomCode(roomCode);
    const queuedRoom = this.roomsByCode.get(roomCode);
    if (!queuedRoom) {
      throw new Error("Durable room metadata is not registered.");
    }
    if (this.fencedRoomCodes.has(roomCode) && !allowFenced) {
      throw new Error("Durable room is fenced pending reconciliation.");
    }
    const queuedRoomId = queuedRoom.roomId;

    let queue = this.queues.get(roomCode);
    if (queue && queue.pendingCount >= MAX_PENDING_OPERATIONS_PER_ROOM) {
      throw new RoomPersistenceCoordinatorCapacityError();
    }
    if (!queue) {
      queue = { pendingCount: 0, tail: Promise.resolve() };
      this.queues.set(roomCode, queue);
    }

    const previous = queue.tail;
    let release!: () => void;
    queue.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.pendingCount += 1;

    try {
      await previous;
      const metadata = this.getMetadata(roomCode);
      if (!metadata) {
        throw new Error("Durable room metadata was removed before the operation ran.");
      }
      if (this.fencedRoomCodes.has(roomCode) && !allowFenced) {
        throw new Error("Durable room is fenced pending reconciliation.");
      }
      if (metadata.roomId !== queuedRoomId) {
        throw new Error("Durable room was replaced before the operation ran.");
      }
      return await operation(metadata);
    } finally {
      release();
      queue.pendingCount -= 1;
      this.notifyCapacityWaiters(roomCode);
      if (
        queue.pendingCount === 0
        && this.queues.get(roomCode) === queue
      ) {
        this.queues.delete(roomCode);
      }
    }
  }

  async runExclusiveWithCapacityRetry<T>(
    roomCode: RoomCode,
    operation: (metadata: RoomPersistenceMetadata) => T | Promise<T>,
  ): Promise<T> {
    for (;;) {
      try {
        return await this.runExclusive(roomCode, operation);
      } catch (error) {
        if (!(error instanceof RoomPersistenceCoordinatorCapacityError)) {
          throw error;
        }
        await this.waitForCapacity(roomCode);
      }
    }
  }

  private waitForCapacity(roomCode: RoomCode): Promise<void> {
    const queue = this.queues.get(roomCode);
    if (!queue || queue.pendingCount < MAX_PENDING_OPERATIONS_PER_ROOM) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let waiters = this.capacityWaiters.get(roomCode);
      if (!waiters) {
        waiters = new Set();
        this.capacityWaiters.set(roomCode, waiters);
      }
      waiters.add(resolve);
    });
  }

  private notifyCapacityWaiters(roomCode: RoomCode): void {
    const queue = this.queues.get(roomCode);
    if (queue && queue.pendingCount >= MAX_PENDING_OPERATIONS_PER_ROOM) {
      return;
    }
    const waiters = this.capacityWaiters.get(roomCode);
    if (!waiters) {
      return;
    }
    this.capacityWaiters.delete(roomCode);
    for (const resolve of waiters) {
      resolve();
    }
  }

  private register(
    metadata: RoomPersistenceMetadata,
  ): RoomPersistenceMetadata {
    validateRoomCode(metadata.roomCode);
    validateRoomId(metadata.roomId);
    validateVersion(metadata.version);
    if (
      metadata.currentGameId !== null
      && (
        typeof metadata.currentGameId !== "string"
        || metadata.currentGameId.length === 0
      )
    ) {
      throw new TypeError("Current game ID must be a non-empty string or null.");
    }
    if (!["active", "expired", "closed"].includes(metadata.lifecycleStatus)) {
      throw new TypeError("Room lifecycle status is invalid.");
    }
    if (
      !["waiting", "starting", "in_progress", "finished"].includes(
        metadata.gameStatus,
      )
    ) {
      throw new TypeError("Room game status is invalid.");
    }
    if (this.fencedRoomCodes.has(metadata.roomCode)) {
      throw new Error("Durable room is fenced pending reconciliation.");
    }
    if (this.roomsByCode.has(metadata.roomCode)) {
      throw new Error("Room code is already registered.");
    }
    const existingRoomCode = this.roomCodesById.get(metadata.roomId);
    if (existingRoomCode !== undefined && existingRoomCode !== metadata.roomCode) {
      throw new Error("Durable room ID is already registered to another room code.");
    }
    if (this.roomsByCode.size >= MAX_TRACKED_ROOMS) {
      throw new Error("Durable room metadata capacity has been reached.");
    }

    const stored = copyMetadata(metadata);
    this.roomsByCode.set(stored.roomCode, stored);
    this.roomCodesById.set(stored.roomId, stored.roomCode);
    return copyMetadata(stored);
  }
}
