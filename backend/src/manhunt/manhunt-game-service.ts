import { randomInt, randomUUID } from "node:crypto";
import {
  MANHUNT_CATCH_DISTANCE_METERS,
  MANHUNT_CATCH_REQUEST_DURATION_SECONDS,
  MANHUNT_COUNTDOWN_DURATION_SECONDS,
  DEFAULT_MANHUNT_GAME_DURATION_SECONDS,
  MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS,
  MANHUNT_LOCATION_MAX_AGE_SECONDS,
  MANHUNT_LOCATION_REVEAL_DURATION_SECONDS,
  MANHUNT_PROXIMITY_COOLDOWN_SECONDS,
  MANHUNT_PROXIMITY_NEAR_METERS,
  MANHUNT_PROXIMITY_STRONG_METERS,
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
  ManhuntGameState,
  ManhuntCountdownCancelledPayload,
  ManhuntLocationAcknowledgementPayload,
  ManhuntProximityAlertPayload,
  ManhuntProximityLevel,
  ManhuntSettings,
  ManhuntTeamAssignment,
  PlayerId,
  RoomCode,
  GameEndedPayload,
  LocationFlashPayload,
  PlayerCaughtPayload,
} from "@impostor/api";
import { RoomService } from "../rooms/room-service.js";
import { AppError } from "../utils/app-error.js";
import type { GameRuntime, GameTimer } from "../games/imposter/classic-game-service.js";

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

export function determineManhuntTimeoutWinner(
  teams: ReadonlyMap<PlayerId, "hunter" | "runner">,
  caughtPlayerIds: ReadonlySet<PlayerId>,
): "hunter" | "runner" {
  const hasUncaughtRunner = [...teams].some(
    ([playerId, team]) =>
      team === "runner" && !caughtPlayerIds.has(playerId),
  );
  return hasUncaughtRunner ? "runner" : "hunter";
}

interface ManhuntRecord {
  roomCode: RoomCode;
  session: Extract<GameSession, { gameMode: "manhunt" }>;
  teams: Map<PlayerId, "hunter" | "runner">;
  readyPlayerIds: Set<PlayerId>;
  locations: Map<PlayerId, PrivateLocation>;
  pendingCatchRequests: Map<string, PendingCatchRequest>;
  pendingCatchByHunter: Map<PlayerId, string>;
  pendingCatchByTarget: Map<PlayerId, string>;
  proximityPairs: Map<string, PairProximityState>;
  cycleTimer?: GameTimer;
  countdownTimer?: GameTimer;
  gameDurationTimer?: GameTimer;
  revealTimer?: GameTimer;
  revealActive: boolean;
  caughtPlayerIds: Set<PlayerId>;
  result?: GameEndedPayload;
}

export interface ManhuntGameEvents {
  gameStarted(roomCode: RoomCode, payload: import("@impostor/api").GameStartedPayload): void;
  roomUpdated(room: import("@impostor/api").Room): void;
  stateUpdated(roomCode: RoomCode, payload: import("@impostor/api").GameStateUpdatePayload): void;
  settingsUpdated(roomCode: RoomCode, payload: import("@impostor/api").ManhuntSettingsUpdatePayload): void;
  teamAssignment(roomCode: RoomCode, payload: import("@impostor/api").ManhuntTeamAssignmentPayload): void;
  readyUpdated(roomCode: RoomCode, payload: import("@impostor/api").ManhuntReadyUpdatePayload): void;
  gameEnded(roomCode: RoomCode, payload: import("@impostor/api").GameEndedPayload): void;
  countdownUpdated(roomCode: RoomCode, payload: CountdownPayload): void;
  countdownCancelled(
    roomCode: RoomCode,
    payload: ManhuntCountdownCancelledPayload,
  ): void;
  locationFlashed(roomCode: RoomCode, payload: LocationFlashPayload): void;
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
}

