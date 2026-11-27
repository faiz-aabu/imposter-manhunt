import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateClockSyncSample,
  getServerDeadlineRemainingMs,
  scheduleServerDeadline,
  selectLowestRoundTripSample,
  ServerClockSynchronizer,
} from "../src/services/server-clock-sync.ts";
import {
  getCountdownRemainingSeconds,
  isCountdownOpen,
} from "../src/hooks/use-server-countdown.ts";
import { useClassicGameStore } from "../src/store/classic-game-store.ts";
import { useWordGameStore } from "../src/store/word-game-store.ts";

const startTime = "2026-01-01T00:00:00.000Z";
const roleRevealEndsAt = "2026-01-01T00:00:10.000Z";
const discussionEndsAt = "2026-01-01T00:00:40.000Z";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function attempt(requestId, offsetMs, roundTripMs = 20) {
  const clientSentAt = 1_000_000;
  const clientReceivedAt = clientSentAt + roundTripMs;
  const serverTime =
    (clientSentAt + clientReceivedAt) / 2 + offsetMs;
  return {
    requestId,
    serverTime: new Date(serverTime).toISOString(),
    clientSentAt,
    clientReceivedAt,
  };
}

function makeSession(gameMode, state, id = "session-1") {
  return {
    id,
    roomCode: "ROOM",
    gameMode,
    startedAt: "1999-01-01T00:00:00.000Z",
    state,
  };
}

function roleState() {
  return {
    phase: "role_reveal",
    roundNumber: 1,
    roleRevealEndsAt,
    votesSubmitted: 0,
    eligibleVoters: 3,
    eliminatedPlayerIds: [],
  };
}

function discussionState() {
  return {
    ...roleState(),
    phase: "discussion",
    roleRevealEndsAt: undefined,
    discussionEndsAt,
  };
}

function resetStores() {
  useClassicGameStore.getState().reset();
  useClassicGameStore.getState().setServerTimeOffset(null);
  useWordGameStore.getState().reset();
  useWordGameStore.getState().setServerTimeOffset(null);
}

