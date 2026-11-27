import type { PlayerId, RoomCode } from "@impostor/api";
import type { RecoverableWaitingRoom } from "./postgres-room-repository.js";
import { RoomPersistenceCoordinatorCapacityError } from "./room-persistence-coordinator.js";
import {
  DeferredRoomMutationCapacityError,
  type PlayerRemoval,
} from "./room-service.js";

const MAX_TIMEOUT_DELAY_MS = 2_147_483_647;
const CAPACITY_RETRY_DELAY_MS = 250;

export interface RecoveredDisconnectTimeout {
  readonly roomCode: RoomCode;
  readonly playerId: PlayerId;
  readonly disconnectGeneration: string;
  readonly reconnectDeadlineAt: Date;
}

export interface DurableTimeoutFailureContext {
  readonly roomCode: RoomCode;
  readonly playerId: PlayerId;
  readonly disconnectGeneration: string;
  readonly phase: "persistence" | "side_effect" | "scheduler";
  readonly removal?: PlayerRemoval;
}

export interface DurableTimeoutSchedulerDependencies {
  readonly scheduleTimeout: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  readonly now: () => Date;
  readonly isServingReady: () => boolean;
  readonly claimTimeoutOwnership?: (
    roomCode: RoomCode,
    playerId: PlayerId,
    owner: symbol,
  ) => boolean;
  readonly releaseTimeoutOwnership?: (
    roomCode: RoomCode,
    playerId: PlayerId,
    owner: symbol,
  ) => void;
  readonly removeDisconnectedPlayer: (
    timeout: RecoveredDisconnectTimeout,
    now: Date,
  ) => Promise<PlayerRemoval | { retryAt: Date } | undefined>;
  readonly onRemoval?: (removal: PlayerRemoval) => void | Promise<void>;
  readonly reportFailure: (
    error: unknown,
    context: DurableTimeoutFailureContext,
  ) => void;
}

export interface DurableTimeoutSchedulerDiagnostics {
  readonly scheduledTimeouts: number;
  readonly pendingPostCommitSideEffects: number;
}

interface ScheduledTimeout extends RecoveredDisconnectTimeout {
  readonly key: string;
  readonly deadlineMs: number;
  cancel?: () => void;
  retryAtMs?: number;
  blocked?: boolean;
  removal?: PlayerRemoval;
}

function timeoutKey(roomCode: RoomCode, playerId: PlayerId): string {
  return `${roomCode}\u0000${playerId}`;
}

