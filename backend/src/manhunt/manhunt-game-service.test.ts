import assert from "node:assert/strict";
import test from "node:test";
import type {
  CatchConfirmedPayload,
  CatchConfirmationRequestPayload,
  CatchRequestStatusPayload,
  CountdownPayload,
  GameStartedPayload,
  GameStateUpdatePayload,
  LocationFlashPayload,
  ManhuntProximityAlertPayload,
  ManhuntSettings,
  ManhuntCountdownCancelledPayload,
  PlayerCaughtPayload,
  RoomCode,
} from "@impostor/api";
import {
  MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS,
  MANHUNT_LOCATION_REVEAL_DURATION_SECONDS,
  MANHUNT_CATCH_DISTANCE_METERS,
  MANHUNT_CATCH_REQUEST_DURATION_SECONDS,
  MANHUNT_COUNTDOWN_DURATION_SECONDS,
  MANHUNT_LOCATION_MAX_AGE_SECONDS,
  MANHUNT_PROXIMITY_COOLDOWN_SECONDS,
} from "@impostor/api";
import { ManhuntGameService } from "./manhunt-game-service.js";
import type { ManhuntGameEvents } from "./manhunt-game-service.js";
import { RoomService } from "../rooms/room-service.js";
import { AppError } from "../utils/app-error.js";
import type { GameRuntime, GameTimer } from "../games/imposter/classic-game-service.js";

interface ManualTimer {
  dueAt: number;
  callback: () => void;
}

class ManualRuntime implements GameRuntime {
  private currentTime = Date.parse("2025-01-01T00:00:00.000Z");
  private nextTimerId = 0;
  private timers = new Map<number, ManualTimer>();
  private cancelledCallbacks: Array<() => void> = [];
  now(): Date {
    return new Date(this.currentTime);
  }
  schedule(callback: () => void, delayMs: number): GameTimer {
    const timerId = this.nextTimerId++;
    this.timers.set(timerId, {
      dueAt: this.currentTime + delayMs,
      callback,
    });
    return {
      cancel: () => {
        const timer = this.timers.get(timerId);
        if (timer) {
          this.cancelledCallbacks.push(timer.callback);
        }
        this.timers.delete(timerId);
      },
    };
  }
  advance(delayMs: number): void {
    this.currentTime += delayMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.currentTime)
        .sort(([, first], [, second]) => first.dueAt - second.dueAt)[0];
      if (!next) return;
      const [timerId, timer] = next;
      this.timers.delete(timerId);
      timer.callback();
    }
  }
  get pendingTimerCount(): number {
    return this.timers.size;
  }
  runCancelledCallbacks(): void {
    const callbacks = this.cancelledCallbacks.splice(0);
    for (const callback of callbacks) callback();
  }
}