test("server deadline timers account for clock skew and can be cancelled", (t) => {
  const deviceNow = Date.parse("2026-01-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: deviceNow });
  let expiredCount = 0;

  const aheadDeadline = new Date(deviceNow - 5_000).toISOString();
  assert.equal(
    getServerDeadlineRemainingMs(aheadDeadline, -10_000),
    5_000,
  );
  scheduleServerDeadline(aheadDeadline, -10_000, () => {
    expiredCount += 1;
  });
  t.mock.timers.tick(4_999);
  assert.equal(expiredCount, 0);
  t.mock.timers.tick(1);
  assert.equal(expiredCount, 1);

  const behindDeadline = new Date(Date.now() + 15_000).toISOString();
  assert.equal(
    getServerDeadlineRemainingMs(behindDeadline, 10_000),
    5_000,
  );
  scheduleServerDeadline(behindDeadline, 10_000, () => {
    expiredCount += 1;
  });
  t.mock.timers.tick(4_999);
  assert.equal(expiredCount, 1);
  t.mock.timers.tick(1);
  assert.equal(expiredCount, 2);

  const expiredDeadline = new Date(Date.now() + 5_000).toISOString();
  assert.equal(
    getServerDeadlineRemainingMs(expiredDeadline, 10_000),
    -5_000,
  );
  scheduleServerDeadline(expiredDeadline, 10_000, () => {
    expiredCount += 1;
  });
  t.mock.timers.tick(1);
  assert.equal(expiredCount, 3);

  const cancel = scheduleServerDeadline(
    new Date(Date.now() + 5_000).toISOString(),
    0,
    () => {
      expiredCount += 1;
    },
  );
  cancel();
  t.mock.timers.tick(5_000);
  assert.equal(expiredCount, 3);
  t.mock.timers.reset();
});

test("clock offset uses the client request-response midpoint and measures RTT", () => {
  const sample = calculateClockSyncSample(1, {
    requestId: 1,
    serverTime: new Date(1_600).toISOString(),
    clientSentAt: 1_000,
    clientReceivedAt: 1_300,
  });

  assert.deepEqual(sample, {
    requestId: 1,
    offsetMs: 450,
    roundTripMs: 300,
  });
});

test("clock synchronization selects the lowest-RTT valid sample", async () => {
  let selectedOffset = null;
  const synchronizer = new ServerClockSynchronizer(
    (offset) => {
      if (offset !== null) selectedOffset = offset;
    },
    () => assert.fail("A valid sample batch must not fail."),
  );
  let requestCount = 0;

  await synchronizer.synchronize(async (requestId) => {
    requestCount += 1;
    const responseByRequest = new Map([
      [1, attempt(1, 500, 60)],
      [2, attempt(2, 100, 40)],
      [3, attempt(3, 250, 10)],
    ]);
    return responseByRequest.get(requestId);
  });

  assert.equal(requestCount, 3);
  assert.equal(selectedOffset, 250);
});

test("an older synchronization generation cannot replace a newer estimate", async () => {
  let offset = null;
  const synchronizer = new ServerClockSynchronizer(
    (value) => {
      offset = value;
    },
    () => assert.fail("Both generations have valid samples."),
  );
  const olderRequests = [];
  const newerRequests = [];
  const olderSync = synchronizer.synchronize((requestId) => {
    const request = deferred();
    olderRequests.push({ requestId, ...request });
    return request.promise;
  });
  const newerSync = synchronizer.synchronize((requestId) => {
    const request = deferred();
    newerRequests.push({ requestId, ...request });
    return request.promise;
  });

  for (const request of newerRequests) {
    request.resolve(attempt(request.requestId, 200, 10));
  }
  await newerSync;
  assert.equal(offset, 200);
  const remainingAfterNewerSample = getCountdownRemainingSeconds(
    "2026-01-01T00:01:00.000Z",
    offset,
    Date.parse(startTime),
  );

  for (const request of olderRequests) {
    request.resolve(attempt(request.requestId, -500, 10));
  }
  await olderSync;
  assert.equal(offset, 200);
  assert.equal(
    getCountdownRemainingSeconds(
      "2026-01-01T00:01:00.000Z",
      offset,
      Date.parse(startTime),
    ),
    remainingAfterNewerSample,
  );
});

test("a previous connection's response is ignored after reconnect", async () => {
  let offset = null;
  const synchronizer = new ServerClockSynchronizer(
    (value) => {
      offset = value;
    },
    () => assert.fail("The current connection has valid samples."),
  );
  const oldRequests = [];
  const oldSync = synchronizer.synchronize((requestId) => {
    const request = deferred();
    oldRequests.push({ requestId, ...request });
    return request.promise;
  });

  await flushMicrotasks();
  synchronizer.invalidate();
  const currentSync = synchronizer.synchronize(async (requestId) =>
    attempt(requestId, 175, 10),
  );
  await currentSync;
  assert.equal(offset, 175);

  for (const request of oldRequests) {
    request.resolve(attempt(request.requestId, -900, 1));
  }
  await oldSync;
  assert.equal(offset, 175);
});

test("invalid clock timestamps, request IDs, and RTTs are rejected", () => {
  assert.equal(
    calculateClockSyncSample(1, {
      ...attempt(1, 0),
      serverTime: "not-a-date",
    }),
    null,
  );
  assert.equal(
    calculateClockSyncSample(1, {
      ...attempt(2, 0),
    }),
    null,
  );
  assert.equal(
    calculateClockSyncSample(1, {
      ...attempt(1, 0),
      clientReceivedAt: Number.NaN,
    }),
    null,
  );
  assert.equal(
    calculateClockSyncSample(1, {
      ...attempt(1, 0),
      clientReceivedAt: 999_999,
    }),
    null,
  );
  assert.equal(
    selectLowestRoundTripSample([
      { requestId: 1, offsetMs: Number.NaN, roundTripMs: 1 },
      { requestId: 2, offsetMs: 10, roundTripMs: Number.POSITIVE_INFINITY },
    ]),
    null,
  );
});

for (const { name, store, gameMode } of [
  {
    name: "Classic",
    store: useClassicGameStore,
    gameMode: "impostor-classic",
  },
  {
    name: "Word",
    store: useWordGameStore,
    gameMode: "impostor-word",
  },
]) {
  test(`${name} uses the shared sync and ignores game-event timestamps`, async () => {
    resetStores();
    store.getState().setSession(makeSession(gameMode, roleState()), []);
    assert.equal(store.getState().serverTimeOffsetMs, null);

    const synchronizer = new ServerClockSynchronizer(
      (offset) => {
        useClassicGameStore.getState().setServerTimeOffset(offset);
        useWordGameStore.getState().setServerTimeOffset(offset);
      },
      () => assert.fail("The shared sync request should succeed."),
    );
    await synchronizer.synchronize(async (requestId) =>
      attempt(requestId, 125, requestId * 10),
    );
    assert.equal(useClassicGameStore.getState().serverTimeOffsetMs, 125);
    assert.equal(useWordGameStore.getState().serverTimeOffsetMs, 125);

    const state = discussionState();
    store.getState().setGameState({
      sessionId: "session-1",
      roomCode: "ROOM",
      state,
      updatedAt: "2000-01-01T00:00:00.000Z",
    });
    store.getState().setDiscussion({
      sessionId: "session-1",
      startsAt: "2000-01-01T00:00:00.000Z",
      endsAt: discussionEndsAt,
    });

    assert.equal(store.getState().serverTimeOffsetMs, 125);
    assert.equal(store.getState().state.discussionEndsAt, discussionEndsAt);
    assert.equal(store.getState().discussion.endsAt, discussionEndsAt);
    resetStores();
  });

  test(`${name} countdowns use server deadlines and do not advance game state`, () => {
    resetStores();
    store.getState().setSession(makeSession(gameMode, roleState()), []);
    store.getState().setServerTimeOffset(0);
    const clientNow = Date.parse(startTime);

    assert.equal(
      getCountdownRemainingSeconds(roleRevealEndsAt, 0, clientNow),
      10,
    );
    store.getState().setGameState({
      sessionId: "session-1",
      roomCode: "ROOM",
      state: discussionState(),
      updatedAt: startTime,
    });
    assert.equal(
      getCountdownRemainingSeconds(discussionEndsAt, 0, clientNow),
      40,
    );
    assert.equal(store.getState().state.phase, "discussion");
    resetStores();
  });

  test(`${name} reconnect sync refreshes the offset without changing deadlines`, async () => {
    resetStores();
    store.getState().setSession(makeSession(gameMode, roleState()), []);
    store.getState().setServerTimeOffset(25);
    store.getState().setDiscussion({
      sessionId: "session-1",
      startsAt: roleRevealEndsAt,
      endsAt: discussionEndsAt,
    });
    store.getState().setGameState({
      sessionId: "session-1",
      roomCode: "ROOM",
      state: discussionState(),
      updatedAt: startTime,
    });

    const synchronizer = new ServerClockSynchronizer(
      (offset) => {
        useClassicGameStore.getState().setServerTimeOffset(offset);
        useWordGameStore.getState().setServerTimeOffset(offset);
      },
      () => assert.fail("The reconnect sync request should succeed."),
    );
    synchronizer.invalidate();
    store
      .getState()
      .setSession(makeSession(gameMode, discussionState()), []);
    assert.equal(store.getState().serverTimeOffsetMs, null);

    await synchronizer.synchronize(async (requestId) =>
      attempt(requestId, 225, 10),
    );

    assert.equal(store.getState().serverTimeOffsetMs, 225);
    assert.equal(store.getState().state.discussionEndsAt, discussionEndsAt);
    assert.equal(store.getState().discussion?.endsAt, discussionEndsAt);
    resetStores();
  });
}

test("pending clock sync produces no countdown estimate", () => {
  assert.equal(getCountdownRemainingSeconds(roleRevealEndsAt, null, 0), null);
});

test("a batch with no valid responses reports failure after bounded retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let offset = null;
  let failures = 0;
  const synchronizer = new ServerClockSynchronizer(
    (value) => {
      offset = value;
    },
    () => {
      failures += 1;
    },
  );

  const synchronization = synchronizer.synchronize(async () => {
    throw new Error("request failed");
  });
  await flushMicrotasks();
  t.mock.timers.tick(1_000);
  await flushMicrotasks();
  t.mock.timers.tick(1_000);
  await synchronization;

  assert.equal(offset, null);
  assert.equal(failures, 1);
  t.mock.timers.reset();
});

