import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  ManhuntMissionAssignmentPayload,
  ManhuntMissionRevealPayload,
  ManhuntCountdownCancelledPayload,
  ManhuntFreezeWarningPayload,
  ManhuntGameState,
  ManhuntBoundary,
  ManhuntBoundaryUpdatePayload,
  ManhuntTeamAssignmentPayload,
  PlayerCaughtPayload,
  PlayerFrozenPayload,
  PlayerFreezeEndedPayload,
  ManhuntFootstepsStatePayload,
  ManhuntSmokeBombStatePayload,
  ManhuntGhostStatePayload,
  ManhuntFreezeDecoyStatePayload,
  ManhuntFreezeDecoyUsageStatePayload,
  ManhuntLateGameClueStatePayload,
  ManhuntLateGameWarningStatePayload,
  GameSessionId,
  PlayerId,
  RoomCode,
} from "@impostor/api";
import {
  MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS,
  MANHUNT_LOCATION_REVEAL_DURATION_SECONDS,
  MANHUNT_CATCH_DISTANCE_METERS,
  MANHUNT_CATCH_REQUEST_DURATION_SECONDS,
  MANHUNT_COUNTDOWN_DURATION_SECONDS,
  MANHUNT_RUNNER_HEAD_START_SECONDS,
  MANHUNT_FREEZE_DURATION_SECONDS,
  MANHUNT_FREEZE_WARNING_SECONDS,
  MANHUNT_FOOTSTEPS_DURATION_SECONDS,
  MANHUNT_FOOTSTEPS_MAX_USES_PER_GAME,
  MANHUNT_SMOKE_BOMB_DURATION_SECONDS,
  MANHUNT_SMOKE_BOMB_MAX_USES_PER_GAME,
  MANHUNT_GHOST_DURATION_SECONDS,
  MANHUNT_FREEZE_DECOY_DURATION_SECONDS,
  MANHUNT_FREEZE_DECOY_MAX_USES_PER_GAME,
  MANHUNT_LOCATION_MAX_AGE_SECONDS,
  MANHUNT_PROXIMITY_COOLDOWN_SECONDS,
  MANHUNT_MISSION_CIRCLE_RADIUS_METERS,
  MANHUNT_MISSION_DEADLINE_SECONDS,
  MANHUNT_MISSION_DWELL_SECONDS,
  MANHUNT_MISSION_MAX_ACCURACY_METERS,
  MANHUNT_MISSION_MIN_DISTANCE_METERS,
} from "@impostor/api";
import { ManhuntGameService } from "./manhunt-game-service.js";
import type { ManhuntGameEvents } from "./manhunt-game-service.js";
import { RoomService } from "../rooms/room-service.js";
import { RoomPersistenceCoordinator } from "../rooms/room-persistence-coordinator.js";
import { RoomPersistenceCommands } from "../rooms/room-persistence-commands.js";
import type {
  CreatedRoomInfo,
  CreateRoomWithHostInput,
  JoinedRoomInfo,
  JoinRoomInput,
  TransitionRoomGameStatusInput,
  TransitionedRoomGameStatusInfo,
} from "../rooms/postgres-room-repository.js";
import { RoomRuntimeFencingError } from "../rooms/postgres-room-repository.js";
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
  scheduleCalls = 0;
  failScheduleOnCall?: number;
  failScheduleDelayMs?: number;
  onSchedule?: (delayMs: number) => void;
  now(): Date {
    return new Date(this.currentTime);
  }
  schedule(callback: () => void, delayMs: number): GameTimer {
    this.scheduleCalls += 1;
    this.onSchedule?.(delayMs);
    if (
      this.failScheduleOnCall === this.scheduleCalls
      || this.failScheduleDelayMs === delayMs
    ) {
      throw new Error("injected timer setup failure");
    }
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
  advance(delayMs: number, maxCallbacks = Number.POSITIVE_INFINITY): void {
    this.currentTime += delayMs;
    let callbackCount = 0;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.currentTime)
        .sort(([, first], [, second]) => first.dueAt - second.dueAt)[0];
      if (!next) return;
      const [timerId, timer] = next;
      this.timers.delete(timerId);
      timer.callback();
      callbackCount += 1;
      if (callbackCount >= maxCallbacks) {
        return;
      }
    }
  }
  get pendingTimerCount(): number {
    return this.timers.size;
  }
  hasPendingTimerDueIn(delayMs: number): boolean {
    return [...this.timers.values()].some(
      (timer) => timer.dueAt === this.currentTime + delayMs,
    );
  }
  runCancelledCallbacks(): void {
    const callbacks = this.cancelledCallbacks.splice(0);
    for (const callback of callbacks) callback();
  }
}

function createHarness(
  playerCount = 4,
  runtime = new ManualRuntime(),
  options: {
    missionRandomInt?: (min: number, max: number) => number;
    freezeRangeMeters?: number;
    ghostUsageLimit?: number;
    freezeDecoyRandomInt?: (min: number, max: number) => number;
    lateGameExposureDurations?: {
      clueDurationSeconds: number;
      warningDurationSeconds: number;
    };
    lateGameExposureRandomInt?: (min: number, max: number) => number;
    createPersistenceCommands?: (
      rooms: RoomService,
    ) => RoomPersistenceCommands;
  } = {},
) {
  const rooms = new RoomService();
  const persistenceCommands = options.createPersistenceCommands?.(rooms);
  const started: GameStartedPayload[] = [];
  const states: GameStateUpdatePayload[] = [];
  const flashes: Array<{
    playerId: string;
    payload: LocationFlashPayload;
  }> = [];
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
  const assignments: ManhuntTeamAssignmentPayload[] = [];
  const missionAssignments: Array<{
    playerId: string;
    payload: ManhuntMissionAssignmentPayload;
  }> = [];
  const missionReveals: Array<{
    playerIds: string[];
    payload: ManhuntMissionRevealPayload;
  }> = [];
  const freezeWarnings: Array<{
    playerId: string;
    payload: ManhuntFreezeWarningPayload;
  }> = [];
  const frozenPlayers: Array<{
    playerId: string;
    payload: PlayerFrozenPayload;
  }> = [];
  const freezeEnds: Array<{
    playerId: string;
    payload: PlayerFreezeEndedPayload;
  }> = [];
  const footstepsStates: Array<{
    playerId: string;
    payload: ManhuntFootstepsStatePayload;
  }> = [];
  const smokeBombStates: Array<{
    playerId: string;
    payload: ManhuntSmokeBombStatePayload;
  }> = [];
  const ghostStates: Array<{
    playerId: string;
    payload: ManhuntGhostStatePayload;
  }> = [];
  const freezeDecoyStates: Array<{
    playerId: string;
    payload: ManhuntFreezeDecoyStatePayload;
  }> = [];
  const freezeDecoyUsageStates: Array<{
    playerId: string;
    payload: ManhuntFreezeDecoyUsageStatePayload;
  }> = [];
  const lateGameClueStates: Array<{
    playerId: string;
    payload: ManhuntLateGameClueStatePayload;
  }> = [];
  const lateGameWarningStates: Array<{
    playerId: string;
    payload: ManhuntLateGameWarningStatePayload;
  }> = [];
  const timerEventOrder: string[] = [];
  const countdownCancellations: ManhuntCountdownCancelledPayload[] = [];
  const boundaryUpdates: ManhuntBoundaryUpdatePayload[] = [];
  const ended: import("@impostor/api").GameEndedPayload[] = [];
  const events: ManhuntGameEvents = {
    gameStarted: (_roomCode, payload) => started.push(payload),
    roomUpdated: () => {},
    stateUpdated: (_roomCode, payload) => states.push(structuredClone(payload)),
    settingsUpdated: () => {},
    boundaryUpdated: (_roomCode, payload) =>
      boundaryUpdates.push(structuredClone(payload)),
    teamAssignment: (_roomCode, _playerId, payload) =>
      assignments.push(payload),
    readyUpdated: () => {},
    gameEnded: (_roomCode, payload) => ended.push(payload),
    countdownUpdated: (_roomCode, payload) => countdowns.push(payload),
    countdownCancelled: (_roomCode, payload) =>
      countdownCancellations.push(payload),
    locationFlashed: (_roomCode, playerId, payload) =>
      flashes.push({ playerId, payload }),
    playerCaught: (_roomCode, payload) => caught.push(payload),
    catchConfirmationRequested: (_roomCode, playerId, payload) =>
      catchRequests.push({ playerId, payload }),
    catchRequestStatus: (_roomCode, playerId, payload) =>
      catchStatuses.push({ playerId, payload }),
    catchConfirmed: (_roomCode, payload) => catchConfirmed.push(payload),
    proximityAlert: (_roomCode, playerId, payload) =>
      proximityAlerts.push({ playerId, payload }),
    missionAssignment: (_roomCode, playerId, payload) => {
      missionAssignments.push({ playerId, payload });
      timerEventOrder.push("assignment");
    },
    missionReveal: (_roomCode, playerIds, payload) =>
      missionReveals.push({ playerIds, payload }),
    freezeWarning: (_roomCode, playerId, payload) =>
      freezeWarnings.push({ playerId, payload }),
    playerFrozen: (_roomCode, playerId, payload) =>
      frozenPlayers.push({ playerId, payload }),
    playerFreezeEnded: (_roomCode, playerId, payload) =>
      freezeEnds.push({ playerId, payload }),
    footstepsState: (_roomCode, playerId, payload) =>
      footstepsStates.push({ playerId, payload }),
    smokeBombState: (_roomCode, playerId, payload) =>
      smokeBombStates.push({ playerId, payload }),
    ghostState: (_roomCode, playerId, payload) =>
      ghostStates.push({ playerId, payload }),
    freezeDecoyState: (_roomCode, playerId, payload) =>
      freezeDecoyStates.push({
        playerId,
        payload: structuredClone(payload),
      }),
    freezeDecoyUsageState: (_roomCode, playerId, payload) =>
      freezeDecoyUsageStates.push({ playerId, payload }),
    lateGameClueState: (_roomCode, playerId, payload) =>
      lateGameClueStates.push({
        playerId,
        payload: structuredClone(payload),
      }),
    lateGameWarningState: (_roomCode, playerId, payload) =>
      lateGameWarningStates.push({
        playerId,
        payload: structuredClone(payload),
      }),
  };
  const service = new ManhuntGameService(
    rooms,
    events,
    runtime,
    options.missionRandomInt,
    options.freezeRangeMeters,
    options.ghostUsageLimit,
    options.freezeDecoyRandomInt,
    options.lateGameExposureDurations,
    options.lateGameExposureRandomInt,
    persistenceCommands,
  );
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
    assignments,
    missionAssignments,
    missionReveals,
    freezeWarnings,
    frozenPlayers,
    freezeEnds,
    footstepsStates,
    smokeBombStates,
    ghostStates,
    freezeDecoyStates,
    freezeDecoyUsageStates,
    lateGameClueStates,
    lateGameWarningStates,
    countdownCancellations,
    boundaryUpdates,
    ended,
    runtime,
    timerEventOrder,
  };
}

function createDurableManhuntFixture(
  activationError?: Error,
  cancellationError?: Error,
  cancellationUncertain = false,
  cancellationGate?: { entered: () => void; wait: Promise<void> },
  completionGate?: { entered: () => void; wait: Promise<void> },
) {
  const coordinator = new RoomPersistenceCoordinator();
  const transitions: TransitionRoomGameStatusInput[] = [];
  const timeoutRemovals: PlayerId[] = [];
  const runtime = new ManualRuntime();
  const database = {
    status: "waiting" as "waiting" | "starting" | "in_progress" | "finished",
    gameId: null as GameSessionId | null,
    version: 1n,
  };
  let commands!: RoomPersistenceCommands;
  const harness = createHarness(3, runtime, {
    createPersistenceCommands(rooms) {
      commands = new RoomPersistenceCommands(
        rooms,
        {
          async createRoomWithHost(
            _input: CreateRoomWithHostInput,
          ): Promise<CreatedRoomInfo> {
            throw new Error("Unexpected room creation.");
          },
          async joinRoom(_input: JoinRoomInput): Promise<JoinedRoomInfo> {
            throw new Error("Unexpected room join.");
          },
          async leaveRoom(input) {
            database.version += 1n;
            return {
              roomId: input.expectedRoomId!,
              roomCode: input.roomCode,
              playerId: input.playerId,
              deleted: false,
              hostChanged: false,
              lifecycleStatus: "active" as const,
              currentGameId: database.gameId,
              gameStatus: database.status,
              version: database.version.toString(),
            };
          },
          async markDisconnected(input) {
            database.version += 1n;
            return {
              roomId: input.expectedRoomId!,
              roomCode: input.roomCode,
              playerId: input.playerId,
              disconnectGeneration: "1",
              reconnectDeadlineAt: input.reconnectDeadlineAt,
              lifecycleStatus: "active" as const,
              currentGameId: database.gameId,
              gameStatus: database.status,
              version: database.version.toString(),
            };
          },
          async removeDisconnectedPlayer(input) {
            timeoutRemovals.push(input.playerId);
            assert.equal(input.expectedVersion, database.version.toString());
            database.version += 1n;
            return {
              status: "removed" as const,
              roomId: input.expectedRoomId!,
              roomCode: input.roomCode,
              playerId: input.playerId,
              deleted: false as const,
              lifecycleStatus: "active" as const,
              currentGameId: database.gameId,
              version: database.version.toString(),
            };
          },
          async transitionRoomGameStatus(input) {
            transitions.push(input);
            if (input.nextStatus === "waiting" && cancellationGate) {
              cancellationGate.entered();
              await cancellationGate.wait;
            }
            if (input.nextStatus === "finished" && completionGate) {
              completionGate.entered();
              await completionGate.wait;
            }
            if (
              input.nextStatus === "in_progress"
              && activationError
            ) {
              throw activationError;
            }
            if (
              input.nextStatus === "waiting"
              && cancellationError
              && !cancellationUncertain
            ) {
              throw cancellationError;
            }
            database.version += 1n;
            database.status = input.nextStatus;
            database.gameId = input.nextGameId;
            if (
              input.nextStatus === "waiting"
              && cancellationError
              && cancellationUncertain
            ) {
              throw cancellationError;
            }
            return {
              roomId: input.expectedRoomId,
              roomCode: input.roomCode,
              gameMode: "manhunt",
              gameStatus: database.status,
              lifecycleStatus: "active" as const,
              currentGameId: database.gameId,
              version: database.version.toString(),
            };
          },
        },
        coordinator,
      );
      return commands;
    },
  });
  coordinator.registerCreatedRoom({
    roomCode: harness.roomCode,
    roomId: randomUUID(),
    gameMode: "manhunt",
    hostPlayerId: harness.playerIds[0]!,
    lifecycleStatus: "active",
    currentGameId: null,
    version: "1",
  });
  harness.service.updateSettings(
    harness.roomCode,
    harness.hostSocket,
    validSettings,
  );
  harness.playerIds.forEach((_, index) =>
    harness.service.setReady(
      harness.roomCode,
      index === 0 ? harness.hostSocket : `socket-${index}`,
      true,
    ),
  );
  return {
    harness,
    commands,
    coordinator,
    transitions,
    timeoutRemovals,
    database,
  };
}

async function commitDurableManhuntStart(
  fixture: ReturnType<typeof createDurableManhuntFixture>,
): Promise<GameSessionId> {
  const { harness, commands } = fixture;
  const reservation = await commands.acquireGameStatusReservation(
    harness.roomCode,
    "waiting",
    null,
    harness.hostSocket,
  );
  try {
    const prepared = harness.service.prepareStart(
      harness.roomCode,
      harness.hostSocket,
    );
    await commands.transitionRoomGameStatus({
      roomCode: harness.roomCode,
      expectedStatus: "waiting",
      nextStatus: "starting",
      expectedCurrentGameId: null,
      nextGameId: prepared.gameId,
      initiatedBy: {
        kind: "host",
        playerId: reservation.hostPlayerId!,
      },
      reservation,
    });
    harness.service.commitPreparedStart(prepared, reservation);
    return prepared.gameId;
  } finally {
    harness.rooms.releaseGameStatusReservation(reservation);
  }
}

function disconnectManhuntPlayerForTimeout(
  harness: ReturnType<typeof createHarness>,
  playerIndex: number,
): { playerId: PlayerId; deadline: Date } {
  const playerId = harness.playerIds[playerIndex];
  const socketId = playerIndex === 0 ? harness.hostSocket : `socket-${playerIndex}`;
  assert.ok(playerId);
  const prepared = harness.rooms.prepareSocketDisconnect(socketId);
  assert.ok(prepared);
  const deadline = new Date(Date.parse("2025-01-01T00:01:00.000Z"));
  harness.rooms.commitPreparedSocketDisconnect(prepared, {
    disconnectGeneration: "1",
    reconnectDeadlineAt: deadline,
  });
  return { playerId, deadline };
}

function startActiveGame(harness: ReturnType<typeof createHarness>) {
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  return session;
}

function activateFreezeGame(
  harness: ReturnType<typeof createHarness>,
  runnerDistancesMeters = [20, 40, 80],
) {
  harness.service.updateSettings(
    harness.roomCode,
    harness.hostSocket,
    validSettings,
  );
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  const hunters = harness.assignments
    .filter(({ team }) => team === "hunter")
    .map(({ playerId }) => playerId);
  const runners = harness.assignments
    .filter(({ team }) => team === "runner")
    .map(({ playerId }) => playerId);
  const center = validSettings.boundary.center;
  for (const hunterId of hunters) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, hunterId),
      center,
      1,
    );
  }
  for (const [index, runnerId] of runners.entries()) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, runnerId),
      {
        latitude:
          center.latitude +
          eastOffsetMeters(runnerDistancesMeters[index] ?? 80),
        longitude: center.longitude,
      },
      1,
    );
  }
  return { session, hunters, runners, center };
}

function activateLateGame(
  harness: ReturnType<typeof createHarness>,
  gameDurationSeconds: 1_800 | 2_700 | 3_600 = 2_700,
  hunterCount = 2,
  boundary = validSettings.boundary,
) {
  const settings: ManhuntSettings = {
    ...validSettings,
    hunterCount,
    gameDurationSeconds,
    boundary,
  };
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, settings);
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  return {
    session,
    hunters: harness.assignments
      .filter(({ team }) => team === "hunter")
      .map(({ playerId }) => playerId),
    runners: harness.assignments
      .filter(({ team }) => team === "runner")
      .map(({ playerId }) => playerId),
    center: boundary.center,
  };
}

function recordLateGameLocations(
  harness: ReturnType<typeof createHarness>,
  playerIds: string[],
  distancesMeters = playerIds.map((_, index) => 20 + index * 10),
): void {
  playerIds.forEach((playerId, index) => {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, playerId),
      {
        latitude:
          validSettings.boundary.center.latitude +
          eastOffsetMeters(distancesMeters[index] ?? 20),
        longitude: validSettings.boundary.center.longitude,
      },
      1,
    );
  });
}

function disconnectHarnessPlayer(
  harness: ReturnType<typeof createHarness>,
  playerId: string,
): void {
  const disconnected = harness.rooms.disconnectSocket(
    socketIdForPlayer(harness, playerId),
  );
  assert.ok(disconnected);
  harness.service.onPlayerDisconnected(disconnected.roomCode, playerId);
}

function currentManhuntRecord(
  harness: ReturnType<typeof createHarness>,
): Record<string, unknown> {
  const games = Reflect.get(harness.service, "currentGames") as Map<
    string,
    Record<string, unknown>
  >;
  const game = games.get(harness.roomCode);
  assert.ok(game);
  return game;
}

function currentManhuntBoundary(
  harness: ReturnType<typeof createHarness>,
): ManhuntBoundary {
  return currentManhuntRecord(harness).boundary as ManhuntBoundary;
}

const validSettings: ManhuntSettings = {
  hunterCount: 1,
  boundary: {
    center: { latitude: 51.5074, longitude: -0.1278 },
    radiusMeters: 500,
  },
};

const TEST_ONLY_FREEZE_RANGE_METERS = 50;
const FREEZE_REQUEST_ONE = "00000000-0000-4000-8000-000000000001";
const FREEZE_REQUEST_TWO = "00000000-0000-4000-8000-000000000002";
const FOOTSTEPS_REQUESTS = [
  "00000000-0000-4000-8000-000000000201",
  "00000000-0000-4000-8000-000000000202",
  "00000000-0000-4000-8000-000000000203",
  "00000000-0000-4000-8000-000000000204",
];
const SMOKE_BOMB_REQUESTS = [
  "00000000-0000-4000-8000-000000000401",
  "00000000-0000-4000-8000-000000000402",
  "00000000-0000-4000-8000-000000000403",
  "00000000-0000-4000-8000-000000000404",
];
const GHOST_REQUESTS = [
  "00000000-0000-4000-8000-000000000601",
  "00000000-0000-4000-8000-000000000602",
  "00000000-0000-4000-8000-000000000603",
];
const TEST_ONLY_GHOST_USAGE_LIMIT = 2;
const TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS = {
  clueDurationSeconds: 15,
  warningDurationSeconds: 5,
};

function assertAppError(
  action: () => void,
  code: AppError["code"],
): void {
  assert.throws(action, (error: unknown) =>
    error instanceof AppError && error.code === code,
  );
}

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

function missionRandomForTest(
  assignmentCount = 2,
): (min: number, max: number) => number {
  let nextBearing = 0;
  return (min, max) => {
    if (min === 0 && max === 360_000) {
      const bearing = nextBearing;
      nextBearing = (nextBearing + 90_000) % 360_000;
      return bearing;
    }
    if (min === 2 && max === 4) {
      return assignmentCount;
    }
    return min;
  };
}

