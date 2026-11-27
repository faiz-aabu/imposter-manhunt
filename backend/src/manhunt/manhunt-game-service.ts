import { randomInt, randomUUID } from "node:crypto";
import {
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
  MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS,
  MANHUNT_LOCATION_MAX_AGE_SECONDS,
  MANHUNT_LOCATION_REVEAL_DURATION_SECONDS,
  MANHUNT_LATE_GAME_EXPOSURE_TRIGGER_SECONDS,
  MANHUNT_LATE_GAME_EXPOSURE_MIN_LOCATION_AGE_SECONDS,
  MANHUNT_LATE_GAME_EXPOSURE_MAX_LOCATION_AGE_SECONDS,
  MANHUNT_PROXIMITY_COOLDOWN_SECONDS,
  MANHUNT_PROXIMITY_NEAR_METERS,
  MANHUNT_PROXIMITY_STRONG_METERS,
  MANHUNT_MISSION_CIRCLE_RADIUS_METERS,
  MANHUNT_MISSION_DEADLINE_SECONDS,
  MANHUNT_MISSION_DWELL_SECONDS,
  MANHUNT_MISSION_MAX_ACCURACY_METERS,
  MANHUNT_MISSION_MAX_SAMPLE_GAP_SECONDS,
  MANHUNT_MISSION_MAX_DISTANCE_METERS,
  MANHUNT_MISSION_MIN_CIRCLE_SEPARATION_METERS,
  MANHUNT_MISSION_MIN_DISTANCE_METERS,
  MANHUNT_MISSION_REVEAL_DURATION_SECONDS,
  MANHUNT_ZONE_WARNING_SECONDS,
  MANHUNT_ZONE_SHRINK_DURATION_SECONDS,
  MANHUNT_ZONE_MIN_RADIUS_METERS,
  DEFAULT_MANHUNT_GAME_DURATION_SECONDS,
  manhuntSettingsSchema,
} from "@impostor/api";
import type {
  CatchConfirmedPayload,
  CountdownPayload,
  CatchRequestStatus,
  CatchRequestStatusPayload,
  CatchConfirmationRequestPayload,
  CountdownSyncResponsePayload,
  Coordinates,
  GameSession,
  GameSessionId,
  ManhuntBoundary,
  ManhuntGameState,
  ManhuntCountdownCancelledPayload,
  ManhuntLocationAcknowledgementPayload,
  ManhuntProximityAlertPayload,
  ManhuntProximityLevel,
  ManhuntSettings,
  ManhuntTeamAssignment,
  PlayerId,
  RoomCode,
  Room,
  GameEndedPayload,
  LocationFlashPayload,
  ManhuntMissionAssignmentPayload,
  ManhuntMissionRevealPayload,
  ManhuntFreezeWarningPayload,
  PlayerFrozenPayload,
  PlayerFreezeEndedPayload,
  ManhuntFootstepsStatePayload,
  ManhuntSmokeBombStatePayload,
  ManhuntGhostStatePayload,
  ManhuntFreezeDecoyPayload,
  ManhuntFreezeDecoyStatePayload,
  ManhuntFreezeDecoyUsageStatePayload,
  ManhuntLateGameClueStatePayload,
  ManhuntLateGameWarningStatePayload,
  PlayerCaughtPayload,
} from "@impostor/api";
import { RoomService } from "../rooms/room-service.js";
import type { RoomGameStatusReservation } from "../rooms/room-service.js";
import type { RoomPersistenceCommands } from "../rooms/room-persistence-commands.js";
import {
  persistFinishedGameReturnToLobby,
  persistGameCompletion,
} from "../rooms/persist-game-status-transition.js";
import { fenceDurableGameRoom } from "../rooms/persist-game-status-transition.js";
import { AppError } from "../utils/app-error.js";
import type { GameRuntime, GameTimer } from "../games/imposter/classic-game-service.js";
import type { LateGameExposureDurations } from "../config/env.js";

interface PrivateLocation {
  coordinates: Coordinates;
  accuracyMeters?: number;
  recordedAt: string;
  clientTimestamp?: string;
}

interface PendingCatchRequest {
  requestId: string;
  hunterId: PlayerId;
  targetId: PlayerId;
  expiresAt: string;
  timer: GameTimer;
}

interface PairProximityState {
  playerIds: [PlayerId, PlayerId];
  level: "outside" | ManhuntProximityLevel;
  lastNearAt?: number;
  lastVeryNearAt?: number;
}

type MissionStatus =
  | "scheduled"
  | "active"
  | "completed"
  | "failed"
  | "cancelled";

interface ManhuntMissionAssignment {
  playerId: PlayerId;
  activationAtMs: number;
  status: MissionStatus;
  center?: Coordinates;
  revealedAtMs?: number;
  deadlineAtMs?: number;
  activationTimer?: GameTimer;
  deadlineTimer?: GameTimer;
  dwellTimer?: GameTimer;
  dwellStartedAtMs?: number;
  lastQualifyingSampleAtMs?: number;
}

interface ManhuntMissionRound {
  requiredCompletions: number;
  assignments: Map<PlayerId, ManhuntMissionAssignment>;
  completedPlayerIds: Set<PlayerId>;
  outcome?: "success" | "failure";
  revealVisibleUntilMs?: number;
  revealTimer?: GameTimer;
  lastRevealedAtMs?: number;
}

interface ManhuntFreezeRound {
  requestId: string;
  playerIds: Set<PlayerId>;
  phase: "warning" | "frozen";
  warningStartedAtMs: number;
  warningEndsAtMs: number;
  frozenAtMs?: number;
  frozenUntilMs?: number;
  timer?: GameTimer;
}

interface ManhuntFootstepsGuidance {
  requestId: string;
  bearingDegrees: number;
  startedAtMs: number;
  expiresAtMs: number;
  timer: GameTimer;
}

interface HunterFootstepsState {
  usedRequestIds: Set<string>;
  uses: number;
  guidances: Map<string, ManhuntFootstepsGuidance>;
}

interface ManhuntSmokeBombEffect {
  requestId: string;
  startedAtMs: number;
  expiresAtMs: number;
  timer: GameTimer;
}

interface HiderSmokeBombState {
  usedRequestIds: Set<string>;
  uses: number;
  activeEffects: Map<string, ManhuntSmokeBombEffect>;
}

interface ManhuntGhostEffect {
  requestId: string;
  startedAtMs: number;
  expiresAtMs: number;
  timer?: GameTimer;
}

interface HiderGhostState {
  usedRequestIds: Set<string>;
  uses: number;
  activeEffects: Map<string, ManhuntGhostEffect>;
}

interface ManhuntFreezeDecoy {
  decoyId: string;
  coordinates: Coordinates;
  startedAtMs: number;
  expiresAtMs: number;
  timer: GameTimer;
}

interface HiderFreezeDecoyState {
  usedRequestIds: Set<string>;
  uses: number;
  activeDecoys: Map<string, ManhuntFreezeDecoy>;
}

interface LateGameHistoricalLocation {
  coordinates: Coordinates;
  recordedAtMs: number;
}

interface LateGameExposureClue {
  clueId: string;
  sourceHiderId: PlayerId;
  coordinates: Coordinates;
  recordedAtMs: number;
  exposedAtMs: number;
  expiresAtMs: number;
  timer?: GameTimer;
}

interface LateGameExposureWarning {
  exposureId: string;
  playerId: PlayerId;
  startedAtMs: number;
  expiresAtMs: number;
  timer?: GameTimer;
}

interface LateGameExposureState {
  triggered: boolean;
  clue?: LateGameExposureClue;
  warning?: LateGameExposureWarning;
}

interface ManhuntRecord {
  roomCode: RoomCode;
  session: Extract<GameSession, { gameMode: "manhunt" }>;
  boundary: {
    center: Coordinates;
    radiusMeters: number;
  };
  teams: Map<PlayerId, "hunter" | "runner">;
  readyPlayerIds: Set<PlayerId>;
  locations: Map<PlayerId, PrivateLocation>;
  lateGameLocationHistory: Map<PlayerId, LateGameHistoricalLocation[]>;
  lateGameLocationHistoryTimer?: GameTimer;
  lateGameExposureTimer?: GameTimer;
  lateGameExposure: LateGameExposureState;
  pendingCatchRequests: Map<string, PendingCatchRequest>;
  pendingCatchByHunter: Map<PlayerId, string>;
  pendingCatchByTarget: Map<PlayerId, string>;
  proximityPairs: Map<string, PairProximityState>;
  cycleTimer?: GameTimer;
  countdownTimer?: GameTimer;
  revealTimer?: GameTimer;
  gameTimer?: GameTimer;
  zoneWarningTimer?: GameTimer;
  zoneShrinkTimer?: GameTimer;
  revealActive: boolean;
  missionRound?: ManhuntMissionRound;
  freezeRound?: ManhuntFreezeRound;
  usedFreezeRequestIds: Set<string>;
  footstepsByHunter: Map<PlayerId, HunterFootstepsState>;
  smokeBombByHider: Map<PlayerId, HiderSmokeBombState>;
  ghostByHider: Map<PlayerId, HiderGhostState>;
  freezeDecoysByHider: Map<PlayerId, HiderFreezeDecoyState>;
  caughtPlayerIds: Set<PlayerId>;
  result?: GameEndedPayload;
}

export interface PreparedManhuntGameStart {
  readonly roomCode: RoomCode;
  readonly gameId: GameSessionId;
}

interface ManhuntGameStartPlan {
  readonly socketId: string;
  readonly game: ManhuntRecord;
  readonly assignments: ManhuntTeamAssignment[];
}

export interface ManhuntGameEvents {
  gameStarted(roomCode: RoomCode, payload: import("@impostor/api").GameStartedPayload): void;
  roomUpdated(room: import("@impostor/api").Room): void;
  stateUpdated(roomCode: RoomCode, payload: import("@impostor/api").GameStateUpdatePayload): void;
  settingsUpdated(roomCode: RoomCode, payload: import("@impostor/api").ManhuntSettingsUpdatePayload): void;
  boundaryUpdated(roomCode: RoomCode, payload: import("@impostor/api").ManhuntBoundaryUpdatePayload): void;
  teamAssignment(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: import("@impostor/api").ManhuntTeamAssignmentPayload,
  ): void;
  readyUpdated(roomCode: RoomCode, payload: import("@impostor/api").ManhuntReadyUpdatePayload): void;
  gameEnded(roomCode: RoomCode, payload: import("@impostor/api").GameEndedPayload): void;
  countdownUpdated(roomCode: RoomCode, payload: CountdownPayload): void;
  countdownCancelled(
    roomCode: RoomCode,
    payload: ManhuntCountdownCancelledPayload,
  ): void;
  locationFlashed(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: LocationFlashPayload,
  ): void;
  playerCaught(roomCode: RoomCode, payload: PlayerCaughtPayload): void;
  catchConfirmationRequested(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: CatchConfirmationRequestPayload,
  ): void;
  catchRequestStatus(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: CatchRequestStatusPayload,
  ): void;
  catchConfirmed(roomCode: RoomCode, payload: CatchConfirmedPayload): void;
  proximityAlert(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: ManhuntProximityAlertPayload,
  ): void;
  missionAssignment(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: ManhuntMissionAssignmentPayload,
  ): void;
  missionReveal(
    roomCode: RoomCode,
    playerIds: PlayerId[],
    payload: ManhuntMissionRevealPayload,
  ): void;
  freezeWarning(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: ManhuntFreezeWarningPayload,
  ): void;
  playerFrozen(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: PlayerFrozenPayload,
  ): void;
  playerFreezeEnded(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: PlayerFreezeEndedPayload,
  ): void;
  footstepsState(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: ManhuntFootstepsStatePayload,
  ): void;
  smokeBombState(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: ManhuntSmokeBombStatePayload,
  ): void;
  ghostState(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: ManhuntGhostStatePayload,
  ): void;
  freezeDecoyState(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: ManhuntFreezeDecoyStatePayload,
  ): void;
  freezeDecoyUsageState(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: ManhuntFreezeDecoyUsageStatePayload,
  ): void;
  lateGameClueState(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: ManhuntLateGameClueStatePayload,
  ): void;
  lateGameWarningState(
    roomCode: RoomCode,
    playerId: PlayerId,
    payload: ManhuntLateGameWarningStatePayload,
  ): void;
}

const MISSION_ASSIGNMENT_WINDOW_SECONDS = 60;
const MISSION_ACTIVATION_RETRY_DELAY_MS = 1_000;
const LATE_GAME_LOCATION_HISTORY_MAX_SAMPLES_PER_HIDER = 128;
const MAX_LATE_GAME_EXPOSURE_TIMER_MS = 2_147_483_647;

export class ManhuntGameService {
  private readonly currentGames = new Map<RoomCode, ManhuntRecord>();
  private readonly scheduledGameTimers = new Map<GameSessionId, Set<GameTimer>>();
  private readonly pendingReadyPlayerIds = new Map<RoomCode, Set<PlayerId>>();
  private readonly pendingFinishes = new Map<GameSessionId, Promise<void>>();
  private readonly pendingLobbyReturns = new Map<RoomCode, Promise<Room>>();
  private readonly preparedStarts = new WeakMap<
    PreparedManhuntGameStart,
    ManhuntGameStartPlan
  >();

