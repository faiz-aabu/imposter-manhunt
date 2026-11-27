import { CLOCK_EVENTS } from "@impostor/api";
import type { ClockSyncResponsePayload } from "@impostor/api";
import type { GameClientSocket } from "./socket-types";

const CLOCK_SYNC_SAMPLE_COUNT = 3;
const CLOCK_SYNC_ACK_TIMEOUT_MS = 2_000;
const CLOCK_SYNC_MAX_RETRIES = 2;
const CLOCK_SYNC_RETRY_DELAY_MS = 1_000;

export type ClockSyncStatus = "idle" | "syncing" | "ready" | "failed";

export interface ClockSyncAttempt extends ClockSyncResponsePayload {
  clientSentAt: number;
  clientReceivedAt: number;
}

export interface ClockSyncSample {
  requestId: number;
  offsetMs: number;
  roundTripMs: number;
}

export function getServerDeadlineRemainingMs(
  deadline: string,
  serverTimeOffsetMs: number,
  clientNowMs = Date.now(),
): number | null {
  const deadlineMs = Date.parse(deadline);
  if (
    !Number.isFinite(deadlineMs) ||
    !Number.isFinite(serverTimeOffsetMs) ||
    !Number.isFinite(clientNowMs)
  ) {
    return null;
  }
  return deadlineMs - (clientNowMs + serverTimeOffsetMs);
}

export function scheduleServerDeadline(
  deadline: string,
  serverTimeOffsetMs: number,
  onDeadline: () => void,
): () => void {
  const remainingMs = getServerDeadlineRemainingMs(
    deadline,
    serverTimeOffsetMs,
  );
  const timer = setTimeout(
    onDeadline,
    remainingMs === null ? 0 : Math.max(0, remainingMs),
  );
  return () => clearTimeout(timer);
}

interface ClockSyncOutcome {
  sample: ClockSyncSample | null;
  error?: unknown;
}

export type ClockSyncRequester = (
  requestId: number,
  signal: AbortSignal,
) => Promise<ClockSyncAttempt>;

export function calculateClockSyncSample(
  expectedRequestId: number,
  attempt: ClockSyncAttempt,
): ClockSyncSample | null {
  if (
    !attempt ||
    !Number.isSafeInteger(attempt.requestId) ||
    typeof attempt.serverTime !== "string" ||
    typeof attempt.clientSentAt !== "number" ||
    typeof attempt.clientReceivedAt !== "number"
  ) {
    return null;
  }

  const serverTimeMs = Date.parse(attempt.serverTime);
  const { clientSentAt, clientReceivedAt } = attempt;
  if (
    attempt.requestId !== expectedRequestId ||
    !Number.isFinite(serverTimeMs) ||
    !Number.isFinite(clientSentAt) ||
    !Number.isFinite(clientReceivedAt) ||
    clientReceivedAt < clientSentAt
  ) {
    return null;
  }

  const roundTripMs = clientReceivedAt - clientSentAt;
  const offsetMs =
    serverTimeMs - (clientSentAt + clientReceivedAt) / 2;
  if (!Number.isFinite(roundTripMs) || !Number.isFinite(offsetMs)) {
    return null;
  }

  return { requestId: attempt.requestId, offsetMs, roundTripMs };
}

export function selectLowestRoundTripSample(
  samples: readonly ClockSyncSample[],
): ClockSyncSample | null {
  let best: ClockSyncSample | null = null;
  for (const sample of samples) {
    if (
      Number.isFinite(sample.offsetMs) &&
      Number.isFinite(sample.roundTripMs) &&
      sample.roundTripMs >= 0 &&
      (!best || sample.roundTripMs < best.roundTripMs)
    ) {
      best = sample;
    }
  }
  return best;
}

export class ServerClockSynchronizer {
  private generation = 0;
  private nextRequestId = 0;
  private readonly activeRequests = new Map<AbortController, () => void>();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveRetry: ((shouldRetry: boolean) => void) | null = null;

  constructor(
    private readonly setOffset: (offsetMs: number | null) => void,
    private readonly onFailure: () => void,
    private readonly onStatus: (status: ClockSyncStatus) => void = () => {},
  ) {}

  synchronize(request: ClockSyncRequester): Promise<void> {
    const generation = ++this.generation;
    this.cancelPendingWork();
    this.setOffset(null);
    this.onStatus("syncing");
    return this.synchronizeGeneration(generation, request);
  }

  invalidate(): void {
    this.generation += 1;
    this.cancelPendingWork();
    this.setOffset(null);
    this.onStatus("idle");
  }