function activateMissionGame(harness: ReturnType<typeof createHarness>) {
  harness.service.updateSettings(
    harness.roomCode,
    harness.hostSocket,
    validSettings,
  );
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  const hiders = harness.assignments
    .filter(({ team }) => team === "runner")
    .map(({ playerId }) => playerId);
  const hunters = harness.assignments
    .filter(({ team }) => team === "hunter")
    .map(({ playerId }) => playerId);

  harness.runtime.advance(
    MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000 - 1_000,
  );
  for (const playerId of hiders) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, playerId),
      validSettings.boundary.center,
      1,
    );
  }
  harness.runtime.advance(1_000);
  return { session, hiders, hunters };
}

function recordMissionLocations(
  harness: ReturnType<typeof createHarness>,
  locations: ReadonlyMap<string, { latitude: number; longitude: number }>,
): void {
  for (const [playerId, coordinates] of locations) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, playerId),
      coordinates,
      1,
    );
  }
}

function getManhuntState(
  harness: ReturnType<typeof createHarness>,
  playerId: string,
): ManhuntGameState {
  const state = harness.service
    .getResumeSnapshot(harness.roomCode, playerId)?.state.state;
  assert.ok(state && "settings" in state);
  return state;
}

function removePlayer(
  harness: ReturnType<typeof createHarness>,
  playerId: string,
): void {
  const removal = harness.rooms.leaveRoom(
    harness.roomCode,
    socketIdForPlayer(harness, playerId),
  );
  harness.service.onPlayerRemoved(harness.roomCode, removal.room !== undefined);
}

function eastOffsetMeters(meters: number): number {
  return (meters / 6_371_000) * (180 / Math.PI);
}

function longitudeOffsetMeters(meters: number, latitude: number): number {
  return (
    (meters / (6_371_000 * Math.cos((latitude * Math.PI) / 180))) *
    (180 / Math.PI)
  );
}

function haversineMeters(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const latitudeDelta = secondLatitude - firstLatitude;
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(haversine));
}

test("suspension blocks Manhunt actions and queued countdown callbacks", () => {
  const harness = createHarness();
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  const scope = harness.rooms.getGameplaySuspensionScope(
    harness.roomCode,
    session.id,
  );
  assert.ok(scope);

  harness.rooms.suspendGameplay(
    harness.roomCode,
    scope,
    "durable_timeout_post_commit_side_effect_failure",
  );

  assert.throws(
    () => harness.service.setReady(harness.roomCode, harness.hostSocket, true),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  harness.runtime.runCancelledCallbacks();
  assert.equal(harness.runtime.pendingTimerCount, 0);
  assert.equal(harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!), undefined);
  assert.equal(harness.started.length, 1);
});

test("suspending one Manhunt room leaves another room's countdown and actions active", async () => {
  const harness = createHarness();
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const suspendedGame = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );

  const otherHost = harness.rooms.createRoom(
    {
      nickname: "Other host",
      settings: { gameMode: "manhunt", maxPlayers: 12, isPrivate: false },
    },
    "other-host",
  );
  for (let index = 1; index < 3; index += 1) {
    harness.rooms.joinRoom(
      { roomCode: otherHost.room.code, nickname: `Other ${index}` },
      `other-${index}`,
    );
  }
  harness.service.updateSettings(otherHost.room.code, "other-host", {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  harness.service.startGame(otherHost.room.code, "other-host");

  const scope = harness.rooms.getGameplaySuspensionScope(
    harness.roomCode,
    suspendedGame.id,
  );
  assert.ok(scope);
  harness.rooms.suspendGameplay(
    harness.roomCode,
    scope,
    "durable_timeout_post_commit_side_effect_failure",
  );
  harness.runtime.runCancelledCallbacks();
  assert.equal(harness.rooms.isGameplaySuspended(harness.roomCode), true);

  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const otherSnapshot = harness.service.getResumeSnapshot(
    otherHost.room.code,
    otherHost.playerId,
  );
  assert.equal(otherSnapshot?.state.state.phase, "active");
  harness.service.recordLocation(
    otherHost.room.code,
    "other-host",
    { latitude: 51.5074, longitude: -0.1278 },
  );
  harness.runtime.advance(1_800 * 1_000);
  assert.equal(harness.ended.length, 1);
  assert.equal(harness.rooms.getPublicRoom(otherHost.room.code)?.gameStatus, "finished");
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "starting");
});

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
  assert.equal(
    Date.parse(session.state.runnerHeadStartEndsAt ?? "") -
      Date.parse(session.startedAt),
    MANHUNT_RUNNER_HEAD_START_SECONDS * 1_000,
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
  assert.ok(state && "settings" in state && !("teams" in state));
  assert.equal(
    harness.assignments.filter((entry) => entry.team === "hunter").length,
    1,
  );

  const small = createHarness(1);
  small.service.updateSettings(small.roomCode, small.hostSocket, validSettings);
  assert.throws(
    () => small.service.startGame(small.roomCode, small.hostSocket),
    (error: unknown) => error instanceof AppError && error.code === "GAME_NOT_READY",
  );
});

test("Manhunt preparation retains readiness without publishing or scheduling", () => {
  const harness = createHarness(3);
  harness.service.updateSettings(
    harness.roomCode,
    harness.hostSocket,
    validSettings,
  );
  harness.service.setReady(harness.roomCode, harness.hostSocket, true);
  const reservation = harness.rooms.reserveGameStatusTransition(
    harness.roomCode,
    "waiting",
    null,
    harness.hostSocket,
  );

  try {
    const prepared = harness.service.prepareStart(
      harness.roomCode,
      harness.hostSocket,
    );
    assert.equal(Object.isFrozen(prepared), true);
    assert.equal(
      Reflect.set(prepared, "gameId", "mutated-game-id"),
      false,
    );
    assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "waiting");
    assert.equal(harness.started.length, 0);
    assert.equal(harness.assignments.length, 0);
    assert.equal(harness.countdowns.length, 0);
    assert.equal(harness.runtime.pendingTimerCount, 0);
    assert.throws(
      () => harness.service.setReady(harness.roomCode, harness.hostSocket, false),
      (error: unknown) =>
        error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
    );

    const started = harness.service.commitPreparedStart(prepared, reservation);
    assert.equal(started.id, prepared.gameId);
    assert.deepEqual(started.state.readyPlayerIds, [harness.playerIds[0]]);
    assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "starting");
    assert.equal(harness.started.length, 1);
    assert.equal(harness.assignments.length, 3);
    assert.equal(harness.countdowns.length, 1);
    assert.equal(harness.runtime.pendingTimerCount, 1);
  } finally {
    harness.rooms.releaseGameStatusReservation(reservation);
    harness.service.close(harness.roomCode);
  }
});

test("discarding a prepared Manhunt start removes its uncommitted plan", () => {
  const harness = createHarness(3);
  harness.service.updateSettings(
    harness.roomCode,
    harness.hostSocket,
    validSettings,
  );
  const prepared = harness.service.prepareStart(
    harness.roomCode,
    harness.hostSocket,
  );
  harness.service.discardPreparedStart(prepared);

  assert.throws(
    () => harness.service.commitPreparedStart(prepared),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "waiting");
  assert.equal(harness.started.length, 0);
  assert.equal(harness.runtime.pendingTimerCount, 0);
  harness.service.close(harness.roomCode);
});

test("Manhunt countdown timer setup failure emits no start events", () => {
  const harness = createHarness(3);
  harness.service.updateSettings(
    harness.roomCode,
    harness.hostSocket,
    validSettings,
  );
  harness.runtime.schedule = () => {
    throw new Error("timer setup failed");
  };

  assert.throws(
    () => harness.service.startGame(harness.roomCode, harness.hostSocket),
    /timer setup failed/,
  );
  assert.equal(harness.started.length, 0);
  assert.equal(harness.countdowns.length, 0);
  assert.equal(harness.runtime.pendingTimerCount, 0);
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "waiting");
  harness.service.close(harness.roomCode);
});

test("durable Manhunt activation persists before committing the active state", async () => {
  const coordinator = new RoomPersistenceCoordinator();
  const transitions: TransitionRoomGameStatusInput[] = [];
  let signalActivationEntered!: () => void;
  const activationEntered = new Promise<void>((resolve) => {
    signalActivationEntered = resolve;
  });
  let resolveActivation!: (value: TransitionedRoomGameStatusInfo) => void;
  const activationResult = new Promise<TransitionedRoomGameStatusInfo>(
    (resolve) => {
      resolveActivation = resolve;
    },
  );
  let commands!: RoomPersistenceCommands;
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime, {
    createPersistenceCommands(rooms) {
      commands = new RoomPersistenceCommands(
        rooms,
        {
          async createRoomWithHost(
            _input: CreateRoomWithHostInput,
          ): Promise<CreatedRoomInfo> {
            throw new Error("Unexpected room creation.");
          },
          async joinRoom(_input: JoinRoomInput): Promise<JoinedRoomInfo> {
            throw new Error("Unexpected room join.");
          },
          async transitionRoomGameStatus(input) {
            transitions.push(input);
            if (input.nextStatus === "in_progress") {
              signalActivationEntered();
              return activationResult;
            }
            return {
              roomId: input.expectedRoomId,
              roomCode: input.roomCode,
              gameMode: "manhunt",
              gameStatus: input.nextStatus,
              lifecycleStatus: "active",
              currentGameId: input.nextGameId,
              version: (BigInt(input.expectedVersion) + 1n).toString(),
            };
          },
        },
        coordinator,
      );
      return commands;
    },
  });
  coordinator.registerCreatedRoom({
    roomCode: harness.roomCode,
    roomId: randomUUID(),
    gameMode: "manhunt",
    hostPlayerId: harness.playerIds[0]!,
    lifecycleStatus: "active",
    currentGameId: null,
    version: "1",
  });
  harness.service.updateSettings(
    harness.roomCode,
    harness.hostSocket,
    validSettings,
  );
  harness.playerIds.forEach((_, index) =>
    harness.service.setReady(
      harness.roomCode,
      index === 0 ? harness.hostSocket : `socket-${index}`,
      true,
    ),
  );

  const reservation = await commands.acquireGameStatusReservation(
    harness.roomCode,
    "waiting",
    null,
    harness.hostSocket,
  );
  let preparedGameId!: GameSessionId;
  try {
    const prepared = harness.service.prepareStart(
      harness.roomCode,
      harness.hostSocket,
    );
    preparedGameId = prepared.gameId;
    await commands.transitionRoomGameStatus({
      roomCode: harness.roomCode,
      expectedStatus: "waiting",
      nextStatus: "starting",
      expectedCurrentGameId: null,
      nextGameId: preparedGameId,
      initiatedBy: {
        kind: "host",
        playerId: reservation.hostPlayerId!,
      },
      reservation,
    });
    harness.service.commitPreparedStart(prepared, reservation);
  } finally {
    harness.rooms.releaseGameStatusReservation(reservation);
  }

  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "starting");
  assert.equal(harness.states.at(-1)?.state.phase, "countdown");
  runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  await activationEntered;

  assert.equal(transitions.length, 2);
  assert.equal(transitions[1]?.expectedStatus, "starting");
  assert.equal(transitions[1]?.nextStatus, "in_progress");
  assert.equal(transitions[1]?.expectedCurrentGameId, preparedGameId);
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "starting");
  assert.equal(
    harness.service.getResumeSnapshot(
      harness.roomCode,
      harness.playerIds[0]!,
    )?.started.session.status,
    "starting",
  );
  assert.equal(harness.states.at(-1)?.state.phase, "countdown");

  const activation = transitions[1]!;
  resolveActivation({
    roomId: activation.expectedRoomId,
    roomCode: activation.roomCode,
    gameMode: "manhunt",
    gameStatus: activation.nextStatus,
    lifecycleStatus: "active",
    currentGameId: activation.nextGameId,
    version: (BigInt(activation.expectedVersion) + 1n).toString(),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "in_progress");
  assert.equal(harness.states.at(-1)?.state.phase, "active");
  assert.equal(
    coordinator.getMetadata(harness.roomCode)?.gameStatus,
    "in_progress",
  );
  harness.service.close(harness.roomCode);
});

test("durable Manhunt activation rejects uncertain and lease-lost transitions", async () => {
  for (const failure of [
    new Error("connection lost after commit"),
    new RoomRuntimeFencingError(),
  ]) {
    const fixture = createDurableManhuntFixture(failure);
    const { harness } = fixture;
    await commitDurableManhuntStart(fixture);

    harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(fixture.database.status, "starting");
    assert.ok(fixture.database.gameId);
    assert.equal(
      harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
      "starting",
    );
    assert.equal(
      harness.service.getResumeSnapshot(
        harness.roomCode,
        harness.playerIds[0]!,
      )?.started.session.status,
      "starting",
    );
    assert.equal(
      harness.states.some((entry) => entry.state.phase === "active"),
      false,
    );
    assert.throws(
      () => harness.rooms.assertRoomNotReserved(harness.roomCode),
      (error: unknown) =>
        error instanceof AppError && error.code === "UNKNOWN",
    );
    harness.service.close(harness.roomCode);
  }
});

test("durable Manhunt completion persists before events and supports a rematch after lobby return", async () => {
  let signalCompletionEntered!: () => void;
  const completionEntered = new Promise<void>((resolve) => {
    signalCompletionEntered = resolve;
  });
  let resolveCompletion!: () => void;
  const completionResult = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const fixture = createDurableManhuntFixture(
    undefined,
    undefined,
    false,
    undefined,
    {
      entered: signalCompletionEntered,
      wait: completionResult,
    },
  );
  const { harness, transitions, database } = fixture;
  const gameId = await commitDurableManhuntStart(fixture);

  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  for (let attempt = 0; attempt < 20 && database.status !== "in_progress"; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(database.status, "in_progress");
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "in_progress");

  const game = (Reflect.get(harness.service, "currentGames") as Map<
    RoomCode,
    object
  >).get(harness.roomCode);
  assert.ok(game);
  const endGame = Reflect.get(harness.service, "endGame");
  const pendingFinish = Reflect.apply(
    endGame,
    harness.service,
    [game, "hunter"],
  ) as Promise<void>;
  const duplicateFinish = Reflect.apply(
    endGame,
    harness.service,
    [game, "hunter"],
  ) as Promise<void>;
  assert.equal(duplicateFinish, pendingFinish);
  await completionEntered;

  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "in_progress");
  assert.equal(harness.ended.length, 0);
  assert.equal(transitions.at(-1)?.expectedCurrentGameId, gameId);
  assert.equal(transitions.at(-1)?.nextStatus, "finished");

  resolveCompletion();
  await pendingFinish;
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "finished");
  assert.equal(harness.ended.length, 1);
  assert.equal(
    transitions.filter((input) => input.nextStatus === "finished").length,
    1,
  );
  assert.equal(database.status, "finished");
  assert.equal(database.gameId, gameId);

  const lobby = await harness.service.returnToLobby(
    harness.roomCode,
    harness.hostSocket,
  );
  assert.equal(lobby.gameStatus, "waiting");
  assert.equal(lobby.currentGameId, undefined);
  assert.equal(database.status, "waiting");

  harness.playerIds.forEach((_, index) =>
    harness.service.setReady(
      harness.roomCode,
      index === 0 ? harness.hostSocket : `socket-${index}`,
      true,
    ),
  );
  const nextGameId = await commitDurableManhuntStart(fixture);
  assert.notEqual(nextGameId, gameId);
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "starting");
  assert.equal(database.status, "starting");
  harness.service.close(harness.roomCode);
});

test("Manhunt completion reservation blocks departure and orders timeout removal after finish", async () => {
  let signalCompletionEntered!: () => void;
  const completionEntered = new Promise<void>((resolve) => {
    signalCompletionEntered = resolve;
  });
  let resolveCompletion!: () => void;
  const completionResult = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });
  const fixture = createDurableManhuntFixture(
    undefined,
    undefined,
    false,
    undefined,
    {
      entered: signalCompletionEntered,
      wait: completionResult,
    },
  );
  const { harness, commands, database, timeoutRemovals } = fixture;
  const gameId = await commitDurableManhuntStart(fixture);
  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  for (let attempt = 0; attempt < 20 && database.status !== "in_progress"; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(database.status, "in_progress");

  const timedOut = disconnectManhuntPlayerForTimeout(harness, 2);
  const game = (Reflect.get(harness.service, "currentGames") as Map<
    RoomCode,
    object
  >).get(harness.roomCode);
  assert.ok(game);
  const endGame = Reflect.get(harness.service, "endGame");
  const pendingFinish = Reflect.apply(
    endGame,
    harness.service,
    [game, "hunter"],
  ) as Promise<void>;
  await completionEntered;

  assert.throws(
    () => harness.rooms.leaveRoom(harness.roomCode, "socket-1"),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  let departureSettled = false;
  const departure = commands.leaveRoom(harness.roomCode, "socket-1").then(
    (result) => {
      departureSettled = true;
      return { result };
    },
    (error: unknown) => {
      departureSettled = true;
      return { error };
    },
  );
  await Promise.resolve();
  assert.equal(departureSettled, false);
  let timeoutSettled = false;
  const pendingRemoval = commands.removeDisconnectedPlayer(
    harness.roomCode,
    timedOut.playerId,
    "1",
    timedOut.deadline,
    new Date(timedOut.deadline.getTime() + 1),
  ).then((result) => {
    timeoutSettled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(timeoutSettled, false);
  assert.ok(
    harness.rooms.getPublicRoom(harness.roomCode)?.players.some(
      (player) => player.id === timedOut.playerId,
    ),
  );

  resolveCompletion();
  await pendingFinish;
  const departureResult = await departure;
  if ("error" in departureResult) {
    assert.ok(
      departureResult.error instanceof AppError
      && departureResult.error.code === "GAME_NOT_ACTIVE",
    );
    assert.ok(
      harness.rooms.getPublicRoom(harness.roomCode)?.players.some(
        (player) => player.id === harness.playerIds[1],
      ),
    );
  } else {
    assert.equal(departureResult.result.playerId, harness.playerIds[1]);
  }
  const removal = await pendingRemoval;
  assert.ok(removal);
  assert.deepEqual(timeoutRemovals, [timedOut.playerId]);
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.players.some(
      (player) => player.id === timedOut.playerId,
    ),
    false,
  );
  assert.equal(database.status, "finished");
  assert.equal(database.gameId, gameId);
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "finished");
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.currentGameId, gameId);
  assert.equal(harness.ended.length, 1);
  harness.service.close(harness.roomCode);
});

test("durable Manhunt countdown cancellation after player removal persists before reset", async () => {
  const fixture = createDurableManhuntFixture();
  const { harness, commands } = fixture;
  const gameId = await commitDurableManhuntStart(fixture);

  const removal = await commands.leaveRoom(harness.roomCode, "socket-2");
  await harness.service.onPlayerRemoved(
    removal.roomCode,
    removal.room !== undefined,
  );

  assert.equal(fixture.transitions.length, 2);
  assert.equal(fixture.transitions[1]?.expectedStatus, "starting");
  assert.equal(fixture.transitions[1]?.nextStatus, "waiting");
  assert.equal(fixture.transitions[1]?.expectedCurrentGameId, gameId);
  assert.equal(fixture.transitions[1]?.nextGameId, null);
  assert.equal(fixture.database.status, "waiting");
  assert.equal(fixture.database.gameId, null);
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
    "waiting",
  );
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.currentGameId,
    undefined,
  );
  assert.equal(harness.countdownCancellations.length, 1);
  harness.service.close(harness.roomCode);
});

test("durable Manhunt player removal waits for cancellation persistence", async () => {
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let releaseTransition!: () => void;
  const wait = new Promise<void>((resolve) => {
    releaseTransition = resolve;
  });
  const fixture = createDurableManhuntFixture(
    undefined,
    undefined,
    false,
    { entered: signalEntered, wait },
  );
  const { harness, commands } = fixture;
  await commitDurableManhuntStart(fixture);
  const removal = await commands.leaveRoom(harness.roomCode, "socket-2");
  let settled = false;
  const cancellation = Promise.resolve(
    harness.service.onPlayerRemoved(
      removal.roomCode,
      removal.room !== undefined,
    ),
  ).then(() => {
    settled = true;
  });

  await entered;
  assert.equal(settled, false);
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
    "starting",
  );
  assert.equal(harness.countdownCancellations.length, 0);

  releaseTransition();
  await cancellation;
  assert.equal(settled, true);
  assert.equal(fixture.database.status, "waiting");
  assert.equal(harness.countdownCancellations.length, 1);
  harness.service.close(harness.roomCode);
});

test("countdown validation awaits durable cancellation before completing activation", async () => {
  let signalEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  let releaseTransition!: () => void;
  const wait = new Promise<void>((resolve) => {
    releaseTransition = resolve;
  });
  const fixture = createDurableManhuntFixture(
    undefined,
    undefined,
    false,
    { entered: signalEntered, wait },
  );
  const { harness, commands } = fixture;
  const gameId = await commitDurableManhuntStart(fixture);
  const disconnected = await commands.disconnectSocket("socket-2", 60_000);
  assert.ok(disconnected);
  harness.service.onPlayerDisconnected(
    harness.roomCode,
    disconnected.playerId,
  );

  const activateCountdown = Reflect.get(
    harness.service,
    "activateCountdown",
  ) as (
    roomCode: RoomCode,
    sessionId: GameSessionId,
  ) => Promise<void>;
  let settled = false;
  const activation = activateCountdown
    .call(harness.service, harness.roomCode, gameId)
    .then(() => {
      settled = true;
    });
  await entered;
  assert.equal(settled, false);
  assert.equal(fixture.database.status, "starting");
  assert.equal(harness.countdownCancellations.length, 0);

  releaseTransition();
  await activation;
  assert.equal(settled, true);
  assert.equal(fixture.database.status, "waiting");
  assert.equal(harness.countdownCancellations.length, 1);
  harness.service.close(harness.roomCode);
});

