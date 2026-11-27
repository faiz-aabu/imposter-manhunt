import assert from "node:assert/strict";
import test from "node:test";
import {
  GAME_EVENTS,
  MANHUNT_EVENTS,
} from "@impostor/api";
import {
  registerGameReconnectListener,
  registerManhuntGameEventListeners,
} from "../src/hooks/manhunt-game-event-listeners.ts";
import { useManhuntGameStore } from "../src/store/manhunt-game-store.ts";
import { useRoomStore } from "../src/store/room-store.ts";

const startedAt = "2026-01-01T00:00:00.000Z";
const runnerHeadStartEndsAt = "2026-01-01T00:00:40.000Z";
const hunterReleaseAt = "2026-01-01T00:00:50.000Z";
const sessionId = "session-countdown-events";
const roomCode = "ABCD";
const playerId = "player-runner";

class FakeSocket {
  listeners = new Map();

  on(event, handler) {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  emit(event, payload) {
    for (const handler of this.listeners.get(event) ?? []) {
      handler(payload);
    }
  }
}

function createSession() {
  return {
    id: sessionId,
    roomCode,
    status: "starting",
    gameMode: "manhunt",
    startedAt,
    state: {
      phase: "countdown",
      settings: {
        hunterCount: 1,
      },
      readyPlayerIds: [],
      runnerHeadStartEndsAt,
      countdownEndsAt: hunterReleaseAt,
    },
  };
}

function createCountdown() {
  return {
    roomCode,
    sessionId,
    remainingSeconds: 50,
    endsAt: hunterReleaseAt,
    runnerHeadStartEndsAt,
    serverNow: startedAt,
  };
}

function createStateUpdate() {
  return {
    sessionId,
    roomCode,
    updatedAt: startedAt,
    state: createSession().state,
  };
}

function activateGame(socket, team = "runner") {
  startCountdown(socket);
  socket.emit(MANHUNT_EVENTS.TEAM_ASSIGNMENT, {
    sessionId,
    playerId,
    team,
  });
  socket.emit(GAME_EVENTS.STATE_UPDATE, {
    sessionId,
    roomCode,
    updatedAt: startedAt,
    state: { ...createSession().state, phase: "active" },
  });
}

function createFreezeWarning(overrides = {}) {
  return {
    roomCode,
    sessionId,
    playerId,
    requestId: "00000000-0000-4000-8000-000000000001",
    warningStartedAt: "2026-01-01T00:00:00.000Z",
    warningEndsAt: "2026-01-01T00:00:03.000Z",
    ...overrides,
  };
}

function createFrozen(overrides = {}) {
  return {
    roomCode,
    sessionId,
    playerId,
    requestId: "00000000-0000-4000-8000-000000000001",
    frozenAt: "2026-01-01T00:00:03.000Z",
    frozenUntil: "2026-01-01T00:00:10.000Z",
    ...overrides,
  };
}

function createFreezeEnded(overrides = {}) {
  return {
    roomCode,
    sessionId,
    playerId,
    requestId: "00000000-0000-4000-8000-000000000001",
    endedAt: "2026-01-01T00:00:10.000Z",
    ...overrides,
  };
}

function createFootstepsState(overrides = {}) {
  return {
    roomCode,
    sessionId,
    playerId,
    remainingUses: 2,
    serverNow: "2026-01-01T00:00:00.000Z",
    guidances: [
      {
        requestId: "00000000-0000-4000-8000-000000000003",
        bearingDegrees: 90,
        startedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:00:03.000Z",
      },
    ],
    ...overrides,
  };
}

function createSmokeBombState(overrides = {}) {
  return {
    roomCode,
    sessionId,
    playerId,
    remainingUses: 2,
    serverNow: startedAt,
    activeEffects: [
      {
        requestId: "00000000-0000-4000-8000-000000000401",
        startedAt,
        expiresAt: "2026-01-01T00:00:10.000Z",
      },
    ],
    ...overrides,
  };
}

function createGhostState(overrides = {}) {
  return {
    roomCode,
    sessionId,
    playerId,
    usageLimit: 2,
    remainingUses: 1,
    serverNow: startedAt,
    activeEffects: [
      {
        requestId: "00000000-0000-4000-8000-000000000601",
        startedAt,
        expiresAt: "2026-01-01T00:00:15.000Z",
      },
    ],
    ...overrides,
  };
}

function setupListeners() {
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
  useRoomStore.getState().setSession(
    {
      code: roomCode,
      players: [
        {
          id: playerId,
          nickname: "Runner",
          status: "waiting",
          connectionStatus: "connected",
        },
      ],
    },
    playerId,
  );
  const socket = new FakeSocket();
  const routes = [];
  const synchronized = [];
  const unsubscribe = registerManhuntGameEventListeners(socket, {
    router: { replace: (route) => routes.push(route) },
    getRoom: () => useRoomStore.getState().room,
    getPlayerId: () => useRoomStore.getState().playerId,
    synchronizeCountdown: (payload) => {
      synchronized.push(payload);
      useManhuntGameStore
        .getState()
        .setCountdown(payload, Date.parse(payload.serverNow));
    },
    announceHuntStarted: () => {},
    onSessionStarted: () => {},
    onCountdownEnded: () => {},
  });
  return { socket, routes, synchronized, unsubscribe };
}

function startCountdown(socket) {
  socket.emit(GAME_EVENTS.GAME_STARTED, { session: createSession() });
  socket.emit(GAME_EVENTS.STATE_UPDATE, createStateUpdate());
}

function assertOriginalDeadlines() {
  const state = useManhuntGameStore.getState();
  assert.equal(state.gameState.countdownEndsAt, hunterReleaseAt);
  assert.equal(state.gameState.runnerHeadStartEndsAt, runnerHeadStartEndsAt);
  assert.equal(state.countdown.endsAt, hunterReleaseAt);
  assert.equal(state.countdown.runnerHeadStartEndsAt, runnerHeadStartEndsAt);
}

test("boundary updates populate the room store independently of game state", () => {
  const { socket, unsubscribe } = setupListeners();
  const room = useRoomStore.getState().room;
  useRoomStore.getState().clearSession();
  assert.equal(useRoomStore.getState().manhuntBoundary, null);

  const boundary = {
    center: { latitude: 0, longitude: 0 },
    radiusMeters: 500,
  };
  socket.emit(MANHUNT_EVENTS.BOUNDARY_UPDATE, { roomCode, boundary });

  assert.deepEqual(useRoomStore.getState().manhuntBoundary, boundary);
  assert.equal(useRoomStore.getState().manhuntBoundaryRoomCode, roomCode);
  useRoomStore.getState().setSession(room, playerId);
  socket.emit(GAME_EVENTS.GAME_STARTED, { session: createSession() });
  assert.equal(
    "boundary" in useManhuntGameStore.getState().session.state.settings,
    false,
  );

  unsubscribe();
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
});

test("fake Socket.IO listener handles countdown before private team assignment", () => {
  const { socket, routes, synchronized, unsubscribe } = setupListeners();
  startCountdown(socket);

  socket.emit(MANHUNT_EVENTS.COUNTDOWN, createCountdown());
  assert.equal(synchronized.length, 1);
  assert.equal(useManhuntGameStore.getState().ownTeam, null);
  assertOriginalDeadlines();

  socket.emit(MANHUNT_EVENTS.TEAM_ASSIGNMENT, {
    sessionId,
    playerId: "another-player",
    team: "hunter",
  });
  assert.equal(useManhuntGameStore.getState().ownTeam, null);

  socket.emit(MANHUNT_EVENTS.TEAM_ASSIGNMENT, {
    sessionId,
    playerId,
    team: "runner",
  });
  assert.equal(useManhuntGameStore.getState().ownTeam, "runner");
  assert.equal(routes.at(-1), "/manhunt/map");
  assertOriginalDeadlines();

  unsubscribe();
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
});

test("fake Socket.IO listener handles private team assignment first and reconnect replay", () => {
  const { socket, routes, synchronized, unsubscribe } = setupListeners();
  startCountdown(socket);
  socket.emit(MANHUNT_EVENTS.TEAM_ASSIGNMENT, {
    sessionId,
    playerId,
    team: "hunter",
  });
  assert.equal(useManhuntGameStore.getState().ownTeam, "hunter");
  assert.equal(routes.at(-1), "/manhunt/countdown");

  socket.emit(MANHUNT_EVENTS.COUNTDOWN, createCountdown());
  assert.equal(synchronized.length, 1);
  assertOriginalDeadlines();

  socket.emit(GAME_EVENTS.GAME_STARTED, { session: createSession() });
  socket.emit(GAME_EVENTS.STATE_UPDATE, createStateUpdate());
  assert.equal(useManhuntGameStore.getState().ownTeam, null);
  socket.emit(MANHUNT_EVENTS.TEAM_ASSIGNMENT, {
    sessionId,
    playerId,
    team: "hunter",
  });
  socket.emit(MANHUNT_EVENTS.COUNTDOWN, createCountdown());

  assert.equal(synchronized.length, 2);
  assert.equal(useManhuntGameStore.getState().ownTeam, "hunter");
  assertOriginalDeadlines();
  assert.equal(routes.at(-1), "/manhunt/countdown");

  unsubscribe();
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
});

test("fake Socket.IO connect listener restores a disconnected Manhunt room", () => {
  const { socket, unsubscribe } = setupListeners();
  startCountdown(socket);
  let disconnected = true;
  const restoredRooms = [];
  const unsubscribeReconnect = registerGameReconnectListener(socket, {
    getManhuntRoomCode: () =>
      useManhuntGameStore.getState().session?.roomCode ?? null,
    getOtherGameRoomCode: () => null,
    isDisconnected: () => disconnected,
    markConnected: () => {
      disconnected = false;
    },
    currentRoute: () => "manhunt/countdown",
    restoreMembership: async (code) => {
      restoredRooms.push(code);
    },
  });

  socket.emit("connect");
  socket.emit("connect");
  assert.deepEqual(restoredRooms, [roomCode]);
  assert.equal(disconnected, false);

  unsubscribeReconnect();
  unsubscribe();
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
});

test("fake Socket.IO listeners show private Freeze warning and frozen state without extending duplicates", () => {
  const { socket, unsubscribe } = setupListeners();
  activateGame(socket);

  socket.emit(MANHUNT_EVENTS.FREEZE_WARNING, createFreezeWarning({
    playerId: "another-player",
  }));
  assert.equal(useManhuntGameStore.getState().freezeState, null);

  socket.emit(MANHUNT_EVENTS.FREEZE_WARNING, createFreezeWarning());
  assert.equal(useManhuntGameStore.getState().freezeState?.phase, "warning");

  socket.emit(MANHUNT_EVENTS.FREEZE_WARNING, createFreezeWarning({
    warningEndsAt: "2026-01-01T00:00:13.000Z",
  }));
  assert.equal(
    useManhuntGameStore.getState().freezeState.payload.warningEndsAt,
    "2026-01-01T00:00:03.000Z",
  );

  socket.emit(MANHUNT_EVENTS.PLAYER_FROZEN, createFrozen());
  assert.equal(useManhuntGameStore.getState().freezeState?.phase, "frozen");
  socket.emit(MANHUNT_EVENTS.PLAYER_FROZEN, createFrozen({
    frozenUntil: "2026-01-01T00:00:20.000Z",
  }));
  assert.equal(
    useManhuntGameStore.getState().freezeState.payload.frozenUntil,
    "2026-01-01T00:00:10.000Z",
  );

  socket.emit(MANHUNT_EVENTS.PLAYER_FREEZE_ENDED, createFreezeEnded({
    requestId: "00000000-0000-4000-8000-000000000002",
  }));
  assert.equal(useManhuntGameStore.getState().freezeState?.phase, "frozen");
  socket.emit(MANHUNT_EVENTS.PLAYER_FREEZE_ENDED, createFreezeEnded());
  assert.equal(useManhuntGameStore.getState().freezeState, null);
  socket.emit(MANHUNT_EVENTS.PLAYER_FROZEN, createFrozen());
  assert.equal(useManhuntGameStore.getState().freezeState, null);

  unsubscribe();
  socket.emit(MANHUNT_EVENTS.FREEZE_WARNING, createFreezeWarning());
  assert.equal(useManhuntGameStore.getState().freezeState, null);
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
});

test("Freeze state is not accepted for Hunters or after game end", () => {
  const { socket, unsubscribe } = setupListeners();
  activateGame(socket, "hunter");
  socket.emit(MANHUNT_EVENTS.FREEZE_WARNING, createFreezeWarning());
  assert.equal(useManhuntGameStore.getState().freezeState, null);

  activateGame(socket, "runner");
  socket.emit(MANHUNT_EVENTS.FREEZE_WARNING, createFreezeWarning());
  assert.equal(useManhuntGameStore.getState().freezeState?.phase, "warning");

  socket.emit(GAME_EVENTS.STATE_UPDATE, {
    sessionId,
    roomCode,
    updatedAt: startedAt,
    state: { ...createSession().state, phase: "finished" },
  });
  assert.equal(useManhuntGameStore.getState().freezeState, null);

  unsubscribe();
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
});

test("Footsteps state is private to the Hunter, bounded to three seconds, and cannot be extended", () => {
  const { socket, unsubscribe } = setupListeners();
  activateGame(socket, "hunter");

  socket.emit(
    MANHUNT_EVENTS.FOOTSTEPS_STATE,
    createFootstepsState({ playerId: "another-player" }),
  );
  assert.equal(useManhuntGameStore.getState().footstepsState, null);

  socket.emit(MANHUNT_EVENTS.FOOTSTEPS_STATE, createFootstepsState());
  assert.equal(
    useManhuntGameStore.getState().footstepsState?.remainingUses,
    2,
  );
  assert.equal(
    useManhuntGameStore.getState().footstepsState?.guidances[0]?.bearingDegrees,
    90,
  );

  socket.emit(
    MANHUNT_EVENTS.FOOTSTEPS_STATE,
    createFootstepsState({
      remainingUses: 1,
      guidances: [
        {
          ...createFootstepsState().guidances[0],
          expiresAt: "2026-01-01T00:00:13.000Z",
        },
      ],
      serverNow: "2026-01-01T00:00:01.000Z",
    }),
  );
  assert.equal(
    useManhuntGameStore.getState().footstepsState?.guidances[0]?.expiresAt,
    "2026-01-01T00:00:03.000Z",
  );

  socket.emit(
    MANHUNT_EVENTS.FOOTSTEPS_STATE,
    createFootstepsState({ coordinates: { latitude: 0, longitude: 0 } }),
  );
  assert.equal(
    "coordinates" in useManhuntGameStore.getState().footstepsState,
    false,
  );

  unsubscribe();
  socket.emit(MANHUNT_EVENTS.FOOTSTEPS_STATE, {
    ...createFootstepsState(),
    remainingUses: 1,
  });
  assert.equal(
    useManhuntGameStore.getState().footstepsState?.remainingUses,
    2,
  );

  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
});

test("Footsteps state is rejected for Hiders and cleared after game end", () => {
  const { socket, unsubscribe } = setupListeners();
  activateGame(socket, "runner");
  socket.emit(MANHUNT_EVENTS.FOOTSTEPS_STATE, createFootstepsState());
  assert.equal(useManhuntGameStore.getState().footstepsState, null);

  activateGame(socket, "hunter");
  socket.emit(MANHUNT_EVENTS.FOOTSTEPS_STATE, createFootstepsState());
  assert.ok(useManhuntGameStore.getState().footstepsState);
  socket.emit(GAME_EVENTS.STATE_UPDATE, {
    sessionId,
    roomCode,
    updatedAt: startedAt,
    state: { ...createSession().state, phase: "finished" },
  });
  assert.equal(useManhuntGameStore.getState().footstepsState, null);

  unsubscribe();
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
});

test("Smoke Bomb state is private to the Hider and cannot be extended by repeated events", () => {
  const { socket, unsubscribe } = setupListeners();
  activateGame(socket);

  socket.emit(
    MANHUNT_EVENTS.SMOKE_BOMB_STATE,
    createSmokeBombState({ playerId: "another-player" }),
  );
  assert.equal(useManhuntGameStore.getState().smokeBombState, null);

  socket.emit(
    MANHUNT_EVENTS.SMOKE_BOMB_STATE,
    createSmokeBombState(),
  );
  assert.equal(
    useManhuntGameStore.getState().smokeBombState?.remainingUses,
    2,
  );
  assert.equal(
    useManhuntGameStore.getState().smokeBombState?.activeEffects[0]?.expiresAt,
    "2026-01-01T00:00:10.000Z",
  );

  socket.emit(
    MANHUNT_EVENTS.SMOKE_BOMB_STATE,
    createSmokeBombState({
      remainingUses: 1,
      serverNow: "2026-01-01T00:00:01.000Z",
      activeEffects: [
        {
          ...createSmokeBombState().activeEffects[0],
          expiresAt: "2026-01-01T00:00:20.000Z",
        },
      ],
    }),
  );
  assert.equal(
    useManhuntGameStore.getState().smokeBombState?.activeEffects[0]?.expiresAt,
    "2026-01-01T00:00:10.000Z",
  );

  socket.emit(
    MANHUNT_EVENTS.SMOKE_BOMB_STATE,
    createSmokeBombState({ remainingUses: 3 }),
  );
  assert.equal(
    useManhuntGameStore.getState().smokeBombState?.remainingUses,
    2,
  );

  unsubscribe();
  socket.emit(
    MANHUNT_EVENTS.SMOKE_BOMB_STATE,
    createSmokeBombState({ remainingUses: 1 }),
  );
  assert.equal(
    useManhuntGameStore.getState().smokeBombState?.remainingUses,
    2,
  );
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
});

test("Smoke Bomb state is rejected for Hunters and cleared when the game ends", () => {
  const { socket, unsubscribe } = setupListeners();
  activateGame(socket, "hunter");
  socket.emit(MANHUNT_EVENTS.SMOKE_BOMB_STATE, createSmokeBombState());
  assert.equal(useManhuntGameStore.getState().smokeBombState, null);

  activateGame(socket, "runner");
  socket.emit(MANHUNT_EVENTS.SMOKE_BOMB_STATE, createSmokeBombState());
  assert.ok(useManhuntGameStore.getState().smokeBombState);
  socket.emit(GAME_EVENTS.STATE_UPDATE, {
    sessionId,
    roomCode,
    updatedAt: startedAt,
    state: { ...createSession().state, phase: "finished" },
  });
  assert.equal(useManhuntGameStore.getState().smokeBombState, null);

  unsubscribe();
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
});

test("Ghost state is private to the Hider and cannot extend its deadline or uses", () => {
  const { socket, unsubscribe } = setupListeners();
  activateGame(socket);

  socket.emit(
    MANHUNT_EVENTS.GHOST_STATE,
    createGhostState({ playerId: "another-player" }),
  );
  assert.equal(useManhuntGameStore.getState().ghostState, null);

  socket.emit(MANHUNT_EVENTS.GHOST_STATE, createGhostState());
  assert.equal(useManhuntGameStore.getState().ghostState?.usageLimit, 2);
  assert.equal(useManhuntGameStore.getState().ghostState?.remainingUses, 1);
  assert.equal(
    useManhuntGameStore.getState().ghostState?.activeEffects[0]?.expiresAt,
    "2026-01-01T00:00:15.000Z",
  );

  socket.emit(
    MANHUNT_EVENTS.GHOST_STATE,
    createGhostState({
      remainingUses: 2,
      serverNow: "2026-01-01T00:00:01.000Z",
    }),
  );
  assert.equal(useManhuntGameStore.getState().ghostState?.remainingUses, 1);

  socket.emit(
    MANHUNT_EVENTS.GHOST_STATE,
    createGhostState({
      remainingUses: 0,
      serverNow: "2026-01-01T00:00:01.000Z",
      activeEffects: [
        {
          ...createGhostState().activeEffects[0],
          startedAt: "2026-01-01T00:00:01.000Z",
          expiresAt: "2026-01-01T00:00:16.000Z",
        },
      ],
    }),
  );
  assert.equal(
    useManhuntGameStore.getState().ghostState?.activeEffects[0]?.expiresAt,
    "2026-01-01T00:00:15.000Z",
  );

  socket.emit(
    MANHUNT_EVENTS.GHOST_STATE,
    createGhostState({ coordinates: { latitude: 0, longitude: 0 } }),
  );
  assert.equal(
    "coordinates" in useManhuntGameStore.getState().ghostState,
    false,
  );

  unsubscribe();
  socket.emit(
    MANHUNT_EVENTS.GHOST_STATE,
    createGhostState({ remainingUses: 0 }),
  );
  assert.equal(useManhuntGameStore.getState().ghostState?.remainingUses, 1);
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
});

test("Ghost is unavailable when its limit is unset and state clears for Hunters and game end", () => {
  const { socket, unsubscribe } = setupListeners();
  activateGame(socket, "hunter");
  socket.emit(
    MANHUNT_EVENTS.GHOST_STATE,
    createGhostState({
      usageLimit: null,
      remainingUses: null,
      activeEffects: [],
    }),
  );
  assert.equal(useManhuntGameStore.getState().ghostState, null);

  activateGame(socket, "runner");
  socket.emit(
    MANHUNT_EVENTS.GHOST_STATE,
    createGhostState({
      usageLimit: null,
      remainingUses: null,
      activeEffects: [],
    }),
  );
  assert.equal(useManhuntGameStore.getState().ghostState?.usageLimit, null);
  assert.equal(useManhuntGameStore.getState().ghostState?.remainingUses, null);
  assert.deepEqual(useManhuntGameStore.getState().ghostState?.activeEffects, []);
  socket.emit(MANHUNT_EVENTS.GHOST_STATE, createGhostState());
  assert.equal(
    useManhuntGameStore.getState().ghostState?.usageLimit,
    null,
  );

  activateGame(socket, "runner");
  socket.emit(MANHUNT_EVENTS.GHOST_STATE, createGhostState());
  assert.ok(useManhuntGameStore.getState().ghostState);
  socket.emit(GAME_EVENTS.STATE_UPDATE, {
    sessionId,
    roomCode,
    updatedAt: startedAt,
    state: { ...createSession().state, phase: "finished" },
  });
  assert.equal(useManhuntGameStore.getState().ghostState, null);

  unsubscribe();
  useManhuntGameStore.getState().reset();
  useRoomStore.getState().clearSession();
});
