import assert from "node:assert/strict";
import test from "node:test";
import { MANHUNT_EVENTS } from "@impostor/api";
import {
  getVisibleMissionAssignment,
  isMissionCircleVisible,
} from "../src/utils/manhunt-missions.ts";
import { subscribeToManhuntMissionEvents } from "../src/services/manhunt-mission-events.ts";
import { useManhuntGameStore } from "../src/store/manhunt-game-store.ts";
import { useRoomStore } from "../src/store/room-store.ts";

const roomCode = "ABCD";
const sessionId = "mission-session";
const playerId = "selected-runner";

class FakeSocket {
  listeners = new Map();

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event, payload) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

function activeSession() {
  return {
    id: sessionId,
    roomCode,
    status: "in_progress",
    gameMode: "manhunt",
    startedAt: "2026-01-01T00:00:00.000Z",
    state: {
      phase: "active",
      activeSince: "2026-01-01T00:00:00.000Z",
      settings: {
        hunterCount: 1,
        boundary: {
          center: { latitude: 0, longitude: 0 },
          radiusMeters: 500,
        },
      },
      readyPlayerIds: [],
    },
  };
}

function assignment(assignedPlayerId = playerId) {
  return {
    sessionId,
    playerId: assignedPlayerId,
    center: { latitude: 0, longitude: 0 },
    radiusMeters: 5,
    revealedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    status: "active",
  };
}

function reveal(outcome, visibleForMs = 5_000) {
  return {
    sessionId,
    outcome,
    locations: [
      {
        playerId: "revealed-player",
        coordinates: { latitude: 0, longitude: 0 },
        status: "active",
      },
    ],
    visibleUntil: new Date(Date.now() + visibleForMs).toISOString(),
  };
}

function setup(team = "runner") {
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().setSession(
    {
      code: roomCode,
      hostId: playerId,
      players: [],
      settings: { gameMode: "manhunt", maxPlayers: 8, isPrivate: false },
      gameStatus: "in_progress",
      currentGameId: sessionId,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    playerId,
  );
  const game = useManhuntGameStore.getState();
  game.setSession(activeSession(), []);
  game.setOwnTeam(sessionId, playerId, team);
  const receivedAt = Date.now();
  game.setGameState(
    {
      sessionId,
      roomCode,
      state: activeSession().state,
      updatedAt: new Date(receivedAt).toISOString(),
    },
    receivedAt,
  );
  const socket = new FakeSocket();
  const subscription = subscribeToManhuntMissionEvents(socket);
  return { socket, subscription };
}

function cleanup(subscription) {
  subscription.dispose();
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
}

test("only the selected Runner accepts and displays a private assignment", () => {
  const { socket, subscription } = setup();
  const ownAssignment = assignment();
  socket.emit(MANHUNT_EVENTS.MISSION_ASSIGNMENT, assignment("other-runner"));
  assert.equal(useManhuntGameStore.getState().missionAssignment, null);

  socket.emit(MANHUNT_EVENTS.MISSION_ASSIGNMENT, ownAssignment);
  const game = useManhuntGameStore.getState();
  assert.deepEqual(game.missionAssignment, ownAssignment);
  assert.deepEqual(
    getVisibleMissionAssignment(
      game.ownTeam,
      game.ownPlayerId,
      game.missionAssignment,
    ),
    ownAssignment,
  );
  assert.equal(
    getVisibleMissionAssignment("hunter", playerId, ownAssignment),
    null,
  );
  assert.equal(
    isMissionCircleVisible(ownAssignment, Date.now()),
    true,
  );
  cleanup(subscription);
});

test("mission reveals are team-authorized and expire; reconnect replays private state", (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout"],
    now: Date.parse("2026-01-01T00:00:00.000Z"),
  });
  const { socket, subscription } = setup();
  const activeAssignment = assignment();
  const successReveal = reveal("success", 40);
  socket.emit(MANHUNT_EVENTS.MISSION_ASSIGNMENT, activeAssignment);
  socket.emit(MANHUNT_EVENTS.MISSION_REVEAL, successReveal);
  assert.deepEqual(
    useManhuntGameStore.getState().missionReveal,
    successReveal,
  );

  useManhuntGameStore
    .getState()
    .setSession(activeSession(), []);
  useManhuntGameStore
    .getState()
    .setOwnTeam(sessionId, playerId, "runner");
  socket.emit(MANHUNT_EVENTS.MISSION_ASSIGNMENT, activeAssignment);
  socket.emit(MANHUNT_EVENTS.MISSION_REVEAL, successReveal);
  assert.deepEqual(
    useManhuntGameStore.getState().missionAssignment,
    activeAssignment,
  );
  assert.deepEqual(
    useManhuntGameStore.getState().missionReveal,
    successReveal,
  );

  useManhuntGameStore.getState().setOwnTeam(
    sessionId,
    "hunter-player",
    "hunter",
  );
  socket.emit(MANHUNT_EVENTS.MISSION_REVEAL, successReveal);
  assert.equal(useManhuntGameStore.getState().missionReveal, null);
  const failureReveal = reveal("failure", 40);
  socket.emit(MANHUNT_EVENTS.MISSION_REVEAL, failureReveal);
  assert.deepEqual(
    useManhuntGameStore.getState().missionReveal,
    failureReveal,
  );

  t.mock.timers.tick(39);
  assert.deepEqual(
    useManhuntGameStore.getState().missionReveal,
    failureReveal,
  );
  t.mock.timers.tick(1);
  assert.equal(useManhuntGameStore.getState().missionReveal, null);
  cleanup(subscription);
  t.mock.timers.reset();
});

