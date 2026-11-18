import assert from "node:assert/strict";
import test from "node:test";
import { useManhuntGameStore } from "../src/store/manhunt-game-store.ts";

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
    teams: [{ playerId: "player-1", team: "hunter" }],
    readyPlayerIds: [],
    ...(phase === "countdown"
      ? { countdownEndsAt: "2026-01-01T00:00:10.000Z" }
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
    remainingSeconds: 10,
    endsAt: "2026-01-01T00:00:10.000Z",
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

test("official active state clears countdown display data", () => {
  const store = useManhuntGameStore.getState();
  store.reset();
  store.setSession(session("session-1"), []);
  store.setCountdown(countdown("session-1"), 1_767_225_590_000);
  store.setGameState({
    roomCode: "ABCD",
    sessionId: "session-1",
    updatedAt: "2026-01-01T00:00:10.000Z",
    state: session("session-1", "active").state,
  });

  assert.equal(useManhuntGameStore.getState().gameState.phase, "active");
  assert.equal(useManhuntGameStore.getState().countdown, null);
  store.reset();
});