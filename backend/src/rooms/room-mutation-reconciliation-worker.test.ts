import assert from "node:assert/strict";
import { test } from "node:test";
import type { GameSessionId, RoomCode } from "@impostor/api";
import { RoomMutationReconciliationWorker } from "./room-mutation-reconciliation-worker.js";
import { RoomPersistenceCoordinatorCapacityError } from "./room-persistence-coordinator.js";
import { RoomService } from "./room-service.js";
import { AppError } from "../utils/app-error.js";

const ROOM_CODE = "ABCD" as RoomCode;

interface FakeTimer {
  readonly dueAt: number;
  readonly callback: () => void;
  cancelled: boolean;
}

class FakeClock {
  nowMs = 0;
  private readonly timers: FakeTimer[] = [];

  scheduleTimeout = (callback: () => void, delayMs: number): (() => void) => {
    const timer: FakeTimer = {
      dueAt: this.nowMs + delayMs,
      callback,
      cancelled: false,
    };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  advance(milliseconds: number): void {
    const target = this.nowMs + milliseconds;
    while (true) {
      const next = this.timers
        .filter((timer) => !timer.cancelled && timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!next) {
        break;
      }
      next.cancelled = true;
      this.nowMs = next.dueAt;
      next.callback();
    }
    this.nowMs = target;
  }
}

async function flushCallbacks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("automatically reconciles blocked room work and clears its job on success", async () => {
  const clock = new FakeClock();
  let blocked = true;
  let attempts = 0;
  const worker = new RoomMutationReconciliationWorker({
    isServingReady: () => true,
    hasBlockedWork: () => blocked,
    reconcile: async () => {
      attempts += 1;
      blocked = false;
      return true;
    },
    now: () => clock.nowMs,
    scheduleTimeout: clock.scheduleTimeout,
    report: () => {},
  });

  worker.request(ROOM_CODE);
  await flushCallbacks();

  assert.equal(attempts, 1);
  assert.equal(blocked, false);
  await worker.drain();
});

test("capacity rejection retries with bounded backoff", async () => {
  const clock = new FakeClock();
  const reported: string[] = [];
  let blocked = true;
  let attempts = 0;
  const worker = new RoomMutationReconciliationWorker({
    isServingReady: () => true,
    hasBlockedWork: () => blocked,
    reconcile: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new RoomPersistenceCoordinatorCapacityError();
      }
      blocked = false;
      return true;
    },
    now: () => clock.nowMs,
    scheduleTimeout: clock.scheduleTimeout,
    report: (event) => reported.push(event),
  });

  worker.request(ROOM_CODE);
  await flushCallbacks();
  assert.equal(attempts, 1);

  clock.advance(249);
  await flushCallbacks();
  assert.equal(attempts, 1);
  clock.advance(1);
  await flushCallbacks();
  assert.equal(attempts, 2);
  assert.ok(reported.includes("retry_scheduled"));
  await worker.drain();
});

test("coalesces concurrent triggers for the same room", async () => {
  const clock = new FakeClock();
  let resolveAttempt!: () => void;
  const attempt = new Promise<void>((resolve) => {
    resolveAttempt = resolve;
  });
  let attempts = 0;
  let blocked = true;
  const worker = new RoomMutationReconciliationWorker({
    isServingReady: () => true,
    hasBlockedWork: () => blocked,
    reconcile: async () => {
      attempts += 1;
      await attempt;
      blocked = false;
      return true;
    },
    now: () => clock.nowMs,
    scheduleTimeout: clock.scheduleTimeout,
    report: () => {},
  });

  worker.request(ROOM_CODE);
  worker.request(ROOM_CODE);
  await flushCallbacks();
  assert.equal(attempts, 1);
  resolveAttempt();
  await worker.drain();
  assert.equal(attempts, 1);
});

test("retains ambiguous work after bounded attempts and stops on shutdown", async () => {
  const clock = new FakeClock();
  const reported: string[] = [];
  let attempts = 0;
  const worker = new RoomMutationReconciliationWorker({
    isServingReady: () => true,
    hasBlockedWork: () => true,
    reconcile: async () => {
      attempts += 1;
      throw new Error("ambiguous database outcome");
    },
    now: () => clock.nowMs,
    scheduleTimeout: clock.scheduleTimeout,
    report: (event) => reported.push(event),
  });

  worker.request(ROOM_CODE);
  await flushCallbacks();
  for (const delay of [250, 500, 1_000, 2_000]) {
    clock.advance(delay);
    await flushCallbacks();
  }

  assert.equal(attempts, 5);
  assert.ok(reported.includes("exhausted"));
  assert.deepEqual(worker.getDiagnostics(), {
    trackedRooms: 1,
    pendingRooms: 0,
    exhaustedRooms: 1,
  });
  worker.stop();
  const pendingDrain = worker.drain();
  await pendingDrain;
  assert.equal(attempts, 5);
});