test("mission reveals stay visible until the server deadline when the device clock is ahead", (t) => {
  const deviceNow = Date.parse("2026-01-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: deviceNow });
  const { socket, subscription } = setup();
  useManhuntGameStore.getState().setGameState(
    {
      sessionId,
      roomCode,
      state: activeSession().state,
      updatedAt: new Date(deviceNow - 10_000).toISOString(),
    },
    deviceNow,
  );
  const revealPayload = reveal("success", -5_000);

  socket.emit(MANHUNT_EVENTS.MISSION_REVEAL, revealPayload);
  assert.deepEqual(
    useManhuntGameStore.getState().missionReveal,
    revealPayload,
  );
  t.mock.timers.tick(4_999);
  assert.deepEqual(
    useManhuntGameStore.getState().missionReveal,
    revealPayload,
  );
  t.mock.timers.tick(1);
  assert.equal(useManhuntGameStore.getState().missionReveal, null);

  cleanup(subscription);
  t.mock.timers.reset();
});

test("mission reveals expire at server time when the device clock is behind", (t) => {
  const deviceNow = Date.parse("2026-01-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: deviceNow });
  const { socket, subscription } = setup();
  useManhuntGameStore.getState().setGameState(
    {
      sessionId,
      roomCode,
      state: activeSession().state,
      updatedAt: new Date(deviceNow + 10_000).toISOString(),
    },
    deviceNow,
  );
  const revealPayload = reveal("success", 15_000);

  socket.emit(MANHUNT_EVENTS.MISSION_REVEAL, revealPayload);
  assert.deepEqual(
    useManhuntGameStore.getState().missionReveal,
    revealPayload,
  );
  t.mock.timers.tick(4_999);
  assert.deepEqual(
    useManhuntGameStore.getState().missionReveal,
    revealPayload,
  );
  t.mock.timers.tick(1);
  assert.equal(useManhuntGameStore.getState().missionReveal, null);

  cleanup(subscription);
  t.mock.timers.reset();
});

test("already-expired mission reveals are ignored and timers are replaced and disposed", (t) => {
  const deviceNow = Date.parse("2026-01-01T00:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: deviceNow });
  const { socket, subscription } = setup();
  useManhuntGameStore.getState().setGameState(
    {
      sessionId,
      roomCode,
      state: activeSession().state,
      updatedAt: new Date(deviceNow + 10_000).toISOString(),
    },
    deviceNow,
  );

  socket.emit(MANHUNT_EVENTS.MISSION_REVEAL, reveal("success", 5_000));
  assert.equal(useManhuntGameStore.getState().missionReveal, null);

  const firstReveal = reveal("success", 5_000);
  socket.emit(
    MANHUNT_EVENTS.MISSION_REVEAL,
    { ...firstReveal, visibleUntil: new Date(deviceNow + 15_000).toISOString() },
  );
  const replacement = reveal("success", 20_000);
  socket.emit(MANHUNT_EVENTS.MISSION_REVEAL, replacement);
  assert.deepEqual(useManhuntGameStore.getState().missionReveal, replacement);

  t.mock.timers.tick(5_000);
  assert.deepEqual(useManhuntGameStore.getState().missionReveal, replacement);
  subscription.dispose();
  t.mock.timers.tick(15_000);
  assert.deepEqual(useManhuntGameStore.getState().missionReveal, replacement);

  cleanup(subscription);
  t.mock.timers.reset();
});

test("mission socket listeners are removed on disposal", () => {
  const { socket, subscription } = setup();
  socket.emit(MANHUNT_EVENTS.MISSION_ASSIGNMENT, assignment());
  socket.emit(MANHUNT_EVENTS.MISSION_REVEAL, reveal("success"));
  assert.equal(
    socket.listeners.get(MANHUNT_EVENTS.MISSION_ASSIGNMENT)?.size,
    1,
  );
  assert.equal(
    socket.listeners.get(MANHUNT_EVENTS.MISSION_REVEAL)?.size,
    1,
  );
  useManhuntGameStore.getState().setResult({
    result: {
      gameId: sessionId,
      roomCode,
      gameMode: "manhunt",
      outcome: "win",
      winnerPlayerIds: [playerId],
      endedAt: new Date().toISOString(),
    },
  });
  assert.equal(useManhuntGameStore.getState().missionAssignment, null);
  assert.equal(useManhuntGameStore.getState().missionReveal, null);
  cleanup(subscription);
  assert.equal(
    socket.listeners.get(MANHUNT_EVENTS.MISSION_ASSIGNMENT)?.size,
    0,
  );
  assert.equal(
    socket.listeners.get(MANHUNT_EVENTS.MISSION_REVEAL)?.size,
    0,
  );
});
