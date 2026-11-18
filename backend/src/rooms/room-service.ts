import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  DEFAULT_DISCUSSION_DURATION_SECONDS,
  DEFAULT_IMPOSTOR_COUNT,
  DEFAULT_VOTING_DURATION_SECONDS,
  MAX_PLAYERS_PER_ROOM,
  ROOM_CODE_LENGTH,
  createRoomSchema,
  joinRoomSchema,
  roomSettingsSchema,
  updateRoomSettingsSchema,
} from "@impostor/api";
import type {
  CreateRoomPayload,
  CreateRoomResponse,
  GameSessionId,
  JoinRoomPayload,
  JoinRoomResponse,
  Player,
  PlayerId,
  PlayerReconnectedPayload,
  ReconnectPayload,
  Room,
  RoomCode,
  RoomSettings,
  UpdateRoomSettingsPayload,
} from "@impostor/api";
import { AppError } from "../utils/app-error.js";

interface StoredPlayer {
  player: Player;
  reconnectTokenHash: Buffer;
  socketId?: string;
}

interface RoomRecord {
  code: RoomCode;
  hostId: PlayerId;
  players: Map<PlayerId, StoredPlayer>;
  settings: RoomSettings;
  gameStatus: Room["gameStatus"];
  currentGameId?: Room["currentGameId"];
  createdAt: string;
}

export interface PlayerRemoval {
  roomCode: RoomCode;
  playerId: PlayerId;
  room?: Room;
  deleted: boolean;
  hostChanged: boolean;
}

export interface PlayerDisconnect {
  roomCode: RoomCode;
  playerId: PlayerId;
  room: Room;
}

export interface ReconnectResult {
  payload: PlayerReconnectedPayload;
  room: Room;
  previousSocketId?: string;
}

const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  gameMode: "impostor-classic",
  maxPlayers: MAX_PLAYERS_PER_ROOM,
  isPrivate: false,
  classicImpostor: {
    impostorCount: DEFAULT_IMPOSTOR_COUNT,
    discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
    votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
  },
};
const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_ROOM_CODE_ATTEMPTS = 128;

export class RoomService {
  private readonly rooms = new Map<RoomCode, RoomRecord>();
  private readonly socketMemberships = new Map<
    string,
    { roomCode: RoomCode; playerId: PlayerId }
  >();

  createRoom(payload: CreateRoomPayload, socketId: string): CreateRoomResponse {
    this.ensureSocketIsFree(socketId);
    const parsedPayload = createRoomSchema.safeParse(payload);
    if (!parsedPayload.success) {
      throw new AppError("INVALID_PAYLOAD", "Room creation payload is invalid.");
    }

    const settingsResult = roomSettingsSchema.safeParse(
      parsedPayload.data.settings ?? DEFAULT_ROOM_SETTINGS,
    );
    if (!settingsResult.success) {
      throw new AppError("INVALID_PAYLOAD", "Room settings are invalid.");
    }

    const code = this.generateRoomCode();
    const playerId = this.generatePlayerId();
    const reconnectToken = this.generateReconnectToken();
    const player: Player = {
      id: playerId,
      nickname: parsedPayload.data.nickname,
      connectionStatus: "connected",
      status: "waiting",
      joinedAt: new Date().toISOString(),
    };
    const room: RoomRecord = {
      code,
      hostId: playerId,
      players: new Map([
        [
          playerId,
          {
            player,
            reconnectTokenHash: this.hashReconnectToken(reconnectToken),
            socketId,
          },
        ],
      ]),
      settings: settingsResult.data,
      gameStatus: "waiting",
      createdAt: new Date().toISOString(),
    };

    this.rooms.set(code, room);
    this.socketMemberships.set(socketId, { roomCode: code, playerId });

    return {
      room: this.toPublicRoom(room),
      playerId,
      reconnectToken,
    };
  }