function createHarness(playerCount = 4, runtime = new ManualRuntime()) {
  const rooms = new RoomService();
  const started: GameStartedPayload[] = [];
  const states: GameStateUpdatePayload[] = [];
  const flashes: LocationFlashPayload[] = [];
  const caught: PlayerCaughtPayload[] = [];
  const catchRequests: Array<{
    playerId: string;
    payload: CatchConfirmationRequestPayload;
  }> = [];
  const catchStatuses: Array<{
    playerId: string;
    payload: CatchRequestStatusPayload;
  }> = [];
  const catchConfirmed: CatchConfirmedPayload[] = [];
  const proximityAlerts: Array<{
    playerId: string;
    payload: ManhuntProximityAlertPayload;
  }> = [];
  const countdowns: CountdownPayload[] = [];
  const countdownCancellations: ManhuntCountdownCancelledPayload[] = [];
  const ended: import("@impostor/api").GameEndedPayload[] = [];
  const events: ManhuntGameEvents = {
    gameStarted: (_roomCode, payload) => started.push(payload),
    roomUpdated: () => {},
    stateUpdated: (_roomCode, payload) => states.push(structuredClone(payload)),
    settingsUpdated: () => {},
    teamAssignment: () => {},
    readyUpdated: () => {},
    gameEnded: (_roomCode, payload) => ended.push(payload),
    countdownUpdated: (_roomCode, payload) => countdowns.push(payload),
    countdownCancelled: (_roomCode, payload) =>
      countdownCancellations.push(payload),
    locationFlashed: (_roomCode, payload) => flashes.push(payload),
    playerCaught: (_roomCode, payload) => caught.push(payload),
    catchConfirmationRequested: (_roomCode, playerId, payload) =>
      catchRequests.push({ playerId, payload }),
    catchRequestStatus: (_roomCode, playerId, payload) =>
      catchStatuses.push({ playerId, payload }),
    catchConfirmed: (_roomCode, payload) => catchConfirmed.push(payload),
    proximityAlert: (_roomCode, playerId, payload) =>
      proximityAlerts.push({ playerId, payload }),
  };
  const service = new ManhuntGameService(rooms, events, runtime);
  const host = rooms.createRoom(
    {
      nickname: "Host",
      settings: { gameMode: "manhunt", maxPlayers: 12, isPrivate: false },
    },
    "host",
  );
  const playerIds = [host.playerId];
  const reconnectTokens = [host.reconnectToken];
  for (let index = 1; index < playerCount; index += 1) {
    const joined = rooms.joinRoom(
      { roomCode: host.room.code, nickname: `Player ${index}` },
      `socket-${index}`,
    );
    playerIds.push(joined.playerId);
    reconnectTokens.push(joined.reconnectToken);
  }
  return {
    rooms,
    service,
    roomCode: host.room.code as RoomCode,
    hostSocket: "host",
    playerIds,
    reconnectTokens,
    started,
    states,
    flashes,
    caught,
    catchRequests,
    catchStatuses,
    catchConfirmed,
    proximityAlerts,
    countdowns,
    countdownCancellations,
    ended,
    runtime,
  };
}

function startActiveGame(harness: ReturnType<typeof createHarness>) {
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  return session;
}

const validSettings: ManhuntSettings = {
  hunterCount: 1,
  boundary: {
    center: { latitude: 51.5074, longitude: -0.1278 },
    radiusMeters: 500,
  },
};

function socketIdForPlayer(
  harness: ReturnType<typeof createHarness>,
  playerId: string,
): string {
  const index = harness.playerIds.indexOf(playerId);
  if (index < 0) {
    throw new Error("Player is not part of this test harness.");
  }
  return index === 0 ? "host" : `socket-${index}`;
}

function eastOffsetMeters(meters: number): number {
  return (meters / 6_371_000) * (180 / Math.PI);
}

test("Manhunt settings are host-only and invalid boundary settings are rejected", () => {
  const harness = createHarness();
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);

  assert.throws(
    () => harness.service.updateSettings(
      harness.roomCode,
      "socket-1",
      validSettings,
    ),
    (error: unknown) => error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );
  assert.throws(
    () => harness.service.updateSettings(
      harness.roomCode,
      harness.hostSocket,
      { ...validSettings, boundary: { center: { latitude: 91, longitude: 0 }, radiusMeters: 500 } },
    ),
    (error: unknown) => error instanceof AppError && error.code === "INVALID_PAYLOAD",
  );
  assert.throws(
    () => harness.service.updateSettings(
      harness.roomCode,
      harness.hostSocket,
      { ...validSettings, boundary: { center: { latitude: 0, longitude: 0 }, radiusMeters: 99 } },
    ),
    (error: unknown) => error instanceof AppError && error.code === "INVALID_PAYLOAD",
  );
  assert.equal(
    harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
      ...validSettings,
      boundary: { ...validSettings.boundary, radiusMeters: 1_000 },
    }).boundary.radiusMeters,
    1_000,
  );
  assert.throws(
    () => harness.service.updateSettings(
      harness.roomCode,
      harness.hostSocket,
      { ...validSettings, boundary: { ...validSettings.boundary, radiusMeters: 1_001 } },
    ),
    (error: unknown) => error instanceof AppError && error.code === "INVALID_PAYLOAD",
  );
});