export class ManhuntGameService {
  private readonly currentGames = new Map<RoomCode, ManhuntRecord>();
  private readonly pendingReadyPlayerIds = new Map<RoomCode, Set<PlayerId>>();

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
  ) {}

  updateSettings(
    roomCode: RoomCode,
    socketId: string,
    settings: ManhuntSettings,
  ): ManhuntSettings {
    const parsed = manhuntSettingsSchema.safeParse(settings);
    if (!parsed.success) {
      throw new AppError("INVALID_PAYLOAD", "Manhunt settings are invalid.");
    }
    const room = this.rooms.updateManhuntSettings(roomCode, socketId, parsed.data);
    this.events.roomUpdated(room);
    this.events.settingsUpdated(roomCode, { roomCode, settings: parsed.data });
    return parsed.data;
  }

  startGame(roomCode: RoomCode, socketId: string): Extract<GameSession, { gameMode: "manhunt" }> {
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
    const settings = manhuntSettingsSchema.safeParse(room.settings.manhunt);
    if (!settings.success) {
      throw new AppError("INVALID_PAYLOAD", "Manhunt settings are required before starting.");
    }
    if (settings.data.hunterCount >= room.players.length) {
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
      settings.data.hunterCount,
    );
    const teams = new Map(assignments.map((assignment) => [assignment.playerId, assignment.team]));
    const state: ManhuntGameState = {
      phase: "countdown",
      settings: {
        ...settings.data,
        gameDurationSeconds:
          settings.data.gameDurationSeconds ??
          DEFAULT_MANHUNT_GAME_DURATION_SECONDS,
      },
      teams: assignments,
      readyPlayerIds: [...(this.pendingReadyPlayerIds.get(roomCode) ?? [])],
      countdownEndsAt: new Date(
        now.getTime() + MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000,
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
    const publicRoom = this.rooms.beginManhuntCountdown(
      roomCode,
      socketId,
      sessionId,
    );
    this.currentGames.set(roomCode, {
      roomCode,
      session,
      teams,
      locations: new Map(),
      pendingCatchRequests: new Map(),
      pendingCatchByHunter: new Map(),
      pendingCatchByTarget: new Map(),
      proximityPairs: new Map(),
      revealActive: false,
      caughtPlayerIds: new Set(),
      readyPlayerIds: this.pendingReadyPlayerIds.get(roomCode) ?? new Set(),
    });
    this.pendingReadyPlayerIds.delete(roomCode);
    const game = this.currentGames.get(roomCode);
    if (!game) {
      throw new Error("Manhunt countdown was not created.");
    }
    game.countdownTimer = this.runtime.schedule(
      () => this.activateCountdown(roomCode, sessionId),
      MANHUNT_COUNTDOWN_DURATION_SECONDS * 1_000,
    );
    this.events.roomUpdated(publicRoom);
    this.events.gameStarted(roomCode, { session });
    this.events.stateUpdated(roomCode, {
      sessionId,
      roomCode,
      state,
      updatedAt: now.toISOString(),
    });
    this.events.teamAssignment(roomCode, { sessionId, assignments });
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
    if (
      !game ||
      game.session.status !== "in_progress" ||
      game.session.state.phase !== "active"
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "Manhunt is not active.");
    }
    if (!game.teams.has(playerId)) {
      throw new AppError("NOT_AUTHORIZED", "Player is not participating in this Manhunt.");
    }
    this.assertActivePlayer(roomCode, playerId);
    const recordedAt = this.runtime.now().toISOString();
    game.locations.set(playerId, {
      coordinates: { ...coordinates },
      accuracyMeters,
      recordedAt,
      clientTimestamp,
    });
    this.updateProximity(game, playerId);
    return { sessionId: game.session.id, recordedAt };
  }

  getResumeSnapshot(roomCode: RoomCode, playerId: PlayerId):
    | {
        started: import("@impostor/api").GameStartedPayload;
        state: import("@impostor/api").GameStateUpdatePayload;
        countdown?: CountdownPayload;
        ended?: GameEndedPayload;
      }
    | undefined {
    const game = this.currentGames.get(roomCode);
    if (!game || !game.teams.has(playerId)) {
      return undefined;
    }
    const state = game.session.state;
    return {
      started: { session: game.session },
      state: {
        sessionId: game.session.id,
        roomCode,
        state,
        updatedAt: this.runtime.now().toISOString(),
      },
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
    const playerId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
    const game = this.currentGames.get(roomCode);
    if (
      !game ||
      !game.teams.has(playerId) ||
      game.session.id !== sessionId ||
      game.session.status !== "starting" ||
      game.session.state.phase !== "countdown" ||
      !game.session.state.countdownEndsAt
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "The Manhunt countdown is no longer active.");
    }
    return {
      roomCode,
      sessionId,
      endsAt: game.session.state.countdownEndsAt,
      serverNow: this.runtime.now().toISOString(),
    };
  }

  setReady(roomCode: RoomCode, socketId: string, ready: boolean): void {
    const playerId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
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
      timer: this.runtime.schedule(
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
    }
  }

  onPlayerDisconnected(roomCode: RoomCode, playerId: PlayerId): void {
    const game = this.currentGames.get(roomCode);
    if (!game) {
      return;
    }
    this.deactivatePlayer(game, playerId);
  }

  close(roomCode: RoomCode): void {
    this.clearSession(roomCode);
  }

  shutdown(): void {
    for (const roomCode of [...this.currentGames.keys()]) {
      this.clearSession(roomCode);
    }
  }

  onPlayerRemoved(roomCode: RoomCode, roomStillExists: boolean): void {
    const game = this.currentGames.get(roomCode);
    if (!game) return;
    if (game.session.state.phase === "countdown") {
      this.cancelCountdown(
        roomCode,
        game,
        roomStillExists ? "player_left" : "room_unavailable",
      );
      return;
    }
    const room = this.rooms.getPublicRoom(roomCode);
    const removedPlayerId = [...game.teams.keys()].find(
      (playerId) => !room?.players.some((player) => player.id === playerId),
    );
    if (removedPlayerId) {
      this.deactivatePlayer(game, removedPlayerId);
    }
    if (!roomStillExists) {
      this.clearSession(roomCode);
    }
  }

  clearSession(roomCode: RoomCode): void {
    this.pendingReadyPlayerIds.delete(roomCode);
    const game = this.currentGames.get(roomCode);
    if (game) {
      for (const request of [...game.pendingCatchRequests.values()]) {
        this.finishPendingCatch(game, request, "cancelled");
      }
      game.cycleTimer?.cancel();
      game.countdownTimer?.cancel();
      game.gameDurationTimer?.cancel();
      game.revealTimer?.cancel();
      game.locations.clear();
      game.proximityPairs.clear();
      game.readyPlayerIds.clear();
      game.teams.clear();
      game.caughtPlayerIds.clear();
    }
    this.currentGames.delete(roomCode);
  }

  private activateCountdown(roomCode: RoomCode, sessionId: GameSessionId): void {
    const game = this.currentGames.get(roomCode);
    if (
      !game ||
      game.session.id !== sessionId ||
      game.session.status !== "starting" ||
      game.session.state.phase !== "countdown"
    ) {
      return;
    }

    const room = this.rooms.getPublicRoom(roomCode);
    if (
      !room ||
      room.currentGameId !== sessionId ||
      room.gameStatus !== "starting"
    ) {
      this.cancelCountdown(roomCode, game, "room_unavailable");
      return;
    }
    if (
      room.players.length < 2 ||
      room.players.some((player) => player.connectionStatus !== "connected")
    ) {
      this.cancelCountdown(roomCode, game, "player_disconnected");
      return;
    }

    const now = this.runtime.now();
    const activeSince = now.toISOString();
    game.countdownTimer?.cancel();
    game.countdownTimer = undefined;
    game.session.status = "in_progress";
    game.session.startedAt = activeSince;
    game.session.state.phase = "active";
    game.session.state.activeSince = activeSince;
    const gameDurationSeconds =
      game.session.state.settings.gameDurationSeconds ??
      DEFAULT_MANHUNT_GAME_DURATION_SECONDS;
    game.session.state.settings.gameDurationSeconds = gameDurationSeconds;
    const gameEndsAt = new Date(
      now.getTime() + gameDurationSeconds * 1_000,
    ).toISOString();
    game.session.state.gameEndsAt = gameEndsAt;
    delete game.session.state.countdownEndsAt;

    const activeRoom = this.rooms.activateGame(roomCode, sessionId);
    this.events.roomUpdated(activeRoom);
    this.events.stateUpdated(roomCode, {
      sessionId,
      roomCode,
      state: game.session.state,
      updatedAt: activeSince,
    });
    this.scheduleNextReveal(roomCode);
    this.scheduleGameDurationEnd(roomCode, sessionId, game, gameEndsAt);
  }

  private scheduleGameDurationEnd(
    roomCode: RoomCode,
    sessionId: GameSessionId,
    game: ManhuntRecord,
    gameEndsAt: string,
  ): void {
    game.gameDurationTimer?.cancel();
    game.gameDurationTimer = this.runtime.schedule(() => {
      game.gameDurationTimer = undefined;
      const current = this.currentGames.get(roomCode);
      if (
        current !== game ||
        current.session.id !== sessionId ||
        current.session.status !== "in_progress" ||
        current.session.state.phase !== "active"
      ) {
        return;
      }

      this.endGame(
        current,
        determineManhuntTimeoutWinner(
          current.teams,
          current.caughtPlayerIds,
        ),
        gameEndsAt,
      );
    }, Math.max(0, Date.parse(gameEndsAt) - this.runtime.now().getTime()));
  }

  private createCountdownPayload(game: ManhuntRecord): CountdownPayload {
    const endsAt = game.session.state.countdownEndsAt;
    if (!endsAt) {
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
      serverNow,
    };
  }

  private cancelCountdown(
    roomCode: RoomCode,
    game: ManhuntRecord,
    reason: ManhuntCountdownCancelledPayload["reason"],
  ): void {
    if (
      this.currentGames.get(roomCode) !== game ||
      game.session.state.phase !== "countdown"
    ) {
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
  }

  private scheduleNextReveal(roomCode: RoomCode): void {
    const game = this.currentGames.get(roomCode);
    if (!game || game.session.status !== "in_progress") {
      return;
    }
    game.revealActive = false;
    game.cycleTimer?.cancel();
    game.cycleTimer = this.runtime.schedule(
      () => this.openRevealWindow(roomCode),
      MANHUNT_LOCATION_FLASH_INTERVAL_SECONDS * 1_000,
    );
  }

  private openRevealWindow(roomCode: RoomCode): void {
    const game = this.currentGames.get(roomCode);
    if (!game || game.session.status !== "in_progress") {
      return;
    }
    game.revealActive = true;
    const locations = [...game.locations.entries()]
      .filter(([playerId]) => !game.caughtPlayerIds.has(playerId))
      .map(([playerId, location]) => ({
        playerId,
        coordinates: { ...location.coordinates },
        team: game.teams.get(playerId) ?? "runner",
        status: this.rooms.getPublicRoom(roomCode)?.players.find(
          (player) => player.id === playerId,
        )?.status ?? "active",
      }));
    const now = this.runtime.now();
    const visibleUntil = new Date(
      now.getTime() +
        MANHUNT_LOCATION_REVEAL_DURATION_SECONDS * 1_000,
    ).toISOString();
    this.events.locationFlashed(roomCode, {
      sessionId: game.session.id,
      locations,
      visibleUntil,
    });
    game.revealTimer?.cancel();
    game.revealTimer = this.runtime.schedule(
      () => this.closeRevealWindow(roomCode),
      MANHUNT_LOCATION_REVEAL_DURATION_SECONDS * 1_000,
    );
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
    endedAt = this.runtime.now().toISOString(),
  ): void {
    if (game.session.status !== "in_progress") {
      return;
    }
    game.session.status = "finished";
    game.session.endedAt = endedAt;
    game.session.state.phase = "finished";
    game.cycleTimer?.cancel();
    game.gameDurationTimer?.cancel();
    game.gameDurationTimer = undefined;
    game.revealTimer?.cancel();
    game.revealActive = false;
    for (const request of [...game.pendingCatchRequests.values()]) {
      this.finishPendingCatch(game, request, "cancelled");
    }
    game.locations.clear();
    game.proximityPairs.clear();
    const publicRoom = this.rooms.finishGame(
      game.roomCode,
      game.session.id,
    );
    const winnerIds = [...game.teams.entries()]
      .filter(([, team]) => team === winningTeam)
      .map(([playerId]) => playerId);
    this.events.roomUpdated(publicRoom ?? this.rooms.getPublicRoom(game.roomCode)!);
    const ended: GameEndedPayload = {
      result: {
        gameId: game.session.id,
        roomCode: game.roomCode,
        gameMode: "manhunt",
        outcome: "win",
        winnerPlayerIds: winnerIds,
        endedAt: game.session.endedAt,
      },
    };
    game.result = ended;
    this.events.gameEnded(game.roomCode, ended);
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

  private deactivatePlayer(game: ManhuntRecord, playerId: PlayerId): void {
    game.locations.delete(playerId);
    this.clearProximityForPlayer(game, playerId);
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

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