test("rejected and uncertain Manhunt cancellations fence without advertising waiting", async () => {
  for (const [error, uncertain] of [
    [new Error("cancellation rejected"), false],
    [new Error("connection lost after cancellation commit"), true],
  ] as const) {
    const fixture = createDurableManhuntFixture(
      undefined,
      error,
      uncertain,
    );
    const { harness, commands } = fixture;
    await commitDurableManhuntStart(fixture);
    const removal = await commands.leaveRoom(harness.roomCode, "socket-2");

    await assert.rejects(
      Promise.resolve(
        harness.service.onPlayerRemoved(
          removal.roomCode,
          removal.room !== undefined,
        ),
      ),
      (failure: unknown) =>
        failure instanceof AppError && failure.code === "UNKNOWN",
    );
    assert.equal(
      harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
      "starting",
    );
    assert.equal(
      fixture.database.status,
      uncertain ? "waiting" : "starting",
    );
    assert.equal(harness.countdownCancellations.length, 0);
    assert.equal(fixture.coordinator.isFenced(harness.roomCode), true);
    assert.throws(
      () => harness.rooms.joinRoom(
        { roomCode: harness.roomCode, nickname: "Late" },
        "late-socket",
      ),
      (failure: unknown) =>
        failure instanceof AppError && failure.code === "UNKNOWN",
    );
    harness.service.close(harness.roomCode);
  }
});

test("a stale Manhunt cancellation cannot roll an activated game back", async () => {
  const fixture = createDurableManhuntFixture();
  const { harness } = fixture;
  await commitDurableManhuntStart(fixture);

  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fixture.database.status, "in_progress");

  await harness.service.onPlayerRemoved(harness.roomCode, true);

  assert.equal(fixture.transitions.length, 2);
  assert.equal(fixture.database.status, "in_progress");
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
    "in_progress",
  );
  assert.equal(harness.countdownCancellations.length, 0);
  harness.service.close(harness.roomCode);
});

test("durable Manhunt countdown cancellation after validation failure persists rollback", async () => {
  const fixture = createDurableManhuntFixture();
  const { harness, commands } = fixture;
  await commitDurableManhuntStart(fixture);
  const disconnected = await commands.disconnectSocket("socket-2", 60_000);
  assert.ok(disconnected);
  harness.service.onPlayerDisconnected(
    harness.roomCode,
    disconnected.playerId,
  );

  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(fixture.transitions.length, 2);
  assert.equal(fixture.transitions[1]?.expectedStatus, "starting");
  assert.equal(fixture.transitions[1]?.nextStatus, "waiting");
  assert.equal(fixture.database.status, "waiting");
  assert.equal(fixture.database.gameId, null);
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
    "waiting",
  );
  assert.equal(
    harness.states.some((entry) => entry.state.phase === "active"),
    false,
  );
  assert.equal(harness.countdownCancellations.length, 1);
  harness.service.close(harness.roomCode);
});

test("two players receive one hunter and one runner regardless of configured count", () => {
  const harness = createHarness(2);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    hunterCount: 11,
  });
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  const hunters = harness.assignments.filter(
    (assignment) => assignment.team === "hunter",
  );
  const runners = harness.assignments.filter(
    (assignment) => assignment.team === "runner",
  );
  assert.equal(hunters.length, 1);
  assert.equal(runners.length, 1);
  assert.equal(session.state.settings.hunterCount, 1);
  assert.equal("teams" in session.state, false);
  const hunter = hunters[0]!;
  const runner = runners[0]!;

  assert.throws(
    () =>
      harness.service.recordLocation(
        harness.roomCode,
        socketIdForPlayer(harness, hunter.playerId),
        validSettings.boundary.center,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  const locationAck = harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, runner.playerId),
    validSettings.boundary.center,
  );
  assert.equal(locationAck.sessionId, session.id);
  assert.throws(
    () =>
      harness.service.attemptCatch(
        harness.roomCode,
        socketIdForPlayer(harness, hunter.playerId),
        runner.playerId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );

  harness.runtime.advance(
    MANHUNT_RUNNER_HEAD_START_SECONDS * 1_000,
  );
  assert.equal(session.state.phase, "countdown");
  assert.equal(
    session.state.runnerHeadStartEndsAt,
    harness.countdowns[0]?.runnerHeadStartEndsAt,
  );
  assert.equal(
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, runner.playerId),
      validSettings.boundary.center,
    ).sessionId,
    session.id,
  );
  assert.equal(
    harness.service
      .getResumeSnapshot(harness.roomCode, runner.playerId)
      ?.teamAssignment.team,
    "runner",
  );
  harness.runtime.advance(
    (MANHUNT_COUNTDOWN_DURATION_SECONDS -
      MANHUNT_RUNNER_HEAD_START_SECONDS) *
      1_000,
  );
  assert.equal(session.state.phase, "active");
  assert.equal(
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, hunter.playerId),
      validSettings.boundary.center,
    ).sessionId,
    session.id,
  );
});

test("games with more than two players retain the configured hunter count", () => {
  const harness = createHarness(4);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    hunterCount: 2,
  });
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  assert.equal(
    harness.assignments.filter((entry) => entry.team === "hunter").length,
    2,
  );
  assert.equal(
    harness.assignments.filter((entry) => entry.team === "runner").length,
    2,
  );
  assert.equal(session.state.settings.hunterCount, 2);
});

test("countdown activation preserves the zone schedule while mission scheduling begins after release", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  assert.equal(runtime.pendingTimerCount, 1);

  runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  const activeSince = Date.parse(session.state.activeSince!);
  const firstShrinkAt = Date.parse(session.state.nextShrinkAt!);
  assert.equal(session.state.phase, "active");
  assert.equal(firstShrinkAt, activeSince + 600_000);
  assert.equal(runtime.pendingTimerCount, 5);
  assert.equal(harness.missionAssignments.length, 0);

  harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!);
  runtime.advance(5_000);
  assert.equal(runtime.pendingTimerCount, 5);
  assert.equal(Date.parse(session.state.nextShrinkAt!), firstShrinkAt);
});

test("partial Manhunt activation timer setup cancels earlier handles and emits no active state", async () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  harness.service.startGame(harness.roomCode, harness.hostSocket);
  runtime.failScheduleOnCall = runtime.scheduleCalls + 3;

  runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000, 1);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(
    harness.states.some((entry) => entry.state.phase === "active"),
    false,
  );
  assert.equal(harness.runtime.pendingTimerCount, 0);
  assert.equal(
    harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!),
    undefined,
  );
  assert.throws(
    () => harness.rooms.assertRoomNotReserved(harness.roomCode),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNKNOWN",
  );
  harness.service.close(harness.roomCode);
});

test("mission deadline scheduling completes before the assignment event", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime, {
    missionRandomInt: missionRandomForTest(2),
  });
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  harness.service.startGame(harness.roomCode, harness.hostSocket);
  const hiders = harness.assignments
    .filter(({ team }) => team === "runner")
    .map(({ playerId }) => playerId);
  runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000 - 1_000);
  for (const playerId of hiders) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, playerId),
      validSettings.boundary.center,
      1,
    );
  }
  runtime.onSchedule = (delayMs) =>
    harness.timerEventOrder.push(`timer:${delayMs}`);

  runtime.advance(1_000);

  const deadlineTimerIndex = harness.timerEventOrder.indexOf(
    `timer:${MANHUNT_MISSION_DEADLINE_SECONDS * 1_000}`,
  );
  const assignmentEventIndex = harness.timerEventOrder.indexOf("assignment");
  assert.ok(deadlineTimerIndex >= 0);
  assert.ok(assignmentEventIndex > deadlineTimerIndex);
  assert.equal(harness.missionAssignments.length, 1);
  harness.service.close(harness.roomCode);
});

test("deadline scheduling failure emits no mission assignment and safely stops the game", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime, {
    missionRandomInt: missionRandomForTest(2),
  });
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  harness.service.startGame(harness.roomCode, harness.hostSocket);
  const hiders = harness.assignments
    .filter(({ team }) => team === "runner")
    .map(({ playerId }) => playerId);
  runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000 - 1_000);
  for (const playerId of hiders) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, playerId),
      validSettings.boundary.center,
      1,
    );
  }
  runtime.failScheduleDelayMs = MANHUNT_MISSION_DEADLINE_SECONDS * 1_000;

  runtime.advance(1_000);

  assert.equal(harness.missionAssignments.length, 0);
  assert.equal(harness.runtime.pendingTimerCount, 0);
  assert.equal(
    harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!),
    undefined,
  );
  assert.throws(
    () => harness.rooms.assertRoomNotReserved(harness.roomCode),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNKNOWN",
  );
  harness.service.close(harness.roomCode);
});

test("mission retry timer scheduling failure is caught and fences the active game", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime, {
    missionRandomInt: missionRandomForTest(2),
  });
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  harness.service.startGame(harness.roomCode, harness.hostSocket);
  runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000, 1);
  runtime.failScheduleDelayMs = 1_000;

  assert.doesNotThrow(() => runtime.advance(0, 1));

  assert.equal(harness.missionAssignments.length, 0);
  assert.equal(harness.runtime.pendingTimerCount, 0);
  assert.equal(
    harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!),
    undefined,
  );
  assert.throws(
    () => harness.rooms.assertRoomNotReserved(harness.roomCode),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNKNOWN",
  );
  harness.service.close(harness.roomCode);
});

test("stale mission timers cannot mutate a replacement game session", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime, {
    missionRandomInt: missionRandomForTest(2),
  });
  activateMissionGame(harness);
  const assignmentsBeforeReplacement = harness.missionAssignments.length;
  const currentGames = Reflect.get(harness.service, "currentGames") as Map<
    RoomCode,
    object
  >;

  harness.service.close(harness.roomCode);
  const replacement = {};
  currentGames.set(harness.roomCode, replacement);
  runtime.runCancelledCallbacks();

  assert.equal(currentGames.get(harness.roomCode), replacement);
  assert.equal(
    harness.missionAssignments.length,
    assignmentsBeforeReplacement,
  );
  currentGames.delete(harness.roomCode);
});

test("mission selection randomly assigns two Hiders and keeps assignments private on reconnect", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime, {
    missionRandomInt: missionRandomForTest(2),
  });
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  const hiders = harness.assignments
    .filter(({ team }) => team === "runner")
    .map(({ playerId }) => playerId);
  const hunters = harness.assignments
    .filter(({ team }) => team === "hunter")
    .map(({ playerId }) => playerId);

  assert.equal(harness.missionAssignments.length, 0);
  runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000 - 1_000);
  for (const playerId of hiders) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, playerId),
      validSettings.boundary.center,
      1,
    );
  }
  runtime.advance(1_000);
  assert.equal(session.state.phase, "active");
  assert.equal(harness.missionAssignments.length, 1);
  const firstShrinkAt = Date.parse(session.state.nextShrinkAt!);

  runtime.advance(1_000);
  const selectedIds = harness.missionAssignments.map(
    ({ playerId }) => playerId,
  );
  assert.equal(selectedIds.length, 2);
  assert.equal(new Set(selectedIds).size, selectedIds.length);
  assert.ok(selectedIds.every((playerId) => hiders.includes(playerId)));
  assert.ok(harness.missionAssignments.every(({ playerId, payload }) =>
    payload.playerId === playerId &&
    Date.parse(payload.deadlineAt) - Date.parse(payload.revealedAt) ===
      MANHUNT_MISSION_DEADLINE_SECONDS * 1_000,
  ));
  assert.equal(Date.parse(session.state.nextShrinkAt!), firstShrinkAt);
  assert.equal(runtime.pendingTimerCount, 5);
  assert.equal("teams" in session.state, false);

  for (const playerId of hunters) {
    assert.equal(
      harness.service.getResumeSnapshot(harness.roomCode, playerId)
        ?.missionAssignment,
      undefined,
    );
  }
  for (const playerId of hiders.filter((id) => !selectedIds.includes(id))) {
    assert.equal(
      harness.service.getResumeSnapshot(harness.roomCode, playerId)
        ?.missionAssignment,
      undefined,
    );
  }
  for (const { playerId, payload } of harness.missionAssignments) {
    const snapshot = harness.service.getResumeSnapshot(
      harness.roomCode,
      playerId,
    );
    assert.deepEqual(snapshot?.missionAssignment, payload);
    assert.equal(
      harness.service.getResumeSnapshot(harness.roomCode, playerId)
        ?.missionReveal,
      undefined,
    );
  }
});

test("mission selection randomly assigns three eligible Hiders", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(5, runtime, {
    missionRandomInt: missionRandomForTest(3),
  });
  const { hiders } = activateMissionGame(harness);

  assert.equal(hiders.length, 4);
  assert.equal(harness.missionAssignments.length, 1);
  runtime.advance(1_000);
  assert.equal(harness.missionAssignments.length, 2);
  runtime.advance(1_000);
  const selectedIds = harness.missionAssignments.map(
    ({ playerId }) => playerId,
  );
  assert.equal(selectedIds.length, 3);
  assert.equal(new Set(selectedIds).size, selectedIds.length);
  assert.ok(selectedIds.every((playerId) => hiders.includes(playerId)));
});

test("all three selected Hiders must complete before the success reveal", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(5, runtime, {
    missionRandomInt: missionRandomForTest(3),
  });
  const { hiders, hunters } = activateMissionGame(harness);
  const first = harness.missionAssignments[0]!;

  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, hunters[0]!),
    validSettings.boundary.center,
    1,
  );
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, first.playerId),
    first.payload.center,
    1,
  );
  runtime.advance(1_000);
  const second = harness.missionAssignments[1]!;
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, second.playerId),
    second.payload.center,
    1,
  );
  runtime.advance(1_000);
  const third = harness.missionAssignments[2]!;

  runtime.advance(3_000);
  recordMissionLocations(
    harness,
    new Map([
      [first.playerId, first.payload.center],
      [second.playerId, second.payload.center],
    ]),
  );
  runtime.advance(5_000);
  assert.equal(
    harness.missionAssignments.filter(
      ({ payload }) => payload.status === "completed",
    ).length,
    1,
  );
  runtime.advance(1_000);
  assert.equal(
    harness.missionAssignments.filter(
      ({ payload }) => payload.status === "completed",
    ).length,
    2,
  );
  assert.equal(harness.missionReveals.length, 0);

  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, third.playerId),
    third.payload.center,
    1,
  );
  runtime.advance(5_000);
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, third.playerId),
    third.payload.center,
    1,
  );
  runtime.advance(5_000);

  assert.equal(
    harness.missionAssignments.filter(
      ({ payload }) => payload.status === "completed",
    ).length,
    3,
  );
  assert.equal(harness.missionReveals.length, 1);
  assert.equal(harness.missionReveals[0]?.payload.outcome, "success");
  assert.deepEqual(
    harness.missionReveals[0]?.playerIds,
    hiders,
  );
});

test("mission selection caps a three-Hider draw to the two eligible Hiders", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime, {
    missionRandomInt: missionRandomForTest(3),
  });
  const { hiders } = activateMissionGame(harness);

  runtime.advance(1_000);
  const selectedIds = harness.missionAssignments.map(
    ({ playerId }) => playerId,
  );
  assert.equal(hiders.length, 2);
  assert.equal(selectedIds.length, 2);
  assert.equal(new Set(selectedIds).size, selectedIds.length);
  assert.ok(selectedIds.every((playerId) => hiders.includes(playerId)));
});

test("every selected Hider must complete the mission before Hunters are revealed", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime, {
    missionRandomInt: missionRandomForTest(),
  });
  const { hiders, hunters } = activateMissionGame(harness);
  runtime.advance(1_000);
  const selected = harness.missionAssignments.map(
    ({ playerId, payload }) => [playerId, payload.center] as const,
  );
  assert.equal(selected.length, 2);

  const locations = new Map(
    selected.map(([playerId, center]) => [playerId, center]),
  );
  for (const hunterId of hunters) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, hunterId),
      validSettings.boundary.center,
      1,
    );
  }
  recordMissionLocations(harness, locations);
  runtime.advance(5_000);
  recordMissionLocations(harness, locations);
  runtime.advance(5_000);

  assert.equal(
    harness.missionAssignments.filter(
      ({ payload }) => payload.status === "completed",
    ).length,
    selected.length,
  );
  assert.equal(harness.missionReveals.length, 1);
  assert.deepEqual(
    harness.missionReveals[0]?.playerIds.sort(),
    [...hiders].sort(),
  );
  assert.equal(harness.missionReveals[0]?.payload.outcome, "success");
  assert.deepEqual(
    harness.missionReveals[0]?.payload.locations.map(({ playerId }) => playerId),
    hunters,
  );
  assert.equal(
    Date.parse(harness.missionReveals[0]!.payload.visibleUntil) -
      runtime.now().getTime(),
    5_000,
  );
});

test("one selected Hider missing the deadline fails the all-or-nothing mission", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime, {
    missionRandomInt: missionRandomForTest(),
  });
  const { hiders, hunters } = activateMissionGame(harness);
  runtime.advance(1_000);
  const selected = harness.missionAssignments.map(
    ({ playerId, payload }) => [playerId, payload.center] as const,
  );
  const completed = selected[0]!;
  const locations = new Map(
    hiders.map((playerId) => [
      playerId,
      playerId === completed[0]
        ? completed[1]
        : validSettings.boundary.center,
    ]),
  );
  for (const hunterId of hunters) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, hunterId),
      validSettings.boundary.center,
      1,
    );
  }
  recordMissionLocations(harness, locations);
  runtime.advance(5_000);
  recordMissionLocations(harness, locations);
  runtime.advance(5_000);
  assert.equal(
    harness.missionAssignments.some(
      ({ playerId, payload }) =>
        playerId === completed[0] && payload.status === "completed",
    ),
    true,
  );
  assert.equal(harness.missionReveals.length, 0);

  runtime.advance(
    (MANHUNT_MISSION_DEADLINE_SECONDS - 10) * 1_000 - 1_000,
  );
  for (const playerId of hiders) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, playerId),
      validSettings.boundary.center,
      1,
    );
  }
  for (const hunterId of hunters) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, hunterId),
      validSettings.boundary.center,
      1,
    );
  }
  runtime.advance(1_000);

  assert.equal(harness.missionReveals.length, 1);
  assert.deepEqual(
    harness.missionReveals[0]?.playerIds,
    hunters,
  );
  assert.equal(harness.missionReveals[0]?.payload.outcome, "failure");
  assert.deepEqual(
    harness.missionReveals[0]?.payload.locations.map(({ playerId }) => playerId),
    hiders,
  );
  assert.equal(
    harness.missionAssignments.some(
      ({ playerId, payload }) =>
        playerId !== completed[0] && payload.status === "failed",
    ),
    true,
  );
});

test("mission completion requires fresh accurate locations inside the five-metre circle for ten seconds", () => {
  const harness = createHarness(3, new ManualRuntime(), {
    missionRandomInt: missionRandomForTest(),
  });
  activateMissionGame(harness);
  const mission = harness.missionAssignments[0]!;
  assert.equal(mission.payload.radiusMeters, MANHUNT_MISSION_CIRCLE_RADIUS_METERS);
  assert.ok(
    Math.abs(
      haversineMeters(
        validSettings.boundary.center,
        mission.payload.center,
      ) - MANHUNT_MISSION_MIN_DISTANCE_METERS,
    ) < 0.1,
  );

  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, mission.playerId),
    mission.payload.center,
    6,
  );
  harness.runtime.advance(MANHUNT_MISSION_DWELL_SECONDS * 1_000);
  assert.equal(
    harness.missionAssignments.some(
      ({ payload }) => payload.status === "completed",
    ),
    false,
  );

  for (let sample = 0; sample <= 2; sample += 1) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, mission.playerId),
      mission.payload.center,
      1,
    );
    if (sample < 2) {
      harness.runtime.advance(5_000);
    }
  }
  assert.equal(
    harness.missionAssignments.some(
      ({ payload }) => payload.status === "completed",
    ),
    true,
  );
});

test("ending a game cancels mission assignment, deadline and reveal timers", () => {
  const harness = createHarness(3, new ManualRuntime(), {
    missionRandomInt: missionRandomForTest(),
  });
  const { hiders, hunters } = activateMissionGame(harness);
  const hunterId = hunters[0]!;
  const hunterSocket = socketIdForPlayer(harness, hunterId);
  harness.service.recordLocation(
    harness.roomCode,
    hunterSocket,
    validSettings.boundary.center,
    1,
  );
  for (const runnerId of hiders) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, runnerId),
      validSettings.boundary.center,
      1,
    );
    const request = harness.service.attemptCatch(
      harness.roomCode,
      hunterSocket,
      runnerId,
    );
    harness.service.respondToCatch(
      harness.roomCode,
      socketIdForPlayer(harness, runnerId),
      request.requestId,
      true,
    );
  }

  assert.equal(harness.service.getResumeSnapshot(harness.roomCode, hunterId)
    ?.state.state.phase, "finished");
  assert.equal(harness.runtime.pendingTimerCount, 0);
});