test("Manhunt start requires authorization, enough players, and assigns exactly hunterCount hunters", () => {
  const harness = createHarness();
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  assert.throws(
    () => harness.service.startGame(harness.roomCode, "socket-1"),
    (error: unknown) => error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );
  const session = harness.service.startGame(harness.roomCode, harness.hostSocket);
  assert.equal(session.gameMode, "manhunt");
  assert.equal(session.status, "starting");
  assert.equal(session.state.phase, "countdown");
  assert.equal(
    Date.parse(session.state.countdownEndsAt ?? "") -
      Date.parse(session.startedAt),
    MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000,
  );
  assert.equal(harness.started.length, 1);
  assert.equal(harness.countdowns.length, 1);
  assert.equal(harness.countdowns[0]?.endsAt, session.state.countdownEndsAt);
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
    "starting",
  );
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.players.every(
      (player) => player.status === "waiting",
    ),
    true,
  );
  const state = harness.states[0]?.state;
  assert.equal(state && "teams" in state ? state.teams.filter((entry) => entry.team === "hunter").length : -1, 1);

  const small = createHarness(1);
  small.service.updateSettings(small.roomCode, small.hostSocket, validSettings);
  assert.throws(
    () => small.service.startGame(small.roomCode, small.hostSocket),
    (error: unknown) => error instanceof AppError && error.code === "GAME_NOT_READY",
  );
});

test("gameplay location updates are rejected until countdown expires and remain private", () => {
  const harness = createHarness();
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = harness.service.startGame(harness.roomCode, harness.hostSocket);
  assert.throws(
    () =>
      harness.service.recordLocation(
        harness.roomCode,
        "host",
        { latitude: 51.6, longitude: -0.2 },
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  assert.equal(session.state.phase, "active");

  const ack = harness.service.recordLocation(
    harness.roomCode,
    "host",
    { latitude: 51.6, longitude: -0.2 },
    5,
  );
  assert.equal(typeof ack.recordedAt, "string");
  assert.equal("coordinates" in ack, false);
  assert.throws(
    () => harness.service.recordLocation(
      harness.roomCode,
      "host",
      { latitude: 91, longitude: 0 },
    ),
  );
  harness.service.clearSession(harness.roomCode);
  const publicRoom = harness.rooms.getPublicRoom(harness.roomCode);
  assert.equal(JSON.stringify(publicRoom).includes("51.6"), false);
  assert.equal(JSON.stringify(publicRoom).includes("-0.2"), false);
});

test("reconnect preserves the existing team assignment and session cleanup clears private state", () => {
  const harness = createHarness();
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  startActiveGame(harness);
  const before = harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!);
  harness.service.recordLocation(harness.roomCode, "host", validSettings.boundary.center);
  const after = harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!);
  assert.deepEqual(before?.state.state, after?.state.state);
  harness.service.onPlayerRemoved(harness.roomCode, false);
  assert.equal(harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!), undefined);
});