  constructor(
    private readonly rooms: RoomService,
    private readonly events: ManhuntGameEvents,
    private readonly runtime: GameRuntime = {
      now: () => new Date(),
      schedule: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return { cancel: () => clearTimeout(timer) };
      },
    },
    private readonly missionRandomInt: (min: number, max: number) => number =
      randomInt,
    private readonly freezeRangeMeters?: number,
    private readonly ghostUsageLimit?: number,
    private readonly freezeDecoyRandomInt: (min: number, max: number) => number =
      randomInt,
    private readonly lateGameExposureDurations?: LateGameExposureDurations | null,
    private readonly lateGameExposureRandomInt: (min: number, max: number) => number =
      randomInt,
    private readonly persistenceCommands?: RoomPersistenceCommands,
  ) {
    this.rooms.onGameplaySuspended((suspension) => {
      if (!suspension.gameId) {
        return;
      }
      const timers = this.scheduledGameTimers.get(suspension.gameId);
      if (!timers) {
        return;
      }
      for (const timer of timers) {
        try {
          timer.cancel();
        } catch (error) {
          console.error(
            JSON.stringify({
              level: "error",
              event: "suspended_game_timer_cancellation_failed",
              roomCode: suspension.roomCode,
              gameId: suspension.gameId,
              error: error instanceof Error ? error.name : "unknown",
            }),
          );
        }
      }
      this.scheduledGameTimers.delete(suspension.gameId);
    });
  }

  getCurrentBoundary(roomCode: RoomCode): ManhuntBoundary | undefined {
    const boundary =
      this.currentGames.get(roomCode)?.boundary ??
      this.rooms.getManhuntBoundary(roomCode);
    return boundary
      ? {
          center: { ...boundary.center },
          radiusMeters: boundary.radiusMeters,
        }
      : undefined;
  }

  getBoundaryForPlayer(
    roomCode: RoomCode,
    playerId: PlayerId,
  ): ManhuntBoundary | undefined {
    const game = this.currentGames.get(roomCode);
    if (game) {
      if (game.teams.get(playerId) !== "runner") {
        return undefined;
      }
      return {
        center: { ...game.boundary.center },
        radiusMeters: game.boundary.radiusMeters,
      };
    }

    const room = this.rooms.getPublicRoom(roomCode);
    if (!room || room.hostId !== playerId) {
      return undefined;
    }
    return this.rooms.getManhuntBoundary(roomCode);
  }

  updateSettings(
    roomCode: RoomCode,
    socketId: string,
    settings: ManhuntSettings,
  ): ManhuntSettings {
    this.rooms.assertGameplayAvailable(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    );
    const parsed = manhuntSettingsSchema.safeParse(settings);
    if (!parsed.success) {
      throw new AppError("INVALID_PAYLOAD", "Manhunt settings are invalid.");
    }
    const room = this.rooms.updateManhuntSettings(roomCode, socketId, parsed.data);
    this.publishSettingsUpdated(roomCode, parsed.data, room);
    return parsed.data;
  }

  publishSettingsUpdated(
    roomCode: RoomCode,
    settings: ManhuntSettings,
    room: Room,
  ): void {
    this.assertGameplayAvailable(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    );
    this.events.roomUpdated(room);
    this.events.settingsUpdated(roomCode, {
      roomCode,
      settings: {
        hunterCount: settings.hunterCount,
        ...(settings.gameDurationSeconds
          ? { gameDurationSeconds: settings.gameDurationSeconds }
          : {}),
      },
    });
    this.events.boundaryUpdated(roomCode, {
      roomCode,
      boundary: settings.boundary,
    });
  }

  startGame(roomCode: RoomCode, socketId: string): Extract<GameSession, { gameMode: "manhunt" }> {
    return this.commitPreparedStart(this.prepareStart(roomCode, socketId));
  }

  prepareStart(
    roomCode: RoomCode,
    socketId: string,
  ): PreparedManhuntGameStart {
    this.rooms.assertGameplayAvailable(roomCode);
    const room = this.rooms.getPublicRoom(roomCode);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }
    this.rooms.assertHost(roomCode, socketId);
    if (room.settings.gameMode !== "manhunt") {
      throw new AppError("GAME_NOT_READY", "This room is not configured for Manhunt.");
    }
    if (room.players.length < 2) {
      throw new AppError("GAME_NOT_READY", "Manhunt requires at least 2 connected players.");
    }
    if (room.players.some((player) => player.connectionStatus !== "connected")) {
      throw new AppError("GAME_NOT_READY", "All players must be connected before the game can start.");
    }
    const publicSettings = room.settings.manhunt;
    const boundary = this.rooms.getManhuntBoundary(roomCode);
    if (!publicSettings || !boundary) {
      throw new AppError("INVALID_PAYLOAD", "Manhunt settings are required before starting.");
    }
    const settings = manhuntSettingsSchema.safeParse({
      ...publicSettings,
      boundary,
    });
    if (!settings.success) {
      throw new AppError("INVALID_PAYLOAD", "Manhunt settings are required before starting.");
    }
    const hunterCount =
      room.players.length === 2 ? 1 : settings.data.hunterCount;
    if (hunterCount >= room.players.length) {
      throw new AppError("GAME_NOT_READY", "At least one player must be assigned as a runner.");
    }
    const previous = this.currentGames.get(roomCode);
    if (previous && (previous.session.status === "starting" || previous.session.status === "in_progress")) {
      throw new AppError("GAME_NOT_ACTIVE", "A Manhunt game is already in progress.");
    }

    const now = this.runtime.now();
    const sessionId = randomUUID();
    const assignments = this.assignTeams(
      room.players.map((player) => player.id),
      hunterCount,
    );
    const teams = new Map(assignments.map((assignment) => [assignment.playerId, assignment.team]));
    const readyPlayerIds = new Set(
      this.pendingReadyPlayerIds.get(roomCode) ?? [],
    );
    const state: ManhuntGameState = {
      phase: "countdown",
      settings: {
        hunterCount,
        ...(settings.data.gameDurationSeconds
          ? { gameDurationSeconds: settings.data.gameDurationSeconds }
          : {}),
      },
      readyPlayerIds: [...readyPlayerIds],
      countdownEndsAt: new Date(
        now.getTime() + MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000,
      ).toISOString(),
      runnerHeadStartEndsAt: new Date(
        now.getTime() + MANHUNT_RUNNER_HEAD_START_SECONDS * 1_000,
      ).toISOString(),
    };
    const session: Extract<GameSession, { gameMode: "manhunt" }> = {
      id: sessionId,
      roomCode,
      status: "starting",
      startedAt: now.toISOString(),
      gameMode: "manhunt",
      state,
    };
    const game: ManhuntRecord = {
      roomCode,
      session,
      boundary: {
        center: { ...boundary.center },
        radiusMeters: boundary.radiusMeters,
      },
      teams,
      locations: new Map(),
      lateGameLocationHistory: new Map(),
      lateGameExposure: { triggered: false },
      pendingCatchRequests: new Map(),
      pendingCatchByHunter: new Map(),
      pendingCatchByTarget: new Map(),
      proximityPairs: new Map(),
      revealActive: false,
      usedFreezeRequestIds: new Set(),
      footstepsByHunter: new Map(
        [...teams.entries()]
          .filter(([, team]) => team === "hunter")
          .map(([playerId]) => [
            playerId,
            { usedRequestIds: new Set<string>(), uses: 0, guidances: new Map() },
          ]),
      ),
      smokeBombByHider: new Map(
        [...teams.entries()]
          .filter(([, team]) => team === "runner")
          .map(([playerId]) => [
            playerId,
            {
              usedRequestIds: new Set<string>(),
              uses: 0,
              activeEffects: new Map<string, ManhuntSmokeBombEffect>(),
            },
          ]),
      ),
      ghostByHider: new Map(
        [...teams.entries()]
          .filter(([, team]) => team === "runner")
          .map(([playerId]) => [
            playerId,
            {
              usedRequestIds: new Set<string>(),
              uses: 0,
              activeEffects: new Map<string, ManhuntGhostEffect>(),
            },
          ]),
      ),
      freezeDecoysByHider: new Map(
        [...teams.entries()]
          .filter(([, team]) => team === "runner")
          .map(([playerId]) => [
            playerId,
            {
              usedRequestIds: new Set<string>(),
              uses: 0,
              activeDecoys: new Map<string, ManhuntFreezeDecoy>(),
            },
          ]),
      ),
      caughtPlayerIds: new Set(),
      readyPlayerIds,
    };
    const prepared = Object.freeze({ roomCode, gameId: sessionId });
    this.preparedStarts.set(prepared, { socketId, game, assignments });
    return prepared;
  }

  discardPreparedStart(prepared: PreparedManhuntGameStart): void {
    this.preparedStarts.delete(prepared);
  }

  commitPreparedStart(
    prepared: PreparedManhuntGameStart,
    reservation?: RoomGameStatusReservation,
  ): Extract<GameSession, { gameMode: "manhunt" }> {
    this.rooms.assertGameplayAvailable(prepared.roomCode, prepared.gameId);
    const plan = this.preparedStarts.get(prepared);
    if (!plan) {
      throw new AppError("GAME_NOT_ACTIVE", "Prepared game start is no longer available.");
    }
    this.preparedStarts.delete(prepared);
    const { roomCode } = prepared;
    const { socketId, game, assignments } = plan;
    const { session } = game;
    try {
      game.countdownTimer = this.scheduleTrackedTimer(
        game,
        () => {
          void this.activateCountdown(roomCode, session.id).catch(
            (error: unknown) =>
              this.handleDurableActivationFailure(roomCode, session.id, error),
          );
        },
        MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000,
      );
    } catch (error) {
      game.countdownTimer?.cancel();
      throw error;
    }

    let publicRoom: Room;
    try {
      publicRoom = this.rooms.beginManhuntCountdown(
        roomCode,
        socketId,
        session.id,
        reservation,
      );
    } catch (error) {
      game.countdownTimer.cancel();
      game.countdownTimer = undefined;
      throw error;
    }
    this.currentGames.set(roomCode, game);
    this.pendingReadyPlayerIds.delete(roomCode);

    this.events.roomUpdated(publicRoom);
    this.events.gameStarted(roomCode, { session });
    this.events.stateUpdated(roomCode, {
      sessionId: session.id,
      roomCode,
      state: session.state,
      updatedAt: session.startedAt,
    });
    for (const assignment of assignments) {
      this.events.teamAssignment(roomCode, assignment.playerId, {
        sessionId: session.id,
        ...assignment,
      });
    }
    this.events.countdownUpdated(roomCode, this.createCountdownPayload(game));
    return session;
  }

  recordLocation(
    roomCode: RoomCode,
    socketId: string,
    coordinates: Coordinates,
    accuracyMeters?: number,
    clientTimestamp?: string,
  ): ManhuntLocationAcknowledgementPayload {
    this.assertGameplayAvailable(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    );
    if (
      !Number.isFinite(coordinates.latitude) ||
      coordinates.latitude < -90 ||
      coordinates.latitude > 90 ||
      !Number.isFinite(coordinates.longitude) ||
      coordinates.longitude < -180 ||
      coordinates.longitude > 180
    ) {
      throw new AppError("INVALID_PAYLOAD", "Location coordinates are invalid.");
    }
    if (
      accuracyMeters !== undefined &&
      (!Number.isFinite(accuracyMeters) ||
        accuracyMeters <= 0 ||
        accuracyMeters > 10_000)
    ) {
      throw new AppError("INVALID_PAYLOAD", "Location accuracy is invalid.");
    }
    const playerId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
    const game = this.currentGames.get(roomCode);
    const isActiveGame =
      game?.session.status === "in_progress" &&
      game.session.state.phase === "active";
    const isRunnerHeadStart =
      game?.session.status === "starting" &&
      game.session.state.phase === "countdown" &&
      game.teams.get(playerId) === "runner";
    if (!game || (!isActiveGame && !isRunnerHeadStart)) {
      throw new AppError("GAME_NOT_ACTIVE", "Manhunt is not active.");
    }
    if (!game.teams.has(playerId)) {
      throw new AppError("NOT_AUTHORIZED", "Player is not participating in this Manhunt.");
    }
    if (isActiveGame) {
      this.assertActivePlayer(roomCode, playerId);
    } else {
      const roomPlayer = this.rooms
        .getPublicRoom(roomCode)
        ?.players.find((player) => player.id === playerId);
      if (roomPlayer?.connectionStatus !== "connected") {
        throw new AppError(
          "GAME_NOT_READY",
          "The runner must be connected to update their location.",
        );
      }
    }
    if (
      isActiveGame &&
      game.freezeRound?.phase === "frozen" &&
      game.freezeRound.playerIds.has(playerId)
    ) {
      throw new AppError(
        "GAME_NOT_READY",
        "Location updates are paused while this player is frozen.",
      );
    }
    const recordedAt = this.runtime.now().toISOString();
    game.locations.set(playerId, {
      coordinates: { ...coordinates },
      accuracyMeters,
      recordedAt,
      clientTimestamp,
    });
    if (isActiveGame) {
      if (game.teams.get(playerId) === "runner") {
        this.recordLateGameHistoricalLocation(
          game,
          playerId,
          coordinates,
          Date.parse(recordedAt),
        );
      }
      this.updateProximity(game, playerId);
      this.updateMissionDwell(game, playerId);
    }
    return { sessionId: game.session.id, recordedAt };
  }

  activateFreeze(
    roomCode: RoomCode,
    socketId: string,
    sessionId: GameSessionId,
    requestId: string,
  ): void {
    this.assertGameplayAvailable(roomCode, sessionId);
    const hunterId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
    const game = this.currentGames.get(roomCode);
    if (
      !game ||
      game.session.id !== sessionId ||
      game.session.status !== "in_progress" ||
      game.session.state.phase !== "active"
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "Manhunt is not active.");
    }
    if (!game.teams.has(hunterId)) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Player is not participating in this Manhunt.",
      );
    }
    if (game.teams.get(hunterId) !== "hunter") {
      throw new AppError("NOT_AUTHORIZED", "Only hunters can use Freeze.");
    }
    this.assertActivePlayer(roomCode, hunterId);
    const freezeRangeMeters = this.freezeRangeMeters;
    if (
      freezeRangeMeters === undefined ||
      !Number.isFinite(freezeRangeMeters) ||
      freezeRangeMeters <= 0
    ) {
      throw new AppError(
        "GAME_NOT_READY",
        "Freeze is disabled until an approved range is configured.",
      );
    }
    if (game.usedFreezeRequestIds.has(requestId)) {
      throw new AppError(
        "GAME_NOT_READY",
        "This Freeze activation request has already been used.",
      );
    }
    if (game.freezeRound) {
      throw new AppError(
        "GAME_NOT_READY",
        "A Freeze activation is already in progress.",
      );
    }

    const hunterLocations = [...game.teams.entries()]
      .filter(
        ([playerId, team]) =>
          team === "hunter" &&
          !game.caughtPlayerIds.has(playerId) &&
          this.isActivePlayer(roomCode, playerId),
      )
      .map(([playerId]) => [
        playerId,
        this.getAccurateFreshLocation(game, playerId),
      ] as const)
      .filter(
        (entry): entry is readonly [PlayerId, PrivateLocation] =>
          entry[1] !== undefined,
      );
    if (!hunterLocations.some(([playerId]) => playerId === hunterId)) {
      throw new AppError(
        "GAME_NOT_READY",
        "A recent, accurate Hunter location is required to use Freeze.",
      );
    }

    const playerIds = new Set<PlayerId>();
    for (const [playerId, team] of game.teams) {
      if (
        team !== "runner" ||
        game.caughtPlayerIds.has(playerId) ||
        !this.isActivePlayer(roomCode, playerId)
      ) {
        continue;
      }
      const location = this.getAccurateFreshLocation(game, playerId);
      if (
        !location ||
        !hunterLocations.some(
          ([, hunterLocation]) =>
            haversineMeters(
              hunterLocation.coordinates,
              location.coordinates,
            ) <= freezeRangeMeters,
        )
      ) {
        continue;
      }
      playerIds.add(playerId);
    }
    if (playerIds.size === 0) {
      return;
    }

    game.usedFreezeRequestIds.add(requestId);
    const warningEndsAtMs =
      this.runtime.now().getTime() +
      MANHUNT_FREEZE_WARNING_SECONDS * 1_000;
    const round: ManhuntFreezeRound = {
      requestId,
      playerIds,
      phase: "warning",
      warningStartedAtMs: warningEndsAtMs -
        MANHUNT_FREEZE_WARNING_SECONDS * 1_000,
      warningEndsAtMs,
    };
    game.freezeRound = round;
    for (const playerId of playerIds) {
      this.events.freezeWarning(roomCode, playerId, {
        roomCode,
        sessionId,
        playerId,
        requestId,
        warningStartedAt: new Date(round.warningStartedAtMs).toISOString(),
        warningEndsAt: new Date(warningEndsAtMs).toISOString(),
      });
    }
    round.timer = this.scheduleTrackedTimer(
      game,
      () => this.beginFreeze(game, round),
      MANHUNT_FREEZE_WARNING_SECONDS * 1_000,
    );
  }

  activateFootsteps(
    roomCode: RoomCode,
    socketId: string,
    sessionId: GameSessionId,
    requestId: string,
  ): void {
    this.assertGameplayAvailable(roomCode, sessionId);
    const hunterId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
    const game = this.currentGames.get(roomCode);
    if (
      !game ||
      game.session.id !== sessionId ||
      game.session.status !== "in_progress" ||
      game.session.state.phase !== "active"
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "Manhunt is not active.");
    }
    if (!game.teams.has(hunterId)) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Player is not participating in this Manhunt.",
      );
    }
    if (game.teams.get(hunterId) !== "hunter") {
      throw new AppError("NOT_AUTHORIZED", "Only hunters can use Footsteps.");
    }
    this.assertActivePlayer(roomCode, hunterId);

    const hunterState = game.footstepsByHunter.get(hunterId);
    if (!hunterState) {
      throw new AppError("GAME_NOT_READY", "Footsteps is unavailable.");
    }
    if (hunterState.usedRequestIds.has(requestId)) {
      throw new AppError(
        "GAME_NOT_READY",
        "This Footsteps activation request has already been used.",
      );
    }
    if (hunterState.uses >= MANHUNT_FOOTSTEPS_MAX_USES_PER_GAME) {
      throw new AppError(
        "GAME_NOT_READY",
        "The Footsteps uses for this game have been exhausted.",
      );
    }

    const hunterLocation = this.getAccurateFreshLocation(game, hunterId);
    if (!hunterLocation) {
      throw new AppError(
        "GAME_NOT_READY",
        "A recent, accurate Hunter location is required to use Footsteps.",
      );
    }
    let nearestLocation: PrivateLocation | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const [playerId, team] of game.teams) {
      if (
        team !== "runner" ||
        game.caughtPlayerIds.has(playerId) ||
        !this.isActivePlayer(roomCode, playerId)
      ) {
        continue;
      }
      const location = this.getAccurateFreshLocation(game, playerId);
      if (!location) {
        continue;
      }
      const distance = haversineMeters(
        hunterLocation.coordinates,
        location.coordinates,
      );
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestLocation = location;
      }
    }
    if (!nearestLocation) {
      throw new AppError(
        "GAME_NOT_READY",
        "No eligible Hider has a recent, accurate location.",
      );
    }

    const startedAtMs = this.runtime.now().getTime();
    const guidance: ManhuntFootstepsGuidance = {
      requestId,
      bearingDegrees: calculateBearingDegrees(
        hunterLocation.coordinates,
        nearestLocation.coordinates,
      ),
      startedAtMs,
      expiresAtMs:
        startedAtMs + MANHUNT_FOOTSTEPS_DURATION_SECONDS * 1_000,
      timer: this.scheduleTrackedTimer(
        game,
        () => this.expireFootsteps(game, hunterId, requestId),
        MANHUNT_FOOTSTEPS_DURATION_SECONDS * 1_000,
      ),
    };
    hunterState.usedRequestIds.add(requestId);
    hunterState.uses += 1;
    hunterState.guidances.set(requestId, guidance);
    this.emitFootstepsState(game, hunterId);
  }

  activateSmokeBomb(
    roomCode: RoomCode,
    socketId: string,
    sessionId: GameSessionId,
    requestId: string,
  ): void {
    this.assertGameplayAvailable(roomCode, sessionId);
    const hiderId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
    const game = this.currentGames.get(roomCode);
    if (
      !game ||
      game.session.id !== sessionId ||
      game.session.status !== "in_progress" ||
      game.session.state.phase !== "active"
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "Manhunt is not active.");
    }
    if (!game.teams.has(hiderId)) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Player is not participating in this Manhunt.",
      );
    }
    if (game.teams.get(hiderId) !== "runner") {
      throw new AppError("NOT_AUTHORIZED", "Only Hiders can use Smoke Bomb.");
    }
    if (game.caughtPlayerIds.has(hiderId)) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Caught players cannot use Smoke Bomb.",
      );
    }
    this.assertActivePlayer(roomCode, hiderId);

    const hiderState = game.smokeBombByHider.get(hiderId);
    if (!hiderState) {
      throw new AppError("GAME_NOT_READY", "Smoke Bomb is unavailable.");
    }
    if (hiderState.usedRequestIds.has(requestId)) {
      throw new AppError(
        "GAME_NOT_READY",
        "This Smoke Bomb activation request has already been used.",
      );
    }
    if (hiderState.uses >= MANHUNT_SMOKE_BOMB_MAX_USES_PER_GAME) {
      throw new AppError(
        "GAME_NOT_READY",
        "The Smoke Bomb uses for this game have been exhausted.",
      );
    }

    const startedAtMs = this.runtime.now().getTime();
    const effect: ManhuntSmokeBombEffect = {
      requestId,
      startedAtMs,
      expiresAtMs:
        startedAtMs + MANHUNT_SMOKE_BOMB_DURATION_SECONDS * 1_000,
      timer: this.scheduleTrackedTimer(
        game,
        () => this.expireSmokeBomb(game, hiderId, requestId),
        MANHUNT_SMOKE_BOMB_DURATION_SECONDS * 1_000,
      ),
    };
    hiderState.usedRequestIds.add(requestId);
    hiderState.uses += 1;
    hiderState.activeEffects.set(requestId, effect);
    this.emitSmokeBombState(game, hiderId);
  }

  activateGhost(
    roomCode: RoomCode,
    socketId: string,
    sessionId: GameSessionId,
    requestId: string,
  ): void {
    this.assertGameplayAvailable(roomCode, sessionId);
    const hiderId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
    const game = this.currentGames.get(roomCode);
    if (
      !game ||
      game.session.id !== sessionId ||
      game.session.status !== "in_progress" ||
      game.session.state.phase !== "active"
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "Manhunt is not active.");
    }
    if (!game.teams.has(hiderId)) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Player is not participating in this Manhunt.",
      );
    }
    if (game.teams.get(hiderId) !== "runner") {
      throw new AppError("NOT_AUTHORIZED", "Only Hiders can use Ghost.");
    }
    if (game.caughtPlayerIds.has(hiderId)) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Caught players cannot use Ghost.",
      );
    }
    this.assertActivePlayer(roomCode, hiderId);

    const usageLimit = this.getConfiguredGhostUsageLimit();
    if (usageLimit === undefined) {
      throw new AppError(
        "GAME_NOT_READY",
        "Ghost is unavailable until its per-game usage limit is configured.",
      );
    }
    const hiderState = game.ghostByHider.get(hiderId);
    if (!hiderState) {
      throw new AppError("GAME_NOT_READY", "Ghost is unavailable.");
    }
    if (hiderState.usedRequestIds.has(requestId)) {
      throw new AppError(
        "GAME_NOT_READY",
        "This Ghost activation request has already been used.",
      );
    }
    if (hiderState.uses >= usageLimit) {
      throw new AppError(
        "GAME_NOT_READY",
        "The Ghost uses for this game have been exhausted.",
      );
    }

    const startedAtMs = this.runtime.now().getTime();
    const effect: ManhuntGhostEffect = {
      requestId,
      startedAtMs,
      expiresAtMs: startedAtMs + MANHUNT_GHOST_DURATION_SECONDS * 1_000,
      timer: this.scheduleTrackedTimer(
        game,
        () => this.expireGhost(game, hiderId, requestId),
        MANHUNT_GHOST_DURATION_SECONDS * 1_000,
      ),
    };
    hiderState.usedRequestIds.add(requestId);
    hiderState.uses += 1;
    hiderState.activeEffects.set(requestId, effect);
    this.emitGhostState(game, hiderId);
  }

  activateFreezeDecoy(
    roomCode: RoomCode,
    socketId: string,
    sessionId: GameSessionId,
    requestId: string,
  ): void {
    this.assertGameplayAvailable(roomCode, sessionId);
    const hiderId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
    const game = this.currentGames.get(roomCode);
    if (
      !game ||
      game.session.id !== sessionId ||
      game.session.status !== "in_progress" ||
      game.session.state.phase !== "active"
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "Manhunt is not active.");
    }
    if (!game.teams.has(hiderId)) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Player is not participating in this Manhunt.",
      );
    }
    if (game.teams.get(hiderId) !== "runner") {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Only Hiders can use Freeze Decoy.",
      );
    }
    if (game.caughtPlayerIds.has(hiderId)) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Caught players cannot use Freeze Decoy.",
      );
    }
    this.assertActivePlayer(roomCode, hiderId);

    const hiderState = game.freezeDecoysByHider.get(hiderId);
    if (!hiderState) {
      throw new AppError("GAME_NOT_READY", "Freeze Decoy is unavailable.");
    }
    if (hiderState.usedRequestIds.has(requestId)) {
      throw new AppError(
        "GAME_NOT_READY",
        "This Freeze Decoy activation request has already been used.",
      );
    }
    if (hiderState.uses >= MANHUNT_FREEZE_DECOY_MAX_USES_PER_GAME) {
      throw new AppError(
        "GAME_NOT_READY",
        "The Freeze Decoy uses for this game have been exhausted.",
      );
    }

    this.pruneFreezeDecoys(game);
    const coordinates = this.generateFreezeDecoyCoordinates(game);
    const startedAtMs = this.runtime.now().getTime();
    const decoyId = randomUUID();
    const decoy: ManhuntFreezeDecoy = {
      decoyId,
      coordinates,
      startedAtMs,
      expiresAtMs:
        startedAtMs + MANHUNT_FREEZE_DECOY_DURATION_SECONDS * 1_000,
      timer: this.scheduleTrackedTimer(
        game,
        () => this.expireFreezeDecoy(game, hiderId, decoyId),
        MANHUNT_FREEZE_DECOY_DURATION_SECONDS * 1_000,
      ),
    };
    hiderState.usedRequestIds.add(requestId);
    hiderState.uses += 1;
    hiderState.activeDecoys.set(decoyId, decoy);
    this.emitFreezeDecoyUsageState(game, hiderId);
    this.emitFreezeDecoyState(game);
  }

  getResumeSnapshot(roomCode: RoomCode, playerId: PlayerId):
    | {
        started: import("@impostor/api").GameStartedPayload;
        state: import("@impostor/api").GameStateUpdatePayload;
        teamAssignment: import("@impostor/api").ManhuntTeamAssignmentPayload;
        missionAssignment?: ManhuntMissionAssignmentPayload;
        missionReveal?: ManhuntMissionRevealPayload;
        freezeWarning?: ManhuntFreezeWarningPayload;
        playerFrozen?: PlayerFrozenPayload;
        footsteps?: ManhuntFootstepsStatePayload;
        smokeBomb?: ManhuntSmokeBombStatePayload;
        ghost?: ManhuntGhostStatePayload;
        freezeDecoys?: ManhuntFreezeDecoyStatePayload;
        freezeDecoyUsage?: ManhuntFreezeDecoyUsageStatePayload;
        lateGameClue?: ManhuntLateGameClueStatePayload;
        lateGameWarning?: ManhuntLateGameWarningStatePayload;
        countdown?: CountdownPayload;
        ended?: GameEndedPayload;
      }
    | undefined {
    const game = this.currentGames.get(roomCode);
    if (game && this.rooms.isGameplaySuspended(roomCode, game.session.id)) {
      return undefined;
    }
    if (!game || !game.teams.has(playerId)) {
      return undefined;
    }
    const state = game.session.state;
    const missionAssignment = this.getMissionAssignmentPayload(
      game,
      playerId,
    );
    const missionReveal = this.getMissionRevealPayload(game, playerId);
    const freezeState = this.getFreezeStatePayload(game, playerId);
    const footsteps = game.teams.get(playerId) === "hunter"
      ? this.createFootstepsStatePayload(game, playerId)
      : undefined;
    const smokeBomb = game.teams.get(playerId) === "runner"
      ? this.createSmokeBombStatePayload(game, playerId)
      : undefined;
    if (game.teams.get(playerId) === "runner") {
      this.syncGhostEffectTimers(game, playerId);
    }
    const ghost = game.teams.get(playerId) === "runner"
      ? this.createGhostStatePayload(game, playerId)
      : undefined;
    if (
      game.teams.get(playerId) === "hunter" &&
      game.session.status === "in_progress"
    ) {
      this.pruneFreezeDecoys(game);
    }
    const freezeDecoys =
      game.teams.get(playerId) === "hunter" &&
      game.session.status === "in_progress" &&
      game.session.state.phase === "active"
        ? this.createFreezeDecoyStatePayload(game)
        : undefined;
    const freezeDecoyUsage =
      game.teams.get(playerId) === "runner" &&
      game.session.status === "in_progress" &&
      game.session.state.phase === "active"
      ? this.createFreezeDecoyUsageStatePayload(game, playerId)
      : undefined;
    const lateGameClue =
      game.teams.get(playerId) === "hunter" &&
      game.session.status === "in_progress" &&
      game.session.state.phase === "active"
        ? this.createLateGameClueStatePayload(game)
        : undefined;
    const lateGameWarning =
      game.teams.get(playerId) === "runner" &&
      game.session.status === "in_progress" &&
      game.session.state.phase === "active"
        ? this.createLateGameWarningStatePayload(game, playerId)
        : undefined;
    return {
      started: { session: game.session },
      state: {
        sessionId: game.session.id,
        roomCode,
        state,
        updatedAt: this.runtime.now().toISOString(),
      },
      teamAssignment: {
        sessionId: game.session.id,
        playerId,
        team: game.teams.get(playerId)!,
      },
      ...(missionAssignment ? { missionAssignment } : {}),
      ...(missionReveal ? { missionReveal } : {}),
      ...(freezeState?.type === "warning"
        ? { freezeWarning: freezeState.payload }
        : {}),
      ...(freezeState?.type === "frozen"
        ? { playerFrozen: freezeState.payload }
        : {}),
      ...(footsteps ? { footsteps } : {}),
      ...(smokeBomb ? { smokeBomb } : {}),
      ...(ghost ? { ghost } : {}),
      ...(freezeDecoys ? { freezeDecoys } : {}),
      ...(freezeDecoyUsage ? { freezeDecoyUsage } : {}),
      ...(lateGameClue ? { lateGameClue } : {}),
      ...(lateGameWarning ? { lateGameWarning } : {}),
      ...(state.phase === "countdown"
        ? { countdown: this.createCountdownPayload(game) }
        : {}),
      ...(game.result ? { ended: game.result } : {}),
    };
  }

  getCountdownSync(
    roomCode: RoomCode,
    socketId: string,
    sessionId: GameSessionId,
  ): CountdownSyncResponsePayload {
    this.assertGameplayAvailable(roomCode, sessionId);
    const playerId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
    const game = this.currentGames.get(roomCode);
    if (
      !game ||
      !game.teams.has(playerId) ||
      game.session.id !== sessionId ||
      game.session.status !== "starting" ||
      game.session.state.phase !== "countdown" ||
      !game.session.state.countdownEndsAt ||
      !game.session.state.runnerHeadStartEndsAt
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "The Manhunt countdown is no longer active.");
    }
    return {
      roomCode,
      sessionId,
      endsAt: game.session.state.countdownEndsAt,
      runnerHeadStartEndsAt: game.session.state.runnerHeadStartEndsAt,
      serverNow: this.runtime.now().toISOString(),
    };
  }

  setReady(roomCode: RoomCode, socketId: string, ready: boolean): void {
    this.assertGameplayAvailable(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    );
    const playerId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
    this.rooms.assertRoomNotReserved(roomCode);
    const game = this.currentGames.get(roomCode);
    if (!game) {
      const room = this.rooms.getPublicRoom(roomCode);
      if (!room || room.gameStatus !== "waiting" || room.settings.gameMode !== "manhunt") {
        throw new AppError("GAME_NOT_ACTIVE", "Manhunt setup is not active.");
      }
      if (!room.players.some((player) => player.id === playerId)) {
        throw new AppError("NOT_AUTHORIZED", "Player is not in this Manhunt.");
      }
      const readyPlayers =
        this.pendingReadyPlayerIds.get(roomCode) ?? new Set<PlayerId>();
      if (ready) {
        readyPlayers.add(playerId);
      } else {
        readyPlayers.delete(playerId);
      }
      this.pendingReadyPlayerIds.set(roomCode, readyPlayers);
      this.events.readyUpdated(roomCode, {
        roomCode,
        readyPlayerIds: [...readyPlayers],
      });
      return;
    }
    if (!game.teams.has(playerId)) {
      throw new AppError("NOT_AUTHORIZED", "Player is not participating in this Manhunt.");
    }
    if (ready) {
      game.readyPlayerIds.add(playerId);
    } else {
      game.readyPlayerIds.delete(playerId);
    }
    game.session.state.readyPlayerIds = [...game.readyPlayerIds];
    this.events.readyUpdated(roomCode, {
      roomCode,
      readyPlayerIds: [...game.readyPlayerIds],
    });
  }

  attemptCatch(
    roomCode: RoomCode,
    socketId: string,
    targetPlayerId: PlayerId,
  ): CatchConfirmationRequestPayload {
    this.assertGameplayAvailable(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    );
    const hunterId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
    const game = this.currentGames.get(roomCode);
    if (
      !game ||
      game.session.status !== "in_progress" ||
      !game.teams.has(hunterId)
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "Manhunt is not active.");
    }
    if (game.teams.get(hunterId) !== "hunter") {
      throw new AppError("NOT_AUTHORIZED", "Only hunters can catch runners.");
    }
    this.assertActivePlayer(roomCode, hunterId);
    if (!game.teams.has(targetPlayerId)) {
      throw new AppError("INVALID_VOTE", "The target is not in this Manhunt.");
    }
    if (game.teams.get(targetPlayerId) !== "runner") {
      throw new AppError("INVALID_VOTE", "The target is not a runner.");
    }
    if (game.caughtPlayerIds.has(targetPlayerId)) {
      throw new AppError("INVALID_VOTE", "The runner has already been caught.");
    }
    this.assertActivePlayer(roomCode, targetPlayerId);
    if (
      game.pendingCatchByHunter.has(hunterId) ||
      game.pendingCatchByTarget.has(targetPlayerId)
    ) {
      throw new AppError(
        "GAME_NOT_READY",
        "A catch confirmation is already pending for one of these players.",
      );
    }

    const hunterLocation = this.getFreshLocation(game, hunterId);
    const targetLocation = this.getFreshLocation(game, targetPlayerId);
    if (!hunterLocation || !targetLocation) {
      throw new AppError(
        "GAME_NOT_READY",
        "Both players need a recent GPS position before requesting a catch.",
      );
    }
    const distance = haversineMeters(
      hunterLocation.coordinates,
      targetLocation.coordinates,
    );
    if (distance > MANHUNT_CATCH_DISTANCE_METERS) {
      throw new AppError(
        "INVALID_VOTE",
        "The target is farther than 1.5 metres away.",
      );
    }

    const room = this.rooms.getPublicRoom(roomCode);
    const hunter = room?.players.find((player) => player.id === hunterId);
    if (!hunter) {
      throw new AppError("NOT_AUTHORIZED", "The hunter is not in this room.");
    }
    const requestId = randomUUID();
    const expiresAt = new Date(
      this.runtime.now().getTime() +
        MANHUNT_CATCH_REQUEST_DURATION_SECONDS * 1_000,
    ).toISOString();
    const request: PendingCatchRequest = {
      requestId,
      hunterId,
      targetId: targetPlayerId,
      expiresAt,
      timer: this.scheduleTrackedTimer(
        game,
        () => this.expireCatchRequest(roomCode, requestId),
        MANHUNT_CATCH_REQUEST_DURATION_SECONDS * 1_000,
      ),
    };
    game.pendingCatchRequests.set(requestId, request);
    game.pendingCatchByHunter.set(hunterId, requestId);
    game.pendingCatchByTarget.set(targetPlayerId, requestId);
    const payload: CatchConfirmationRequestPayload = {
      roomCode,
      sessionId: game.session.id,
      requestId,
      hunterNickname: hunter.nickname,
      expiresAt,
    };
    this.events.catchConfirmationRequested(roomCode, targetPlayerId, payload);
    this.events.catchRequestStatus(roomCode, hunterId, {
      roomCode,
      sessionId: game.session.id,
      requestId,
      status: "pending",
    });
    return payload;
  }

  respondToCatch(
    roomCode: RoomCode,
    socketId: string,
    requestId: string,
    accepted: boolean,
  ): void {
    this.assertGameplayAvailable(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    );
    const playerId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
    const game = this.currentGames.get(roomCode);
    const request = game?.pendingCatchRequests.get(requestId);
    if (!game || !request) {
      throw new AppError("GAME_NOT_READY", "This catch request is no longer active.");
    }
    if (request.targetId !== playerId) {
      throw new AppError("NOT_AUTHORIZED", "This catch request is for another player.");
    }
    if (Date.parse(request.expiresAt) <= this.runtime.now().getTime()) {
      this.finishPendingCatch(game, request, "expired");
      throw new AppError("GAME_NOT_READY", "This catch request has expired.");
    }
    if (
      game.session.status !== "in_progress" ||
      !this.isActivePlayer(roomCode, request.hunterId) ||
      !this.isActivePlayer(roomCode, request.targetId)
    ) {
      this.finishPendingCatch(game, request, "cancelled");
      throw new AppError("GAME_NOT_ACTIVE", "This catch request is no longer valid.");
    }
    if (!accepted) {
      this.finishPendingCatch(game, request, "rejected");
      return;
    }

    const hunterLocation = this.getFreshLocation(game, request.hunterId);
    const targetLocation = this.getFreshLocation(game, request.targetId);
    if (!hunterLocation || !targetLocation) {
      this.finishPendingCatch(game, request, "cancelled");
      throw new AppError(
        "GAME_NOT_READY",
        "The catch request cannot be confirmed without recent GPS positions.",
      );
    }
    const distance = haversineMeters(
      hunterLocation.coordinates,
      targetLocation.coordinates,
    );
    if (distance > MANHUNT_CATCH_DISTANCE_METERS) {
      this.finishPendingCatch(game, request, "cancelled");
      throw new AppError(
        "GAME_NOT_READY",
        "The players are no longer within 1.5 metres.",
      );
    }

    const room = this.rooms.getPublicRoom(roomCode);
    const caughtPlayer = room?.players.find(
      (player) => player.id === request.targetId,
    );
    if (!caughtPlayer) {
      this.finishPendingCatch(game, request, "cancelled");
      throw new AppError("INVALID_VOTE", "The runner is no longer in this room.");
    }
    const publicRoom = this.rooms.markPlayerCaught(
      roomCode,
      game.session.id,
      request.targetId,
    );
    game.caughtPlayerIds.add(request.targetId);
    game.locations.delete(request.targetId);
    this.clearLateGameLocationHistory(game, request.targetId);
    this.clearLateGameExposureForHider(game, request.targetId);
    this.clearFreezeForPlayer(game, request.targetId, true);
    this.clearSmokeBombForPlayer(game, request.targetId);
    this.clearGhostForPlayer(game, request.targetId);
    this.clearFreezeDecoysForPlayer(game, request.targetId);
    this.clearProximityForPlayer(game, request.targetId);
    this.finishPendingCatch(game, request, "accepted");
    this.events.roomUpdated(publicRoom);

    const caughtAt = this.runtime.now().toISOString();
    this.events.playerCaught(roomCode, {
      roomCode,
      catcherPlayerId: request.hunterId,
      caughtPlayerId: request.targetId,
      caughtAt,
    });
    this.events.catchConfirmed(roomCode, {
      roomCode,
      sessionId: game.session.id,
      requestId,
      caughtNickname: caughtPlayer.nickname,
      caughtAt,
    });

    const runners = [...game.teams.entries()]
      .filter(([, team]) => team === "runner")
      .map(([runnerId]) => runnerId);
    if (runners.every((runnerId) => game.caughtPlayerIds.has(runnerId))) {
      this.endGame(game, "hunter");
      return;
    }
    this.markMissionPlayerUnavailable(game, request.targetId);
    this.evaluateLateGameExposure(game);
  }

  onPlayerDisconnected(roomCode: RoomCode, playerId: PlayerId): void {
    if (this.rooms.isGameplaySuspended(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    )) {
      return;
    }
    const game = this.currentGames.get(roomCode);
    if (!game) {
      return;
    }
    this.deactivatePlayer(game, playerId);
    this.syncGhostEffectTimers(game, playerId);
    this.evaluateLateGameExposure(game);
  }

  onPlayerConnected(roomCode: RoomCode, playerId: PlayerId): void {
    if (this.rooms.isGameplaySuspended(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    )) {
      return;
    }
    const game = this.currentGames.get(roomCode);
    if (!game || !game.teams.has(playerId)) {
      return;
    }
    this.evaluateLateGameExposure(game);
  }

  close(roomCode: RoomCode): void {
    this.clearSession(roomCode);
  }

  shutdown(): void {
    for (const roomCode of [...this.currentGames.keys()]) {
      this.clearSession(roomCode);
    }
  }

  returnToLobby(roomCode: RoomCode, socketId: string): Promise<Room> {
    this.assertGameplayAvailable(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    );
    const pending = this.pendingLobbyReturns.get(roomCode);
    if (pending) {
      return pending;
    }
    const operation = this.returnToLobbyCore(roomCode, socketId);
    const tracked = operation.finally(() => {
      if (this.pendingLobbyReturns.get(roomCode) === tracked) {
        this.pendingLobbyReturns.delete(roomCode);
      }
    });
    this.pendingLobbyReturns.set(roomCode, tracked);
    return tracked;
  }

  private async returnToLobbyCore(
    roomCode: RoomCode,
    socketId: string,
  ): Promise<Room> {
    this.rooms.assertHost(roomCode, socketId);
    const room = this.rooms.getPublicRoom(roomCode);
    if (room?.gameStatus === "waiting" && !room.currentGameId) {
      return room;
    }
    const game = this.currentGames.get(roomCode);
    if (
      !room
      || room.gameStatus !== "finished"
      || !game
      || game.session.status !== "finished"
      || room.currentGameId !== game.session.id
    ) {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Only a finished Manhunt game can return to the lobby.",
      );
    }

    if (!this.persistenceCommands) {
      const lobby = this.rooms.returnFinishedGameToLobby(
        roomCode,
        socketId,
        game.session.id,
      );
      this.clearSession(roomCode);
      return lobby;
    }

    return persistFinishedGameReturnToLobby(
      this.rooms,
      this.persistenceCommands,
      roomCode,
      socketId,
      game.session.id,
      (reservation) => {
        const lobby = this.rooms.returnFinishedGameToLobby(
          roomCode,
          socketId,
          game.session.id,
          reservation,
        );
        this.clearSession(roomCode);
        return lobby;
      },
    );
  }

  onPlayerRemoved(
    roomCode: RoomCode,
    roomStillExists: boolean,
  ): void | Promise<void> {
    if (this.rooms.isGameplaySuspended(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    )) {
      return;
    }
    const game = this.currentGames.get(roomCode);
    if (!game) return;
    if (!roomStillExists) {
      this.clearSession(roomCode);
      return;
    }
    if (game.session.state.phase === "countdown") {
      return this.cancelCountdown(
        roomCode,
        game,
        "player_left",
      );
      return;
    }
    if (game.session.status !== "in_progress") return;

    const room = this.rooms.getPublicRoom(roomCode);
    const removedPlayerId = [...game.teams.keys()].find(
      (playerId) => !room?.players.some((player) => player.id === playerId),
    );
    if (!removedPlayerId) return;

    this.deactivatePlayer(game, removedPlayerId);
    this.clearLateGameLocationHistory(game, removedPlayerId);
    this.clearLateGameExposureForHider(game, removedPlayerId);
    this.clearFootstepsForPlayer(game, removedPlayerId);
    this.clearSmokeBombForPlayer(game, removedPlayerId);
    this.clearGhostForPlayer(game, removedPlayerId);
    this.clearFreezeDecoysForPlayer(game, removedPlayerId);
    game.teams.delete(removedPlayerId);
    game.readyPlayerIds.delete(removedPlayerId);
    game.session.state.readyPlayerIds =
      game.session.state.readyPlayerIds.filter(
        (playerId) => playerId !== removedPlayerId,
      );
    this.events.stateUpdated(roomCode, {
      sessionId: game.session.id,
      roomCode,
      state: game.session.state,
      updatedAt: this.runtime.now().toISOString(),
    });

    const remainingRunners = [...game.teams.entries()]
      .filter(([, team]) => team === "runner")
      .map(([playerId]) => playerId);
    if (remainingRunners.every((playerId) => game.caughtPlayerIds.has(playerId))) {
      this.endGame(game, "hunter");
    } else {
      this.evaluateLateGameExposure(game);
    }
  }

  clearSession(roomCode: RoomCode): void {
    this.pendingReadyPlayerIds.delete(roomCode);
    const game = this.currentGames.get(roomCode);
    if (game) {
      const scheduledTimers = this.scheduledGameTimers.get(game.session.id);
      if (scheduledTimers) {
        for (const timer of scheduledTimers) {
          timer.cancel();
        }
        this.scheduledGameTimers.delete(game.session.id);
      }
      for (const request of [...game.pendingCatchRequests.values()]) {
        this.finishPendingCatch(game, request, "cancelled");
      }
      game.cycleTimer?.cancel();
      game.countdownTimer?.cancel();
      game.revealTimer?.cancel();
      game.gameTimer?.cancel();
      game.zoneWarningTimer?.cancel();
      game.zoneShrinkTimer?.cancel();
      this.clearLateGameExposure(game);
      this.clearMissionTimers(game);
      this.clearFreezeRound(game, false);
      this.clearFootsteps(game);
      this.clearSmokeBombs(game);
      this.clearGhosts(game);
      this.clearAllFreezeDecoys(game);
      game.locations.clear();
      game.proximityPairs.clear();
      game.readyPlayerIds.clear();
      game.teams.clear();
      game.caughtPlayerIds.clear();
    }
    this.currentGames.delete(roomCode);
  }

  private async activateCountdown(
    roomCode: RoomCode,
    sessionId: GameSessionId,
  ): Promise<void> {
    this.assertGameplayAvailable(roomCode, sessionId);
    const game = this.currentGames.get(roomCode);
    if (
      !game ||
      game.session.id !== sessionId ||
      game.session.status !== "starting" ||
      game.session.state.phase !== "countdown"
    ) {
      return;
    }

    if (!this.persistenceCommands) {
      const room = this.rooms.getPublicRoom(roomCode);
      if (
        !room ||
        room.currentGameId !== sessionId ||
        room.gameStatus !== "starting"
      ) {
        await this.cancelCountdown(roomCode, game, "room_unavailable");
        return;
      }
      if (
        room.players.length < 2 ||
        room.players.some((player) => player.connectionStatus !== "connected")
      ) {
        await this.cancelCountdown(roomCode, game, "player_disconnected");
        return;
      }
      this.commitCountdownActivation(game);
      return;
    }

    const reservation =
      await this.persistenceCommands.acquireGameStatusReservation(
        roomCode,
        "starting",
        sessionId,
      );
    let cancellationReason:
      | ManhuntCountdownCancelledPayload["reason"]
      | undefined;
    try {
      const room = this.rooms.getPublicRoom(roomCode);
      if (
        !room ||
        room.currentGameId !== sessionId ||
        room.gameStatus !== "starting"
      ) {
        fenceDurableGameRoom(
          this.rooms,
          this.persistenceCommands,
          roomCode,
        );
        return;
      }
      if (
        room.players.length < 2 ||
        room.players.some((player) => player.connectionStatus !== "connected")
      ) {
        cancellationReason = "player_disconnected";
      } else {
        try {
          await this.persistenceCommands.transitionRoomGameStatus({
            roomCode,
            expectedStatus: "starting",
            nextStatus: "in_progress",
            expectedCurrentGameId: sessionId,
            nextGameId: sessionId,
            initiatedBy: { kind: "game-service" },
            reservation,
          });
        } catch (error) {
          fenceDurableGameRoom(
            this.rooms,
            this.persistenceCommands,
            roomCode,
          );
          throw error;
        }

        try {
          this.commitCountdownActivation(game, reservation);
        } catch (error) {
          fenceDurableGameRoom(
            this.rooms,
            this.persistenceCommands,
            roomCode,
          );
          console.error(
            JSON.stringify({
              level: "error",
              event: "durable_game_activation_commit_failed",
              roomCode,
              gameId: sessionId,
              error: error instanceof Error ? error.message : "unknown",
            }),
          );
          throw new AppError(
            "UNKNOWN",
            "The durable game transition committed but live state could not be synchronized safely.",
          );
        }
      }
    } finally {
      this.rooms.releaseGameStatusReservation(reservation);
    }

    if (cancellationReason) {
      await this.cancelCountdown(roomCode, game, cancellationReason);
    }
  }

  private commitCountdownActivation(
    game: ManhuntRecord,
    reservation?: RoomGameStatusReservation,
  ): void {
    const { roomCode } = game;
    const sessionId = game.session.id;
    const now = this.runtime.now();
    const activeSince = now.toISOString();
    game.countdownTimer?.cancel();
    game.countdownTimer = undefined;
    const activeRoom = this.rooms.activateGame(
      roomCode,
      sessionId,
      reservation,
    );
    game.session.status = "in_progress";
    game.session.startedAt = activeSince;
    game.session.state.phase = "active";
    game.session.state.activeSince = activeSince;
    delete game.session.state.countdownEndsAt;
    delete game.session.state.runnerHeadStartEndsAt;

    const durationSeconds = game.session.state.settings.gameDurationSeconds ?? DEFAULT_MANHUNT_GAME_DURATION_SECONDS;
    const gameEndsAt = new Date(now.getTime() + durationSeconds * 1_000).toISOString();
    const firstShrinkSeconds = Math.floor(durationSeconds / 3);
    game.session.state.gameEndsAt = gameEndsAt;
    game.session.state.nextShrinkAt = new Date(now.getTime() + firstShrinkSeconds * 1_000).toISOString();
    game.session.state.shrinkStage = 0;
    try {
      game.gameTimer = this.scheduleActiveGameTimer(
        game,
        durationSeconds * 1_000,
        () => this.endGame(game, "runner"),
      );
      this.scheduleZoneWarning(roomCode, firstShrinkSeconds * 1_000);
      this.scheduleNextReveal(roomCode);
      this.scheduleLateGameExposureTimeTrigger(game);
      this.scheduleMissionAssignments(
        roomCode,
        sessionId,
        game,
        now.getTime(),
      );
      this.evaluateLateGameExposure(game);
    } catch (error) {
      this.clearSession(roomCode);
      this.rooms.fenceRoom(roomCode);
      throw error;
    }

    this.events.roomUpdated(activeRoom);
    this.events.stateUpdated(roomCode, {
      sessionId,
      roomCode,
      state: game.session.state,
      updatedAt: this.runtime.now().toISOString(),
    });
    for (const [playerId, team] of game.teams) {
      if (team === "hunter") {
        this.emitFootstepsState(game, playerId);
      } else {
        this.emitSmokeBombState(game, playerId);
        this.emitGhostState(game, playerId);
        this.emitFreezeDecoyUsageState(game, playerId);
      }
    }
  }

  private handleDurableActivationFailure(
    roomCode: RoomCode,
    gameId: GameSessionId,
    error: unknown,
  ): void {
    if (this.persistenceCommands) {
      fenceDurableGameRoom(
        this.rooms,
        this.persistenceCommands,
        roomCode,
      );
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "game_activation_failed",
        roomCode,
        gameId,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }

  private scheduleActiveGameTimer(
    game: ManhuntRecord,
    delayMs: number,
    callback: () => void,
    requireActiveState = true,
  ): GameTimer {
    const sessionId = game.session.id;
    return this.scheduleTrackedTimer(game, () => {
      if (
        this.currentGames.get(game.roomCode) !== game
        || game.session.id !== sessionId
        || (
          requireActiveState
          && (
            game.session.status !== "in_progress"
            || game.session.state.phase !== "active"
          )
        )
      ) {
        return;
      }
      try {
        callback();
      } catch (error) {
        this.handleActiveGameTimerFailure(game, sessionId, error);
      }
    }, delayMs);
  }

  private scheduleTrackedTimer(
    game: ManhuntRecord,
    callback: () => void,
    delayMs: number,
  ): GameTimer {
    if (this.rooms.isGameplaySuspended(game.roomCode, game.session.id)) {
      return { cancel: () => undefined };
    }
    let timer: GameTimer;
    timer = this.runtime.schedule(() => {
      this.scheduledGameTimers.get(game.session.id)?.delete(timer);
      if (
        this.currentGames.get(game.roomCode) !== game
        || this.rooms.isGameplaySuspended(game.roomCode, game.session.id)
      ) {
        return;
      }
      callback();
    }, delayMs);
    const timers = this.scheduledGameTimers.get(game.session.id) ?? new Set();
    timers.add(timer);
    this.scheduledGameTimers.set(game.session.id, timers);
    return timer;
  }

  private handleActiveGameTimerFailure(
    game: ManhuntRecord,
    sessionId: GameSessionId,
    error: unknown,
  ): void {
    if (
      this.currentGames.get(game.roomCode) !== game
      || game.session.id !== sessionId
    ) {
      return;
    }
    this.clearSession(game.roomCode);
    if (this.persistenceCommands) {
      fenceDurableGameRoom(
        this.rooms,
        this.persistenceCommands,
        game.roomCode,
      );
    } else {
      this.rooms.fenceRoom(game.roomCode);
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "manhunt_active_timer_failed",
        roomCode: game.roomCode,
        gameId: sessionId,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }

  private scheduleMissionAssignments(
    roomCode: RoomCode,
    sessionId: GameSessionId,
    game: ManhuntRecord,
    activatedAtMs: number,
  ): void {
    const hiderIds = [...game.teams]
      .filter(
        ([playerId, team]) =>
          team === "runner" &&
          !game.caughtPlayerIds.has(playerId) &&
          this.isActivePlayer(roomCode, playerId),
      )
      .map(([playerId]) => playerId);
    if (hiderIds.length === 0) {
      return;
    }

    const requestedAssignmentCount = this.missionRandomInt(2, 4);
    const selectedHiderCount = Math.min(
      requestedAssignmentCount,
      hiderIds.length,
    );
    for (let index = 0; index < selectedHiderCount; index += 1) {
      const swapIndex = this.missionRandomInt(index, hiderIds.length);
      [hiderIds[index], hiderIds[swapIndex]] = [
        hiderIds[swapIndex]!,
        hiderIds[index]!,
      ];
    }
    const selectedHiderIds = hiderIds.slice(0, selectedHiderCount);
    const requiredCompletions = selectedHiderIds.length;
    const offsets = Array.from(
      { length: MISSION_ASSIGNMENT_WINDOW_SECONDS },
      (_, second) => second,
    );
    for (let index = 0; index < selectedHiderIds.length; index += 1) {
      const swapIndex = this.missionRandomInt(index, offsets.length);
      [offsets[index], offsets[swapIndex]] = [
        offsets[swapIndex]!,
        offsets[index]!,
      ];
    }

    const assignments = new Map<PlayerId, ManhuntMissionAssignment>();
    selectedHiderIds.forEach((playerId, index) => {
      assignments.set(playerId, {
        playerId,
        activationAtMs: activatedAtMs + offsets[index]! * 1_000,
        status: "scheduled",
      });
    });
    game.missionRound = {
      requiredCompletions,
      assignments,
      completedPlayerIds: new Set(),
    };

    for (const assignment of assignments.values()) {
      this.scheduleMissionActivation(
        roomCode,
        sessionId,
        game,
        assignment,
        assignment.activationAtMs - activatedAtMs,
      );
    }
  }

  private scheduleMissionActivation(
    roomCode: RoomCode,
    sessionId: GameSessionId,
    game: ManhuntRecord,
    assignment: ManhuntMissionAssignment,
    delayMs: number,
  ): void {
    assignment.activationTimer = this.scheduleActiveGameTimer(game, Math.max(0, delayMs), () => {
      assignment.activationTimer = undefined;
      const round = game.missionRound;
      if (
        this.currentGames.get(roomCode) !== game ||
        game.session.id !== sessionId ||
        game.session.status !== "in_progress" ||
        game.session.state.phase !== "active" ||
        !round ||
        round.outcome ||
        assignment.status !== "scheduled"
      ) {
        return;
      }

      if (
        game.caughtPlayerIds.has(assignment.playerId) ||
        game.teams.get(assignment.playerId) !== "runner"
      ) {
        this.markMissionPlayerUnavailable(game, assignment.playerId);
        return;
      }
      if (!this.isActivePlayer(roomCode, assignment.playerId)) {
        this.retryMissionActivation(roomCode, sessionId, game, assignment);
        return;
      }

      const location = this.getFreshMissionLocation(game, assignment.playerId);
      const center = location
        ? this.generateMissionCircleCenter(game, location.coordinates)
        : undefined;
      if (!center) {
        this.retryMissionActivation(roomCode, sessionId, game, assignment);
        return;
      }

      const nowMs = this.runtime.now().getTime();
      if (
        round.lastRevealedAtMs !== undefined &&
        nowMs <= round.lastRevealedAtMs
      ) {
        this.retryMissionActivation(
          roomCode,
          sessionId,
          game,
          assignment,
          round.lastRevealedAtMs + 1 - nowMs,
        );
        return;
      }

      const deadlineAtMs =
        nowMs + MANHUNT_MISSION_DEADLINE_SECONDS * 1_000;
      let deadlineTimer: GameTimer | undefined;
      deadlineTimer = this.scheduleActiveGameTimer(
        game,
        MANHUNT_MISSION_DEADLINE_SECONDS * 1_000,
        () => {
          if (!deadlineTimer || assignment.deadlineTimer !== deadlineTimer) {
            return;
          }
          assignment.deadlineTimer = undefined;
          this.failMissionAssignment(
            roomCode,
            sessionId,
            game,
            assignment,
          );
        },
      );
      if (
        this.currentGames.get(roomCode) !== game
        || game.session.id !== sessionId
        || game.session.state.phase !== "active"
        || game.missionRound !== round
        || round.assignments.get(assignment.playerId) !== assignment
        || assignment.status !== "scheduled"
      ) {
        deadlineTimer.cancel();
        return;
      }
      assignment.center = center;
      assignment.revealedAtMs = nowMs;
      assignment.deadlineAtMs = deadlineAtMs;
      assignment.deadlineTimer = deadlineTimer;
      assignment.status = "active";
      round.lastRevealedAtMs = nowMs;
      this.events.missionAssignment(
        roomCode,
        assignment.playerId,
        this.createMissionAssignmentPayload(game, assignment),
      );
    });
  }

  private retryMissionActivation(
    roomCode: RoomCode,
    sessionId: GameSessionId,
    game: ManhuntRecord,
    assignment: ManhuntMissionAssignment,
    delayMs = MISSION_ACTIVATION_RETRY_DELAY_MS,
  ): void {
    this.scheduleMissionActivation(
      roomCode,
      sessionId,
      game,
      assignment,
      delayMs,
    );
  }

  private generateMissionCircleCenter(
    game: ManhuntRecord,
    playerCoordinates: Coordinates,
  ): Coordinates | undefined {
    const boundary = game.boundary;
    const assignedCenters = [...(game.missionRound?.assignments.values() ?? [])]
      .flatMap((assignment) =>
        assignment.center ? [assignment.center] : [],
      );
    for (let attempt = 0; attempt < 256; attempt += 1) {
      const distanceMeters =
        this.missionRandomInt(
          MANHUNT_MISSION_MIN_DISTANCE_METERS * 1_000,
          MANHUNT_MISSION_MAX_DISTANCE_METERS * 1_000 + 1,
        ) / 1_000;
      const bearingRadians =
        (this.missionRandomInt(0, 360_000) / 1_000) * (Math.PI / 180);
      const candidate = destinationCoordinates(
        playerCoordinates,
        distanceMeters,
        bearingRadians,
      );
      if (
        haversineMeters(candidate, boundary.center) +
          MANHUNT_MISSION_CIRCLE_RADIUS_METERS >
        boundary.radiusMeters
      ) {
        continue;
      }
      if (
        assignedCenters.some(
          (existing) =>
            haversineMeters(candidate, existing) <
            MANHUNT_MISSION_MIN_CIRCLE_SEPARATION_METERS,
        )
      ) {
        continue;
      }
      return candidate;
    }
    return undefined;
  }

  private getFreshMissionLocation(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): PrivateLocation | undefined {
    const location = this.getFreshLocation(game, playerId);
    return location?.accuracyMeters !== undefined &&
      location.accuracyMeters <= MANHUNT_MISSION_MAX_ACCURACY_METERS
      ? location
      : undefined;
  }

  private updateMissionDwell(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    const round = game.missionRound;
    const assignment = round?.assignments.get(playerId);
    if (
      !round ||
      round.outcome ||
      !assignment ||
      assignment.status !== "active"
    ) {
      return;
    }

    const nowMs = this.runtime.now().getTime();
    if (
      assignment.deadlineAtMs === undefined ||
      nowMs >= assignment.deadlineAtMs
    ) {
      this.failMissionAssignment(
        game.roomCode,
        game.session.id,
        game,
        assignment,
      );
      return;
    }

    const location = this.getFreshMissionLocation(game, playerId);
    if (
      !this.isActivePlayer(game.roomCode, playerId) ||
      game.caughtPlayerIds.has(playerId) ||
      !location ||
      !assignment.center ||
      haversineMeters(location.coordinates, assignment.center) +
        (location.accuracyMeters ?? Number.POSITIVE_INFINITY) >
        MANHUNT_MISSION_CIRCLE_RADIUS_METERS
    ) {
      this.resetMissionDwell(game, playerId);
      return;
    }

    const maxGapMs = MANHUNT_MISSION_MAX_SAMPLE_GAP_SECONDS * 1_000;
    if (
      assignment.dwellStartedAtMs === undefined ||
      assignment.lastQualifyingSampleAtMs === undefined ||
      nowMs - assignment.lastQualifyingSampleAtMs > maxGapMs
    ) {
      this.resetMissionDwell(game, playerId);
      assignment.dwellStartedAtMs = nowMs;
    }
    assignment.lastQualifyingSampleAtMs = nowMs;

    if (
      nowMs - assignment.dwellStartedAtMs >=
      MANHUNT_MISSION_DWELL_SECONDS * 1_000
    ) {
      this.completeMissionAssignment(game, assignment);
      return;
    }
    this.scheduleMissionDwellCompletion(game, assignment);
  }

  private scheduleMissionDwellCompletion(
    game: ManhuntRecord,
    assignment: ManhuntMissionAssignment,
  ): void {
    if (
      assignment.dwellTimer ||
      assignment.dwellStartedAtMs === undefined
    ) {
      return;
    }
    const remainingMs =
      assignment.dwellStartedAtMs +
      MANHUNT_MISSION_DWELL_SECONDS * 1_000 -
      this.runtime.now().getTime();
    assignment.dwellTimer = this.scheduleActiveGameTimer(game, Math.max(0, remainingMs), () => {
      assignment.dwellTimer = undefined;
      const round = game.missionRound;
      if (
        this.currentGames.get(game.roomCode) !== game ||
        game.session.status !== "in_progress" ||
        !round ||
        round.outcome ||
        assignment.status !== "active"
      ) {
        return;
      }

      const nowMs = this.runtime.now().getTime();
      const latestLocation = this.getFreshMissionLocation(
        game,
        assignment.playerId,
      );
      const sampleAgeMs =
        assignment.lastQualifyingSampleAtMs === undefined
          ? Number.POSITIVE_INFINITY
          : nowMs - assignment.lastQualifyingSampleAtMs;
      if (
        assignment.deadlineAtMs === undefined ||
        nowMs >= assignment.deadlineAtMs
      ) {
        this.failMissionAssignment(
          game.roomCode,
          game.session.id,
          game,
          assignment,
        );
        return;
      }
      if (
        !latestLocation ||
        !this.isActivePlayer(game.roomCode, assignment.playerId) ||
        sampleAgeMs < 0 ||
        sampleAgeMs > MANHUNT_MISSION_MAX_SAMPLE_GAP_SECONDS * 1_000 ||
        !assignment.center ||
        haversineMeters(latestLocation.coordinates, assignment.center) +
          (latestLocation.accuracyMeters ?? Number.POSITIVE_INFINITY) >
          MANHUNT_MISSION_CIRCLE_RADIUS_METERS
      ) {
        this.resetMissionDwell(game, assignment.playerId);
        return;
      }

      if (
        assignment.dwellStartedAtMs !== undefined &&
        nowMs - assignment.dwellStartedAtMs >=
          MANHUNT_MISSION_DWELL_SECONDS * 1_000
      ) {
        this.completeMissionAssignment(game, assignment);
        return;
      }
      this.scheduleMissionDwellCompletion(game, assignment);
    });
  }

  private completeMissionAssignment(
    game: ManhuntRecord,
    assignment: ManhuntMissionAssignment,
  ): void {
    const round = game.missionRound;
    if (
      !round ||
      round.outcome ||
      assignment.status !== "active" ||
      game.caughtPlayerIds.has(assignment.playerId)
    ) {
      return;
    }
    this.clearMissionAssignmentTimers(assignment);
    assignment.status = "completed";
    round.completedPlayerIds.add(assignment.playerId);
    this.emitMissionAssignment(game, assignment);
    this.evaluateMissionRound(game);
  }

  private failMissionAssignment(
    roomCode: RoomCode,
    sessionId: GameSessionId,
    game: ManhuntRecord,
    assignment: ManhuntMissionAssignment,
  ): void {
    if (
      this.currentGames.get(roomCode) !== game ||
      game.session.id !== sessionId ||
      game.session.status !== "in_progress" ||
      assignment.status !== "active"
    ) {
      return;
    }
    this.clearMissionAssignmentTimers(assignment);
    assignment.status = "failed";
    this.emitMissionAssignment(game, assignment);
    this.evaluateMissionRound(game);
  }

  private markMissionPlayerUnavailable(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    const assignment = game.missionRound?.assignments.get(playerId);
    if (
      !assignment ||
      (assignment.status !== "scheduled" &&
        assignment.status !== "active")
    ) {
      return;
    }
    this.clearMissionAssignmentTimers(assignment);
    assignment.status = "failed";
    this.emitMissionAssignment(game, assignment);
    this.evaluateMissionRound(game);
  }

  private evaluateMissionRound(game: ManhuntRecord): void {
    const round = game.missionRound;
    if (!round || round.outcome) {
      return;
    }
    const completedCount = round.completedPlayerIds.size;
    const allAssignmentsResolved = [...round.assignments.values()].every(
      (assignment) => assignment.status !== "scheduled",
    );
    if (
      completedCount === round.requiredCompletions &&
      allAssignmentsResolved
    ) {
      this.resolveMissionRound(game, "success");
      return;
    }

    const maximumPossible =
      completedCount +
      [...round.assignments.values()].filter(
        (assignment) =>
          (assignment.status === "scheduled" ||
            assignment.status === "active") &&
          !game.caughtPlayerIds.has(assignment.playerId),
      ).length;
    if (maximumPossible < round.requiredCompletions) {
      this.resolveMissionRound(game, "failure");
    }
  }

  private resolveMissionRound(
    game: ManhuntRecord,
    outcome: "success" | "failure",
  ): void {
    const round = game.missionRound;
    if (!round || round.outcome) {
      return;
    }
    round.outcome = outcome;
    for (const assignment of round.assignments.values()) {
      this.clearMissionAssignmentTimers(assignment);
      if (assignment.status === "active") {
        assignment.status = "cancelled";
        this.emitMissionAssignment(game, assignment);
      }
    }

    const recipientTeam = outcome === "success" ? "runner" : "hunter";
    const recipientPlayerIds = [...game.teams]
      .filter(([, team]) => team === recipientTeam)
      .map(([playerId]) => playerId);
    const nowMs = this.runtime.now().getTime();
    round.revealVisibleUntilMs =
      nowMs + MANHUNT_MISSION_REVEAL_DURATION_SECONDS * 1_000;
    const payload = this.createMissionRevealPayload(game);
    round.revealTimer = this.scheduleActiveGameTimer(
      game,
      MANHUNT_MISSION_REVEAL_DURATION_SECONDS * 1_000,
      () => {
        round.revealTimer = undefined;
        round.revealVisibleUntilMs = undefined;
      },
    );
    if (payload) {
      this.events.missionReveal(game.roomCode, recipientPlayerIds, payload);
    }
  }

  private createMissionAssignmentPayload(
    game: ManhuntRecord,
    assignment: ManhuntMissionAssignment,
  ): ManhuntMissionAssignmentPayload {
    if (
      !assignment.center ||
      assignment.revealedAtMs === undefined ||
      assignment.deadlineAtMs === undefined ||
      assignment.status === "scheduled"
    ) {
      throw new Error("Cannot emit an unrevealed Manhunt mission assignment.");
    }
    return {
      sessionId: game.session.id,
      playerId: assignment.playerId,
      center: { ...assignment.center },
      radiusMeters: MANHUNT_MISSION_CIRCLE_RADIUS_METERS,
      revealedAt: new Date(assignment.revealedAtMs).toISOString(),
      deadlineAt: new Date(assignment.deadlineAtMs).toISOString(),
      status: assignment.status,
    };
  }

  private getMissionAssignmentPayload(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): ManhuntMissionAssignmentPayload | undefined {
    const assignment = game.missionRound?.assignments.get(playerId);
    if (
      game.session.status !== "in_progress" ||
      !assignment ||
      assignment.status === "scheduled" ||
      !assignment.center
    ) {
      return undefined;
    }
    return this.createMissionAssignmentPayload(game, assignment);
  }

  private emitMissionAssignment(
    game: ManhuntRecord,
    assignment: ManhuntMissionAssignment,
  ): void {
    const payload = this.getMissionAssignmentPayload(
      game,
      assignment.playerId,
    );
    if (payload) {
      this.events.missionAssignment(
        game.roomCode,
        assignment.playerId,
        payload,
      );
    }
  }

  private getMissionRevealPayload(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): ManhuntMissionRevealPayload | undefined {
    const round = game.missionRound;
    if (
      game.session.status !== "in_progress" ||
      !round?.outcome ||
      round.revealVisibleUntilMs === undefined ||
      round.revealVisibleUntilMs <= this.runtime.now().getTime()
    ) {
      return undefined;
    }
    const recipientTeam = round.outcome === "success" ? "runner" : "hunter";
    if (game.teams.get(playerId) !== recipientTeam) {
      return undefined;
    }
    return this.createMissionRevealPayload(game);
  }

  private createMissionRevealPayload(
    game: ManhuntRecord,
  ): ManhuntMissionRevealPayload | undefined {
    const round = game.missionRound;
    if (!round?.outcome || round.revealVisibleUntilMs === undefined) {
      return undefined;
    }
    const revealedTeam = round.outcome === "success" ? "hunter" : "runner";
    const room = this.rooms.getPublicRoom(game.roomCode);
    const locations = [...game.teams]
      .filter(
        ([playerId, team]) =>
          team === revealedTeam &&
          !game.caughtPlayerIds.has(playerId) &&
          this.isActivePlayer(game.roomCode, playerId) &&
          this.getFreshLocation(game, playerId) !== undefined,
      )
      .map(([playerId]) => {
        const location = this.getFreshLocation(game, playerId);
        if (!location) {
          return undefined;
        }
        return {
          playerId,
          coordinates: { ...location.coordinates },
          status:
            room?.players.find((player) => player.id === playerId)?.status ??
            "active",
        };
      })
      .filter((location) => location !== undefined);
    return {
      sessionId: game.session.id,
      outcome: round.outcome,
      locations,
      visibleUntil: new Date(round.revealVisibleUntilMs).toISOString(),
    };
  }

  private clearMissionAssignmentTimers(
    assignment: ManhuntMissionAssignment,
  ): void {
    assignment.activationTimer?.cancel();
    assignment.activationTimer = undefined;
    assignment.deadlineTimer?.cancel();
    assignment.deadlineTimer = undefined;
    assignment.dwellTimer?.cancel();
    assignment.dwellTimer = undefined;
    assignment.dwellStartedAtMs = undefined;
    assignment.lastQualifyingSampleAtMs = undefined;
  }

  private clearMissionTimers(game: ManhuntRecord): void {
    const round = game.missionRound;
    if (!round) {
      return;
    }
    for (const assignment of round.assignments.values()) {
      this.clearMissionAssignmentTimers(assignment);
    }
    round.revealTimer?.cancel();
    round.revealTimer = undefined;
    round.revealVisibleUntilMs = undefined;
  }

  private resetMissionDwell(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    const assignment = game.missionRound?.assignments.get(playerId);
    if (!assignment || assignment.status !== "active") {
      return;
    }
    assignment.dwellTimer?.cancel();
    assignment.dwellTimer = undefined;
    assignment.dwellStartedAtMs = undefined;
    assignment.lastQualifyingSampleAtMs = undefined;
  }

  private scheduleZoneWarning(roomCode: RoomCode, delayMs: number): void {
    const game = this.currentGames.get(roomCode);
    if (!game || game.session.status !== "in_progress") return;
    game.zoneWarningTimer?.cancel();
    game.zoneWarningTimer = this.scheduleActiveGameTimer(game, Math.max(0, delayMs - MANHUNT_ZONE_WARNING_SECONDS * 1_000), () => {
      const current = this.currentGames.get(roomCode);
      if (!current || current !== game || current.session.status !== "in_progress") return;
      const nextShrinkAt = current.session.state.nextShrinkAt;
      if (!nextShrinkAt) return;
      const warningAt = this.runtime.now();
      current.session.state.shrinkWarningEndsAt = nextShrinkAt;
      this.events.stateUpdated(roomCode, {
        sessionId: current.session.id,
        roomCode,
        state: current.session.state,
        updatedAt: warningAt.toISOString(),
      });
      current.zoneWarningTimer = this.scheduleActiveGameTimer(
        current,
        MANHUNT_ZONE_WARNING_SECONDS * 1_000,
        () => this.beginZoneShrink(roomCode, current.session.id),
      );
    });
  }

  private beginZoneShrink(roomCode: RoomCode, sessionId: GameSessionId): void {
    const game = this.currentGames.get(roomCode);
    if (!game || game.session.id !== sessionId || game.session.status !== "in_progress") return;
    const state = game.session.state;
    const stage = state.shrinkStage ?? 0;
    const fromRadius = game.boundary.radiusMeters;
    const reduction = stage === 0 ? 0.15 : 0.25;
    const toRadius = Math.max(MANHUNT_ZONE_MIN_RADIUS_METERS, Math.round(fromRadius * (1 - reduction)));
    const startedAt = this.runtime.now().getTime();
    const endsAt = startedAt + MANHUNT_ZONE_SHRINK_DURATION_SECONDS * 1_000;
    state.zoneShrinkFromRadiusMeters = fromRadius;
    state.zoneShrinkToRadiusMeters = toRadius;
    state.zoneShrinkEndsAt = new Date(endsAt).toISOString();
    state.shrinkStage = stage + 1;
    delete state.shrinkWarningEndsAt;
    const durationSeconds = state.settings.gameDurationSeconds ?? DEFAULT_MANHUNT_GAME_DURATION_SECONDS;
    const nextStageSeconds = Math.floor((durationSeconds * (stage + 2)) / 3);
    if (stage === 0) {
      state.nextShrinkAt = new Date(Date.parse(state.activeSince!) + nextStageSeconds * 1_000).toISOString();
    } else {
      delete state.nextShrinkAt;
    }
    const updateRadius = () => {
      const current = this.currentGames.get(roomCode);
      if (!current || current !== game || current.session.id !== sessionId || current.session.status !== "in_progress") return;
      const elapsed = Math.min(1, (this.runtime.now().getTime() - startedAt) / (MANHUNT_ZONE_SHRINK_DURATION_SECONDS * 1_000));
      const radius = Math.round(fromRadius + (toRadius - fromRadius) * elapsed);
      current.boundary.radiusMeters = Math.max(MANHUNT_ZONE_MIN_RADIUS_METERS, radius);
      this.events.boundaryUpdated(roomCode, {
        roomCode,
        boundary: {
          center: { ...current.boundary.center },
          radiusMeters: current.boundary.radiusMeters,
        },
      });
      this.pruneFreezeDecoys(current);
      this.pruneLateGameExposureClueForBoundary(current);
      this.events.stateUpdated(roomCode, {
        sessionId,
        roomCode,
        state: current.session.state,
        updatedAt: this.runtime.now().toISOString(),
      });
      if (elapsed < 1) {
        current.zoneShrinkTimer = this.scheduleActiveGameTimer(
          current,
          1_000,
          updateRadius,
        );
      } else {
        delete current.session.state.zoneShrinkFromRadiusMeters;
        delete current.session.state.zoneShrinkToRadiusMeters;
        delete current.session.state.zoneShrinkEndsAt;
        this.events.stateUpdated(roomCode, {
          sessionId,
          roomCode,
          state: current.session.state,
          updatedAt: this.runtime.now().toISOString(),
        });
        if (current.session.state.nextShrinkAt) {
          const nextDelay = Date.parse(current.session.state.nextShrinkAt) - this.runtime.now().getTime();
          this.scheduleZoneWarning(roomCode, Math.max(0, nextDelay));
        }
      }
    };
    this.events.stateUpdated(roomCode, {
      sessionId,
      roomCode,
      state,
      updatedAt: this.runtime.now().toISOString(),
    });
    updateRadius();
  }

  private createCountdownPayload(game: ManhuntRecord): CountdownPayload {
    const endsAt = game.session.state.countdownEndsAt;
    const runnerHeadStartEndsAt =
      game.session.state.runnerHeadStartEndsAt;
    if (!endsAt || !runnerHeadStartEndsAt) {
      throw new Error("Manhunt countdown is missing its server deadline.");
    }
    const serverNow = this.runtime.now().toISOString();
    return {
      roomCode: game.roomCode,
      sessionId: game.session.id,
      remainingSeconds: Math.max(
        0,
        Math.ceil((Date.parse(endsAt) - Date.parse(serverNow)) / 1_000),
      ),
      endsAt,
      runnerHeadStartEndsAt,
      serverNow,
    };
  }

  private async cancelCountdown(
    roomCode: RoomCode,
    game: ManhuntRecord,
    reason: ManhuntCountdownCancelledPayload["reason"],
  ): Promise<void> {
    if (
      this.currentGames.get(roomCode) !== game ||
      game.session.state.phase !== "countdown"
    ) {
      return;
    }
    if (this.persistenceCommands) {
      await this.cancelDurableCountdown(roomCode, game, reason);
      return;
    }
    const sessionId = game.session.id;
    const room = this.rooms.cancelStartingGame(roomCode, sessionId);
    const readyPlayerIds = [...game.readyPlayerIds];
    this.clearSession(roomCode);
    if (!room) {
      return;
    }
    this.pendingReadyPlayerIds.set(roomCode, new Set(readyPlayerIds));
    this.events.roomUpdated(room);
    this.events.countdownCancelled(roomCode, {
      roomCode,
      sessionId,
      reason,
    });
    this.events.boundaryUpdated(roomCode, {
      roomCode,
      boundary: this.rooms.getManhuntBoundary(roomCode) ?? null,
    });
  }

  private async cancelDurableCountdown(
    roomCode: RoomCode,
    game: ManhuntRecord,
    reason: ManhuntCountdownCancelledPayload["reason"],
  ): Promise<void> {
    const sessionId = game.session.id;
    game.countdownTimer?.cancel();
    game.countdownTimer = undefined;

    let reservation: RoomGameStatusReservation | undefined;
    try {
      reservation = await this.persistenceCommands!.acquireGameStatusReservation(
        roomCode,
        "starting",
        sessionId,
      );
      const room = this.rooms.getPublicRoom(roomCode);
      if (
        this.currentGames.get(roomCode) !== game
        || game.session.state.phase !== "countdown"
      ) {
        return;
      }
      if (
        !room
        || room.gameStatus !== "starting"
        || room.currentGameId !== sessionId
      ) {
        fenceDurableGameRoom(this.rooms, this.persistenceCommands!, roomCode);
        return;
      }

      await this.persistenceCommands!.transitionRoomGameStatus({
        roomCode,
        expectedStatus: "starting",
        nextStatus: "waiting",
        expectedCurrentGameId: sessionId,
        nextGameId: null,
        initiatedBy: { kind: "game-service" },
        reservation,
      });

      const updatedRoom = this.rooms.cancelStartingGame(
        roomCode,
        sessionId,
        reservation,
      );
      if (!updatedRoom) {
        fenceDurableGameRoom(this.rooms, this.persistenceCommands!, roomCode);
        throw new AppError(
          "UNKNOWN",
          "The durable countdown cancellation committed but live state could not be synchronized safely.",
        );
      }

      const readyPlayerIds = [...game.readyPlayerIds];
      this.clearSession(roomCode);
      this.pendingReadyPlayerIds.set(roomCode, new Set(readyPlayerIds));
      this.events.roomUpdated(updatedRoom);
      this.events.countdownCancelled(roomCode, {
        roomCode,
        sessionId,
        reason,
      });
      this.events.boundaryUpdated(roomCode, {
        roomCode,
        boundary: this.rooms.getManhuntBoundary(roomCode) ?? null,
      });
    } catch (error) {
      fenceDurableGameRoom(this.rooms, this.persistenceCommands!, roomCode);
      this.logDurableCountdownCancellationFailure(roomCode, sessionId, error);
      throw error;
    } finally {
      if (reservation) {
        this.rooms.releaseGameStatusReservation(reservation);
      }
    }
  }

  private logDurableCountdownCancellationFailure(
    roomCode: RoomCode,
    gameId: GameSessionId,
    error: unknown,
  ): void {
    console.error(
      JSON.stringify({
        level: "error",
        event: "durable_game_countdown_cancellation_failed",
        roomCode,
        gameId,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }

  private scheduleNextReveal(roomCode: RoomCode): void {
    const game = this.currentGames.get(roomCode);
    if (!game || game.session.status !== "in_progress") {
      return;
    }
    game.revealActive = false;
    game.cycleTimer?.cancel();
    game.cycleTimer = this.scheduleActiveGameTimer(
      game,
      MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS * 1_000,
      () => this.openRevealWindow(roomCode),
    );
  }

  private getConfiguredLateGameExposureDurations():
    | LateGameExposureDurations
    | undefined {
    const durations = this.lateGameExposureDurations;
    if (
      !durations ||
      !Number.isSafeInteger(durations.clueDurationSeconds) ||
      durations.clueDurationSeconds <= 0 ||
      durations.clueDurationSeconds * 1_000 >
        MAX_LATE_GAME_EXPOSURE_TIMER_MS ||
      !Number.isSafeInteger(durations.warningDurationSeconds) ||
      durations.warningDurationSeconds <= 0 ||
      durations.warningDurationSeconds * 1_000 >
        MAX_LATE_GAME_EXPOSURE_TIMER_MS
    ) {
      return undefined;
    }
    return durations;
  }

  private scheduleLateGameExposureTimeTrigger(game: ManhuntRecord): void {
    const gameDurationSeconds =
      game.session.state.settings.gameDurationSeconds ??
      DEFAULT_MANHUNT_GAME_DURATION_SECONDS;
    if (
      !this.getConfiguredLateGameExposureDurations() ||
      (gameDurationSeconds !== 2_700 && gameDurationSeconds !== 3_600)
    ) {
      return;
    }
    const activeSinceMs = Date.parse(game.session.state.activeSince ?? "");
    if (!Number.isFinite(activeSinceMs)) {
      return;
    }
    const delayMs = Math.max(
      0,
      activeSinceMs +
        MANHUNT_LATE_GAME_EXPOSURE_TRIGGER_SECONDS * 1_000 -
        this.runtime.now().getTime(),
    );
    const sessionId = game.session.id;
    game.lateGameExposureTimer = this.scheduleActiveGameTimer(game, delayMs, () => {
      const current = this.currentGames.get(game.roomCode);
      if (
        current !== game ||
        current.session.id !== sessionId ||
        current.session.status !== "in_progress" ||
        current.session.state.phase !== "active"
      ) {
        return;
      }
      current.lateGameExposureTimer = undefined;
      this.evaluateLateGameExposure(current);
    });
  }

  private evaluateLateGameExposure(game: ManhuntRecord): void {
    if (
      !this.getConfiguredLateGameExposureDurations() ||
      this.currentGames.get(game.roomCode) !== game ||
      game.session.status !== "in_progress" ||
      game.session.state.phase !== "active" ||
      game.lateGameExposure.triggered
    ) {
      return;
    }

    const nowMs = this.runtime.now().getTime();
    const gameDurationSeconds =
      game.session.state.settings.gameDurationSeconds ??
      DEFAULT_MANHUNT_GAME_DURATION_SECONDS;
    const timeTriggerEnabled =
      gameDurationSeconds === 2_700 || gameDurationSeconds === 3_600;
    const activeSinceMs = Date.parse(game.session.state.activeSince ?? "");
    const timeTriggerReached =
      timeTriggerEnabled &&
      Number.isFinite(activeSinceMs) &&
      nowMs - activeSinceMs >=
        MANHUNT_LATE_GAME_EXPOSURE_TRIGGER_SECONDS * 1_000;
    const hunters = [...game.teams].filter(
      ([playerId, team]) =>
        team === "hunter" &&
        !game.caughtPlayerIds.has(playerId) &&
        this.isActivePlayer(game.roomCode, playerId),
    );
    const hiders = [...game.teams].filter(
      ([playerId, team]) =>
        team === "runner" &&
        !game.caughtPlayerIds.has(playerId) &&
        this.isActivePlayer(game.roomCode, playerId),
    );
    if (!timeTriggerReached && !(hunters.length === 2 && hiders.length === 2)) {
      return;
    }

    this.triggerLateGameExposure(game, nowMs);
  }

  private triggerLateGameExposure(
    game: ManhuntRecord,
    exposedAtMs: number,
  ): void {
    const durations = this.getConfiguredLateGameExposureDurations();
    if (!durations || game.lateGameExposure.triggered) {
      return;
    }
    game.lateGameExposure.triggered = true;
    game.lateGameExposureTimer?.cancel();
    game.lateGameExposureTimer = undefined;
    this.pruneLateGameLocationHistory(game, exposedAtMs);

    const boundary = game.boundary;
    const eligibleHiders = [...game.teams]
      .filter(
        ([playerId, team]) =>
          team === "runner" &&
          !game.caughtPlayerIds.has(playerId) &&
          this.isActivePlayer(game.roomCode, playerId) &&
          !this.isHiderLocationProtected(game, playerId, exposedAtMs),
      )
      .map(([playerId]) => {
        const qualifyingLocations = (
          game.lateGameLocationHistory.get(playerId) ?? []
        ).filter((location) => {
          const ageMs = exposedAtMs - location.recordedAtMs;
          return (
            ageMs >=
              MANHUNT_LATE_GAME_EXPOSURE_MIN_LOCATION_AGE_SECONDS * 1_000 &&
            ageMs <=
              MANHUNT_LATE_GAME_EXPOSURE_MAX_LOCATION_AGE_SECONDS * 1_000 &&
            Number.isFinite(location.coordinates.latitude) &&
            location.coordinates.latitude >= -90 &&
            location.coordinates.latitude <= 90 &&
            Number.isFinite(location.coordinates.longitude) &&
            location.coordinates.longitude >= -180 &&
            location.coordinates.longitude <= 180 &&
            haversineMeters(
              boundary.center,
              location.coordinates,
            ) <= boundary.radiusMeters
          );
        });
        const location = qualifyingLocations.reduce<
          LateGameHistoricalLocation | undefined
        >(
          (newest, candidate) =>
            !newest || candidate.recordedAtMs > newest.recordedAtMs
              ? candidate
              : newest,
          undefined,
        );
        return location ? { playerId, location } : undefined;
      })
      .filter(
        (
          candidate,
        ): candidate is {
          playerId: PlayerId;
          location: LateGameHistoricalLocation;
        } => candidate !== undefined,
      );

    this.clearLateGameLocationHistories(game);
    if (eligibleHiders.length === 0) {
      return;
    }

    const selectedIndex = this.lateGameExposureRandomInt(
      0,
      eligibleHiders.length,
    );
    if (
      !Number.isSafeInteger(selectedIndex) ||
      selectedIndex < 0 ||
      selectedIndex >= eligibleHiders.length
    ) {
      throw new Error("Late-game exposure target selection was invalid.");
    }
    const selected = eligibleHiders[selectedIndex]!;
    const clueId = randomUUID();
    const warningDurationMs = durations.warningDurationSeconds * 1_000;
    const clueDurationMs = durations.clueDurationSeconds * 1_000;
    const clue: LateGameExposureClue = {
      clueId,
      sourceHiderId: selected.playerId,
      coordinates: { ...selected.location.coordinates },
      recordedAtMs: selected.location.recordedAtMs,
      exposedAtMs,
      expiresAtMs: exposedAtMs + clueDurationMs,
    };
    const warning: LateGameExposureWarning = {
      exposureId: clueId,
      playerId: selected.playerId,
      startedAtMs: exposedAtMs,
      expiresAtMs: exposedAtMs + warningDurationMs,
    };
    game.lateGameExposure.clue = clue;
    game.lateGameExposure.warning = warning;
    clue.timer = this.scheduleActiveGameTimer(
      game,
      clueDurationMs,
      () => this.expireLateGameClue(game, clueId),
    );
    warning.timer = this.scheduleActiveGameTimer(
      game,
      warningDurationMs,
      () => this.expireLateGameWarning(game, clueId),
    );
    this.emitLateGameClueState(game, clue);
    this.emitLateGameWarningState(game, warning);
  }

  private recordLateGameHistoricalLocation(
    game: ManhuntRecord,
    playerId: PlayerId,
    coordinates: Coordinates,
    recordedAtMs: number,
  ): void {
    if (
      !this.getConfiguredLateGameExposureDurations() ||
      game.lateGameExposure.triggered ||
      this.isHiderLocationProtected(game, playerId, recordedAtMs)
    ) {
      return;
    }
    this.pruneLateGameLocationHistoryForPlayer(game, playerId, recordedAtMs);
    const history = game.lateGameLocationHistory.get(playerId) ?? [];
    history.push({ coordinates: { ...coordinates }, recordedAtMs });
    if (history.length > LATE_GAME_LOCATION_HISTORY_MAX_SAMPLES_PER_HIDER) {
      history.splice(
        0,
        history.length - LATE_GAME_LOCATION_HISTORY_MAX_SAMPLES_PER_HIDER,
      );
    }
    game.lateGameLocationHistory.set(playerId, history);
    this.scheduleLateGameLocationHistoryPrune(game);
  }

  private pruneLateGameLocationHistoryForPlayer(
    game: ManhuntRecord,
    playerId: PlayerId,
    nowMs: number,
  ): void {
    const history = game.lateGameLocationHistory.get(playerId);
    if (!history) {
      return;
    }
    const retained = history.filter(
      ({ recordedAtMs }) =>
        recordedAtMs <= nowMs &&
        nowMs - recordedAtMs <=
          MANHUNT_LATE_GAME_EXPOSURE_MAX_LOCATION_AGE_SECONDS * 1_000,
    );
    if (retained.length === 0) {
      game.lateGameLocationHistory.delete(playerId);
    } else {
      game.lateGameLocationHistory.set(playerId, retained);
    }
  }

  private pruneLateGameLocationHistory(
    game: ManhuntRecord,
    nowMs: number,
  ): void {
    for (const playerId of game.lateGameLocationHistory.keys()) {
      this.pruneLateGameLocationHistoryForPlayer(game, playerId, nowMs);
    }
    this.scheduleLateGameLocationHistoryPrune(game);
  }

  private scheduleLateGameLocationHistoryPrune(game: ManhuntRecord): void {
    game.lateGameLocationHistoryTimer?.cancel();
    game.lateGameLocationHistoryTimer = undefined;
    if (game.lateGameExposure.triggered) {
      return;
    }
    const oldestRecordedAtMs = Math.min(
      ...[...game.lateGameLocationHistory.values()].flatMap((history) =>
        history.map(({ recordedAtMs }) => recordedAtMs),
      ),
    );
    if (!Number.isFinite(oldestRecordedAtMs)) {
      return;
    }
    const nowMs = this.runtime.now().getTime();
    const delayMs =
      oldestRecordedAtMs +
      MANHUNT_LATE_GAME_EXPOSURE_MAX_LOCATION_AGE_SECONDS * 1_000 -
      nowMs +
      1;
    game.lateGameLocationHistoryTimer = this.scheduleActiveGameTimer(game, Math.max(0, delayMs), () => {
      if (this.currentGames.get(game.roomCode) !== game) {
        return;
      }
      game.lateGameLocationHistoryTimer = undefined;
      this.pruneLateGameLocationHistory(game, this.runtime.now().getTime());
    }, false);
  }

  private clearLateGameLocationHistory(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    game.lateGameLocationHistory.delete(playerId);
    this.scheduleLateGameLocationHistoryPrune(game);
  }

  private clearLateGameLocationHistories(game: ManhuntRecord): void {
    game.lateGameLocationHistoryTimer?.cancel();
    game.lateGameLocationHistoryTimer = undefined;
    game.lateGameLocationHistory.clear();
  }

  private isHiderLocationProtected(
    game: ManhuntRecord,
    playerId: PlayerId,
    nowMs: number,
  ): boolean {
    return (
      this.isSmokeBombActive(game, playerId, nowMs) ||
      this.isGhostActive(game, playerId, nowMs)
    );
  }

  private createLateGameClueStatePayload(
    game: ManhuntRecord,
  ): ManhuntLateGameClueStatePayload | undefined {
    const clue = game.lateGameExposure.clue;
    if (!clue || clue.expiresAtMs <= this.runtime.now().getTime()) {
      return undefined;
    }
    const now = this.runtime.now().toISOString();
    return {
      roomCode: game.roomCode,
      sessionId: game.session.id,
      serverNow: now,
      clue: {
        clueId: clue.clueId,
        coordinates: { ...clue.coordinates },
        recordedAt: new Date(clue.recordedAtMs).toISOString(),
        exposedAt: new Date(clue.exposedAtMs).toISOString(),
        expiresAt: new Date(clue.expiresAtMs).toISOString(),
      },
    };
  }

  private createLateGameWarningStatePayload(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): ManhuntLateGameWarningStatePayload | undefined {
    const warning = game.lateGameExposure.warning;
    if (
      !warning ||
      warning.playerId !== playerId ||
      warning.expiresAtMs <= this.runtime.now().getTime()
    ) {
      return undefined;
    }
    return {
      roomCode: game.roomCode,
      sessionId: game.session.id,
      playerId,
      serverNow: this.runtime.now().toISOString(),
      warning: {
        exposureId: warning.exposureId,
        startedAt: new Date(warning.startedAtMs).toISOString(),
        expiresAt: new Date(warning.expiresAtMs).toISOString(),
      },
    };
  }

  private emitLateGameClueState(
    game: ManhuntRecord,
    clue: LateGameExposureClue | null,
  ): void {
    const serverNow = this.runtime.now().toISOString();
    for (const [playerId, team] of game.teams) {
      if (
        team !== "hunter" ||
        game.caughtPlayerIds.has(playerId) ||
        !this.isActivePlayer(game.roomCode, playerId)
      ) {
        continue;
      }
      this.events.lateGameClueState(game.roomCode, playerId, {
        roomCode: game.roomCode,
        sessionId: game.session.id,
        serverNow,
        clue: clue
          ? {
              clueId: clue.clueId,
              coordinates: { ...clue.coordinates },
              recordedAt: new Date(clue.recordedAtMs).toISOString(),
              exposedAt: new Date(clue.exposedAtMs).toISOString(),
              expiresAt: new Date(clue.expiresAtMs).toISOString(),
            }
          : null,
      });
    }
  }

  private emitLateGameWarningState(
    game: ManhuntRecord,
    warning: LateGameExposureWarning | null,
  ): void {
    if (!warning) {
      return;
    }
    this.events.lateGameWarningState(
      game.roomCode,
      warning.playerId,
      {
        roomCode: game.roomCode,
        sessionId: game.session.id,
        playerId: warning.playerId,
        serverNow: this.runtime.now().toISOString(),
        warning: {
          exposureId: warning.exposureId,
          startedAt: new Date(warning.startedAtMs).toISOString(),
          expiresAt: new Date(warning.expiresAtMs).toISOString(),
        },
      },
    );
  }

  private expireLateGameClue(
    game: ManhuntRecord,
    clueId: string,
  ): void {
    const clue = game.lateGameExposure.clue;
    if (
      this.currentGames.get(game.roomCode) !== game ||
      !clue ||
      clue.clueId !== clueId
    ) {
      return;
    }
    const remainingMs = clue.expiresAtMs - this.runtime.now().getTime();
    if (remainingMs > 0) {
      clue.timer = this.scheduleActiveGameTimer(
        game,
        remainingMs,
        () => this.expireLateGameClue(game, clueId),
      );
      return;
    }
    game.lateGameExposure.clue = undefined;
    this.emitLateGameClueState(game, null);
  }

  private expireLateGameWarning(
    game: ManhuntRecord,
    exposureId: string,
  ): void {
    const warning = game.lateGameExposure.warning;
    if (
      this.currentGames.get(game.roomCode) !== game ||
      !warning ||
      warning.exposureId !== exposureId
    ) {
      return;
    }
    const remainingMs = warning.expiresAtMs - this.runtime.now().getTime();
    if (remainingMs > 0) {
      warning.timer = this.scheduleActiveGameTimer(
        game,
        remainingMs,
        () => this.expireLateGameWarning(game, exposureId),
      );
      return;
    }
    game.lateGameExposure.warning = undefined;
    this.events.lateGameWarningState(
      game.roomCode,
      warning.playerId,
      {
        roomCode: game.roomCode,
        sessionId: game.session.id,
        playerId: warning.playerId,
        serverNow: this.runtime.now().toISOString(),
        warning: null,
      },
    );
  }

  private clearLateGameExposureForHider(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    const clue = game.lateGameExposure.clue;
    if (clue?.sourceHiderId === playerId) {
      clue.timer?.cancel();
      game.lateGameExposure.clue = undefined;
      this.emitLateGameClueState(game, null);
    }
    const warning = game.lateGameExposure.warning;
    if (warning?.playerId === playerId) {
      warning.timer?.cancel();
      game.lateGameExposure.warning = undefined;
      this.events.lateGameWarningState(game.roomCode, playerId, {
        roomCode: game.roomCode,
        sessionId: game.session.id,
        playerId,
        serverNow: this.runtime.now().toISOString(),
        warning: null,
      });
    }
  }

  private clearLateGameExposure(game: ManhuntRecord): void {
    game.lateGameExposureTimer?.cancel();
    game.lateGameExposureTimer = undefined;
    game.lateGameExposure.clue?.timer?.cancel();
    game.lateGameExposure.warning?.timer?.cancel();
    game.lateGameExposure.clue = undefined;
    game.lateGameExposure.warning = undefined;
    game.lateGameExposure.triggered = false;
    this.clearLateGameLocationHistories(game);
  }

  private pruneLateGameExposureClueForBoundary(game: ManhuntRecord): void {
    const clue = game.lateGameExposure.clue;
    const boundary = game.boundary;
    if (
      clue &&
      haversineMeters(boundary.center, clue.coordinates) >
        boundary.radiusMeters
    ) {
      clue.timer?.cancel();
      game.lateGameExposure.clue = undefined;
      this.emitLateGameClueState(game, null);
    }
  }

  private openRevealWindow(roomCode: RoomCode): void {
    const game = this.currentGames.get(roomCode);
    if (
      !game
      || game.session.status !== "in_progress"
      || game.session.state.phase !== "active"
    ) {
      return;
    }
    const locations = [...game.locations.entries()]
      .filter(([playerId]) => !game.caughtPlayerIds.has(playerId))
      .map(([playerId, location]) => ({
        playerId,
        coordinates: { ...location.coordinates },
        status: this.rooms.getPublicRoom(roomCode)?.players.find(
          (player) => player.id === playerId,
        )?.status ?? "active",
      }));
    const now = this.runtime.now();
    const visibleUntil = new Date(
      now.getTime() +
        MANHUNT_LOCATION_REVEAL_DURATION_SECONDS * 1_000,
    ).toISOString();
    const connectedPlayerIds =
      this.rooms
        .getPublicRoom(roomCode)
        ?.players.filter((player) => player.connectionStatus === "connected")
        .map((player) => player.id) ?? [];
    game.revealTimer?.cancel();
    const revealTimer = this.scheduleActiveGameTimer(
      game,
      MANHUNT_LOCATION_REVEAL_DURATION_SECONDS * 1_000,
      () => this.closeRevealWindow(roomCode),
    );
    game.revealTimer = revealTimer;
    game.revealActive = true;
    for (const recipientId of connectedPlayerIds) {
      const recipientTeam = game.teams.get(recipientId);
      const recipientLocations =
        recipientTeam === "hunter"
          ? locations.filter(
              ({ playerId }) =>
                !this.isSmokeBombActive(game, playerId, now.getTime()) &&
                !this.isGhostActive(game, playerId, now.getTime()),
            )
          : locations;
      this.events.locationFlashed(roomCode, recipientId, {
        sessionId: game.session.id,
        locations: recipientLocations,
        visibleUntil,
      });
    }
  }

  private closeRevealWindow(roomCode: RoomCode): void {
    const game = this.currentGames.get(roomCode);
    if (!game) {
      return;
    }
    game.revealActive = false;
    this.scheduleNextReveal(roomCode);
  }

  private endGame(
    game: ManhuntRecord,
    winningTeam: "hunter" | "runner",
  ): Promise<void> {
    if (
      this.currentGames.get(game.roomCode) !== game ||
      game.session.status !== "in_progress"
    ) {
      return Promise.resolve();
    }
    const existing = this.pendingFinishes.get(game.session.id);
    if (existing) {
      return existing;
    }
    const operation = this.endGameCore(game, winningTeam);
    const tracked = operation.finally(() => {
      if (this.pendingFinishes.get(game.session.id) === tracked) {
        this.pendingFinishes.delete(game.session.id);
      }
    });
    this.pendingFinishes.set(game.session.id, tracked);
    void tracked.catch((error: unknown) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "manhunt_game_completion_failed",
          roomCode: game.roomCode,
          gameId: game.session.id,
          error: error instanceof AppError
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown",
        }),
      );
    });
    return tracked;
  }

  private async endGameCore(
    game: ManhuntRecord,
    winningTeam: "hunter" | "runner",
  ): Promise<void> {
    const commit = (reservation?: RoomGameStatusReservation) => {
      const publicRoom = this.rooms.finishGame(
        game.roomCode,
        game.session.id,
        reservation,
      );
      if (!publicRoom) {
        throw new AppError("GAME_NOT_ACTIVE", "The Manhunt game is no longer current.");
      }
      game.session.status = "finished";
      game.session.endedAt = this.runtime.now().toISOString();
      game.session.state.phase = "finished";
      game.cycleTimer?.cancel();
      game.revealTimer?.cancel();
      game.gameTimer?.cancel();
      game.zoneWarningTimer?.cancel();
      game.zoneShrinkTimer?.cancel();
      this.clearMissionTimers(game);
      this.clearFreezeRound(game, true);
      this.clearFootsteps(game);
      this.clearSmokeBombs(game);
      this.clearGhosts(game);
      this.clearAllFreezeDecoys(game);
      this.clearLateGameExposure(game);
      game.revealActive = false;
      for (const request of [...game.pendingCatchRequests.values()]) {
        this.finishPendingCatch(game, request, "cancelled");
      }
      game.locations.clear();
      game.proximityPairs.clear();
      const winnerIds = [...game.teams.entries()]
        .filter(
          ([playerId, team]) =>
            team === winningTeam &&
            (winningTeam !== "runner" || !game.caughtPlayerIds.has(playerId)),
        )
        .map(([playerId]) => playerId);
      const ended: GameEndedPayload = {
        result: {
          gameId: game.session.id,
          roomCode: game.roomCode,
          gameMode: "manhunt",
          outcome: "win",
          winnerPlayerIds: winnerIds,
          endedAt: game.session.endedAt!,
        },
      };
      game.result = ended;
      this.events.roomUpdated(publicRoom);
      this.events.gameEnded(game.roomCode, ended);
    };

    if (this.persistenceCommands) {
      const room = this.rooms.getPublicRoom(game.roomCode);
      if (
        !room
        || room.gameStatus !== "in_progress"
        || room.currentGameId !== game.session.id
      ) {
        throw new AppError("GAME_NOT_ACTIVE", "The Manhunt game is no longer current.");
      }
      await persistGameCompletion(
        this.rooms,
        this.persistenceCommands,
        game.roomCode,
        game.session.id,
        "in_progress",
        (reservation) => commit(reservation),
      );
      return;
    }
    commit();
  }

  private expireCatchRequest(roomCode: RoomCode, requestId: string): void {
    const game = this.currentGames.get(roomCode);
    const request = game?.pendingCatchRequests.get(requestId);
    if (game && request) {
      this.finishPendingCatch(game, request, "expired");
    }
  }

  private finishPendingCatch(
    game: ManhuntRecord,
    request: PendingCatchRequest,
    status: CatchRequestStatus,
  ): void {
    if (!game.pendingCatchRequests.has(request.requestId)) {
      return;
    }
    request.timer.cancel();
    game.pendingCatchRequests.delete(request.requestId);
    if (game.pendingCatchByHunter.get(request.hunterId) === request.requestId) {
      game.pendingCatchByHunter.delete(request.hunterId);
    }
    if (game.pendingCatchByTarget.get(request.targetId) === request.requestId) {
      game.pendingCatchByTarget.delete(request.targetId);
    }
    this.emitCatchRequestStatus(game, request, status);
  }

  private emitCatchRequestStatus(
    game: ManhuntRecord,
    request: PendingCatchRequest,
    status: CatchRequestStatus,
  ): void {
    const payload: CatchRequestStatusPayload = {
      roomCode: game.roomCode,
      sessionId: game.session.id,
      requestId: request.requestId,
      status,
    };
    this.events.catchRequestStatus(game.roomCode, request.hunterId, payload);
    if (status !== "pending") {
      this.events.catchRequestStatus(game.roomCode, request.targetId, payload);
    }
  }

  private assertGameplayAvailable(
    roomCode: RoomCode,
    gameId?: GameSessionId | null,
  ): void {
    this.rooms.assertGameplayAvailable(roomCode, gameId);
  }

  private assertActivePlayer(roomCode: RoomCode, playerId: PlayerId): void {
    if (!this.isActivePlayer(roomCode, playerId)) {
      throw new AppError("GAME_NOT_READY", "This player is not active in Manhunt.");
    }
  }

  private isActivePlayer(roomCode: RoomCode, playerId: PlayerId): boolean {
    const player = this.rooms
      .getPublicRoom(roomCode)
      ?.players.find((entry) => entry.id === playerId);
    return player?.connectionStatus === "connected" && player.status === "active";
  }

  private getFreshLocation(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): PrivateLocation | undefined {
    const location = game.locations.get(playerId);
    if (!location) {
      return undefined;
    }
    const ageMs = this.runtime.now().getTime() - Date.parse(location.recordedAt);
    return ageMs >= 0 &&
      ageMs <= MANHUNT_LOCATION_MAX_AGE_SECONDS * 1_000
      ? location
      : undefined;
  }

  private getAccurateFreshLocation(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): PrivateLocation | undefined {
    const location = this.getFreshLocation(game, playerId);
    return location?.accuracyMeters !== undefined &&
      location.accuracyMeters <= MANHUNT_MISSION_MAX_ACCURACY_METERS
      ? location
      : undefined;
  }

  private createFootstepsStatePayload(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): ManhuntFootstepsStatePayload | undefined {
    const state = game.footstepsByHunter.get(playerId);
    if (!state) {
      return undefined;
    }
    const now = this.runtime.now().getTime();
    return {
      roomCode: game.roomCode,
      sessionId: game.session.id,
      playerId,
      remainingUses:
        MANHUNT_FOOTSTEPS_MAX_USES_PER_GAME - state.uses,
      serverNow: new Date(now).toISOString(),
      guidances: [...state.guidances.values()]
        .filter((guidance) => guidance.expiresAtMs > now)
        .map((guidance) => ({
          requestId: guidance.requestId,
          bearingDegrees: guidance.bearingDegrees,
          startedAt: new Date(guidance.startedAtMs).toISOString(),
          expiresAt: new Date(guidance.expiresAtMs).toISOString(),
        })),
    };
  }

  private emitFootstepsState(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    const payload = this.createFootstepsStatePayload(game, playerId);
    if (payload) {
      this.events.footstepsState(game.roomCode, playerId, payload);
    }
  }

  private expireFootsteps(
    game: ManhuntRecord,
    hunterId: PlayerId,
    requestId: string,
  ): void {
    if (
      this.currentGames.get(game.roomCode) !== game ||
      game.session.status !== "in_progress"
    ) {
      return;
    }
    const state = game.footstepsByHunter.get(hunterId);
    const guidance = state?.guidances.get(requestId);
    if (!state || !guidance) {
      return;
    }
    const remainingMs = guidance.expiresAtMs - this.runtime.now().getTime();
    if (remainingMs > 0) {
      guidance.timer = this.scheduleTrackedTimer(
        game,
        () => this.expireFootsteps(game, hunterId, requestId),
        remainingMs,
      );
      return;
    }
    state.guidances.delete(requestId);
    this.emitFootstepsState(game, hunterId);
  }

  private clearFootstepsForPlayer(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    const state = game.footstepsByHunter.get(playerId);
    if (!state) {
      return;
    }
    for (const guidance of state.guidances.values()) {
      guidance.timer.cancel();
    }
    state.guidances.clear();
    game.footstepsByHunter.delete(playerId);
  }

  private clearFootsteps(game: ManhuntRecord): void {
    for (const state of game.footstepsByHunter.values()) {
      for (const guidance of state.guidances.values()) {
        guidance.timer.cancel();
      }
      state.guidances.clear();
    }
    game.footstepsByHunter.clear();
  }

  private createSmokeBombStatePayload(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): ManhuntSmokeBombStatePayload | undefined {
    const state = game.smokeBombByHider.get(playerId);
    if (!state) {
      return undefined;
    }
    const now = this.runtime.now().getTime();
    return {
      roomCode: game.roomCode,
      sessionId: game.session.id,
      playerId,
      remainingUses:
        MANHUNT_SMOKE_BOMB_MAX_USES_PER_GAME - state.uses,
      serverNow: new Date(now).toISOString(),
      activeEffects: [...state.activeEffects.values()]
        .filter((effect) => effect.expiresAtMs > now)
        .map((effect) => ({
          requestId: effect.requestId,
          startedAt: new Date(effect.startedAtMs).toISOString(),
          expiresAt: new Date(effect.expiresAtMs).toISOString(),
        })),
    };
  }

  private emitSmokeBombState(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    const payload = this.createSmokeBombStatePayload(game, playerId);
    if (payload) {
      this.events.smokeBombState(game.roomCode, playerId, payload);
    }
  }

  private expireSmokeBomb(
    game: ManhuntRecord,
    hiderId: PlayerId,
    requestId: string,
  ): void {
    if (
      this.currentGames.get(game.roomCode) !== game ||
      game.session.status !== "in_progress"
    ) {
      return;
    }
    const state = game.smokeBombByHider.get(hiderId);
    const effect = state?.activeEffects.get(requestId);
    if (!state || !effect) {
      return;
    }
    const remainingMs = effect.expiresAtMs - this.runtime.now().getTime();
    if (remainingMs > 0) {
      effect.timer = this.scheduleTrackedTimer(
        game,
        () => this.expireSmokeBomb(game, hiderId, requestId),
        remainingMs,
      );
      return;
    }
    state.activeEffects.delete(requestId);
    this.emitSmokeBombState(game, hiderId);
  }

  private clearSmokeBombForPlayer(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    const state = game.smokeBombByHider.get(playerId);
    if (!state) {
      return;
    }
    for (const effect of state.activeEffects.values()) {
      effect.timer.cancel();
    }
    state.activeEffects.clear();
    game.smokeBombByHider.delete(playerId);
  }

  private clearSmokeBombs(game: ManhuntRecord): void {
    for (const state of game.smokeBombByHider.values()) {
      for (const effect of state.activeEffects.values()) {
        effect.timer.cancel();
      }
      state.activeEffects.clear();
    }
    game.smokeBombByHider.clear();
  }

  private isSmokeBombActive(
    game: ManhuntRecord,
    playerId: PlayerId,
    nowMs: number,
  ): boolean {
    return [...(game.smokeBombByHider.get(playerId)?.activeEffects.values() ?? [])]
      .some((effect) => effect.expiresAtMs > nowMs);
  }

  private getConfiguredGhostUsageLimit(): number | undefined {
    const usageLimit = this.ghostUsageLimit;
    return typeof usageLimit === "number" &&
      Number.isSafeInteger(usageLimit) &&
      usageLimit > 0
      ? usageLimit
      : undefined;
  }

  private createGhostStatePayload(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): ManhuntGhostStatePayload | undefined {
    const state = game.ghostByHider.get(playerId);
    if (!state) {
      return undefined;
    }
    const usageLimit = this.getConfiguredGhostUsageLimit();
    const now = this.runtime.now().getTime();
    return {
      roomCode: game.roomCode,
      sessionId: game.session.id,
      playerId,
      usageLimit: usageLimit ?? null,
      remainingUses:
        usageLimit === undefined ? null : Math.max(0, usageLimit - state.uses),
      serverNow: new Date(now).toISOString(),
      activeEffects:
        usageLimit === undefined
          ? []
          : [...state.activeEffects.values()]
              .filter((effect) => effect.expiresAtMs > now)
              .map((effect) => ({
                requestId: effect.requestId,
                startedAt: new Date(effect.startedAtMs).toISOString(),
                expiresAt: new Date(effect.expiresAtMs).toISOString(),
              })),
    };
  }

  private emitGhostState(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    const payload = this.createGhostStatePayload(game, playerId);
    if (payload) {
      this.events.ghostState(game.roomCode, playerId, payload);
    }
  }

  private expireGhost(
    game: ManhuntRecord,
    hiderId: PlayerId,
    requestId: string,
  ): void {
    if (
      this.currentGames.get(game.roomCode) !== game ||
      game.session.status !== "in_progress"
    ) {
      return;
    }
    const state = game.ghostByHider.get(hiderId);
    const effect = state?.activeEffects.get(requestId);
    if (!state || !effect) {
      return;
    }
    const remainingMs = effect.expiresAtMs - this.runtime.now().getTime();
    if (remainingMs > 0) {
      effect.timer = undefined;
      const connected = this.rooms
        .getPublicRoom(game.roomCode)
        ?.players.some(
          (player) =>
            player.id === hiderId &&
            player.connectionStatus === "connected",
        );
      if (connected) {
        effect.timer = this.scheduleTrackedTimer(
          game,
          () => this.expireGhost(game, hiderId, requestId),
          remainingMs,
        );
      }
      return;
    }
    state.activeEffects.delete(requestId);
    this.emitGhostState(game, hiderId);
  }

  private syncGhostEffectTimers(
    game: ManhuntRecord,
    hiderId: PlayerId,
  ): void {
    const state = game.ghostByHider.get(hiderId);
    if (!state) {
      return;
    }
    const now = this.runtime.now().getTime();
    const connected = this.rooms
      .getPublicRoom(game.roomCode)
      ?.players.some(
        (player) =>
          player.id === hiderId && player.connectionStatus === "connected",
      );
    for (const [requestId, effect] of state.activeEffects) {
      const remainingMs = effect.expiresAtMs - now;
      if (remainingMs <= 0) {
        effect.timer?.cancel();
        state.activeEffects.delete(requestId);
      } else if (!connected) {
        effect.timer?.cancel();
        effect.timer = undefined;
      } else if (!effect.timer) {
        effect.timer = this.scheduleTrackedTimer(
          game,
          () => this.expireGhost(game, hiderId, requestId),
          remainingMs,
        );
      }
    }
  }

  private clearGhostForPlayer(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    const state = game.ghostByHider.get(playerId);
    if (!state) {
      return;
    }
    for (const effect of state.activeEffects.values()) {
      effect.timer?.cancel();
    }
    state.activeEffects.clear();
    game.ghostByHider.delete(playerId);
  }

  private clearGhosts(game: ManhuntRecord): void {
    for (const state of game.ghostByHider.values()) {
      for (const effect of state.activeEffects.values()) {
        effect.timer?.cancel();
      }
      state.activeEffects.clear();
    }
    game.ghostByHider.clear();
  }

  private isGhostActive(
    game: ManhuntRecord,
    playerId: PlayerId,
    nowMs: number,
  ): boolean {
    return [...(game.ghostByHider.get(playerId)?.activeEffects.values() ?? [])]
      .some((effect) => effect.expiresAtMs > nowMs);
  }

  private generateFreezeDecoyCoordinates(game: ManhuntRecord): Coordinates {
    const boundary = game.boundary;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const radialSample = this.freezeDecoyRandomInt(0, 1_000_000);
      const bearingSample = this.freezeDecoyRandomInt(0, 360_000);
      if (
        !Number.isSafeInteger(radialSample) ||
        radialSample < 0 ||
        radialSample >= 1_000_000 ||
        !Number.isSafeInteger(bearingSample) ||
        bearingSample < 0 ||
        bearingSample >= 360_000
      ) {
        throw new AppError(
          "GAME_NOT_READY",
          "A valid synthetic Freeze Decoy location could not be generated.",
        );
      }

      const distanceMeters =
        Math.sqrt(radialSample / 1_000_000) * boundary.radiusMeters;
      const coordinates = distanceMeters === 0
        ? { ...boundary.center }
        : destinationCoordinates(
            boundary.center,
            distanceMeters,
            (bearingSample / 1_000) * (Math.PI / 180),
          );
      if (
        !Number.isFinite(coordinates.latitude) ||
        !Number.isFinite(coordinates.longitude) ||
        haversineMeters(coordinates, boundary.center) > boundary.radiusMeters
      ) {
        throw new AppError(
          "GAME_NOT_READY",
          "A valid synthetic Freeze Decoy location could not be generated.",
        );
      }

      const matchesHiderLocation = [...game.teams].some(
        ([playerId, team]) => {
          if (team !== "runner" || game.caughtPlayerIds.has(playerId)) {
            return false;
          }
          const location = game.locations.get(playerId);
          return (
            location !== undefined &&
            location.coordinates.latitude === coordinates.latitude &&
            location.coordinates.longitude === coordinates.longitude
          );
        },
      );
      if (!matchesHiderLocation) {
        return coordinates;
      }
    }

    throw new AppError(
      "GAME_NOT_READY",
      "A valid synthetic Freeze Decoy location could not be generated.",
    );
  }

  private createFreezeDecoyUsageStatePayload(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): ManhuntFreezeDecoyUsageStatePayload | undefined {
    const state = game.freezeDecoysByHider.get(playerId);
    if (!state) {
      return undefined;
    }
    return {
      roomCode: game.roomCode,
      sessionId: game.session.id,
      playerId,
      remainingUses:
        MANHUNT_FREEZE_DECOY_MAX_USES_PER_GAME - state.uses,
      serverNow: this.runtime.now().toISOString(),
    };
  }

  private emitFreezeDecoyUsageState(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    const payload = this.createFreezeDecoyUsageStatePayload(game, playerId);
    if (payload) {
      this.events.freezeDecoyUsageState(game.roomCode, playerId, payload);
    }
  }

  private createFreezeDecoyStatePayload(
    game: ManhuntRecord,
  ): ManhuntFreezeDecoyStatePayload {
    const now = this.runtime.now().getTime();
    const decoys: ManhuntFreezeDecoyPayload[] = [];
    for (const state of game.freezeDecoysByHider.values()) {
      for (const decoy of state.activeDecoys.values()) {
        if (
          decoy.expiresAtMs <= now ||
          haversineMeters(
            decoy.coordinates,
            game.boundary.center,
          ) > game.boundary.radiusMeters
        ) {
          continue;
        }
        decoys.push({
          decoyId: decoy.decoyId,
          coordinates: { ...decoy.coordinates },
          startedAt: new Date(decoy.startedAtMs).toISOString(),
          expiresAt: new Date(decoy.expiresAtMs).toISOString(),
        });
      }
    }
    return {
      roomCode: game.roomCode,
      sessionId: game.session.id,
      serverNow: new Date(now).toISOString(),
      decoys,
    };
  }

  private emitFreezeDecoyState(game: ManhuntRecord): void {
    const payload = this.createFreezeDecoyStatePayload(game);
    for (const [playerId, team] of game.teams) {
      if (
        team !== "hunter" ||
        game.caughtPlayerIds.has(playerId) ||
        !this.isActivePlayer(game.roomCode, playerId)
      ) {
        continue;
      }
      this.events.freezeDecoyState(game.roomCode, playerId, payload);
    }
  }

  private pruneFreezeDecoys(
    game: ManhuntRecord,
    notifyHunters = true,
  ): boolean {
    const now = this.runtime.now().getTime();
    const boundary = game.boundary;
    let changed = false;
    for (const state of game.freezeDecoysByHider.values()) {
      for (const [decoyId, decoy] of state.activeDecoys) {
        if (
          decoy.expiresAtMs <= now ||
          haversineMeters(decoy.coordinates, boundary.center) >
            boundary.radiusMeters
        ) {
          decoy.timer.cancel();
          state.activeDecoys.delete(decoyId);
          changed = true;
        }
      }
    }
    if (changed && notifyHunters) {
      this.emitFreezeDecoyState(game);
    }
    return changed;
  }

  private expireFreezeDecoy(
    game: ManhuntRecord,
    hiderId: PlayerId,
    decoyId: string,
  ): void {
    if (
      this.currentGames.get(game.roomCode) !== game ||
      game.session.status !== "in_progress"
    ) {
      return;
    }
    const state = game.freezeDecoysByHider.get(hiderId);
    const decoy = state?.activeDecoys.get(decoyId);
    if (!state || !decoy) {
      return;
    }
    const remainingMs = decoy.expiresAtMs - this.runtime.now().getTime();
    if (remainingMs > 0) {
      decoy.timer = this.scheduleTrackedTimer(
        game,
        () => this.expireFreezeDecoy(game, hiderId, decoyId),
        remainingMs,
      );
      return;
    }
    state.activeDecoys.delete(decoyId);
    this.emitFreezeDecoyState(game);
  }

  private clearFreezeDecoysForPlayer(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    const state = game.freezeDecoysByHider.get(playerId);
    if (!state) {
      return;
    }
    for (const decoy of state.activeDecoys.values()) {
      decoy.timer.cancel();
    }
    const hadActiveDecoys = state.activeDecoys.size > 0;
    state.activeDecoys.clear();
    game.freezeDecoysByHider.delete(playerId);
    if (hadActiveDecoys) {
      this.emitFreezeDecoyState(game);
    }
  }

  private clearAllFreezeDecoys(game: ManhuntRecord): void {
    let hadActiveDecoys = false;
    for (const state of game.freezeDecoysByHider.values()) {
      for (const decoy of state.activeDecoys.values()) {
        decoy.timer.cancel();
      }
      hadActiveDecoys = hadActiveDecoys || state.activeDecoys.size > 0;
      state.activeDecoys.clear();
    }
    game.freezeDecoysByHider.clear();
    if (hadActiveDecoys) {
      this.emitFreezeDecoyState(game);
    }
  }

  private getFreezeStatePayload(
    game: ManhuntRecord,
    playerId: PlayerId,
  ):
    | { type: "warning"; payload: ManhuntFreezeWarningPayload }
    | { type: "frozen"; payload: PlayerFrozenPayload }
    | undefined {
    const round = game.freezeRound;
    if (!round?.playerIds.has(playerId)) {
      return undefined;
    }
    if (round.phase === "warning") {
      return {
        type: "warning",
        payload: {
          roomCode: game.roomCode,
          sessionId: game.session.id,
          playerId,
          requestId: round.requestId,
          warningStartedAt: new Date(round.warningStartedAtMs).toISOString(),
          warningEndsAt: new Date(round.warningEndsAtMs).toISOString(),
        },
      };
    }
    if (round.frozenAtMs === undefined || round.frozenUntilMs === undefined) {
      return undefined;
    }
    return {
      type: "frozen",
      payload: {
        roomCode: game.roomCode,
        sessionId: game.session.id,
        playerId,
        requestId: round.requestId,
        frozenAt: new Date(round.frozenAtMs).toISOString(),
        frozenUntil: new Date(round.frozenUntilMs).toISOString(),
      },
    };
  }

  private beginFreeze(game: ManhuntRecord, round: ManhuntFreezeRound): void {
    if (
      this.currentGames.get(game.roomCode) !== game ||
      game.freezeRound !== round ||
      round.phase !== "warning" ||
      game.session.status !== "in_progress" ||
      game.session.state.phase !== "active"
    ) {
      return;
    }
    round.timer = undefined;
    for (const playerId of [...round.playerIds]) {
      if (
        game.caughtPlayerIds.has(playerId) ||
        game.teams.get(playerId) !== "runner" ||
        !this.isActivePlayer(game.roomCode, playerId)
      ) {
        round.playerIds.delete(playerId);
      }
    }
    if (round.playerIds.size === 0) {
      game.freezeRound = undefined;
      return;
    }

    round.phase = "frozen";
    round.frozenAtMs = this.runtime.now().getTime();
    round.frozenUntilMs =
      round.frozenAtMs + MANHUNT_FREEZE_DURATION_SECONDS * 1_000;
    for (const playerId of round.playerIds) {
      this.events.playerFrozen(game.roomCode, playerId, {
        roomCode: game.roomCode,
        sessionId: game.session.id,
        playerId,
        requestId: round.requestId,
        frozenAt: new Date(round.frozenAtMs).toISOString(),
        frozenUntil: new Date(round.frozenUntilMs).toISOString(),
      });
    }
    round.timer = this.scheduleTrackedTimer(
      game,
      () => this.endFreeze(game, round),
      MANHUNT_FREEZE_DURATION_SECONDS * 1_000,
    );
  }

  private endFreeze(game: ManhuntRecord, round: ManhuntFreezeRound): void {
    if (
      this.currentGames.get(game.roomCode) !== game ||
      game.freezeRound !== round ||
      round.phase !== "frozen"
    ) {
      return;
    }
    round.timer = undefined;
    this.clearFreezeRound(game, true);
  }

  private clearFreezeForPlayer(
    game: ManhuntRecord,
    playerId: PlayerId,
    notify: boolean,
  ): void {
    const round = game.freezeRound;
    if (!round?.playerIds.delete(playerId)) {
      return;
    }
    if (notify) {
      this.emitFreezeEnded(game, round, playerId);
    }
    if (round.playerIds.size === 0) {
      round.timer?.cancel();
      game.freezeRound = undefined;
    }
  }

  private clearFreezeRound(game: ManhuntRecord, notify: boolean): void {
    const round = game.freezeRound;
    if (!round) {
      return;
    }
    round.timer?.cancel();
    round.timer = undefined;
    game.freezeRound = undefined;
    if (notify) {
      for (const playerId of round.playerIds) {
        this.emitFreezeEnded(game, round, playerId);
      }
    }
    round.playerIds.clear();
  }

  private emitFreezeEnded(
    game: ManhuntRecord,
    round: ManhuntFreezeRound,
    playerId: PlayerId,
  ): void {
    this.events.playerFreezeEnded(game.roomCode, playerId, {
      roomCode: game.roomCode,
      sessionId: game.session.id,
      playerId,
      requestId: round.requestId,
      endedAt: this.runtime.now().toISOString(),
    });
  }

  private deactivatePlayer(game: ManhuntRecord, playerId: PlayerId): void {
    game.locations.delete(playerId);
    this.clearFreezeForPlayer(game, playerId, true);
    this.clearProximityForPlayer(game, playerId);
    this.resetMissionDwell(game, playerId);
    for (const request of [...game.pendingCatchRequests.values()]) {
      if (request.hunterId === playerId || request.targetId === playerId) {
        this.finishPendingCatch(game, request, "cancelled");
      }
    }
  }

  private updateProximity(game: ManhuntRecord, playerId: PlayerId): void {
    if (
      game.session.status !== "in_progress" ||
      game.caughtPlayerIds.has(playerId) ||
      !this.isActivePlayer(game.roomCode, playerId)
    ) {
      this.clearProximityForPlayer(game, playerId);
      return;
    }
    const location = this.getFreshLocation(game, playerId);
    if (!location) {
      this.clearProximityForPlayer(game, playerId);
      return;
    }

    const team = game.teams.get(playerId);
    if (!team) {
      return;
    }
    for (const [otherPlayerId, otherTeam] of game.teams) {
      if (otherPlayerId === playerId) {
        continue;
      }
      const pairKey = getPairKey(playerId, otherPlayerId);
      if (
        team === otherTeam ||
        game.caughtPlayerIds.has(otherPlayerId) ||
        !this.isActivePlayer(game.roomCode, otherPlayerId)
      ) {
        game.proximityPairs.delete(pairKey);
        continue;
      }
      const otherLocation = this.getFreshLocation(game, otherPlayerId);
      if (!otherLocation) {
        game.proximityPairs.delete(pairKey);
        continue;
      }

      const distance = haversineMeters(
        location.coordinates,
        otherLocation.coordinates,
      );
      const level: PairProximityState["level"] =
        distance <= MANHUNT_PROXIMITY_STRONG_METERS
          ? "very_near"
          : distance <= MANHUNT_PROXIMITY_NEAR_METERS
            ? "near"
            : "outside";
      const playerIds: [PlayerId, PlayerId] =
        playerId < otherPlayerId
          ? [playerId, otherPlayerId]
          : [otherPlayerId, playerId];
      const state = game.proximityPairs.get(pairKey) ?? {
        playerIds,
        level: "outside",
      };
      const now = this.runtime.now().getTime();
      const cooldownMs = MANHUNT_PROXIMITY_COOLDOWN_SECONDS * 1_000;

      if (
        level === "near" &&
        state.level === "outside" &&
        now - (state.lastNearAt ?? Number.NEGATIVE_INFINITY) >= cooldownMs
      ) {
        this.emitProximityAlert(game, state.playerIds, "near");
        state.lastNearAt = now;
      } else if (
        level === "very_near" &&
        state.level !== "very_near" &&
        now - (state.lastVeryNearAt ?? Number.NEGATIVE_INFINITY) >= cooldownMs
      ) {
        this.emitProximityAlert(game, state.playerIds, "very_near");
        state.lastVeryNearAt = now;
      }
      state.level = level;
      game.proximityPairs.set(pairKey, state);
    }
  }

  private emitProximityAlert(
    game: ManhuntRecord,
    playerIds: [PlayerId, PlayerId],
    level: ManhuntProximityLevel,
  ): void {
    const payload: ManhuntProximityAlertPayload = {
      roomCode: game.roomCode,
      sessionId: game.session.id,
      level,
    };
    for (const playerId of playerIds) {
      this.events.proximityAlert(game.roomCode, playerId, payload);
    }
  }

  private clearProximityForPlayer(
    game: ManhuntRecord,
    playerId: PlayerId,
  ): void {
    for (const [key, state] of game.proximityPairs) {
      if (state.playerIds.includes(playerId)) {
        game.proximityPairs.delete(key);
      }
    }
  }

  private assignTeams(
    playerIds: PlayerId[],
    hunterCount: number,
  ): ManhuntTeamAssignment[] {
    const shuffled = [...playerIds];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = randomInt(index + 1);
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex]!, shuffled[index]!];
    }

    return shuffled.map((playerId, index) => ({
      playerId,
      team: index < hunterCount ? "hunter" : "runner",
    }));
  }
}

