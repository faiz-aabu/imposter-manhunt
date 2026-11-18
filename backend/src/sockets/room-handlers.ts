import {
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
  catchConfirmationResponseSchema,
  manhuntCountdownSyncSchema,
  createRoomSchema,
  joinRoomSchema,
  leaveRoomSchema,
  roomCodeSchema,
  roleRequestSchema,
  startGameSchema,
  updateRoomSettingsSchema,
  voteSubmissionSchema,
  wordImpostorRoleRequestSchema,
  wordImpostorVoteSubmissionSchema,
} from "@impostor/api";
import type {
  CreateRoomResponse,
  JoinRoomResponse,
  PlayerJoinedPayload,
  PlayerId,
  PlayerLeftPayload,
  PlayerReconnectedPayload,
  ReconnectPayload,
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
import { RoomService } from "../rooms/room-service.js";
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
): { close: () => void } {
  const rateLimiter = new InMemoryRateLimiter();
  const disconnectTimers = new Map<string, NodeJS.Timeout>();
  let isClosing = false;
  const includeErrorDetails = options.nodeEnv !== "production";
  const reportSocketError = <T>(
    socket: GameSocket,
    acknowledgement: SocketAck<T> | undefined,
    error: unknown,
  ) => reportError(socket, acknowledgement, error, includeErrorDetails);

  const onConnection = (socket: GameSocket) => {
    if (isClosing) {
      socket.disconnect(true);
      return;
    }

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

    socket.on(GAME_EVENTS.START_GAME, (payload, acknowledgement) => {
      handleStartGame(socket, payload, acknowledgement);
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

      const disconnected = rooms.disconnectSocket(socket.id);
      if (!disconnected) {
        return;
      }

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
          classicGames.onPlayerRemoved(
            removal.roomCode,
            removal.room !== undefined,
          );
          wordGames.onPlayerRemoved(
            removal.roomCode,
            removal.room !== undefined,
          );
          manhuntGames.onPlayerRemoved(
            removal.roomCode,
            removal.room !== undefined,
          );
          publishPlayerLeft(io, removal);
        }
      }, options.reconnectGracePeriodMs);
      timer.unref();
      disconnectTimers.set(timerKey, timer);
    });
  };
  io.on("connection", onConnection);

  return {
    close: () => {
      isClosing = true;
      io.off("connection", onConnection);
      for (const timer of disconnectTimers.values()) {
        clearTimeout(timer);
      }
      disconnectTimers.clear();
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
      response = rooms.createRoom(parsed.data, socket.id);
      await socket.join(response.room.code);
      socket.data.playerId = response.playerId;
      socket.data.roomCode = response.room.code;
      acknowledgeSuccess(acknowledgement, response);
      publishRoomUpdate(io, response.room);
    } catch (error) {
      if (response) {
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
      response = rooms.joinRoom(parsed.data, socket.id);
      await socket.join(response.room.code);
      socket.data.playerId = response.playerId;
      socket.data.roomCode = response.room.code;

      const player = response.room.players.find(
        (roomPlayer) => roomPlayer.id === response?.playerId,
      );
      if (!player) {
        throw new Error("Joined player was missing from the room snapshot.");
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
      const removal = rooms.leaveRoom(parsed.data.roomCode, socket.id);
      clearDisconnectTimer(makeTimerKey(removal.roomCode, removal.playerId));
      await socket.leave(removal.roomCode);
      socket.data.playerId = undefined;
      socket.data.roomCode = undefined;
      acknowledgeSuccess(acknowledgement, undefined);
      classicGames.onPlayerRemoved(
        removal.roomCode,
        removal.room !== undefined,
      );
      wordGames.onPlayerRemoved(
        removal.roomCode,
        removal.room !== undefined,
      );
      manhuntGames.onPlayerRemoved(
        removal.roomCode,
        removal.room !== undefined,
      );
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
      const room = rooms.updateRoomSettings(parsed.data, socket.id);
      const response: RoomUpdatePayload = { room };
      acknowledgeSuccess(acknowledgement, response);
      publishRoomUpdate(io, room);
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
    }
  }

  function handleStartGame(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<void> | undefined,
  ): void {
    const parsed = startGameSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }

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
      );
    } catch (error) {
      reportSocketError(socket, undefined, error);
    }
  }

  function handleManhuntSettings(
    socket: GameSocket,
    payload: unknown,
    acknowledgement: SocketAck<RoomUpdatePayload> | undefined,
  ): void {
    const parsed = manhuntUpdateSettingsSchema.safeParse(payload);
    if (!parsed.success) {
      reportValidationError(socket, acknowledgement, parsed.error.issues);
      return;
    }
    try {
      manhuntGames.updateSettings(
        parsed.data.roomCode,
        socket.id,
        parsed.data.settings,
      );
      const room = rooms.getPublicRoom(parsed.data.roomCode);
      if (room) {
        acknowledgeSuccess(acknowledgement, { room });
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
      const result = rooms.reconnect(parsed.payload, socket.id);
      clearDisconnectTimer(
        makeTimerKey(result.payload.roomCode, result.payload.player.id),
      );

      if (result.previousSocketId) {
        io.sockets.sockets.get(result.previousSocketId)?.disconnect(true);
      }

      await socket.join(result.payload.roomCode);
      socket.data.playerId = result.payload.player.id;
      socket.data.roomCode = result.payload.roomCode;
      acknowledgeSuccess(acknowledgement, result.payload);
      io
        .to(result.payload.roomCode)
        .emit(CONNECTION_EVENTS.PLAYER_RECONNECTED, result.payload);
      publishRoomUpdate(io, result.room);
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
        if (manhuntSnapshot.countdown) {
          socket.emit(MANHUNT_EVENTS.COUNTDOWN, manhuntSnapshot.countdown);
        }
        if (manhuntSnapshot.ended) {
          socket.emit(GAME_EVENTS.GAME_ENDED, manhuntSnapshot.ended);
        }
      }
    } catch (error) {
      reportSocketError(socket, acknowledgement, error);
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