test("reconnecting during countdown restores its deadline and active state", () => {
  const harness = createHarness();
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = harness.service.startGame(harness.roomCode, harness.hostSocket);
  assert.equal(harness.runtime.pendingTimerCount, 1);
  harness.rooms.disconnectSocket("socket-1");
  harness.service.onPlayerDisconnected(harness.roomCode, harness.playerIds[1]!);
  harness.runtime.advance(4_250);
  harness.rooms.reconnect(
    {
      roomCode: harness.roomCode,
      playerId: harness.playerIds[1]!,
      reconnectToken: harness.reconnectTokens[1]!,
    },
    "socket-1-reconnected",
  );
  assert.equal(harness.runtime.pendingTimerCount, 1);

  const countdownSnapshot = harness.service.getResumeSnapshot(
    harness.roomCode,
    harness.playerIds[1]!,
  );
  assert.equal(countdownSnapshot?.state.state.phase, "countdown");
  assert.equal(countdownSnapshot?.countdown?.remainingSeconds, 6);
  assert.equal(
    countdownSnapshot?.countdown?.endsAt,
    session.state.countdownEndsAt,
  );
  const sync = harness.service.getCountdownSync(
    harness.roomCode,
    "socket-1-reconnected",
    session.id,
  );
  assert.equal(sync.endsAt, session.state.countdownEndsAt);
  assert.equal(sync.serverNow, harness.runtime.now().toISOString());

  harness.runtime.advance(5_750);
  const activeSnapshot = harness.service.getResumeSnapshot(
    harness.roomCode,
    harness.playerIds[1]!,
  );
  assert.equal(activeSnapshot?.state.state.phase, "active");
  assert.equal(activeSnapshot?.countdown, undefined);
  assert.throws(
    () =>
      harness.service.getCountdownSync(
        harness.roomCode,
        "socket-1-reconnected",
        session.id,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
});

test("host removal cancels countdown and stale timers cannot activate a newer game", () => {
  const harness = createHarness();
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const firstSession = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  harness.rooms.disconnectSocket(harness.hostSocket);
  harness.service.onPlayerDisconnected(harness.roomCode, harness.playerIds[0]!);
  const removal = harness.rooms.removeDisconnectedPlayer(
    harness.roomCode,
    harness.playerIds[0]!,
  );
  assert.ok(removal?.hostChanged);
  harness.service.onPlayerRemoved(harness.roomCode, true);
  assert.equal(harness.countdownCancellations[0]?.sessionId, firstSession.id);
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
    "waiting",
  );
  assert.equal(harness.runtime.pendingTimerCount, 0);

  const secondSession = harness.service.startGame(
    harness.roomCode,
    "socket-1",
  );
  harness.runtime.runCancelledCallbacks();
  assert.equal(secondSession.state.phase, "countdown");
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.currentGameId,
    secondSession.id,
  );
  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  assert.equal(secondSession.state.phase, "active");
  assert.equal(
    harness.states.filter((entry) => entry.state.phase === "active").length,
    1,
  );
});

test("game cleanup cancels a pending Manhunt countdown timer", () => {
  const harness = createHarness();
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  harness.service.startGame(harness.roomCode, harness.hostSocket);
  assert.equal(harness.runtime.pendingTimerCount, 1);
  harness.service.clearSession(harness.roomCode);
  assert.equal(harness.runtime.pendingTimerCount, 0);
  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  assert.equal(
    harness.states.some((entry) => entry.state.phase === "active"),
    false,
  );
});

test("reveal cycle opens at 20 seconds for five seconds and repeats", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  startActiveGame(harness);
  for (const [index, playerId] of harness.playerIds.entries()) {
    harness.service.recordLocation(
      harness.roomCode,
      index === 0 ? "host" : `socket-${index}`,
      { latitude: 51.5074 + index * 0.0001, longitude: -0.1278 },
    );
  }

  runtime.advance((MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS - 1) * 1_000);
  assert.equal(harness.flashes.length, 0);
  runtime.advance(1_000);
  assert.equal(harness.flashes.length, 1);
  assert.equal(harness.flashes[0]?.locations.length, 4);
  runtime.advance((MANHUNT_LOCATION_REVEAL_DURATION_SECONDS - 1) * 1_000);
  assert.equal(harness.flashes.length, 1);
  runtime.advance(1_000);
  assert.equal(harness.flashes.length, 1);
  runtime.advance(MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS * 1_000);
  assert.equal(harness.flashes.length, 2);

  harness.service.clearSession(harness.roomCode);
  runtime.advance(MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS * 1_000);
  assert.equal(harness.flashes.length, 2);
  assert.equal(runtime.pendingTimerCount, 0);
});


test("Manhunt warns before two progressive safe-zone shrinks and respects the 65m floor", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  const session = startActiveGame(harness);
  const activeSince = Date.parse(session.state.activeSince!);

  runtime.advance((10 * 60 - 21) * 1_000);
  let state = harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!)!.state.state;
  assert.equal(state.shrinkWarningEndsAt, undefined);

  runtime.advance(1_000);
  state = harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!)!.state.state;
  assert.equal(Date.parse(state.shrinkWarningEndsAt!), activeSince + 10 * 60 * 1_000);

  runtime.advance(20_000);
  state = harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!)!.state.state;
  assert.equal(state.zoneShrinkEndsAt !== undefined, true);

  runtime.advance(60_000);
  state = harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!)!.state.state;
  assert.equal(state.settings.boundary.radiusMeters, 425);
  assert.equal(Date.parse(state.nextShrinkAt!), activeSince + 20 * 60 * 1_000);

  runtime.advance((9 * 60 - 20) * 1_000);
  state = harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!)!.state.state;
  assert.equal(Date.parse(state.shrinkWarningEndsAt!), activeSince + 20 * 60 * 1_000);

  runtime.advance(20_000);
  runtime.advance(60_000);
  state = harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!)!.state.state;
  assert.equal(state.settings.boundary.radiusMeters, 319);
  assert.ok(state.settings.boundary.radiusMeters >= 65);
});