test("gameplay location updates are rejected until countdown expires and remain private", () => {
  const harness = createHarness();
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = harness.service.startGame(harness.roomCode, harness.hostSocket);
  const hunter = harness.assignments.find(
    (assignment) => assignment.team === "hunter",
  )!;
  assert.throws(
    () =>
      harness.service.recordLocation(
        harness.roomCode,
        socketIdForPlayer(harness, hunter.playerId),
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
  assert.equal(
    countdownSnapshot?.countdown?.remainingSeconds,
    MANHUNT_COUNTDOWN_DURATION_SECONDS - 4,
  );
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

  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000 - 4_250);
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
  const activeUpdates = harness.states.filter(
    (entry) => entry.state.phase === "active",
  );
  assert.equal(activeUpdates.length, 1);
  const activeState = activeUpdates[0]!.state;
  assert.ok("gameEndsAt" in activeState && "nextShrinkAt" in activeState);
  assert.ok(activeState.gameEndsAt);
  assert.ok(activeState.nextShrinkAt);
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

test("a stale game timeout cannot emit a result for a newer Manhunt session", () => {
  const harness = createHarness();
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const firstSession = startActiveGame(harness);

  harness.rooms.finishGame(harness.roomCode, firstSession.id);
  harness.service.clearSession(harness.roomCode);
  const secondSession = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  harness.runtime.runCancelledCallbacks();

  assert.equal(harness.ended.length, 0);
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.currentGameId,
    secondSession.id,
  );
  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  assert.equal(secondSession.state.phase, "active");
  assert.equal(harness.ended.length, 0);
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
  assert.equal(harness.flashes.length, 4);
  assert.equal(harness.flashes[0]?.payload.locations.length, 4);
  runtime.advance((MANHUNT_LOCATION_REVEAL_DURATION_SECONDS - 1) * 1_000);
  assert.equal(harness.flashes.length, 4);
  runtime.advance(1_000);
  assert.equal(harness.flashes.length, 4);
  runtime.advance(MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS * 1_000);
  assert.equal(harness.flashes.length, 8);

  harness.service.clearSession(harness.roomCode);
  runtime.advance(MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS * 1_000);
  assert.equal(harness.flashes.length, 8);
  assert.equal(runtime.pendingTimerCount, 0);
});


test("Manhunt warns before two progressive safe-zone shrinks and respects the 65m floor", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    boundary: { ...validSettings.boundary, radiusMeters: 100 },
    gameDurationSeconds: 1_800,
  });
  const session = startActiveGame(harness);
  const activeSince = Date.parse(session.state.activeSince!);
  assert.equal(JSON.stringify(harness.started.at(-1)).includes('"boundary"'), false);
  assert.equal(JSON.stringify(harness.states.at(-1)).includes('"boundary"'), false);

  runtime.advance((10 * 60 - 21) * 1_000);
  let state = getManhuntState(harness, harness.playerIds[0]!);
  assert.equal(state.shrinkWarningEndsAt, undefined);

  runtime.advance(1_000);
  state = getManhuntState(harness, harness.playerIds[0]!);
  assert.equal(Date.parse(state.shrinkWarningEndsAt!), activeSince + 10 * 60 * 1_000);

  runtime.advance(20_000);
  state = getManhuntState(harness, harness.playerIds[0]!);
  assert.equal(state.zoneShrinkEndsAt !== undefined, true);

  runtime.advance(60_000);
  state = getManhuntState(harness, harness.playerIds[0]!);
  assert.equal(currentManhuntBoundary(harness).radiusMeters, 85);
  assert.equal(harness.boundaryUpdates.at(-1)?.boundary?.radiusMeters, 85);
  assert.equal(Date.parse(state.nextShrinkAt!), activeSince + 20 * 60 * 1_000);

  runtime.advance((9 * 60 - 20) * 1_000);
  state = getManhuntState(harness, harness.playerIds[0]!);
  assert.equal(Date.parse(state.shrinkWarningEndsAt!), activeSince + 20 * 60 * 1_000);

  runtime.advance(20_000);
  runtime.advance(60_000);
  state = getManhuntState(harness, harness.playerIds[0]!);
  assert.equal(currentManhuntBoundary(harness).radiusMeters, 65);
  assert.ok(currentManhuntBoundary(harness).radiusMeters >= 65);
});

test("Manhunt schedules both shrink phases for every duration and the default", () => {
  const scenarios = [
    { name: "30-minute", configuredDuration: 1_800, duration: 1_800 },
    { name: "45-minute", configuredDuration: 2_700, duration: 2_700 },
    { name: "60-minute", configuredDuration: 3_600, duration: 3_600 },
    { name: "default", configuredDuration: undefined, duration: 3_600 },
  ] as const;

  for (const scenario of scenarios) {
    const runtime = new ManualRuntime();
    const harness = createHarness(3, runtime);
    const settings = scenario.configuredDuration === undefined
      ? validSettings
      : { ...validSettings, gameDurationSeconds: scenario.configuredDuration };
    harness.service.updateSettings(harness.roomCode, harness.hostSocket, settings);
    const session = startActiveGame(harness);
    const activeSince = Date.parse(session.state.activeSince!);
    const firstShrinkSeconds = Math.floor(scenario.duration / 3);
    const secondShrinkSeconds = Math.floor((scenario.duration * 2) / 3);
    const firstShrinkAt = activeSince + firstShrinkSeconds * 1_000;
    const secondShrinkAt = activeSince + secondShrinkSeconds * 1_000;

    assert.equal(
      session.state.settings.gameDurationSeconds,
      scenario.duration,
      `${scenario.name} duration`,
    );
    assert.equal(
      Date.parse(session.state.gameEndsAt!),
      activeSince + scenario.duration * 1_000,
      `${scenario.name} game deadline`,
    );
    assert.equal(
      Date.parse(session.state.nextShrinkAt!),
      firstShrinkAt,
      `${scenario.name} first shrink deadline`,
    );

    runtime.advance((firstShrinkSeconds - 20) * 1_000);
    let state = getManhuntState(harness, harness.playerIds[0]!);
    assert.equal(
      Date.parse(state.shrinkWarningEndsAt!),
      firstShrinkAt,
      `${scenario.name} first warning deadline`,
    );
    runtime.advance(20_000);
    state = getManhuntState(harness, harness.playerIds[0]!);
    assert.equal(Date.parse(state.zoneShrinkEndsAt!), firstShrinkAt + 60_000);
    assert.equal(state.zoneShrinkFromRadiusMeters, 500);
    assert.equal(state.zoneShrinkToRadiusMeters, 425);
    runtime.advance(60_000);

    state = getManhuntState(harness, harness.playerIds[0]!);
    assert.equal(currentManhuntBoundary(harness).radiusMeters, 425);
    assert.equal(Date.parse(state.nextShrinkAt!), secondShrinkAt);
    runtime.advance(
      secondShrinkSeconds * 1_000 -
        20_000 -
        (firstShrinkSeconds * 1_000 + 60_000),
    );
    state = getManhuntState(harness, harness.playerIds[0]!);
    assert.equal(
      Date.parse(state.shrinkWarningEndsAt!),
      secondShrinkAt,
      `${scenario.name} second warning deadline`,
    );
    runtime.advance(20_000);
    state = getManhuntState(harness, harness.playerIds[0]!);
    assert.equal(Date.parse(state.zoneShrinkEndsAt!), secondShrinkAt + 60_000);
    assert.equal(state.zoneShrinkFromRadiusMeters, 425);
    assert.equal(state.zoneShrinkToRadiusMeters, 319);
    runtime.advance(60_000);

    state = getManhuntState(harness, harness.playerIds[0]!);
    assert.equal(currentManhuntBoundary(harness).radiusMeters, 319);
    assert.equal(state.shrinkStage, 2);
    assert.equal(state.nextShrinkAt, undefined);
    assert.equal(state.shrinkWarningEndsAt, undefined);
  }
});

test("Manhunt timeout awards the win to remaining runners", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  const session = startActiveGame(harness);
  const runnerIds = harness.assignments
    .filter((assignment) => assignment.team === "runner")
    .map((assignment) => assignment.playerId);

  runtime.advance(30 * 60 * 1_000);
  assert.equal(harness.ended.length, 1);
  assert.deepEqual(harness.ended[0]?.result.winnerPlayerIds, runnerIds);
  assert.equal(harness.runtime.pendingTimerCount, 0);
});

test("a removed Hider is not a timeout winner", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  const session = startActiveGame(harness);
  const runners = harness.assignments.filter(
    (assignment) => assignment.team === "runner",
  );
  const removedRunner = runners[0]!;
  const remainingRunnerIds = runners
    .slice(1)
    .map((assignment) => assignment.playerId);
  removePlayer(harness, removedRunner.playerId);

  runtime.advance(30 * 60 * 1_000);

  assert.equal(harness.ended.length, 1);
  assert.deepEqual(
    harness.ended[0]?.result.winnerPlayerIds,
    remainingRunnerIds,
  );
  assert.equal(
    harness.ended[0]?.result.winnerPlayerIds.includes(removedRunner.playerId),
    false,
  );
});

test("a removed Hider does not prevent Hunters winning after remaining Hiders are caught", () => {
  const harness = createHarness(3);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = startActiveGame(harness);
  const hunter = harness.assignments.find(
    (assignment) => assignment.team === "hunter",
  )!;
  const runners = harness.assignments.filter(
    (assignment) => assignment.team === "runner",
  );
  const removedRunner = runners[0]!;
  const remainingRunner = runners[1]!;

  removePlayer(harness, removedRunner.playerId);
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, hunter.playerId),
    { latitude: 0, longitude: 0 },
  );
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, remainingRunner.playerId),
    { latitude: 0, longitude: eastOffsetMeters(1.4) },
  );
  const request = harness.service.attemptCatch(
    harness.roomCode,
    socketIdForPlayer(harness, hunter.playerId),
    remainingRunner.playerId,
  );
  harness.service.respondToCatch(
    harness.roomCode,
    socketIdForPlayer(harness, remainingRunner.playerId),
    request.requestId,
    true,
  );

  assert.equal(harness.ended.length, 1);
  assert.deepEqual(
    harness.ended[0]?.result.winnerPlayerIds,
    [hunter.playerId],
  );
  assert.equal(harness.runtime.pendingTimerCount, 0);
});

test("Manhunt timeout excludes already-caught Hiders from the winner list", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  const session = startActiveGame(harness);
  const hunter = harness.assignments.find((entry) => entry.team === "hunter")!;
  const runners = harness.assignments.filter((entry) => entry.team === "runner");
  const caughtRunner = runners[0]!;
  const remainingRunner = runners[1]!;

  for (const assignment of harness.assignments) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, assignment.playerId),
      assignment.playerId === caughtRunner.playerId
        ? { latitude: 0, longitude: eastOffsetMeters(1.4) }
        : { latitude: 0, longitude: 0 },
    );
  }
  const request = harness.service.attemptCatch(
    harness.roomCode,
    socketIdForPlayer(harness, hunter.playerId),
    caughtRunner.playerId,
  );
  harness.service.respondToCatch(
    harness.roomCode,
    socketIdForPlayer(harness, caughtRunner.playerId),
    request.requestId,
    true,
  );

  runtime.advance(30 * 60 * 1_000);
  assert.equal(harness.ended.length, 1);
  assert.deepEqual(
    harness.ended[0]?.result.winnerPlayerIds,
    [remainingRunner.playerId],
  );
  assert.equal(
    harness.ended[0]?.result.winnerPlayerIds.includes(caughtRunner.playerId),
    false,
  );
  assert.equal(harness.runtime.pendingTimerCount, 0);
});

test("Manhunt game and zone timers are cancelled when hunters win during a shrink", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    gameDurationSeconds: 1_800,
  });
  const session = startActiveGame(harness);
  const hunter = harness.assignments.find((entry) => entry.team === "hunter")!;
  const runners = harness.assignments.filter((entry) => entry.team === "runner");

  runtime.advance((10 * 60 - 20) * 1_000);
  runtime.advance(20_000);
  assert.ok(getManhuntState(harness, harness.playerIds[0]!).zoneShrinkEndsAt);

  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, hunter.playerId),
    { latitude: 0, longitude: 0 },
  );
  for (const runner of runners) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, runner.playerId),
      { latitude: 0, longitude: eastOffsetMeters(1.4) },
    );
  }
  for (const runner of runners) {
    const request = harness.service.attemptCatch(
      harness.roomCode,
      socketIdForPlayer(harness, hunter.playerId),
      runner.playerId,
    );
    harness.service.respondToCatch(
      harness.roomCode,
      socketIdForPlayer(harness, runner.playerId),
      request.requestId,
      true,
    );
  }

  assert.equal(harness.ended.length, 1);
  assert.deepEqual(
    harness.ended[0]?.result.winnerPlayerIds,
    [hunter.playerId],
  );
  assert.equal(harness.runtime.pendingTimerCount, 0);
});

test("catch requests accept exactly 1.5 metres and only mark caught after civilian acceptance", () => {
  const harness = createHarness(3);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = startActiveGame(harness);
  const hunter = harness.assignments.find((entry) => entry.team === "hunter")!;
  const runners = harness.assignments.filter((entry) => entry.team === "runner");
  const firstRunner = runners[0]!;

  for (const assignment of harness.assignments) {
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
  assert.deepEqual(
    harness.ended[0]?.result.winnerPlayerIds,
    [hunter.playerId],
  );
  assert.equal(harness.runtime.pendingTimerCount, 0);
});

test("catch requests reject distant and stale locations, and only hunters may request", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime);
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, validSettings);
  const session = startActiveGame(harness);
  const hunter = harness.assignments.find((entry) => entry.team === "hunter")!;
  const runner = harness.assignments.find((entry) => entry.team === "runner")!;
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
  const hunter = harness.assignments.find((entry) => entry.team === "hunter")!;
  const runner = harness.assignments.find((entry) => entry.team === "runner")!;
  for (const assignment of harness.assignments) {
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
  const hunter = harness.assignments.find((entry) => entry.team === "hunter")!;
  const runner = harness.assignments.find((entry) => entry.team === "runner")!;
  for (const assignment of harness.assignments) {
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
  const hunters = harness.assignments.filter((entry) => entry.team === "hunter");
  const runners = harness.assignments.filter((entry) => entry.team === "runner");
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
  const hunters = harness.assignments.filter((entry) => entry.team === "hunter");
  const runners = harness.assignments.filter((entry) => entry.team === "runner");
  const positions = new Map([
    [hunters[0]!.playerId, { latitude: 0, longitude: 0 }],
    [hunters[1]!.playerId, { latitude: 0, longitude: eastOffsetMeters(1) }],
    [runners[0]!.playerId, { latitude: 0, longitude: eastOffsetMeters(100) }],
    [runners[1]!.playerId, { latitude: 0, longitude: eastOffsetMeters(101) }],
  ]);
  for (const assignment of harness.assignments) {
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
  const hunter = harness.assignments.find((entry) => entry.team === "hunter")!;
  const runner = harness.assignments.find((entry) => entry.team === "runner")!;
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

  const hunter = harness.assignments.find((entry) => entry.team === "hunter")!;
  const runners = harness.assignments.filter((entry) => entry.team === "runner");
  for (const assignment of harness.assignments) {
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

test("Freeze requires an active Hunter and remains disabled without an approved range", () => {
  const harness = createHarness();
  harness.service.updateSettings(
    harness.roomCode,
    harness.hostSocket,
    validSettings,
  );
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  const hunterId = harness.assignments.find(
    (assignment) => assignment.team === "hunter",
  )!.playerId;
  assertAppError(
    () =>
      harness.service.activateFreeze(
        harness.roomCode,
        socketIdForPlayer(harness, hunterId),
        session.id,
        FREEZE_REQUEST_ONE,
      ),
    "GAME_NOT_ACTIVE",
  );

  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  assertAppError(
    () =>
      harness.service.activateFreeze(
        harness.roomCode,
        socketIdForPlayer(harness, hunterId),
        session.id,
        FREEZE_REQUEST_ONE,
      ),
    "GAME_NOT_READY",
  );
  assert.equal(harness.freezeWarnings.length, 0);

  const configured = createHarness(4, new ManualRuntime(), {
    freezeRangeMeters: TEST_ONLY_FREEZE_RANGE_METERS,
  });
  const active = activateFreezeGame(configured);
  assertAppError(
    () =>
      configured.service.activateFreeze(
        configured.roomCode,
        socketIdForPlayer(configured, active.runners[0]!),
        active.session.id,
        FREEZE_REQUEST_ONE,
      ),
    "NOT_AUTHORIZED",
  );

  const hunterIdActive = active.hunters[0]!;
  configured.rooms.markPlayerCaught(
    configured.roomCode,
    active.session.id,
    hunterIdActive,
  );
  assertAppError(
    () =>
      configured.service.activateFreeze(
        configured.roomCode,
        socketIdForPlayer(configured, hunterIdActive),
        active.session.id,
        FREEZE_REQUEST_TWO,
      ),
    "GAME_NOT_READY",
  );
});

test("Freeze requires fresh accurate locations for Hunters and eligible Hiders", () => {
  const staleHunter = createHarness(4, new ManualRuntime(), {
    freezeRangeMeters: TEST_ONLY_FREEZE_RANGE_METERS,
  });
  const staleHunterGame = activateFreezeGame(staleHunter);
  staleHunter.runtime.advance((MANHUNT_LOCATION_MAX_AGE_SECONDS + 1) * 1_000);
  assertAppError(
    () =>
      staleHunter.service.activateFreeze(
        staleHunter.roomCode,
        socketIdForPlayer(staleHunter, staleHunterGame.hunters[0]!),
        staleHunterGame.session.id,
        FREEZE_REQUEST_ONE,
      ),
    "GAME_NOT_READY",
  );

  const inaccurateHunter = createHarness(4, new ManualRuntime(), {
    freezeRangeMeters: TEST_ONLY_FREEZE_RANGE_METERS,
  });
  const inaccurateHunterGame = activateFreezeGame(inaccurateHunter);
  inaccurateHunter.service.recordLocation(
    inaccurateHunter.roomCode,
    socketIdForPlayer(inaccurateHunter, inaccurateHunterGame.hunters[0]!),
    inaccurateHunterGame.center,
    MANHUNT_MISSION_MAX_ACCURACY_METERS + 1,
  );
  assertAppError(
    () =>
      inaccurateHunter.service.activateFreeze(
        inaccurateHunter.roomCode,
        socketIdForPlayer(inaccurateHunter, inaccurateHunterGame.hunters[0]!),
        inaccurateHunterGame.session.id,
        FREEZE_REQUEST_ONE,
      ),
    "GAME_NOT_READY",
  );

  const inaccurateHiders = createHarness(4, new ManualRuntime(), {
    freezeRangeMeters: TEST_ONLY_FREEZE_RANGE_METERS,
  });
  const inaccurateHiderGame = activateFreezeGame(inaccurateHiders);
  for (const runnerId of inaccurateHiderGame.runners) {
    inaccurateHiders.service.recordLocation(
      inaccurateHiders.roomCode,
      socketIdForPlayer(inaccurateHiders, runnerId),
      {
        latitude: inaccurateHiderGame.center.latitude,
        longitude: inaccurateHiderGame.center.longitude + eastOffsetMeters(20),
      },
      MANHUNT_MISSION_MAX_ACCURACY_METERS + 1,
    );
  }
  inaccurateHiders.service.activateFreeze(
    inaccurateHiders.roomCode,
    socketIdForPlayer(inaccurateHiders, inaccurateHiderGame.hunters[0]!),
    inaccurateHiderGame.session.id,
    FREEZE_REQUEST_ONE,
  );
  assert.equal(inaccurateHiders.freezeWarnings.length, 0);

  const staleHiders = createHarness(4, new ManualRuntime(), {
    freezeRangeMeters: TEST_ONLY_FREEZE_RANGE_METERS,
  });
  const staleHiderGame = activateFreezeGame(staleHiders);
  staleHiders.runtime.advance((MANHUNT_LOCATION_MAX_AGE_SECONDS + 1) * 1_000);
  staleHiders.service.recordLocation(
    staleHiders.roomCode,
    socketIdForPlayer(staleHiders, staleHiderGame.hunters[0]!),
    staleHiderGame.center,
    1,
  );
  staleHiders.service.activateFreeze(
    staleHiders.roomCode,
    socketIdForPlayer(staleHiders, staleHiderGame.hunters[0]!),
    staleHiderGame.session.id,
    FREEZE_REQUEST_ONE,
  );
  assert.equal(staleHiders.freezeWarnings.length, 0);
});

test("Freeze warns all in-range Hiders privately, then freezes for exactly seven seconds", () => {
  const harness = createHarness(4, new ManualRuntime(), {
    freezeRangeMeters: TEST_ONLY_FREEZE_RANGE_METERS,
  });
  const { session, hunters, runners } = activateFreezeGame(harness);
  const hunterId = hunters[0]!;
  const inRangeRunners = runners.slice(0, 2);
  harness.service.activateFreeze(
    harness.roomCode,
    socketIdForPlayer(harness, hunterId),
    session.id,
    FREEZE_REQUEST_ONE,
  );

  assert.deepEqual(
    harness.freezeWarnings.map(({ playerId }) => playerId).sort(),
    [...inRangeRunners].sort(),
  );
  assert.equal(
    harness.freezeWarnings.every(
      ({ payload }) => payload.warningEndsAt ===
        new Date(
          Date.parse(payload.warningStartedAt) +
            MANHUNT_FREEZE_WARNING_SECONDS * 1_000,
        ).toISOString(),
    ),
    true,
  );
  assert.equal(harness.frozenPlayers.length, 0);
  const hunterSnapshot = harness.service.getResumeSnapshot(
    harness.roomCode,
    hunterId,
  );
  const outsideRunnerSnapshot = harness.service.getResumeSnapshot(
    harness.roomCode,
    runners[2]!,
  );
  assert.equal(hunterSnapshot?.freezeWarning, undefined);
  assert.equal(hunterSnapshot?.playerFrozen, undefined);
  assert.equal(outsideRunnerSnapshot?.freezeWarning, undefined);
  assert.equal(outsideRunnerSnapshot?.playerFrozen, undefined);

  harness.runtime.advance(MANHUNT_FREEZE_WARNING_SECONDS * 1_000 - 1);
  assert.equal(harness.frozenPlayers.length, 0);
  harness.runtime.advance(1);
  assert.deepEqual(
    harness.frozenPlayers.map(({ playerId }) => playerId).sort(),
    [...inRangeRunners].sort(),
  );
  assert.equal(
    harness.frozenPlayers.every(
      ({ payload }) =>
        Date.parse(payload.frozenUntil) - Date.parse(payload.frozenAt) ===
        MANHUNT_FREEZE_DURATION_SECONDS * 1_000,
    ),
    true,
  );
  assertAppError(
    () =>
      harness.service.recordLocation(
        harness.roomCode,
        socketIdForPlayer(harness, inRangeRunners[0]!),
        { latitude: 51.5075, longitude: -0.1278 },
        1,
      ),
    "GAME_NOT_READY",
  );

  const firstFrozenState = harness.service.getResumeSnapshot(
    harness.roomCode,
    inRangeRunners[0]!,
  )?.playerFrozen;
  assert.ok(firstFrozenState);
  assert.equal(
    harness.service.getResumeSnapshot(
      harness.roomCode,
      hunterId,
    )?.playerFrozen,
    undefined,
  );
  harness.runtime.advance(3_000);
  assert.equal(
    harness.service.getResumeSnapshot(
      harness.roomCode,
      inRangeRunners[0]!,
    )?.playerFrozen?.frozenUntil,
    firstFrozenState.frozenUntil,
  );
  harness.runtime.advance(
    MANHUNT_FREEZE_DURATION_SECONDS * 1_000 - 3_000 - 1,
  );
  assert.equal(harness.freezeEnds.length, 0);
  harness.runtime.advance(1);
  assert.deepEqual(
    harness.freezeEnds.map(({ playerId }) => playerId).sort(),
    [...inRangeRunners].sort(),
  );
  assert.equal(harness.service.getResumeSnapshot(
    harness.roomCode,
    inRangeRunners[0]!,
  )?.playerFrozen, undefined);
  assert.equal(
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, inRangeRunners[0]!),
      { latitude: 51.5075, longitude: -0.1278 },
      1,
    ).sessionId,
    session.id,
  );
});

test("Freeze selects Hiders within range of any active Hunter", () => {
  const harness = createHarness(5, new ManualRuntime(), {
    freezeRangeMeters: TEST_ONLY_FREEZE_RANGE_METERS,
  });
  const settings = { ...validSettings, hunterCount: 2 };
  harness.service.updateSettings(
    harness.roomCode,
    harness.hostSocket,
    settings,
  );
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  const hunters = harness.assignments
    .filter(({ team }) => team === "hunter")
    .map(({ playerId }) => playerId);
  const runners = harness.assignments
    .filter(({ team }) => team === "runner")
    .map(({ playerId }) => playerId);
  const center = settings.boundary.center;
  for (const [index, hunterId] of hunters.entries()) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, hunterId),
      {
        latitude:
          center.latitude +
          eastOffsetMeters(index === 0 ? 0 : 200),
        longitude: center.longitude,
      },
      1,
    );
  }
  for (const [index, runnerId] of runners.entries()) {
    const distanceMeters = [20, 180, 100][index];
    if (distanceMeters === undefined) {
      throw new Error("The test did not assign a distance to a runner.");
    }
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, runnerId),
      {
        latitude: center.latitude + eastOffsetMeters(distanceMeters),
        longitude: center.longitude,
      },
      1,
    );
  }
  harness.service.activateFreeze(
    harness.roomCode,
    socketIdForPlayer(harness, hunters[0]!),
    session.id,
    FREEZE_REQUEST_ONE,
  );
  assert.deepEqual(
    harness.freezeWarnings.map(({ playerId }) => playerId).sort(),
    [runners[0], runners[1]].sort(),
  );
});