  joinRoom(payload: JoinRoomPayload, socketId: string): JoinRoomResponse {
    this.ensureSocketIsFree(socketId);
    const parsedPayload = joinRoomSchema.safeParse(payload);
    if (!parsedPayload.success) {
      throw new AppError("INVALID_PAYLOAD", "Room joining payload is invalid.");
    }

    const room = this.rooms.get(parsedPayload.data.roomCode);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }
    if (room.gameStatus !== "waiting") {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "This room is no longer accepting players.",
      );
    }
    if (room.players.size >= room.settings.maxPlayers) {
      throw new AppError("ROOM_FULL", "Room has reached its player limit.");
    }

    const playerId = this.generatePlayerId();
    const reconnectToken = this.generateReconnectToken();
    const player: Player = {
      id: playerId,
      nickname: parsedPayload.data.nickname,
      connectionStatus: "connected",
      status: "waiting",
      joinedAt: new Date().toISOString(),
    };

    room.players.set(playerId, {
      player,
      reconnectTokenHash: this.hashReconnectToken(reconnectToken),
      socketId,
    });
    this.socketMemberships.set(socketId, {
      roomCode: room.code,
      playerId,
    });

    return {
      room: this.toPublicRoom(room),
      playerId,
      reconnectToken,
    };
  }

  leaveRoom(roomCode: RoomCode, socketId: string): PlayerRemoval {
    const membership = this.requireMembership(roomCode, socketId);
    const room = this.requireRoom(membership.roomCode);
    return this.removePlayer(room, membership.playerId);
  }

  updateRoomSettings(
    payload: UpdateRoomSettingsPayload,
    socketId: string,
  ): Room {
    const parsedPayload = updateRoomSettingsSchema.safeParse(payload);
    if (!parsedPayload.success) {
      throw new AppError("INVALID_PAYLOAD", "Room settings payload is invalid.");
    }

    const membership = this.requireMembership(
      parsedPayload.data.roomCode,
      socketId,
    );
    const room = this.requireRoom(membership.roomCode);
    this.ensureHost(room, membership.playerId);
    if (room.gameStatus !== "waiting") {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Room settings cannot be changed after a game has started.",
      );
    }

    const settingsResult = roomSettingsSchema.safeParse(
      parsedPayload.data.settings,
    );
    if (!settingsResult.success) {
      throw new AppError("INVALID_PAYLOAD", "Room settings are invalid.");
    }
    if (settingsResult.data.maxPlayers < room.players.size) {
      throw new AppError(
        "ROOM_FULL",
        "The player limit cannot be lower than the current room size.",
      );
    }

    room.settings = settingsResult.data;
    return this.toPublicRoom(room);
  }

  assertHost(roomCode: RoomCode, socketId: string): void {
    const membership = this.requireMembership(roomCode, socketId);
    const room = this.requireRoom(membership.roomCode);
    this.ensureHost(room, membership.playerId);
  }

  updateManhuntSettings(
    roomCode: RoomCode,
    socketId: string,
    settings: NonNullable<RoomSettings["manhunt"]>,
  ): Room {
    const membership = this.requireMembership(roomCode, socketId);
    const room = this.requireRoom(membership.roomCode);
    this.ensureHost(room, membership.playerId);
    if (room.gameStatus !== "waiting") {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Manhunt settings cannot be changed after a game has started.",
      );
    }
    if (room.settings.gameMode !== "manhunt") {
      throw new AppError(
        "GAME_NOT_READY",
        "This room is not configured for Manhunt.",
      );
    }
    room.settings = { ...room.settings, manhunt: { ...settings, boundary: { ...settings.boundary, center: { ...settings.boundary.center } } } };
    return this.toPublicRoom(room);
  }

  getPlayerIdForSocket(roomCode: RoomCode, socketId: string): PlayerId {
    return this.requireMembership(roomCode, socketId).playerId;
  }

  getSocketIdForPlayer(
    roomCode: RoomCode,
    playerId: PlayerId,
  ): string | undefined {
    return this.rooms.get(roomCode)?.players.get(playerId)?.socketId;
  }

  beginGame(
    roomCode: RoomCode,
    socketId: string,
    gameId: GameSessionId,
  ): Room {
    const membership = this.requireMembership(roomCode, socketId);
    const room = this.requireRoom(membership.roomCode);
    this.ensureHost(room, membership.playerId);
    if (room.gameStatus === "starting" || room.gameStatus === "in_progress") {
      throw new AppError("GAME_NOT_ACTIVE", "A game is already in progress.");
    }

    room.gameStatus = "starting";
    room.currentGameId = gameId;
    for (const storedPlayer of room.players.values()) {
      storedPlayer.player.status = "active";
    }
    return this.toPublicRoom(room);
  }

  beginManhuntCountdown(
    roomCode: RoomCode,
    socketId: string,
    gameId: GameSessionId,
  ): Room {
    const membership = this.requireMembership(roomCode, socketId);
    const room = this.requireRoom(membership.roomCode);
    this.ensureHost(room, membership.playerId);
    if (room.gameStatus === "starting" || room.gameStatus === "in_progress") {
      throw new AppError("GAME_NOT_ACTIVE", "A game is already in progress.");
    }

    room.gameStatus = "starting";
    room.currentGameId = gameId;
    return this.toPublicRoom(room);
  }

  activateGame(roomCode: RoomCode, gameId: GameSessionId): Room {
    const room = this.rooms.get(roomCode);
    if (
      !room ||
      room.currentGameId !== gameId ||
      room.gameStatus !== "starting"
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "The game can no longer start.");
    }

    room.gameStatus = "in_progress";
    for (const storedPlayer of room.players.values()) {
      storedPlayer.player.status = "active";
    }
    return this.toPublicRoom(room);
  }

  cancelStartingGame(
    roomCode: RoomCode,
    gameId: GameSessionId,
  ): Room | undefined {
    const room = this.rooms.get(roomCode);
    if (
      !room ||
      room.currentGameId !== gameId ||
      room.gameStatus !== "starting"
    ) {
      return undefined;
    }

    room.gameStatus = "waiting";
    room.currentGameId = undefined;
    for (const storedPlayer of room.players.values()) {
      storedPlayer.player.status = "waiting";
    }
    return this.toPublicRoom(room);
  }

  eliminatePlayer(
    roomCode: RoomCode,
    gameId: GameSessionId,
    playerId: PlayerId,
  ): Room {
    const room = this.rooms.get(roomCode);
    const player = room?.players.get(playerId);
    if (
      !room ||
      room.currentGameId !== gameId ||
      room.gameStatus !== "in_progress" ||
      !player ||
      player.player.status !== "active"
    ) {
      throw new AppError(
        "INVALID_VOTE",
        "The selected player cannot be eliminated.",
      );
    }

    player.player.status = "eliminated";
    return this.toPublicRoom(room);
  }

  markPlayerCaught(
    roomCode: RoomCode,
    gameId: GameSessionId,
    playerId: PlayerId,
  ): Room {
    const room = this.rooms.get(roomCode);
    const player = room?.players.get(playerId);
    if (
      !room ||
      room.currentGameId !== gameId ||
      room.gameStatus !== "in_progress" ||
      !player ||
      player.player.status === "caught"
    ) {
      throw new AppError(
        "INVALID_VOTE",
        "The selected player cannot be caught.",
      );
    }
    player.player.status = "caught";
    return this.toPublicRoom(room);
  }

  finishGame(roomCode: RoomCode, gameId: GameSessionId): Room | undefined {
    const room = this.rooms.get(roomCode);
    if (!room || room.currentGameId !== gameId) {
      return undefined;
    }
    room.gameStatus = "finished";
    return this.toPublicRoom(room);
  }

  reconnect(
    payload: ReconnectPayload,
    socketId: string,
  ): ReconnectResult {
    const room = this.rooms.get(payload.roomCode);
    const storedPlayer = room?.players.get(payload.playerId);
    if (!room || !storedPlayer) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Reconnect credentials are invalid or expired.",
      );
    }

    const suppliedHash = this.hashReconnectToken(payload.reconnectToken);
    if (!timingSafeEqual(storedPlayer.reconnectTokenHash, suppliedHash)) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Reconnect credentials are invalid or expired.",
      );
    }

    const currentMembership = this.socketMemberships.get(socketId);
    if (
      currentMembership &&
      (currentMembership.roomCode !== room.code ||
        currentMembership.playerId !== storedPlayer.player.id)
    ) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "This connection is already a member of another room.",
      );
    }

    const previousSocketId = storedPlayer.socketId;
    if (previousSocketId && previousSocketId !== socketId) {
      this.socketMemberships.delete(previousSocketId);
    }

    storedPlayer.socketId = socketId;
    storedPlayer.player.connectionStatus = "connected";
    this.socketMemberships.set(socketId, {
      roomCode: room.code,
      playerId: storedPlayer.player.id,
    });

    const payloadResult: PlayerReconnectedPayload = {
      roomCode: room.code,
      player: { ...storedPlayer.player },
    };
    return {
      payload: payloadResult,
      room: this.toPublicRoom(room),
      previousSocketId:
        previousSocketId === socketId ? undefined : previousSocketId,
    };
  }

  disconnectSocket(socketId: string): PlayerDisconnect | undefined {
    const membership = this.socketMemberships.get(socketId);
    if (!membership) {
      return undefined;
    }

    this.socketMemberships.delete(socketId);
    const room = this.rooms.get(membership.roomCode);
    const storedPlayer = room?.players.get(membership.playerId);
    if (!room || !storedPlayer || storedPlayer.socketId !== socketId) {
      return undefined;
    }

    storedPlayer.socketId = undefined;
    storedPlayer.player.connectionStatus = "disconnected";
    return {
      roomCode: room.code,
      playerId: storedPlayer.player.id,
      room: this.toPublicRoom(room),
    };
  }

  removeDisconnectedPlayer(
    roomCode: RoomCode,
    playerId: PlayerId,
  ): PlayerRemoval | undefined {
    const room = this.rooms.get(roomCode);
    const storedPlayer = room?.players.get(playerId);
    if (
      !room ||
      !storedPlayer ||
      storedPlayer.socketId !== undefined ||
      storedPlayer.player.connectionStatus !== "disconnected"
    ) {
      return undefined;
    }

    return this.removePlayer(room, playerId);
  }

  getPublicRoom(roomCode: RoomCode): Room | undefined {
    const room = this.rooms.get(roomCode);
    return room ? this.toPublicRoom(room) : undefined;
  }

  private ensureSocketIsFree(socketId: string): void {
    if (this.socketMemberships.has(socketId)) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "This connection has already joined a room.",
      );
    }
  }

  private requireMembership(
    roomCode: RoomCode,
    socketId: string,
  ): { roomCode: RoomCode; playerId: PlayerId } {
    const membership = this.socketMemberships.get(socketId);
    if (!membership || membership.roomCode !== roomCode) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "This connection is not a member of the requested room.",
      );
    }
    return membership;
  }

  private requireRoom(roomCode: RoomCode): RoomRecord {
    const room = this.rooms.get(roomCode);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }
    return room;
  }

  private ensureHost(room: RoomRecord, playerId: PlayerId): void {
    if (room.hostId !== playerId) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Only the room host can perform this action.",
      );
    }
  }

  private removePlayer(room: RoomRecord, playerId: PlayerId): PlayerRemoval {
    const storedPlayer = room.players.get(playerId);
    if (!storedPlayer) {
      throw new AppError("NOT_AUTHORIZED", "Player is not in this room.");
    }

    if (storedPlayer.socketId) {
      this.socketMemberships.delete(storedPlayer.socketId);
    }
    room.players.delete(playerId);

    const wasHost = room.hostId === playerId;
    if (room.players.size === 0) {
      this.rooms.delete(room.code);
      return {
        roomCode: room.code,
        playerId,
        deleted: true,
        hostChanged: wasHost,
      };
    }

    if (wasHost) {
      const nextHost =
        [...room.players.values()].find(
          (entry) => entry.player.connectionStatus === "connected",
        ) ?? room.players.values().next().value;
      if (!nextHost) {
        throw new Error("Non-empty room has no players.");
      }
      room.hostId = nextHost.player.id;
    }

    return {
      roomCode: room.code,
      playerId,
      room: this.toPublicRoom(room),
      deleted: false,
      hostChanged: wasHost,
    };
  }

  private toPublicRoom(room: RoomRecord): Room {
    return {
      code: room.code,
      hostId: room.hostId,
      players: [...room.players.values()].map(({ player }) => ({
        ...player,
      })),
      settings: {
        ...room.settings,
        ...(room.settings.classicImpostor
          ? { classicImpostor: { ...room.settings.classicImpostor } }
          : {}),
        ...(room.settings.wordImpostor
          ? { wordImpostor: { ...room.settings.wordImpostor } }
          : {}),
        ...(room.settings.manhunt
          ? {
              manhunt: {
                ...room.settings.manhunt,
                boundary: {
                  ...room.settings.manhunt.boundary,
                  center: { ...room.settings.manhunt.boundary.center },
                },
              },
            }
          : {}),
      },
      gameStatus: room.gameStatus,
      ...(room.currentGameId ? { currentGameId: room.currentGameId } : {}),
      createdAt: room.createdAt,
    };
  }

  private generateRoomCode(): RoomCode {
    for (let attempt = 0; attempt < MAX_ROOM_CODE_ATTEMPTS; attempt += 1) {
      let code = "";
      for (let character = 0; character < ROOM_CODE_LENGTH; character += 1) {
        code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    throw new AppError(
      "UNKNOWN",
      "Unable to allocate a unique room code. Please try again.",
    );
  }

  private generatePlayerId(): PlayerId {
    let playerId = randomUUID();
    while (
      [...this.rooms.values()].some((room) => room.players.has(playerId))
    ) {
      playerId = randomUUID();
    }
    return playerId;
  }

  private generateReconnectToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private hashReconnectToken(token: string): Buffer {
    return createHash("sha256").update(token).digest();
  }
}
