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
  nicknameSchema,
  roomCodeSchema,
  roomSettingsSchema,
  updateRoomSettingsSchema,
} from "@impostor/api";
import type {
  CreateRoomPayload,
  CreateRoomResponse,
  GameSessionId,
  ImpostorGameMode,
  JoinRoomPayload,
  JoinRoomResponse,
  Player,
  PlayerId,
  PlayerReconnectedPayload,
  ReconnectPayload,
  Room,
  RoomCode,
  RoomSettings,
  PublicRoomSettings,
  ManhuntBoundary,
  UpdateRoomSettingsPayload,
} from "@impostor/api";
import { AppError } from "../utils/app-error.js";
import type { RecoverableWaitingRoom } from "./postgres-room-repository.js";

interface StoredPlayer {
  player: Player;
  reconnectTokenHash: Buffer;
  socketId?: string;
  disconnectGeneration: string;
  reconnectDeadlineAt: Date | null;
}

interface RoomRecord {
  code: RoomCode;
  durableRoomId: string;
  hostId: PlayerId;
  players: Map<PlayerId, StoredPlayer>;
  settings: PublicRoomSettings;
  manhuntBoundary?: ManhuntBoundary;
  gameStatus: Room["gameStatus"];
  currentGameId?: Room["currentGameId"];
  createdAt: string;
  persistenceFenced: boolean;
}

export interface PlayerRemoval {
  roomCode: RoomCode;
  playerId: PlayerId;
  room?: Room;
  deleted: boolean;
  hostChanged: boolean;
  suspensionScope?: GameplaySuspensionScope;
}

export interface GameplaySuspensionScope {
  readonly roomId: string;
  readonly gameId: GameSessionId | null;
}

export interface GameplaySuspension extends GameplaySuspensionScope {
  readonly roomCode: RoomCode;
  readonly reason: "durable_timeout_post_commit_side_effect_failure";
  readonly suspendedAt: string;
}

export interface ExpiredRoomSnapshot {
  roomCode: RoomCode;
  roomId: string;
  playerIds: readonly PlayerId[];
  socketIds: readonly string[];
}

export type ExpiredRoomRemovalResult =
  | { status: "removed" }
  | { status: "absent" }
  | { status: "blocked" }
  | { status: "replaced" };

export interface PlayerDisconnect {
  roomCode: RoomCode;
  playerId: PlayerId;
  room: Room;
  disconnectGeneration?: string;
  reconnectDeadlineAt?: Date;
}

export interface DisconnectedPlayerTimeout {
  roomCode: RoomCode;
  playerId: PlayerId;
  disconnectGeneration: string;
  reconnectDeadlineAt: Date;
}

export interface ReconnectResult {
  payload: PlayerReconnectedPayload;
  room: Room;
  previousSocketId?: string;
}

export interface PreparedRoomCreation {
  readonly roomId: string;
  readonly roomCode: RoomCode;
  readonly hostPlayerId: PlayerId;
  readonly hostNickname: string;
  readonly settings: RoomSettings;
  readonly reconnectToken: string;
  readonly reconnectTokenHash: Buffer;
}

export interface PreparedRoomJoin {
  readonly roomCode: RoomCode;
  readonly playerId: PlayerId;
  readonly nickname: string;
  readonly expectedHostId: PlayerId;
  readonly expectedCreatedAt: string;
  readonly reconnectToken: string;
  readonly reconnectTokenHash: Buffer;
}

export interface RoomMutationSnapshot {
  readonly roomCode: RoomCode;
  readonly hostId: PlayerId;
  readonly createdAt: string;
  readonly players: readonly {
    readonly playerId: PlayerId;
    readonly connectionStatus: Player["connectionStatus"];
    readonly socketId?: string;
    readonly disconnectGeneration: string;
    readonly reconnectDeadlineAt: number | null;
  }[];
}

export interface PreparedRoomLeave {
  readonly roomCode: RoomCode;
  readonly playerId: PlayerId;
  readonly socketId: string;
  readonly snapshot: RoomMutationSnapshot;
}

export interface PreparedRoomDisconnect {
  readonly roomCode: RoomCode;
  readonly playerId: PlayerId;
  readonly socketId: string;
  readonly snapshot: RoomMutationSnapshot;
}

export interface PreparedRoomReconnect {
  readonly roomCode: RoomCode;
  readonly playerId: PlayerId;
  readonly socketId: string;
  readonly reconnectToken: string;
  readonly snapshot: RoomMutationSnapshot;
}

export interface PreparedDisconnectedPlayerRemoval {
  readonly roomCode: RoomCode;
  readonly playerId: PlayerId;
  readonly disconnectGeneration: string;
  readonly reconnectDeadlineAt: Date;
  readonly snapshot: RoomMutationSnapshot;
}

export interface PersistedRoomLeave {
  readonly deleted: boolean;
  readonly hostChanged: boolean;
  readonly hostPlayerId?: PlayerId;
}

export interface PersistedPlayerRemoval {
  readonly deleted: boolean;
  readonly hostChanged: boolean;
  readonly hostPlayerId?: PlayerId;
}

export interface PersistedDisconnect {
  readonly disconnectGeneration: string;
  readonly reconnectDeadlineAt: Date;
}

export interface PreparedWaitingRoomSettingsUpdate {
  readonly roomCode: RoomCode;
  readonly socketId: string;
  readonly playerId: PlayerId;
  readonly settings: RoomSettings;
}

export interface RoomGameStatusReservation {
  readonly roomCode: RoomCode;
  readonly hostPlayerId?: PlayerId;
}

interface DeferredRoomMutation {
  run: (reservation: RoomGameStatusReservation) => Promise<void>;
  reconcile?: (reservation: RoomGameStatusReservation) => Promise<"complete" | "retry">;
  reject: (error: unknown) => void;
  isSettled: () => boolean;
}

interface DeferredRoomMutationQueue {
  readonly pending: DeferredRoomMutation[];
  draining: boolean;
  blocked: boolean;
}

export class DeferredRoomMutationCapacityError extends Error {
  constructor() {
    super("Deferred room mutation queue is full.");
    this.name = "DeferredRoomMutationCapacityError";
  }
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

function toPublicRoomSettings(settings: RoomSettings): PublicRoomSettings {
  const { manhunt, ...publicSettings } = settings;
  return {
    ...publicSettings,
    ...(manhunt
      ? {
          manhunt: {
            hunterCount: manhunt.hunterCount,
            ...(manhunt.gameDurationSeconds
              ? { gameDurationSeconds: manhunt.gameDurationSeconds }
              : {}),
          },
        }
      : {}),
  };
}

const ROOM_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_ROOM_CODE_ATTEMPTS = 128;

export class RoomService {
  private readonly rooms = new Map<RoomCode, RoomRecord>();
  private readonly gameStatusReservations = new Map<
    RoomCode,
    RoomGameStatusReservation
  >();
  private readonly deferredRoomMutations = new Map<
    RoomCode,
    DeferredRoomMutationQueue
  >();
  private readonly deferredMutationBlockedListeners = new Set<
    (roomCode: RoomCode) => void
  >();
  private readonly expiredRoomListeners = new Set<
    (room: ExpiredRoomSnapshot) => void | Promise<void>
  >();
  private readonly gameplaySuspensions = new Map<string, GameplaySuspension>();
  private readonly suspendedGameIds = new Map<GameSessionId, GameplaySuspension>();
  private readonly gameplaySuspensionListeners = new Set<
    (suspension: GameplaySuspension) => void
  >();
  private readonly disconnectTimeoutOwners = new Map<string, symbol>();
  private readonly socketMemberships = new Map<
    string,
    { roomCode: RoomCode; playerId: PlayerId }
  >();

