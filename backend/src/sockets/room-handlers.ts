import {
  CLOCK_EVENTS,
  CONNECTION_EVENTS,
  ERROR_EVENTS,
  GAME_EVENTS,
  IMPOSTOR_EVENTS,
  MAX_PLAYER_ID_LENGTH,
  ROOM_EVENTS,
  WORD_IMPOSTOR_EVENTS,
  MANHUNT_EVENTS,
  manhuntUpdateSettingsSchema,
  locationUpdateSchema,
  manhuntReadySchema,
  catchAttemptSchema,
  freezePlayerSchema,
  freezeDecoyRequestSchema,
  footstepsRequestSchema,
  smokeBombRequestSchema,
  ghostRequestSchema,
  catchConfirmationResponseSchema,
  clockSyncSchema,
  manhuntCountdownSyncSchema,
  createRoomSchema,
  joinRoomSchema,
  leaveRoomSchema,
  roomCodeSchema,
  returnToLobbySchema,
  roleRequestSchema,
  startGameSchema,
  updateRoomSettingsSchema,
  voteSubmissionSchema,
  wordImpostorRoleRequestSchema,
  wordImpostorVoteSubmissionSchema,
} from "@impostor/api";
import type {
  ClockSyncResponsePayload,
  CreateRoomResponse,
  GameSessionId,
  JoinRoomResponse,
  PlayerJoinedPayload,
  PlayerId,
  PlayerLeftPayload,
  PlayerReconnectedPayload,
  ReconnectPayload,
  RoomCode,
  ManhuntBoundary,
  Room,
  RoomUpdatePayload,
  ServerErrorPayload,
  ValidationErrorPayload,
  ValidationIssue,
} from "@impostor/api";
import { ClassicImpostorService } from "../games/imposter/classic-game-service.js";
import { WordImpostorService } from "../games/imposter/word-game-service.js";
import { ManhuntGameService } from "../manhunt/manhunt-game-service.js";
import { InMemoryRateLimiter } from "../services/rate-limiter.js";
import type { RoomPersistenceCommands } from "../rooms/room-persistence-commands.js";
import { DurableRoomTimeoutScheduler } from "../rooms/durable-room-timeout-scheduler.js";
import {
  isRuntimeGuardedRoomPersistenceCommands,
} from "../rooms/durable-room-runtime.js";
import type {
  DurableTimeoutSchedulerDiagnostics,
} from "../rooms/durable-room-timeout-scheduler.js";
import { fenceDurableGameRoom } from "../rooms/persist-game-status-transition.js";
import { RoomService } from "../rooms/room-service.js";
import type { RoomGameStatusReservation } from "../rooms/room-service.js";
import { AppError } from "../utils/app-error.js";
import { getClientIp } from "../utils/client-ip.js";
import type { ClientIpMode } from "../utils/client-ip.js";
import type {
  GameSocket,
  GameSocketServer,
  SocketAck,
  SocketAcknowledgement,
} from "./socket-types.js";

const RATE_LIMIT_WINDOW_MS = 60_000;
const SOCKET_CONNECTION_LIMIT = 60;
const ROOM_CREATION_LIMIT = 5;
const ROOM_JOIN_LIMIT = 12;
const RECONNECT_LIMIT = 10;
const CLOCK_SYNC_LIMIT = 12;
const WORD_ROLE_REQUEST_LIMIT = 20;
const WORD_VOTE_LIMIT = 20;
const MANHUNT_LOCATION_LIMIT = 12;
const MANHUNT_CATCH_LIMIT = 20;
const MANHUNT_CATCH_RESPONSE_LIMIT = 12;
const MANHUNT_COUNTDOWN_SYNC_LIMIT = 12;

interface SocketHandlerOptions {
  reconnectGracePeriodMs: number;
  nodeEnv: "development" | "test" | "production";
  clientIpMode: ClientIpMode;
  trustProxyHops: number;
  roomPersistenceCommands?: RoomPersistenceCommands;
  isServingReady?: () => boolean;
}

interface ReconnectParseResult {
  success: true;
  payload: ReconnectPayload;
}

interface ReconnectParseFailure {
  success: false;
  issues: ValidationIssue[];
}

type ReconnectPayloadResult = ReconnectParseResult | ReconnectParseFailure;

