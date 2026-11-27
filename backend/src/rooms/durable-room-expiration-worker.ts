import type { RoomCode } from "@impostor/api";
import {
  MAX_ROOM_EXPIRATION_BATCH_SIZE,
} from "./postgres-room-repository.js";
import type {
  DueWaitingRoomExpiration,
  ExpiredWaitingRoom,
} from "./postgres-room-repository.js";

const EXPIRATION_RETRY_DELAY_MS = 30_000;

export interface DurableRoomExpirationWorkerDependencies {
  readonly scheduleTimeout: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly isServingReady: () => boolean;
  readonly listDue: (limit: number) => Promise<DueWaitingRoomExpiration[]>;
  readonly expire: (
    candidate: DueWaitingRoomExpiration,
  ) => Promise<ExpiredWaitingRoom | undefined>;
  readonly completeCleanup: (expired: ExpiredWaitingRoom) => Promise<boolean>;
  readonly reportFailure: (
    error: unknown,
    roomCode?: RoomCode,
  ) => void;
}

export interface DurableRoomExpirationDiagnostics {
  readonly pendingCandidates: number;
  readonly pendingLocalCleanup: number;
}

function candidateKey(candidate: DueWaitingRoomExpiration): string {
  return `${candidate.roomId}\u0000${candidate.expectedVersion}`;
}

function expiredKey(expired: ExpiredWaitingRoom): string {
  return `${expired.roomId}\u0000${expired.version}`;
}

export class DurableRoomExpirationWorker {
  private readonly dependencies: DurableRoomExpirationWorkerDependencies;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private readonly pendingCandidates = new Map<string, DueWaitingRoomExpiration>();
  private readonly pendingCleanup = new Map<string, ExpiredWaitingRoom>();
  private timerCancel?: () => void;
  private inFlight?: Promise<void>;
  private stopped = true;

  constructor(dependencies: DurableRoomExpirationWorkerDependencies) {
    this.dependencies = dependencies;
    this.batchSize = dependencies.batchSize ?? MAX_ROOM_EXPIRATION_BATCH_SIZE;
    this.intervalMs = dependencies.intervalMs ?? EXPIRATION_RETRY_DELAY_MS;
    if (
      !Number.isInteger(this.batchSize)
      || this.batchSize < 1
      || this.batchSize > MAX_ROOM_EXPIRATION_BATCH_SIZE
      || !Number.isInteger(this.intervalMs)
      || this.intervalMs < 1
    ) {
      throw new RangeError("Durable room expiration worker limits are invalid.");
    }
  }

  get pendingCount(): number {
    return this.pendingCandidates.size + this.pendingCleanup.size;
  }

  getDiagnostics(): DurableRoomExpirationDiagnostics {
    return {
      pendingCandidates: this.pendingCandidates.size,
      pendingLocalCleanup: this.pendingCleanup.size,
    };
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.timerCancel?.();
    this.timerCancel = undefined;
  }

  runNow(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }
    if (this.stopped || !this.dependencies.isServingReady()) {
      return Promise.resolve();
    }

    const operation = this.runBatch();
    this.inFlight = operation;
    const clearInFlight = () => {
      if (this.inFlight === operation) {
        this.inFlight = undefined;
      }
      if (!this.stopped) {
        this.schedule(this.intervalMs);
      }
    };
    void operation.then(clearInFlight, clearInFlight);
    return operation;
  }

  async drain(): Promise<void> {
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (
      this.stopped
      || this.timerCancel
      || !this.dependencies.isServingReady()
    ) {
      return;
    }
    this.timerCancel = this.dependencies.scheduleTimeout(() => {
      this.timerCancel = undefined;
      void this.runNow().catch((error: unknown) => {
        this.dependencies.reportFailure(error);
      });
    }, delayMs);
  }

  private async runBatch(): Promise<void> {
    if (this.stopped || !this.dependencies.isServingReady()) {
      return;
    }

    if (this.pendingCleanup.size > 0) {
      for (const [key, expired] of this.pendingCleanup) {
        if (this.stopped || !this.dependencies.isServingReady()) {
          return;
        }
        try {
          if (await this.dependencies.completeCleanup(expired)) {
            this.pendingCleanup.delete(key);
          }
        } catch (error) {
          this.dependencies.reportFailure(error, expired.roomCode);
        }
      }
      return;
    }

    if (this.pendingCandidates.size === 0) {
      let candidates: DueWaitingRoomExpiration[];
      try {
        candidates = await this.dependencies.listDue(this.batchSize);
      } catch (error) {
        this.dependencies.reportFailure(error);
        return;
      }
      if (candidates.length > this.batchSize) {
        throw new Error("Room expiration query exceeded its configured batch size.");
      }
      for (const candidate of candidates) {
        this.pendingCandidates.set(candidateKey(candidate), candidate);
      }
    }

    for (const [key, candidate] of this.pendingCandidates) {
      if (this.stopped || !this.dependencies.isServingReady()) {
        return;
      }
      try {
        const expired = await this.dependencies.expire(candidate);
        this.pendingCandidates.delete(key);
        if (!expired) {
          continue;
        }
        const cleanupKey = expiredKey(expired);
        this.pendingCleanup.set(cleanupKey, expired);
        if (this.stopped || !this.dependencies.isServingReady()) {
          return;
        }
        if (await this.dependencies.completeCleanup(expired)) {
          this.pendingCleanup.delete(cleanupKey);
        }
      } catch (error) {
        this.dependencies.reportFailure(error, candidate.roomCode);
        return;
      }
    }
  }
}