  constructor(
    private readonly roomCodeFactory?: () => RoomCode,
  ) {}

  createRoom(payload: CreateRoomPayload, socketId: string): CreateRoomResponse {
    const prepared = this.prepareRoomCreation(payload, socketId);
    return this.commitPreparedRoomCreation(prepared, socketId);
  }

  prepareRoomCreation(
    payload: CreateRoomPayload,
    socketId: string,
  ): PreparedRoomCreation {
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
    const roomId = randomUUID();
    const playerId = this.generatePlayerId();
    const reconnectToken = this.generateReconnectToken();
    return {
      roomId,
      roomCode: code,
      hostPlayerId: playerId,
      hostNickname: parsedPayload.data.nickname,
      settings: settingsResult.data,
      reconnectToken,
      reconnectTokenHash: this.hashReconnectToken(reconnectToken),
    };
  }

  prepareRoomCreationWithNextCode(
    prepared: PreparedRoomCreation,
    excludedCodes: ReadonlySet<RoomCode>,
  ): PreparedRoomCreation {
    return {
      ...prepared,
      roomCode: this.generateRoomCode(excludedCodes),
    };
  }

  commitPreparedRoomCreation(
    prepared: PreparedRoomCreation,
    socketId: string,
  ): CreateRoomResponse {
    this.ensureSocketIsFree(socketId);
    if (
      this.rooms.has(prepared.roomCode)
      || this.hasPlayerId(prepared.hostPlayerId)
    ) {
      throw new AppError(
        "UNKNOWN",
        "Room identity became unavailable before creation completed.",
      );
    }

    const player: Player = {
      id: prepared.hostPlayerId,
      nickname: prepared.hostNickname,
      connectionStatus: "connected",
      status: "waiting",
      joinedAt: new Date().toISOString(),
    };
    const room: RoomRecord = {
      code: prepared.roomCode,
      durableRoomId: prepared.roomId,
      hostId: prepared.hostPlayerId,
      players: new Map([
        [
          prepared.hostPlayerId,
          {
            player,
            reconnectTokenHash: Buffer.from(prepared.reconnectTokenHash),
            socketId,
            disconnectGeneration: "0",
            reconnectDeadlineAt: null,
          },
        ],
      ]),
      settings: toPublicRoomSettings(prepared.settings),
      ...(prepared.settings.gameMode === "manhunt" && prepared.settings.manhunt
        ? {
            manhuntBoundary: {
              center: { ...prepared.settings.manhunt.boundary.center },
              radiusMeters: prepared.settings.manhunt.boundary.radiusMeters,
            },
          }
        : {}),
      gameStatus: "waiting",
      createdAt: new Date().toISOString(),
      persistenceFenced: false,
    };

    this.rooms.set(prepared.roomCode, room);
    this.socketMemberships.set(socketId, {
      roomCode: prepared.roomCode,
      playerId: prepared.hostPlayerId,
    });

    return {
      room: this.toPublicRoom(room),
      playerId: prepared.hostPlayerId,
      reconnectToken: prepared.reconnectToken,
    };
  }

  joinRoom(payload: JoinRoomPayload, socketId: string): JoinRoomResponse {
    const prepared = this.prepareRoomJoin(payload, socketId);
    return this.commitPreparedRoomJoin(prepared, socketId);
  }

  prepareRoomJoin(
    payload: JoinRoomPayload,
    socketId: string,
    options: { checkLocalCapacity?: boolean } = {},
  ): PreparedRoomJoin {
    this.ensureSocketIsFree(socketId);
    const parsedPayload = joinRoomSchema.safeParse(payload);
    if (!parsedPayload.success) {
      throw new AppError("INVALID_PAYLOAD", "Room joining payload is invalid.");
    }

    const room = this.rooms.get(parsedPayload.data.roomCode);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }
    this.ensureRoomWritable(room);
    if (room.gameStatus !== "waiting") {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "This room is no longer accepting players.",
      );
    }
    if (
      options.checkLocalCapacity !== false
      && room.players.size >= room.settings.maxPlayers
    ) {
      throw new AppError("ROOM_FULL", "Room has reached its player limit.");
    }