test("Freeze activation IDs are idempotent and overlapping rounds are rejected without a cooldown", () => {
  const harness = createHarness(2, new ManualRuntime(), {
    freezeRangeMeters: TEST_ONLY_FREEZE_RANGE_METERS,
  });
  const { session, hunters, runners } = activateFreezeGame(harness, [1]);
  const hunterSocket = socketIdForPlayer(harness, hunters[0]!);
  const activate = (requestId: string) =>
    harness.service.activateFreeze(
      harness.roomCode,
      hunterSocket,
      session.id,
      requestId,
    );
  activate(FREEZE_REQUEST_ONE);
  assertAppError(() => activate(FREEZE_REQUEST_ONE), "GAME_NOT_READY");
  assertAppError(() => activate(FREEZE_REQUEST_TWO), "GAME_NOT_READY");
  assert.equal(harness.freezeWarnings.length, 1);

  harness.runtime.advance(MANHUNT_FREEZE_WARNING_SECONDS * 1_000);
  assert.deepEqual(
    harness.frozenPlayers.map(({ playerId }) => playerId),
    runners,
  );
  harness.runtime.advance(MANHUNT_FREEZE_DURATION_SECONDS * 1_000);
  assert.deepEqual(
    harness.freezeEnds.map(({ playerId }) => playerId),
    runners,
  );
  assertAppError(() => activate(FREEZE_REQUEST_ONE), "GAME_NOT_READY");
  activate("00000000-0000-4000-8000-000000000003");
  assert.equal(harness.freezeWarnings.length, 2);
});

test("Freeze cleanup handles disconnect, departure, catch, and game end", () => {
  const disconnected = createHarness(2, new ManualRuntime(), {
    freezeRangeMeters: TEST_ONLY_FREEZE_RANGE_METERS,
  });
  const disconnectedGame = activateFreezeGame(disconnected, [20]);
  const disconnectedRunner = disconnectedGame.runners[0]!;
  disconnected.service.activateFreeze(
    disconnected.roomCode,
    socketIdForPlayer(disconnected, disconnectedGame.hunters[0]!),
    disconnectedGame.session.id,
    FREEZE_REQUEST_ONE,
  );
  disconnected.service.onPlayerDisconnected(
    disconnected.roomCode,
    disconnectedRunner,
  );
  assert.equal(
    disconnected.service.getResumeSnapshot(
      disconnected.roomCode,
      disconnectedRunner,
    )?.freezeWarning,
    undefined,
  );
  disconnected.runtime.runCancelledCallbacks();
  disconnected.runtime.advance(MANHUNT_FREEZE_WARNING_SECONDS * 1_000);
  assert.equal(disconnected.frozenPlayers.length, 0);

  const departed = createHarness(2, new ManualRuntime(), {
    freezeRangeMeters: TEST_ONLY_FREEZE_RANGE_METERS,
  });
  const departedGame = activateFreezeGame(departed, [20]);
  departed.service.activateFreeze(
    departed.roomCode,
    socketIdForPlayer(departed, departedGame.hunters[0]!),
    departedGame.session.id,
    FREEZE_REQUEST_TWO,
  );
  removePlayer(departed, departedGame.runners[0]!);
  assert.equal(departed.ended.length, 1);
  departed.runtime.runCancelledCallbacks();
  departed.runtime.advance(MANHUNT_FREEZE_WARNING_SECONDS * 1_000);
  assert.equal(departed.frozenPlayers.length, 0);

  const caught = createHarness(2, new ManualRuntime(), {
    freezeRangeMeters: TEST_ONLY_FREEZE_RANGE_METERS,
  });
  const caughtGame = activateFreezeGame(caught, [1]);
  const hunterId = caughtGame.hunters[0]!;
  const runnerId = caughtGame.runners[0]!;
  caught.service.activateFreeze(
    caught.roomCode,
    socketIdForPlayer(caught, hunterId),
    caughtGame.session.id,
    "00000000-0000-4000-8000-000000000003",
  );
  caught.runtime.advance(MANHUNT_FREEZE_WARNING_SECONDS * 1_000);
  const catchRequest = caught.service.attemptCatch(
    caught.roomCode,
    socketIdForPlayer(caught, hunterId),
    runnerId,
  );
  caught.service.respondToCatch(
    caught.roomCode,
    socketIdForPlayer(caught, runnerId),
    catchRequest.requestId,
    true,
  );
  assert.equal(caught.freezeEnds.length, 1);
  assert.equal(caught.ended.length, 1);
  caught.runtime.runCancelledCallbacks();
  caught.runtime.advance(MANHUNT_FREEZE_DURATION_SECONDS * 1_000);
  assert.equal(caught.freezeEnds.length, 1);
});

test("Footsteps requires an active Hunter after release", () => {
  const countdown = createHarness(2, new ManualRuntime());
  countdown.service.updateSettings(
    countdown.roomCode,
    countdown.hostSocket,
    validSettings,
  );
  const countdownSession = countdown.service.startGame(
    countdown.roomCode,
    countdown.hostSocket,
  );
  const countdownHunter = countdown.assignments.find(
    ({ team }) => team === "hunter",
  )!.playerId;
  assertAppError(
    () =>
      countdown.service.activateFootsteps(
        countdown.roomCode,
        socketIdForPlayer(countdown, countdownHunter),
        countdownSession.id,
        FOOTSTEPS_REQUESTS[0]!,
      ),
    "GAME_NOT_ACTIVE",
  );

  const active = createHarness(2, new ManualRuntime());
  const { session, hunters, runners } = activateFreezeGame(active, [20]);
  assertAppError(
    () =>
      active.service.activateFootsteps(
        active.roomCode,
        socketIdForPlayer(active, runners[0]!),
        session.id,
        FOOTSTEPS_REQUESTS[0]!,
      ),
    "NOT_AUTHORIZED",
  );
  assert.equal(hunters.length, 1);

  const caught = createHarness(3, new ManualRuntime());
  const caughtGame = activateFreezeGame(caught, [1, 20]);
  const caughtRunner = caughtGame.runners[0]!;
  const catchRequest = caught.service.attemptCatch(
    caught.roomCode,
    socketIdForPlayer(caught, caughtGame.hunters[0]!),
    caughtRunner,
  );
  caught.service.respondToCatch(
    caught.roomCode,
    socketIdForPlayer(caught, caughtRunner),
    catchRequest.requestId,
    true,
  );
  assertAppError(
    () =>
      caught.service.activateFootsteps(
        caught.roomCode,
        socketIdForPlayer(caught, caughtRunner),
        caughtGame.session.id,
        FOOTSTEPS_REQUESTS[1]!,
      ),
    "NOT_AUTHORIZED",
  );
});

test("Footsteps points toward the nearest eligible Hider without exposing identity or coordinates", () => {
  const harness = createHarness(4, new ManualRuntime());
  const { session, hunters, runners, center } = activateFreezeGame(
    harness,
    [40, 20, 60],
  );
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, runners[0]!),
    {
      latitude: center.latitude + eastOffsetMeters(40),
      longitude: center.longitude,
    },
    1,
  );
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, runners[1]!),
    {
      latitude: center.latitude,
      longitude:
        center.longitude + longitudeOffsetMeters(10, center.latitude),
    },
    1,
  );
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, runners[2]!),
    {
      latitude: center.latitude - eastOffsetMeters(20),
      longitude: center.longitude,
    },
    1,
  );

  const hunterId = hunters[0]!;
  harness.service.activateFootsteps(
    harness.roomCode,
    socketIdForPlayer(harness, hunterId),
    session.id,
    FOOTSTEPS_REQUESTS[0]!,
  );
  const state = harness.footstepsStates.at(-1)!.payload;
  const guidance = state.guidances[0]!;

  assert.equal(state.playerId, hunterId);
  assert.equal(state.remainingUses, MANHUNT_FOOTSTEPS_MAX_USES_PER_GAME - 1);
  assert.ok(Math.abs(guidance.bearingDegrees - 90) < 1);
  assert.equal(
    Date.parse(guidance.expiresAt) - Date.parse(guidance.startedAt),
    MANHUNT_FOOTSTEPS_DURATION_SECONDS * 1_000,
  );
  assert.deepEqual(
    Object.keys(guidance).sort(),
    ["bearingDegrees", "expiresAt", "requestId", "startedAt"].sort(),
  );
  const serializedState = JSON.stringify(state);
  assert.ok(runners.every((runnerId) => !serializedState.includes(runnerId)));
  assert.equal(serializedState.includes("latitude"), false);
  assert.equal(serializedState.includes("longitude"), false);
});

test("Footsteps rejects inaccurate, stale, and unavailable Hider locations", () => {
  const inaccurate = createHarness(2, new ManualRuntime());
  const inaccurateGame = activateFreezeGame(inaccurate, [10]);
  inaccurate.service.recordLocation(
    inaccurate.roomCode,
    socketIdForPlayer(inaccurate, inaccurateGame.hunters[0]!),
    inaccurateGame.center,
    1,
  );
  inaccurate.service.recordLocation(
    inaccurate.roomCode,
    socketIdForPlayer(inaccurate, inaccurateGame.runners[0]!),
    inaccurateGame.center,
    MANHUNT_MISSION_MAX_ACCURACY_METERS + 1,
  );
  assertAppError(
    () =>
      inaccurate.service.activateFootsteps(
        inaccurate.roomCode,
        socketIdForPlayer(inaccurate, inaccurateGame.hunters[0]!),
        inaccurateGame.session.id,
        FOOTSTEPS_REQUESTS[0]!,
      ),
    "GAME_NOT_READY",
  );

  const stale = createHarness(2, new ManualRuntime());
  const staleGame = activateFreezeGame(stale, [10]);
  stale.runtime.advance((MANHUNT_LOCATION_MAX_AGE_SECONDS + 1) * 1_000);
  stale.service.recordLocation(
    stale.roomCode,
    socketIdForPlayer(stale, staleGame.hunters[0]!),
    staleGame.center,
    1,
  );
  assertAppError(
    () =>
      stale.service.activateFootsteps(
        stale.roomCode,
        socketIdForPlayer(stale, staleGame.hunters[0]!),
        staleGame.session.id,
        FOOTSTEPS_REQUESTS[0]!,
      ),
    "GAME_NOT_READY",
  );

  const unavailable = createHarness(2, new ManualRuntime());
  const unavailableGame = activateFreezeGame(unavailable, [10]);
  unavailable.service.onPlayerDisconnected(
    unavailable.roomCode,
    unavailableGame.runners[0]!,
  );
  assertAppError(
    () =>
      unavailable.service.activateFootsteps(
        unavailable.roomCode,
        socketIdForPlayer(unavailable, unavailableGame.hunters[0]!),
        unavailableGame.session.id,
        FOOTSTEPS_REQUESTS[0]!,
      ),
    "GAME_NOT_READY",
  );
});

test("Footsteps enforces three server-owned uses per Hunter and rejects replayed IDs", () => {
  const harness = createHarness(5, new ManualRuntime());
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, {
    ...validSettings,
    hunterCount: 2,
  });
  const session = startActiveGame(harness);
  const hunters = harness.assignments
    .filter(({ team }) => team === "hunter")
    .map(({ playerId }) => playerId);
  for (const playerId of harness.playerIds) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, playerId),
      validSettings.boundary.center,
      1,
    );
  }
  const activate = (hunterId: string, requestId: string) =>
    harness.service.activateFootsteps(
      harness.roomCode,
      socketIdForPlayer(harness, hunterId),
      session.id,
      requestId,
    );
  activate(hunters[0]!, FOOTSTEPS_REQUESTS[0]!);
  assertAppError(
    () => activate(hunters[0]!, FOOTSTEPS_REQUESTS[0]!),
    "GAME_NOT_READY",
  );
  activate(hunters[1]!, FOOTSTEPS_REQUESTS[0]!);
  activate(hunters[0]!, FOOTSTEPS_REQUESTS[1]!);
  activate(hunters[0]!, FOOTSTEPS_REQUESTS[2]!);
  assertAppError(
    () => activate(hunters[0]!, FOOTSTEPS_REQUESTS[3]!),
    "GAME_NOT_READY",
  );

  const firstHunterState = harness.footstepsStates
    .filter(({ playerId }) => playerId === hunters[0])
    .at(-1)!.payload;
  const secondHunterState = harness.footstepsStates
    .filter(({ playerId }) => playerId === hunters[1])
    .at(-1)!.payload;
  assert.equal(firstHunterState.remainingUses, 0);
  assert.equal(
    secondHunterState.remainingUses,
    MANHUNT_FOOTSTEPS_MAX_USES_PER_GAME - 1,
  );
  assert.equal(firstHunterState.guidances.length, 3);

  harness.runtime.advance(
    MANHUNT_FOOTSTEPS_DURATION_SECONDS * 1_000 - 1,
  );
  assert.equal(harness.footstepsStates.at(-1)!.payload.guidances.length, 3);
  harness.runtime.advance(1);
  assert.equal(harness.footstepsStates.at(-1)!.payload.guidances.length, 0);
  assertAppError(
    () => activate(hunters[0]!, FOOTSTEPS_REQUESTS[0]!),
    "GAME_NOT_READY",
  );
});

test("Footsteps reconnect preserves uses and original guidance deadlines", () => {
  const harness = createHarness(2, new ManualRuntime());
  const { session, hunters } = activateFreezeGame(harness, [10]);
  const hunterId = hunters[0]!;
  const hunterSocket = socketIdForPlayer(harness, hunterId);
  harness.service.activateFootsteps(
    harness.roomCode,
    hunterSocket,
    session.id,
    FOOTSTEPS_REQUESTS[0]!,
  );
  const original = harness.footstepsStates.at(-1)!.payload.guidances[0]!;

  harness.rooms.disconnectSocket(hunterSocket);
  harness.service.onPlayerDisconnected(harness.roomCode, hunterId);
  harness.rooms.reconnect(
    {
      roomCode: harness.roomCode,
      playerId: hunterId,
      reconnectToken: harness.reconnectTokens[harness.playerIds.indexOf(hunterId)]!,
    },
    "hunter-reconnected",
  );
  const resumed = harness.service.getResumeSnapshot(
    harness.roomCode,
    hunterId,
  )?.footsteps;
  assert.equal(resumed?.remainingUses, MANHUNT_FOOTSTEPS_MAX_USES_PER_GAME - 1);
  assert.equal(resumed?.guidances[0]?.expiresAt, original.expiresAt);
  assert.equal(resumed?.guidances[0]?.startedAt, original.startedAt);

  harness.runtime.advance(1_000);
  const stillActive = harness.service.getResumeSnapshot(
    harness.roomCode,
    hunterId,
  )?.footsteps;
  assert.equal(stillActive?.remainingUses, MANHUNT_FOOTSTEPS_MAX_USES_PER_GAME - 1);
  assert.equal(stillActive?.guidances[0]?.expiresAt, original.expiresAt);
});

test("Footsteps timers are cancelled on Hunter departure and game end", () => {
  const departed = createHarness(2, new ManualRuntime());
  const departedGame = activateFreezeGame(departed, [10]);
  const hunterId = departedGame.hunters[0]!;
  const timersBefore = departed.runtime.pendingTimerCount;
  departed.service.activateFootsteps(
    departed.roomCode,
    socketIdForPlayer(departed, hunterId),
    departedGame.session.id,
    FOOTSTEPS_REQUESTS[0]!,
  );
  assert.equal(departed.runtime.pendingTimerCount, timersBefore + 1);
  removePlayer(departed, hunterId);
  assert.equal(departed.runtime.pendingTimerCount, timersBefore);
  assert.equal(
    departed.service.getResumeSnapshot(departed.roomCode, hunterId),
    undefined,
  );
  const emittedBeforeCancelledCallback = departed.footstepsStates.length;
  departed.runtime.runCancelledCallbacks();
  assert.equal(departed.footstepsStates.length, emittedBeforeCancelledCallback);

  const caught = createHarness(2, new ManualRuntime());
  const caughtGame = activateFreezeGame(caught, [1]);
  const caughtHunter = caughtGame.hunters[0]!;
  const caughtRunner = caughtGame.runners[0]!;
  caught.service.activateFootsteps(
    caught.roomCode,
    socketIdForPlayer(caught, caughtHunter),
    caughtGame.session.id,
    FOOTSTEPS_REQUESTS[1]!,
  );
  const catchRequest = caught.service.attemptCatch(
    caught.roomCode,
    socketIdForPlayer(caught, caughtHunter),
    caughtRunner,
  );
  caught.service.respondToCatch(
    caught.roomCode,
    socketIdForPlayer(caught, caughtRunner),
    catchRequest.requestId,
    true,
  );
  assert.equal(caught.ended.length, 1);
  assert.equal(
    caught.service.getResumeSnapshot(caught.roomCode, caughtHunter)?.footsteps,
    undefined,
  );
  assertAppError(
    () =>
      caught.service.activateFootsteps(
        caught.roomCode,
        socketIdForPlayer(caught, caughtHunter),
        caughtGame.session.id,
        FOOTSTEPS_REQUESTS[2]!,
      ),
    "GAME_NOT_ACTIVE",
  );
  const emittedBeforeGameEndCallback = caught.footstepsStates.length;
  caught.runtime.runCancelledCallbacks();
  assert.equal(caught.footstepsStates.length, emittedBeforeGameEndCallback);
});

test("Smoke Bomb requires an active Hider and rejects countdown, Hunters, and caught players", () => {
  const countdown = createHarness(2, new ManualRuntime());
  countdown.service.updateSettings(
    countdown.roomCode,
    countdown.hostSocket,
    validSettings,
  );
  const countdownSession = countdown.service.startGame(
    countdown.roomCode,
    countdown.hostSocket,
  );
  const countdownHider = countdown.assignments.find(
    ({ team }) => team === "runner",
  )!.playerId;
  assertAppError(
    () =>
      countdown.service.activateSmokeBomb(
        countdown.roomCode,
        socketIdForPlayer(countdown, countdownHider),
        countdownSession.id,
        SMOKE_BOMB_REQUESTS[0]!,
      ),
    "GAME_NOT_ACTIVE",
  );

  const active = createHarness(3, new ManualRuntime());
  const { session, hunters, runners } = activateFreezeGame(active, [1, 20]);
  assertAppError(
    () =>
      active.service.activateSmokeBomb(
        active.roomCode,
        socketIdForPlayer(active, hunters[0]!),
        session.id,
        SMOKE_BOMB_REQUESTS[0]!,
      ),
    "NOT_AUTHORIZED",
  );

  const catchRequest = active.service.attemptCatch(
    active.roomCode,
    socketIdForPlayer(active, hunters[0]!),
    runners[0]!,
  );
  active.service.respondToCatch(
    active.roomCode,
    socketIdForPlayer(active, runners[0]!),
    catchRequest.requestId,
    true,
  );
  assertAppError(
    () =>
      active.service.activateSmokeBomb(
        active.roomCode,
        socketIdForPlayer(active, runners[0]!),
        session.id,
        SMOKE_BOMB_REQUESTS[0]!,
      ),
    "NOT_AUTHORIZED",
  );
});