test("Manhunt timeout awards the win to remaining runners", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  const session = startActiveGame(harness);
  const runnerIds = session.state.teams
    .filter((assignment) => assignment.team === "runner")
    .map((assignment) => assignment.playerId);

  runtime.advance(30 * 60 * 1_000);
  assert.equal(harness.ended.length, 1);
  assert.deepEqual(harness.ended[0]?.result.winnerPlayerIds, runnerIds);
  assert.equal(harness.runtime.pendingTimerCount, 0);
});

test("catch requests accept exactly 1.5 metres and only mark caught after civilian acceptance", () => {
  const harness = createHarness(3);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = startActiveGame(harness);
  const hunter = session.state.teams.find((entry) => entry.team === "hunter")!;
  const runners = session.state.teams.filter((entry) => entry.team === "runner");
  const firstRunner = runners[0]!;

  for (const assignment of session.state.teams) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, assignment.playerId),
      assignment.playerId === hunter.playerId
        ? { latitude: 0, longitude: 0 }
        : {
            latitude: 0,
            longitude:
              assignment.playerId === firstRunner.playerId
                ? eastOffsetMeters(MANHUNT_CATCH_DISTANCE_METERS)
                : eastOffsetMeters(50),
          },
    );
  }

  const request = harness.service.attemptCatch(
    harness.roomCode,
    socketIdForPlayer(harness, hunter.playerId),
    firstRunner.playerId,
  );
  const firstRunnerNickname = harness.rooms
    .getPublicRoom(harness.roomCode)
    ?.players.find((player) => player.id === firstRunner.playerId)?.nickname;
  assert.equal(harness.catchRequests[0]?.playerId, firstRunner.playerId);
  assert.equal(harness.catchRequests[0]?.payload.requestId, request.requestId);
  assert.equal(harness.catchStatuses[0]?.payload.status, "pending");
  assert.equal(harness.caught.length, 0);
  assert.equal(harness.catchConfirmed.length, 0);
  assert.equal(
    harness.rooms
      .getPublicRoom(harness.roomCode)
      ?.players.find((player) => player.id === firstRunner.playerId)?.status,
    "active",
  );

  assert.throws(
    () =>
      harness.service.attemptCatch(
        harness.roomCode,
        socketIdForPlayer(harness, hunter.playerId),
        firstRunner.playerId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_READY",
  );
  assert.throws(
    () =>
      harness.service.respondToCatch(
        harness.roomCode,
        socketIdForPlayer(harness, runners[1]!.playerId),
        request.requestId,
        true,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );

  harness.service.respondToCatch(
    harness.roomCode,
    socketIdForPlayer(harness, firstRunner.playerId),
    request.requestId,
    true,
  );
  assert.equal(harness.caught.length, 1);
  assert.equal(harness.catchConfirmed.length, 1);
  assert.equal(harness.catchConfirmed[0]?.caughtNickname, firstRunnerNickname);
  assert.equal("coordinates" in harness.catchConfirmed[0]!, false);
  assert.equal(harness.catchConfirmed[0]?.requestId, request.requestId);
  assert.equal(harness.catchStatuses.at(-1)?.payload.status, "accepted");

  const secondRunner = runners[1]!;
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, secondRunner.playerId),
    { latitude: 0, longitude: eastOffsetMeters(1.4) },
  );
  const secondRequest = harness.service.attemptCatch(
    harness.roomCode,
    socketIdForPlayer(harness, hunter.playerId),
    secondRunner.playerId,
  );
  harness.service.respondToCatch(
    harness.roomCode,
    socketIdForPlayer(harness, secondRunner.playerId),
    secondRequest.requestId,
    true,
  );
  assert.equal(harness.catchConfirmed.length, 2);
  assert.equal(harness.ended.length, 1);
  assert.equal(harness.ended[0]?.result.outcome, "win");
  assert.equal(harness.runtime.pendingTimerCount, 0);
});

