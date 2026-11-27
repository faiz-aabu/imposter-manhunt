import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearBoundaryAfterCountdownCancellation,
  clearBoundaryForHunterAssignment,
} from "../src/utils/manhunt-boundary-state.ts";

const cached = {
  roomCode: "TEST",
  boundary: {
    center: { latitude: 51.5074, longitude: -0.1278 },
    radiusMeters: 500,
  },
};

test("a Hunter assignment clears the local private boundary", () => {
  assert.deepEqual(
    clearBoundaryForHunterAssignment(cached, "TEST", "player-1", {
      sessionId: "session-1",
      playerId: "player-1",
      team: "hunter",
    }),
    { roomCode: "TEST", boundary: null },
  );
});

test("Hider assignments and assignments for other players preserve local state", () => {
  assert.equal(
    clearBoundaryForHunterAssignment(cached, "TEST", "player-1", {
      sessionId: "session-1",
      playerId: "player-1",
      team: "runner",
    }),
    cached,
  );
  assert.equal(
    clearBoundaryForHunterAssignment(cached, "TEST", "player-1", {
      sessionId: "session-1",
      playerId: "player-2",
      team: "hunter",
    }),
    cached,
  );
});

test("countdown cancellation clears only the matching room session boundary", () => {
  assert.deepEqual(
    clearBoundaryAfterCountdownCancellation(cached, "TEST", "session-1", {
      roomCode: "TEST",
      sessionId: "session-1",
      reason: "player_left",
    }),
    { roomCode: "TEST", boundary: null },
  );
  assert.equal(
    clearBoundaryAfterCountdownCancellation(cached, "TEST", "session-2", {
      roomCode: "TEST",
      sessionId: "session-1",
      reason: "player_left",
    }),
    cached,
  );
});