test("Smoke Bomb enforces three per-game uses, rejects replay, and expires at ten seconds", () => {
  const harness = createHarness(4, new ManualRuntime());
  const { session, runners } = activateFreezeGame(harness, [20, 40, 60]);
  const hiderId = runners[0]!;
  const activate = (requestId: string) =>
    harness.service.activateSmokeBomb(
      harness.roomCode,
      socketIdForPlayer(harness, hiderId),
      session.id,
      requestId,
    );

  activate(SMOKE_BOMB_REQUESTS[0]!);
  const first = harness.smokeBombStates.at(-1)!.payload;
  assert.equal(first.remainingUses, MANHUNT_SMOKE_BOMB_MAX_USES_PER_GAME - 1);
  assert.equal(first.activeEffects.length, 1);
  assert.equal(
    Date.parse(first.activeEffects[0]!.expiresAt) -
      Date.parse(first.activeEffects[0]!.startedAt),
    MANHUNT_SMOKE_BOMB_DURATION_SECONDS * 1_000,
  );
  assertAppError(
    () => activate(SMOKE_BOMB_REQUESTS[0]!),
    "GAME_NOT_READY",
  );
  activate(SMOKE_BOMB_REQUESTS[1]!);
  activate(SMOKE_BOMB_REQUESTS[2]!);
  assertAppError(
    () => activate(SMOKE_BOMB_REQUESTS[3]!),
    "GAME_NOT_READY",
  );

  const stateBeforeExpiry = harness.smokeBombStates.at(-1)!.payload;
  assert.equal(stateBeforeExpiry.remainingUses, 0);
  assert.equal(stateBeforeExpiry.activeEffects.length, 3);
  harness.runtime.advance(
    MANHUNT_SMOKE_BOMB_DURATION_SECONDS * 1_000 - 1,
  );
  assert.equal(harness.smokeBombStates.at(-1)!.payload.activeEffects.length, 3);
  harness.runtime.advance(1);
  assert.equal(harness.smokeBombStates.at(-1)!.payload.activeEffects.length, 0);
  assertAppError(
    () => activate(SMOKE_BOMB_REQUESTS[0]!),
    "GAME_NOT_READY",
  );
});

test("Smoke Bomb reconnect preserves uses and the original expiry deadline", () => {
  const harness = createHarness(2, new ManualRuntime());
  const { session, runners } = activateFreezeGame(harness, [10]);
  const hiderId = runners[0]!;
  const hiderSocket = socketIdForPlayer(harness, hiderId);
  harness.service.activateSmokeBomb(
    harness.roomCode,
    hiderSocket,
    session.id,
    SMOKE_BOMB_REQUESTS[0]!,
  );
  const original = harness.smokeBombStates.at(-1)!.payload.activeEffects[0]!;

  harness.rooms.disconnectSocket(hiderSocket);
  harness.service.onPlayerDisconnected(harness.roomCode, hiderId);
  harness.rooms.reconnect(
    {
      roomCode: harness.roomCode,
      playerId: hiderId,
      reconnectToken:
        harness.reconnectTokens[harness.playerIds.indexOf(hiderId)]!,
    },
    "hider-reconnected",
  );
  const resumed = harness.service.getResumeSnapshot(
    harness.roomCode,
    hiderId,
  )?.smokeBomb;
  assert.equal(
    resumed?.remainingUses,
    MANHUNT_SMOKE_BOMB_MAX_USES_PER_GAME - 1,
  );
  assert.equal(resumed?.activeEffects[0]?.startedAt, original.startedAt);
  assert.equal(resumed?.activeEffects[0]?.expiresAt, original.expiresAt);

  harness.runtime.advance(3_000);
  const stillActive = harness.service.getResumeSnapshot(
    harness.roomCode,
    hiderId,
  )?.smokeBomb;
  assert.equal(stillActive?.remainingUses, resumed?.remainingUses);
  assert.equal(stillActive?.activeEffects[0]?.expiresAt, original.expiresAt);
});

test("Smoke Bomb filters only future Hunter location flashes and preserves mission reveals", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime);
  const { session, hunters, runners } = activateFreezeGame(
    harness,
    [20, 40, 60],
  );
  harness.smokeBombStates.length = 0;
  const hunterId = hunters[0]!;
  const hiderId = runners[0]!;
  const openRevealWindow = Reflect.get(
    harness.service,
    "openRevealWindow",
  );
  assert.equal(typeof openRevealWindow, "function");

  Reflect.apply(openRevealWindow, harness.service, [harness.roomCode]);
  const priorHunterFlash = harness.flashes.find(
    ({ playerId }) => playerId === hunterId,
  )!.payload;
  const priorHiddenMarker = priorHunterFlash.locations.find(
    ({ playerId }) => playerId === hiderId,
  );
  assert.ok(priorHiddenMarker);

  harness.service.activateSmokeBomb(
    harness.roomCode,
    socketIdForPlayer(harness, hiderId),
    session.id,
    SMOKE_BOMB_REQUESTS[0]!,
  );
  Reflect.apply(openRevealWindow, harness.service, [harness.roomCode]);

  const hunterFlash = harness.flashes
    .filter(({ playerId }) => playerId === hunterId)
    .at(-1)!.payload;
  const hiderFlash = harness.flashes
    .filter(({ playerId }) => playerId === hiderId)
    .at(-1)!.payload;
  assert.equal(
    hunterFlash.locations.some(({ playerId }) => playerId === hiderId),
    false,
  );
  assert.equal(
    hunterFlash.locations.some(({ playerId }) => playerId === runners[1]),
    true,
  );
  assert.equal(
    hiderFlash.locations.some(({ playerId }) => playerId === hiderId),
    true,
  );
  assert.deepEqual(
    priorHunterFlash.locations.find(({ playerId }) => playerId === hiderId),
    priorHiddenMarker,
  );
  assert.equal(
    harness.smokeBombStates.every(({ playerId }) => playerId === hiderId),
    true,
  );

  const missionRuntime = new ManualRuntime();
  const missionHarness = createHarness(4, missionRuntime, {
    missionRandomInt: missionRandomForTest(2),
  });
  const { session: missionSession, hiders, hunters: missionHunters } =
    activateMissionGame(missionHarness);
  missionRuntime.advance(1_000);
  const selected = missionHarness.missionAssignments.map(
    ({ playerId, payload }) => [playerId, payload.center] as const,
  );
  assert.equal(selected.length, 2);
  const locations = new Map(
    selected.map(([playerId, center]) => [playerId, center]),
  );
  for (const hunter of missionHunters) {
    missionHarness.service.recordLocation(
      missionHarness.roomCode,
      socketIdForPlayer(missionHarness, hunter),
      validSettings.boundary.center,
      1,
    );
  }
  recordMissionLocations(missionHarness, locations);
  missionRuntime.advance(5_000);
  missionHarness.service.activateSmokeBomb(
    missionHarness.roomCode,
    socketIdForPlayer(missionHarness, selected[0]![0]),
    missionSession.id,
    SMOKE_BOMB_REQUESTS[1]!,
  );
  recordMissionLocations(missionHarness, locations);
  missionRuntime.advance(5_000);

  assert.equal(missionHarness.missionReveals.length, 1);
  assert.deepEqual(
    missionHarness.missionReveals[0]?.playerIds.sort(),
    [...hiders].sort(),
  );
  assert.deepEqual(
    missionHarness.missionReveals[0]?.payload.locations.map(
      ({ playerId }) => playerId,
    ),
    missionHunters,
  );
  assert.equal(
    missionHarness.service
      .getResumeSnapshot(missionHarness.roomCode, selected[0]![0])
      ?.smokeBomb?.activeEffects.length,
    1,
  );
});

test("Smoke Bomb leaves catch and proximity checks on server-held locations", () => {
  const harness = createHarness(3, new ManualRuntime());
  const { session, hunters, runners, center } = activateFreezeGame(
    harness,
    [20, 40],
  );
  const hunterId = hunters[0]!;
  const hiderId = runners[0]!;
  harness.service.activateSmokeBomb(
    harness.roomCode,
    socketIdForPlayer(harness, hiderId),
    session.id,
    SMOKE_BOMB_REQUESTS[0]!,
  );
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, hiderId),
    {
      latitude: center.latitude + eastOffsetMeters(9),
      longitude: center.longitude,
    },
    1,
  );
  assert.equal(
    harness.proximityAlerts.some(
      ({ playerId }) => playerId === hiderId || playerId === hunterId,
    ),
    true,
  );
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, hiderId),
    {
      latitude: center.latitude + eastOffsetMeters(1.4),
      longitude: center.longitude,
    },
    1,
  );

  const catchRequest = harness.service.attemptCatch(
    harness.roomCode,
    socketIdForPlayer(harness, hunterId),
    hiderId,
  );
  harness.service.respondToCatch(
    harness.roomCode,
    socketIdForPlayer(harness, hiderId),
    catchRequest.requestId,
    true,
  );
  assert.equal(harness.catchConfirmed.length, 1);
  assert.equal(
    harness.service.getResumeSnapshot(harness.roomCode, hiderId)?.smokeBomb,
    undefined,
  );
});

test("Smoke Bomb timers are cleared on departure, catch-driven game end, and session cleanup", () => {
  const departed = createHarness(3, new ManualRuntime());
  const departedGame = activateFreezeGame(departed, [20, 40]);
  const departedHider = departedGame.runners[0]!;
  const timersBeforeDeparture = departed.runtime.pendingTimerCount;
  departed.service.activateSmokeBomb(
    departed.roomCode,
    socketIdForPlayer(departed, departedHider),
    departedGame.session.id,
    SMOKE_BOMB_REQUESTS[0]!,
  );
  assert.equal(
    departed.runtime.pendingTimerCount,
    timersBeforeDeparture + 1,
  );
  removePlayer(departed, departedHider);
  assert.equal(
    departed.runtime.pendingTimerCount,
    timersBeforeDeparture,
  );
  assert.equal(
    departed.service.getResumeSnapshot(departed.roomCode, departedHider),
    undefined,
  );
  departed.service.clearSession(departed.roomCode);
  assert.equal(departed.runtime.pendingTimerCount, 0);

  const ended = createHarness(2, new ManualRuntime());
  const endedGame = activateFreezeGame(ended, [1]);
  const hunterId = endedGame.hunters[0]!;
  const hiderId = endedGame.runners[0]!;
  ended.service.activateSmokeBomb(
    ended.roomCode,
    socketIdForPlayer(ended, hiderId),
    endedGame.session.id,
    SMOKE_BOMB_REQUESTS[1]!,
  );
  const catchRequest = ended.service.attemptCatch(
    ended.roomCode,
    socketIdForPlayer(ended, hunterId),
    hiderId,
  );
  ended.service.respondToCatch(
    ended.roomCode,
    socketIdForPlayer(ended, hiderId),
    catchRequest.requestId,
    true,
  );
  assert.equal(ended.ended.length, 1);
  assert.equal(
    ended.service.getResumeSnapshot(ended.roomCode, hiderId)?.smokeBomb,
    undefined,
  );
  assert.equal(ended.runtime.pendingTimerCount, 0);
});

test("Ghost stays fail-closed without a configured limit and rejects unauthorized activation", () => {
  const countdown = createHarness(2, new ManualRuntime());
  countdown.service.updateSettings(
    countdown.roomCode,
    countdown.hostSocket,
    validSettings,
  );
  const countdownSession = countdown.service.startGame(
    countdown.roomCode,
    countdown.hostSocket,
  );
  const countdownHider = countdown.assignments.find(
    ({ team }) => team === "runner",
  )!.playerId;
  assertAppError(
    () =>
      countdown.service.activateGhost(
        countdown.roomCode,
        socketIdForPlayer(countdown, countdownHider),
        countdownSession.id,
        GHOST_REQUESTS[0]!,
      ),
    "GAME_NOT_ACTIVE",
  );

  const active = createHarness(4, new ManualRuntime());
  const { session, hunters, runners } = activateFreezeGame(active, [20, 40, 60]);
  const hiderId = runners[0]!;
  const hiderState = active.service
    .getResumeSnapshot(active.roomCode, hiderId)?.ghost;
  assert.equal(hiderState?.usageLimit, null);
  assert.equal(hiderState?.remainingUses, null);
  assert.deepEqual(hiderState?.activeEffects, []);

  assertAppError(
    () =>
      active.service.activateGhost(
        active.roomCode,
        socketIdForPlayer(active, hunters[0]!),
        session.id,
        GHOST_REQUESTS[0]!,
      ),
    "NOT_AUTHORIZED",
  );
  assertAppError(
    () =>
      active.service.activateGhost(
        active.roomCode,
        socketIdForPlayer(active, hiderId),
        session.id,
        GHOST_REQUESTS[0]!,
      ),
    "GAME_NOT_READY",
  );

  active.service.recordLocation(
    active.roomCode,
    socketIdForPlayer(active, hiderId),
    {
      latitude: validSettings.boundary.center.latitude + eastOffsetMeters(1),
      longitude: validSettings.boundary.center.longitude,
    },
    1,
  );
  const catchRequest = active.service.attemptCatch(
    active.roomCode,
    socketIdForPlayer(active, hunters[0]!),
    hiderId,
  );
  active.service.respondToCatch(
    active.roomCode,
    socketIdForPlayer(active, hiderId),
    catchRequest.requestId,
    true,
  );
  assertAppError(
    () =>
      active.service.activateGhost(
        active.roomCode,
        socketIdForPlayer(active, hiderId),
        session.id,
        GHOST_REQUESTS[1]!,
      ),
    "NOT_AUTHORIZED",
  );
});

test("Ghost enforces its test-only per-game limit, rejects replay, and expires at fifteen seconds", () => {
  const harness = createHarness(2, new ManualRuntime(), {
    ghostUsageLimit: TEST_ONLY_GHOST_USAGE_LIMIT,
  });
  const { session, runners } = activateFreezeGame(harness, [20]);
  const hiderId = runners[0]!;
  const activate = (requestId: string) =>
    harness.service.activateGhost(
      harness.roomCode,
      socketIdForPlayer(harness, hiderId),
      session.id,
      requestId,
    );

  activate(GHOST_REQUESTS[0]!);
  const first = harness.ghostStates.at(-1)!.payload;
  assert.equal(first.usageLimit, TEST_ONLY_GHOST_USAGE_LIMIT);
  assert.equal(first.remainingUses, TEST_ONLY_GHOST_USAGE_LIMIT - 1);
  assert.equal(first.activeEffects.length, 1);
  assert.equal(
    Date.parse(first.activeEffects[0]!.expiresAt) -
      Date.parse(first.activeEffects[0]!.startedAt),
    MANHUNT_GHOST_DURATION_SECONDS * 1_000,
  );
  assertAppError(() => activate(GHOST_REQUESTS[0]!), "GAME_NOT_READY");

  activate(GHOST_REQUESTS[1]!);
  assert.equal(harness.ghostStates.at(-1)!.payload.remainingUses, 0);
  assert.equal(harness.ghostStates.at(-1)!.payload.activeEffects.length, 2);
  assertAppError(() => activate(GHOST_REQUESTS[2]!), "GAME_NOT_READY");

  harness.runtime.advance(MANHUNT_GHOST_DURATION_SECONDS * 1_000 - 1);
  assert.equal(harness.ghostStates.at(-1)!.payload.activeEffects.length, 2);
  harness.runtime.advance(1);
  assert.equal(harness.ghostStates.at(-1)!.payload.activeEffects.length, 0);
  assert.equal(harness.ghostStates.at(-1)!.payload.remainingUses, 0);
  assertAppError(() => activate(GHOST_REQUESTS[0]!), "GAME_NOT_READY");
});

test("Ghost filters future Hunter flashes without changing Hider updates or prior markers", () => {
  const harness = createHarness(4, new ManualRuntime(), {
    ghostUsageLimit: TEST_ONLY_GHOST_USAGE_LIMIT,
  });
  const { session, runners } = activateFreezeGame(harness, [20, 40, 60]);
  const hiderId = runners[0]!;
  const openRevealWindow = Reflect.get(
    harness.service,
    "openRevealWindow",
  );
  assert.equal(typeof openRevealWindow, "function");

  Reflect.apply(openRevealWindow, harness.service, [harness.roomCode]);
  const previousHunterFlash = harness.flashes.find(
    ({ playerId }) =>
      playerId !== hiderId &&
      harness.assignments.find((assignment) => assignment.playerId === playerId)
        ?.team === "hunter",
  )!.payload;
  const previousMarker = previousHunterFlash.locations.find(
    ({ playerId }) => playerId === hiderId,
  );
  assert.ok(previousMarker);

  harness.service.activateGhost(
    harness.roomCode,
    socketIdForPlayer(harness, hiderId),
    session.id,
    GHOST_REQUESTS[0]!,
  );
  Reflect.apply(openRevealWindow, harness.service, [harness.roomCode]);

  const hunterId = harness.assignments.find(
    ({ team }) => team === "hunter",
  )!.playerId;
  const hunterFlash = harness.flashes
    .filter(({ playerId }) => playerId === hunterId)
    .at(-1)!.payload;
  const hiderFlash = harness.flashes
    .filter(({ playerId }) => playerId === hiderId)
    .at(-1)!.payload;
  const otherHiderFlash = harness.flashes
    .filter(({ playerId }) => playerId === runners[1])
    .at(-1)!.payload;
  assert.equal(
    hunterFlash.locations.some(({ playerId }) => playerId === hiderId),
    false,
  );
  assert.equal(
    hunterFlash.locations.some(({ playerId }) => playerId === runners[1]),
    true,
  );
  assert.equal(
    hiderFlash.locations.some(({ playerId }) => playerId === hiderId),
    true,
  );
  assert.equal(
    otherHiderFlash.locations.some(({ playerId }) => playerId === hiderId),
    true,
  );
  assert.deepEqual(
    previousHunterFlash.locations.find(({ playerId }) => playerId === hiderId),
    previousMarker,
  );
  assert.equal(
    harness.ghostStates.every(({ playerId }) => runners.includes(playerId)),
    true,
  );
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, hiderId),
    {
      latitude:
        validSettings.boundary.center.latitude + eastOffsetMeters(9),
      longitude: validSettings.boundary.center.longitude,
    },
    1,
  );
  assert.equal(
    harness.proximityAlerts.some(({ playerId }) => playerId === hiderId),
    true,
  );
});

test("Ghost does not change mission reveal recipients or payloads", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime, {
    missionRandomInt: missionRandomForTest(2),
    ghostUsageLimit: TEST_ONLY_GHOST_USAGE_LIMIT,
  });
  const { session, hiders, hunters } = activateMissionGame(harness);
  runtime.advance(1_000);
  const selected = harness.missionAssignments.map(
    ({ playerId, payload }) => [playerId, payload.center] as const,
  );
  assert.equal(selected.length, 2);
  const locations = new Map(
    selected.map(([playerId, center]) => [playerId, center]),
  );
  for (const hunterId of hunters) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, hunterId),
      validSettings.boundary.center,
      1,
    );
  }
  recordMissionLocations(harness, locations);
  runtime.advance(5_000);
  harness.service.activateGhost(
    harness.roomCode,
    socketIdForPlayer(harness, selected[0]![0]),
    session.id,
    GHOST_REQUESTS[0]!,
  );
  recordMissionLocations(harness, locations);
  runtime.advance(5_000);

  assert.equal(harness.missionReveals.length, 1);
  assert.deepEqual(
    harness.missionReveals[0]?.playerIds.sort(),
    [...hiders].sort(),
  );
  assert.deepEqual(
    harness.missionReveals[0]?.payload.locations.map(
      ({ playerId }) => playerId,
    ),
    hunters,
  );
});

test("Ghost and Smoke Bomb expirations remain independent in either order", () => {
  for (const scenario of [
    { first: "ghost", secondDelayMs: 8_000 },
    { first: "smoke", secondDelayMs: 5_000 },
  ] as const) {
    const harness = createHarness(3, new ManualRuntime(), {
      ghostUsageLimit: TEST_ONLY_GHOST_USAGE_LIMIT,
    });
    const { session, hunters, runners } = activateFreezeGame(harness, [20, 40]);
    const hiderId = runners[0]!;
    const hiderSocket = socketIdForPlayer(harness, hiderId);
    const activateGhost = () =>
      harness.service.activateGhost(
        harness.roomCode,
        hiderSocket,
        session.id,
        GHOST_REQUESTS[0]!,
      );
    const activateSmokeBomb = () =>
      harness.service.activateSmokeBomb(
        harness.roomCode,
        hiderSocket,
        session.id,
        SMOKE_BOMB_REQUESTS[0]!,
      );
    if (scenario.first === "ghost") {
      activateGhost();
    } else {
      activateSmokeBomb();
    }
    harness.runtime.advance(scenario.secondDelayMs);
    if (scenario.first === "ghost") {
      activateSmokeBomb();
    } else {
      activateGhost();
    }

    const firstExpiryDelay =
      scenario.first === "ghost"
        ? MANHUNT_GHOST_DURATION_SECONDS * 1_000 - scenario.secondDelayMs
        : MANHUNT_SMOKE_BOMB_DURATION_SECONDS * 1_000 -
          scenario.secondDelayMs;
    harness.runtime.advance(firstExpiryDelay);
    const openRevealWindow = Reflect.get(
      harness.service,
      "openRevealWindow",
    );
    Reflect.apply(openRevealWindow, harness.service, [harness.roomCode]);
    const hunterFlash = harness.flashes
      .filter(({ playerId }) => playerId === hunters[0])
      .at(-1)!.payload;
    assert.equal(
      hunterFlash.locations.some(({ playerId }) => playerId === hiderId),
      false,
    );

    const remainingEffectMs =
      scenario.first === "ghost"
        ? MANHUNT_SMOKE_BOMB_DURATION_SECONDS * 1_000 -
          (MANHUNT_GHOST_DURATION_SECONDS * 1_000 - scenario.secondDelayMs)
        : MANHUNT_GHOST_DURATION_SECONDS * 1_000 -
          (MANHUNT_SMOKE_BOMB_DURATION_SECONDS * 1_000 - scenario.secondDelayMs);
    harness.runtime.advance(remainingEffectMs);
    Reflect.apply(openRevealWindow, harness.service, [harness.roomCode]);
    const restoredHunterFlash = harness.flashes
      .filter(({ playerId }) => playerId === hunters[0])
      .at(-1)!.payload;
    assert.equal(
      restoredHunterFlash.locations.some(({ playerId }) => playerId === hiderId),
      true,
    );
  }
});

