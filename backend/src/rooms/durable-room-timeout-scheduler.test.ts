import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlayerId, RoomCode } from "@impostor/api";
import {
  DurableRoomTimeoutScheduler,
  type DurableTimeoutFailureContext,
  type RecoveredDisconnectTimeout,
} from "./durable-room-timeout-scheduler.js";
import { RoomPersistenceCoordinatorCapacityError } from "./room-persistence-coordinator.js";
import type { RecoverableWaitingRoom } from "./postgres-room-repository.js";
import {
  DeferredRoomMutationCapacityError,
  RoomService,
  type PlayerRemoval,
} from "./room-service.js";
import { AppError } from "../utils/app-error.js";

const START = new Date("2026-01-01T00:00:00.000Z").getTime();
const ROOM_CODE = "ABCD" as RoomCode;

interface FakeTimer {
  readonly dueAt: number;
  readonly callback: () => void;
  cancelled: boolean;
}

class FakeClock {
  nowMs = START;
  readonly scheduledDelays: number[] = [];
  private readonly timers: FakeTimer[] = [];

  scheduleTimeout = (callback: () => void, delayMs: number): (() => void) => {
    const timer: FakeTimer = {
      dueAt: this.nowMs + delayMs,
      callback,
      cancelled: false,
    };
    this.timers.push(timer);
    this.scheduledDelays.push(delayMs);
    return () => {
      timer.cancelled = true;
    };
  };