test("each request times out and valid partial samples survive other timeouts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let offset = null;
  const statuses = [];
  const synchronizer = new ServerClockSynchronizer(
    (value) => {
      offset = value;
    },
    () => assert.fail("A valid partial batch must not fail."),
    (status) => statuses.push(status),
  );
  const synchronization = synchronizer.synchronize((requestId) =>
    requestId === 1
      ? Promise.resolve(attempt(requestId, 175, 10))
      : new Promise(() => {}),
  );

  await flushMicrotasks();
  t.mock.timers.tick(2_000);
  await synchronization;

  assert.equal(offset, 175);
  assert.deepEqual(statuses, ["syncing", "ready"]);
  t.mock.timers.reset();
});

test("a completely failed batch retries a bounded number of times", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let offset = null;
  let requestCount = 0;
  let failures = 0;
  const synchronizer = new ServerClockSynchronizer(
    (value) => {
      offset = value;
    },
    () => {
      failures += 1;
    },
  );
  const synchronization = synchronizer.synchronize((requestId) => {
    requestCount += 1;
    if (requestCount <= 3) {
      return Promise.reject(new Error("first batch unavailable"));
    }
    return Promise.resolve(attempt(requestId, 240, requestId));
  });

  await flushMicrotasks();
  t.mock.timers.tick(1_000);
  await flushMicrotasks();
  await synchronization;

  assert.equal(requestCount, 6);
  assert.equal(offset, 240);
  assert.equal(failures, 0);
  assert.equal(
    isCountdownOpen(
      getCountdownRemainingSeconds(
        "2026-01-01T00:01:00.000Z",
        offset,
        Date.parse(startTime),
      ),
    ),
    true,
  );
  t.mock.timers.reset();
});