test("Ghost reconnect preserves remaining uses and the original expiry deadline", () => {
  const harness = createHarness(2, new ManualRuntime(), {
    ghostUsageLimit: TEST_ONLY_GHOST_USAGE_LIMIT,
  });
  const { session, runners } = activateFreezeGame(harness, [10]);
  const hiderId = runners[0]!;
  const hiderSocket = socketIdForPlayer(harness, hiderId);
  harness.service.activateGhost(
    harness.roomCode,
    hiderSocket,
    session.id,
    GHOST_REQUESTS[0]!,
  );
  const original = harness.ghostStates.at(-1)!.payload.activeEffects[0]!;
  const timerCountBeforeDisconnect = harness.runtime.pendingTimerCount;

  harness.rooms.disconnectSocket(hiderSocket);
  harness.service.onPlayerDisconnected(harness.roomCode, hiderId);
  assert.equal(
    harness.runtime.pendingTimerCount,
    timerCountBeforeDisconnect - 1,
  );
  harness.runtime.advance(5_000);
  harness.rooms.reconnect(
    {
      roomCode: harness.roomCode,
      playerId: hiderId,
      reconnectToken:
        harness.reconnectTokens[harness.playerIds.indexOf(hiderId)]!,
    },
    "ghost-hider-reconnected",
  );

  const resumed = harness.service.getResumeSnapshot(
    harness.roomCode,
    hiderId,
  )?.ghost;
  assert.equal(resumed?.remainingUses, TEST_ONLY_GHOST_USAGE_LIMIT - 1);
  assert.equal(resumed?.activeEffects[0]?.startedAt, original.startedAt);
  assert.equal(resumed?.activeEffects[0]?.expiresAt, original.expiresAt);
  harness.runtime.advance(
    MANHUNT_GHOST_DURATION_SECONDS * 1_000 - 5_000 - 1,
  );
  assert.equal(
    harness.service.getResumeSnapshot(harness.roomCode, hiderId)?.ghost
      ?.activeEffects.length,
    1,
  );
  harness.runtime.advance(1);
  const expired = harness.service.getResumeSnapshot(
    harness.roomCode,
    hiderId,
  )?.ghost;
  assert.equal(expired?.remainingUses, TEST_ONLY_GHOST_USAGE_LIMIT - 1);
  assert.equal(expired?.activeEffects.length, 0);
});

test("Ghost state and timers are cleared on catch, departure, game end, and session cleanup", () => {
  const caught = createHarness(4, new ManualRuntime(), {
    ghostUsageLimit: TEST_ONLY_GHOST_USAGE_LIMIT,
  });
  const caughtGame = activateFreezeGame(caught, [20, 40, 60]);
  const caughtHider = caughtGame.runners[0]!;
  caught.service.activateGhost(
    caught.roomCode,
    socketIdForPlayer(caught, caughtHider),
    caughtGame.session.id,
    GHOST_REQUESTS[0]!,
  );
  const caughtTimerCount = caught.runtime.pendingTimerCount;
  caught.service.recordLocation(
    caught.roomCode,
    socketIdForPlayer(caught, caughtHider),
    {
      latitude:
        caughtGame.center.latitude + eastOffsetMeters(1),
      longitude: caughtGame.center.longitude,
    },
    1,
  );
  const catchRequest = caught.service.attemptCatch(
    caught.roomCode,
    socketIdForPlayer(caught, caughtGame.hunters[0]!),
    caughtHider,
  );
  caught.service.respondToCatch(
    caught.roomCode,
    socketIdForPlayer(caught, caughtHider),
    catchRequest.requestId,
    true,
  );
  assert.ok(caught.runtime.pendingTimerCount < caughtTimerCount);
  assert.equal(
    caught.service.getResumeSnapshot(caught.roomCode, caughtHider)?.ghost,
    undefined,
  );

  const departed = createHarness(3, new ManualRuntime(), {
    ghostUsageLimit: TEST_ONLY_GHOST_USAGE_LIMIT,
  });
  const departedGame = activateFreezeGame(departed, [20, 40]);
  const departedHider = departedGame.runners[0]!;
  const timersBeforeGhost = departed.runtime.pendingTimerCount;
  departed.service.activateGhost(
    departed.roomCode,
    socketIdForPlayer(departed, departedHider),
    departedGame.session.id,
    GHOST_REQUESTS[1]!,
  );
  removePlayer(departed, departedHider);
  assert.equal(departed.runtime.pendingTimerCount, timersBeforeGhost);
  assert.equal(
    departed.service.getResumeSnapshot(departed.roomCode, departedHider),
    undefined,
  );

  const ended = createHarness(2, new ManualRuntime(), {
    ghostUsageLimit: TEST_ONLY_GHOST_USAGE_LIMIT,
  });
  const endedGame = activateFreezeGame(ended, [1]);
  const endedHider = endedGame.runners[0]!;
  ended.service.activateGhost(
    ended.roomCode,
    socketIdForPlayer(ended, endedHider),
    endedGame.session.id,
    GHOST_REQUESTS[2]!,
  );
  const endRequest = ended.service.attemptCatch(
    ended.roomCode,
    socketIdForPlayer(ended, endedGame.hunters[0]!),
    endedHider,
  );
  ended.service.respondToCatch(
    ended.roomCode,
    socketIdForPlayer(ended, endedHider),
    endRequest.requestId,
    true,
  );
  assert.equal(ended.ended.length, 1);
  assert.equal(ended.runtime.pendingTimerCount, 0);

  const cleaned = createHarness(2, new ManualRuntime(), {
    ghostUsageLimit: TEST_ONLY_GHOST_USAGE_LIMIT,
  });
  const cleanedGame = activateFreezeGame(cleaned, [10]);
  cleaned.service.activateGhost(
    cleaned.roomCode,
    socketIdForPlayer(cleaned, cleanedGame.runners[0]!),
    cleanedGame.session.id,
    GHOST_REQUESTS[0]!,
  );
  cleaned.service.clearSession(cleaned.roomCode);
  assert.equal(cleaned.runtime.pendingTimerCount, 0);
});

test("Freeze Decoy authorizes only active, connected, uncaught Hiders in the session", () => {
  const countdown = createHarness(2);
  countdown.service.updateSettings(
    countdown.roomCode,
    countdown.hostSocket,
    validSettings,
  );
  const countdownSession = countdown.service.startGame(
    countdown.roomCode,
    countdown.hostSocket,
  );
  const countdownHider = countdown.assignments.find(
    ({ team }) => team === "runner",
  )!.playerId;
  assertAppError(
    () =>
      countdown.service.activateFreezeDecoy(
        countdown.roomCode,
        socketIdForPlayer(countdown, countdownHider),
        countdownSession.id,
        "00000000-0000-4000-8000-000000000801",
      ),
    "GAME_NOT_ACTIVE",
  );

  const active = createHarness(4);
  const activeGame = activateFreezeGame(active);
  assertAppError(
    () =>
      active.service.activateFreezeDecoy(
        active.roomCode,
        socketIdForPlayer(active, activeGame.hunters[0]!),
        activeGame.session.id,
        "00000000-0000-4000-8000-000000000802",
      ),
    "NOT_AUTHORIZED",
  );
  assertAppError(
    () =>
      active.service.activateFreezeDecoy(
        active.roomCode,
        socketIdForPlayer(active, activeGame.runners[0]!),
        "wrong-session",
        "00000000-0000-4000-8000-000000000803",
      ),
    "GAME_NOT_ACTIVE",
  );

  const disconnected = createHarness(2);
  const disconnectedGame = activateFreezeGame(disconnected);
  const disconnectedHider = disconnectedGame.runners[0]!;
  const disconnectedSocket = socketIdForPlayer(
    disconnected,
    disconnectedHider,
  );
  disconnected.rooms.disconnectSocket(disconnectedSocket);
  disconnected.service.onPlayerDisconnected(
    disconnected.roomCode,
    disconnectedHider,
  );
  assertAppError(
    () =>
      disconnected.service.activateFreezeDecoy(
        disconnected.roomCode,
        disconnectedSocket,
        disconnectedGame.session.id,
        "00000000-0000-4000-8000-000000000804",
      ),
    "NOT_AUTHORIZED",
  );

  const caught = createHarness(3);
  const caughtGame = activateFreezeGame(caught, [1, 40]);
  const caughtHider = caughtGame.runners[0]!;
  const hiderSocket = socketIdForPlayer(caught, caughtHider);
  const catchRequest = caught.service.attemptCatch(
    caught.roomCode,
    socketIdForPlayer(caught, caughtGame.hunters[0]!),
    caughtHider,
  );
  caught.service.respondToCatch(
    caught.roomCode,
    hiderSocket,
    catchRequest.requestId,
    true,
  );
  assertAppError(
    () =>
      caught.service.activateFreezeDecoy(
        caught.roomCode,
        hiderSocket,
        caughtGame.session.id,
        "00000000-0000-4000-8000-000000000805",
      ),
    "NOT_AUTHORIZED",
  );
});

test("Freeze Decoy generates boundary-contained synthetic locations and private identity-free snapshots", () => {
  const harness = createHarness(4, new ManualRuntime(), {
    freezeDecoyRandomInt: (min) => min,
  });
  const { session, hunters, runners } = activateFreezeGame(harness);
  const hiderId = runners[0]!;
  const sourceCoordinates = {
    latitude: validSettings.boundary.center.latitude + eastOffsetMeters(35),
    longitude: validSettings.boundary.center.longitude,
  };
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, hiderId),
    sourceCoordinates,
  );
  harness.service.activateFreezeDecoy(
    harness.roomCode,
    socketIdForPlayer(harness, hiderId),
    session.id,
    "00000000-0000-4000-8000-000000000806",
  );

  const delivered = harness.freezeDecoyStates.filter(({ payload }) =>
    payload.decoys.length === 1,
  );
  assert.deepEqual(
    delivered.map(({ playerId }) => playerId).sort(),
    [...hunters].sort(),
  );
  const decoy = delivered[0]!.payload.decoys[0]!;
  assert.deepEqual(decoy.coordinates, validSettings.boundary.center);
  assert.ok(
    haversineMeters(
      decoy.coordinates,
      validSettings.boundary.center,
    ) <= validSettings.boundary.radiusMeters,
  );
  assert.equal(
    Date.parse(decoy.expiresAt) - Date.parse(decoy.startedAt),
    MANHUNT_FREEZE_DECOY_DURATION_SECONDS * 1_000,
  );
  assert.notDeepEqual(decoy.coordinates, sourceCoordinates);
  assert.equal("playerId" in decoy, false);
  assert.equal("sourceHiderId" in decoy, false);
  assertAppError(
    () =>
      harness.service.attemptCatch(
        harness.roomCode,
        socketIdForPlayer(harness, hunters[0]!),
        decoy.decoyId,
      ),
    "INVALID_VOTE",
  );
  assert.equal(
    JSON.stringify(delivered[0]!.payload).includes(hiderId),
    false,
  );
  assert.equal(
    JSON.stringify(delivered[0]!.payload).includes(
      JSON.stringify(sourceCoordinates),
    ),
    false,
  );
  assert.deepEqual(
    harness.freezeDecoyStates.map(({ playerId }) => playerId).sort(),
    [...hunters].sort(),
  );
  const usage = harness.freezeDecoyUsageStates
    .filter(({ playerId }) => playerId === hiderId)
    .at(-1)!.payload;
  assert.equal(usage.remainingUses, MANHUNT_FREEZE_DECOY_MAX_USES_PER_GAME - 1);
  const hiderSnapshot = harness.service.getResumeSnapshot(
    harness.roomCode,
    hiderId,
  );
  assert.deepEqual(hiderSnapshot?.freezeDecoyUsage, usage);
  assert.equal(hiderSnapshot?.freezeDecoys, undefined);
  const hunterSnapshot = harness.service.getResumeSnapshot(
    harness.roomCode,
    hunters[0]!,
  );
  assert.deepEqual(hunterSnapshot?.freezeDecoys?.decoys, [decoy]);
  assert.equal(hunterSnapshot?.freezeDecoyUsage, undefined);
  assert.equal(
    JSON.stringify(hunterSnapshot?.freezeDecoys).includes(hiderId),
    false,
  );
});

test("Freeze Decoy retries if independent generation matches a tracked Hider coordinate", () => {
  const samples = [0, 0, 160_000, 0];
  let sampleIndex = 0;
  const harness = createHarness(2, new ManualRuntime(), {
    freezeDecoyRandomInt: () => samples[sampleIndex++] ?? 0,
  });
  const { session, hunters, runners } = activateFreezeGame(harness);
  const hiderId = runners[0]!;
  const hiderSocket = socketIdForPlayer(harness, hiderId);
  const realCoordinates = validSettings.boundary.center;
  harness.service.recordLocation(
    harness.roomCode,
    hiderSocket,
    realCoordinates,
  );

  harness.service.activateFreezeDecoy(
    harness.roomCode,
    hiderSocket,
    session.id,
    "00000000-0000-4000-8000-000000000821",
  );

  const decoy = harness.freezeDecoyStates.at(-1)!.payload.decoys[0]!;
  assert.notDeepEqual(decoy.coordinates, realCoordinates);
  assert.ok(
    harness.freezeDecoyStates.some(({ playerId, payload }) =>
      hunters.includes(playerId) && payload.decoys.some(
        ({ decoyId }) => decoyId === decoy.decoyId,
      ),
    ),
  );
});

test("Freeze Decoy enforces three uses, replay protection, and independent exact expirations", () => {
  const harness = createHarness(2, new ManualRuntime(), {
    freezeDecoyRandomInt: (min) => min,
  });
  const { session, runners } = activateFreezeGame(harness, [20]);
  const hiderId = runners[0]!;
  const activate = (requestId: string) =>
    harness.service.activateFreezeDecoy(
      harness.roomCode,
      socketIdForPlayer(harness, hiderId),
      session.id,
      requestId,
    );
  const firstRequest = "00000000-0000-4000-8000-000000000811";
  const secondRequest = "00000000-0000-4000-8000-000000000812";
  const thirdRequest = "00000000-0000-4000-8000-000000000813";
  const fourthRequest = "00000000-0000-4000-8000-000000000814";

  activate(firstRequest);
  const first = harness.freezeDecoyStates.at(-1)!.payload.decoys[0]!;
  assertAppError(() => activate(firstRequest), "GAME_NOT_READY");
  harness.runtime.advance(3_000);
  activate(secondRequest);
  const second = harness.freezeDecoyStates.at(-1)!.payload.decoys[1]!;
  assert.equal(Date.parse(second.expiresAt) - Date.parse(first.expiresAt), 3_000);

  harness.runtime.advance(6_999);
  assert.equal(harness.freezeDecoyStates.at(-1)!.payload.decoys.length, 2);
  harness.runtime.advance(1);
  assert.deepEqual(
    harness.freezeDecoyStates.at(-1)!.payload.decoys.map(({ decoyId }) => decoyId),
    [second.decoyId],
  );

  harness.runtime.advance(1_000);
  activate(thirdRequest);
  const third = harness.freezeDecoyStates.at(-1)!.payload.decoys[1]!;
  harness.runtime.advance(2_000);
  assert.deepEqual(
    harness.freezeDecoyStates.at(-1)!.payload.decoys.map(({ decoyId }) => decoyId),
    [third.decoyId],
  );
  assert.equal(
    harness.freezeDecoyUsageStates.at(-1)!.payload.remainingUses,
    0,
  );
  assertAppError(() => activate(fourthRequest), "GAME_NOT_READY");

  harness.runtime.advance(7_999);
  assert.equal(harness.freezeDecoyStates.at(-1)!.payload.decoys.length, 1);
  harness.runtime.advance(1);
  assert.equal(harness.freezeDecoyStates.at(-1)!.payload.decoys.length, 0);
});

test("Freeze Decoy reconnect preserves uses and original deadlines", () => {
  const harness = createHarness(2, new ManualRuntime(), {
    freezeDecoyRandomInt: (min) => min,
  });
  const { session, hunters, runners } = activateFreezeGame(harness, [20]);
  const hiderId = runners[0]!;
  const hiderSocket = socketIdForPlayer(harness, hiderId);
  harness.service.activateFreezeDecoy(
    harness.roomCode,
    hiderSocket,
    session.id,
    "00000000-0000-4000-8000-000000000815",
  );
  const original = harness.freezeDecoyStates.at(-1)!.payload.decoys[0]!;

  harness.rooms.disconnectSocket(hiderSocket);
  harness.service.onPlayerDisconnected(harness.roomCode, hiderId);
  harness.runtime.advance(2_000);
  harness.rooms.reconnect(
    {
      roomCode: harness.roomCode,
      playerId: hiderId,
      reconnectToken: harness.reconnectTokens[harness.playerIds.indexOf(hiderId)]!,
    },
    "hider-reconnected",
  );
  const hiderSnapshot = harness.service.getResumeSnapshot(
    harness.roomCode,
    hiderId,
  );
  assert.equal(
    hiderSnapshot?.freezeDecoyUsage?.remainingUses,
    MANHUNT_FREEZE_DECOY_MAX_USES_PER_GAME - 1,
  );
  const hunterSnapshot = harness.service.getResumeSnapshot(
    harness.roomCode,
    hunters[0]!,
  );
  assert.equal(
    hunterSnapshot?.freezeDecoys?.decoys[0]?.decoyId,
    original.decoyId,
  );
  assert.equal(
    hunterSnapshot?.freezeDecoys?.decoys[0]?.expiresAt,
    original.expiresAt,
  );
  harness.runtime.advance(MANHUNT_FREEZE_DECOY_DURATION_SECONDS * 1_000 - 2_000);
  assert.equal(
    harness.service.getResumeSnapshot(harness.roomCode, hunters[0]!)
      ?.freezeDecoys?.decoys.length,
    0,
  );
});

test("Freeze Decoy is removed immediately when the current boundary excludes it", () => {
  const harness = createHarness(2, new ManualRuntime(), {
    freezeDecoyRandomInt: (_min, max) => (max === 1_000_000 ? 810_000 : 0),
  });
  const settings = {
    ...validSettings,
    boundary: { ...validSettings.boundary, radiusMeters: 100 },
  };
  harness.service.updateSettings(harness.roomCode, harness.hostSocket, settings);
  const session = harness.service.startGame(
    harness.roomCode,
    harness.hostSocket,
  );
  harness.runtime.advance(MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000);
  const hunter = harness.assignments.find(({ team }) => team === "hunter")!
    .playerId;
  const hider = harness.assignments.find(({ team }) => team === "runner")!
    .playerId;
  harness.service.activateFreezeDecoy(
    harness.roomCode,
    socketIdForPlayer(harness, hider),
    session.id,
    "00000000-0000-4000-8000-000000000816",
  );
  const original = harness.freezeDecoyStates.at(-1)!.payload.decoys[0]!;
  assert.ok(haversineMeters(original.coordinates, settings.boundary.center) > 85);

  currentManhuntBoundary(harness).radiusMeters = 85;
  const snapshot = harness.service.getResumeSnapshot(harness.roomCode, hunter);
  assert.deepEqual(snapshot?.freezeDecoys?.decoys, []);
  assert.deepEqual(harness.freezeDecoyStates.at(-1)!.payload.decoys, []);
});

test("Freeze Decoy timers and source state clear on catch, departure, game end, and session cleanup", () => {
  const caught = createHarness(3, new ManualRuntime(), {
    freezeDecoyRandomInt: (min) => min,
  });
  const caughtGame = activateFreezeGame(caught, [1, 40]);
  const caughtHider = caughtGame.runners[0]!;
  const caughtHunter = caughtGame.hunters[0]!;
  caught.service.activateFreezeDecoy(
    caught.roomCode,
    socketIdForPlayer(caught, caughtHider),
    caughtGame.session.id,
    "00000000-0000-4000-8000-000000000817",
  );
  assert.equal(caught.runtime.hasPendingTimerDueIn(10_000), true);
  const catchRequest = caught.service.attemptCatch(
    caught.roomCode,
    socketIdForPlayer(caught, caughtHunter),
    caughtHider,
  );
  caught.service.respondToCatch(
    caught.roomCode,
    socketIdForPlayer(caught, caughtHider),
    catchRequest.requestId,
    true,
  );
  assert.equal(caught.runtime.hasPendingTimerDueIn(10_000), false);
  assert.deepEqual(
    caught.service.getResumeSnapshot(caught.roomCode, caughtHunter)
      ?.freezeDecoys?.decoys,
    [],
  );

  const departed = createHarness(3, new ManualRuntime(), {
    freezeDecoyRandomInt: (min) => min,
  });
  const departedGame = activateFreezeGame(departed, [20, 40]);
  const departedHider = departedGame.runners[0]!;
  departed.service.activateFreezeDecoy(
    departed.roomCode,
    socketIdForPlayer(departed, departedHider),
    departedGame.session.id,
    "00000000-0000-4000-8000-000000000818",
  );
  assert.equal(departed.runtime.hasPendingTimerDueIn(10_000), true);
  removePlayer(departed, departedHider);
  assert.equal(departed.runtime.hasPendingTimerDueIn(10_000), false);
  assert.deepEqual(
    departed.service.getResumeSnapshot(
      departed.roomCode,
      departedGame.hunters[0]!,
    )?.freezeDecoys?.decoys,
    [],
  );
  departed.runtime.runCancelledCallbacks();
  assert.deepEqual(departed.freezeDecoyStates.at(-1)!.payload.decoys, []);

  const ended = createHarness(2, new ManualRuntime(), {
    freezeDecoyRandomInt: (min) => min,
  });
  const endedGame = activateFreezeGame(ended, [1]);
  const endedHider = endedGame.runners[0]!;
  ended.service.activateFreezeDecoy(
    ended.roomCode,
    socketIdForPlayer(ended, endedHider),
    endedGame.session.id,
    "00000000-0000-4000-8000-000000000819",
  );
  const endRequest = ended.service.attemptCatch(
    ended.roomCode,
    socketIdForPlayer(ended, endedGame.hunters[0]!),
    endedHider,
  );
  ended.service.respondToCatch(
    ended.roomCode,
    socketIdForPlayer(ended, endedHider),
    endRequest.requestId,
    true,
  );
  assert.equal(ended.ended.length, 1);
  assert.equal(ended.runtime.pendingTimerCount, 0);
  assert.deepEqual(ended.freezeDecoyStates.at(-1)!.payload.decoys, []);

  const cleaned = createHarness(2, new ManualRuntime(), {
    freezeDecoyRandomInt: (min) => min,
  });
  const cleanedGame = activateFreezeGame(cleaned, [10]);
  cleaned.service.activateFreezeDecoy(
    cleaned.roomCode,
    socketIdForPlayer(cleaned, cleanedGame.runners[0]!),
    cleanedGame.session.id,
    "00000000-0000-4000-8000-000000000820",
  );
  cleaned.service.clearSession(cleaned.roomCode);
  assert.equal(cleaned.runtime.pendingTimerCount, 0);
  assert.equal(
    cleaned.service.getResumeSnapshot(
      cleaned.roomCode,
      cleanedGame.hunters[0]!,
    ),
    undefined,
  );
});

