import assert from "node:assert/strict";
import test from "node:test";
import { useManhuntGameStore } from "../src/store/manhunt-game-store.ts";
import { getManhuntRoleRoute } from "../src/utils/manhunt-role-countdown.ts";

const runnerHeadStartEndsAt = "2026-01-01T00:00:40.000Z";
const countdownEndsAt = "2026-01-01T00:00:50.000Z";

function session(sessionId, phase = "countdown") {
  const state = {
    phase,
    settings: {
      hunterCount: 1,
      boundary: {
        center: { latitude: 0, longitude: 0 },
        radiusMeters: 500,
      },
    },
    readyPlayerIds: [],
    ...(phase === "countdown"
      ? { countdownEndsAt, runnerHeadStartEndsAt }
      : { activeSince: "2026-01-01T00:00:10.000Z" }),
  };
  return {
    id: sessionId,
    roomCode: "ABCD",
    status: phase === "countdown" ? "starting" : "in_progress",
    gameMode: "manhunt",
    startedAt: "2026-01-01T00:00:00.000Z",
    state,
  };
}

function countdown(sessionId) {
  return {
    roomCode: "ABCD",
    sessionId,
    remainingSeconds: 50,
    endsAt: countdownEndsAt,
    runnerHeadStartEndsAt,
    serverNow: "2026-01-01T00:00:00.000Z",
  };
}

test("countdown uses a server clock offset and rejects stale session events", () => {
  const store = useManhuntGameStore.getState();
  store.reset();
  store.setSession(session("session-1"), []);
  store.setCountdown(countdown("session-1"), 1_767_225_590_000);

  assert.equal(
    useManhuntGameStore.getState().countdownServerOffsetMs,
    Date.parse("2026-01-01T00:00:00.000Z") - 1_767_225_590_000,
  );

  useManhuntGameStore.getState().setSession(session("session-2"), []);
  useManhuntGameStore.getState().setCountdown(countdown("session-1"), 0);
  assert.equal(useManhuntGameStore.getState().countdown, null);
  store.reset();
});

test("countdown-first then private role assignment preserves both server deadlines", () => {
  const store = useManhuntGameStore.getState();
  store.reset();
  store.setSession(session("session-order"), []);
  store.setCountdown(countdown("session-order"), Date.now());
  const beforeAssignment = useManhuntGameStore.getState().countdown;
  assert.ok(beforeAssignment);

  store.setOwnTeam("session-order", "player-1", "runner");

  const state = useManhuntGameStore.getState();
  assert.equal(state.ownTeam, "runner");
  assert.equal(state.ownPlayerId, "player-1");
  assert.equal(state.countdown, beforeAssignment);
  assert.equal(state.countdown?.endsAt, countdownEndsAt);
  assert.equal(state.countdown?.runnerHeadStartEndsAt, runnerHeadStartEndsAt);
  assert.equal(getManhuntRoleRoute(state.ownTeam), "/manhunt/map");
  store.reset();
});

test("private role assignment before countdown keeps the role and original deadlines", () => {
  const store = useManhuntGameStore.getState();
  store.reset();
  store.setSession(session("session-order"), []);
  store.setOwnTeam("session-order", "player-1", "hunter");
  store.setCountdown(countdown("session-order"), Date.now());

  const state = useManhuntGameStore.getState();
  assert.equal(state.ownTeam, "hunter");
  assert.equal(getManhuntRoleRoute(state.ownTeam), "/manhunt/countdown");
  assert.equal(state.countdown?.endsAt, countdownEndsAt);
  assert.equal(state.countdown?.runnerHeadStartEndsAt, runnerHeadStartEndsAt);
  store.reset();
});

test("official active state clears countdown display data", () => {
  const store = useManhuntGameStore.getState();
  store.reset();
  store.setSession(session("session-1"), []);
  store.setCountdown(countdown("session-1"), 1_767_225_590_000);
  const updatedAt = "2026-01-01T00:00:10.000Z";
  const receivedAt = Date.parse(updatedAt) - 2_500;
  store.setGameState({
    roomCode: "ABCD",
    sessionId: "session-1",
    updatedAt,
    state: session("session-1", "active").state,
  }, receivedAt);

  assert.equal(useManhuntGameStore.getState().gameState.phase, "active");
  assert.equal(useManhuntGameStore.getState().countdown, null);
  assert.equal(useManhuntGameStore.getState().countdownServerOffsetMs, null);
  assert.equal(useManhuntGameStore.getState().serverTimeOffsetMs, 2_500);
  store.reset();
});