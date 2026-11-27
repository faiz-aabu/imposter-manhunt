import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  nicknameSchema,
  roomCodeSchema,
  roomSettingsSchema,
} from "@impostor/api";
import type {
  ConnectionStatus,
  GameMode,
  GameSessionId,
  GameStatus,
  ManhuntBoundary,
  PlayerId,
  RoomCode,
  RoomSettings,
} from "@impostor/api";
import { withPostgresTransaction } from "../db/postgres.js";
import type { Pool, PoolClient, QueryResultRow } from "pg";

export type RoomLifecycleStatus = "active" | "expired" | "closed";

export interface CreateRoomWithHostInput {
  roomId: string;
  roomCode: RoomCode;
  gameMode: GameMode;
  settings: RoomSettings;
  maxPlayers: number;
  hostPlayerId: PlayerId;
  hostNickname: string;
  reconnectTokenHash: Buffer;
}

export interface CreatedRoomInfo {
  roomId: string;
  roomCode: RoomCode;
  gameMode: GameMode;
  hostPlayerId: PlayerId;
  lifecycleStatus: RoomLifecycleStatus;
  currentGameId: GameSessionId | null;
  version: string;
}

export interface JoinRoomInput {
  roomCode: RoomCode;
  playerId: PlayerId;
  nickname: string;
  reconnectTokenHash: Buffer;
  expectedRoomId?: string;
  expectedVersion?: string;
}

export interface JoinedRoomInfo {
  roomId: string;
  roomCode: RoomCode;
  gameMode: GameMode;
  playerId: PlayerId;
  lifecycleStatus: RoomLifecycleStatus;
  currentGameId: GameSessionId | null;
  version: string;
}

export interface LeaveRoomInput {
  roomCode: RoomCode;
  playerId: PlayerId;
  expectedRoomId?: string;
  expectedVersion?: string;
}

export interface UpdateWaitingRoomSettingsInput {
  roomCode: RoomCode;
  requestingPlayerId: PlayerId;
  settings: RoomSettings;
  expectedRoomId?: string;
  expectedVersion?: string;
}

export interface UpdatedWaitingRoomSettingsInfo {
  roomId: string;
  roomCode: RoomCode;
  gameMode: GameMode;
  lifecycleStatus: RoomLifecycleStatus;
  currentGameId: GameSessionId | null;
  version: string;
}

interface RoomGameStatusTransitionFields {
  roomCode: RoomCode;
  expectedRoomId: string;
  expectedStatus: GameStatus;
  nextStatus: GameStatus;
  expectedVersion: string;
  expectedCurrentGameId: GameSessionId | null;
  nextGameId: GameSessionId | null;
}

export interface HostInitiatedRoomGameStatusTransition
  extends RoomGameStatusTransitionFields {
  initiatedBy: {
    kind: "host";
    playerId: PlayerId;
  };
}

export interface GameServiceRoomGameStatusTransition
  extends RoomGameStatusTransitionFields {
  initiatedBy: {
    kind: "game-service";
  };
}

export type TransitionRoomGameStatusInput =
  | HostInitiatedRoomGameStatusTransition
  | GameServiceRoomGameStatusTransition;

export interface TransitionedRoomGameStatusInfo {
  roomId: string;
  roomCode: RoomCode;
  gameMode: GameMode;
  gameStatus: GameStatus;
  lifecycleStatus: RoomLifecycleStatus;
  currentGameId: GameSessionId | null;
  version: string;
}

export type LeftRoomInfo =
  | {
    roomId: string;
    roomCode: RoomCode;
    playerId: PlayerId;
    deleted: true;
    hostChanged: boolean;
    currentGameId: GameSessionId | null;
  }
  | {
    roomId: string;
    roomCode: RoomCode;
    playerId: PlayerId;
    deleted: false;
    hostChanged: boolean;
    hostPlayerId?: PlayerId;
    lifecycleStatus: RoomLifecycleStatus;
    currentGameId: GameSessionId | null;
    version: string;
  };

export interface MarkDisconnectedInput {
  roomCode: RoomCode;
  playerId: PlayerId;
  reconnectDeadlineAt: Date;
  expectedRoomId?: string;
  expectedVersion?: string;
}

export interface MarkDisconnectedResult {
  roomId: string;
  roomCode: RoomCode;
  playerId: PlayerId;
  disconnectGeneration: string;
  reconnectDeadlineAt: Date;
  lifecycleStatus: RoomLifecycleStatus;
  currentGameId: GameSessionId | null;
  version: string;
}

export interface ReconnectPlayerInput {
  roomCode: RoomCode;
  playerId: PlayerId;
  reconnectToken: string;
  expectedRoomId?: string;
  expectedVersion?: string;
}

export interface ReconnectedPlayerInfo {
  roomId: string;
  roomCode: RoomCode;
  playerId: PlayerId;
  disconnectGeneration: string;
  lifecycleStatus: RoomLifecycleStatus;
  currentGameId: GameSessionId | null;
  version: string;
}

export interface ListDueDisconnectedMembersInput {
  now: Date;
  limit: number;
}

export interface DueDisconnectedMember {
  roomCode: RoomCode;
  playerId: PlayerId;
  disconnectGeneration: string;
  reconnectDeadlineAt: Date;
}

export interface DeferredRoomMutationState {
  room: {
    roomId: string;
    roomCode: RoomCode;
    lifecycleStatus: RoomLifecycleStatus;
    gameStatus: GameStatus;
    currentGameId: GameSessionId | null;
    version: string;
    hostPlayerId: PlayerId | null;
    activeMemberCount: number;
  } | null;
  member?: {
    membershipStatus: "active" | "removed";
    connectionStatus: ConnectionStatus;
    disconnectGeneration: string;
    reconnectDeadlineAt: Date | null;
  };
}

export interface RemoveDisconnectedPlayerInput {
  roomCode: RoomCode;
  playerId: PlayerId;
  expectedDisconnectGeneration: string;
  expectedReconnectDeadlineAt?: Date;
  expectedRoomId?: string;
  expectedVersion?: string;
  now: Date;
}

export interface PrepareForRuntimeRecoveryInput {
  now: Date;
  reconnectGracePeriodMs: number;
}

export interface RuntimeRecoverySummary {
  waitingRoomsPreserved: number;
  connectedMembershipsMarkedDisconnected: number;
  alreadyOverdueMembershipsRemoved: number;
  legacyDisconnectedMembershipsRemoved: number;
  nonWaitingRoomsClosed: number;
  emptyWaitingRoomsDeleted: number;
  closedRooms: Array<{ roomId: string; roomCode: RoomCode }>;
  deletedRooms: Array<{ roomId: string; roomCode: RoomCode }>;
}

export type RecoverableRoomSettings = Omit<RoomSettings, "manhunt"> & {
  manhunt?: Omit<NonNullable<RoomSettings["manhunt"]>, "boundary">;
};

export interface RecoverableWaitingRoomMember {
  playerId: PlayerId;
  nickname: string;
  membershipStatus: "active";
  connectionStatus: ConnectionStatus;
  joinedAt: Date;
  disconnectGeneration: string;
  reconnectDeadlineAt: Date | null;
  /** Server-only reconnect validation data; never serialize as a public DTO. */
  reconnectTokenHash: Buffer;
}

export interface RecoverableWaitingRoom {
  roomId: string;
  roomCode: RoomCode;
  gameMode: GameMode;
  lifecycleStatus: "active";
  gameStatus: "waiting";
  settings: RecoverableRoomSettings;
  maxPlayers: number;
  hostPlayerId: PlayerId | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  version: string;
  currentGameId: GameSessionId | null;
  members: RecoverableWaitingRoomMember[];
  /** Server-only private boundary, separate from persisted/public room settings. */
  privateManhuntBoundary: ManhuntBoundary | null;
}

export interface DueWaitingRoomExpiration {
  roomId: string;
  roomCode: RoomCode;
  expectedVersion: string;
}

export interface ExpiredWaitingRoom {
  roomId: string;
  roomCode: RoomCode;
  version: string;
}

export type RemoveDisconnectedPlayerResult =
  | {
    status: "removed";
    roomId: string;
    roomCode: RoomCode;
    playerId: PlayerId;
    deleted: false;
    hostChanged?: boolean;
    hostPlayerId?: PlayerId;
    lifecycleStatus: RoomLifecycleStatus;
    currentGameId: GameSessionId | null;
    version: string;
  }
  | {
    status: "room_deleted";
    roomId: string;
    roomCode: RoomCode;
    playerId: PlayerId;
    deleted: true;
    currentGameId: GameSessionId | null;
  }
  | {
    status: "stale";
    roomCode: RoomCode;
    playerId: PlayerId;
    reason:
      | "room_not_found"
      | "room_not_active"
      | "membership_not_found"
      | "membership_not_active"
      | "room_id_mismatch"
      | "version_mismatch"
      | "generation_mismatch"
      | "membership_not_disconnected"
      | "deadline_missing"
      | "deadline_mismatch";
  }
  | {
    status: "not_due";
    roomCode: RoomCode;
    playerId: PlayerId;
  };

export type RoomJoinErrorCode =
  | "ROOM_NOT_FOUND"
  | "STALE_VERSION"
  | "ROOM_NOT_ACCEPTING_JOINS"
  | "ROOM_EXPIRED_OR_CLOSED"
  | "GAME_ALREADY_STARTED"
  | "ROOM_FULL"
  | "PLAYER_ALREADY_EXISTS";

export class RoomJoinError extends Error {
  constructor(readonly code: RoomJoinErrorCode, message: string) {
    super(message);
    this.name = "RoomJoinError";
  }
}

export type RoomLeaveErrorCode =
  | "ROOM_NOT_FOUND"
  | "STALE_VERSION"
  | "MEMBERSHIP_NOT_ACTIVE"
  | "HOST_TRANSFER_FAILED";

export class RoomLeaveError extends Error {
  constructor(readonly code: RoomLeaveErrorCode, message: string) {
    super(message);
    this.name = "RoomLeaveError";
  }
}

export type RoomSettingsUpdateErrorCode =
  | "ROOM_NOT_FOUND"
  | "STALE_VERSION"
  | "ROOM_NOT_ACTIVE"
  | "GAME_ALREADY_STARTED"
  | "MEMBERSHIP_NOT_ACTIVE"
  | "NOT_HOST"
  | "ROOM_MODE_MISMATCH"
  | "ROOM_FULL";

export class RoomSettingsUpdateError extends Error {
  constructor(readonly code: RoomSettingsUpdateErrorCode, message: string) {
    super(message);
    this.name = "RoomSettingsUpdateError";
  }
}

export type RoomGameStatusTransitionErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_NOT_ACTIVE"
  | "STALE_ROOM_ID"
  | "MEMBERSHIP_NOT_ACTIVE"
  | "HOST_NOT_CONNECTED"
  | "NOT_HOST"
  | "STALE_STATUS"
  | "STALE_VERSION"
  | "STALE_GAME_ID"
  | "INVALID_TRANSITION";