    const playerId = this.generatePlayerId();
    const reconnectToken = this.generateReconnectToken();
    return {
      roomCode: room.code,
      playerId,
      nickname: parsedPayload.data.nickname,
      expectedHostId: room.hostId,
      expectedCreatedAt: room.createdAt,
      reconnectToken,
      reconnectTokenHash: this.hashReconnectToken(reconnectToken),
    };
  }

  commitPreparedRoomJoin(
    prepared: PreparedRoomJoin,
    socketId: string,
  ): JoinRoomResponse {
    this.ensureSocketIsFree(socketId);
    const room = this.requireRoom(prepared.roomCode);
    if (
      room.hostId !== prepared.expectedHostId
      || room.createdAt !== prepared.expectedCreatedAt
    ) {
      throw new AppError(
        "ROOM_NOT_FOUND",
        "Room changed before joining could complete.",
      );
    }
    if (room.gameStatus !== "waiting") {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "This room is no longer accepting players.",
      );
    }
    if (this.hasPlayerId(prepared.playerId)) {
      throw new AppError(
        "UNKNOWN",
        "Player identity became unavailable before joining completed.",
      );
    }
    if (room.players.size >= room.settings.maxPlayers) {
      throw new AppError("ROOM_FULL", "Room has reached its player limit.");
    }

    const player: Player = {
      id: prepared.playerId,
      nickname: prepared.nickname,
      connectionStatus: "connected",
      status: "waiting",
      joinedAt: new Date().toISOString(),
    };

    room.players.set(prepared.playerId, {
      player,
      reconnectTokenHash: Buffer.from(prepared.reconnectTokenHash),
      socketId,
      disconnectGeneration: "0",
      reconnectDeadlineAt: null,
    });
    this.socketMemberships.set(socketId, {
      roomCode: room.code,
      playerId: prepared.playerId,
    });

    return {
      room: this.toPublicRoom(room),
      playerId: prepared.playerId,
      reconnectToken: prepared.reconnectToken,
    };
  }

  leaveRoom(roomCode: RoomCode, socketId: string): PlayerRemoval {
    const membership = this.requireMembership(roomCode, socketId);
    const room = this.requireRoom(membership.roomCode);
    return this.removePlayer(room, membership.playerId);
  }

  prepareRoomLeave(
    roomCode: RoomCode,
    socketId: string,
  ): PreparedRoomLeave {
    const membership = this.requireMembership(roomCode, socketId);
    const room = this.requireRoom(membership.roomCode);
    this.ensureRoomWritable(room);
    return {
      roomCode: room.code,
      playerId: membership.playerId,
      socketId,
      snapshot: this.captureRoomMutationSnapshot(room),
    };
  }

  commitPreparedRoomLeave(
    prepared: PreparedRoomLeave,
    persisted: PersistedRoomLeave,
  ): PlayerRemoval {
    const room = this.requireRoom(prepared.roomCode);
    this.assertRoomMutationSnapshot(room, prepared.snapshot);
    const storedPlayer = room.players.get(prepared.playerId);
    if (!storedPlayer || storedPlayer.socketId !== prepared.socketId) {
      throw new AppError("UNKNOWN", "Room membership changed before leaving completed.");
    }

    const wasHost = room.hostId === prepared.playerId;
    if (persisted.hostChanged !== wasHost || persisted.deleted !== (room.players.size === 1)) {
      throw new AppError("UNKNOWN", "Persisted room membership no longer matches runtime state.");
    }

    let nextHostId = room.hostId;
    if (persisted.hostChanged && !persisted.deleted) {
      if (
        !persisted.hostPlayerId
        || persisted.hostPlayerId === prepared.playerId
        || !room.players.has(persisted.hostPlayerId)
      ) {
        throw new AppError("UNKNOWN", "Persisted host transfer could not be applied safely.");
      }
      nextHostId = persisted.hostPlayerId;
    }

    this.socketMemberships.delete(prepared.socketId);
    room.players.delete(prepared.playerId);
    if (persisted.deleted) {
      this.rooms.delete(room.code);
      return {
        roomCode: room.code,
        playerId: prepared.playerId,
        deleted: true,
        hostChanged: persisted.hostChanged,
      };
    }

    room.hostId = nextHostId;
    return {
      roomCode: room.code,
      playerId: prepared.playerId,
      room: this.toPublicRoom(room),
      deleted: false,
      hostChanged: persisted.hostChanged,
    };
  }

  updateRoomSettings(
    payload: UpdateRoomSettingsPayload,
    socketId: string,
  ): Room {
    return this.commitPreparedWaitingRoomSettings(
      this.prepareRoomSettingsUpdate(payload, socketId),
    );
  }

  prepareRoomSettingsUpdate(
    payload: UpdateRoomSettingsPayload,
    socketId: string,
  ): PreparedWaitingRoomSettingsUpdate {
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

    return {
      roomCode: room.code,
      socketId,
      playerId: membership.playerId,
      settings: settingsResult.data,
    };
  }

  prepareManhuntSettingsUpdate(
    roomCode: RoomCode,
    socketId: string,
    settings: NonNullable<RoomSettings["manhunt"]>,
  ): PreparedWaitingRoomSettingsUpdate {
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

    const settingsResult = roomSettingsSchema.safeParse({
      ...room.settings,
      manhunt: settings,
    });
    if (!settingsResult.success) {
      throw new AppError("INVALID_PAYLOAD", "Manhunt settings are invalid.");
    }
    return {
      roomCode: room.code,
      socketId,
      playerId: membership.playerId,
      settings: settingsResult.data,
    };
  }

  commitPreparedWaitingRoomSettings(
    prepared: PreparedWaitingRoomSettingsUpdate,
  ): Room {
    const membership = this.requireMembership(
      prepared.roomCode,
      prepared.socketId,
    );
    const room = this.requireRoom(prepared.roomCode);
    this.ensureHost(room, membership.playerId);
    if (membership.playerId !== prepared.playerId) {
      throw new AppError("NOT_AUTHORIZED", "Only the current room host can update settings.");
    }
    if (room.gameStatus !== "waiting") {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Room settings cannot be changed after a game has started.",
      );
    }
    if (prepared.settings.maxPlayers < room.players.size) {
      throw new AppError(
        "ROOM_FULL",
        "The player limit cannot be lower than the current room size.",
      );
    }

    room.settings = toPublicRoomSettings(prepared.settings);
    if (prepared.settings.gameMode === "manhunt" && prepared.settings.manhunt) {
      room.manhuntBoundary = {
        center: { ...prepared.settings.manhunt.boundary.center },
        radiusMeters: prepared.settings.manhunt.boundary.radiusMeters,
      };
    } else {
      delete room.manhuntBoundary;
    }
    return this.toPublicRoom(room);
  }

  assertHost(roomCode: RoomCode, socketId: string): void {
    const membership = this.requireMembership(roomCode, socketId);
    const room = this.rooms.get(membership.roomCode);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }
    if (room.persistenceFenced) {
      throw new AppError(
        "UNKNOWN",
        "Room is unavailable pending reconciliation.",
      );
    }
    this.assertGameplayAvailable(roomCode);
    this.ensureHost(room, membership.playerId);
  }

  reserveGameStatusTransition(
    roomCode: RoomCode,
    expectedStatus: Room["gameStatus"],
    expectedGameId: GameSessionId | null,
    hostSocketId?: string,
  ): RoomGameStatusReservation {
    const room = this.rooms.get(roomCode);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }
    this.ensureRoomWritable(room);
    if (
      room.gameStatus !== expectedStatus ||
      (room.currentGameId ?? null) !== expectedGameId
    ) {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Room game status changed before the transition could be reserved.",
      );
    }

    let hostPlayerId: PlayerId | undefined;
    if (hostSocketId !== undefined) {
      const membership = this.requireMembership(roomCode, hostSocketId);
      this.ensureHost(room, membership.playerId);
      hostPlayerId = membership.playerId;
    }

    const reservation = Object.freeze({
      roomCode,
      ...(hostPlayerId ? { hostPlayerId } : {}),
    });
    this.gameStatusReservations.set(roomCode, reservation);
    return reservation;
  }

  releaseGameStatusReservation(
    reservation: RoomGameStatusReservation,
  ): void {
    if (this.gameStatusReservations.get(reservation.roomCode) === reservation) {
      this.gameStatusReservations.delete(reservation.roomCode);
      this.drainDeferredRoomMutations(reservation.roomCode);
    }
  }

  isGameStatusReserved(roomCode: RoomCode): boolean {
    return this.gameStatusReservations.has(roomCode);
  }

  deferRoomMutation<T>(
    roomCode: RoomCode,
    operation: (reservation: RoomGameStatusReservation) => Promise<T>,
    reconcile?: (
      reservation: RoomGameStatusReservation,
      resolve: (value: T) => void,
    ) => Promise<"complete" | "retry">,
  ): Promise<T> {
    let queue = this.deferredRoomMutations.get(roomCode);
    if (queue && queue.pending.length >= 128) {
      throw new DeferredRoomMutationCapacityError();
    }
    if (!queue) {
      queue = { pending: [], draining: false, blocked: false };
      this.deferredRoomMutations.set(roomCode, queue);
    }

    const result = new Promise<T>((resolve, reject) => {
      let settled = false;
      let resolveDeferred!: (value: T) => void;
      let rejectDeferred!: (error: unknown) => void;
      queue!.pending.push({
        run: async (reservation) => {
          const value = await operation(reservation);
          if (!settled) {
            settled = true;
            resolveDeferred(value);
          }
        },
        reconcile: reconcile
          ? async (reservation) => reconcile(reservation, (value) => {
            if (!settled) {
              settled = true;
              resolveDeferred(value);
            }
          })
          : undefined,
        reject: (error) => {
          if (!settled) {
            settled = true;
            rejectDeferred(error);
          }
        },
        isSettled: () => settled,
      });
      resolveDeferred = resolve;
      rejectDeferred = reject;
    });
    this.drainDeferredRoomMutations(roomCode);
    return result;
  }

  onDeferredRoomMutationBlocked(
    listener: (roomCode: RoomCode) => void,
  ): () => void {
    this.deferredMutationBlockedListeners.add(listener);
    return () => this.deferredMutationBlockedListeners.delete(listener);
  }

  onExpiredRoom(
    listener: (room: ExpiredRoomSnapshot) => void | Promise<void>,
  ): () => void {
    this.expiredRoomListeners.add(listener);
    return () => this.expiredRoomListeners.delete(listener);
  }

  rejectBlockedDeferredRoomMutations(error: unknown): void {
    for (const [roomCode, queue] of this.deferredRoomMutations) {
      if (!queue.blocked) {
        continue;
      }
      for (const mutation of queue.pending) {
        mutation.reject(error);
      }
    }
  }

  hasBlockedDeferredRoomMutations(roomCode: RoomCode): boolean {
    return this.deferredRoomMutations.get(roomCode)?.blocked ?? false;
  }

  suspendGameplay(
    roomCode: RoomCode,
    scope: GameplaySuspensionScope,
    reason: GameplaySuspension["reason"],
  ): GameplaySuspension {
    const existing = this.gameplaySuspensions.get(scope.roomId);
    if (existing) {
      return existing;
    }

    const suspension: GameplaySuspension = Object.freeze({
      roomCode,
      roomId: scope.roomId,
      gameId: scope.gameId,
      reason,
      suspendedAt: new Date().toISOString(),
    });
    this.gameplaySuspensions.set(scope.roomId, suspension);
    if (scope.gameId) {
      this.suspendedGameIds.set(scope.gameId, suspension);
    }

    for (const listener of this.gameplaySuspensionListeners) {
      try {
        listener(suspension);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "gameplay_suspension_listener_failed",
            roomCode,
            roomId: scope.roomId,
            gameId: scope.gameId,
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
      }
    }
    return suspension;
  }

  getGameplaySuspensionScope(
    roomCode: RoomCode,
    gameId: GameSessionId | null,
  ): GameplaySuspensionScope | undefined {
    const room = this.rooms.get(roomCode);
    return room
      ? { roomId: room.durableRoomId, gameId }
      : undefined;
  }

  onGameplaySuspended(
    listener: (suspension: GameplaySuspension) => void,
  ): () => void {
    this.gameplaySuspensionListeners.add(listener);
    return () => this.gameplaySuspensionListeners.delete(listener);
  }

  isGameplaySuspended(
    roomCode: RoomCode,
    gameId?: GameSessionId | null,
  ): boolean {
    const room = this.rooms.get(roomCode);
    if (room && this.gameplaySuspensions.has(room.durableRoomId)) {
      return true;
    }
    return gameId ? this.suspendedGameIds.has(gameId) : false;
  }

  assertGameplayAvailable(
    roomCode: RoomCode,
    gameId?: GameSessionId | null,
  ): void {
    if (this.isGameplaySuspended(roomCode, gameId)) {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Gameplay is temporarily unavailable for this room.",
      );
    }
  }

  getGameplaySuspensions(): readonly GameplaySuspension[] {
    return [...this.gameplaySuspensions.values()];
  }

  claimDisconnectTimeout(
    roomCode: RoomCode,
    playerId: PlayerId,
    owner: symbol,
  ): boolean {
    const key = `${roomCode}\u0000${playerId}`;
    const currentOwner = this.disconnectTimeoutOwners.get(key);
    if (currentOwner !== undefined && currentOwner !== owner) {
      return false;
    }
    this.disconnectTimeoutOwners.set(key, owner);
    return true;
  }

  releaseDisconnectTimeout(
    roomCode: RoomCode,
    playerId: PlayerId,
    owner: symbol,
  ): void {
    const key = `${roomCode}\u0000${playerId}`;
    if (this.disconnectTimeoutOwners.get(key) === owner) {
      this.disconnectTimeoutOwners.delete(key);
    }
  }

  async reconcileDeferredRoomMutations(roomCode: RoomCode): Promise<boolean> {
    const queue = this.deferredRoomMutations.get(roomCode);
    const mutation = queue?.pending[0];
    if (
      !queue
      || !mutation
      || !queue.blocked
      || queue.draining
      || this.gameStatusReservations.has(roomCode)
    ) {
      return false;
    }
    if (!mutation.reconcile) {
      throw new AppError(
        "FEATURE_UNAVAILABLE",
        "The blocked room mutation has no reconciliation procedure.",
      );
    }

    const reservation = Object.freeze({ roomCode });
    queue.draining = true;
    this.gameStatusReservations.set(roomCode, reservation);
    try {
      const result = await mutation.reconcile(reservation);
      if (result === "retry") {
        await mutation.run(reservation);
      } else if (!mutation.isSettled()) {
        throw new Error("Deferred mutation reconciliation completed without a result.");
      }
      if (queue.pending[0] === mutation) {
        queue.pending.shift();
      }
      queue.blocked = false;
      this.finishDeferredRoomMutation(roomCode, queue, reservation, true);
      return true;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "deferred_room_mutation_reconciliation_failed",
          roomCode,
          error: error instanceof AppError
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown",
        }),
      );
      this.finishDeferredRoomMutation(roomCode, queue, reservation, false);
      this.notifyDeferredMutationBlocked(roomCode);
      throw error;
    }
  }

  assertGameStatusTransitionWritable(
    roomCode: RoomCode,
    reservation?: RoomGameStatusReservation,
  ): void {
    const room = this.rooms.get(roomCode);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }
    this.ensureRoomWritable(room, reservation);
  }

  updateManhuntSettings(
    roomCode: RoomCode,
    socketId: string,
    settings: NonNullable<RoomSettings["manhunt"]>,
  ): Room {
    return this.commitPreparedWaitingRoomSettings(
      this.prepareManhuntSettingsUpdate(roomCode, socketId, settings),
    );
  }

  getManhuntBoundary(roomCode: RoomCode): ManhuntBoundary | undefined {
    const room = this.rooms.get(roomCode);
    return room?.manhuntBoundary
      ? {
          center: { ...room.manhuntBoundary.center },
          radiusMeters: room.manhuntBoundary.radiusMeters,
        }
      : undefined;
  }

  restoreWaitingRoom(recovered: RecoverableWaitingRoom): Room {
    const roomCode = roomCodeSchema.parse(recovered.roomCode);
    if (this.gameplaySuspensions.has(recovered.roomId)) {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Gameplay is temporarily unavailable for this room.",
      );
    }
    if (this.rooms.has(roomCode)) {
      throw new Error(`Room ${roomCode} is already registered.`);
    }
    if (
      recovered.lifecycleStatus !== "active" ||
      recovered.gameStatus !== "waiting" ||
      recovered.hostPlayerId === null
    ) {
      throw new Error("Only active waiting rooms with a host can be recovered.");
    }
    const boundary = recovered.privateManhuntBoundary;
    let candidateSettings: unknown;
    if (recovered.gameMode === "manhunt") {
      if (boundary === null) {
        throw new Error("Recovered Manhunt room is missing its private boundary.");
      }
      const manhuntSettings = recovered.settings.manhunt;
      if (!manhuntSettings) {
        throw new Error("Recovered Manhunt room is missing its settings.");
      }
      candidateSettings = {
        ...recovered.settings,
        manhunt: {
          ...manhuntSettings,
          boundary: {
            center: { ...boundary.center },
            radiusMeters: boundary.radiusMeters,
          },
        },
      };
    } else {
      if (boundary !== null) {
        throw new Error("Recovered non-Manhunt room has a private boundary.");
      }
      candidateSettings = recovered.settings;
    }
    const settings = roomSettingsSchema.parse(candidateSettings);
    if (
      settings.gameMode !== recovered.gameMode ||
      settings.maxPlayers !== recovered.maxPlayers
    ) {
      throw new Error("Recovered room settings do not match persisted metadata.");
    }

    const players = new Map<PlayerId, StoredPlayer>();
    for (const member of recovered.members) {
      if (
        member.membershipStatus !== "active" ||
        member.connectionStatus !== "disconnected" ||
        member.reconnectDeadlineAt === null
      ) {
        throw new Error("Recovered waiting-room members must be disconnected.");
      }
      const nickname = nicknameSchema.parse(member.nickname);
      if (
        !Number.isFinite(member.joinedAt.getTime()) ||
        !Number.isFinite(member.reconnectDeadlineAt.getTime()) ||
        member.reconnectTokenHash.length !== 32
      ) {
        throw new Error("Recovered waiting-room member data is invalid.");
      }
      if (players.has(member.playerId)) {
        throw new Error("Recovered waiting room contains duplicate members.");
      }
      for (const room of this.rooms.values()) {
        if (room.players.has(member.playerId)) {
          throw new Error("Recovered player is already registered in another room.");
        }
      }

      players.set(member.playerId, {
        player: {
          id: member.playerId,
          nickname,
          status: "waiting",
          connectionStatus: "disconnected",
          joinedAt: member.joinedAt.toISOString(),
        },
        reconnectTokenHash: Buffer.from(member.reconnectTokenHash),
        disconnectGeneration: member.disconnectGeneration,
        reconnectDeadlineAt: new Date(member.reconnectDeadlineAt.getTime()),
      });
    }
    if (!players.has(recovered.hostPlayerId)) {
      throw new Error("Recovered room host is not an active member.");
    }

    const room: RoomRecord = {
      code: roomCode,
      durableRoomId: recovered.roomId,
      hostId: recovered.hostPlayerId,
      players,
      settings: {
        gameMode: settings.gameMode,
        maxPlayers: settings.maxPlayers,
        isPrivate: settings.isPrivate,
        ...(settings.classicImpostor
          ? { classicImpostor: { ...settings.classicImpostor } }
          : {}),
        ...(settings.wordImpostor
          ? { wordImpostor: { ...settings.wordImpostor } }
          : {}),
        ...(settings.manhunt
          ? {
              manhunt: {
                hunterCount: settings.manhunt.hunterCount,
                ...(settings.manhunt.gameDurationSeconds
                  ? { gameDurationSeconds: settings.manhunt.gameDurationSeconds }
                  : {}),
              },
            }
          : {}),
      },
      ...(boundary
        ? {
            manhuntBoundary: {
              center: { ...boundary.center },
              radiusMeters: boundary.radiusMeters,
            },
          }
        : {}),
      gameStatus: "waiting",
      ...(recovered.currentGameId
        ? { currentGameId: recovered.currentGameId }
        : {}),
      createdAt: recovered.createdAt.toISOString(),
      persistenceFenced: false,
    };
    this.rooms.set(room.code, room);
    return this.toPublicRoom(room);
  }

  async removeExpiredWaitingRoom(
    roomCode: RoomCode,
    roomId: string,
  ): Promise<ExpiredRoomRemovalResult> {
    const room = this.rooms.get(roomCode);
    if (!room) {
      return { status: "absent" };
    }
    if (room.durableRoomId !== roomId) {
      return { status: "replaced" };
    }
    if (
      !room.persistenceFenced
      || room.gameStatus !== "waiting"
      || room.currentGameId !== undefined
      || this.gameStatusReservations.has(roomCode)
      || this.deferredRoomMutations.has(roomCode)
    ) {
      return { status: "blocked" };
    }

    const playerIds = [...room.players.keys()];
    const socketIds = [...room.players.values()]
      .flatMap((player) => player.socketId ? [player.socketId] : []);
    const snapshot: ExpiredRoomSnapshot = {
      roomCode,
      roomId,
      playerIds,
      socketIds,
    };
    for (const listener of this.expiredRoomListeners) {
      await listener(snapshot);
    }

    for (const player of room.players.values()) {
      if (player.socketId) {
        this.socketMemberships.delete(player.socketId);
      }
      this.disconnectTimeoutOwners.delete(`${roomCode}\u0000${player.player.id}`);
    }
    this.rooms.delete(roomCode);
    return { status: "removed" };
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

  getRoomCodeForSocket(socketId: string): RoomCode | undefined {
    return this.socketMemberships.get(socketId)?.roomCode;
  }

  beginGame(
    roomCode: RoomCode,
    socketId: string,
    gameId: GameSessionId,
    reservation?: RoomGameStatusReservation,
  ): Room {
    const membership = this.requireMembership(roomCode, socketId);
    const room = this.requireRoom(membership.roomCode, reservation);
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

  beginImpostorGame(
    roomCode: RoomCode,
    socketId: string,
    gameId: GameSessionId,
    gameMode: ImpostorGameMode,
    reservation?: RoomGameStatusReservation,
  ): Room {
    const membership = this.requireMembership(roomCode, socketId);
    const room = this.requireRoom(membership.roomCode, reservation);
    this.ensureHost(room, membership.playerId);
    if (room.settings.gameMode !== gameMode) {
      throw new AppError(
        "GAME_NOT_READY",
        "The room is configured for a different game mode.",
      );
    }
    if (room.gameStatus !== "waiting") {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Return the finished game to the lobby before starting another.",
      );
    }
    return this.beginGame(roomCode, socketId, gameId, reservation);
  }

  beginManhuntCountdown(
    roomCode: RoomCode,
    socketId: string,
    gameId: GameSessionId,
    reservation?: RoomGameStatusReservation,
  ): Room {
    const membership = this.requireMembership(roomCode, socketId);
    const room = this.requireRoom(membership.roomCode, reservation);
    this.ensureHost(room, membership.playerId);
    if (room.gameStatus === "starting" || room.gameStatus === "in_progress") {
      throw new AppError("GAME_NOT_ACTIVE", "A game is already in progress.");
    }

    room.gameStatus = "starting";
    room.currentGameId = gameId;
    return this.toPublicRoom(room);
  }

  activateGame(
    roomCode: RoomCode,
    gameId: GameSessionId,
    reservation?: RoomGameStatusReservation,
  ): Room {
    const room = this.rooms.get(roomCode);
    if (room) {
      this.ensureRoomWritable(room, reservation);
    }
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
    reservation?: RoomGameStatusReservation,
  ): Room | undefined {
    const room = this.rooms.get(roomCode);
    if (room) {
      this.ensureRoomWritable(room, reservation);
    }
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
    if (room) {
      this.ensureRoomWritable(room);
    }
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
    if (room) {
      this.ensureRoomWritable(room);
    }
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

  finishGame(
    roomCode: RoomCode,
    gameId: GameSessionId,
    reservation?: RoomGameStatusReservation,
  ): Room | undefined {
    const room = this.rooms.get(roomCode);
    if (room) {
      this.ensureRoomWritable(room, reservation);
    }
    if (!room || room.currentGameId !== gameId) {
      return undefined;
    }
    if (room.gameStatus === "finished") {
      return this.toPublicRoom(room);
    }
    if (room.gameStatus !== "starting" && room.gameStatus !== "in_progress") {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Only a starting or active game can be finished.",
      );
    }
    room.gameStatus = "finished";
    return this.toPublicRoom(room);
  }

  returnFinishedGameToLobby(
    roomCode: RoomCode,
    socketId: string,
    gameId: GameSessionId,
    reservation?: RoomGameStatusReservation,
  ): Room {
    const membership = this.requireMembership(roomCode, socketId);
    const room = this.requireRoom(membership.roomCode, reservation);
    this.ensureHost(room, membership.playerId);
    this.ensureRoomWritable(room, reservation);
    if (
      room.gameStatus !== "finished" ||
      room.currentGameId !== gameId ||
      !["impostor-classic", "impostor-word", "manhunt"].includes(
        room.settings.gameMode,
      )
    ) {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Only the finished room game can return to the lobby.",
      );
    }

    room.gameStatus = "waiting";
    room.currentGameId = undefined;
    for (const storedPlayer of room.players.values()) {
      storedPlayer.player.status = "waiting";
    }
    return this.toPublicRoom(room);
  }

  returnFinishedImpostorGameToLobby(
    roomCode: RoomCode,
    socketId: string,
    gameId: GameSessionId,
    reservation?: RoomGameStatusReservation,
  ): Room {
    const room = this.rooms.get(roomCode);
    if (
      !room
      || (room.settings.gameMode !== "impostor-classic"
        && room.settings.gameMode !== "impostor-word")
    ) {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Only an Impostor game can return to the lobby through this operation.",
      );
    }
    return this.returnFinishedGameToLobby(
      roomCode,
      socketId,
      gameId,
      reservation,
    );
  }

  prepareRoomReconnect(
    payload: ReconnectPayload,
    socketId: string,
  ): PreparedRoomReconnect {
    const room = this.rooms.get(payload.roomCode);
    if (room) {
      this.ensureRoomWritable(room, undefined, false, true);
    }
    const storedPlayer = room?.players.get(payload.playerId);
    if (!room || !storedPlayer) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Reconnect credentials are invalid or expired.",
      );
    }

    const suppliedHash = this.hashReconnectToken(payload.reconnectToken);
    if (
      suppliedHash.length !== storedPlayer.reconnectTokenHash.length
      || !timingSafeEqual(storedPlayer.reconnectTokenHash, suppliedHash)
    ) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "Reconnect credentials are invalid or expired.",
      );
    }

    const currentMembership = this.socketMemberships.get(socketId);
    if (
      currentMembership
      && (
        currentMembership.roomCode !== room.code
        || currentMembership.playerId !== storedPlayer.player.id
      )
    ) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "This connection is already a member of another room.",
      );
    }

    return {
      roomCode: room.code,
      playerId: storedPlayer.player.id,
      socketId,
      reconnectToken: payload.reconnectToken,
      snapshot: this.captureRoomMutationSnapshot(room),
    };
  }

  commitPreparedRoomReconnect(
    prepared: PreparedRoomReconnect,
    disconnectGeneration: string,
  ): ReconnectResult {
    const room = this.requireRoom(prepared.roomCode, undefined, false, true);
    this.assertRoomMutationSnapshot(room, prepared.snapshot);
    const storedPlayer = room.players.get(prepared.playerId);
    if (!storedPlayer) {
      throw new AppError("NOT_AUTHORIZED", "Reconnect credentials are invalid or expired.");
    }

    const suppliedHash = this.hashReconnectToken(prepared.reconnectToken);
    if (
      suppliedHash.length !== storedPlayer.reconnectTokenHash.length
      || !timingSafeEqual(storedPlayer.reconnectTokenHash, suppliedHash)
    ) {
      throw new AppError("NOT_AUTHORIZED", "Reconnect credentials are invalid or expired.");
    }
    if (
      !/^\d+$/.test(disconnectGeneration)
      || BigInt(disconnectGeneration) !== BigInt(storedPlayer.disconnectGeneration) + 1n
    ) {
      throw new AppError("UNKNOWN", "Persisted reconnect generation is inconsistent.");
    }

    const currentMembership = this.socketMemberships.get(prepared.socketId);
    if (
      currentMembership
      && (
        currentMembership.roomCode !== room.code
        || currentMembership.playerId !== storedPlayer.player.id
      )
    ) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "This connection is already a member of another room.",
      );
    }

    const previousSocketId = storedPlayer.socketId;
    if (previousSocketId && previousSocketId !== prepared.socketId) {
      this.socketMemberships.delete(previousSocketId);
    }

    storedPlayer.socketId = prepared.socketId;
    storedPlayer.player.connectionStatus = "connected";
    storedPlayer.disconnectGeneration = disconnectGeneration;
    storedPlayer.reconnectDeadlineAt = null;
    this.socketMemberships.set(prepared.socketId, {
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
        previousSocketId === prepared.socketId ? undefined : previousSocketId,
    };
  }

  reconnect(
    payload: ReconnectPayload,
    socketId: string,
  ): ReconnectResult {
    const room = this.rooms.get(payload.roomCode);
    if (room) {
      this.ensureRoomWritable(room, undefined, false, true);
    }
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
    storedPlayer.reconnectDeadlineAt = null;
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

    const room = this.rooms.get(membership.roomCode);
    const storedPlayer = room?.players.get(membership.playerId);
    if (!room || !storedPlayer || storedPlayer.socketId !== socketId) {
      return undefined;
    }
    this.ensureRoomWritable(room);

    this.socketMemberships.delete(socketId);
    storedPlayer.socketId = undefined;
    storedPlayer.player.connectionStatus = "disconnected";
    return {
      roomCode: room.code,
      playerId: storedPlayer.player.id,
      room: this.toPublicRoom(room),
    };
  }

  prepareSocketDisconnect(
    socketId: string,
    reservation?: RoomGameStatusReservation,
  ): PreparedRoomDisconnect | undefined {
    const membership = this.socketMemberships.get(socketId);
    if (!membership) {
      return undefined;
    }

    const room = this.rooms.get(membership.roomCode);
    const storedPlayer = room?.players.get(membership.playerId);
    if (!room || !storedPlayer || storedPlayer.socketId !== socketId) {
      return undefined;
    }
    this.ensureRoomWritable(room, reservation);
    if (storedPlayer.player.connectionStatus !== "connected") {
      return undefined;
    }

    return {
      roomCode: room.code,
      playerId: storedPlayer.player.id,
      socketId,
      snapshot: this.captureRoomMutationSnapshot(room),
    };
  }

  commitPreparedSocketDisconnect(
    prepared: PreparedRoomDisconnect,
    persisted: PersistedDisconnect,
    reservation?: RoomGameStatusReservation,
  ): PlayerDisconnect {
    return this.commitPreparedSocketDisconnectCore(prepared, persisted, reservation, false);
  }

  commitReconciledSocketDisconnect(
    prepared: PreparedRoomDisconnect,
    persisted: PersistedDisconnect,
    reservation: RoomGameStatusReservation,
  ): PlayerDisconnect {
    return this.commitPreparedSocketDisconnectCore(prepared, persisted, reservation, true);
  }

  private commitPreparedSocketDisconnectCore(
    prepared: PreparedRoomDisconnect,
    persisted: PersistedDisconnect,
    reservation: RoomGameStatusReservation | undefined,
    allowFenced: boolean,
  ): PlayerDisconnect {
    const room = this.requireRoom(prepared.roomCode, reservation, allowFenced);
    this.assertRoomMutationSnapshot(room, prepared.snapshot);
    const storedPlayer = room.players.get(prepared.playerId);
    if (
      !storedPlayer
      || storedPlayer.socketId !== prepared.socketId
      || storedPlayer.player.connectionStatus !== "connected"
    ) {
      throw new AppError("UNKNOWN", "Room membership changed before disconnect completed.");
    }
    if (
      !Number.isFinite(persisted.reconnectDeadlineAt.getTime())
      || !/^\d+$/.test(persisted.disconnectGeneration)
      || BigInt(persisted.disconnectGeneration)
        !== BigInt(storedPlayer.disconnectGeneration) + 1n
    ) {
      throw new AppError("UNKNOWN", "Persisted disconnect state is inconsistent.");
    }

    this.socketMemberships.delete(prepared.socketId);
    storedPlayer.socketId = undefined;
    storedPlayer.player.connectionStatus = "disconnected";
    storedPlayer.disconnectGeneration = persisted.disconnectGeneration;
    storedPlayer.reconnectDeadlineAt = new Date(persisted.reconnectDeadlineAt);
    return {
      roomCode: room.code,
      playerId: storedPlayer.player.id,
      room: this.toPublicRoom(room),
      disconnectGeneration: storedPlayer.disconnectGeneration,
      reconnectDeadlineAt: new Date(persisted.reconnectDeadlineAt),
    };
  }

  removeDisconnectedPlayer(
    roomCode: RoomCode,
    playerId: PlayerId,
  ): PlayerRemoval | undefined {
    const room = this.rooms.get(roomCode);
    const storedPlayer = room?.players.get(playerId);
    if (room && this.gameStatusReservations.has(roomCode)) {
      this.ensureRoomWritable(room);
    }
    if (
      !room ||
      room.persistenceFenced ||
      !storedPlayer ||
      storedPlayer.socketId !== undefined ||
      storedPlayer.player.connectionStatus !== "disconnected"
    ) {
      return undefined;
    }

    return this.removePlayer(room, playerId);
  }

  prepareDisconnectedPlayerRemoval(
    roomCode: RoomCode,
    playerId: PlayerId,
    disconnectGeneration: string,
    reconnectDeadlineAt: Date,
    reservation?: RoomGameStatusReservation,
  ): PreparedDisconnectedPlayerRemoval | undefined {
    const room = this.rooms.get(roomCode);
    const storedPlayer = room?.players.get(playerId);
    if (!room || !storedPlayer) {
      return undefined;
    }
    this.ensureRoomWritable(room, reservation);
    if (
      !/^\d+$/.test(disconnectGeneration)
      || !(reconnectDeadlineAt instanceof Date)
      || !Number.isFinite(reconnectDeadlineAt.getTime())
    ) {
      throw new AppError("INVALID_PAYLOAD", "Reconnect timeout state is invalid.");
    }

    return {
      roomCode,
      playerId,
      disconnectGeneration,
      reconnectDeadlineAt: new Date(reconnectDeadlineAt),
      snapshot: this.captureRoomMutationSnapshot(room),
    };
  }

  commitPreparedDisconnectedPlayerRemoval(
    prepared: PreparedDisconnectedPlayerRemoval,
    persisted: PersistedPlayerRemoval,
    reservation?: RoomGameStatusReservation,
  ): PlayerRemoval {
    return this.commitPreparedDisconnectedPlayerRemovalCore(prepared, persisted, reservation, false);
  }

  commitReconciledDisconnectedPlayerRemoval(
    prepared: PreparedDisconnectedPlayerRemoval,
    persisted: PersistedPlayerRemoval,
    reservation: RoomGameStatusReservation,
  ): PlayerRemoval {
    return this.commitPreparedDisconnectedPlayerRemovalCore(prepared, persisted, reservation, true);
  }

  private commitPreparedDisconnectedPlayerRemovalCore(
    prepared: PreparedDisconnectedPlayerRemoval,
    persisted: PersistedPlayerRemoval,
    reservation: RoomGameStatusReservation | undefined,
    allowFenced: boolean,
  ): PlayerRemoval {
    const room = this.requireRoom(prepared.roomCode, reservation, allowFenced);
    this.assertRoomMutationSnapshot(room, prepared.snapshot);
    const storedPlayer = room.players.get(prepared.playerId);
    if (
      !storedPlayer
      || storedPlayer.socketId !== undefined
      || storedPlayer.player.connectionStatus !== "disconnected"
      || storedPlayer.disconnectGeneration !== prepared.disconnectGeneration
      || storedPlayer.reconnectDeadlineAt?.getTime()
        !== prepared.reconnectDeadlineAt.getTime()
    ) {
      throw new AppError(
        "UNKNOWN",
        "Disconnected membership changed before timeout removal completed.",
      );
    }

    const wasHost = room.hostId === prepared.playerId;
    if (persisted.hostChanged !== wasHost || persisted.deleted !== (room.players.size === 1)) {
      throw new AppError("UNKNOWN", "Persisted room membership no longer matches runtime state.");
    }
    let nextHostId = room.hostId;
    if (persisted.hostChanged && !persisted.deleted) {
      if (
        !persisted.hostPlayerId
        || persisted.hostPlayerId === prepared.playerId
        || !room.players.has(persisted.hostPlayerId)
      ) {
        throw new AppError("UNKNOWN", "Persisted host transfer could not be applied safely.");
      }
      nextHostId = persisted.hostPlayerId;
    }

    room.players.delete(prepared.playerId);
    const suspensionScope: GameplaySuspensionScope = {
      roomId: room.durableRoomId,
      gameId: room.currentGameId ?? null,
    };
    if (persisted.deleted) {
      this.rooms.delete(room.code);
      return {
        roomCode: room.code,
        playerId: prepared.playerId,
        deleted: true,
        hostChanged: persisted.hostChanged,
        suspensionScope,
      };
    }
    room.hostId = nextHostId;
    return {
      roomCode: room.code,
      playerId: prepared.playerId,
      room: this.toPublicRoom(room),
      deleted: false,
      hostChanged: persisted.hostChanged,
      suspensionScope,
    };
  }

  getPublicRoom(roomCode: RoomCode): Room | undefined {
    const room = this.rooms.get(roomCode);
    return room ? this.toPublicRoom(room) : undefined;
  }

  listDisconnectedPlayerTimeouts(): DisconnectedPlayerTimeout[] {
    const timeouts: DisconnectedPlayerTimeout[] = [];
    for (const room of this.rooms.values()) {
      for (const storedPlayer of room.players.values()) {
        if (
          storedPlayer.player.connectionStatus === "disconnected"
          && storedPlayer.reconnectDeadlineAt
        ) {
          timeouts.push({
            roomCode: room.code,
            playerId: storedPlayer.player.id,
            disconnectGeneration: storedPlayer.disconnectGeneration,
            reconnectDeadlineAt: new Date(storedPlayer.reconnectDeadlineAt),
          });
        }
      }
    }
    return timeouts;
  }

  fenceRoom(roomCode: RoomCode): void {
    const room = this.rooms.get(roomCode);
    if (room) {
      room.persistenceFenced = true;
    }
  }

  clearPersistenceFence(
    roomCode: RoomCode,
    reservation: RoomGameStatusReservation,
  ): void {
    if (this.gameStatusReservations.get(roomCode) !== reservation) {
      throw new AppError("UNKNOWN", "Room reconciliation lost its reservation.");
    }
    const room = this.rooms.get(roomCode);
    if (room) {
      room.persistenceFenced = false;
    }
  }

  assertReconciledRoomSnapshot(
    snapshot: RoomMutationSnapshot,
    reservation: RoomGameStatusReservation,
  ): void {
    if (this.gameStatusReservations.get(snapshot.roomCode) !== reservation) {
      throw new AppError("UNKNOWN", "Room reconciliation lost its reservation.");
    }
    const room = this.rooms.get(snapshot.roomCode);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }
    this.assertRoomMutationSnapshot(room, snapshot);
  }

  private captureRoomMutationSnapshot(room: RoomRecord): RoomMutationSnapshot {
    return {
      roomCode: room.code,
      hostId: room.hostId,
      createdAt: room.createdAt,
      players: [...room.players.entries()].map(([playerId, storedPlayer]) => ({
        playerId,
        connectionStatus: storedPlayer.player.connectionStatus,
        ...(storedPlayer.socketId !== undefined
          ? { socketId: storedPlayer.socketId }
          : {}),
        disconnectGeneration: storedPlayer.disconnectGeneration,
        reconnectDeadlineAt: storedPlayer.reconnectDeadlineAt?.getTime() ?? null,
      })),
    };
  }

  private assertRoomMutationSnapshot(
    room: RoomRecord,
    snapshot: RoomMutationSnapshot,
  ): void {
    const current = this.captureRoomMutationSnapshot(room);
    if (
      current.roomCode !== snapshot.roomCode
      || current.hostId !== snapshot.hostId
      || current.createdAt !== snapshot.createdAt
      || current.players.length !== snapshot.players.length
      || current.players.some((player, index) => {
        const previous = snapshot.players[index];
        return (
          !previous
          || player.playerId !== previous.playerId
          || player.connectionStatus !== previous.connectionStatus
          || player.socketId !== previous.socketId
          || player.disconnectGeneration !== previous.disconnectGeneration
          || player.reconnectDeadlineAt !== previous.reconnectDeadlineAt
        );
      })
    ) {
      throw new AppError("UNKNOWN", "Room changed before the durable operation completed.");
    }
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

  assertRoomNotReserved(roomCode: RoomCode): void {
    const room = this.rooms.get(roomCode);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }
    this.ensureRoomWritable(room);
  }

  private requireRoom(
    roomCode: RoomCode,
    reservation?: RoomGameStatusReservation,
    allowFenced = false,
    allowGameplaySuspended = false,
  ): RoomRecord {
    const room = this.rooms.get(roomCode);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }
    this.ensureRoomWritable(
      room,
      reservation,
      allowFenced,
      allowGameplaySuspended,
    );
    return room;
  }

  private ensureRoomWritable(
    room: RoomRecord,
    reservation?: RoomGameStatusReservation,
    allowFenced = false,
    allowGameplaySuspended = false,
  ): void {
    if (room.persistenceFenced && !allowFenced) {
      throw new AppError(
        "UNKNOWN",
        "Room is unavailable pending reconciliation.",
      );
    }
    if (
      !allowGameplaySuspended
      && this.gameplaySuspensions.has(room.durableRoomId)
    ) {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Gameplay is temporarily unavailable for this room.",
      );
    }
    const activeReservation = this.gameStatusReservations.get(room.code);
    if (activeReservation && activeReservation !== reservation) {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Room is reserved for a game-status transition.",
      );
    }
  }

  private drainDeferredRoomMutations(roomCode: RoomCode): void {
    const queue = this.deferredRoomMutations.get(roomCode);
    if (
      !queue
      || queue.draining
      || queue.blocked
      || queue.pending.length === 0
      || this.gameStatusReservations.has(roomCode)
    ) {
      return;
    }

    const mutation = queue.pending[0]!;
    const reservation = Object.freeze({ roomCode });
    queue.draining = true;
    this.gameStatusReservations.set(roomCode, reservation);

    void Promise.resolve()
      .then(() => mutation.run(reservation))
      .then(
        () => {
          if (queue.pending[0] === mutation) {
            queue.pending.shift();
          }
          this.finishDeferredRoomMutation(roomCode, queue, reservation, true);
        },
        (error: unknown) => {
          queue.blocked = true;
          this.fenceRoom(roomCode);
          console.error(
            JSON.stringify({
              level: "error",
              event: "deferred_room_mutation_failed",
              roomCode,
              error: error instanceof AppError
                ? error.code
                : error instanceof Error
                  ? error.name
                  : "unknown",
            }),
          );
          this.finishDeferredRoomMutation(roomCode, queue, reservation, false);
          this.notifyDeferredMutationBlocked(roomCode);
        },
      );
  }

  private finishDeferredRoomMutation(
    roomCode: RoomCode,
    queue: DeferredRoomMutationQueue,
    reservation: RoomGameStatusReservation,
    succeeded: boolean,
  ): void {
    if (this.gameStatusReservations.get(roomCode) === reservation) {
      this.gameStatusReservations.delete(roomCode);
    }
    queue.draining = false;
    if (
      queue.pending.length === 0
      && this.deferredRoomMutations.get(roomCode) === queue
    ) {
      this.deferredRoomMutations.delete(roomCode);
    } else if (succeeded) {
      this.drainDeferredRoomMutations(roomCode);
    }
  }

  private notifyDeferredMutationBlocked(roomCode: RoomCode): void {
    for (const listener of this.deferredMutationBlockedListeners) {
      try {
        listener(roomCode);
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "deferred_room_mutation_listener_failed",
            roomCode,
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }
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
    const publicSettings: PublicRoomSettings = {
      gameMode: room.settings.gameMode,
      maxPlayers: room.settings.maxPlayers,
      isPrivate: room.settings.isPrivate,
      ...(room.settings.classicImpostor
        ? { classicImpostor: { ...room.settings.classicImpostor } }
        : {}),
      ...(room.settings.wordImpostor
        ? { wordImpostor: { ...room.settings.wordImpostor } }
        : {}),
      ...(room.settings.manhunt
        ? {
            manhunt: {
              hunterCount: room.settings.manhunt.hunterCount,
              ...(room.settings.manhunt.gameDurationSeconds
                ? { gameDurationSeconds: room.settings.manhunt.gameDurationSeconds }
                : {}),
            },
          }
        : {}),
    };
    return {
      code: room.code,
      hostId: room.hostId,
      players: [...room.players.values()].map(({ player }) => ({
        ...player,
      })),
      settings: publicSettings,
      gameStatus: room.gameStatus,
      ...(room.currentGameId ? { currentGameId: room.currentGameId } : {}),
      createdAt: room.createdAt,
    };
  }

  private generateRoomCode(
    excludedCodes: ReadonlySet<RoomCode> = new Set(),
  ): RoomCode {
    for (let attempt = 0; attempt < MAX_ROOM_CODE_ATTEMPTS; attempt += 1) {
      let code = this.roomCodeFactory?.() ?? "";
      if (!this.roomCodeFactory) {
        for (let character = 0; character < ROOM_CODE_LENGTH; character += 1) {
          code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
        }
      }
      if (!this.rooms.has(code) && !excludedCodes.has(code)) {
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
    while (this.hasPlayerId(playerId)) {
      playerId = randomUUID();
    }
    return playerId;
  }

  private hasPlayerId(playerId: PlayerId): boolean {
    return [...this.rooms.values()].some((room) => room.players.has(playerId));
  }

  private generateReconnectToken(): string {
    return randomBytes(32).toString("base64url");
  }

  private hashReconnectToken(token: string): Buffer {
    return createHash("sha256").update(token).digest();
  }
}