export function attachRoomSocketHandlers(
  io: GameSocketServer,
  rooms: RoomService,
  classicGames: ClassicImpostorService,
  wordGames: WordImpostorService,
  manhuntGames: ManhuntGameService,
  options: SocketHandlerOptions,
): {
  close: () => void;
  getDiagnostics: () => DurableTimeoutSchedulerDiagnostics;
} {
  const rateLimiter = new InMemoryRateLimiter();
  const disconnectTimers = new Map<string, NodeJS.Timeout>();
  let isClosing = false;
  const isServingReady = () =>
    options.isServingReady?.() ?? true;
  const includeErrorDetails = options.nodeEnv !== "production";
  const reportSocketError = <T>(
    socket: GameSocket,
    acknowledgement: SocketAck<T> | undefined,
    error: unknown,
  ) => reportError(socket, acknowledgement, error, includeErrorDetails);
  const persistenceCommands = options.roomPersistenceCommands;
  if (
    persistenceCommands
    && !isRuntimeGuardedRoomPersistenceCommands(persistenceCommands)
  ) {
    throw new TypeError(
      "Socket handlers require runtime-gated durable room commands.",
    );
  }
  const persistedTimeoutScheduler = persistenceCommands
    ? new DurableRoomTimeoutScheduler({
      scheduleTimeout: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        timer.unref();
        return () => clearTimeout(timer);
      },
      now: () => new Date(),
      isServingReady: () => !isClosing,
      claimTimeoutOwnership: (roomCode, playerId, owner) =>
        rooms.claimDisconnectTimeout(roomCode, playerId, owner),
      releaseTimeoutOwnership: (roomCode, playerId, owner) =>
        rooms.releaseDisconnectTimeout(roomCode, playerId, owner),
      removeDisconnectedPlayer: (timeout, now) =>
        persistenceCommands.removeDisconnectedPlayer(
          timeout.roomCode,
          timeout.playerId,
          timeout.disconnectGeneration,
          timeout.reconnectDeadlineAt,
          now,
        ),
      onRemoval: async (removal) => {
        await classicGames.onPlayerRemoved(
          removal.roomCode,
          removal.room !== undefined,
        );
        await wordGames.onPlayerRemoved(
          removal.roomCode,
          removal.room !== undefined,
        );
        await manhuntGames.onPlayerRemoved(
          removal.roomCode,
          removal.room !== undefined,
        );
        publishPlayerLeft(io, removal);
      },
      reportFailure: (error, context) => {
        if (context.phase === "side_effect") {
          const suspensionScope =
            context.removal?.suspensionScope
            ?? rooms.getGameplaySuspensionScope(context.roomCode, null);
          if (suspensionScope) {
            rooms.suspendGameplay(
              context.roomCode,
              suspensionScope,
              "durable_timeout_post_commit_side_effect_failure",
            );
          } else {
            logInternalError(
              "Could not suspend a room after committed timeout side effects failed because its identity was unavailable.",
              new Error("Committed timeout removal did not retain room identity."),
              includeErrorDetails,
            );
          }
        }
        try {
          persistenceCommands.fenceRoom(context.roomCode);
        } catch (fenceError) {
          logInternalError(
            "Could not fence a failed reconnect-timeout removal.",
            fenceError,
            includeErrorDetails,
          );
        }
        logInternalError(
          context.phase === "side_effect"
            ? "Reconnect-timeout persistence committed, but its side effects failed; the result remains retained."
            : context.phase === "persistence"
              ? "Reconnect-timeout persistence failed; the operation remains retained for reconciliation."
              : "Could not schedule or validate a reconnect timeout; the result remains retained.",
          error,
          includeErrorDetails,
        );
      },
    })
    : undefined;
  const removeExpiredRoomListener = rooms.onExpiredRoom(async (expired) => {
    for (const playerId of expired.playerIds) {
      clearDisconnectTimer(makeTimerKey(expired.roomCode, playerId));
      persistedTimeoutScheduler?.cancelPlayer(expired.roomCode, playerId);
    }
    for (const socketId of expired.socketIds) {
      const socket = io.sockets.sockets.get(socketId);
      if (!socket) {
        continue;
      }
      await socket.leave(expired.roomCode);
      if (socket.data.roomCode === expired.roomCode) {
        socket.data.roomCode = undefined;
        socket.data.playerId = undefined;
      }
    }
  });

  const onConnection = (socket: GameSocket) => {
    if (isClosing || !isServingReady()) {
      socket.disconnect(true);
      return;
    }

    socket.use((_packet, next) => {
      if (isClosing || !isServingReady()) {
        socket.disconnect(true);
        next(new Error("Backend is not accepting gameplay traffic."));
        return;
      }
      next();
    });

    const address = getClientAddress(socket, options);
    if (!address) {
      socket.disconnect(true);
      return;
    }
    if (
      !rateLimiter.consume(
        `socket-connection:${address}`,
        SOCKET_CONNECTION_LIMIT,
        RATE_LIMIT_WINDOW_MS,
      )
    ) {
      socket.disconnect(true);
      return;
    }

    socket.on(ROOM_EVENTS.CREATE, (payload, acknowledgement) => {
      void handleCreateRoom(socket, payload, acknowledgement);
    });

    socket.on(ROOM_EVENTS.JOIN, (payload, acknowledgement) => {
      void handleJoinRoom(socket, payload, acknowledgement);
    });

    socket.on(ROOM_EVENTS.LEAVE, (payload, acknowledgement) => {
      void handleLeaveRoom(socket, payload, acknowledgement);
    });

    socket.on(ROOM_EVENTS.UPDATE_SETTINGS, (payload, acknowledgement) => {
      void handleUpdateRoomSettings(socket, payload, acknowledgement);
    });

    socket.on(ROOM_EVENTS.RETURN_TO_LOBBY, (payload, acknowledgement) => {
      handleReturnToLobby(socket, payload, acknowledgement);
    });

    socket.on(GAME_EVENTS.START_GAME, (payload, acknowledgement) => {
      void handleStartGame(socket, payload, acknowledgement);
    });

    socket.on(CLOCK_EVENTS.SYNC, (payload, acknowledgement) => {
      handleClockSync(socket, payload, acknowledgement);
    });

    socket.on(IMPOSTOR_EVENTS.ROLE_REQUEST, (payload) => {
      handleRoleRequest(socket, payload);
    });

    socket.on(IMPOSTOR_EVENTS.VOTE_SUBMISSION, (payload) => {
      handleVoteSubmission(socket, payload);
    });

    socket.on(WORD_IMPOSTOR_EVENTS.ROLE_REQUEST, (payload) => {
      handleWordRoleRequest(socket, payload);
    });

    socket.on(WORD_IMPOSTOR_EVENTS.VOTE_SUBMISSION, (payload) => {
      handleWordVoteSubmission(socket, payload);
    });

    socket.on(MANHUNT_EVENTS.UPDATE_SETTINGS, (payload, acknowledgement) => {
      handleManhuntSettings(socket, payload, acknowledgement);
    });

    socket.on(MANHUNT_EVENTS.LOCATION_UPDATE, (payload, acknowledgement) => {
      handleManhuntLocation(socket, payload, acknowledgement);
    });

    socket.on(MANHUNT_EVENTS.FREEZE, (payload, acknowledgement) => {
      handleManhuntFreeze(socket, payload, acknowledgement);
    });

    socket.on(MANHUNT_EVENTS.FOOTSTEPS, (payload, acknowledgement) => {
      handleManhuntFootsteps(socket, payload, acknowledgement);
    });

    socket.on(MANHUNT_EVENTS.SMOKE_BOMB, (payload, acknowledgement) => {
      handleManhuntSmokeBomb(socket, payload, acknowledgement);
    });

    socket.on(MANHUNT_EVENTS.GHOST, (payload, acknowledgement) => {
      handleManhuntGhost(socket, payload, acknowledgement);
    });

    socket.on(MANHUNT_EVENTS.FREEZE_DECOY, (payload, acknowledgement) => {
      handleManhuntFreezeDecoy(socket, payload, acknowledgement);
    });

    socket.on(MANHUNT_EVENTS.READY_UPDATE, (payload) => {
      handleManhuntReady(socket, payload);
    });

    socket.on(MANHUNT_EVENTS.CATCH, (payload) => {
      handleManhuntCatch(socket, payload);
    });

    socket.on(
      MANHUNT_EVENTS.CATCH_CONFIRMATION_RESPONSE,
      (payload, acknowledgement) => {
        handleManhuntCatchConfirmationResponse(
          socket,
          payload,
          acknowledgement,
        );
      },
    );

    socket.on(MANHUNT_EVENTS.COUNTDOWN_SYNC, (payload, acknowledgement) => {
      handleManhuntCountdownSync(socket, payload, acknowledgement);
    });

    socket.on(CONNECTION_EVENTS.RECONNECT, (payload, acknowledgement) => {
      void handleReconnect(socket, payload, acknowledgement);
    });

    socket.on(CONNECTION_EVENTS.DISCONNECT, () => {
      if (isClosing) {
        return;
      }

      if (options.roomPersistenceCommands) {
        void handlePersistedDisconnect(socket.id);
        return;
      }

      const disconnected = rooms.disconnectSocket(socket.id);
      if (!disconnected) {
        return;
      }

      classicGames.onPlayerConnectionChanged(disconnected.roomCode);
      wordGames.onPlayerConnectionChanged(disconnected.roomCode);
      manhuntGames.onPlayerDisconnected(
        disconnected.roomCode,
        disconnected.playerId,
      );
      io.to(disconnected.roomCode).emit(ROOM_EVENTS.UPDATE, {
        room: disconnected.room,
      });

      const timerKey = makeTimerKey(
        disconnected.roomCode,
        disconnected.playerId,
      );
      clearDisconnectTimer(timerKey);
      const timer = setTimeout(() => {
        disconnectTimers.delete(timerKey);
        const removal = rooms.removeDisconnectedPlayer(
          disconnected.roomCode,
          disconnected.playerId,
        );
        if (removal) {
          void Promise.resolve()
            .then(async () => {
              await classicGames.onPlayerRemoved(
                removal.roomCode,
                removal.room !== undefined,
              );
              await wordGames.onPlayerRemoved(
                removal.roomCode,
                removal.room !== undefined,
              );
              await manhuntGames.onPlayerRemoved(
                removal.roomCode,
                removal.room !== undefined,
              );
            })
            .then(() => publishPlayerLeft(io, removal))
            .catch((error: unknown) => {
              logInternalError(
                "Could not finish removing a disconnected room member.",
                error,
                includeErrorDetails,
              );
            });
        }
      }, options.reconnectGracePeriodMs);
      timer.unref();
      disconnectTimers.set(timerKey, timer);
    });
  };
  if (persistedTimeoutScheduler) {
    try {
      for (const timeout of rooms.listDisconnectedPlayerTimeouts()) {
        persistedTimeoutScheduler.schedule(timeout);
      }
    } catch (error) {
      persistedTimeoutScheduler.cancelAll();
      removeExpiredRoomListener();
      throw error;
    }
  }
  io.on("connection", onConnection);

  return {
    close: () => {
      if (isClosing) {
        return;
      }
      isClosing = true;
      io.off("connection", onConnection);
      removeExpiredRoomListener();
      for (const timer of disconnectTimers.values()) {
        clearTimeout(timer);
      }
      disconnectTimers.clear();
      persistedTimeoutScheduler?.cancelAll();
    },
    getDiagnostics: () =>
      persistedTimeoutScheduler?.getDiagnostics() ?? {
        scheduledTimeouts: 0,
        pendingPostCommitSideEffects: 0,
      },
  };

  async function handleCreateRoom(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<CreateRoomResponse> | undefined,
  ): Promise<void> {
    if (
      !allowAttempt(
        socket,
        "create",
        ROOM_CREATION_LIMIT,
        rateLimiter,
        acknowledgement,
        includeErrorDetails,
      )
    ) {
      return;
    }

    const parsed = createRoomSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }

    let response: CreateRoomResponse | undefined;
    try {
      response = options.roomPersistenceCommands
        ? await options.roomPersistenceCommands.createRoom(parsed.data, socket.id)
        : rooms.createRoom(parsed.data, socket.id);
      await socket.join(response.room.code);
      socket.data.playerId = response.playerId;
      socket.data.roomCode = response.room.code;
      if (response.room.settings.gameMode === "manhunt") {
        emitManhuntBoundaryToSocket(
          socket,
          rooms,
          manhuntGames,
          response.room.code,
        );
      }
      acknowledgeSuccess(acknowledgement, response);
      publishRoomUpdate(io, response.room);
    } catch (error) {
      if (response) {
        if (options.roomPersistenceCommands) {
          try {
            options.roomPersistenceCommands.fenceRoom(response.room.code);
          } catch (fenceError) {
            logInternalError(
              "Could not fence room after failed socket setup.",
              fenceError,
              includeErrorDetails,
            );
          }
        } else {
          try {
            rooms.leaveRoom(response.room.code, socket.id);
          } catch (rollbackError) {
            logInternalError(
              "Could not roll back failed room creation.",
              rollbackError,
              includeErrorDetails,
            );
          }
        }
      }
      reportSocketError(socket, acknowledgement, error);
    }
  }

  async function handleJoinRoom(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<JoinRoomResponse> | undefined,
  ): Promise<void> {
    if (
      !allowAttempt(
        socket,
        "join",
        ROOM_JOIN_LIMIT,
        rateLimiter,
        acknowledgement,
        includeErrorDetails,
      )
    ) {
      return;
    }

    const parsed = joinRoomSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }

    let response: JoinRoomResponse | undefined;
    try {
      response = options.roomPersistenceCommands
        ? await options.roomPersistenceCommands.joinRoom(parsed.data, socket.id)
        : rooms.joinRoom(parsed.data, socket.id);
      await socket.join(response.room.code);
      socket.data.playerId = response.playerId;
      socket.data.roomCode = response.room.code;

      const player = response.room.players.find(
        (roomPlayer) => roomPlayer.id === response?.playerId,
      );
      if (!player) {
        throw new Error("Joined player was missing from the room snapshot.");
      }
      if (response.room.settings.gameMode === "manhunt") {
        emitManhuntBoundaryToSocket(
          socket,
          rooms,
          manhuntGames,
          response.room.code,
        );
      }

      const joinedPayload: PlayerJoinedPayload = {
        roomCode: response.room.code,
        player,
      };
      acknowledgeSuccess(acknowledgement, response);
      io.to(response.room.code).emit(ROOM_EVENTS.PLAYER_JOINED, joinedPayload);
      publishRoomUpdate(io, response.room);
    } catch (error) {
      if (response) {
        if (options.roomPersistenceCommands) {
          try {
            options.roomPersistenceCommands.fenceRoom(response.room.code);
          } catch (fenceError) {
            logInternalError(
              "Could not fence room after failed socket setup.",
              fenceError,
              includeErrorDetails,
            );
          }
        } else {
          try {
            rooms.leaveRoom(response.room.code, socket.id);
          } catch (rollbackError) {
            logInternalError(
              "Could not roll back failed room join.",
              rollbackError,
              includeErrorDetails,
            );
          }
        }
      }
      reportSocketError(socket, acknowledgement, error);
    }
  }

  async function handleLeaveRoom(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<void> | undefined,
  ): Promise<void> {
    const parsed = leaveRoomSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }

    try {
      const removal = options.roomPersistenceCommands
        ? await options.roomPersistenceCommands.leaveRoom(
            parsed.data.roomCode,
            socket.id,
          )
        : rooms.leaveRoom(parsed.data.roomCode, socket.id);
      clearDisconnectTimer(makeTimerKey(removal.roomCode, removal.playerId));
      persistedTimeoutScheduler?.cancelPlayer(removal.roomCode, removal.playerId);
      await socket.leave(removal.roomCode);
      socket.data.playerId = undefined;
      socket.data.roomCode = undefined;
      try {
        await classicGames.onPlayerRemoved(
          removal.roomCode,
          removal.room !== undefined,
        );
        await wordGames.onPlayerRemoved(
          removal.roomCode,
          removal.room !== undefined,
        );
        await manhuntGames.onPlayerRemoved(
          removal.roomCode,
          removal.room !== undefined,
        );
      } catch (error) {
        logInternalError(
          "The leave committed, but game completion or countdown cancellation did not complete.",
          error,
          includeErrorDetails,
        );
      }
      acknowledgeSuccess(acknowledgement, undefined);
      publishPlayerLeft(io, removal);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  async function handleUpdateRoomSettings(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<RoomUpdatePayload> | undefined,
  ): Promise<void> {
    const parsed = updateRoomSettingsSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }

    try {
      const room = options.roomPersistenceCommands
        ? await options.roomPersistenceCommands.updateRoomSettings(
            parsed.data,
            socket.id,
          )
        : rooms.updateRoomSettings(parsed.data, socket.id);
      if (parsed.data.settings.gameMode === "manhunt") {
        emitManhuntBoundaryToSocket(socket, rooms, manhuntGames, room.code);
      }
      const response: RoomUpdatePayload = { room };
      acknowledgeSuccess(acknowledgement, response);
      publishRoomUpdate(io, room);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  async function handleReturnToLobby(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<RoomUpdatePayload> | undefined,
  ): Promise<void> {
    const parsed = returnToLobbySchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }

    try {
      const currentRoom = rooms.getPublicRoom(parsed.data.roomCode);
      if (!currentRoom) {
        throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
      }

      let room: Room;
      if (currentRoom.settings.gameMode === "impostor-classic") {
        room = options.roomPersistenceCommands
          ? await classicGames.returnToLobbyPersisted(
              parsed.data.roomCode,
              socket.id,
            )
          : classicGames.returnToLobby(parsed.data.roomCode, socket.id);
      } else if (currentRoom.settings.gameMode === "impostor-word") {
        room = options.roomPersistenceCommands
          ? await wordGames.returnToLobbyPersisted(
              parsed.data.roomCode,
              socket.id,
            )
          : wordGames.returnToLobby(parsed.data.roomCode, socket.id);
      } else if (currentRoom.settings.gameMode === "manhunt") {
        room = await manhuntGames.returnToLobby(parsed.data.roomCode, socket.id);
      } else {
        throw new AppError(
          "GAME_NOT_READY",
          "This room cannot return to the lobby.",
        );
      }
      const response: RoomUpdatePayload = { room };
      acknowledgeSuccess(acknowledgement, response);
      publishRoomUpdate(io, room);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  async function handleStartGame(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<void> | undefined,
  ): Promise<void> {
    const parsed = startGameSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }

    if (!options.roomPersistenceCommands) {
      try {
        const room = rooms.getPublicRoom(parsed.data.roomCode);
        if (room?.settings.gameMode === "impostor-word") {
          wordGames.startGame(parsed.data.roomCode, socket.id);
        } else if (room?.settings.gameMode === "manhunt") {
          manhuntGames.startGame(parsed.data.roomCode, socket.id);
        } else {
          classicGames.startGame(parsed.data.roomCode, socket.id);
        }
        acknowledgeSuccess(acknowledgement, undefined);
      } catch (error) {
        reportSocketError(socket, acknowledgement, error);
      }
      return;
    }

    let reservation: RoomGameStatusReservation | undefined;
    let discardPreparedStart: (() => void) | undefined;
    try {
      reservation =
        await options.roomPersistenceCommands.acquireGameStatusReservation(
          parsed.data.roomCode,
          "waiting",
          null,
          socket.id,
        );
      const room = rooms.getPublicRoom(parsed.data.roomCode);
      if (!room) {
        throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
      }

      let preparedGameId: GameSessionId;
      let commitPreparedStart: (() => void) | undefined;
      if (room.settings.gameMode === "impostor-word") {
        const prepared = wordGames.prepareStart(
          parsed.data.roomCode,
          socket.id,
        );
        preparedGameId = prepared.gameId;
        discardPreparedStart = () => wordGames.discardPreparedStart(prepared);
        commitPreparedStart = () => {
          wordGames.commitPreparedStart(prepared, reservation);
        };
      } else if (room.settings.gameMode === "manhunt") {
        const prepared = manhuntGames.prepareStart(
          parsed.data.roomCode,
          socket.id,
        );
        preparedGameId = prepared.gameId;
        discardPreparedStart = () => manhuntGames.discardPreparedStart(prepared);
        commitPreparedStart = () => {
          manhuntGames.commitPreparedStart(prepared, reservation);
        };
      } else {
        const prepared = classicGames.prepareStart(
          parsed.data.roomCode,
          socket.id,
        );
        preparedGameId = prepared.gameId;
        discardPreparedStart = () => classicGames.discardPreparedStart(prepared);
        commitPreparedStart = () => {
          classicGames.commitPreparedStart(prepared, reservation);
        };
      }

      const hostPlayerId = reservation.hostPlayerId;
      if (!hostPlayerId) {
        throw new AppError(
          "NOT_AUTHORIZED",
          "A host identity is required to start a durable game.",
        );
      }

      try {
        await options.roomPersistenceCommands.transitionRoomGameStatus({
          roomCode: parsed.data.roomCode,
          expectedStatus: "waiting",
          nextStatus: "starting",
          expectedCurrentGameId: null,
          nextGameId: preparedGameId,
          initiatedBy: { kind: "host", playerId: hostPlayerId },
          reservation,
        });
      } catch (error) {
        fenceDurableGameRoom(
          rooms,
          options.roomPersistenceCommands,
          parsed.data.roomCode,
        );
        throw error;
      }

      try {
        commitPreparedStart();
      } catch (error) {
        fenceDurableGameRoom(
          rooms,
          options.roomPersistenceCommands,
          parsed.data.roomCode,
        );
        console.error(
          JSON.stringify({
            level: "error",
            event: "durable_game_start_commit_failed",
            roomCode: parsed.data.roomCode,
            gameId: preparedGameId,
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
        throw new AppError(
          "UNKNOWN",
          "The durable game start committed but live state could not be synchronized safely.",
        );
      }

      acknowledgeSuccess(acknowledgement, undefined);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    } finally {
      discardPreparedStart?.();
      if (reservation) {
        rooms.releaseGameStatusReservation(reservation);
      }
    }
  }

  function handleRoleRequest(socket: GameSocket, payload: unknown): void {
    const parsed = roleRequestSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, undefined, parsed.error.issues);
      return;
    }

    try {
      const playerId = rooms.getPlayerIdForSocket(
        parsed.data.roomCode,
        socket.id,
      );
      const role = classicGames.requestRole(
        parsed.data.roomCode,
        parsed.data.sessionId,
        playerId,
      );
      socket.emit(IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, role);
    } catch (error) {
      reportSocketError(socket, undefined, error);
    }
  }

  function handleVoteSubmission(socket: GameSocket, payload: unknown): void {
    const parsed = voteSubmissionSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, undefined, parsed.error.issues);
      return;
    }

    try {
      const voterId = rooms.getPlayerIdForSocket(
        parsed.data.roomCode,
        socket.id,
      );
      classicGames.submitVote(
        parsed.data.roomCode,
        voterId,
        parsed.data.targetPlayerId,
        parsed.data.sessionId,
        parsed.data.votingEndsAt,
        parsed.data.votingPhaseId,
      );
    } catch (error) {
      reportSocketError(socket, undefined, error);
    }
  }

  function handleWordRoleRequest(socket: GameSocket, payload: unknown): void {
    if (
      !allowPlayerAction(
        socket,
        "word-role",
        WORD_ROLE_REQUEST_LIMIT,
        rateLimiter,
        includeErrorDetails,
      )
    ) {
      return;
    }

    const parsed = wordImpostorRoleRequestSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, undefined, parsed.error.issues);
      return;
    }

    try {
      const playerId = rooms.getPlayerIdForSocket(
        parsed.data.roomCode,
        socket.id,
      );
      const role = wordGames.requestRole(
        parsed.data.roomCode,
        parsed.data.sessionId,
        playerId,
      );
      socket.emit(WORD_IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, role);
    } catch (error) {
      reportSocketError(socket, undefined, error);
    }
  }

  function handleWordVoteSubmission(socket: GameSocket, payload: unknown): void {
    if (
      !allowPlayerAction(
        socket,
        "word-vote",
        WORD_VOTE_LIMIT,
        rateLimiter,
        includeErrorDetails,
      )
    ) {
      return;
    }

    const parsed = wordImpostorVoteSubmissionSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, undefined, parsed.error.issues);
      return;
    }

    try {
      const voterId = rooms.getPlayerIdForSocket(
        parsed.data.roomCode,
        socket.id,
      );
      wordGames.submitVote(
        parsed.data.roomCode,
        voterId,
        parsed.data.targetPlayerId,
        parsed.data.sessionId,
        parsed.data.votingEndsAt,
        parsed.data.votingPhaseId,
      );
    } catch (error) {
      reportSocketError(socket, undefined, error);
    }
  }

  async function handleManhuntSettings(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<RoomUpdatePayload> | undefined,
  ): Promise<void> {
    const parsed = manhuntUpdateSettingsSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }
    try {
      if (options.roomPersistenceCommands) {
        const room = await options.roomPersistenceCommands.updateManhuntSettings(
          parsed.data.roomCode,
          socket.id,
          parsed.data.settings,
        );
        manhuntGames.publishSettingsUpdated(
          parsed.data.roomCode,
          parsed.data.settings,
          room,
        );
        acknowledgeSuccess(acknowledgement, { room });
      } else {
        manhuntGames.updateSettings(
          parsed.data.roomCode,
          socket.id,
          parsed.data.settings,
        );
        const room = rooms.getPublicRoom(parsed.data.roomCode);
        if (room) {
          acknowledgeSuccess(acknowledgement, { room });
        }
      }
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  function handleManhuntLocation(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<import("@impostor/api").ManhuntLocationAcknowledgementPayload> | undefined,
  ): void {
    if (
      !allowPlayerAction(
        socket,
        "manhunt-location",
        MANHUNT_LOCATION_LIMIT,
        rateLimiter,
        includeErrorDetails,
        acknowledgement,
      )
    ) {
      return;
    }
    const parsed = locationUpdateSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }
    try {
      const result = manhuntGames.recordLocation(
        parsed.data.roomCode,
        socket.id,
        parsed.data.coordinates,
        parsed.data.accuracyMeters,
        parsed.data.clientTimestamp,
      );
      acknowledgeSuccess(acknowledgement, result);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  function handleManhuntFreeze(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<void> | undefined,
  ): void {
    const parsed = freezePlayerSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }
    try {
      manhuntGames.activateFreeze(
        parsed.data.roomCode,
        socket.id,
        parsed.data.sessionId,
        parsed.data.requestId,
      );
      acknowledgeSuccess(acknowledgement, undefined);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  function handleManhuntFootsteps(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<void> | undefined,
  ): void {
    const parsed = footstepsRequestSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }
    try {
      manhuntGames.activateFootsteps(
        parsed.data.roomCode,
        socket.id,
        parsed.data.sessionId,
        parsed.data.requestId,
      );
      acknowledgeSuccess(acknowledgement, undefined);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  function handleManhuntSmokeBomb(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<void> | undefined,
  ): void {
    const parsed = smokeBombRequestSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }
    try {
      manhuntGames.activateSmokeBomb(
        parsed.data.roomCode,
        socket.id,
        parsed.data.sessionId,
        parsed.data.requestId,
      );
      acknowledgeSuccess(acknowledgement, undefined);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  function handleManhuntGhost(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<void> | undefined,
  ): void {
    const parsed = ghostRequestSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }
    try {
      manhuntGames.activateGhost(
        parsed.data.roomCode,
        socket.id,
        parsed.data.sessionId,
        parsed.data.requestId,
      );
      acknowledgeSuccess(acknowledgement, undefined);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  function handleManhuntFreezeDecoy(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<void> | undefined,
  ): void {
    const parsed = freezeDecoyRequestSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }
    try {
      manhuntGames.activateFreezeDecoy(
        parsed.data.roomCode,
        socket.id,
        parsed.data.sessionId,
        parsed.data.requestId,
      );
      acknowledgeSuccess(acknowledgement, undefined);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  function handleManhuntReady(socket: GameSocket, payload: unknown): void {
    const parsed = manhuntReadySchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, undefined, parsed.error.issues);
      return;
    }
    try {
      manhuntGames.setReady(
        parsed.data.roomCode,
        socket.id,
        parsed.data.ready,
      );
    } catch (error) {
      reportSocketError(socket, undefined, error);
    }
  }

  function handleManhuntCatch(socket: GameSocket, payload: unknown): void {
    if (
      !allowPlayerAction(
        socket,
        "manhunt-catch",
        MANHUNT_CATCH_LIMIT,
        rateLimiter,
        includeErrorDetails,
      )
    ) {
      return;
    }
    const parsed = catchAttemptSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, undefined, parsed.error.issues);
      return;
    }
    try {
      manhuntGames.attemptCatch(
        parsed.data.roomCode,
        socket.id,
        parsed.data.targetPlayerId,
      );
    } catch (error) {
      reportSocketError(socket, undefined, error);
    }
  }

  function handleManhuntCatchConfirmationResponse(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<void> | undefined,
  ): void {
    if (
      !allowPlayerAction(
        socket,
        "manhunt-catch-response",
        MANHUNT_CATCH_RESPONSE_LIMIT,
        rateLimiter,
        includeErrorDetails,
        acknowledgement,
      )
    ) {
      return;
    }
    const parsed = catchConfirmationResponseSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }
    try {
      manhuntGames.respondToCatch(
        parsed.data.roomCode,
        socket.id,
        parsed.data.requestId,
        parsed.data.accepted,
      );
      acknowledgeSuccess(acknowledgement, undefined);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  function handleManhuntCountdownSync(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<
      import("@impostor/api").CountdownSyncResponsePayload
    > | undefined,
  ): void {
    if (
      !allowPlayerAction(
        socket,
        "manhunt-countdown-sync",
        MANHUNT_COUNTDOWN_SYNC_LIMIT,
        rateLimiter,
        includeErrorDetails,
        acknowledgement,
      )
    ) {
      return;
    }
    const parsed = manhuntCountdownSyncSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }
    try {
      const result = manhuntGames.getCountdownSync(
        parsed.data.roomCode,
        socket.id,
        parsed.data.sessionId,
      );
      acknowledgeSuccess(acknowledgement, result);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  function handleClockSync(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<ClockSyncResponsePayload> | undefined,
  ): void {
    if (
      !allowPlayerAction(
        socket,
        "clock-sync",
        CLOCK_SYNC_LIMIT,
        rateLimiter,
        includeErrorDetails,
        acknowledgement,
      )
    ) {
      return;
    }

    const parsed = clockSyncSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }

    acknowledgeSuccess(acknowledgement, {
      requestId: parsed.data.requestId,
      serverTime: new Date().toISOString(),
    });
  }

  async function handleReconnect(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<PlayerReconnectedPayload> | undefined,
  ): Promise<void> {
    if (
      !allowAttempt(
        socket,
        "reconnect",
        RECONNECT_LIMIT,
        rateLimiter,
        acknowledgement,
        includeErrorDetails,
      )
    ) {
      return;
    }

    const parsed = parseReconnectPayload(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.issues);
      return;
    }

    try {
      const result = options.roomPersistenceCommands
        ? await options.roomPersistenceCommands.reconnect(
            parsed.payload,
            socket.id,
          )
        : rooms.reconnect(parsed.payload, socket.id);
      clearDisconnectTimer(
        makeTimerKey(result.payload.roomCode, result.payload.player.id),
      );
      persistedTimeoutScheduler?.cancelPlayer(
        result.payload.roomCode,
        result.payload.player.id,
      );

      if (result.previousSocketId) {
        io.sockets.sockets.get(result.previousSocketId)?.disconnect(true);
      }

      await socket.join(result.payload.roomCode);
      socket.data.playerId = result.payload.player.id;
      socket.data.roomCode = result.payload.roomCode;
      if (result.room.settings.gameMode === "manhunt") {
        emitManhuntBoundaryToSocket(
          socket,
          rooms,
          manhuntGames,
          result.payload.roomCode,
        );
      }
      acknowledgeSuccess(acknowledgement, result.payload);
      io
        .to(result.payload.roomCode)
        .emit(CONNECTION_EVENTS.PLAYER_RECONNECTED, result.payload);
      publishRoomUpdate(io, result.room);
      classicGames.onPlayerConnectionChanged(result.payload.roomCode);
      wordGames.onPlayerConnectionChanged(result.payload.roomCode);
      const classicSnapshot = classicGames.getResumeSnapshot(
        result.payload.roomCode,
        result.payload.player.id,
      );
      const wordSnapshot = wordGames.getResumeSnapshot(
        result.payload.roomCode,
        result.payload.player.id,
      );
      const manhuntSnapshot = manhuntGames.getResumeSnapshot(
        result.payload.roomCode,
        result.payload.player.id,
      );
      if (
        wordSnapshot &&
        wordSnapshot.started.session.id === result.room.currentGameId
      ) {
        socket.emit(GAME_EVENTS.GAME_STARTED, wordSnapshot.started);
        socket.emit(GAME_EVENTS.STATE_UPDATE, wordSnapshot.state);
        if (wordSnapshot.role) {
          socket.emit(WORD_IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, wordSnapshot.role);
        }
        if (wordSnapshot.ended) {
          socket.emit(GAME_EVENTS.GAME_ENDED, wordSnapshot.ended);
        }
        if (wordSnapshot.reveal) {
          socket.emit(WORD_IMPOSTOR_EVENTS.REVEAL, wordSnapshot.reveal);
        }
      } else if (
        classicSnapshot &&
        classicSnapshot.started.session.id === result.room.currentGameId
      ) {
        socket.emit(GAME_EVENTS.GAME_STARTED, classicSnapshot.started);
        socket.emit(GAME_EVENTS.STATE_UPDATE, classicSnapshot.state);
        if (classicSnapshot.role) {
          socket.emit(IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, classicSnapshot.role);
        }
        if (classicSnapshot.ended) {
          socket.emit(GAME_EVENTS.GAME_ENDED, classicSnapshot.ended);
        }
        if (classicSnapshot.reveal) {
          socket.emit(IMPOSTOR_EVENTS.REVEAL, classicSnapshot.reveal);
        }
      } else if (
        manhuntSnapshot &&
        manhuntSnapshot.started.session.id === result.room.currentGameId
      ) {
        socket.emit(GAME_EVENTS.GAME_STARTED, manhuntSnapshot.started);
        socket.emit(GAME_EVENTS.STATE_UPDATE, manhuntSnapshot.state);
        socket.emit(
          MANHUNT_EVENTS.TEAM_ASSIGNMENT,
          manhuntSnapshot.teamAssignment,
        );
        if (manhuntSnapshot.missionAssignment) {
          socket.emit(
            MANHUNT_EVENTS.MISSION_ASSIGNMENT,
            manhuntSnapshot.missionAssignment,
          );
        }
        if (manhuntSnapshot.missionReveal) {
          socket.emit(
            MANHUNT_EVENTS.MISSION_REVEAL,
            manhuntSnapshot.missionReveal,
          );
        }
        if (manhuntSnapshot.freezeWarning) {
          socket.emit(
            MANHUNT_EVENTS.FREEZE_WARNING,
            manhuntSnapshot.freezeWarning,
          );
        }
        if (manhuntSnapshot.playerFrozen) {
          socket.emit(
            MANHUNT_EVENTS.PLAYER_FROZEN,
            manhuntSnapshot.playerFrozen,
          );
        }
        if (manhuntSnapshot.footsteps) {
          socket.emit(
            MANHUNT_EVENTS.FOOTSTEPS_STATE,
            manhuntSnapshot.footsteps,
          );
        }
        if (manhuntSnapshot.smokeBomb) {
          socket.emit(
            MANHUNT_EVENTS.SMOKE_BOMB_STATE,
            manhuntSnapshot.smokeBomb,
          );
        }
        if (manhuntSnapshot.ghost) {
          socket.emit(MANHUNT_EVENTS.GHOST_STATE, manhuntSnapshot.ghost);
        }
        if (manhuntSnapshot.freezeDecoys) {
          socket.emit(
            MANHUNT_EVENTS.FREEZE_DECOY_STATE,
            manhuntSnapshot.freezeDecoys,
          );
        }
        if (manhuntSnapshot.freezeDecoyUsage) {
          socket.emit(
            MANHUNT_EVENTS.FREEZE_DECOY_USAGE_STATE,
            manhuntSnapshot.freezeDecoyUsage,
          );
        }
        if (manhuntSnapshot.lateGameClue) {
          socket.emit(
            MANHUNT_EVENTS.LATE_GAME_CLUE_STATE,
            manhuntSnapshot.lateGameClue,
          );
        }
        if (manhuntSnapshot.lateGameWarning) {
          socket.emit(
            MANHUNT_EVENTS.LATE_GAME_WARNING_STATE,
            manhuntSnapshot.lateGameWarning,
          );
        }
        if (manhuntSnapshot.countdown) {
          socket.emit(MANHUNT_EVENTS.COUNTDOWN, manhuntSnapshot.countdown);
        }
        if (manhuntSnapshot.ended) {
          socket.emit(GAME_EVENTS.GAME_ENDED, manhuntSnapshot.ended);
        }
      }
      manhuntGames.onPlayerConnected(
        result.payload.roomCode,
        result.payload.player.id,
      );
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  async function handlePersistedDisconnect(socketId: string): Promise<void> {
    const commands = options.roomPersistenceCommands;
    if (!commands) {
      return;
    }

    try {
      const disconnected = await commands.disconnectSocket(
        socketId,
        options.reconnectGracePeriodMs,
      );
      if (!disconnected) {
        return;
      }

      classicGames.onPlayerConnectionChanged(disconnected.roomCode);
      wordGames.onPlayerConnectionChanged(disconnected.roomCode);
      manhuntGames.onPlayerDisconnected(
        disconnected.roomCode,
        disconnected.playerId,
      );
      io.to(disconnected.roomCode).emit(ROOM_EVENTS.UPDATE, {
        room: disconnected.room,
      });

      if (
        disconnected.disconnectGeneration === undefined
        || disconnected.reconnectDeadlineAt === undefined
      ) {
        throw new Error("Durable disconnect result did not include timeout metadata.");
      }
      try {
        if (!persistedTimeoutScheduler) {
          throw new Error("Persisted reconnect timeout scheduler is unavailable.");
        }
        persistedTimeoutScheduler.schedule({
          roomCode: disconnected.roomCode,
          playerId: disconnected.playerId,
          disconnectGeneration: disconnected.disconnectGeneration,
          reconnectDeadlineAt: disconnected.reconnectDeadlineAt,
        });
      } catch (error) {
        try {
          commands.fenceRoom(disconnected.roomCode);
        } catch (fenceError) {
          logInternalError(
            "Could not fence a room after reconnect timeout scheduling failed.",
            fenceError,
            includeErrorDetails,
          );
        }
        throw error;
      }
    } catch (error) {
      logInternalError(
        "Could not persist the disconnected room member.",
        error,
        includeErrorDetails,
      );
    }
  }

  function clearDisconnectTimer(key: string): void {
    const timer = disconnectTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      disconnectTimers.delete(key);
    }
  }

  function allowAttempt<T>(
    socket: GameSocket,
    action: string,
    limit: number,
    limiter: InMemoryRateLimiter,
    acknowledgement: SocketAck<T> | undefined,
    includeErrorDetails: boolean,
  ): boolean {
    const address = getClientAddress(socket, options);
    if (!address) {
      socket.disconnect(true);
      return false;
    }
    if (limiter.consume(`${action}:${address}`, limit, RATE_LIMIT_WINDOW_MS)) {
      return true;
    }

    reportSocketError(
      socket,
      acknowledgement,
      new AppError("UNKNOWN", "Too many attempts. Please try again later.", 429),
    );
    return false;
  }
}

function makeTimerKey(roomCode: string, playerId: string): string {
  return `${roomCode}:${playerId}`;
}

function emitManhuntBoundaryToSocket(
  socket: GameSocket,
  rooms: RoomService,
  manhuntGames: ManhuntGameService,
  roomCode: string,
): void {
  const playerId = rooms.getPlayerIdForSocket(roomCode, socket.id);
  if (rooms.getSocketIdForPlayer(roomCode, playerId) !== socket.id) {
    throw new Error("Manhunt boundary recipient is not an active room member.");
  }
  socket.emit(MANHUNT_EVENTS.BOUNDARY_UPDATE, {
    roomCode,
    boundary: manhuntGames.getBoundaryForPlayer(roomCode, playerId) ?? null,
  });
}

function publishRoomUpdate(io: GameSocketServer, room: Room): void {
  const payload: RoomUpdatePayload = { room };
  io.to(room.code).emit(ROOM_EVENTS.UPDATE, payload);
}

function allowPlayerAction<T = unknown>(
  socket: GameSocket,
  action: string,
  limit: number,
  limiter: InMemoryRateLimiter,
  includeErrorDetails: boolean,
  acknowledgement?: SocketAck<T>,
): boolean {
  const identity =
    socket.data.playerId && socket.data.roomCode
      ? `${socket.data.roomCode}:${socket.data.playerId}`
      : socket.id;
  if (limiter.consume(`${action}:${identity}`, limit, RATE_LIMIT_WINDOW_MS)) {
    return true;
  }

  reportError(
    socket,
    acknowledgement,
    new AppError("UNKNOWN", "Too many attempts. Please try again later.", 429),
    includeErrorDetails,
  );
  return false;
}

function getClientAddress(
  socket: GameSocket,
  options: SocketHandlerOptions,
): string | undefined {
  return getClientIp(
    socket.handshake.headers,
    socket.handshake.address,
    options.clientIpMode,
    options.trustProxyHops,
  );
}

function publishPlayerLeft(
  io: GameSocketServer,
  removal: {
    roomCode: string;
    playerId: string;
    room?: Room;
  },
): void {
  if (!removal.room) {
    return;
  }

  const payload: PlayerLeftPayload = {
    roomCode: removal.roomCode,
    playerId: removal.playerId,
  };
  io.to(removal.roomCode).emit(ROOM_EVENTS.PLAYER_LEFT, payload);
  publishRoomUpdate(io, removal.room);
}

function parseReconnectPayload(payload: unknown): ReconnectPayloadResult {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {
      success: false,
      issues: [{ path: [], message: "Expected an object payload." }],
    };
  }

  const record = payload as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(record)) {
    if (
      key !== "roomCode" &&
      key !== "playerId" &&
      key !== "reconnectToken"
    ) {
      issues.push({
        path: [key],
        message: "Unknown field.",
      });
    }
  }
  const parsedRoomCode = roomCodeSchema.safeParse(record.roomCode);
  if (!parsedRoomCode.success) {
    issues.push(
      ...parsedRoomCode.error.issues.map((issue) => ({
        path: ["roomCode", ...issue.path.map(String)],
        message: issue.message,
      })),
    );
  }

  const playerId = record.playerId;
  if (
    typeof playerId !== "string" ||
    playerId.trim().length === 0 ||
    playerId.length > MAX_PLAYER_ID_LENGTH
  ) {
    issues.push({
      path: ["playerId"],
      message: `Player ID must contain 1-${MAX_PLAYER_ID_LENGTH} characters.`,
    });
  }

  const reconnectToken = record.reconnectToken;
  if (
    typeof reconnectToken !== "string" ||
    reconnectToken.length < 1 ||
    reconnectToken.length > 128
  ) {
    issues.push({
      path: ["reconnectToken"],
      message: "Reconnect token must be a non-empty string of at most 128 characters.",
    });
  }

  if (
    issues.length > 0 ||
    !parsedRoomCode.success ||
    typeof playerId !== "string" ||
    typeof reconnectToken !== "string"
  ) {
    return { success: false, issues };
  }

  return {
    success: true,
    payload: {
      roomCode: parsedRoomCode.data,
      playerId,
      reconnectToken,
    },
  };
}

function reportValidationError<T>(
  socket: GameSocket,
  acknowledgement: SocketAck<T> | undefined,
  issues: readonly { path: readonly unknown[]; message: string }[],
): void {
  const payload: ValidationErrorPayload = {
    code: "INVALID_PAYLOAD",
    message: "Request payload is invalid.",
    issues: issues.map((issue) => ({
      path: issue.path.map((part) =>
        typeof part === "string" || typeof part === "number"
          ? part
          : String(part),
      ),
      message: issue.message,
    })),
  };
  socket.emit(ERROR_EVENTS.VALIDATION_ERROR, payload);
  acknowledgeFailure(acknowledgement, payload);
}

function reportError<T>(
  socket: GameSocket,
  acknowledgement: SocketAck<T> | undefined,
  error: unknown,
  includeDetails: boolean,
): void {
  let payload: ServerErrorPayload;
  if (error instanceof AppError) {
    payload = {
      code: error.code,
      message: error.message,
    };
  } else {
    logInternalError(
      "Unexpected Socket.IO request failure.",
      error,
      includeDetails,
    );
    payload = {
      code: "UNKNOWN",
      message: "An unexpected server error occurred.",
    };
  }

  socket.emit(ERROR_EVENTS.SERVER_ERROR, payload);
  acknowledgeFailure(acknowledgement, payload);
}

function logInternalError(
  message: string,
  error: unknown,
  includeDetails: boolean,
): void {
  console.error(JSON.stringify({
    level: "error",
    message,
    ...(includeDetails
      ? {
          error:
            error instanceof Error ? error.stack ?? error.message : String(error),
        }
      : {}),
  }));
}

function acknowledgeSuccess<T>(
  acknowledgement: SocketAck<T> | undefined,
  data: T,
): void {
  acknowledgement?.({ ok: true, data });
}

function acknowledgeFailure<T>(
  acknowledgement: SocketAck<T> | undefined,
  error: ServerErrorPayload,
): void {
  const result: SocketAcknowledgement<T> = { ok: false, error };
  acknowledgement?.(result);
}