test("all timed-out batches stop after the configured bounded retries", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestCount = 0;
  let failures = 0;
  const statuses = [];
  const synchronizer = new ServerClockSynchronizer(
    () => {},
    () => {
      failures += 1;
    },
    (status) => statuses.push(status),
  );
  const synchronization = synchronizer.synchronize(() => {
    requestCount += 1;
    return new Promise(() => {});
  });

  for (let batch = 0; batch < 3; batch += 1) {
    await flushMicrotasks();
    t.mock.timers.tick(2_000);
    await flushMicrotasks();
    if (batch < 2) {
      t.mock.timers.tick(1_000);
    }
  }
  await synchronization;

  assert.equal(requestCount, 9);
  assert.equal(failures, 1);
  assert.deepEqual(statuses, ["syncing", "failed"]);
  t.mock.timers.reset();
});

test("disconnect cancels a scheduled retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requestCount = 0;
  let status = "idle";
  const synchronizer = new ServerClockSynchronizer(
    () => {},
    () => assert.fail("Cancelled synchronization must not fail."),
    (nextStatus) => {
      status = nextStatus;
    },
  );
  const synchronization = synchronizer.synchronize(() => {
    requestCount += 1;
    return Promise.reject(new Error("connection lost"));
  });

  await flushMicrotasks();
  assert.equal(requestCount, 3);
  synchronizer.invalidate();
  t.mock.timers.tick(5_000);
  await synchronization;

  assert.equal(requestCount, 3);
  assert.equal(status, "idle");
  t.mock.timers.reset();
});

test("vote countdown actions remain gated until synchronization succeeds", async () => {
  const deadline = "2026-01-01T00:01:00.000Z";
  const clientNow = Date.parse(startTime);
  let offset = null;
  const synchronizer = new ServerClockSynchronizer(
    (value) => {
      offset = value;
    },
    () => assert.fail("Synchronization should succeed."),
  );

  assert.equal(
    isCountdownOpen(getCountdownRemainingSeconds(deadline, offset, clientNow)),
    false,
  );
  await synchronizer.synchronize(async (requestId) =>
    attempt(requestId, 100, requestId),
  );
  assert.equal(
    isCountdownOpen(getCountdownRemainingSeconds(deadline, offset, clientNow)),
    true,
  );
  assert.equal(isCountdownOpen(null), false);
  assert.equal(isCountdownOpen(0), false);
});
