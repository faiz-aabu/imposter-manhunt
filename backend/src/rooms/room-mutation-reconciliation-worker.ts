import type { RoomCode } from "@impostor/api";

const MAX_CONCURRENT_RECONCILIATIONS = 4;
const MAX_TRACKED_RECONCILIATIONS = 10_000;
const MAX_RECONCILIATION_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 4_000;

export interface RoomMutationReconciliationWorkerDependencies {
  readonly isServingReady: () => boolean;
  readonly hasBlockedWork: (roomCode: RoomCode) => boolean;
  readonly reconcile: (roomCode: RoomCode) => Promise<boolean>;
  readonly now: () => number;
  readonly scheduleTimeout: (
    callback: () => void,
    delayMs: number,
  ) => () => void;
  readonly report: (
    event: "started" | "retry_scheduled" | "exhausted" | "failed",
    roomCode: RoomCode,
    attempt: number,
    error?: unknown,
  ) => void;
}

export interface RoomMutationReconciliationDiagnostics {
  readonly trackedRooms: number;
  readonly pendingRooms: number;
  readonly exhaustedRooms: number;
}

interface ReconciliationJob {
  readonly roomCode: RoomCode;
  attempts: number;
  nextAttemptAt: number;
  running: boolean;
  queued: boolean;
  exhausted: boolean;
}

export class RoomMutationReconciliationWorker {
  private readonly jobs = new Map<RoomCode, ReconciliationJob>();
  private readonly queue: ReconciliationJob[] = [];
  private readonly activeRuns = new Set<Promise<void>>();
  private activeCount = 0;
  private retryTimer?: () => void;
  private retryTimerAt?: number;
  private stopped = false;

  constructor(
    private readonly dependencies: RoomMutationReconciliationWorkerDependencies,
  ) {}

  getDiagnostics(): RoomMutationReconciliationDiagnostics {
    let exhaustedRooms = 0;
    for (const job of this.jobs.values()) {
      if (job.exhausted) {
        exhaustedRooms += 1;
      }
    }
    return {
      trackedRooms: this.jobs.size,
      pendingRooms: this.jobs.size - exhaustedRooms,
      exhaustedRooms,
    };
  }

  request(roomCode: RoomCode): void {
    if (this.stopped || !this.dependencies.isServingReady()) {
      return;
    }

    let job = this.jobs.get(roomCode);
    if (!job) {
      if (this.jobs.size >= MAX_TRACKED_RECONCILIATIONS) {
        this.report("failed", roomCode, 0, new Error(
          "Room reconciliation tracking capacity has been reached.",
        ));
        return;
      }
      job = {
        roomCode,
        attempts: 0,
        nextAttemptAt: this.readNow(),
        running: false,
        queued: false,
        exhausted: false,
      };
      this.jobs.set(roomCode, job);
    }

    if (job.exhausted) {
      return;
    }
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.retryTimer?.();
    this.retryTimer = undefined;
    this.retryTimerAt = undefined;
    this.queue.length = 0;
    for (const job of this.jobs.values()) {
      job.queued = false;
    }
  }

  async drain(): Promise<void> {
    while (this.activeRuns.size > 0) {
      await Promise.allSettled([...this.activeRuns]);
    }
  }

  private pump(): void {
    if (this.stopped || !this.dependencies.isServingReady()) {
      this.retryTimer?.();
      this.retryTimer = undefined;
      this.retryTimerAt = undefined;
      return;
    }

    const now = this.readNow();
    for (const job of this.jobs.values()) {
      if (
        !job.running
        && !job.queued
        && !job.exhausted
        && job.nextAttemptAt <= now
      ) {
        job.queued = true;
        this.queue.push(job);
      }
    }

    while (
      this.activeCount < MAX_CONCURRENT_RECONCILIATIONS
      && this.queue.length > 0
    ) {
      const job = this.queue.shift();
      if (!job || !job.queued || job.exhausted) {
        continue;
      }
      job.queued = false;
      this.run(job);
    }

    if (this.activeCount >= MAX_CONCURRENT_RECONCILIATIONS) {
      return;
    }

    const nextAttemptAt = [...this.jobs.values()]
      .filter((job) =>
        !job.running
        && !job.queued
        && !job.exhausted
        && job.nextAttemptAt > now)
      .reduce<number | undefined>(
        (earliest, job) => Math.min(earliest ?? job.nextAttemptAt, job.nextAttemptAt),
        undefined,
      );
    if (nextAttemptAt === undefined) {
      this.retryTimer?.();
      this.retryTimer = undefined;
      this.retryTimerAt = undefined;
      return;
    }
    this.schedulePump(nextAttemptAt, now);
  }

  private run(job: ReconciliationJob): void {
    job.running = true;
    job.attempts += 1;
    this.activeCount += 1;
    this.report("started", job.roomCode, job.attempts);

    const run = Promise.resolve()
      .then(() => this.dependencies.reconcile(job.roomCode))
      .then(
        () => {
          if (!this.stopped && !this.dependencies.hasBlockedWork(job.roomCode)) {
            this.jobs.delete(job.roomCode);
          }
        },
        (error: unknown) => {
          this.report("failed", job.roomCode, job.attempts, error);
        },
      )
      .finally(() => {
        job.running = false;
        this.activeCount -= 1;
        this.activeRuns.delete(run);
        if (this.stopped) {
          return;
        }

        let stillBlocked = true;
        try {
          stillBlocked = this.dependencies.hasBlockedWork(job.roomCode);
        } catch (error) {
          this.report("failed", job.roomCode, job.attempts, error);
        }
        if (!stillBlocked) {
          this.jobs.delete(job.roomCode);
        } else if (job.attempts >= MAX_RECONCILIATION_ATTEMPTS) {
          job.exhausted = true;
          this.report("exhausted", job.roomCode, job.attempts);
        } else {
          job.nextAttemptAt =
            this.readNow() + this.retryDelay(job.attempts);
          this.report("retry_scheduled", job.roomCode, job.attempts);
        }
        this.pump();
      });

    this.activeRuns.add(run);
    void run.catch((error: unknown) => {
      this.report("failed", job.roomCode, job.attempts, error);
    });
  }

  private schedulePump(nextAttemptAt: number, now: number): void {
    if (this.retryTimerAt !== undefined && this.retryTimerAt <= nextAttemptAt) {
      return;
    }
    this.retryTimer?.();
    this.retryTimerAt = nextAttemptAt;
    try {
      this.retryTimer = this.dependencies.scheduleTimeout(
        () => {
          this.retryTimer = undefined;
          this.retryTimerAt = undefined;
          this.pump();
        },
        Math.max(0, nextAttemptAt - now),
      );
    } catch (error) {
      this.retryTimer = undefined;
      this.retryTimerAt = undefined;
      for (const job of this.jobs.values()) {
        this.report("failed", job.roomCode, job.attempts, error);
      }
    }
  }

  private retryDelay(attempt: number): number {
    return Math.min(
      BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1),
      MAX_RETRY_DELAY_MS,
    );
  }

  private readNow(): number {
    const now = this.dependencies.now();
    if (!Number.isFinite(now)) {
      throw new TypeError("Reconciliation clock returned an invalid time.");
    }
    return now;
  }

  private report(
    event: "started" | "retry_scheduled" | "exhausted" | "failed",
    roomCode: RoomCode,
    attempt: number,
    error?: unknown,
  ): void {
    try {
      this.dependencies.report(event, roomCode, attempt, error);
    } catch (reportError) {
      console.error("Could not report room reconciliation state.", reportError);
    }
  }
}