function compareGenerations(left: string, right: string): number {
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) {
    throw new TypeError("Disconnect generations must be non-negative integers.");
  }
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export class DurableRoomTimeoutScheduler {
  private readonly scheduled = new Map<string, ScheduledTimeout>();
  private readonly owner = Symbol("durable-room-timeout-scheduler");

  constructor(
    private readonly dependencies: DurableTimeoutSchedulerDependencies,
  ) {}

  getDiagnostics(): DurableTimeoutSchedulerDiagnostics {
    let pendingPostCommitSideEffects = 0;
    for (const timeout of this.scheduled.values()) {
      if (timeout.removal && timeout.blocked) {
        pendingPostCommitSideEffects += 1;
      }
    }
    return {
      scheduledTimeouts: this.scheduled.size,
      pendingPostCommitSideEffects,
    };
  }

  scheduleRecoveredRooms(rooms: readonly RecoverableWaitingRoom[]): void {
    for (const room of rooms) {
      for (const member of room.members) {
        if (
          member.connectionStatus === "disconnected"
          && member.reconnectDeadlineAt !== null
        ) {
          this.schedule({
            roomCode: room.roomCode,
            playerId: member.playerId,
            disconnectGeneration: member.disconnectGeneration,
            reconnectDeadlineAt: member.reconnectDeadlineAt,
          });
        }
      }
    }
  }

  schedule(timeout: RecoveredDisconnectTimeout): void {
    if (!this.dependencies.isServingReady()) {
      throw new Error("Reconnect timeout scheduling requires a serving-ready runtime.");
    }
    if (
      !/^\d+$/.test(timeout.disconnectGeneration)
      || !(timeout.reconnectDeadlineAt instanceof Date)
      || !Number.isFinite(timeout.reconnectDeadlineAt.getTime())
    ) {
      throw new TypeError("Recovered reconnect timeout metadata is invalid.");
    }

    const key = timeoutKey(timeout.roomCode, timeout.playerId);
    const existing = this.scheduled.get(key);
    if (existing) {
      const generationOrder = compareGenerations(
        timeout.disconnectGeneration,
        existing.disconnectGeneration,
      );
      if (generationOrder < 0) {
        return;
      }
      if (generationOrder === 0) {
        if (existing.deadlineMs !== timeout.reconnectDeadlineAt.getTime()) {
          throw new Error("A disconnect generation cannot have multiple deadlines.");
        }
        return;
      }
      this.cancel(existing);
    }

    if (
      this.dependencies.claimTimeoutOwnership
      && !this.dependencies.claimTimeoutOwnership(
        timeout.roomCode,
        timeout.playerId,
        this.owner,
      )
    ) {
      return;
    }

    const scheduled: ScheduledTimeout = {
      ...timeout,
      reconnectDeadlineAt: new Date(timeout.reconnectDeadlineAt.getTime()),
      key,
      deadlineMs: timeout.reconnectDeadlineAt.getTime(),
    };
    this.scheduled.set(key, scheduled);
    try {
      this.arm(scheduled);
    } catch (error) {
      this.fail(scheduled, error);
      throw error;
    }
  }

  cancelPlayer(roomCode: RoomCode, playerId: PlayerId): void {
    const timeout = this.scheduled.get(timeoutKey(roomCode, playerId));
    if (timeout) {
      this.cancel(timeout);
    }
  }

  cancelAll(): void {
    for (const timeout of this.scheduled.values()) {
      timeout.cancel?.();
      timeout.cancel = undefined;
      this.releaseOwnership(timeout);
    }
    this.scheduled.clear();
  }

  private arm(timeout: ScheduledTimeout): void {
    const now = this.dependencies.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new TypeError("Reconnect timeout clock returned an invalid date.");
    }
    const targetMs = Math.max(timeout.deadlineMs, timeout.retryAtMs ?? 0);
    const remainingMs = Math.max(0, targetMs - now.getTime());
    const delayMs = Math.min(remainingMs, MAX_TIMEOUT_DELAY_MS);
    timeout.cancel = this.dependencies.scheduleTimeout(() => {
      timeout.cancel = undefined;
      void this.fire(timeout);
    }, delayMs);
  }

  private async fire(timeout: ScheduledTimeout): Promise<void> {
    if (this.scheduled.get(timeout.key) !== timeout || timeout.blocked) {
      return;
    }
    if (!this.dependencies.isServingReady()) {
      this.cancel(timeout);
      return;
    }

    const now = this.dependencies.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      this.fail(timeout, new TypeError("Reconnect timeout clock returned an invalid date."));
      return;
    }
    const targetMs = Math.max(timeout.deadlineMs, timeout.retryAtMs ?? 0);
    if (targetMs > now.getTime()) {
      this.arm(timeout);
      return;
    }

    if (!timeout.removal) {
      let result: PlayerRemoval | { retryAt: Date } | undefined;
      try {
        result = await this.dependencies.removeDisconnectedPlayer(timeout, now);
      } catch (error) {
        if (
          error instanceof RoomPersistenceCoordinatorCapacityError
          || error instanceof DeferredRoomMutationCapacityError
        ) {
          this.retryAfterCapacity(timeout);
        } else {
          this.fail(timeout, error, "persistence");
        }
        return;
      }
      if (this.scheduled.get(timeout.key) !== timeout) {
        return;
      }
      if (result && "retryAt" in result) {
        if (!(result.retryAt instanceof Date) || !Number.isFinite(result.retryAt.getTime())) {
          this.fail(timeout, new TypeError("Durable timeout retry returned an invalid date."));
          return;
        }
        timeout.retryAtMs = Math.max(timeout.deadlineMs, result.retryAt.getTime());
        try {
          this.arm(timeout);
        } catch (error) {
          this.fail(timeout, error);
        }
        return;
      }
      if (!result) {
        this.scheduled.delete(timeout.key);
        this.releaseOwnership(timeout);
        return;
      }
      timeout.removal = result;
    }

    const removal = timeout.removal;
    if (!removal) {
      this.fail(timeout, new Error("Persisted timeout removal result was lost."));
      return;
    }
    try {
      await this.dependencies.onRemoval?.(removal);
      this.scheduled.delete(timeout.key);
      this.releaseOwnership(timeout);
    } catch (error) {
      this.fail(timeout, error, "side_effect", removal);
    }
  }

  private retryAfterCapacity(timeout: ScheduledTimeout): void {
    if (this.scheduled.get(timeout.key) !== timeout) {
      return;
    }
    const now = this.dependencies.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      this.fail(
        timeout,
        new TypeError("Reconnect timeout clock returned an invalid date."),
      );
      return;
    }
    timeout.retryAtMs = Math.max(
      timeout.deadlineMs,
      now.getTime() + CAPACITY_RETRY_DELAY_MS,
    );
    try {
      this.arm(timeout);
    } catch (error) {
      this.fail(timeout, error);
    }
  }

  private fail(
    timeout: ScheduledTimeout,
    error: unknown,
    phase: DurableTimeoutFailureContext["phase"] = "scheduler",
    removal?: PlayerRemoval,
  ): void {
    if (this.scheduled.get(timeout.key) !== timeout) {
      return;
    }
    timeout.cancel?.();
    timeout.cancel = undefined;
    timeout.blocked = true;
    try {
      this.dependencies.reportFailure(error, {
        roomCode: timeout.roomCode,
        playerId: timeout.playerId,
        disconnectGeneration: timeout.disconnectGeneration,
        phase,
        ...(removal ? { removal } : {}),
      });
    } catch (reportError) {
      console.error(
        "Could not report a retained reconnect timeout failure.",
        reportError,
      );
    }
  }

  private cancel(timeout: ScheduledTimeout): void {
    timeout.cancel?.();
    timeout.cancel = undefined;
    if (this.scheduled.get(timeout.key) === timeout) {
      this.scheduled.delete(timeout.key);
    }
    this.releaseOwnership(timeout);
  }

  private releaseOwnership(timeout: ScheduledTimeout): void {
    this.dependencies.releaseTimeoutOwnership?.(
      timeout.roomCode,
      timeout.playerId,
      this.owner,
    );
  }
}