test("catch requests reject distant and stale locations, and only hunters may request", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = startActiveGame(harness);
  const hunter = session.state.teams.find((entry) => entry.team === "hunter")!;
  const runner = session.state.teams.find((entry) => entry.team === "runner")!;
  const hunterSocket = socketIdForPlayer(harness, hunter.playerId);
  const runnerSocket = socketIdForPlayer(harness, runner.playerId);

  assert.throws(
    () =>
      harness.service.attemptCatch(
        harness.roomCode,
        runnerSocket,
        hunter.playerId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );

  harness.service.recordLocation(harness.roomCode, hunterSocket, {
    latitude: 0,
    longitude: 0,
  });
  harness.service.recordLocation(harness.roomCode, runnerSocket, {
    latitude: 0,
    longitude: eastOffsetMeters(1.51),
  });
  assert.throws(
    () =>
      harness.service.attemptCatch(
        harness.roomCode,
        hunterSocket,
        runner.playerId,
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "INVALID_VOTE" &&
      /farther than 1.5 metres/.test(error.message),
  );
  assert.equal(harness.catchRequests.length, 0);

  harness.service.recordLocation(harness.roomCode, runnerSocket, {
    latitude: 0,
    longitude: eastOffsetMeters(1.5),
  });
  runtime.advance((MANHUNT_LOCATION_MAX_AGE_SECONDS + 1) * 1_000);
  assert.throws(
    () =>
      harness.service.attemptCatch(
        harness.roomCode,
        hunterSocket,
        runner.playerId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_READY",
  );
  assert.equal(harness.catchRequests.length, 0);
});

test("rejected and repeated catch responses never mark a player caught", () => {
  const harness = createHarness(3);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = startActiveGame(harness);
  const hunter = session.state.teams.find((entry) => entry.team === "hunter")!;
  const runner = session.state.teams.find((entry) => entry.team === "runner")!;
  for (const assignment of session.state.teams) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, assignment.playerId),
      { latitude: 0, longitude: 0 },
    );
  }
  const request = harness.service.attemptCatch(
    harness.roomCode,
    socketIdForPlayer(harness, hunter.playerId),
    runner.playerId,
  );

  harness.service.respondToCatch(
    harness.roomCode,
    socketIdForPlayer(harness, runner.playerId),
    request.requestId,
    false,
  );
  assert.equal(harness.caught.length, 0);
  assert.equal(harness.catchConfirmed.length, 0);
  assert.equal(
    harness.rooms
      .getPublicRoom(harness.roomCode)
      ?.players.find((player) => player.id === runner.playerId)?.status,
    "active",
  );
  assert.equal(harness.catchStatuses.at(-1)?.payload.status, "rejected");
  assert.throws(
    () =>
      harness.service.respondToCatch(
        harness.roomCode,
        socketIdForPlayer(harness, runner.playerId),
        request.requestId,
        true,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_READY",
  );
});