export class RoomGameStatusTransitionError extends Error {
  constructor(
    readonly code: RoomGameStatusTransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomGameStatusTransitionError";
  }
}

export type RoomConnectionErrorCode =
  | "ROOM_NOT_FOUND"
  | "STALE_VERSION"
  | "ROOM_NOT_ACTIVE"
  | "MEMBERSHIP_NOT_FOUND"
  | "MEMBERSHIP_NOT_ACTIVE"
  | "MEMBERSHIP_NOT_CONNECTED"
  | "MEMBERSHIP_NOT_DISCONNECTED"
  | "INVALID_RECONNECT_DEADLINE"
  | "INVALID_RECONNECT_CREDENTIALS"
  | "RECONNECT_DEADLINE_MISSING"
  | "RECONNECT_DEADLINE_EXPIRED";

export class RoomConnectionError extends Error {
  constructor(readonly code: RoomConnectionErrorCode, message: string) {
    super(message);
    this.name = "RoomConnectionError";
  }
}

export class RoomRuntimeFencingError extends Error {
  constructor() {
    super("Room mutation was rejected because its runtime fencing epoch is stale.");
    this.name = "RoomRuntimeFencingError";
  }
}

interface JoinableRoomRow extends QueryResultRow {
  id: string;
  room_code: RoomCode;
  game_mode: GameMode;
  max_players: number;
  game_status: string;
  lifecycle_status: RoomLifecycleStatus;
  current_game_id: GameSessionId | null;
  version: string;
  expiry_passed: boolean;
}

interface RoomToLeaveRow extends QueryResultRow {
  id: string;
  room_code: RoomCode;
  host_player_id: PlayerId | null;
  lifecycle_status: RoomLifecycleStatus;
  current_game_id: GameSessionId | null;
  version: string;
}

interface RoomSettingsUpdateRow extends QueryResultRow {
  id: string;
  room_code: RoomCode;
  version: string;
  game_mode: GameMode;
  host_player_id: PlayerId | null;
  game_status: string;
  lifecycle_status: RoomLifecycleStatus;
  current_game_id: GameSessionId | null;
}

interface RoomSettingsMemberRow extends QueryResultRow {
  player_id: PlayerId;
  membership_status: string;
}

interface RoomGameStatusTransitionRow extends QueryResultRow {
  id: string;
  room_code: RoomCode;
  game_mode: GameMode;
  host_player_id: PlayerId | null;
  game_status: GameStatus;
  lifecycle_status: RoomLifecycleStatus;
  current_game_id: GameSessionId | null;
  version: string;
}

interface RoomGameStatusTransitionMemberRow extends QueryResultRow {
  membership_status: string;
  connection_status: string;
}

interface RoomConnectionRow extends QueryResultRow {
  id: string;
  room_code: RoomCode;
  lifecycle_status: RoomLifecycleStatus;
  current_game_id: GameSessionId | null;
  version: string;
}

interface ReconnectRoomRow extends QueryResultRow {
  id: string;
  room_code: RoomCode;
  lifecycle_status: RoomLifecycleStatus;
  current_game_id: GameSessionId | null;
  version: string;
}

interface ConnectionMembershipRow extends QueryResultRow {
  membership_status: string;
  connection_status: string;
  disconnect_generation: string;
  reconnect_token_hash: Buffer | null;
  reconnect_deadline_at: Date | null;
}

interface MembershipConnectionStateRow extends QueryResultRow {
  membership_status: string;
  connection_status: string;
}

interface DueDisconnectedMemberRow extends QueryResultRow {
  room_code: RoomCode;
  player_id: PlayerId;
  disconnect_generation: string;
  reconnect_deadline_at: Date;
}

interface TimeoutRoomRow extends QueryResultRow {
  id: string;
  room_code: RoomCode;
  lifecycle_status: RoomLifecycleStatus;
  host_player_id: PlayerId | null;
  current_game_id: GameSessionId | null;
  version: string;
}

interface TimeoutMembershipRow extends QueryResultRow {
  membership_status: string;
  connection_status: string;
  disconnect_generation: string;
  reconnect_deadline_at: Date | null;
  deadline_is_due: boolean;
  deadline_matches: boolean;
}

interface DeferredMutationRoomRow extends QueryResultRow {
  id: string;
  room_code: RoomCode;
  lifecycle_status: RoomLifecycleStatus;
  game_status: GameStatus;
  current_game_id: GameSessionId | null;
  version: string;
  host_player_id: PlayerId | null;
}

interface DeferredMutationMemberRow extends QueryResultRow {
  membership_status: string;
  connection_status: string;
  disconnect_generation: string;
  reconnect_deadline_at: Date | null;
}

interface RuntimeRecoveryRoomRow extends QueryResultRow {
  id: string;
  room_code: RoomCode;
  lifecycle_status: RoomLifecycleStatus;
  game_status: string;
}

interface RuntimeRecoveryLegacyMemberRow extends QueryResultRow {
  room_code: RoomCode;
  player_id: PlayerId;
  disconnect_generation: string;
}

interface RecoverableWaitingRoomRow extends QueryResultRow {
  id: string;
  room_code: RoomCode;
  game_mode: GameMode;
  lifecycle_status: "active";
  game_status: "waiting";
  settings: RecoverableRoomSettings;
  max_players: number;
  host_player_id: PlayerId | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  version: string;
  current_game_id: GameSessionId | null;
  player_id: PlayerId | null;
  nickname: string | null;
  membership_status: "active" | null;
  connection_status: ConnectionStatus | null;
  joined_at: Date | null;
  disconnect_generation: string | null;
  reconnect_deadline_at: Date | null;
  reconnect_token_hash: Buffer | null;
  private_boundary_latitude: number | null;
  private_boundary_longitude: number | null;
  private_boundary_radius_meters: number | null;
}

interface DueWaitingRoomExpirationRow extends QueryResultRow {
  id: string;
  room_code: RoomCode;
  version: string;
}

interface ExpiredWaitingRoomRow extends QueryResultRow {
  id: string;
  room_code: RoomCode;
  lifecycle_status: RoomLifecycleStatus;
  game_status: GameStatus;
  current_game_id: GameSessionId | null;
  version: string;
  expiry_passed: boolean;
}

const MIN_RECONNECT_GRACE_PERIOD_MS = 1;
const MAX_RECONNECT_GRACE_PERIOD_MS = 86_400_000;
export const MAX_ROOM_EXPIRATION_BATCH_SIZE = 50;

function validateExpectedRoomVersion(input: {
  expectedRoomId?: string;
  expectedVersion?: string;
}): void {
  if ((input.expectedRoomId === undefined) !== (input.expectedVersion === undefined)) {
    throw new TypeError("Expected room ID and version must be provided together.");
  }
  if (
    input.expectedRoomId !== undefined
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(input.expectedRoomId)
  ) {
    throw new TypeError("Expected room ID must be a UUID.");
  }
  if (
    input.expectedVersion !== undefined
    && !/^[1-9]\d*$/.test(input.expectedVersion)
  ) {
    throw new TypeError("Expected room version must be a positive integer.");
  }
}

function isAllowedRoomGameStatusTransition(
  gameMode: GameMode,
  initiatorKind: "host" | "game-service",
  from: GameStatus,
  to: GameStatus,
): boolean {
  if (initiatorKind === "host") {
    if (to === "starting") {
      return from === "waiting";
    }
    return (
      from === "finished"
      && to === "waiting"
    );
  }

  if (to === "in_progress") {
    return from === "starting";
  }
  if (to === "finished") {
    return (
      from === "in_progress"
      || (from === "starting" && gameMode !== "manhunt")
    );
  }
  return from === "starting" && to === "waiting" && gameMode === "manhunt";
}

export class PostgresRoomRepository {
  private runtimeFencingEpoch?: string;

  constructor(private readonly pool: Pool) {}

  setRuntimeFencingEpoch(epoch: string): void {
    if (!/^\d+$/.test(epoch)) {
      throw new TypeError("Runtime fencing epoch must be a non-negative integer.");
    }
    if (this.runtimeFencingEpoch !== undefined && this.runtimeFencingEpoch !== epoch) {
      throw new Error("Runtime fencing epoch has already been assigned.");
    }
    this.runtimeFencingEpoch = epoch;
  }

  private withRuntimeFenceTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const expectedEpoch = this.runtimeFencingEpoch;
    if (expectedEpoch === undefined) {
      return Promise.reject(
        new Error("Room repository has no acquired runtime fencing epoch."),
      );
    }