test("late-game exposure time trigger runs only for 45- and 60-minute games", () => {
  for (const duration of [2_700, 3_600] as const) {
    const runtime = new ManualRuntime();
    const harness = createHarness(5, runtime, {
      lateGameExposureDurations: TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS,
      lateGameExposureRandomInt: (min) => min,
    });
    const game = activateLateGame(harness, duration, 1);
    runtime.advance(29 * 60 * 1_000);
    recordLateGameLocations(harness, [game.runners[0]!]);
    runtime.advance(60_000);

    assert.equal(harness.lateGameClueStates.length, game.hunters.length);
    assert.equal(harness.lateGameWarningStates.length, 1);
    assert.equal(
      harness.lateGameClueStates[0]?.payload.clue?.recordedAt,
      new Date(runtime.now().getTime() - 60_000).toISOString(),
    );
    assert.equal(
      Date.parse(harness.lateGameClueStates[0]!.payload.clue!.exposedAt),
      runtime.now().getTime(),
    );
  }

  const runtime = new ManualRuntime();
  const harness = createHarness(5, runtime, {
    lateGameExposureDurations: TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS,
  });
  const game = activateLateGame(harness, 1_800, 1);
  assert.equal(currentManhuntRecord(harness).lateGameExposureTimer, undefined);
  runtime.advance(29 * 60 * 1_000);
  recordLateGameLocations(harness, [game.runners[0]!]);
  runtime.advance(60_000);
  assert.equal(harness.ended.length, 1);
  assert.equal(harness.lateGameClueStates.length, 0);
  assert.equal(harness.lateGameWarningStates.length, 0);
});

test("late-game exposure triggers at exactly 2 connected Hunters and 2 Hiders privately", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(6, runtime, {
    lateGameExposureDurations: TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS,
    lateGameExposureRandomInt: (_min, max) => max - 1,
  });
  const game = activateLateGame(harness, 2_700, 2);
  recordLateGameLocations(harness, game.runners);
  runtime.advance(60_000);

  disconnectHarnessPlayer(harness, game.runners[2]!);
  assert.equal(harness.lateGameClueStates.length, 0);
  disconnectHarnessPlayer(harness, game.runners[3]!);

  const selectedHider = game.runners[1]!;
  const hunterSnapshot = harness.service.getResumeSnapshot(
    harness.roomCode,
    game.hunters[0]!,
  );
  const hiderSnapshot = harness.service.getResumeSnapshot(
    harness.roomCode,
    selectedHider,
  );
  const initialClue = hunterSnapshot?.lateGameClue?.clue;
  const initialWarning = hiderSnapshot?.lateGameWarning?.warning;
  assert.ok(initialClue);
  assert.ok(initialWarning);
  const originalClueDeadline = initialClue.expiresAt;
  const originalWarningDeadline = initialWarning.expiresAt;
  assert.deepEqual(
    harness.lateGameClueStates.map(({ playerId }) => playerId).sort(),
    [...game.hunters].sort(),
  );
  assert.deepEqual(
    harness.lateGameWarningStates.map(({ playerId }) => playerId),
    [selectedHider],
  );
  for (const { payload } of harness.lateGameClueStates) {
    assert.ok(payload.clue);
    assert.equal("playerId" in payload.clue, false);
    assert.equal("nickname" in payload.clue, false);
    assert.equal(JSON.stringify(payload.clue).includes(selectedHider), false);
    assert.equal(
      Date.parse(payload.clue.expiresAt) - Date.parse(payload.clue.exposedAt),
      15_000,
    );
  }
  const warning = harness.lateGameWarningStates[0]!.payload.warning;
  assert.ok(warning);
  assert.equal(
    Date.parse(warning.expiresAt) - Date.parse(warning.startedAt),
    5_000,
  );

  runtime.advance(5_000);
  assert.equal(harness.lateGameWarningStates.at(-1)?.payload.warning, null);
  assert.ok(harness.lateGameClueStates.at(-1)?.payload.clue);
  assert.equal(
    harness.service.getResumeSnapshot(
      harness.roomCode,
      selectedHider,
    )?.lateGameWarning,
    undefined,
  );
  assert.equal(
    harness.service.getResumeSnapshot(
      harness.roomCode,
      game.hunters[0]!,
    )?.lateGameClue?.clue?.expiresAt,
    originalClueDeadline,
  );
  assert.notEqual(originalWarningDeadline, undefined);
  runtime.advance(10_000);
  assert.equal(harness.lateGameClueStates.at(-1)?.payload.clue, null);
  assert.equal(
    harness.service.getResumeSnapshot(
      harness.roomCode,
      game.hunters[0]!,
    )?.lateGameClue,
    undefined,
  );
});

test("late-game exposure uses the newest qualifying sample and does not duplicate after a second trigger", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(6, runtime, {
    lateGameExposureDurations: TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS,
    lateGameExposureRandomInt: (_min, max) => max - 1,
  });
  const game = activateLateGame(harness, 2_700, 2);
  runtime.advance(25 * 60 * 1_000);
  recordLateGameLocations(harness, game.runners.slice(0, 2));
  const qualifyingSampleAt = runtime.now().getTime();
  runtime.advance((4 * 60 + 30) * 1_000);
  harness.service.recordLocation(
    harness.roomCode,
    socketIdForPlayer(harness, game.runners[1]!),
    {
      latitude: game.center.latitude + eastOffsetMeters(100),
      longitude: game.center.longitude,
    },
    1,
  );
  runtime.advance(30_000);

  assert.equal(harness.lateGameClueStates.length, game.hunters.length);
  assert.equal(harness.lateGameWarningStates.length, 1);
  assert.equal(
    harness.lateGameClueStates[0]?.payload.clue?.recordedAt,
    new Date(qualifyingSampleAt).toISOString(),
  );
  assert.equal(
    harness.lateGameClueStates[0]?.payload.clue?.coordinates.latitude,
    game.center.latitude + eastOffsetMeters(30),
  );

  disconnectHarnessPlayer(harness, game.runners[2]!);
  disconnectHarnessPlayer(harness, game.runners[3]!);
  assert.equal(harness.lateGameClueStates.length, game.hunters.length);
  assert.equal(harness.lateGameWarningStates.length, 1);
});

test("late-game exposure accepts the inclusive 60-second and 5-minute history ages", () => {
  for (const ageSeconds of [60, 300]) {
    const runtime = new ManualRuntime();
    const harness = createHarness(6, runtime, {
      lateGameExposureDurations: TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS,
      lateGameExposureRandomInt: (_min, max) => max - 1,
    });
    const game = activateLateGame(harness, 2_700, 2);
    recordLateGameLocations(harness, game.runners);
    runtime.advance(ageSeconds * 1_000);
    disconnectHarnessPlayer(harness, game.runners[2]!);
    disconnectHarnessPlayer(harness, game.runners[3]!);

    assert.equal(harness.lateGameWarningStates.length, 1);
    assert.equal(harness.lateGameWarningStates[0]?.playerId, game.runners[1]);
    assert.equal(
      harness.lateGameClueStates[0]?.payload.clue?.recordedAt,
      new Date(runtime.now().getTime() - ageSeconds * 1_000).toISOString(),
    );
  }
});

test("stale late-game expiry callbacks cannot clear newer clue or warning state", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(6, runtime, {
    lateGameExposureDurations: TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS,
    lateGameExposureRandomInt: (min) => min,
  });
  const game = activateLateGame(harness, 2_700, 2);
  recordLateGameLocations(harness, game.runners);
  runtime.advance(60_000);
  disconnectHarnessPlayer(harness, game.runners[2]!);
  disconnectHarnessPlayer(harness, game.runners[3]!);

  const currentGame = currentManhuntRecord(harness);
  const exposure = currentGame.lateGameExposure as {
    clue: { clueId: string };
    warning: { exposureId: string };
  };
  const staleClueId = exposure.clue.clueId;
  const staleWarningId = exposure.warning.exposureId;
  const replacementClueId = "00000000-0000-4000-8000-000000000901";
  const replacementWarningId = "00000000-0000-4000-8000-000000000902";
  exposure.clue.clueId = replacementClueId;
  exposure.warning.exposureId = replacementWarningId;

  const expireClue = Reflect.get(
    harness.service,
    "expireLateGameClue",
  ) as (game: object, clueId: string) => void;
  const expireWarning = Reflect.get(
    harness.service,
    "expireLateGameWarning",
  ) as (game: object, exposureId: string) => void;
  expireClue.call(harness.service, currentGame, staleClueId);
  expireWarning.call(harness.service, currentGame, staleWarningId);

  assert.equal(
    harness.service.getResumeSnapshot(
      harness.roomCode,
      game.hunters[0]!,
    )?.lateGameClue?.clue?.clueId,
    replacementClueId,
  );
  assert.equal(
    harness.service.getResumeSnapshot(
      harness.roomCode,
      harness.lateGameWarningStates[0]!.playerId,
    )?.lateGameWarning?.warning?.exposureId,
    replacementWarningId,
  );
  assert.equal(harness.lateGameClueStates.length, game.hunters.length);
  assert.equal(harness.lateGameWarningStates.length, 1);
});

test("late-game exposure rejects history outside the approved age window without retrying", () => {
  for (const ageSeconds of [59, 301]) {
    const runtime = new ManualRuntime();
    const harness = createHarness(6, runtime, {
      lateGameExposureDurations: TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS,
    });
    const game = activateLateGame(harness, 2_700, 2);
    recordLateGameLocations(harness, game.runners);
    runtime.advance(ageSeconds * 1_000);
    disconnectHarnessPlayer(harness, game.runners[2]!);
    disconnectHarnessPlayer(harness, game.runners[3]!);

    assert.equal(harness.lateGameClueStates.length, 0);
    assert.equal(harness.lateGameWarningStates.length, 0);
    assert.equal(
      (currentManhuntRecord(harness).lateGameExposure as { triggered: boolean })
        .triggered,
      true,
    );
    recordLateGameLocations(harness, game.runners.slice(0, 2));
    assert.equal(harness.lateGameClueStates.length, 0);
  }
});

test("late-game exposure excludes Smoke Bomb/Ghost samples and currently protected Hiders", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(7, runtime, {
    lateGameExposureDurations: TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS,
    lateGameExposureRandomInt: (min) => min,
    ghostUsageLimit: TEST_ONLY_GHOST_USAGE_LIMIT,
  });
  const game = activateLateGame(harness, 2_700, 2);
  const [
    ghostSampleHider,
    smokeSampleHider,
    currentlyGhostProtectedHider,
    currentlySmokeProtectedHider,
    eligibleHider,
  ] = game.runners;
  assert.ok(ghostSampleHider);
  assert.ok(smokeSampleHider);
  assert.ok(currentlyGhostProtectedHider);
  assert.ok(currentlySmokeProtectedHider);
  assert.ok(eligibleHider);

  runtime.advance(29 * 60 * 1_000);
  harness.service.activateGhost(
    harness.roomCode,
    socketIdForPlayer(harness, ghostSampleHider),
    game.session.id,
    GHOST_REQUESTS[0]!,
  );
  harness.service.activateSmokeBomb(
    harness.roomCode,
    socketIdForPlayer(harness, smokeSampleHider),
    game.session.id,
    SMOKE_BOMB_REQUESTS[0]!,
  );
  recordLateGameLocations(harness, [ghostSampleHider, smokeSampleHider]);
  recordLateGameLocations(harness, [
    currentlyGhostProtectedHider,
    currentlySmokeProtectedHider,
    eligibleHider,
  ]);
  runtime.advance(55_000);
  harness.service.activateGhost(
    harness.roomCode,
    socketIdForPlayer(harness, currentlyGhostProtectedHider),
    game.session.id,
    GHOST_REQUESTS[1]!,
  );
  harness.service.activateSmokeBomb(
    harness.roomCode,
    socketIdForPlayer(harness, currentlySmokeProtectedHider),
    game.session.id,
    SMOKE_BOMB_REQUESTS[1]!,
  );
  runtime.advance(5_000);

  assert.deepEqual(
    harness.lateGameWarningStates.map(({ playerId }) => playerId),
    [eligibleHider],
  );
  assert.equal(
    harness.lateGameClueStates[0]?.payload.clue?.coordinates.latitude,
    validSettings.boundary.center.latitude +
      eastOffsetMeters(40),
  );
});

test("late-game exposure rejects historical coordinates outside the current shrunken boundary", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(6, runtime, {
    lateGameExposureDurations: TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS,
    lateGameExposureRandomInt: (min) => min,
  });
  const game = activateLateGame(harness, 2_700, 2);
  recordLateGameLocations(harness, game.runners);
  const currentGame = currentManhuntRecord(harness);
  const history = currentGame.lateGameLocationHistory as Map<
    string,
    Array<{ coordinates: { latitude: number; longitude: number } }>
  >;
  history.get(game.runners[0]!)![0]!.coordinates.latitude =
    game.center.latitude + eastOffsetMeters(200);
  (currentGame.boundary as ManhuntBoundary).radiusMeters = 100;

  runtime.advance(60_000);
  disconnectHarnessPlayer(harness, game.runners[2]!);
  disconnectHarnessPlayer(harness, game.runners[3]!);

  assert.equal(harness.lateGameWarningStates.length, 1);
  assert.equal(harness.lateGameWarningStates[0]?.playerId, game.runners[1]);
  assert.equal(
    harness.lateGameClueStates[0]?.payload.clue?.coordinates.latitude,
    game.center.latitude + eastOffsetMeters(30),
  );
});

test("late-game exposure never falls back to a live location when history is empty", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(6, runtime, {
    lateGameExposureDurations: TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS,
  });
  const game = activateLateGame(harness, 2_700, 2);
  recordLateGameLocations(harness, game.runners);
  const currentGame = currentManhuntRecord(harness);
  const liveLocations = currentGame.locations as Map<string, unknown>;
  const history = currentGame.lateGameLocationHistory as Map<string, unknown>;
  assert.equal(liveLocations.has(game.runners[0]!), true);
  history.clear();

  runtime.advance(60_000);
  disconnectHarnessPlayer(harness, game.runners[2]!);
  disconnectHarnessPlayer(harness, game.runners[3]!);

  assert.equal(harness.lateGameClueStates.length, 0);
  assert.equal(harness.lateGameWarningStates.length, 0);
  assert.equal(history.size, 0);
  assert.equal(
    (currentGame.lateGameExposure as { triggered: boolean }).triggered,
    true,
  );
  recordLateGameLocations(harness, game.runners.slice(0, 2));
  assert.equal(harness.lateGameClueStates.length, 0);
});

test("late-game exposure clears source state on catch and departure and cancels timers on cleanup", () => {
  for (const lifecycle of ["catch", "departure", "cleanup"] as const) {
    const runtime = new ManualRuntime();
    const harness = createHarness(6, runtime, {
      lateGameExposureDurations: TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS,
      lateGameExposureRandomInt: (min) => min,
    });
    const game = activateLateGame(harness, 2_700, 2);
    recordLateGameLocations(harness, game.runners);
    runtime.advance(60_000);
    disconnectHarnessPlayer(harness, game.runners[2]!);
    disconnectHarnessPlayer(harness, game.runners[3]!);
    const exposedHider = harness.lateGameWarningStates[0]!.playerId;
    assert.ok(harness.lateGameClueStates[0]?.payload.clue);

    if (lifecycle === "catch") {
      const hunter = game.hunters[0]!;
      harness.service.recordLocation(
        harness.roomCode,
        socketIdForPlayer(harness, hunter),
        game.center,
        1,
      );
      harness.service.recordLocation(
        harness.roomCode,
        socketIdForPlayer(harness, exposedHider),
        {
          latitude: game.center.latitude + eastOffsetMeters(1),
          longitude: game.center.longitude,
        },
        1,
      );
      const request = harness.service.attemptCatch(
        harness.roomCode,
        socketIdForPlayer(harness, hunter),
        exposedHider,
      );
      harness.service.respondToCatch(
        harness.roomCode,
        socketIdForPlayer(harness, exposedHider),
        request.requestId,
        true,
      );
      assert.equal(harness.lateGameClueStates.at(-1)?.payload.clue, null);
      assert.equal(
        harness.lateGameWarningStates.at(-1)?.payload.warning,
        null,
      );
    } else if (lifecycle === "departure") {
      removePlayer(harness, exposedHider);
      assert.equal(harness.lateGameClueStates.at(-1)?.payload.clue, null);
      assert.equal(
        harness.lateGameWarningStates.at(-1)?.payload.warning,
        null,
      );
    } else {
      harness.service.clearSession(harness.roomCode);
      assert.equal(runtime.pendingTimerCount, 0);
      assert.equal(
        harness.service.getResumeSnapshot(harness.roomCode, game.hunters[0]!),
        undefined,
      );
    }
  }
});

test("late-game exposure timers are cancelled when the game ends", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(3, runtime, {
    lateGameExposureDurations: TEST_ONLY_LATE_GAME_EXPOSURE_DURATIONS,
    lateGameExposureRandomInt: (min) => min,
  });
  const game = activateLateGame(harness, 2_700, 1);
  runtime.advance(29 * 60 * 1_000);
  recordLateGameLocations(harness, game.runners);
  runtime.advance(60_000);
  assert.equal(harness.lateGameClueStates.length, 1);
  assert.equal(harness.lateGameWarningStates.length, 1);

  const hunter = game.hunters[0]!;
  for (const hider of game.runners) {
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, hunter),
      game.center,
      1,
    );
    harness.service.recordLocation(
      harness.roomCode,
      socketIdForPlayer(harness, hider),
      {
        latitude: game.center.latitude + eastOffsetMeters(1),
        longitude: game.center.longitude,
      },
      1,
    );
    const request = harness.service.attemptCatch(
      harness.roomCode,
      socketIdForPlayer(harness, hunter),
      hider,
    );
    harness.service.respondToCatch(
      harness.roomCode,
      socketIdForPlayer(harness, hider),
      request.requestId,
      true,
    );
  }

  assert.equal(harness.ended.length, 1);
  assert.equal(runtime.pendingTimerCount, 0);
  const clueEventCount = harness.lateGameClueStates.length;
  const warningEventCount = harness.lateGameWarningStates.length;
  runtime.advance(60_000);
  assert.equal(harness.lateGameClueStates.length, clueEventCount);
  assert.equal(harness.lateGameWarningStates.length, warningEventCount);
});

test("late-game exposure fails closed for missing or invalid durations", () => {
  const runtime = new ManualRuntime();
  const harness = createHarness(4, runtime);
  const game = activateLateGame(harness, 2_700, 2);
  recordLateGameLocations(harness, game.runners);
  const currentGame = currentManhuntRecord(harness);
  assert.equal(currentGame.lateGameExposureTimer, undefined);
  assert.equal(
    (currentGame.lateGameLocationHistory as Map<string, unknown>).size,
    0,
  );
  assert.equal(harness.lateGameClueStates.length, 0);
  assert.equal(harness.lateGameWarningStates.length, 0);

  for (const invalidDurations of [
    { clueDurationSeconds: 0, warningDurationSeconds: 5 },
    { clueDurationSeconds: 15, warningDurationSeconds: Number.NaN },
    {
      clueDurationSeconds: Number.MAX_SAFE_INTEGER,
      warningDurationSeconds: 5,
    },
  ]) {
    const invalidHarness = createHarness(4, new ManualRuntime(), {
      lateGameExposureDurations: invalidDurations,
    });
    const invalidGame = activateLateGame(invalidHarness, 2_700, 2);
    recordLateGameLocations(invalidHarness, invalidGame.runners);
    const invalidCurrentGame = currentManhuntRecord(invalidHarness);
    assert.equal(invalidCurrentGame.lateGameExposureTimer, undefined);
    assert.equal(
      (invalidCurrentGame.lateGameLocationHistory as Map<string, unknown>)
        .size,
      0,
    );
    assert.equal(invalidHarness.lateGameClueStates.length, 0);
    assert.equal(invalidHarness.lateGameWarningStates.length, 0);
  }
});