test("expired and disconnected catch requests are cancelled without a catch", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = startActiveGame(harness);
  const hunter = session.state.teams.find((entry) => entry.team === "hunter")!;
  const runner = session.state.teams.find((entry) => entry.team === "runner")!;
  for (const assignment of session.state.teams) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, assignment.playerId),
      { latitude: 0, longitude: 0 },
    );
  }

  const expiredRequest = harness.service.attemptCatch(
    harness.roomCode,
    socketIdForPlayer(harness, hunter.playerId),
    runner.playerId,
  );
  runtime.advance(MANHUNT_CATCH_REQUEST_DURATION_SECONDS * 1_000);
  assert.equal(harness.catchStatuses.at(-1)?.payload.status, "expired");
  assert.equal(harness.caught.length, 0);
  assert.equal(harness.catchConfirmed.length, 0);
  assert.throws(
    () =>
      harness.service.respondToCatch(
        harness.roomCode,
        socketIdForPlayer(harness, runner.playerId),
        expiredRequest.requestId,
        true,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_READY",
  );

  const liveRequest = harness.service.attemptCatch(
    harness.roomCode,
    socketIdForPlayer(harness, hunter.playerId),
    runner.playerId,
  );
  const hunterSocket = socketIdForPlayer(harness, hunter.playerId);
  harness.rooms.disconnectSocket(hunterSocket);
  harness.service.onPlayerDisconnected(harness.roomCode, hunter.playerId);
  assert.equal(harness.catchStatuses.at(-1)?.payload.status, "cancelled");
  assert.throws(
    () =>
      harness.service.respondToCatch(
        harness.roomCode,
        socketIdForPlayer(harness, runner.playerId),
        liveRequest.requestId,
        true,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_READY",
  );
  assert.equal(harness.caught.length, 0);
  assert.equal(harness.catchConfirmed.length, 0);
  harness.service.clearSession(harness.roomCode);
  assert.equal(runtime.pendingTimerCount, 0);
});

test("proximity alerts only target fresh opposite-team pairs at 10m and 5m thresholds", () => {
  const harness = createHarness(4);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    hunterCount: 2,
  });
  const session = startActiveGame(harness);
  const hunters = session.state.teams.filter((entry) => entry.team === "hunter");
  const runners = session.state.teams.filter((entry) => entry.team === "runner");
  const hunter = hunters[0]!;
  const runner = runners[0]!;
  const farRunner = runners[1]!;

  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, hunter.playerId),
    { latitude: 0, longitude: 0 },
  );
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, runner.playerId),
    { latitude: 0, longitude: eastOffsetMeters(11) },
  );
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, farRunner.playerId),
    { latitude: 0, longitude: eastOffsetMeters(50) },
  );
  assert.equal(harness.proximityAlerts.length, 0);

  const nearPosition = { latitude: 0, longitude: eastOffsetMeters(9) };
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, runner.playerId),
    nearPosition,
  );
  assert.deepEqual(
    harness.proximityAlerts.map(({ playerId, payload }) => [
      playerId,
      payload.level,
    ]).sort(([first], [second]) => first!.localeCompare(second!)),
    [[hunter.playerId, "near"], [runner.playerId, "near"]].sort(
      ([first], [second]) => first!.localeCompare(second!),
    ),
  );

  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, runner.playerId),
    { latitude: 0, longitude: eastOffsetMeters(8) },
  );
  assert.equal(harness.proximityAlerts.length, 2);

  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, runner.playerId),
    { latitude: 0, longitude: eastOffsetMeters(4) },
  );
  assert.equal(harness.proximityAlerts.length, 4);
  assert.deepEqual(
    harness.proximityAlerts.slice(2).map(({ payload }) => payload.level),
    ["very_near", "very_near"],
  );
  for (const alert of harness.proximityAlerts) {
    assert.deepEqual(Object.keys(alert.payload).sort(), [
      "level",
      "roomCode",
      "sessionId",
    ]);
  }
});