    return withPostgresTransaction(this.pool, async (client) => {
      const result = await client.query<{ epoch: string }>(
        `SELECT epoch::text
         FROM public.room_runtime_fencing
         WHERE singleton_id = 1
         FOR SHARE`,
      );
      if (result.rows[0]?.epoch !== expectedEpoch) {
        throw new RoomRuntimeFencingError();
      }
      return operation(client);
    });
  }

  async listDueWaitingRoomExpirations(
    limit = MAX_ROOM_EXPIRATION_BATCH_SIZE,
  ): Promise<DueWaitingRoomExpiration[]> {
    if (
      !Number.isInteger(limit)
      || limit < 1
      || limit > MAX_ROOM_EXPIRATION_BATCH_SIZE
    ) {
      throw new RangeError(
        `Room expiration batch size must be between 1 and ${MAX_ROOM_EXPIRATION_BATCH_SIZE}.`,
      );
    }

    return this.withRuntimeFenceTransaction(async (client) => {
      const result = await client.query<DueWaitingRoomExpirationRow>(
        `SELECT id::text, room_code, version::text
         FROM public.rooms
         WHERE lifecycle_status = 'active'
           AND game_status = 'waiting'
           AND current_game_id IS NULL
           AND expires_at IS NOT NULL
           AND expires_at <= clock_timestamp()
         ORDER BY expires_at, id
         LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        roomId: row.id,
        roomCode: row.room_code,
        expectedVersion: row.version,
      }));
    });
  }

  async expireDueWaitingRooms(
    limit = MAX_ROOM_EXPIRATION_BATCH_SIZE,
  ): Promise<number> {
    if (
      !Number.isInteger(limit)
      || limit < 1
      || limit > MAX_ROOM_EXPIRATION_BATCH_SIZE
    ) {
      throw new RangeError(
        `Room expiration batch size must be between 1 and ${MAX_ROOM_EXPIRATION_BATCH_SIZE}.`,
      );
    }

    return this.withRuntimeFenceTransaction(async (client) => {
      const result = await client.query<DueWaitingRoomExpirationRow>(
        `WITH due_rooms AS (
           SELECT id
           FROM public.rooms
           WHERE lifecycle_status = 'active'
             AND game_status = 'waiting'
             AND current_game_id IS NULL
             AND expires_at IS NOT NULL
             AND expires_at <= clock_timestamp()
           ORDER BY expires_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT $1
         )
         UPDATE public.rooms AS room
         SET lifecycle_status = 'expired',
             version = room.version + 1,
             updated_at = clock_timestamp()
         FROM due_rooms
         WHERE room.id = due_rooms.id
           AND room.lifecycle_status = 'active'
           AND room.game_status = 'waiting'
           AND room.current_game_id IS NULL
           AND room.expires_at IS NOT NULL
           AND room.expires_at <= clock_timestamp()
         RETURNING room.id::text, room.room_code, room.version::text`,
        [limit],
      );
      return result.rowCount ?? result.rows.length;
    });
  }

  async expireWaitingRoom(
    candidate: DueWaitingRoomExpiration,
  ): Promise<ExpiredWaitingRoom | undefined> {
    const parsedRoomCode = roomCodeSchema.safeParse(candidate.roomCode);
    if (!parsedRoomCode.success || parsedRoomCode.data !== candidate.roomCode) {
      throw new TypeError("Room code must be four uppercase letters.");
    }
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        candidate.roomId,
      )
      || !/^[1-9]\d*$/.test(candidate.expectedVersion)
    ) {
      throw new TypeError("Room expiration identity or version is invalid.");
    }

    return this.withRuntimeFenceTransaction(async (client) => {
      const selected = await client.query<ExpiredWaitingRoomRow>(
        `SELECT id::text, room_code, lifecycle_status, game_status,
                current_game_id, version::text,
                (expires_at IS NOT NULL AND expires_at <= clock_timestamp())
                  AS expiry_passed
         FROM public.rooms
         WHERE id = $1 AND room_code = $2
         FOR UPDATE`,
        [candidate.roomId, candidate.roomCode],
      );
      const room = selected.rows[0];
      if (!room) {
        return undefined;
      }

      const committedVersion = (BigInt(candidate.expectedVersion) + 1n).toString();
      if (
        room.lifecycle_status === "expired"
        && room.game_status === "waiting"
        && room.current_game_id === null
        && room.version === committedVersion
        && room.expiry_passed
      ) {
        return {
          roomId: room.id,
          roomCode: room.room_code,
          version: room.version,
        };
      }
      if (
        room.lifecycle_status !== "active"
        || room.game_status !== "waiting"
        || room.current_game_id !== null
        || room.version !== candidate.expectedVersion
        || !room.expiry_passed
      ) {
        return undefined;
      }

      const updated = await client.query<DueWaitingRoomExpirationRow>(
        `UPDATE public.rooms
         SET lifecycle_status = 'expired',
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND room_code = $2
           AND version = $3::bigint
           AND lifecycle_status = 'active'
           AND game_status = 'waiting'
           AND current_game_id IS NULL
           AND expires_at IS NOT NULL
           AND expires_at <= clock_timestamp()
         RETURNING id::text, room_code, version::text`,
        [candidate.roomId, candidate.roomCode, candidate.expectedVersion],
      );
      const result = updated.rows[0];
      return result
        ? {
            roomId: result.id,
            roomCode: result.room_code,
            version: result.version,
          }
        : undefined;
    });
  }

  /**
   * Prepare durable rooms after a process restart. The caller must hold the
   * exclusive lease returned by acquireRoomRuntimeLease for this operation.
   */
  async prepareForRuntimeRecovery(
    input: PrepareForRuntimeRecoveryInput,
  ): Promise<RuntimeRecoverySummary> {
    if (
      !(input.now instanceof Date)
      || !Number.isFinite(input.now.getTime())
    ) {
      throw new TypeError("Recovery time must be a valid date.");
    }
    if (
      !Number.isInteger(input.reconnectGracePeriodMs)
      || input.reconnectGracePeriodMs < MIN_RECONNECT_GRACE_PERIOD_MS
      || input.reconnectGracePeriodMs > MAX_RECONNECT_GRACE_PERIOD_MS
    ) {
      throw new RangeError(
        "Reconnect grace period must be between 1 and 86400000 milliseconds.",
      );
    }

    const reconnectDeadlineAt = new Date(
      input.now.getTime() + input.reconnectGracePeriodMs,
    );
    if (
      !Number.isFinite(reconnectDeadlineAt.getTime())
      || reconnectDeadlineAt.getTime() <= Date.now()
    ) {
      throw new RangeError(
        "Recovery time and grace period must produce a future reconnect deadline.",
      );
    }

    const summary: RuntimeRecoverySummary = {
      waitingRoomsPreserved: 0,
      connectedMembershipsMarkedDisconnected: 0,
      alreadyOverdueMembershipsRemoved: 0,
      legacyDisconnectedMembershipsRemoved: 0,
      nonWaitingRoomsClosed: 0,
      emptyWaitingRoomsDeleted: 0,
      closedRooms: [],
      deletedRooms: [],
    };

    const interruptedRooms = await this.pool.query<RuntimeRecoveryRoomRow>(
      `SELECT id::text, room_code, lifecycle_status, game_status
       FROM public.rooms
       WHERE lifecycle_status = 'active'
         AND game_status IN ('starting', 'in_progress', 'finished')
       ORDER BY id`,
    );
    for (const candidate of interruptedRooms.rows) {
      const closed = await this.withRuntimeFenceTransaction(async (client) => {
        const roomResult = await client.query<RuntimeRecoveryRoomRow>(
          `SELECT id::text, room_code, lifecycle_status, game_status
           FROM public.rooms
           WHERE id = $1
           FOR UPDATE`,
          [candidate.id],
        );
        const room = roomResult.rows[0];
        if (
          !room
          || room.lifecycle_status !== "active"
          || !["starting", "in_progress", "finished"].includes(room.game_status)
        ) {
          return false;
        }

        const members = await client.query<{ player_id: PlayerId }>(
          `SELECT player_id::text
           FROM public.room_players
           WHERE room_id = $1 AND membership_status = 'active'
           ORDER BY player_id
           FOR UPDATE`,
          [room.id],
        );

        const roomUpdate = await client.query(
          `UPDATE public.rooms
           SET lifecycle_status = 'closed',
               host_player_id = NULL,
               version = version + 1,
               updated_at = $2
           WHERE id = $1
             AND lifecycle_status = 'active'
             AND game_status IN ('starting', 'in_progress', 'finished')`,
          [room.id, input.now],
        );
        if (roomUpdate.rowCount !== 1) {
          throw new Error("Interrupted room changed during runtime recovery.");
        }

        const membersUpdate = await client.query(
          `UPDATE public.room_players
           SET membership_status = 'removed',
               connection_status = 'disconnected',
               reconnect_token_hash = NULL,
               reconnect_deadline_at = NULL,
               removed_at = $2
           WHERE room_id = $1 AND membership_status = 'active'`,
          [room.id, input.now],
        );
        if (membersUpdate.rowCount !== members.rowCount) {
          throw new Error("Room memberships changed during runtime recovery.");
        }
        return true;
      });
      if (closed) {
        summary.nonWaitingRoomsClosed += 1;
        summary.closedRooms.push({
          roomId: candidate.id,
          roomCode: candidate.room_code,
        });
      }
    }

    const waitingRooms = await this.pool.query<RuntimeRecoveryRoomRow>(
      `SELECT id::text, room_code, lifecycle_status, game_status
       FROM public.rooms
       WHERE lifecycle_status = 'active' AND game_status = 'waiting'
       ORDER BY id`,
    );
    const waitingRoomIds = waitingRooms.rows.map((room) => room.id);

    const overdueMembers = await this.pool.query<RuntimeRecoveryLegacyMemberRow>(
      `SELECT r.room_code, rp.player_id::text,
              rp.disconnect_generation::text
       FROM public.rooms AS r
       JOIN public.room_players AS rp ON rp.room_id = r.id
       WHERE r.lifecycle_status = 'active'
         AND r.game_status = 'waiting'
         AND rp.membership_status = 'active'
         AND rp.connection_status = 'disconnected'
         AND rp.reconnect_deadline_at <= $1
       ORDER BY r.id, rp.player_id`,
      [input.now],
    );
    for (const member of overdueMembers.rows) {
      const result = await this.removeDisconnectedPlayer({
        roomCode: member.room_code,
        playerId: member.player_id,
        expectedDisconnectGeneration: member.disconnect_generation,
        now: input.now,
      });
      if (result.status === "removed" || result.status === "room_deleted") {
        summary.alreadyOverdueMembershipsRemoved += 1;
        if (result.status === "room_deleted") {
          summary.emptyWaitingRoomsDeleted += 1;
          summary.deletedRooms.push({
            roomId: result.roomId,
            roomCode: result.roomCode,
          });
        }
      }
    }

    const legacyMembers = await this.pool.query<RuntimeRecoveryLegacyMemberRow>(
      `SELECT r.room_code, rp.player_id::text,
              rp.disconnect_generation::text
       FROM public.rooms AS r
       JOIN public.room_players AS rp ON rp.room_id = r.id
       WHERE r.lifecycle_status = 'active'
         AND r.game_status = 'waiting'
         AND rp.membership_status = 'active'
         AND rp.connection_status = 'disconnected'
         AND rp.reconnect_deadline_at IS NULL
       ORDER BY r.id, rp.player_id`,
    );
    for (const member of legacyMembers.rows) {
      const normalized = await this.withRuntimeFenceTransaction(
        async (client) => {
          const roomResult = await client.query<RuntimeRecoveryRoomRow>(
            `SELECT id::text, room_code, lifecycle_status, game_status
             FROM public.rooms
             WHERE room_code = $1
             FOR UPDATE`,
            [member.room_code],
          );
          const room = roomResult.rows[0];
          if (
            !room
            || room.lifecycle_status !== "active"
            || room.game_status !== "waiting"
          ) {
            return false;
          }

          const membershipResult = await client.query<{
            membership_status: string;
            connection_status: string;
            disconnect_generation: string;
            reconnect_deadline_at: Date | null;
          }>(
            `SELECT membership_status, connection_status,
                    disconnect_generation::text, reconnect_deadline_at
             FROM public.room_players
             WHERE room_id = $1 AND player_id = $2
             FOR UPDATE`,
            [room.id, member.player_id],
          );
          const membership = membershipResult.rows[0];
          if (
            !membership
            || membership.membership_status !== "active"
            || membership.connection_status !== "disconnected"
            || membership.disconnect_generation !== member.disconnect_generation
            || membership.reconnect_deadline_at !== null
          ) {
            return false;
          }

          const update = await client.query(
            `UPDATE public.room_players
             SET reconnect_deadline_at = $4
             WHERE room_id = $1
               AND player_id = $2
               AND membership_status = 'active'
               AND connection_status = 'disconnected'
               AND disconnect_generation = $3
               AND reconnect_deadline_at IS NULL`,
            [
              room.id,
              member.player_id,
              member.disconnect_generation,
              input.now,
            ],
          );
          return update.rowCount === 1;
        },
      );
      if (!normalized) {
        continue;
      }

      const result = await this.removeDisconnectedPlayer({
        roomCode: member.room_code,
        playerId: member.player_id,
        expectedDisconnectGeneration: member.disconnect_generation,
        now: input.now,
      });
      if (result.status === "removed" || result.status === "room_deleted") {
        summary.legacyDisconnectedMembershipsRemoved += 1;
        if (result.status === "room_deleted") {
          summary.emptyWaitingRoomsDeleted += 1;
          summary.deletedRooms.push({
            roomId: result.roomId,
            roomCode: result.roomCode,
          });
        }
      }
    }

    for (const room of waitingRooms.rows) {
      const connectedMembers = await this.pool.query<{
        player_id: PlayerId;
      }>(
        `SELECT player_id::text
         FROM public.room_players
         WHERE room_id = $1
           AND membership_status = 'active'
           AND connection_status = 'connected'
         ORDER BY player_id`,
        [room.id],
      );
      for (const member of connectedMembers.rows) {
        try {
          await this.markDisconnected({
            roomCode: room.room_code,
            playerId: member.player_id,
            reconnectDeadlineAt,
          });
          summary.connectedMembershipsMarkedDisconnected += 1;
        } catch (error) {
          if (
            error instanceof RoomConnectionError
            && (
              error.code === "ROOM_NOT_FOUND"
              || error.code === "MEMBERSHIP_NOT_FOUND"
              || error.code === "MEMBERSHIP_NOT_ACTIVE"
              || error.code === "MEMBERSHIP_NOT_CONNECTED"
            )
          ) {
            continue;
          }
          throw error;
        }
      }
    }

    for (const candidate of waitingRooms.rows) {
      const deleted = await this.withRuntimeFenceTransaction(async (client) => {
        const roomResult = await client.query<RuntimeRecoveryRoomRow>(
          `SELECT id::text, room_code, lifecycle_status, game_status
           FROM public.rooms
           WHERE id = $1
           FOR UPDATE`,
          [candidate.id],
        );
        const room = roomResult.rows[0];
        if (
          !room
          || room.lifecycle_status !== "active"
          || room.game_status !== "waiting"
        ) {
          return false;
        }

        const activeMembers = await client.query<{ player_id: PlayerId }>(
          `SELECT player_id::text
           FROM public.room_players
           WHERE room_id = $1 AND membership_status = 'active'
           ORDER BY player_id
           FOR UPDATE`,
          [room.id],
        );
        if (activeMembers.rowCount !== 0) {
          return false;
        }

        const result = await client.query(
          `DELETE FROM public.rooms
           WHERE id = $1
             AND lifecycle_status = 'active'
             AND game_status = 'waiting'`,
          [room.id],
        );
        return result.rowCount === 1;
      });
      if (deleted) {
        summary.emptyWaitingRoomsDeleted += 1;
        summary.deletedRooms.push({
          roomId: candidate.id,
          roomCode: candidate.room_code,
        });
      }
    }

    if (waitingRoomIds.length > 0) {
      const preserved = await this.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM public.rooms AS r
         WHERE r.id::text = ANY($1::text[])
           AND r.lifecycle_status = 'active'
           AND r.game_status = 'waiting'
           AND EXISTS (
             SELECT 1
             FROM public.room_players AS rp
             WHERE rp.room_id = r.id
               AND rp.membership_status = 'active'
           )`,
        [waitingRoomIds],
      );
      summary.waitingRoomsPreserved = preserved.rows[0]?.count ?? 0;
    }

    return summary;
  }

  /**
   * Load waiting-room recovery data while the caller holds the room-runtime
   * advisory lease. Returned hashes and Manhunt boundaries are server-only;
   * socket IDs are intentionally unavailable after a process restart.
   */
  async loadRecoverableWaitingRooms(): Promise<RecoverableWaitingRoom[]> {
    const result = await this.pool.query<RecoverableWaitingRoomRow>(
      `SELECT r.id::text,
              r.room_code,
              r.game_mode,
              r.lifecycle_status,
              r.game_status,
              r.settings,
              r.max_players::int,
              r.host_player_id::text,
              r.created_at,
              r.updated_at,
              r.expires_at,
              r.version::text,
              r.current_game_id,
              rp.player_id::text,
              rp.nickname,
              rp.membership_status,
              rp.connection_status,
              rp.joined_at,
              rp.disconnect_generation::text,
              rp.reconnect_deadline_at,
              rp.reconnect_token_hash,
              boundary.center_latitude::double precision
                AS private_boundary_latitude,
              boundary.center_longitude::double precision
                AS private_boundary_longitude,
              boundary.radius_meters::double precision
                AS private_boundary_radius_meters
       FROM public.rooms AS r
       LEFT JOIN public.room_players AS rp
         ON rp.room_id = r.id
        AND rp.membership_status = 'active'
       LEFT JOIN public.room_private_manhunt_boundaries AS boundary
         ON boundary.room_id = r.id
        AND r.game_mode = 'manhunt'
       WHERE r.lifecycle_status = 'active'
         AND r.game_status = 'waiting'
         AND (r.expires_at IS NULL OR r.expires_at > clock_timestamp())
       ORDER BY r.room_code, r.id, rp.joined_at NULLS LAST, rp.player_id NULLS LAST`,
    );

    const rooms = new Map<string, RecoverableWaitingRoom>();
    for (const row of result.rows) {
      let room = rooms.get(row.id);
      if (!room) {
        if (
          !row.settings
          || typeof row.settings !== "object"
          || row.settings.gameMode !== row.game_mode
          || row.settings.maxPlayers !== row.max_players
          || "boundary" in row.settings
          || (
            row.settings.manhunt !== undefined
            && "boundary" in row.settings.manhunt
          )
        ) {
          throw new Error("Waiting room settings are inconsistent with persisted metadata.");
        }

        let privateManhuntBoundary: ManhuntBoundary | null = null;
        if (row.game_mode === "manhunt") {
          if (
            row.settings.manhunt === undefined
            || row.private_boundary_latitude === null
            || row.private_boundary_longitude === null
            || row.private_boundary_radius_meters === null
            || !Number.isFinite(row.private_boundary_latitude)
            || !Number.isFinite(row.private_boundary_longitude)
            || !Number.isFinite(row.private_boundary_radius_meters)
          ) {
            throw new Error("Manhunt waiting room is missing valid private recovery data.");
          }
          privateManhuntBoundary = {
            center: {
              latitude: row.private_boundary_latitude,
              longitude: row.private_boundary_longitude,
            },
            radiusMeters: row.private_boundary_radius_meters,
          };
        }

        room = {
          roomId: row.id,
          roomCode: row.room_code,
          gameMode: row.game_mode,
          lifecycleStatus: row.lifecycle_status,
          gameStatus: row.game_status,
          settings: row.settings,
          maxPlayers: row.max_players,
          hostPlayerId: row.host_player_id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          expiresAt: row.expires_at,
          version: row.version,
          currentGameId: row.current_game_id,
          members: [],
          privateManhuntBoundary,
        };
        rooms.set(row.id, room);
      }

      if (row.player_id === null) {
        if (
          row.nickname !== null
          || row.membership_status !== null
          || row.connection_status !== null
          || row.joined_at !== null
          || row.disconnect_generation !== null
          || row.reconnect_deadline_at !== null
          || row.reconnect_token_hash !== null
        ) {
          throw new Error("Waiting room has incomplete membership recovery data.");
        }
        continue;
      }
      if (
        row.nickname === null
        || row.membership_status !== "active"
        || row.connection_status === null
        || row.joined_at === null
        || row.disconnect_generation === null
        || !Buffer.isBuffer(row.reconnect_token_hash)
      ) {
        throw new Error("Active membership has incomplete recovery data.");
      }

      room.members.push({
        playerId: row.player_id,
        nickname: row.nickname,
        membershipStatus: row.membership_status,
        connectionStatus: row.connection_status,
        joinedAt: row.joined_at,
        disconnectGeneration: row.disconnect_generation,
        reconnectDeadlineAt: row.reconnect_deadline_at,
        reconnectTokenHash: Buffer.from(row.reconnect_token_hash),
      });
    }

    return [...rooms.values()];
  }

  async createRoomWithHost(
    input: CreateRoomWithHostInput,
  ): Promise<CreatedRoomInfo> {
    const roomCode = roomCodeSchema.safeParse(input.roomCode);
    if (!roomCode.success || roomCode.data !== input.roomCode) {
      throw new TypeError("Room code must be four uppercase letters.");
    }

    const nickname = nicknameSchema.safeParse(input.hostNickname);
    if (!nickname.success) {
      throw new TypeError("Host nickname is invalid.");
    }

    const settingsResult = roomSettingsSchema.safeParse(input.settings);
    if (!settingsResult.success) {
      throw new TypeError("Room settings are invalid.");
    }
    const settings = settingsResult.data;
    if (
      settings.gameMode !== input.gameMode
      || settings.maxPlayers !== input.maxPlayers
    ) {
      throw new TypeError("Room mode and player limit must match its settings.");
    }
    if (
      !Buffer.isBuffer(input.reconnectTokenHash)
      || input.reconnectTokenHash.length !== 32
    ) {
      throw new TypeError("Reconnect token hash must contain exactly 32 bytes.");
    }

    let storedSettings: Record<string, unknown> = { ...settings };
    let privateBoundary: ManhuntBoundary | undefined;

    if (settings.gameMode === "manhunt") {
      if (!settings.manhunt) {
        throw new TypeError("Manhunt settings must include a boundary.");
      }
      const { boundary, ...manhuntSettings } = settings.manhunt;
      privateBoundary = boundary;
      storedSettings = { ...settings, manhunt: manhuntSettings };
    }

    const createdRoom = await this.withRuntimeFenceTransaction(async (client) => {
      const roomResult = await client.query<{
        id: string;
        room_code: RoomCode;
        lifecycle_status: RoomLifecycleStatus;
        current_game_id: GameSessionId | null;
        version: string;
      }>(
        `INSERT INTO public.rooms (
           id, room_code, game_mode, settings, max_players, host_player_id, expires_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
         RETURNING id::text, room_code, lifecycle_status, current_game_id,
                   version::text`,
        [
          input.roomId,
          roomCode.data,
          input.gameMode,
          JSON.stringify(storedSettings),
          input.maxPlayers,
          input.hostPlayerId,
          null,
        ],
      );
      const room = roomResult.rows[0];
      if (!room) {
        throw new Error("Durable room creation did not return its persisted metadata.");
      }

      await client.query(
        `INSERT INTO public.room_players (
           player_id, room_id, nickname, connection_status,
           membership_status, reconnect_token_hash
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          input.hostPlayerId,
          input.roomId,
          nickname.data,
          "connected",
          "active",
          input.reconnectTokenHash,
        ],
      );

      if (privateBoundary) {
        await client.query(
          `INSERT INTO public.room_private_manhunt_boundaries (
             room_id, center_latitude, center_longitude, radius_meters
           ) VALUES ($1, $2, $3, $4)`,
          [
            input.roomId,
            privateBoundary.center.latitude,
            privateBoundary.center.longitude,
            privateBoundary.radiusMeters,
          ],
        );
      }
      return room;
    });

    return {
      roomId: createdRoom.id,
      roomCode: createdRoom.room_code,
      gameMode: input.gameMode,
      hostPlayerId: input.hostPlayerId,
      lifecycleStatus: createdRoom.lifecycle_status,
      currentGameId: createdRoom.current_game_id,
      version: createdRoom.version,
    };
  }

  async updateWaitingRoomSettings(
    input: UpdateWaitingRoomSettingsInput,
  ): Promise<UpdatedWaitingRoomSettingsInfo> {
    const roomCode = roomCodeSchema.safeParse(input.roomCode);
    if (!roomCode.success || roomCode.data !== input.roomCode) {
      throw new TypeError("Room code must be four uppercase letters.");
    }

    const settingsResult = roomSettingsSchema.safeParse(input.settings);
    if (!settingsResult.success) {
      throw new TypeError("Room settings are invalid.");
    }
    const settings = settingsResult.data;
    let privateBoundary: ManhuntBoundary | undefined;
    const storedSettings: Record<string, unknown> = { ...settings };

    if (settings.gameMode === "manhunt") {
      if (!settings.manhunt) {
        throw new TypeError("Manhunt settings must include a boundary.");
      }
      const { boundary, ...publicManhuntSettings } = settings.manhunt;
      privateBoundary = boundary;
      storedSettings.manhunt = publicManhuntSettings;
    }

    return this.withRuntimeFenceTransaction(async (client) => {
      const roomResult = await client.query<RoomSettingsUpdateRow>(
        `SELECT id::text, room_code, version::text, game_mode, host_player_id::text,
                game_status, lifecycle_status, current_game_id
         FROM public.rooms
         WHERE room_code = $1
         FOR UPDATE`,
        [roomCode.data],
      );
      const room = roomResult.rows[0];
      if (!room) {
        throw new RoomSettingsUpdateError(
          "ROOM_NOT_FOUND",
          "Room was not found.",
        );
      }
      if (
        (input.expectedRoomId !== undefined && room.id !== input.expectedRoomId)
        || (input.expectedVersion !== undefined
          && room.version !== input.expectedVersion)
      ) {
        throw new RoomSettingsUpdateError(
          "STALE_VERSION",
          "Room changed before settings could be updated.",
        );
      }
      if (room.lifecycle_status !== "active") {
        throw new RoomSettingsUpdateError(
          "ROOM_NOT_ACTIVE",
          "Room is not active.",
        );
      }
      if (room.game_status !== "waiting") {
        throw new RoomSettingsUpdateError(
          "GAME_ALREADY_STARTED",
          "Room settings cannot be changed after the game has started.",
        );
      }

      const membersResult = await client.query<RoomSettingsMemberRow>(
        `SELECT player_id::text, membership_status
         FROM public.room_players
         WHERE room_id = $1
         ORDER BY player_id
         FOR UPDATE`,
        [room.id],
      );
      const requestingMember = membersResult.rows.find(
        (member) => member.player_id === input.requestingPlayerId,
      );
      if (!requestingMember || requestingMember.membership_status !== "active") {
        throw new RoomSettingsUpdateError(
          "MEMBERSHIP_NOT_ACTIVE",
          "Player does not have an active membership in this room.",
        );
      }
      if (room.host_player_id !== input.requestingPlayerId) {
        throw new RoomSettingsUpdateError(
          "NOT_HOST",
          "Only the current room host can update room settings.",
        );
      }
      if (settings.gameMode !== room.game_mode) {
        throw new RoomSettingsUpdateError(
          "ROOM_MODE_MISMATCH",
          "Room settings must match the room's configured game mode.",
        );
      }

      const activeMemberCount = membersResult.rows.filter(
        (member) => member.membership_status === "active",
      ).length;
      if (settings.maxPlayers < activeMemberCount) {
        throw new RoomSettingsUpdateError(
          "ROOM_FULL",
          "The player limit cannot be lower than the current room size.",
        );
      }

      const roomUpdate = await client.query<{ version: string }>(
        `UPDATE public.rooms
         SET settings = $2::jsonb,
             max_players = $3,
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1 AND version = $4::bigint
         RETURNING version::text`,
        [
          room.id,
          JSON.stringify(storedSettings),
          settings.maxPlayers,
          input.expectedVersion ?? room.version,
        ],
      );
      const version = roomUpdate.rows[0]?.version;
      if (roomUpdate.rowCount !== 1 || version === undefined) {
        throw new RoomSettingsUpdateError(
          "STALE_VERSION",
          "Room changed before settings could be updated.",
        );
      }

      if (privateBoundary) {
        await client.query(
          `INSERT INTO public.room_private_manhunt_boundaries (
             room_id, center_latitude, center_longitude, radius_meters
           ) VALUES ($1, $2, $3, $4)
           ON CONFLICT (room_id) DO UPDATE
           SET center_latitude = EXCLUDED.center_latitude,
               center_longitude = EXCLUDED.center_longitude,
               radius_meters = EXCLUDED.radius_meters,
               updated_at = clock_timestamp()`,
          [
            room.id,
            privateBoundary.center.latitude,
            privateBoundary.center.longitude,
            privateBoundary.radiusMeters,
          ],
        );
      } else {
        await client.query(
          `DELETE FROM public.room_private_manhunt_boundaries
           WHERE room_id = $1`,
          [room.id],
        );
      }

      return {
        roomId: room.id,
        roomCode: room.room_code,
        gameMode: room.game_mode,
        lifecycleStatus: room.lifecycle_status,
        currentGameId: room.current_game_id,
        version,
      };
    });
  }

  async transitionRoomGameStatus(
    input: TransitionRoomGameStatusInput,
  ): Promise<TransitionedRoomGameStatusInfo> {
    const roomCode = roomCodeSchema.safeParse(input.roomCode);
    if (!roomCode.success || roomCode.data !== input.roomCode) {
      throw new TypeError("Room code must be four uppercase letters.");
    }
    if (!/^[1-9]\d*$/.test(input.expectedVersion)) {
      throw new TypeError("Expected room version must be a positive integer.");
    }
    if (
      typeof input.expectedRoomId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(input.expectedRoomId)
    ) {
      throw new TypeError("Expected room ID must be a UUID.");
    }
    if (
      input.expectedCurrentGameId !== null
      && (
        typeof input.expectedCurrentGameId !== "string"
        || input.expectedCurrentGameId.length === 0
      )
    ) {
      throw new TypeError("Expected game ID must be a non-empty string or null.");
    }
    if (
      input.nextGameId !== null
      && (
        typeof input.nextGameId !== "string"
        || input.nextGameId.length === 0
      )
    ) {
      throw new TypeError("Next game ID must be a non-empty string or null.");
    }
    if (
      !["waiting", "starting", "in_progress", "finished"].includes(
        input.expectedStatus,
      )
      || !["waiting", "starting", "in_progress", "finished"].includes(
        input.nextStatus,
      )
    ) {
      throw new TypeError("Room game status is invalid.");
    }
    if (
      input.initiatedBy.kind !== "host"
      && input.initiatedBy.kind !== "game-service"
    ) {
      throw new TypeError("Room game status transition initiator is invalid.");
    }
    if (
      input.initiatedBy.kind === "host"
      && (
        typeof input.initiatedBy.playerId !== "string"
        || input.initiatedBy.playerId.length === 0
      )
    ) {
      throw new TypeError("Host player ID is invalid.");
    }

    return this.withRuntimeFenceTransaction(async (client) => {
      const roomResult = await client.query<RoomGameStatusTransitionRow>(
        `SELECT id::text, room_code, game_mode, host_player_id::text,
                game_status, lifecycle_status, current_game_id, version::text
         FROM public.rooms
         WHERE room_code = $1
         FOR UPDATE`,
        [roomCode.data],
      );
      const room = roomResult.rows[0];
      if (!room) {
        throw new RoomGameStatusTransitionError(
          "ROOM_NOT_FOUND",
          "Room was not found.",
        );
      }
      if (room.id.toLowerCase() !== input.expectedRoomId.toLowerCase()) {
        throw new RoomGameStatusTransitionError(
          "STALE_ROOM_ID",
          "Room identity changed before the transition could be applied.",
        );
      }
      if (room.lifecycle_status !== "active") {
        throw new RoomGameStatusTransitionError(
          "ROOM_NOT_ACTIVE",
          "Room is not active.",
        );
      }

      if (input.initiatedBy.kind === "host") {
        const membershipResult = await client.query<RoomGameStatusTransitionMemberRow>(
          `SELECT membership_status, connection_status
           FROM public.room_players
           WHERE room_id = $1 AND player_id = $2
           FOR UPDATE`,
          [room.id, input.initiatedBy.playerId],
        );
        const membership = membershipResult.rows[0];
        if (!membership || membership.membership_status !== "active") {
          throw new RoomGameStatusTransitionError(
            "MEMBERSHIP_NOT_ACTIVE",
            "Player does not have an active membership in this room.",
          );
        }
        if (room.host_player_id !== input.initiatedBy.playerId) {
          throw new RoomGameStatusTransitionError(
            "NOT_HOST",
            "Only the current room host can perform this transition.",
          );
        }
        if (membership.connection_status !== "connected") {
          throw new RoomGameStatusTransitionError(
            "HOST_NOT_CONNECTED",
            "The room host must be connected to perform this transition.",
          );
        }
      }

      if (room.game_status !== input.expectedStatus) {
        throw new RoomGameStatusTransitionError(
          "STALE_STATUS",
          "Room game status changed before the transition could be applied.",
        );
      }
      if (room.version !== input.expectedVersion) {
        throw new RoomGameStatusTransitionError(
          "STALE_VERSION",
          "Room version changed before the transition could be applied.",
        );
      }
      if (room.current_game_id !== input.expectedCurrentGameId) {
        throw new RoomGameStatusTransitionError(
          "STALE_GAME_ID",
          "Current game ID changed before the transition could be applied.",
        );
      }
      if (
        !isAllowedRoomGameStatusTransition(
          room.game_mode,
          input.initiatedBy.kind,
          input.expectedStatus,
          input.nextStatus,
        )
      ) {
        throw new RoomGameStatusTransitionError(
          "INVALID_TRANSITION",
          "This room mode does not allow the requested game-status transition.",
        );
      }

      const gameIdentityIsValid = input.nextStatus === "starting"
        ? input.nextGameId !== null
          && (
            input.expectedStatus === "waiting"
              ? input.expectedCurrentGameId === null
              : input.expectedStatus === "finished"
                && input.expectedCurrentGameId !== null
                && input.nextGameId !== input.expectedCurrentGameId
          )
        : input.nextStatus === "waiting"
          ? input.expectedCurrentGameId !== null && input.nextGameId === null
          : input.expectedCurrentGameId !== null
            && input.nextGameId === input.expectedCurrentGameId;
      if (!gameIdentityIsValid) {
        throw new RoomGameStatusTransitionError(
          "INVALID_TRANSITION",
          "Game ID changes do not match the requested status transition.",
        );
      }

      const update = await client.query<{
        game_status: GameStatus;
        lifecycle_status: RoomLifecycleStatus;
        current_game_id: GameSessionId | null;
        version: string;
      }>(
        `UPDATE public.rooms
         SET game_status = $3,
             current_game_id = $4,
             version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
           AND room_code = $2
           AND lifecycle_status = 'active'
           AND game_status = $5
           AND version = $6::bigint
           AND current_game_id IS NOT DISTINCT FROM $7
         RETURNING game_status, lifecycle_status, current_game_id,
                   version::text`,
        [
          input.expectedRoomId,
          input.roomCode,
          input.nextStatus,
          input.nextGameId,
          input.expectedStatus,
          input.expectedVersion,
          input.expectedCurrentGameId,
        ],
      );
      const updated = update.rows[0];
      if (update.rowCount !== 1 || !updated) {
        throw new RoomGameStatusTransitionError(
          "STALE_VERSION",
          "Room changed before the game-status transition could be applied.",
        );
      }

      return {
        roomId: room.id,
        roomCode: room.room_code,
        gameMode: room.game_mode,
        gameStatus: updated.game_status,
        lifecycleStatus: updated.lifecycle_status,
        currentGameId: updated.current_game_id,
        version: updated.version,
      };
    });
  }

  async joinRoom(input: JoinRoomInput): Promise<JoinedRoomInfo> {
    const roomCode = roomCodeSchema.safeParse(input.roomCode);
    if (!roomCode.success || roomCode.data !== input.roomCode) {
      throw new TypeError("Room code must be four uppercase letters.");
    }

    const nickname = nicknameSchema.safeParse(input.nickname);
    if (!nickname.success) {
      throw new TypeError("Player nickname is invalid.");
    }
    if (
      !Buffer.isBuffer(input.reconnectTokenHash)
      || input.reconnectTokenHash.length !== 32
    ) {
      throw new TypeError("Reconnect token hash must contain exactly 32 bytes.");
    }
    if ((input.expectedRoomId === undefined) !== (input.expectedVersion === undefined)) {
      throw new TypeError("Expected room ID and version must be provided together.");
    }
    if (
      input.expectedRoomId !== undefined
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.expectedRoomId,
      )
    ) {
      throw new TypeError("Expected room ID must be a UUID.");
    }
    if (
      input.expectedVersion !== undefined
      && !/^[1-9]\d*$/.test(input.expectedVersion)
    ) {
      throw new TypeError("Expected room version must be a positive decimal string.");
    }

    return this.withRuntimeFenceTransaction(async (client) => {
      // Every join must hold this lock before counting or inserting memberships.
      const roomResult = await client.query<JoinableRoomRow>(
        `SELECT id::text, room_code, game_mode, max_players, game_status,
               lifecycle_status, current_game_id, version::text,
                (expires_at IS NOT NULL AND expires_at <= clock_timestamp())
                  AS expiry_passed
         FROM public.rooms
         WHERE room_code = $1
         FOR UPDATE`,
        [roomCode.data],
      );
      const room = roomResult.rows[0];
      if (!room) {
        throw new RoomJoinError("ROOM_NOT_FOUND", "Room was not found.");
      }
      if (
        input.expectedRoomId !== undefined
        && (
          room.id !== input.expectedRoomId
          || room.version !== input.expectedVersion
        )
      ) {
        throw new RoomJoinError(
          "STALE_VERSION",
          "Room changed before the join could be committed.",
        );
      }
      if (room.lifecycle_status === "closed") {
        throw new RoomJoinError(
          "ROOM_NOT_ACCEPTING_JOINS",
          "Room is closed and is not accepting joins.",
        );
      }
      if (room.lifecycle_status !== "active") {
        throw new RoomJoinError(
          "ROOM_EXPIRED_OR_CLOSED",
          "Room is expired or closed.",
        );
      }
      if (room.expiry_passed) {
        throw new RoomJoinError(
          "ROOM_EXPIRED_OR_CLOSED",
          "Room is expired or closed.",
        );
      }
      if (room.game_status !== "waiting") {
        throw new RoomJoinError(
          "GAME_ALREADY_STARTED",
          "The game has already started.",
        );
      }

      const memberCountResult = await client.query<{ active_count: number }>(
        `SELECT count(*)::int AS active_count
         FROM public.room_players
         WHERE room_id = $1 AND membership_status = $2`,
        [room.id, "active"],
      );
      const activeCount = memberCountResult.rows[0]?.active_count;
      if (activeCount === undefined) {
        throw new Error("Unable to count active room members.");
      }
      if (activeCount >= room.max_players) {
        throw new RoomJoinError("ROOM_FULL", "Room is full.");
      }

      const membershipResult = await client.query<{ player_id: string }>(
        `INSERT INTO public.room_players (
           player_id, room_id, nickname, connection_status,
           membership_status, reconnect_token_hash,
           reconnect_deadline_at, disconnect_generation
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (player_id) DO NOTHING
         RETURNING player_id::text`,
        [
          input.playerId,
          room.id,
          nickname.data,
          "connected",
          "active",
          input.reconnectTokenHash,
          null,
          0,
        ],
      );
      if (membershipResult.rowCount !== 1) {
        throw new RoomJoinError(
          "PLAYER_ALREADY_EXISTS",
          "Player already has a room membership.",
        );
      }

      const roomUpdate = await client.query<{
        version: string;
        lifecycle_status: RoomLifecycleStatus;
        current_game_id: GameSessionId | null;
      }>(
        `UPDATE public.rooms
         SET version = version + 1, updated_at = now()
         WHERE id = $1
         RETURNING version::text, lifecycle_status, current_game_id`,
        [room.id],
      );
      const updatedRoom = roomUpdate.rows[0];
      if (roomUpdate.rowCount !== 1 || !updatedRoom) {
        throw new Error("Room join did not return the committed room metadata.");
      }

      return {
        roomId: room.id,
        roomCode: room.room_code,
        gameMode: room.game_mode,
        playerId: input.playerId,
        lifecycleStatus: updatedRoom.lifecycle_status,
        currentGameId: updatedRoom.current_game_id,
        version: updatedRoom.version,
      };
    });
  }

  async leaveRoom(input: LeaveRoomInput): Promise<LeftRoomInfo> {
    const roomCode = roomCodeSchema.safeParse(input.roomCode);
    if (!roomCode.success || roomCode.data !== input.roomCode) {
      throw new TypeError("Room code must be four uppercase letters.");
    }
    validateExpectedRoomVersion(input);

    return this.withRuntimeFenceTransaction(async (client) => {
      const roomResult = await client.query<RoomToLeaveRow>(
        `SELECT id::text, room_code, host_player_id::text,
                lifecycle_status, current_game_id, version::text
         FROM public.rooms
         WHERE room_code = $1
         FOR UPDATE`,
        [roomCode.data],
      );
      const room = roomResult.rows[0];
      if (!room) {
        throw new RoomLeaveError("ROOM_NOT_FOUND", "Room was not found.");
      }
      if (
        (input.expectedRoomId !== undefined && input.expectedRoomId !== room.id)
        || (input.expectedVersion !== undefined && input.expectedVersion !== room.version)
      ) {
        throw new RoomLeaveError("STALE_VERSION", "Room version is stale.");
      }

      const membershipResult = await client.query<{ player_id: PlayerId }>(
        `SELECT player_id::text
         FROM public.room_players
         WHERE room_id = $1
           AND player_id = $2
           AND membership_status = $3
         FOR UPDATE`,
        [room.id, input.playerId, "active"],
      );
      if (membershipResult.rowCount !== 1) {
        throw new RoomLeaveError(
          "MEMBERSHIP_NOT_ACTIVE",
          "Player does not have an active membership in this room.",
        );
      }

      const activeCountResult = await client.query<{ active_count: number }>(
        `SELECT count(*)::int AS active_count
         FROM public.room_players
         WHERE room_id = $1 AND membership_status = $2`,
        [room.id, "active"],
      );
      const activeCount = activeCountResult.rows[0]?.active_count;
      if (activeCount === undefined) {
        throw new Error("Unable to count active room members.");
      }

      const hostChanged = room.host_player_id === input.playerId;
      if (activeCount === 1) {
        await client.query(
          "DELETE FROM public.rooms WHERE id = $1",
          [room.id],
        );
        return {
          roomId: room.id,
          roomCode: room.room_code,
          playerId: input.playerId,
          deleted: true,
          hostChanged,
          currentGameId: room.current_game_id,
        };
      }

      const removedMembership = await client.query(
        `UPDATE public.room_players
         SET membership_status = $3,
             reconnect_token_hash = NULL,
             reconnect_deadline_at = NULL,
             removed_at = clock_timestamp()
         WHERE room_id = $1
           AND player_id = $2
           AND membership_status = $4`,
        [room.id, input.playerId, "removed", "active"],
      );
      if (removedMembership.rowCount !== 1) {
        throw new RoomLeaveError(
          "MEMBERSHIP_NOT_ACTIVE",
          "Player does not have an active membership in this room.",
        );
      }

      if (hostChanged) {
        const nextHostId = await this.findNextHost(
          client,
          room.id,
          input.playerId,
        );
        if (!nextHostId) {
          throw new RoomLeaveError(
            "HOST_TRANSFER_FAILED",
            "Unable to transfer room ownership to an active member.",
          );
        }

        const roomUpdate = await client.query<{
          version: string;
          host_player_id: PlayerId;
        }>(
          `UPDATE public.rooms
           SET host_player_id = $2,
               version = version + 1,
               updated_at = clock_timestamp()
           WHERE id = $1
           RETURNING version::text, host_player_id::text`,
          [room.id, nextHostId],
        );
        const updatedRoom = roomUpdate.rows[0];
        if (
          roomUpdate.rowCount !== 1
          || updatedRoom?.version === undefined
          || updatedRoom.host_player_id !== nextHostId
        ) {
          throw new Error("Host transfer did not return the committed room version.");
        }
        return {
          roomId: room.id,
          roomCode: room.room_code,
          playerId: input.playerId,
          deleted: false,
          hostChanged: true,
          hostPlayerId: updatedRoom.host_player_id,
          lifecycleStatus: room.lifecycle_status,
          currentGameId: room.current_game_id,
          version: updatedRoom.version,
        };
      } else {
        const roomUpdate = await client.query<{ version: string }>(
          `UPDATE public.rooms
           SET version = version + 1,
               updated_at = clock_timestamp()
           WHERE id = $1
           RETURNING version::text`,
          [room.id],
        );
        const version = roomUpdate.rows[0]?.version;
        if (roomUpdate.rowCount !== 1 || version === undefined) {
          throw new Error("Room leave did not return the committed room version.");
        }
        return {
          roomId: room.id,
          roomCode: room.room_code,
          playerId: input.playerId,
          deleted: false,
          hostChanged: false,
          lifecycleStatus: room.lifecycle_status,
          currentGameId: room.current_game_id,
          version,
        };
      }
    });
  }

  private async findNextHost(
    client: PoolClient,
    roomId: string,
    departingPlayerId: PlayerId,
  ): Promise<PlayerId | undefined> {
    const candidateResult = await client.query<{ player_id: PlayerId }>(
      `SELECT player_id::text
       FROM public.room_players
       WHERE room_id = $1
         AND membership_status = $2
         AND player_id <> $3
       ORDER BY
         CASE connection_status
           WHEN 'connected' THEN 0
           WHEN 'disconnected' THEN 1
           ELSE 2
         END,
         joined_at,
         player_id
       FOR UPDATE`,
      [roomId, "active", departingPlayerId],
    );
    return candidateResult.rows[0]?.player_id;
  }

  async markDisconnected(
    input: MarkDisconnectedInput,
  ): Promise<MarkDisconnectedResult> {
    const roomCode = roomCodeSchema.safeParse(input.roomCode);
    if (!roomCode.success || roomCode.data !== input.roomCode) {
      throw new TypeError("Room code must be four uppercase letters.");
    }
    validateExpectedRoomVersion(input);
    if (
      !(input.reconnectDeadlineAt instanceof Date)
      || !Number.isFinite(input.reconnectDeadlineAt.getTime())
      || input.reconnectDeadlineAt.getTime() <= Date.now()
    ) {
      throw new RoomConnectionError(
        "INVALID_RECONNECT_DEADLINE",
        "Reconnect deadline must be a valid future date.",
      );
    }

    return this.withRuntimeFenceTransaction(async (client) => {
      // Keep the room-then-membership lock order shared with reconnectPlayer.
      const roomResult = await client.query<RoomConnectionRow>(
        `SELECT id::text, room_code, lifecycle_status, current_game_id,
                version::text
         FROM public.rooms
         WHERE room_code = $1
         FOR UPDATE`,
        [roomCode.data],
      );
      const room = roomResult.rows[0];
      if (!room) {
        throw new RoomConnectionError("ROOM_NOT_FOUND", "Room was not found.");
      }
      if (
        (input.expectedRoomId !== undefined && input.expectedRoomId !== room.id)
        || (input.expectedVersion !== undefined && input.expectedVersion !== room.version)
      ) {
        throw new RoomConnectionError("STALE_VERSION", "Room version is stale.");
      }

      const membershipResult = await client.query<MembershipConnectionStateRow>(
        `SELECT membership_status, connection_status
         FROM public.room_players
         WHERE room_id = $1 AND player_id = $2
         FOR UPDATE`,
        [room.id, input.playerId],
      );
      const membership = membershipResult.rows[0];
      if (!membership) {
        throw new RoomConnectionError(
          "MEMBERSHIP_NOT_FOUND",
          "Player membership was not found.",
        );
      }
      if (membership.membership_status !== "active") {
        throw new RoomConnectionError(
          "MEMBERSHIP_NOT_ACTIVE",
          "Player does not have an active membership.",
        );
      }
      if (membership.connection_status !== "connected") {
        throw new RoomConnectionError(
          "MEMBERSHIP_NOT_CONNECTED",
          "Player is not currently connected.",
        );
      }

      const deadlineCheck = await client.query<{ is_future: boolean }>(
        "SELECT $1::timestamptz > clock_timestamp() AS is_future",
        [input.reconnectDeadlineAt],
      );
      if (deadlineCheck.rows[0]?.is_future !== true) {
        throw new RoomConnectionError(
          "INVALID_RECONNECT_DEADLINE",
          "Reconnect deadline must be a valid future date.",
        );
      }

      const updatedMembership = await client.query<{
        disconnect_generation: string;
        reconnect_deadline_at: Date;
      }>(
        `UPDATE public.room_players
         SET connection_status = $3,
             reconnect_deadline_at = $4,
             disconnect_generation = disconnect_generation + 1
         WHERE room_id = $1
           AND player_id = $2
           AND membership_status = $5
           AND connection_status = $6
           AND $4::timestamptz > clock_timestamp()
         RETURNING disconnect_generation::text, reconnect_deadline_at`,
        [
          room.id,
          input.playerId,
          "disconnected",
          input.reconnectDeadlineAt,
          "active",
          "connected",
        ],
      );
      const updated = updatedMembership.rows[0];
      if (!updated) {
        const deadlineCheck = await client.query<{ is_future: boolean }>(
          "SELECT $1::timestamptz > clock_timestamp() AS is_future",
          [input.reconnectDeadlineAt],
        );
        if (deadlineCheck.rows[0]?.is_future !== true) {
          throw new RoomConnectionError(
            "INVALID_RECONNECT_DEADLINE",
            "Reconnect deadline must be a valid future date.",
          );
        }
        throw new RoomConnectionError(
          "MEMBERSHIP_NOT_CONNECTED",
          "Player is not currently connected.",
        );
      }

      const roomUpdate = await client.query<{ version: string }>(
        `UPDATE public.rooms
         SET version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING version::text`,
        [room.id],
      );
      const version = roomUpdate.rows[0]?.version;
      if (roomUpdate.rowCount !== 1 || version === undefined) {
        throw new Error("Disconnect update did not return the committed room version.");
      }

      return {
        roomId: room.id,
        roomCode: room.room_code,
        playerId: input.playerId,
        disconnectGeneration: updated.disconnect_generation,
        reconnectDeadlineAt: updated.reconnect_deadline_at,
        lifecycleStatus: room.lifecycle_status,
        currentGameId: room.current_game_id,
        version,
      };
    });
  }

  async reconnectPlayer(
    input: ReconnectPlayerInput,
  ): Promise<ReconnectedPlayerInfo> {
    const roomCode = roomCodeSchema.safeParse(input.roomCode);
    if (!roomCode.success || roomCode.data !== input.roomCode) {
      throw new TypeError("Room code must be four uppercase letters.");
    }
    validateExpectedRoomVersion(input);
    if (
      typeof input.reconnectToken !== "string"
      || input.reconnectToken.length < 1
      || input.reconnectToken.length > 128
    ) {
      throw new RoomConnectionError(
        "INVALID_RECONNECT_CREDENTIALS",
        "Reconnect credentials are invalid or expired.",
      );
    }
    const suppliedHash = createHash("sha256")
      .update(input.reconnectToken, "utf8")
      .digest();

    return this.withRuntimeFenceTransaction(async (client) => {
      // Acquire locks in the same order as markDisconnected to serialize races.
      const roomResult = await client.query<ReconnectRoomRow>(
        `SELECT id::text, room_code, lifecycle_status, current_game_id,
                version::text
         FROM public.rooms
         WHERE room_code = $1
         FOR UPDATE`,
        [roomCode.data],
      );
      const room = roomResult.rows[0];
      if (!room) {
        throw new RoomConnectionError("ROOM_NOT_FOUND", "Room was not found.");
      }
      if (
        (input.expectedRoomId !== undefined && input.expectedRoomId !== room.id)
        || (input.expectedVersion !== undefined && input.expectedVersion !== room.version)
      ) {
        throw new RoomConnectionError("STALE_VERSION", "Room version is stale.");
      }
      if (room.lifecycle_status !== "active") {
        throw new RoomConnectionError(
          "ROOM_NOT_ACTIVE",
          "Room is not active.",
        );
      }

      const membershipResult = await client.query<ConnectionMembershipRow>(
        `SELECT membership_status, connection_status,
                disconnect_generation::text,
                reconnect_token_hash, reconnect_deadline_at
         FROM public.room_players
         WHERE room_id = $1 AND player_id = $2
         FOR UPDATE`,
        [room.id, input.playerId],
      );
      const membership = membershipResult.rows[0];
      if (!membership) {
        throw new RoomConnectionError(
          "MEMBERSHIP_NOT_FOUND",
          "Player membership was not found.",
        );
      }
      if (membership.membership_status !== "active") {
        throw new RoomConnectionError(
          "MEMBERSHIP_NOT_ACTIVE",
          "Player does not have an active membership.",
        );
      }
      if (membership.connection_status !== "disconnected") {
        throw new RoomConnectionError(
          "MEMBERSHIP_NOT_DISCONNECTED",
          "Player is not disconnected.",
        );
      }

      const storedHash = membership.reconnect_token_hash;
      if (
        !Buffer.isBuffer(storedHash)
        || storedHash.length !== suppliedHash.length
        || !timingSafeEqual(storedHash, suppliedHash)
      ) {
        throw new RoomConnectionError(
          "INVALID_RECONNECT_CREDENTIALS",
          "Reconnect credentials are invalid or expired.",
        );
      }
      if (!membership.reconnect_deadline_at) {
        throw new RoomConnectionError(
          "RECONNECT_DEADLINE_MISSING",
          "Reconnect credentials are invalid or expired.",
        );
      }

      const deadlineCheck = await client.query<{ is_expired: boolean }>(
        "SELECT $1::timestamptz <= clock_timestamp() AS is_expired",
        [membership.reconnect_deadline_at],
      );
      if (deadlineCheck.rows[0]?.is_expired !== false) {
        throw new RoomConnectionError(
          "RECONNECT_DEADLINE_EXPIRED",
          "Reconnect credentials are invalid or expired.",
        );
      }

      const updatedMembership = await client.query<{
        disconnect_generation: string;
      }>(
        `UPDATE public.room_players
         SET connection_status = $3,
             reconnect_deadline_at = NULL,
             disconnect_generation = disconnect_generation + 1
         WHERE room_id = $1
           AND player_id = $2
           AND membership_status = $4
           AND connection_status = $5
           AND reconnect_deadline_at > clock_timestamp()
         RETURNING disconnect_generation::text`,
        [
          room.id,
          input.playerId,
          "connected",
          "active",
          "disconnected",
        ],
      );
      const updated = updatedMembership.rows[0];
      if (!updated) {
        throw new RoomConnectionError(
          "RECONNECT_DEADLINE_EXPIRED",
          "Reconnect credentials are invalid or expired.",
        );
      }

      const roomUpdate = await client.query<{ version: string }>(
        `UPDATE public.rooms
         SET version = version + 1,
             updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING version::text`,
        [room.id],
      );
      const version = roomUpdate.rows[0]?.version;
      if (roomUpdate.rowCount !== 1 || version === undefined) {
        throw new Error("Reconnect update did not return the committed room version.");
      }

      return {
        roomId: room.id,
        roomCode: room.room_code,
        playerId: input.playerId,
        disconnectGeneration: updated.disconnect_generation,
        lifecycleStatus: room.lifecycle_status,
        currentGameId: room.current_game_id,
        version,
      };
    });
  }

  async listDueDisconnectedMembers(
    input: ListDueDisconnectedMembersInput,
  ): Promise<DueDisconnectedMember[]> {
    if (
      !(input.now instanceof Date)
      || !Number.isFinite(input.now.getTime())
    ) {
      throw new TypeError("Discovery time must be a valid date.");
    }
    if (
      !Number.isInteger(input.limit)
      || input.limit < 1
      || input.limit > 1_000
    ) {
      throw new RangeError("Discovery limit must be between 1 and 1000.");
    }

    const result = await this.pool.query<DueDisconnectedMemberRow>(
      `SELECT r.room_code, rp.player_id::text,
              rp.disconnect_generation::text, rp.reconnect_deadline_at
       FROM public.room_players AS rp
       JOIN public.rooms AS r ON r.id = rp.room_id
       WHERE rp.membership_status = 'active'
         AND rp.connection_status = 'disconnected'
         AND rp.reconnect_deadline_at IS NOT NULL
         AND rp.reconnect_deadline_at <= $1
         AND r.lifecycle_status = 'active'
       ORDER BY rp.reconnect_deadline_at, rp.room_id, rp.player_id
       LIMIT $2`,
      [input.now, input.limit],
    );

    return result.rows.map((row) => ({
      roomCode: row.room_code,
      playerId: row.player_id,
      disconnectGeneration: row.disconnect_generation,
      reconnectDeadlineAt: row.reconnect_deadline_at,
    }));
  }

  async readDeferredRoomMutationState(
    roomCode: RoomCode,
    playerId: PlayerId,
  ): Promise<DeferredRoomMutationState> {
    const parsedRoomCode = roomCodeSchema.safeParse(roomCode);
    if (!parsedRoomCode.success || parsedRoomCode.data !== roomCode) {
      throw new TypeError("Room code must be four uppercase letters.");
    }

    return this.withRuntimeFenceTransaction(async (client) => {
      const roomResult = await client.query<DeferredMutationRoomRow>(
        `SELECT id::text, room_code, lifecycle_status, game_status,
                current_game_id, version::text, host_player_id::text
         FROM public.rooms
         WHERE room_code = $1
         FOR UPDATE`,
        [roomCode],
      );
      const room = roomResult.rows[0];
      if (!room) {
        return { room: null };
      }

      const [memberResult, countResult] = await Promise.all([
        client.query<DeferredMutationMemberRow>(
          `SELECT membership_status, connection_status,
                  disconnect_generation::text, reconnect_deadline_at
           FROM public.room_players
           WHERE room_id = $1 AND player_id = $2
           FOR UPDATE`,
          [room.id, playerId],
        ),
        client.query<{ active_member_count: number }>(
          `SELECT count(*)::int AS active_member_count
           FROM public.room_players
           WHERE room_id = $1 AND membership_status = 'active'`,
          [room.id],
        ),
      ]);
      const activeMemberCount = countResult.rows[0]?.active_member_count;
      if (activeMemberCount === undefined) {
        throw new Error("Could not read the active room member count.");
      }

      const memberRow = memberResult.rows[0];
      if (!memberRow) {
        return {
          room: {
            roomId: room.id,
            roomCode: room.room_code,
            lifecycleStatus: room.lifecycle_status,
            gameStatus: room.game_status,
            currentGameId: room.current_game_id,
            version: room.version,
            hostPlayerId: room.host_player_id,
            activeMemberCount,
          },
        };
      }
      if (
        (memberRow.membership_status !== "active"
          && memberRow.membership_status !== "removed")
        || (memberRow.connection_status !== "connected"
          && memberRow.connection_status !== "disconnected")
        || !/^\d+$/.test(memberRow.disconnect_generation)
        || (
          memberRow.reconnect_deadline_at !== null
          && !Number.isFinite(memberRow.reconnect_deadline_at.getTime())
        )
      ) {
        throw new Error("Deferred mutation reconciliation state is invalid.");
      }

      return {
        room: {
          roomId: room.id,
          roomCode: room.room_code,
          lifecycleStatus: room.lifecycle_status,
          gameStatus: room.game_status,
          currentGameId: room.current_game_id,
          version: room.version,
          hostPlayerId: room.host_player_id,
          activeMemberCount,
        },
        member: {
          membershipStatus: memberRow.membership_status,
          connectionStatus: memberRow.connection_status,
          disconnectGeneration: memberRow.disconnect_generation,
          reconnectDeadlineAt: memberRow.reconnect_deadline_at,
        },
      };
    });
  }

  async removeDisconnectedPlayer(
    input: RemoveDisconnectedPlayerInput,
  ): Promise<RemoveDisconnectedPlayerResult> {
    const roomCode = roomCodeSchema.safeParse(input.roomCode);
    if (!roomCode.success || roomCode.data !== input.roomCode) {
      throw new TypeError("Room code must be four uppercase letters.");
    }
    if (
      !(input.now instanceof Date)
      || !Number.isFinite(input.now.getTime())
    ) {
      throw new TypeError("Timeout time must be a valid date.");
    }
    if (
      typeof input.expectedDisconnectGeneration !== "string"
      || !/^\d+$/.test(input.expectedDisconnectGeneration)
    ) {
      throw new TypeError("Expected disconnect generation must be a non-negative integer.");
    }
    validateExpectedRoomVersion(input);
    if (
      input.expectedReconnectDeadlineAt !== undefined
      && (
        !(input.expectedReconnectDeadlineAt instanceof Date)
        || !Number.isFinite(input.expectedReconnectDeadlineAt.getTime())
      )
    ) {
      throw new TypeError("Expected reconnect deadline must be a valid date.");
    }

    return this.withRuntimeFenceTransaction(async (client) => {
      const roomResult = await client.query<TimeoutRoomRow>(
        `SELECT id::text, room_code, lifecycle_status, host_player_id::text,
                current_game_id, version::text
         FROM public.rooms
         WHERE room_code = $1
         FOR UPDATE`,
        [roomCode.data],
      );
      const room = roomResult.rows[0];
      if (!room) {
        return {
          status: "stale",
          roomCode: roomCode.data,
          playerId: input.playerId,
          reason: "room_not_found",
        };
      }
      if (input.expectedRoomId !== undefined && input.expectedRoomId !== room.id) {
        return {
          status: "stale",
          roomCode: room.room_code,
          playerId: input.playerId,
          reason: "room_id_mismatch",
        };
      }
      if (
        input.expectedVersion !== undefined
        && input.expectedVersion !== room.version
      ) {
        return {
          status: "stale",
          roomCode: room.room_code,
          playerId: input.playerId,
          reason: "version_mismatch",
        };
      }
      if (room.lifecycle_status !== "active") {
        return {
          status: "stale",
          roomCode: room.room_code,
          playerId: input.playerId,
          reason: "room_not_active",
        };
      }

      const membershipResult = await client.query<TimeoutMembershipRow>(
        `SELECT membership_status, connection_status,
                disconnect_generation::text, reconnect_deadline_at,
                reconnect_deadline_at <= $3 AS deadline_is_due,
                ($4::timestamptz IS NULL OR reconnect_deadline_at = $4)
                  AS deadline_matches
         FROM public.room_players
         WHERE room_id = $1 AND player_id = $2
         FOR UPDATE`,
        [
          room.id,
          input.playerId,
          input.now,
          input.expectedReconnectDeadlineAt ?? null,
        ],
      );
      const membership = membershipResult.rows[0];
      if (!membership) {
        return {
          status: "stale",
          roomCode: room.room_code,
          playerId: input.playerId,
          reason: "membership_not_found",
        };
      }
      if (membership.membership_status !== "active") {
        return {
          status: "stale",
          roomCode: room.room_code,
          playerId: input.playerId,
          reason: "membership_not_active",
        };
      }
      if (
        membership.disconnect_generation
        !== input.expectedDisconnectGeneration
      ) {
        return {
          status: "stale",
          roomCode: room.room_code,
          playerId: input.playerId,
          reason: "generation_mismatch",
        };
      }
      if (membership.connection_status !== "disconnected") {
        return {
          status: "stale",
          roomCode: room.room_code,
          playerId: input.playerId,
          reason: "membership_not_disconnected",
        };
      }
      if (!membership.reconnect_deadline_at) {
        return {
          status: "stale",
          roomCode: room.room_code,
          playerId: input.playerId,
          reason: "deadline_missing",
        };
      }
      if (!membership.deadline_matches) {
        return {
          status: "stale",
          roomCode: room.room_code,
          playerId: input.playerId,
          reason: "deadline_mismatch",
        };
      }
      if (!membership.deadline_is_due) {
        return {
          status: "not_due",
          roomCode: room.room_code,
          playerId: input.playerId,
        };
      }

      const activeCountResult = await client.query<{ active_count: number }>(
        `SELECT count(*)::int AS active_count
         FROM public.room_players
         WHERE room_id = $1 AND membership_status = 'active'`,
        [room.id],
      );
      const activeCount = activeCountResult.rows[0]?.active_count;
      if (activeCount === undefined || activeCount < 1) {
        throw new Error("Unable to count active room members.");
      }
      if (activeCount === 1) {
        await client.query("DELETE FROM public.rooms WHERE id = $1", [room.id]);
        return {
          status: "room_deleted",
          roomId: room.id,
          roomCode: room.room_code,
          playerId: input.playerId,
          deleted: true,
          currentGameId: room.current_game_id,
        };
      }

      const hostChanged = room.host_player_id === input.playerId;
      const nextHostId = hostChanged
        ? await this.findNextHost(client, room.id, input.playerId)
        : undefined;
      if (hostChanged && !nextHostId) {
        throw new Error("Unable to transfer room ownership to an active member.");
      }

      const removedMembership = await client.query(
        `UPDATE public.room_players
         SET membership_status = 'removed',
             reconnect_token_hash = NULL,
             reconnect_deadline_at = NULL,
             removed_at = clock_timestamp()
         WHERE room_id = $1
           AND player_id = $2
           AND membership_status = 'active'
           AND connection_status = 'disconnected'
           AND disconnect_generation = $3
           AND reconnect_deadline_at <= $4
           AND ($5::timestamptz IS NULL OR reconnect_deadline_at = $5)`,
        [
          room.id,
          input.playerId,
          input.expectedDisconnectGeneration,
          input.now,
          input.expectedReconnectDeadlineAt ?? null,
        ],
      );
      if (removedMembership.rowCount !== 1) {
        throw new Error("Disconnected membership changed during timeout removal.");
      }

      if (hostChanged) {
        const roomUpdate = await client.query<{
          version: string;
          host_player_id: PlayerId;
        }>(
          `UPDATE public.rooms
           SET host_player_id = $2,
               version = version + 1,
               updated_at = clock_timestamp()
           WHERE id = $1
           RETURNING version::text, host_player_id::text`,
          [room.id, nextHostId],
        );
        const updatedRoom = roomUpdate.rows[0];
        if (
          roomUpdate.rowCount !== 1
          || updatedRoom?.version === undefined
          || updatedRoom.host_player_id !== nextHostId
        ) {
          throw new Error("Timeout host transfer did not return the committed room version.");
        }
        return {
          status: "removed",
          roomId: room.id,
          roomCode: room.room_code,
          playerId: input.playerId,
          deleted: false,
          hostChanged,
          hostPlayerId: updatedRoom.host_player_id,
          lifecycleStatus: room.lifecycle_status,
          currentGameId: room.current_game_id,
          version: updatedRoom.version,
        };
      } else {
        const roomUpdate = await client.query<{ version: string }>(
          `UPDATE public.rooms
           SET version = version + 1,
               updated_at = clock_timestamp()
           WHERE id = $1
           RETURNING version::text`,
          [room.id],
        );
        const version = roomUpdate.rows[0]?.version;
        if (roomUpdate.rowCount !== 1 || version === undefined) {
          throw new Error("Timeout removal did not return the committed room version.");
        }
        return {
          status: "removed",
          roomId: room.id,
          roomCode: room.room_code,
          playerId: input.playerId,
          deleted: false,
          lifecycleStatus: room.lifecycle_status,
          currentGameId: room.current_game_id,
          version,
        };
      }
    });
  }
}
