import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
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
import { ClassicImpostorService } from "./games/imposter/classic-game-service.js";
import { WordImpostorService } from "./games/imposter/word-game-service.js";
import { ManhuntGameService } from "./manhunt/manhunt-game-service.js";
import { GuestProfileService } from "./guest-profiles/guest-profile-service.js";
import { RoomService } from "./rooms/room-service.js";
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
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function createBackendServer(
  config: BackendConfig,
  roomService = new RoomService(),
  guestProfileService = new GuestProfileService(config.guestProfiles),
): BackendServer {
  const app = createApp(config, roomService, guestProfileService);
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
  });
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
  });
  const manhuntGameService = new ManhuntGameService(roomService, {
    gameStarted: (roomCode, payload) =>
      io.to(roomCode).emit(GAME_EVENTS.GAME_STARTED, payload),
    roomUpdated: (room) => io.to(room.code).emit(ROOM_EVENTS.UPDATE, { room }),
    stateUpdated: (roomCode, payload) =>
      io.to(roomCode).emit(GAME_EVENTS.STATE_UPDATE, payload),
    settingsUpdated: (roomCode, payload) =>
      io.to(roomCode).emit(MANHUNT_EVENTS.SETTINGS_UPDATE, payload),
    teamAssignment: (roomCode, payload) =>
      io.to(roomCode).emit(MANHUNT_EVENTS.TEAM_ASSIGNMENT, payload),
    readyUpdated: (roomCode, payload) =>
      io.to(roomCode).emit(MANHUNT_EVENTS.READY_UPDATE, payload),
    locationFlashed: (roomCode, payload) =>
      io.to(roomCode).emit(MANHUNT_EVENTS.LOCATION_FLASH, payload),
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
  });
  const socketHandlers = attachRoomSocketHandlers(
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
    },
  );

  return {
    app,
    httpServer,
    io,
    roomService,
    classicImpostorService,
    wordImpostorService,
    manhuntGameService,
    listen: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        const handleError = (error: Error) => reject(error);
        httpServer.once("error", handleError);
        httpServer.listen(config.port, "0.0.0.0", () => {
          httpServer.off("error", handleError);
          const address = httpServer.address();
          if (!address || typeof address === "string") {
            reject(new Error("HTTP server did not bind to a TCP port."));
            return;
          }
          resolve(address);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        socketHandlers.close();
        classicImpostorService.close();
        wordImpostorService.close();
        manhuntGameService.shutdown();
        io.close(() => resolve());
      }),
  };
}