  now = (): Date => new Date(this.nowMs);

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

function timeout(
  playerId: string,
  generation: string,
  deadlineMs: number,
): RecoveredDisconnectTimeout {
  return {
    roomCode: ROOM_CODE,
    playerId: playerId as PlayerId,
    disconnectGeneration: generation,
    reconnectDeadlineAt: new Date(deadlineMs),
  };
}

async function flushCallbacks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("schedules a persisted deadline exactly once and allows reconnect cancellation", async () => {
  const clock = new FakeClock();
  const removed: RecoveredDisconnectTimeout[] = [];
  let servingReady = false;
  const scheduler = new DurableRoomTimeoutScheduler({
    scheduleTimeout: clock.scheduleTimeout,
    now: clock.now,
    isServingReady: () => servingReady,
    removeDisconnectedPlayer: async (entry) => {
      removed.push(entry);
      return undefined;
    },
    reportFailure: assert.fail,
  });
  const pending = timeout("player-a", "7", START + 5_000);

  assert.throws(() => scheduler.schedule(pending), /serving-ready/);
  assert.deepEqual(clock.scheduledDelays, []);
  servingReady = true;
  scheduler.schedule(pending);
  scheduler.schedule(pending);
  assert.deepEqual(clock.scheduledDelays, [5_000]);

  clock.advance(4_999);
  await flushCallbacks();
  assert.equal(removed.length, 0);
  scheduler.cancelPlayer(ROOM_CODE, pending.playerId);
  clock.advance(1);
  await flushCallbacks();
  assert.equal(removed.length, 0);
});

test("publishes timeout removal side effects once after the durable removal result", async () => {
  const clock = new FakeClock();
  let persistenceCalls = 0;
  const published: PlayerRemoval[] = [];
  const removal: PlayerRemoval = {
    roomCode: ROOM_CODE,
    playerId: "player-a" as PlayerId,
    room: {
      code: ROOM_CODE,
      hostId: "player-b" as PlayerId,
      players: [],
      settings: {
        gameMode: "impostor-classic",
        maxPlayers: 8,
        isPrivate: false,
      },
      gameStatus: "waiting",
      createdAt: new Date(START).toISOString(),
    },
    deleted: false,
    hostChanged: false,
  };
  const scheduler = new DurableRoomTimeoutScheduler({
    scheduleTimeout: clock.scheduleTimeout,
    now: clock.now,
    isServingReady: () => true,
    removeDisconnectedPlayer: async () => {
      persistenceCalls += 1;
      return removal;
    },
    onRemoval: (result) => {
      published.push(result);
    },
    reportFailure: assert.fail,
  });

  scheduler.schedule(timeout("player-a", "1", START + 10));
  clock.advance(10);
  await flushCallbacks();

  assert.equal(persistenceCalls, 1);
  assert.deepEqual(published, [removal]);
});

test("a side-effect capacity error is retained instead of retrying a committed removal", async () => {
  const clock = new FakeClock();
  let persistenceCalls = 0;
  let sideEffectCalls = 0;
  const reported: unknown[] = [];
  const phases: DurableTimeoutFailureContext["phase"][] = [];
  const committedRemoval: PlayerRemoval = {
    roomCode: ROOM_CODE,
    playerId: "player-a" as PlayerId,
    deleted: true,
    hostChanged: true,
    suspensionScope: { roomId: "durable-room-a", gameId: null },
  };
  const scheduler = new DurableRoomTimeoutScheduler({
    scheduleTimeout: clock.scheduleTimeout,
    now: clock.now,
    isServingReady: () => true,
    removeDisconnectedPlayer: async () => {
      persistenceCalls += 1;
      return committedRemoval;
    },
    onRemoval: () => {
      sideEffectCalls += 1;
      throw new RoomPersistenceCoordinatorCapacityError();
    },
    reportFailure: (error, context) => {
      reported.push(error);
      phases.push(context.phase);
      assert.equal(context.removal, committedRemoval);
    },
  });
  scheduler.schedule(timeout("player-a", "1", START + 10));
  clock.advance(10);
  await flushCallbacks();
  clock.advance(1_000);
  await flushCallbacks();

  assert.equal(persistenceCalls, 1);
  assert.equal(sideEffectCalls, 1);
  assert.equal(reported.length, 1);
  assert.deepEqual(phases, ["side_effect"]);
  assert.deepEqual(scheduler.getDiagnostics(), {
    scheduledTimeouts: 1,
    pendingPostCommitSideEffects: 1,
  });
});

test("post-commit timeout failure suspends its room without replaying removal or side effects", async () => {
  const clock = new FakeClock();
  const rooms = new RoomService();
  const created = rooms.createRoom({ nickname: "Host" }, "host-socket");
  const scope = rooms.getGameplaySuspensionScope(created.room.code, null);
  assert.ok(scope);
  const removal: PlayerRemoval = {
    roomCode: created.room.code,
    playerId: created.playerId,
    deleted: false,
    hostChanged: false,
    suspensionScope: scope,
  };
  let persistenceCalls = 0;
  let sideEffectCalls = 0;
  const scheduler = new DurableRoomTimeoutScheduler({
    scheduleTimeout: clock.scheduleTimeout,
    now: clock.now,
    isServingReady: () => true,
    removeDisconnectedPlayer: async () => {
      persistenceCalls += 1;
      return removal;
    },
    onRemoval: () => {
      sideEffectCalls += 1;
      throw new Error("injected post-commit side-effect failure");
    },
    reportFailure: (_error, context) => {
      assert.equal(context.phase, "side_effect");
      assert.equal(context.removal, removal);
      rooms.suspendGameplay(
        context.roomCode,
        removal.suspensionScope!,
        "durable_timeout_post_commit_side_effect_failure",
      );
    },
  });

  scheduler.schedule({
    ...timeout("player-a", "1", START + 10),
    roomCode: created.room.code,
    playerId: created.playerId,
  });
  clock.advance(10);
  await flushCallbacks();
  clock.advance(1_000);
  await flushCallbacks();

  assert.equal(persistenceCalls, 1);
  assert.equal(sideEffectCalls, 1);
  assert.equal(rooms.isGameplaySuspended(created.room.code), true);
  assert.throws(
    () =>
      rooms.joinRoom(
        { roomCode: created.room.code, nickname: "Guest" },
        "guest-socket",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  assert.equal(scheduler.getDiagnostics().pendingPostCommitSideEffects, 1);
});

test("restores each disconnected member from its deadline and runs expired deadlines immediately", async () => {
  const clock = new FakeClock();
  const removed: RecoveredDisconnectTimeout[] = [];
  const scheduler = new DurableRoomTimeoutScheduler({
    scheduleTimeout: clock.scheduleTimeout,
    now: clock.now,
    isServingReady: () => true,
    removeDisconnectedPlayer: async (entry) => {
      removed.push(entry);
      return undefined;
    },
    reportFailure: assert.fail,
  });
  const recovered = {
    roomCode: ROOM_CODE,
    members: [
      {
        playerId: "player-a" as PlayerId,
        connectionStatus: "disconnected",
        disconnectGeneration: "2",
        reconnectDeadlineAt: new Date(START - 1),
      },
      {
        playerId: "player-b" as PlayerId,
        connectionStatus: "disconnected",
        disconnectGeneration: "9",
        reconnectDeadlineAt: new Date(START + 3_000),
      },
      {
        playerId: "player-c" as PlayerId,
        connectionStatus: "connected",
        disconnectGeneration: "1",
        reconnectDeadlineAt: null,
      },
    ],
  } as RecoverableWaitingRoom;

  scheduler.scheduleRecoveredRooms([recovered]);
  assert.deepEqual(clock.scheduledDelays, [0, 3_000]);
  clock.advance(0);
  await flushCallbacks();
  assert.deepEqual(
    removed.map((entry) => entry.playerId),
    ["player-a"],
  );
  clock.advance(3_000);
  await flushCallbacks();
  assert.deepEqual(
    removed.map((entry) => entry.playerId),
    ["player-a", "player-b"],
  );
});

test("a newer disconnect generation replaces an older timer", async () => {
  const clock = new FakeClock();
  const removed: RecoveredDisconnectTimeout[] = [];
  const scheduler = new DurableRoomTimeoutScheduler({
    scheduleTimeout: clock.scheduleTimeout,
    now: clock.now,
    isServingReady: () => true,
    removeDisconnectedPlayer: async (entry) => {
      removed.push(entry);
      return undefined;
    },
    reportFailure: assert.fail,
  });

  scheduler.schedule(timeout("player-a", "4", START + 5_000));
  scheduler.schedule(timeout("player-a", "3", START + 2_000));
  scheduler.schedule(timeout("player-a", "5", START + 8_000));
  assert.deepEqual(clock.scheduledDelays, [5_000, 8_000]);
  clock.advance(5_000);
  await flushCallbacks();
  assert.equal(removed.length, 0);
  clock.advance(3_000);
  await flushCallbacks();
  assert.deepEqual(removed.map((entry) => entry.disconnectGeneration), ["5"]);
});

test("long deadlines are split below the platform timer limit", async () => {
  const clock = new FakeClock();
  const scheduler = new DurableRoomTimeoutScheduler({
    scheduleTimeout: clock.scheduleTimeout,
    now: clock.now,
    isServingReady: () => true,
    removeDisconnectedPlayer: async () => undefined,
    reportFailure: assert.fail,
  });
  const maxDelay = 2_147_483_647;

  scheduler.schedule(timeout("player-a", "1", START + maxDelay + 10_000));
  assert.deepEqual(clock.scheduledDelays, [maxDelay]);
  clock.advance(maxDelay);
  await flushCallbacks();
  assert.deepEqual(clock.scheduledDelays, [maxDelay, 10_000]);
  scheduler.cancelAll();
});

test("retries not-yet-due persistence and reports failures without another removal attempt", async () => {
  const clock = new FakeClock();
  const reported: Array<{ error: unknown; context: DurableTimeoutFailureContext }> = [];
  let attempts = 0;
  const scheduler = new DurableRoomTimeoutScheduler({
    scheduleTimeout: clock.scheduleTimeout,
    now: clock.now,
    isServingReady: () => true,
    removeDisconnectedPlayer: async () => {
      attempts += 1;
      if (attempts === 1) {
        return { retryAt: new Date(START + 2_000) };
      }
      throw new Error("database write failed");
    },
    reportFailure: (error, context) => reported.push({ error, context }),
  });

  scheduler.schedule(timeout("player-a", "3", START + 1_000));
  clock.advance(1_000);
  await flushCallbacks();
  assert.equal(attempts, 1);
  assert.deepEqual(clock.scheduledDelays, [1_000, 1_000]);
  clock.advance(1_000);
  await flushCallbacks();
  assert.equal(attempts, 2);
  assert.equal(reported.length, 1);
  assert.match(String(reported[0]?.error), /database write failed/);
  assert.equal(reported[0]?.context.disconnectGeneration, "3");
  assert.equal(reported[0]?.context.phase, "persistence");
  scheduler.schedule(timeout("player-a", "3", START + 1_000));
  clock.advance(10_000);
  await flushCallbacks();
  assert.equal(attempts, 2);
});

test("retries coordinator capacity rejection without changing the timeout deadline", async () => {
  const clock = new FakeClock();
  let attempts = 0;
  const scheduler = new DurableRoomTimeoutScheduler({
    scheduleTimeout: clock.scheduleTimeout,
    now: clock.now,
    isServingReady: () => true,
    removeDisconnectedPlayer: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new RoomPersistenceCoordinatorCapacityError();
      }
      return undefined;
    },
    reportFailure: assert.fail,
  });

  scheduler.schedule(timeout("player-a", "8", START));
  clock.advance(0);
  await flushCallbacks();
  assert.equal(attempts, 1);
  assert.deepEqual(clock.scheduledDelays, [0, 250]);

  clock.advance(249);
  await flushCallbacks();
  assert.equal(attempts, 1);
  clock.advance(1);
  await flushCallbacks();
  assert.equal(attempts, 2);
});

test("retries deferred-queue capacity without changing the timeout deadline", async () => {
  const clock = new FakeClock();
  let attempts = 0;
  const scheduler = new DurableRoomTimeoutScheduler({
    scheduleTimeout: clock.scheduleTimeout,
    now: clock.now,
    isServingReady: () => true,
    removeDisconnectedPlayer: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new DeferredRoomMutationCapacityError();
      }
      return undefined;
    },
    reportFailure: assert.fail,
  });

