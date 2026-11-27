import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PoolConfig } from "pg";
import {
  GAME_EVENTS,
  IMPOSTOR_EVENTS,
  ROOM_EVENTS,
  WORD_IMPOSTOR_EVENTS,
  MANHUNT_EVENTS,
} from "@impostor/api";
import { Server } from "socket.io";
import type { BackendConfig } from "./config/env.js";
import { createApp } from "./app.js";
import type { BackendReadinessResponse } from "./app.js";
import { ClassicImpostorService } from "./games/imposter/classic-game-service.js";
import { WordImpostorService } from "./games/imposter/word-game-service.js";
import { ManhuntGameService } from "./manhunt/manhunt-game-service.js";
import { GuestProfileService } from "./guest-profiles/guest-profile-service.js";
import { RoomService } from "./rooms/room-service.js";
import type { RoomPersistenceCommands } from "./rooms/room-persistence-commands.js";
import {
  DurableRoomRuntime,
} from "./rooms/durable-room-runtime.js";
import type {
  DurableRoomRuntimeDependencies,
} from "./rooms/durable-room-runtime.js";
import type {
  PrepareForRuntimeRecoveryInput,
} from "./rooms/postgres-room-repository.js";
import { attachRoomSocketHandlers } from "./sockets/room-handlers.js";
import type {
  GameSocketServer,
  InterServerEvents,
  SocketData,
} from "./sockets/socket-types.js";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "./sockets/socket-types.js";
import { isOriginAllowed } from "./utils/cors.js";
import { getClientIp } from "./utils/client-ip.js";
import { isSecureTransport } from "./utils/transport.js";

export interface BackendServer {
  app: ReturnType<typeof createApp>;
  httpServer: HttpServer;
  io: GameSocketServer;
  roomService: RoomService;
  classicImpostorService: ClassicImpostorService;
  wordImpostorService: WordImpostorService;
  manhuntGameService: ManhuntGameService;
  getReadiness(): BackendReadinessResponse;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function createBackendServer(
  config: BackendConfig,
  roomService = new RoomService(),
  guestProfileService = new GuestProfileService(config.guestProfiles),
): BackendServer {
  return buildBackendServer(
    config,
    roomService,
    guestProfileService,
  );
}

export interface DurableBackendServerOptions {
  readonly poolConfig: PoolConfig;
  readonly recoveryInput?: PrepareForRuntimeRecoveryInput;
  readonly runtimeDependencies?: Partial<DurableRoomRuntimeDependencies>;
  readonly roomService?: RoomService;
}

export async function createDurableBackendServer(
  config: BackendConfig,
  options: DurableBackendServerOptions,
): Promise<BackendServer> {
  const roomService = options.roomService ?? new RoomService();
  const runtime = new DurableRoomRuntime(
    roomService,
    options.poolConfig,
    options.runtimeDependencies,
  );
  try {
    await runtime.initialize();
    const recoveryInput = options.recoveryInput ?? {
      now: new Date(),
      reconnectGracePeriodMs: config.reconnectGracePeriodMs,
    };
    const services = await runtime.recover(recoveryInput);
    if (!runtime.isServingReady || !runtime.isLeaseOwned) {
      throw new Error("Durable room runtime did not become serving-ready.");
    }

    const server = buildBackendServer(
      config,
      roomService,
      new GuestProfileService(config.guestProfiles),
      services.commands,
      runtime,
    );
    const removeLeaseLostListener = runtime.onLeaseLost(() => {
      server.stopGameplayAdmission();
    });
    const close = () =>
      server.closeWithRuntime(runtime, removeLeaseLostListener);
    return {
      app: server.app,
      httpServer: server.httpServer,
      io: server.io,
      roomService: server.roomService,
      classicImpostorService: server.classicImpostorService,
      wordImpostorService: server.wordImpostorService,
      manhuntGameService: server.manhuntGameService,
      getReadiness: server.getReadiness,
      listen: async () => {
        try {
          return await server.listen();
        } catch (listenError) {
          try {
            await close();
          } catch (cleanupError) {
            throw new AggregateError(
              [listenError, cleanupError],
              "Durable backend listen failed and cleanup was incomplete.",
              { cause: listenError },
            );
          }
          throw listenError;
        }
      },
      close,
    };
  } catch (startupError) {
    try {
      await runtime.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Durable backend startup failed and cleanup was incomplete.",
        { cause: startupError },
      );
    }
    throw startupError;
  }
}