function getPairKey(firstPlayerId: PlayerId, secondPlayerId: PlayerId): string {
  return firstPlayerId < secondPlayerId
    ? `${firstPlayerId}:${secondPlayerId}`
    : `${secondPlayerId}:${firstPlayerId}`;
}

function destinationCoordinates(
  origin: Coordinates,
  distanceMeters: number,
  bearingRadians: number,
): Coordinates {
  const earthRadiusMeters = 6_371_000;
  const angularDistance = distanceMeters / earthRadiusMeters;
  const originLatitude = toRadians(origin.latitude);
  const originLongitude = toRadians(origin.longitude);
  const latitude = Math.asin(
    Math.sin(originLatitude) * Math.cos(angularDistance) +
      Math.cos(originLatitude) *
        Math.sin(angularDistance) *
        Math.cos(bearingRadians),
  );
  const longitude =
    originLongitude +
    Math.atan2(
      Math.sin(bearingRadians) *
        Math.sin(angularDistance) *
        Math.cos(originLatitude),
      Math.cos(angularDistance) -
        Math.sin(originLatitude) * Math.sin(latitude),
    );
  const normalizedLongitude =
    ((longitude + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  return {
    latitude: (latitude * 180) / Math.PI,
    longitude: (normalizedLongitude * 180) / Math.PI,
  };
}

function haversineMeters(first: Coordinates, second: Coordinates): number {
  const earthRadiusMeters = 6_371_000;
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const latitudeDelta = toRadians(second.latitude - first.latitude);
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMeters * Math.asin(Math.sqrt(haversine));
}

function calculateBearingDegrees(
  origin: Coordinates,
  destination: Coordinates,
): number {
  const originLatitude = toRadians(origin.latitude);
  const destinationLatitude = toRadians(destination.latitude);
  const longitudeDelta = toRadians(destination.longitude - origin.longitude);
  const y = Math.sin(longitudeDelta) * Math.cos(destinationLatitude);
  const x =
    Math.cos(originLatitude) * Math.sin(destinationLatitude) -
    Math.sin(originLatitude) *
      Math.cos(destinationLatitude) *
      Math.cos(longitudeDelta);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