test("reconciliation exhaustion retains a fenced, suspended room and pending mutation", async () => {
  const clock = new FakeClock();
  const rooms = new RoomService();
  const created = rooms.createRoom({ nickname: "Host" }, "host-socket");
  const guest = rooms.joinRoom(
    { roomCode: created.room.code, nickname: "Guest" },
    "guest-socket",
  );
  rooms.disconnectSocket("guest-socket");
  const unaffectedRoom = rooms.createRoom({ nickname: "Other host" }, "other-host");
  const scope = rooms.getGameplaySuspensionScope(created.room.code, null);
  assert.ok(scope);

  const reservation = rooms.reserveGameStatusTransition(
    created.room.code,
    "waiting",
    null,
    "host-socket",
  );
  let deferredWrites = 0;
  const unresolvedMutation = rooms.deferRoomMutation(
    created.room.code,
    async () => {
      deferredWrites += 1;
      throw new Error("Uncertain write outcome.");
    },
  );
  void unresolvedMutation.catch(() => {});

  let attempts = 0;
  let blockedAtExhaustion = false;
  const worker = new RoomMutationReconciliationWorker({
    isServingReady: () => true,
    hasBlockedWork: (roomCode) =>
      rooms.hasBlockedDeferredRoomMutations(roomCode),
    reconcile: async (roomCode) => {
      attempts += 1;
      if (attempts === 5) {
        blockedAtExhaustion = rooms.hasBlockedDeferredRoomMutations(roomCode);
      }
      return rooms.reconcileDeferredRoomMutations(roomCode);
    },
    now: () => clock.nowMs,
    scheduleTimeout: clock.scheduleTimeout,
    report: () => {},
  });
  rooms.onDeferredRoomMutationBlocked((roomCode) => worker.request(roomCode));
  rooms.releaseGameStatusReservation(reservation);
  await flushCallbacks();
  rooms.suspendGameplay(
    created.room.code,
    scope,
    "durable_timeout_post_commit_side_effect_failure",
  );

  for (const delay of [250, 500, 1_000, 2_000]) {
    clock.advance(delay);
    await flushCallbacks();
  }
  await worker.drain();

  assert.equal(attempts, 5);
  assert.equal(deferredWrites, 1);
  assert.equal(blockedAtExhaustion, true);
  assert.deepEqual(worker.getDiagnostics(), {
    trackedRooms: 1,
    pendingRooms: 0,
    exhaustedRooms: 1,
  });
  assert.equal(rooms.hasBlockedDeferredRoomMutations(created.room.code), true);
  assert.equal(rooms.isGameplaySuspended(created.room.code), true);
  const queues = Reflect.get(rooms, "deferredRoomMutations") as Map<
    RoomCode,
    { pending: unknown[]; blocked: boolean }
  >;
  assert.equal(queues.get(created.room.code)?.pending.length, 1);
  assert.equal(queues.get(created.room.code)?.blocked, true);
  assert.throws(
    () => rooms.joinRoom(
      { roomCode: created.room.code, nickname: "Late joiner" },
      "late-socket",
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.throws(
    () => rooms.assertGameplayAvailable(created.room.code),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  assert.throws(
    () => rooms.beginImpostorGame(
      created.room.code,
      "host-socket",
      "replacement-game" as GameSessionId,
      "impostor-classic",
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.throws(
    () => rooms.returnFinishedGameToLobby(
      created.room.code,
      "host-socket",
      "replacement-game" as GameSessionId,
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.throws(
    () => rooms.reconnect(
      {
        roomCode: created.room.code,
        playerId: guest.playerId,
        reconnectToken: guest.reconnectToken,
      },
      "guest-reconnected",
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNKNOWN",
  );
  assert.equal(rooms.isGameplaySuspended(created.room.code), true);
  assert.equal(
    rooms.joinRoom(
      { roomCode: unaffectedRoom.room.code, nickname: "Other guest" },
      "other-guest",
    ).room.players.length,
    2,
  );
});

test("lease loss prevents retry scheduling", async () => {
  const clock = new FakeClock();
  let servingReady = true;
  let attempts = 0;
  const worker = new RoomMutationReconciliationWorker({
    isServingReady: () => servingReady,
    hasBlockedWork: () => true,
    reconcile: async () => {
      attempts += 1;
      servingReady = false;
      throw new Error("lease lost");
    },
    now: () => clock.nowMs,
    scheduleTimeout: clock.scheduleTimeout,
    report: () => {},
  });

  worker.request(ROOM_CODE);
  await flushCallbacks();
  clock.advance(10_000);
  await flushCallbacks();
  assert.equal(attempts, 1);
  worker.stop();
  await worker.drain();
});

test("shutdown stops new work and drains an in-flight reconciliation", async () => {
  const clock = new FakeClock();
  let resolveAttempt!: () => void;
  const attempt = new Promise<void>((resolve) => {
    resolveAttempt = resolve;
  });
  let attempts = 0;
  let blocked = true;
  const worker = new RoomMutationReconciliationWorker({
    isServingReady: () => true,
    hasBlockedWork: () => blocked,
    reconcile: async () => {
      attempts += 1;
      await attempt;
      blocked = false;
      return true;
    },
    now: () => clock.nowMs,
    scheduleTimeout: clock.scheduleTimeout,
    report: () => {},
  });

  worker.request(ROOM_CODE);
  await flushCallbacks();
  worker.stop();
  worker.request("EFGH" as RoomCode);
  let drained = false;
  const drain = worker.drain().then(() => {
    drained = true;
  });
  await flushCallbacks();
  assert.equal(drained, false);
  assert.equal(attempts, 1);
  resolveAttempt();
  await drain;
  assert.equal(drained, true);
  assert.equal(blocked, false);
});