interface InternalBackendServer extends BackendServer {
  stopGameplayAdmission(): void;
  closeWithRuntime(
    runtime: DurableRoomRuntime,
    removeLeaseLostListener: () => void,
  ): Promise<void>;
}

function buildBackendServer(
  config: BackendConfig,
  roomService: RoomService,
  guestProfileService: GuestProfileService,
  roomPersistenceCommands?: RoomPersistenceCommands,
  runtime?: DurableRoomRuntime,
): InternalBackendServer {
  let isListening = false;
  let isClosing = false;
  let getSocketHandlerDiagnostics = () => ({
    scheduledTimeouts: 0,
    pendingPostCommitSideEffects: 0,
  });
  const getReadiness = (): BackendReadinessResponse => {
    const runtimeDiagnostics = runtime?.getDiagnostics();
    const timeoutDiagnostics = getSocketHandlerDiagnostics();
    const servingReady = runtime?.isServingReady ?? false;
    return {
      processAlive: true,
      acceptingTraffic:
        isListening
        && !isClosing
        && (!runtime || (servingReady && runtime.isLeaseOwned)),
      durableRuntimeReadiness: runtime?.readiness ?? "disabled",
      durableRuntimeInitialized: runtime?.isResourceReady ?? false,
      databaseLeaseOwned: runtime ? runtime.isLeaseOwned : null,
      waitingRoomRecoveryCompleted: servingReady,
      shuttingDown: isClosing || runtime?.readiness === "draining",
      unresolved: {
        trackedReconciliations:
          runtimeDiagnostics?.roomReconciliation.trackedRooms ?? 0,
        exhaustedReconciliations:
          runtimeDiagnostics?.roomReconciliation.exhaustedRooms ?? 0,
        pendingExpirations:
          runtimeDiagnostics?.roomExpiration.pendingCandidates ?? 0,
        pendingExpirationCleanup:
          runtimeDiagnostics?.roomExpiration.pendingLocalCleanup ?? 0,
        scheduledReconnectTimeouts: timeoutDiagnostics.scheduledTimeouts,
        pendingTimeoutSideEffects:
          timeoutDiagnostics.pendingPostCommitSideEffects,
      },
    };
  };
  const app = createApp(config, roomService, guestProfileService, getReadiness);
  const httpServer = createServer(app);
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData
  >(httpServer, {
    cors: {
      origin: (origin, callback) => {
        const allowed = isOriginAllowed(origin, config.allowedOrigins);
        callback(allowed ? null : new Error("Origin is not allowed."), allowed);
      },
      methods: ["GET", "POST"],
    },
    maxHttpBufferSize: 64 * 1024,
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      const originAllowed = isOriginAllowed(origin, config.allowedOrigins);
      const clientIpAllowed =
        getClientIp(
          request.headers,
          request.socket.remoteAddress,
          config.clientIpMode,
          config.trustProxyHops,
        ) !== undefined;
      const transportAllowed =
        !config.requireHttps ||
        isSecureTransport(
          request,
          config.clientIpMode,
          config.trustProxyHops,
        );
      callback(null, originAllowed && clientIpAllowed && transportAllowed);
    },
  });
  const classicImpostorService = new ClassicImpostorService(roomService, {
    gameStarted: (roomCode, payload) =>
      io.to(roomCode).emit(GAME_EVENTS.GAME_STARTED, payload),
    roomUpdated: (room) => io.to(room.code).emit(ROOM_EVENTS.UPDATE, { room }),
    stateUpdated: (roomCode, payload) =>
      io.to(roomCode).emit(GAME_EVENTS.STATE_UPDATE, payload),
    discussionStarted: (roomCode, payload) =>
      io.to(roomCode).emit(IMPOSTOR_EVENTS.DISCUSSION, payload),
    voteResults: (roomCode, payload) =>
      io.to(roomCode).emit(IMPOSTOR_EVENTS.VOTE_RESULTS, payload),
    gameEnded: (roomCode, payload) =>
      io.to(roomCode).emit(GAME_EVENTS.GAME_ENDED, payload),
    rolesRevealed: (roomCode, payload) =>
      io.to(roomCode).emit(IMPOSTOR_EVENTS.REVEAL, payload),
  }, undefined, roomPersistenceCommands);
  const wordImpostorService = new WordImpostorService(roomService, {
    gameStarted: (roomCode, payload) =>
      io.to(roomCode).emit(GAME_EVENTS.GAME_STARTED, payload),
    roomUpdated: (room) => io.to(room.code).emit(ROOM_EVENTS.UPDATE, { room }),
    stateUpdated: (roomCode, payload) =>
      io.to(roomCode).emit(GAME_EVENTS.STATE_UPDATE, payload),
    discussionStarted: (roomCode, payload) =>
      io.to(roomCode).emit(WORD_IMPOSTOR_EVENTS.DISCUSSION, payload),
    voteResults: (roomCode, payload) =>
      io.to(roomCode).emit(WORD_IMPOSTOR_EVENTS.VOTE_RESULTS, payload),
    gameEnded: (roomCode, payload) =>
      io.to(roomCode).emit(GAME_EVENTS.GAME_ENDED, payload),
    rolesRevealed: (roomCode, payload) =>
      io.to(roomCode).emit(WORD_IMPOSTOR_EVENTS.REVEAL, payload),
  }, undefined, roomPersistenceCommands);
  const manhuntGameService = new ManhuntGameService(roomService, {
    gameStarted: (roomCode, payload) =>
      io.to(roomCode).emit(GAME_EVENTS.GAME_STARTED, payload),
    roomUpdated: (room) => io.to(room.code).emit(ROOM_EVENTS.UPDATE, { room }),
    stateUpdated: (roomCode, payload) =>
      io.to(roomCode).emit(GAME_EVENTS.STATE_UPDATE, payload),
    settingsUpdated: (roomCode, payload) =>
      io.to(roomCode).emit(MANHUNT_EVENTS.SETTINGS_UPDATE, payload),
    boundaryUpdated: (roomCode, payload) => {
      const room = roomService.getPublicRoom(roomCode);
      if (!room || payload.roomCode !== roomCode) {
        return;
      }
      for (const player of room.players) {
        const socketId = roomService.getSocketIdForPlayer(
          roomCode,
          player.id,
        );
        if (socketId) {
          io.to(socketId).emit(MANHUNT_EVENTS.BOUNDARY_UPDATE, {
            roomCode,
            boundary:
              manhuntGameService.getBoundaryForPlayer(roomCode, player.id) ??
              null,
          });
        }
      }
    },
    teamAssignment: (roomCode, playerId, payload) => {
      if (payload.playerId !== playerId) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "manhunt_team_assignment_identity_mismatch",
            roomCode,
            playerId,
            payloadPlayerId: payload.playerId,
          }),
        );
        return;
      }
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (!socketId) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "manhunt_team_assignment_socket_missing",
            roomCode,
            playerId,
          }),
        );
        return;
      }
      io.to(socketId).emit(MANHUNT_EVENTS.TEAM_ASSIGNMENT, payload);
      io.to(socketId).emit(MANHUNT_EVENTS.BOUNDARY_UPDATE, {
        roomCode,
        boundary:
          manhuntGameService.getBoundaryForPlayer(roomCode, playerId) ?? null,
      });
    },
    readyUpdated: (roomCode, payload) =>
      io.to(roomCode).emit(MANHUNT_EVENTS.READY_UPDATE, payload),
    locationFlashed: (roomCode, playerId, payload) => {
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.LOCATION_FLASH, payload);
      }
    },
    missionAssignment: (roomCode, playerId, payload) => {
      if (payload.playerId !== playerId) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "manhunt_mission_assignment_identity_mismatch",
            roomCode,
            playerId,
            payloadPlayerId: payload.playerId,
          }),
        );
        return;
      }
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.MISSION_ASSIGNMENT, payload);
      }
    },
    missionReveal: (roomCode, playerIds, payload) => {
      for (const playerId of playerIds) {
        const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
        if (socketId) {
          io.to(socketId).emit(MANHUNT_EVENTS.MISSION_REVEAL, payload);
        }
      }
    },
    freezeWarning: (roomCode, playerId, payload) => {
      if (payload.playerId !== playerId) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "manhunt_freeze_warning_identity_mismatch",
            roomCode,
            playerId,
            payloadPlayerId: payload.playerId,
          }),
        );
        return;
      }
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.FREEZE_WARNING, payload);
      }
    },
    playerFrozen: (roomCode, playerId, payload) => {
      if (payload.playerId !== playerId) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "manhunt_frozen_identity_mismatch",
            roomCode,
            playerId,
            payloadPlayerId: payload.playerId,
          }),
        );
        return;
      }
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.PLAYER_FROZEN, payload);
      }
    },
    playerFreezeEnded: (roomCode, playerId, payload) => {
      if (payload.playerId !== playerId) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "manhunt_freeze_end_identity_mismatch",
            roomCode,
            playerId,
            payloadPlayerId: payload.playerId,
          }),
        );
        return;
      }
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.PLAYER_FREEZE_ENDED, payload);
      }
    },
    footstepsState: (roomCode, playerId, payload) => {
      if (payload.playerId !== playerId) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "manhunt_footsteps_identity_mismatch",
            roomCode,
            playerId,
            payloadPlayerId: payload.playerId,
          }),
        );
        return;
      }
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.FOOTSTEPS_STATE, payload);
      }
    },
    smokeBombState: (roomCode, playerId, payload) => {
      if (payload.playerId !== playerId) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "manhunt_smoke_bomb_identity_mismatch",
            roomCode,
            playerId,
            payloadPlayerId: payload.playerId,
          }),
        );
        return;
      }
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.SMOKE_BOMB_STATE, payload);
      }
    },
    ghostState: (roomCode, playerId, payload) => {
      if (payload.playerId !== playerId) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "manhunt_ghost_identity_mismatch",
            roomCode,
            playerId,
            payloadPlayerId: payload.playerId,
          }),
        );
        return;
      }
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.GHOST_STATE, payload);
      }
    },
    freezeDecoyState: (roomCode, playerId, payload) => {
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.FREEZE_DECOY_STATE, payload);
      }
    },
    freezeDecoyUsageState: (roomCode, playerId, payload) => {
      if (payload.playerId !== playerId) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "manhunt_freeze_decoy_usage_identity_mismatch",
            roomCode,
            playerId,
            payloadPlayerId: payload.playerId,
          }),
        );
        return;
      }
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(
          MANHUNT_EVENTS.FREEZE_DECOY_USAGE_STATE,
          payload,
        );
      }
    },
    lateGameClueState: (roomCode, playerId, payload) => {
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.LATE_GAME_CLUE_STATE, payload);
      }
    },
    lateGameWarningState: (roomCode, playerId, payload) => {
      if (payload.playerId !== playerId) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "manhunt_late_game_warning_identity_mismatch",
            roomCode,
          }),
        );
        return;
      }
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.LATE_GAME_WARNING_STATE, payload);
      }
    },
    playerCaught: (roomCode, payload) =>
      io.to(roomCode).emit(MANHUNT_EVENTS.PLAYER_CAUGHT, payload),
    catchConfirmationRequested: (roomCode, playerId, payload) => {
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(
          MANHUNT_EVENTS.CATCH_CONFIRMATION_REQUEST,
          payload,
        );
      }
    },
    catchRequestStatus: (roomCode, playerId, payload) => {
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.CATCH_REQUEST_STATUS, payload);
      }
    },
    catchConfirmed: (roomCode, payload) =>
      io.to(roomCode).emit(MANHUNT_EVENTS.CATCH_CONFIRMED, payload),
    proximityAlert: (roomCode, playerId, payload) => {
      const socketId = roomService.getSocketIdForPlayer(roomCode, playerId);
      if (socketId) {
        io.to(socketId).emit(MANHUNT_EVENTS.PROXIMITY_ALERT, payload);
      }
    },
    gameEnded: (roomCode, payload) =>
      io.to(roomCode).emit(GAME_EVENTS.GAME_ENDED, payload),
    countdownUpdated: (roomCode, payload) =>
      io.to(roomCode).emit(MANHUNT_EVENTS.COUNTDOWN, payload),
    countdownCancelled: (roomCode, payload) =>
      io.to(roomCode).emit(MANHUNT_EVENTS.COUNTDOWN_CANCELLED, payload),
  },
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  config.lateGameExposureDurations ?? undefined,
  undefined,
  roomPersistenceCommands);
  let socketHandlers: ReturnType<typeof attachRoomSocketHandlers>;
  try {
    socketHandlers = attachRoomSocketHandlers(
      io,
      roomService,
      classicImpostorService,
      wordImpostorService,
      manhuntGameService,
      {
        reconnectGracePeriodMs: config.reconnectGracePeriodMs,
        nodeEnv: config.nodeEnv,
        clientIpMode: config.clientIpMode,
        trustProxyHops: config.trustProxyHops,
        roomPersistenceCommands,
        isServingReady: runtime
          ? () => runtime.isServingReady && runtime.isLeaseOwned
          : undefined,
      },
    );
  } catch (startupError) {
    const cleanupErrors: unknown[] = [];
    for (const stop of [
      () => classicImpostorService.close(),
      () => wordImpostorService.close(),
      () => manhuntGameService.shutdown(),
    ]) {
      try {
        stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      io.close(() => {});
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [startupError, ...cleanupErrors],
        "Backend setup failed and partial server cleanup was incomplete.",
        { cause: startupError },
      );
    }
    throw startupError;
  }
  getSocketHandlerDiagnostics = socketHandlers.getDiagnostics;

  let closeCorePromise: Promise<void> | undefined;
  let closeWithRuntimePromise: Promise<void> | undefined;
  let gamesStopped = false;
  const stopGameplayAdmission = () => {
    if (isClosing) {
      return;
    }
    isClosing = true;
    isListening = false;
    const errors: unknown[] = [];
    try {
      socketHandlers.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      io.disconnectSockets(true);
    } catch (error) {
      errors.push(error);
    }
    if (!gamesStopped) {
      gamesStopped = true;
      for (const stop of [
        () => classicImpostorService.close(),
        () => wordImpostorService.close(),
        () => manhuntGameService.shutdown(),
      ]) {
        try {
          stop();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Backend gameplay admission could not be stopped cleanly.",
      );
    }
  };
  const closeCore = (): Promise<void> => {
    if (closeCorePromise) {
      return closeCorePromise;
    }
    closeCorePromise = (async () => {
      const errors: unknown[] = [];
      try {
        stopGameplayAdmission();
      } catch (error) {
        errors.push(error);
      }
      try {
        await new Promise<void>((resolve) => io.close(() => resolve()));
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Backend server shutdown failed.");
      }
    })();
    return closeCorePromise;
  };
  const closeWithRuntime = (
    ownedRuntime: DurableRoomRuntime,
    removeLeaseLostListener: () => void,
  ): Promise<void> => {
    if (closeWithRuntimePromise) {
      return closeWithRuntimePromise;
    }
    closeWithRuntimePromise = (async () => {
      const errors: unknown[] = [];
      try {
        await closeCore();
      } catch (error) {
        errors.push(error);
      }
      removeLeaseLostListener();
      try {
        await ownedRuntime.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "Durable backend shutdown failed.",
          { cause: errors[0] },
        );
      }
    })();
    return closeWithRuntimePromise;
  };
  let listenPromise: Promise<AddressInfo> | undefined;

  return {
    app,
    httpServer,
    io,
    roomService,
    classicImpostorService,
    wordImpostorService,
    manhuntGameService,
    getReadiness,
    stopGameplayAdmission,
    closeWithRuntime,
    listen: () => {
      if (isClosing) {
        return Promise.reject(new Error("Backend server is shutting down."));
      }
      if (listenPromise) {
        return listenPromise;
      }
      listenPromise = new Promise<AddressInfo>((resolve, reject) => {
        const handleError = (error: Error) => {
          httpServer.off("error", handleError);
          listenPromise = undefined;
          reject(error);
        };
        httpServer.once("error", handleError);
        httpServer.listen(config.port, "0.0.0.0", () => {
          httpServer.off("error", handleError);
          const address = httpServer.address();
          if (!address || typeof address === "string") {
            listenPromise = undefined;
            reject(new Error("HTTP server did not bind to a TCP address."));
            return;
          }
          isListening = true;
          resolve(address);
        });
      });
      return listenPromise;
    },
    close: closeCore,
  };
}