test("same-team pairs, stale positions and inactive players never trigger proximity alerts", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    hunterCount: 2,
  });
  const session = startActiveGame(harness);
  const hunters = session.state.teams.filter((entry) => entry.team === "hunter");
  const runners = session.state.teams.filter((entry) => entry.team === "runner");
  const positions = new Map([
    [hunters[0]!.playerId, { latitude: 0, longitude: 0 }],
    [hunters[1]!.playerId, { latitude: 0, longitude: eastOffsetMeters(1) }],
    [runners[0]!.playerId, { latitude: 0, longitude: eastOffsetMeters(100) }],
    [runners[1]!.playerId, { latitude: 0, longitude: eastOffsetMeters(101) }],
  ]);
  for (const assignment of session.state.teams) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, assignment.playerId),
      positions.get(assignment.playerId)!,
    );
  }
  assert.equal(harness.proximityAlerts.length, 0);

  runtime.advance((MANHUNT_LOCATION_MAX_AGE_SECONDS + 1) * 1_000);
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, runners[0]!.playerId),
    { latitude: 0, longitude: eastOffsetMeters(0.5) },
  );
  assert.equal(harness.proximityAlerts.length, 0);

  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, hunters[0]!.playerId),
    { latitude: 0, longitude: 0 },
  );
  assert.equal(harness.proximityAlerts.length, 2);
  assert.equal(
    harness.proximityAlerts.some(
      ({ playerId }) => playerId === runners[1]!.playerId,
    ),
    false,
  );

  const hunterSocket = socketIdForPlayer(harness, hunters[0]!.playerId);
  const runnerSocket = socketIdForPlayer(harness, runners[0]!.playerId);
  const request = harness.service.attemptCatch(
    harness.roomCode,
    hunterSocket,
    runners[0]!.playerId,
  );
  harness.service.respondToCatch(
    harness.roomCode,
    runnerSocket,
    request.requestId,
    true,
  );
  harness.service.recordLocation(
    harness.roomCode,
    hunterSocket,
    { latitude: 0, longitude: 0 },
  );
  assert.equal(harness.proximityAlerts.length, 2);
});

test("proximity threshold cooldown suppresses rapid re-entry alerts", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = startActiveGame(harness);
  const hunter = session.state.teams.find((entry) => entry.team === "hunter")!;
  const runner = session.state.teams.find((entry) => entry.team === "runner")!;
  const hunterSocket = socketIdForPlayer(harness, hunter.playerId);
  const runnerSocket = socketIdForPlayer(harness, runner.playerId);
  harness.service.recordLocation(harness.roomCode, hunterSocket, {
    latitude: 0,
    longitude: 0,
  });
  harness.service.recordLocation(harness.roomCode, runnerSocket, {
    latitude: 0,
    longitude: eastOffsetMeters(9),
  });
  assert.equal(harness.proximityAlerts.length, 2);

  harness.service.recordLocation(harness.roomCode, runnerSocket, {
    latitude: 0,
    longitude: eastOffsetMeters(11),
  });
  runtime.advance((MANHUNT_PROXIMITY_COOLDOWN_SECONDS - 1) * 1_000);
  harness.service.recordLocation(harness.roomCode, runnerSocket, {
    latitude: 0,
    longitude: eastOffsetMeters(9),
  });
  assert.equal(harness.proximityAlerts.length, 2);

  harness.service.recordLocation(harness.roomCode, runnerSocket, {
    latitude: 0,
    longitude: eastOffsetMeters(11),
  });
  runtime.advance(1_000);
  harness.service.recordLocation(harness.roomCode, runnerSocket, {
    latitude: 0,
    longitude: eastOffsetMeters(9),
  });
  assert.equal(harness.proximityAlerts.length, 4);
});

test("readiness is retained through setup and reconnect resume restores completed results", () => {
  const harness = createHarness(3);
  harness.service.setReady(harness.roomCode, "host", true);
  harness.service.setReady(harness.roomCode, "socket-1", true);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = startActiveGame(harness);
  assert.equal(session.state.readyPlayerIds.includes(harness.playerIds[0]), true);

  const hunter = session.state.teams.find((entry) => entry.team === "hunter")!;
  const runners = session.state.teams.filter((entry) => entry.team === "runner");
  for (const assignment of session.state.teams) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, assignment.playerId),
      assignment.team === "hunter"
        ? { latitude: 51.5074, longitude: -0.1278 }
        : { latitude: 51.5074, longitude: -0.1278 },
    );
  }
  const hunterSocket = socketIdForPlayer(harness, hunter.playerId);
  for (const runner of runners) {
    const request = harness.service.attemptCatch(
      harness.roomCode,
      hunterSocket,
      runner.playerId,
    );
    harness.service.respondToCatch(
      harness.roomCode,
      socketIdForPlayer(harness, runner.playerId),
      request.requestId,
      true,
    );
  }

  const snapshot = harness.service.getResumeSnapshot(
    harness.roomCode,
    harness.playerIds[0]!,
  );
  assert.equal(snapshot?.ended?.result.gameMode, "manhunt");
  assert.equal(snapshot?.state.state.phase, "finished");
});