  private async synchronizeGeneration(
    generation: number,
    request: ClockSyncRequester,
  ): Promise<void> {
    for (let retry = 0; retry <= CLOCK_SYNC_MAX_RETRIES; retry += 1) {
      const requestIds = Array.from(
        { length: CLOCK_SYNC_SAMPLE_COUNT },
        () => this.nextId(),
      );
      const outcomes = await Promise.all(
        requestIds.map((requestId) => this.requestSample(request, requestId)),
      );
      if (generation !== this.generation) {
        return;
      }

      const best = selectLowestRoundTripSample(
        outcomes.flatMap(({ sample }) => (sample ? [sample] : [])),
      );
      if (best) {
        this.setOffset(best.offsetMs);
        this.onStatus("ready");
        return;
      }

      if (retry === CLOCK_SYNC_MAX_RETRIES) {
        this.onFailure();
        this.onStatus("failed");
        return;
      }

      if (!(await this.waitBeforeRetry(generation))) {
        return;
      }
    }
  }

  private requestSample(
    request: ClockSyncRequester,
    requestId: number,
  ): Promise<ClockSyncOutcome> {
    const controller = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = (outcome: ClockSyncOutcome) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout !== null) {
          clearTimeout(timeout);
        }
        this.activeRequests.delete(controller);
        resolve(outcome);
      };

      this.activeRequests.set(controller, () => {
        controller.abort();
        finish({
          sample: null,
          error: new Error("Server clock synchronization was cancelled."),
        });
      });
      timeout = setTimeout(() => {
        controller.abort();
        finish({
          sample: null,
          error: new Error("Server clock synchronization timed out."),
        });
      }, CLOCK_SYNC_ACK_TIMEOUT_MS);

      if (controller.signal.aborted) {
        finish({
          sample: null,
          error: new Error("Server clock synchronization was cancelled."),
        });
        return;
      }

      try {
        void Promise.resolve(request(requestId, controller.signal))
          .then((attempt) => {
            const sample = calculateClockSyncSample(requestId, attempt);
            finish(
              sample
                ? { sample }
                : {
                    sample: null,
                    error: new Error(
                      "Server returned an invalid clock sample.",
                    ),
                  },
            );
          })
          .catch((error: unknown) => finish({ sample: null, error }));
      } catch (error) {
        finish({ sample: null, error });
      }
    });
  }

  private waitBeforeRetry(generation: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (generation !== this.generation) {
        resolve(false);
        return;
      }

      this.resolveRetry = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.resolveRetry = null;
        resolve(generation === this.generation);
      }, CLOCK_SYNC_RETRY_DELAY_MS);
    });
  }

  private cancelPendingWork(): void {
    for (const cancel of this.activeRequests.values()) {
      cancel();
    }
    this.activeRequests.clear();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const resolveRetry = this.resolveRetry;
    this.resolveRetry = null;
    resolveRetry?.(false);
  }

  private nextId(): number {
    this.nextRequestId =
      this.nextRequestId >= Number.MAX_SAFE_INTEGER
        ? 1
        : this.nextRequestId + 1;
    return this.nextRequestId;
  }
}

export function requestServerClock(
  socket: GameClientSocket,
  requestId: number,
  signal: AbortSignal,
): Promise<ClockSyncAttempt> {
  if (!socket.connected) {
    return Promise.reject(new Error("Socket is not connected."));
  }
  if (signal.aborted) {
    return Promise.reject(new Error("Socket clock request was cancelled."));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () =>
      finish(() => reject(new Error("Socket clock request was cancelled.")));
    signal.addEventListener("abort", onAbort, { once: true });

    const clientSentAt = Date.now();
    try {
      socket.emit(CLOCK_EVENTS.SYNC, { requestId }, (response) => {
        if (settled) {
          return;
        }
        const clientReceivedAt = Date.now();
        if (!response || typeof response !== "object" || !("ok" in response)) {
          finish(() =>
            reject(new Error("Server returned an invalid clock response.")),
          );
          return;
        }
        if (!response.ok) {
          finish(() => reject(new Error(response.error.message)));
          return;
        }

        const data = response.data;
        if (
          !data ||
          typeof data !== "object" ||
          !Number.isSafeInteger(data.requestId) ||
          typeof data.serverTime !== "string"
        ) {
          finish(() =>
            reject(new Error("Server returned an invalid clock sample.")),
          );
          return;
        }
        finish(() => resolve({ ...data, clientSentAt, clientReceivedAt }));
      });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