  scheduler.schedule(timeout("player-a", "8", START));
  clock.advance(0);
  await flushCallbacks();
  assert.equal(attempts, 1);
  assert.deepEqual(clock.scheduledDelays, [0, 250]);
  clock.advance(250);
  await flushCallbacks();
  assert.equal(attempts, 2);
});

test("only one scheduler owns a room timeout at a time", async () => {
  const clock = new FakeClock();
  const rooms = new RoomService();
  const removed: string[] = [];
  const ownership = {
    claimTimeoutOwnership: (
      roomCode: RoomCode,
      playerId: PlayerId,
      owner: symbol,
    ) => rooms.claimDisconnectTimeout(roomCode, playerId, owner),
    releaseTimeoutOwnership: (
      roomCode: RoomCode,
      playerId: PlayerId,
      owner: symbol,
    ) => rooms.releaseDisconnectTimeout(roomCode, playerId, owner),
  };
  const createScheduler = () => new DurableRoomTimeoutScheduler({
    ...ownership,
    scheduleTimeout: clock.scheduleTimeout,
    now: clock.now,
    isServingReady: () => true,
    removeDisconnectedPlayer: async (entry) => {
      removed.push(entry.disconnectGeneration);
      return undefined;
    },
    reportFailure: assert.fail,
  });
  const first = createScheduler();
  const second = createScheduler();
  const entry = timeout("player-a", "9", START + 10);

  first.schedule(entry);
  second.schedule(entry);
  assert.deepEqual(clock.scheduledDelays, [10]);
  clock.advance(10);
  await flushCallbacks();
  assert.deepEqual(removed, ["9"]);
  assert.equal(
    rooms.claimDisconnectTimeout(ROOM_CODE, entry.playerId, Symbol("next")),
    true,
  );
});

test("shutdown or lease loss cancels pending timers", () => {
  const clock = new FakeClock();
  const scheduler = new DurableRoomTimeoutScheduler({
    scheduleTimeout: clock.scheduleTimeout,
    now: clock.now,
    isServingReady: () => true,
    removeDisconnectedPlayer: async () => undefined,
    reportFailure: assert.fail,
  });

  scheduler.schedule(timeout("player-a", "1", START + 10_000));
  scheduler.cancelAll();
  clock.advance(10_000);
  assert.deepEqual(clock.scheduledDelays, [10_000]);
});
