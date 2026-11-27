import { joinRoomSchema } from "@impostor/api";
import type {
  CreateRoomPayload,
  CreateRoomResponse,
  GameSessionId,
  JoinRoomPayload,
  JoinRoomResponse,
  PlayerId,
  ReconnectPayload,
  RoomCode,
} from "@impostor/api";
import { RoomPersistenceCoordinator } from "./room-persistence-coordinator.js";
import type { RoomPersistenceMetadata } from "./room-persistence-coordinator.js";
import {
  RoomConnectionError,
  RoomGameStatusTransitionError,
  RoomJoinError,
  RoomLeaveError,
  RoomRuntimeFencingError,
  RoomSettingsUpdateError,
} from "./postgres-room-repository.js";
import type {
  CreatedRoomInfo,
  CreateRoomWithHostInput,
  LeftRoomInfo,
  JoinedRoomInfo,
  JoinRoomInput,
  MarkDisconnectedResult,
  ReconnectedPlayerInfo,
  RemoveDisconnectedPlayerResult,
  DeferredRoomMutationState,
  DueWaitingRoomExpiration,
  ExpiredWaitingRoom,
  TransitionRoomGameStatusInput,
  TransitionedRoomGameStatusInfo,
  UpdatedWaitingRoomSettingsInfo,
  PostgresRoomRepository,
} from "./postgres-room-repository.js";
import { RoomService } from "./room-service.js";
import type {
  PersistedDisconnect,
  PersistedPlayerRemoval,
  PreparedDisconnectedPlayerRemoval,
  PreparedRoomDisconnect,
  PreparedRoomJoin,
  PreparedRoomLeave,
  PreparedRoomReconnect,
  PreparedWaitingRoomSettingsUpdate,
  PlayerDisconnect,
  PlayerRemoval,
  ReconnectResult,
  RoomGameStatusReservation,
} from "./room-service.js";
import { AppError } from "../utils/app-error.js";
import type { Room, RoomSettings, UpdateRoomSettingsPayload } from "@impostor/api";

const MAX_CREATE_ATTEMPTS = 5;

function incrementVersion(value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new TypeError("Room versions and disconnect generations must be decimal strings.");
  }
  return (BigInt(value) + 1n).toString();
}

interface DeferredMutationAttempt<TPrepared> {
  metadata?: RoomPersistenceMetadata;
  prepared?: TPrepared;
}

export interface DurableTimeoutRetry {
  retryAt: Date;
}

type RoomCreateAndJoinRepository = Pick<
  PostgresRoomRepository,
  "createRoomWithHost" | "joinRoom"
> & Partial<Pick<
  PostgresRoomRepository,
  | "leaveRoom"
  | "markDisconnected"
  | "reconnectPlayer"
  | "removeDisconnectedPlayer"
  | "readDeferredRoomMutationState"
  | "updateWaitingRoomSettings"
  | "transitionRoomGameStatus"
  | "listDueWaitingRoomExpirations"
  | "expireWaitingRoom"
>>;

function isActiveRoomCodeCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; constraint?: unknown };
  return (
    candidate.code === "23505"
    && candidate.constraint === "rooms_active_room_code_key"
  );
}

function isRoomJoinError(error: unknown): error is RoomJoinError {
  return error instanceof RoomJoinError;
}

export class RoomPersistenceCommands {
  private readonly inFlightSockets = new Set<string>();
  private readonly inFlightSocketOperations = new Map<string, Promise<void>>();
  private readonly uncertainExpirations = new Set<string>();

  constructor(
    private readonly rooms: RoomService,
    private readonly repository: RoomCreateAndJoinRepository,
    private readonly coordinator: RoomPersistenceCoordinator,
  ) {}

  async listDueWaitingRoomExpirations(
    limit?: number,
  ): Promise<DueWaitingRoomExpiration[]> {
    if (!this.repository.listDueWaitingRoomExpirations) {
      throw new AppError(
        "FEATURE_UNAVAILABLE",
        "Durable room expiration is unavailable.",
      );
    }
    return this.repository.listDueWaitingRoomExpirations(limit);
  }

  async expireWaitingRoom(
    candidate: DueWaitingRoomExpiration,
  ): Promise<ExpiredWaitingRoom | undefined> {
    if (!this.repository.expireWaitingRoom) {
      throw new AppError(
        "FEATURE_UNAVAILABLE",
        "Durable room expiration is unavailable.",
      );
    }
    const expirationKey =
      `${candidate.roomId}\u0000${candidate.expectedVersion}`;
    const expireWaitingRoom =
      this.repository.expireWaitingRoom.bind(this.repository);

    return this.coordinator.runExclusiveForReconciliation(
      candidate.roomCode,
      async (metadata) => {
        const alreadyExpired =
          metadata.roomId === candidate.roomId
          && metadata.lifecycleStatus === "expired"
          && metadata.gameStatus === "waiting"
          && metadata.currentGameId === null
          && metadata.version === (BigInt(candidate.expectedVersion) + 1n).toString();
        if (alreadyExpired) {
          this.uncertainExpirations.delete(expirationKey);
          this.rooms.fenceRoom(candidate.roomCode);
          if (!this.coordinator.isFenced(candidate.roomCode)) {
            this.coordinator.fenceRoom(candidate.roomCode, candidate.roomId);
          }
          return {
            roomId: metadata.roomId,
            roomCode: metadata.roomCode,
            version: metadata.version,
          };
        }
        const wasFenced = this.coordinator.isFenced(candidate.roomCode);
        if (wasFenced && !this.uncertainExpirations.has(expirationKey)) {
          throw new AppError(
            "UNKNOWN",
            "The room is fenced for another unresolved persistence operation.",
          );
        }
        if (
          metadata.roomId !== candidate.roomId
          || metadata.version !== candidate.expectedVersion
          || metadata.lifecycleStatus !== "active"
          || metadata.gameStatus !== "waiting"
          || metadata.currentGameId !== null
        ) {
          return undefined;
        }

        let expired: ExpiredWaitingRoom | undefined;
        this.uncertainExpirations.add(expirationKey);
        try {
          expired = await expireWaitingRoom(candidate);
        } catch (error) {
          this.tryFenceRoom(candidate.roomCode, candidate.roomId);
          throw error;
        }
        if (!expired) {
          if (wasFenced) {
            throw new Error(
              "Canonical room state did not resolve the uncertain expiration.",
            );
          }
          this.uncertainExpirations.delete(expirationKey);
          return undefined;
        }
        if (
          expired.roomId !== candidate.roomId
          || expired.roomCode !== candidate.roomCode
          || expired.version !== (BigInt(candidate.expectedVersion) + 1n).toString()
        ) {
          this.tryFenceRoom(candidate.roomCode, candidate.roomId);
          throw new Error("Expired room result does not match its prepared identity.");
        }

        const nextMetadata: RoomPersistenceMetadata = {
          ...metadata,
          version: expired.version,
          lifecycleStatus: "expired",
        };
        try {
          if (wasFenced) {
            this.coordinator.synchronizeFencedMetadata(nextMetadata);
          } else {
            this.coordinator.recordCommittedMutation(
              candidate.roomCode,
              candidate.expectedVersion,
              { ...expired, lifecycleStatus: "expired" },
            );
          }
          this.rooms.fenceRoom(candidate.roomCode);
          this.coordinator.fenceRoom(candidate.roomCode, candidate.roomId);
        } catch {
          this.tryFenceRoom(candidate.roomCode, candidate.roomId);
          throw new AppError(
            "UNKNOWN",
            "The expired room requires reconciliation before cleanup.",
          );
        }
        this.uncertainExpirations.delete(expirationKey);
        return expired;
      },
    );
  }

  async completeExpiredRoomCleanup(
    expired: ExpiredWaitingRoom,
  ): Promise<boolean> {
    return this.coordinator.runExclusiveForReconciliation(
      expired.roomCode,
      async (metadata) => {
        if (
          metadata.roomId !== expired.roomId
          || metadata.version !== expired.version
          || metadata.lifecycleStatus !== "expired"
          || metadata.gameStatus !== "waiting"
          || metadata.currentGameId !== null
        ) {
          throw new Error("Expired room metadata changed before local cleanup.");
        }

        const removal = await this.rooms.removeExpiredWaitingRoom(
          expired.roomCode,
          expired.roomId,
        );
        if (removal.status === "blocked") {
          return false;
        }
        this.coordinator.removeExpiredRoom(
          expired.roomCode,
          expired.roomId,
          expired.version,
        );
        return true;
      },
    );
  }

  async createRoom(
    payload: CreateRoomPayload,
    socketId: string,
  ): Promise<CreateRoomResponse> {
    return this.runForSocket(socketId, async () => {
      let prepared = this.rooms.prepareRoomCreation(payload, socketId);
      const attemptedCodes = new Set<RoomCode>();

      for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
        while (
          this.coordinator.getMetadata(prepared.roomCode)
          || this.coordinator.isFenced(prepared.roomCode)
          || attemptedCodes.has(prepared.roomCode)
        ) {
          prepared = this.rooms.prepareRoomCreationWithNextCode(
            prepared,
            attemptedCodes,
          );
        }
        attemptedCodes.add(prepared.roomCode);

        const input: CreateRoomWithHostInput = {
          roomId: prepared.roomId,
          roomCode: prepared.roomCode,
          gameMode: prepared.settings.gameMode,
          settings: prepared.settings,
          maxPlayers: prepared.settings.maxPlayers,
          hostPlayerId: prepared.hostPlayerId,
          hostNickname: prepared.hostNickname,
          reconnectTokenHash: Buffer.from(prepared.reconnectTokenHash),
        };

        let created: CreatedRoomInfo;
        try {
          created = await this.repository.createRoomWithHost(input);
        } catch (error) {
          if (isActiveRoomCodeCollision(error) && attempt + 1 < MAX_CREATE_ATTEMPTS) {
            prepared = this.rooms.prepareRoomCreationWithNextCode(
              prepared,
              attemptedCodes,
            );
            continue;
          }
          throw new AppError(
            "UNKNOWN",
            "Could not create the room. Please try again.",
          );
        }

        if (
          created.roomId !== prepared.roomId
          || created.roomCode !== prepared.roomCode
          || created.hostPlayerId !== prepared.hostPlayerId
          || created.gameMode !== prepared.settings.gameMode
          || created.lifecycleStatus !== "active"
          || created.currentGameId !== null
        ) {
          this.tryFenceRoom(created.roomCode, created.roomId);
          this.tryFenceRoom(prepared.roomCode, prepared.roomId);
          throw new AppError(
            "UNKNOWN",
            "The room was stored but could not be activated safely.",
          );
        }

        try {
          this.coordinator.registerCreatedRoom(created);
        } catch {
          this.tryFenceRoom(created.roomCode, created.roomId);
          throw new AppError(
            "UNKNOWN",
            "The room was stored but could not be activated safely.",
          );
        }

        try {
          return this.rooms.commitPreparedRoomCreation(prepared, socketId);
        } catch {
          this.tryFenceRoom(created.roomCode, created.roomId);
          throw new AppError(
            "UNKNOWN",
            "The room was stored but could not be activated safely.",
          );
        }
      }

      throw new AppError(
        "UNKNOWN",
        "Could not allocate a unique room code. Please try again.",
      );
    });
  }

  async joinRoom(
    payload: JoinRoomPayload,
    socketId: string,
  ): Promise<JoinRoomResponse> {
    const parsed = joinRoomSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError("INVALID_PAYLOAD", "Room joining payload is invalid.");
    }

    return this.runForSocket(socketId, async () => {
      try {
        return await this.coordinator.runExclusive(
          parsed.data.roomCode,
          async (metadata) => {
            let prepared: PreparedRoomJoin;
            try {
              prepared = this.rooms.prepareRoomJoin(
                parsed.data,
                socketId,
                { checkLocalCapacity: false },
              );
            } catch (error) {
              if (error instanceof AppError) {
                throw error;
              }
              throw new AppError("UNKNOWN", "Could not join the room.");
            }

            const input: JoinRoomInput = {
              roomCode: prepared.roomCode,
              playerId: prepared.playerId,
              nickname: prepared.nickname,
              reconnectTokenHash: Buffer.from(prepared.reconnectTokenHash),
              expectedRoomId: metadata.roomId,
              expectedVersion: metadata.version,
            };

            let joined: JoinedRoomInfo;
            try {
              joined = await this.repository.joinRoom(input);
            } catch (error) {
              if (isRoomJoinError(error) && error.code === "STALE_VERSION") {
                this.tryFenceRoom(metadata.roomCode, metadata.roomId);
                throw new AppError(
                  "UNKNOWN",
                  "The room changed. Refresh the room and try again.",
                );
              }
              if (isRoomJoinError(error)) {
                switch (error.code) {
                  case "ROOM_NOT_FOUND":
                    throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
                  case "ROOM_FULL":
                    throw new AppError("ROOM_FULL", "Room has reached its player limit.");
                  case "GAME_ALREADY_STARTED":
                  case "ROOM_NOT_ACCEPTING_JOINS":
                  case "ROOM_EXPIRED_OR_CLOSED":
                    throw new AppError(
                      "GAME_NOT_ACTIVE",
                      "This room is no longer accepting players.",
                    );
                  default:
                    throw new AppError("UNKNOWN", "Could not join the room.");
                }
              }
              throw new AppError("UNKNOWN", "Could not join the room.");
            }

            if (
              joined.roomCode !== metadata.roomCode
              || joined.roomId !== metadata.roomId
              || joined.playerId !== prepared.playerId
            ) {
              this.tryFenceRoom(metadata.roomCode, metadata.roomId);
              throw new AppError(
                "UNKNOWN",
                "The room was updated but could not be synchronized safely.",
              );
            }

            try {
              this.coordinator.recordCommittedMutation(
                metadata.roomCode,
                metadata.version,
                joined,
              );
            } catch {
              this.tryFenceRoom(metadata.roomCode, metadata.roomId);
              throw new AppError(
                "UNKNOWN",
                "The room was updated but could not be synchronized safely.",
              );
            }

            try {
              return this.rooms.commitPreparedRoomJoin(prepared, socketId);
            } catch {
              this.tryFenceRoom(metadata.roomCode, metadata.roomId);
              throw new AppError(
                "UNKNOWN",
                "The room was updated but could not be synchronized safely.",
              );
            }
          },
        );
      } catch (error) {
        if (error instanceof AppError) {
          throw error;
        }
        throw new AppError(
          "UNKNOWN",
          "The room is unavailable. Refresh and try again.",
        );
      }
    });
  }

  async leaveRoom(
    roomCode: RoomCode,
    socketId: string,
  ): Promise<PlayerRemoval> {
    this.requireRegisteredRoom(roomCode);
    return this.runForSocket(socketId, async () =>
      this.coordinator.runExclusive(roomCode, async (metadata) => {
        let prepared: PreparedRoomLeave;
        try {
          prepared = this.rooms.prepareRoomLeave(roomCode, socketId);
        } catch (error) {
          if (error instanceof AppError) {
            throw error;
          }
          throw new AppError("UNKNOWN", "Could not leave the room.");
        }

        if (!this.repository.leaveRoom) {
          throw new AppError("FEATURE_UNAVAILABLE", "Durable room leaving is unavailable.");
        }

        let left: LeftRoomInfo;
        try {
          left = await this.repository.leaveRoom({
            roomCode,
            playerId: prepared.playerId,
            expectedRoomId: metadata.roomId,
            expectedVersion: metadata.version,
          });
        } catch (error) {
          if (error instanceof RoomLeaveError) {
            if (error.code === "STALE_VERSION") {
              this.tryFenceRoom(metadata.roomCode, metadata.roomId);
              throw new AppError("UNKNOWN", "The room changed. Refresh and try again.");
            }
            if (error.code === "ROOM_NOT_FOUND") {
              this.tryFenceRoom(metadata.roomCode, metadata.roomId);
              throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
            }
            if (error.code === "MEMBERSHIP_NOT_ACTIVE") {
              this.tryFenceRoom(metadata.roomCode, metadata.roomId);
              throw new AppError("NOT_AUTHORIZED", "This connection is not a room member.");
            }
            throw new AppError("UNKNOWN", "Could not leave the room.");
          }
          this.tryFenceRoom(metadata.roomCode, metadata.roomId);
          throw new AppError("UNKNOWN", "Could not leave the room.");
        }

        if (
          left.roomCode !== metadata.roomCode
          || left.roomId !== metadata.roomId
          || left.playerId !== prepared.playerId
        ) {
          this.tryFenceRoom(metadata.roomCode, metadata.roomId);
          throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
        }

        try {
          this.coordinator.recordCommittedMutation(
            metadata.roomCode,
            metadata.version,
            left,
          );
        } catch {
          this.tryFenceRoom(metadata.roomCode, metadata.roomId);
          throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
        }

        try {
          return this.rooms.commitPreparedRoomLeave(prepared, left);
        } catch {
          this.tryFenceRoom(metadata.roomCode, metadata.roomId);
          throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
        }
      }),
    );
  }

  async updateRoomSettings(
    payload: UpdateRoomSettingsPayload,
    socketId: string,
  ): Promise<Room> {
    return this.runForSocket(socketId, async () => {
      const initial = this.rooms.prepareRoomSettingsUpdate(payload, socketId);
      this.requireRegisteredRoom(initial.roomCode);
      return this.coordinator.runExclusive(initial.roomCode, async (metadata) => {
        const prepared = this.rooms.prepareRoomSettingsUpdate(payload, socketId);
        return this.persistWaitingRoomSettings(prepared, metadata);
      });
    });
  }

  async updateManhuntSettings(
    roomCode: RoomCode,
    socketId: string,
    settings: NonNullable<RoomSettings["manhunt"]>,
  ): Promise<Room> {
    return this.runForSocket(socketId, async () => {
      const initial = this.rooms.prepareManhuntSettingsUpdate(
        roomCode,
        socketId,
        settings,
      );
      this.requireRegisteredRoom(initial.roomCode);
      return this.coordinator.runExclusive(initial.roomCode, async (metadata) => {
        const prepared = this.rooms.prepareManhuntSettingsUpdate(
          roomCode,
          socketId,
          settings,
        );
        return this.persistWaitingRoomSettings(prepared, metadata);
      });
    });
  }

  async transitionRoomGameStatus(
    input: Omit<
      TransitionRoomGameStatusInput,
      "expectedRoomId" | "expectedVersion"
    > & { reservation?: RoomGameStatusReservation },
  ): Promise<TransitionedRoomGameStatusInfo> {
    return this.coordinator.runExclusive(input.roomCode, async (metadata) => {
      if (metadata.lifecycleStatus !== "active") {
        throw new RoomGameStatusTransitionError(
          "ROOM_NOT_ACTIVE",
          "Room is not active.",
        );
      }
      if (metadata.gameStatus !== input.expectedStatus) {
        throw new RoomGameStatusTransitionError(
          "STALE_STATUS",
          "Room game status changed before the transition could be applied.",
        );
      }
      if (metadata.currentGameId !== input.expectedCurrentGameId) {
        throw new RoomGameStatusTransitionError(
          "STALE_GAME_ID",
          "Current game ID changed before the transition could be applied.",
        );
      }
      this.rooms.assertGameStatusTransitionWritable(
        input.roomCode,
        input.reservation,
      );
      if (!this.repository.transitionRoomGameStatus) {
        throw new AppError(
          "FEATURE_UNAVAILABLE",
          "Durable game-status transitions are unavailable.",
        );
      }

      let transitioned: TransitionedRoomGameStatusInfo;
      try {
        const transitionFields = {
          roomCode: input.roomCode,
          expectedRoomId: metadata.roomId,
          expectedStatus: input.expectedStatus,
          nextStatus: input.nextStatus,
          expectedVersion: metadata.version,
          expectedCurrentGameId: input.expectedCurrentGameId,
          nextGameId: input.nextGameId,
        };
        const transitionInput: TransitionRoomGameStatusInput =
          input.initiatedBy.kind === "host"
            ? {
              ...transitionFields,
              initiatedBy: {
                kind: "host",
                playerId: input.initiatedBy.playerId,
              },
            }
            : {
              ...transitionFields,
              initiatedBy: { kind: "game-service" },
            };
        transitioned = await this.repository.transitionRoomGameStatus(
          transitionInput,
        );
      } catch (error) {
        if (
          error instanceof RoomGameStatusTransitionError
          && (
            error.code === "INVALID_TRANSITION"
            || error.code === "MEMBERSHIP_NOT_ACTIVE"
            || error.code === "NOT_HOST"
            || error.code === "HOST_NOT_CONNECTED"
          )
        ) {
          throw error;
        }
        this.coordinator.fenceRoom(metadata.roomCode, metadata.roomId);
        if (
          error instanceof RoomGameStatusTransitionError
          || error instanceof RoomRuntimeFencingError
        ) {
          throw error;
        }
        throw new AppError(
          "UNKNOWN",
          "The room transition could not be confirmed; reconciliation is required.",
        );
      }

      if (
        transitioned.roomCode !== metadata.roomCode
        || transitioned.roomId !== metadata.roomId
        || transitioned.lifecycleStatus !== "active"
        || transitioned.gameStatus !== input.nextStatus
        || transitioned.currentGameId !== input.nextGameId
      ) {
        this.coordinator.fenceRoom(metadata.roomCode, metadata.roomId);
        throw new AppError(
          "UNKNOWN",
          "The room transition committed but could not be synchronized safely.",
        );
      }

      try {
        this.coordinator.recordCommittedMutation(
          metadata.roomCode,
          metadata.version,
          transitioned,
        );
      } catch {
        this.coordinator.fenceRoom(metadata.roomCode, metadata.roomId);
        throw new AppError(
          "UNKNOWN",
          "The room transition committed but could not be synchronized safely.",
        );
      }

      return transitioned;
    });
  }

  async finishGame(
    roomCode: RoomCode,
    gameId: GameSessionId,
    expectedStatus: "starting" | "in_progress",
    reservation: RoomGameStatusReservation,
  ): Promise<TransitionedRoomGameStatusInfo> {
    return this.transitionTerminalStatus(
      {
        roomCode,
        expectedStatus,
        nextStatus: "finished",
        expectedCurrentGameId: gameId,
        nextGameId: gameId,
        initiatedBy: { kind: "game-service" },
        reservation,
      },
    );
  }

  async returnFinishedGameToLobby(
    roomCode: RoomCode,
    socketId: string,
    gameId: GameSessionId,
    reservation: RoomGameStatusReservation,
  ): Promise<TransitionedRoomGameStatusInfo> {
    this.rooms.assertHost(roomCode, socketId);
    const hostId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
    return this.transitionTerminalStatus({
      roomCode,
      expectedStatus: "finished",
      nextStatus: "waiting",
      expectedCurrentGameId: gameId,
      nextGameId: null,
      initiatedBy: { kind: "host", playerId: hostId },
      reservation,
    });
  }

  private async transitionTerminalStatus(
    input: {
      roomCode: RoomCode;
      expectedStatus: Room["gameStatus"];
      nextStatus: Room["gameStatus"];
      expectedCurrentGameId: GameSessionId | null;
      nextGameId: GameSessionId | null;
      initiatedBy:
        | { kind: "host"; playerId: PlayerId }
        | { kind: "game-service" };
      reservation: RoomGameStatusReservation;
    },
  ): Promise<TransitionedRoomGameStatusInfo> {
    const originalMetadata = this.requireRegisteredRoom(input.roomCode);
    const room = this.rooms.getPublicRoom(input.roomCode);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }

    if (
      !this.coordinator.isFenced(input.roomCode)
      && originalMetadata.gameStatus === input.nextStatus
      && originalMetadata.currentGameId === input.nextGameId
    ) {
      return this.toTransitionedRoomGameStatusInfo(originalMetadata);
    }

    try {
      return await this.transitionRoomGameStatus(input);
    } catch (error) {
      if (
        error instanceof RoomGameStatusTransitionError
        || error instanceof RoomRuntimeFencingError
      ) {
        throw error;
      }

      this.rooms.fenceRoom(input.roomCode);
      const reconciliation = await this.reconcileTerminalTransition(
        input,
        originalMetadata,
        room.hostId,
      );
      if (reconciliation.committed) {
        return reconciliation.result;
      }

      try {
        return await this.transitionRoomGameStatus(input);
      } catch (retryError) {
        if (
          retryError instanceof RoomGameStatusTransitionError
          || retryError instanceof RoomRuntimeFencingError
        ) {
          throw retryError;
        }
        this.rooms.fenceRoom(input.roomCode);
        const retryReconciliation = await this.reconcileTerminalTransition(
          input,
          originalMetadata,
          room.hostId,
        );
        if (retryReconciliation.committed) {
          return retryReconciliation.result;
        }
        throw retryError;
      }
    }
  }

  private async reconcileTerminalTransition(
    input: {
      roomCode: RoomCode;
      expectedStatus: Room["gameStatus"];
      nextStatus: Room["gameStatus"];
      expectedCurrentGameId: GameSessionId | null;
      nextGameId: GameSessionId | null;
      reservation: RoomGameStatusReservation;
    },
    originalMetadata: RoomPersistenceMetadata,
    hostId: PlayerId,
  ): Promise<{ committed: boolean; result: TransitionedRoomGameStatusInfo }> {
    const reader = this.repository.readDeferredRoomMutationState;
    if (!reader) {
      this.coordinator.fenceRoom(input.roomCode, originalMetadata.roomId);
      this.rooms.fenceRoom(input.roomCode);
      throw new AppError(
        "UNKNOWN",
        "The room transition is uncertain and cannot be reconciled.",
      );
    }

    try {
      return await this.coordinator.runExclusiveForReconciliation(
        input.roomCode,
        async (currentMetadata) => {
          if (currentMetadata.roomId !== originalMetadata.roomId) {
            throw new Error("Room identity changed during terminal reconciliation.");
          }
          const state = await reader.call(
            this.repository,
            input.roomCode,
            hostId,
          );
          const canonical = state.room;
          if (
            !canonical
            || canonical.roomId !== originalMetadata.roomId
            || canonical.roomCode !== input.roomCode
          ) {
            throw new Error("Canonical room state does not match the attempted transition.");
          }

          const committed =
            canonical.lifecycleStatus === "active"
            && canonical.version === incrementVersion(originalMetadata.version)
            && canonical.gameStatus === input.nextStatus
            && canonical.currentGameId === input.nextGameId;
          const notCommitted =
            canonical.lifecycleStatus === "active"
            && canonical.version === originalMetadata.version
            && canonical.gameStatus === input.expectedStatus
            && canonical.currentGameId === input.expectedCurrentGameId;
          if (!committed && !notCommitted) {
            throw new Error("Canonical terminal transition outcome is ambiguous.");
          }

          const synchronizedMetadata: RoomPersistenceMetadata = {
            roomCode: canonical.roomCode,
            roomId: canonical.roomId,
            lifecycleStatus: canonical.lifecycleStatus,
            gameStatus: canonical.gameStatus,
            currentGameId: canonical.currentGameId,
            version: canonical.version,
          };
          this.coordinator.synchronizeFencedMetadata(synchronizedMetadata);
          this.coordinator.clearFencedRoom(
            input.roomCode,
            canonical.roomId,
          );
          this.rooms.clearPersistenceFence(input.roomCode, input.reservation);
          return {
            committed,
            result: this.toTransitionedRoomGameStatusInfo(synchronizedMetadata),
          };
        },
      );
    } catch {
      this.coordinator.fenceRoom(input.roomCode, originalMetadata.roomId);
      this.rooms.fenceRoom(input.roomCode);
      throw new AppError(
        "UNKNOWN",
        "The room transition remains fenced pending reconciliation.",
      );
    }
  }

  private toTransitionedRoomGameStatusInfo(
    metadata: RoomPersistenceMetadata,
  ): TransitionedRoomGameStatusInfo {
    const room = this.rooms.getPublicRoom(metadata.roomCode);
    if (!room) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }
    return {
      roomId: metadata.roomId,
      roomCode: metadata.roomCode,
      gameMode: room.settings.gameMode,
      lifecycleStatus: metadata.lifecycleStatus,
      gameStatus: metadata.gameStatus,
      currentGameId: metadata.currentGameId,
      version: metadata.version,
    };
  }

  async acquireGameStatusReservation(
    roomCode: RoomCode,
    expectedStatus: Room["gameStatus"],
    expectedCurrentGameId: GameSessionId | null,
    hostSocketId?: string,
  ): Promise<RoomGameStatusReservation> {
    return this.coordinator.runExclusive(roomCode, async (metadata) => {
      if (metadata.lifecycleStatus !== "active") {
        throw new RoomGameStatusTransitionError(
          "ROOM_NOT_ACTIVE",
          "Room is not active.",
        );
      }
      if (metadata.gameStatus !== expectedStatus) {
        throw new RoomGameStatusTransitionError(
          "STALE_STATUS",
          "Room game status changed before the transition could be reserved.",
        );
      }
      if (metadata.currentGameId !== expectedCurrentGameId) {
        throw new RoomGameStatusTransitionError(
          "STALE_GAME_ID",
          "Current game ID changed before the transition could be reserved.",
        );
      }
      return this.rooms.reserveGameStatusTransition(
        roomCode,
        expectedStatus,
        expectedCurrentGameId,
        hostSocketId,
      );
    });
  }

  async disconnectSocket(
    socketId: string,
    reconnectGracePeriodMs: number,
  ): Promise<PlayerDisconnect | undefined> {
    if (
      !Number.isInteger(reconnectGracePeriodMs)
      || reconnectGracePeriodMs < 1
      || reconnectGracePeriodMs > 86_400_000
    ) {
      throw new AppError("INVALID_PAYLOAD", "Reconnect grace period is invalid.");
    }
    const roomCode = this.rooms.getRoomCodeForSocket(socketId);
    if (roomCode && this.rooms.isGameStatusReserved(roomCode)) {
      const expectedPlayerId = this.rooms.getPlayerIdForSocket(roomCode, socketId);
      const expectedRoomId = this.coordinator.getMetadata(roomCode)?.roomId;
      const reconnectDeadlineAt = new Date(Date.now() + reconnectGracePeriodMs);
      const attempt: DeferredMutationAttempt<PreparedRoomDisconnect> = {};
      return this.rooms.deferRoomMutation(
        roomCode,
        (reservation) => this.disconnectSocketCore(
          socketId,
          reconnectDeadlineAt,
          expectedPlayerId,
          expectedRoomId,
          reservation,
          attempt,
        ),
        (reservation, resolve) => this.reconcileDeferredDisconnect(
          roomCode,
          expectedPlayerId,
          reconnectDeadlineAt,
          attempt,
          reservation,
          resolve,
        ),
      );
    }
    return this.disconnectSocketCore(
      socketId,
      new Date(Date.now() + reconnectGracePeriodMs),
    );
  }

  private async disconnectSocketCore(
    socketId: string,
    reconnectDeadlineAt: Date,
    expectedPlayerId?: PlayerId,
    expectedRoomId?: string,
    reservation?: RoomGameStatusReservation,
    attempt?: DeferredMutationAttempt<PreparedRoomDisconnect>,
  ): Promise<PlayerDisconnect | undefined> {
    const pendingSocketOperation = this.inFlightSocketOperations.get(socketId);
    if (pendingSocketOperation) {
      await pendingSocketOperation;
    }
    const candidate = this.rooms.prepareSocketDisconnect(socketId, reservation);
    if (!candidate) {
      return undefined;
    }
    if (expectedPlayerId && candidate.playerId !== expectedPlayerId) {
      return undefined;
    }
    this.requireRegisteredRoom(candidate.roomCode);

    return this.coordinator.runExclusiveWithCapacityRetry(candidate.roomCode, async (metadata) => {
      if (expectedRoomId && metadata.roomId !== expectedRoomId) {
        return undefined;
      }
      const prepared = this.rooms.prepareSocketDisconnect(socketId, reservation);
      if (!prepared) {
        return undefined;
      }
      if (attempt) {
        attempt.metadata = metadata;
        attempt.prepared = prepared;
      }
      if (expectedPlayerId && prepared.playerId !== expectedPlayerId) {
        return undefined;
      }
      if (!this.repository.markDisconnected) {
        throw new AppError(
          "FEATURE_UNAVAILABLE",
          "Durable disconnect handling is unavailable.",
        );
      }

      let disconnected: MarkDisconnectedResult;
      try {
        disconnected = await this.repository.markDisconnected({
          roomCode: prepared.roomCode,
          playerId: prepared.playerId,
          reconnectDeadlineAt,
          expectedRoomId: metadata.roomId,
          expectedVersion: metadata.version,
        });
      } catch {
        this.tryFenceRoom(metadata.roomCode, metadata.roomId);
        throw new AppError(
          "UNKNOWN",
          "The room is unavailable pending reconciliation.",
        );
      }

      if (
        disconnected.roomCode !== metadata.roomCode
        || disconnected.roomId !== metadata.roomId
        || disconnected.playerId !== prepared.playerId
      ) {
        this.tryFenceRoom(metadata.roomCode, metadata.roomId);
        throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
      }

      try {
        this.coordinator.recordCommittedMutation(
          metadata.roomCode,
          metadata.version,
          disconnected,
        );
      } catch {
        this.tryFenceRoom(metadata.roomCode, metadata.roomId);
        throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
      }

      const persisted: PersistedDisconnect = {
        disconnectGeneration: disconnected.disconnectGeneration,
        reconnectDeadlineAt: disconnected.reconnectDeadlineAt,
      };
      try {
        return this.rooms.commitPreparedSocketDisconnect(
          prepared,
          persisted,
          reservation,
        );
      } catch {
        this.tryFenceRoom(metadata.roomCode, metadata.roomId);
        throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
      }
    });
  }

  async reconnect(
    payload: ReconnectPayload,
    socketId: string,
  ): Promise<ReconnectResult> {
    this.requireRegisteredRoom(payload.roomCode);
    return this.runForSocket(socketId, async () =>
      this.coordinator.runExclusive(payload.roomCode, async (metadata) => {
        let prepared: PreparedRoomReconnect;
        try {
          prepared = this.rooms.prepareRoomReconnect(payload, socketId);
        } catch (error) {
          if (error instanceof AppError) {
            throw error;
          }
          throw new AppError("NOT_AUTHORIZED", "Reconnect credentials are invalid or expired.");
        }
        if (!this.repository.reconnectPlayer) {
          throw new AppError("FEATURE_UNAVAILABLE", "Durable reconnect is unavailable.");
        }

        let reconnected: ReconnectedPlayerInfo;
        try {
          reconnected = await this.repository.reconnectPlayer({
            roomCode: prepared.roomCode,
            playerId: prepared.playerId,
            reconnectToken: prepared.reconnectToken,
            expectedRoomId: metadata.roomId,
            expectedVersion: metadata.version,
          });
        } catch (error) {
          if (error instanceof RoomConnectionError && error.code === "STALE_VERSION") {
            this.tryFenceRoom(metadata.roomCode, metadata.roomId);
            throw new AppError("UNKNOWN", "The room changed. Refresh and try again.");
          }
          if (error instanceof RoomConnectionError) {
            if (
              error.code === "ROOM_NOT_FOUND"
              || error.code === "ROOM_NOT_ACTIVE"
              || error.code === "MEMBERSHIP_NOT_FOUND"
              || error.code === "MEMBERSHIP_NOT_ACTIVE"
            ) {
              this.tryFenceRoom(metadata.roomCode, metadata.roomId);
            }
            throw new AppError("NOT_AUTHORIZED", "Reconnect credentials are invalid or expired.");
          }
          this.tryFenceRoom(metadata.roomCode, metadata.roomId);
          throw new AppError("UNKNOWN", "The room is unavailable pending reconciliation.");
        }

        if (
          reconnected.roomCode !== metadata.roomCode
          || reconnected.roomId !== metadata.roomId
          || reconnected.playerId !== prepared.playerId
        ) {
          this.tryFenceRoom(metadata.roomCode, metadata.roomId);
          throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
        }

        try {
          this.coordinator.recordCommittedMutation(
            metadata.roomCode,
            metadata.version,
            reconnected,
          );
        } catch {
          this.tryFenceRoom(metadata.roomCode, metadata.roomId);
          throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
        }

        try {
          return this.rooms.commitPreparedRoomReconnect(
            prepared,
            reconnected.disconnectGeneration,
          );
        } catch {
          this.tryFenceRoom(metadata.roomCode, metadata.roomId);
          throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
        }
      }),
    );
  }

  async removeDisconnectedPlayer(
    roomCode: RoomCode,
    playerId: PlayerId,
    disconnectGeneration: string,
    reconnectDeadlineAt: Date,
    now: Date,
  ): Promise<PlayerRemoval | DurableTimeoutRetry | undefined> {
    if (!this.coordinator.getMetadata(roomCode)) {
      if (this.rooms.getPublicRoom(roomCode)) {
        this.fenceRoom(roomCode);
        throw new AppError(
          "UNKNOWN",
          "The room is unavailable pending reconciliation.",
        );
      }
      return undefined;
    }

    const expectedRoomId = this.coordinator.getMetadata(roomCode)?.roomId;
    const attempt: DeferredMutationAttempt<PreparedDisconnectedPlayerRemoval> = {};
    return this.rooms.deferRoomMutation(
      roomCode,
      (reservation) => this.removeDisconnectedPlayerCore(
        roomCode,
        playerId,
        disconnectGeneration,
        reconnectDeadlineAt,
        new Date(),
        expectedRoomId,
        reservation,
        attempt,
      ),
      (reservation, resolve) => this.reconcileDeferredTimeout(
        roomCode,
        playerId,
        disconnectGeneration,
        reconnectDeadlineAt,
        attempt,
        reservation,
        resolve,
      ),
    );
  }

  private async removeDisconnectedPlayerCore(
    roomCode: RoomCode,
    playerId: PlayerId,
    disconnectGeneration: string,
    reconnectDeadlineAt: Date,
    now: Date,
    expectedRoomId?: string,
    reservation?: RoomGameStatusReservation,
    attempt?: DeferredMutationAttempt<PreparedDisconnectedPlayerRemoval>,
  ): Promise<PlayerRemoval | DurableTimeoutRetry | undefined> {
    return this.coordinator.runExclusiveWithCapacityRetry(roomCode, async (metadata) => {
      if (expectedRoomId && metadata.roomId !== expectedRoomId) {
        return undefined;
      }
      const prepared: PreparedDisconnectedPlayerRemoval | undefined =
        this.rooms.prepareDisconnectedPlayerRemoval(
          roomCode,
          playerId,
          disconnectGeneration,
          reconnectDeadlineAt,
          reservation,
        );
      if (!prepared) {
        return undefined;
      }
      if (attempt) {
        attempt.metadata = metadata;
        attempt.prepared = prepared;
      }
      if (!this.repository.removeDisconnectedPlayer) {
        throw new AppError(
          "FEATURE_UNAVAILABLE",
          "Durable timeout handling is unavailable.",
        );
      }

      let removal: RemoveDisconnectedPlayerResult;
      try {
        removal = await this.repository.removeDisconnectedPlayer({
          roomCode,
          playerId,
          expectedDisconnectGeneration: prepared.disconnectGeneration,
          expectedReconnectDeadlineAt: prepared.reconnectDeadlineAt,
          expectedRoomId: metadata.roomId,
          expectedVersion: metadata.version,
          now,
        });
      } catch {
        this.tryFenceRoom(metadata.roomCode, metadata.roomId);
        throw new AppError(
          "UNKNOWN",
          "The room is unavailable pending reconciliation.",
        );
      }

      if (removal.status === "not_due") {
        return {
          retryAt: new Date(
            Math.max(now.getTime() + 1_000, prepared.reconnectDeadlineAt.getTime() + 1_000),
          ),
        };
      }
      if (removal.status === "stale") {
        if (
          removal.reason === "room_id_mismatch"
          || removal.reason === "version_mismatch"
          || removal.reason === "room_not_found"
          || removal.reason === "room_not_active"
        ) {
          this.tryFenceRoom(metadata.roomCode, metadata.roomId);
          throw new AppError("UNKNOWN", "The room changed. Refresh and try again.");
        }
        return undefined;
      }
      if (
        removal.roomCode !== metadata.roomCode
        || removal.roomId !== metadata.roomId
        || removal.playerId !== prepared.playerId
      ) {
        this.tryFenceRoom(metadata.roomCode, metadata.roomId);
        throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
      }

      try {
        this.coordinator.recordCommittedMutation(
          metadata.roomCode,
          metadata.version,
          removal,
        );
      } catch {
        this.tryFenceRoom(metadata.roomCode, metadata.roomId);
        throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
      }

      const persisted: PersistedPlayerRemoval = {
        deleted: removal.deleted,
        hostChanged: removal.status === "room_deleted"
          ? prepared.snapshot.hostId === playerId
          : removal.hostChanged ?? prepared.snapshot.hostId === playerId,
        ...(removal.status === "removed" && removal.hostPlayerId
          ? { hostPlayerId: removal.hostPlayerId }
          : {}),
      };
      try {
        return this.rooms.commitPreparedDisconnectedPlayerRemoval(
          prepared,
          persisted,
          reservation,
        );
      } catch {
        this.tryFenceRoom(metadata.roomCode, metadata.roomId);
        throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
      }
    });
  }

  async reconcileDeferredRoomMutations(roomCode: RoomCode): Promise<boolean> {
    if (!this.repository.readDeferredRoomMutationState) {
      throw new AppError(
        "FEATURE_UNAVAILABLE",
        "Deferred room mutation reconciliation is unavailable.",
      );
    }
    return this.rooms.reconcileDeferredRoomMutations(roomCode);
  }

  private async reconcileDeferredDisconnect(
    roomCode: RoomCode,
    playerId: PlayerId | undefined,
    reconnectDeadlineAt: Date,
    attempt: DeferredMutationAttempt<PreparedRoomDisconnect>,
    reservation: RoomGameStatusReservation,
    resolve: (value: PlayerDisconnect | undefined) => void,
  ): Promise<"complete" | "retry"> {
    const originalMetadata = attempt.metadata;
    const prepared = attempt.prepared;
    if (!originalMetadata || !prepared || !playerId) {
      throw new Error("Deferred disconnect did not capture its canonical attempt.");
    }

    return this.coordinator.runExclusiveForReconciliation(roomCode, async (current) => {
      if (current.roomId !== originalMetadata.roomId) {
        throw new Error("Deferred disconnect room identity changed.");
      }
      const state = await this.repository.readDeferredRoomMutationState!(
        roomCode,
        playerId,
      );
      if (!state.room || state.room.roomId !== originalMetadata.roomId || !state.member) {
        throw new Error("Deferred disconnect outcome is not provable.");
      }
      const canonicalMetadata = this.toPersistenceMetadata(state);
      const originalPlayer = prepared.snapshot.players.find(
        (member) => member.playerId === playerId,
      );
      if (!originalPlayer) {
        throw new Error("Deferred disconnect player is absent from its prepared snapshot.");
      }

      const committed =
        state.room.version === incrementVersion(originalMetadata.version)
        && state.member.membershipStatus === "active"
        && state.member.connectionStatus === "disconnected"
        && state.member.disconnectGeneration === incrementVersion(
          originalPlayer.disconnectGeneration,
        )
        && state.member.reconnectDeadlineAt?.getTime() === reconnectDeadlineAt.getTime();
      if (committed) {
        this.coordinator.synchronizeFencedMetadata(canonicalMetadata);
        const result = this.rooms.commitReconciledSocketDisconnect(
          prepared,
          {
            disconnectGeneration: state.member.disconnectGeneration,
            reconnectDeadlineAt,
          },
          reservation,
        );
        this.coordinator.clearFencedRoom(roomCode, state.room.roomId);
        this.rooms.clearPersistenceFence(roomCode, reservation);
        resolve(result);
        return "complete";
      }

      const notCommitted =
        state.room.version === originalMetadata.version
        && state.member.membershipStatus === "active"
        && state.member.connectionStatus === "connected"
        && state.member.disconnectGeneration === originalPlayer.disconnectGeneration
        && state.member.reconnectDeadlineAt === null;
      if (!notCommitted) {
        throw new Error("Deferred disconnect has an ambiguous database outcome.");
      }
      this.rooms.assertReconciledRoomSnapshot(prepared.snapshot, reservation);
      this.coordinator.synchronizeFencedMetadata(canonicalMetadata);
      this.coordinator.clearFencedRoom(roomCode, state.room.roomId);
      this.rooms.clearPersistenceFence(roomCode, reservation);
      return "retry";
    });
  }

  private async reconcileDeferredTimeout(
    roomCode: RoomCode,
    playerId: PlayerId,
    disconnectGeneration: string,
    reconnectDeadlineAt: Date,
    attempt: DeferredMutationAttempt<PreparedDisconnectedPlayerRemoval>,
    reservation: RoomGameStatusReservation,
    resolve: (value: PlayerRemoval | DurableTimeoutRetry | undefined) => void,
  ): Promise<"complete" | "retry"> {
    const originalMetadata = attempt.metadata;
    const prepared = attempt.prepared;
    if (!originalMetadata || !prepared) {
      throw new Error("Deferred timeout did not capture its canonical attempt.");
    }

    return this.coordinator.runExclusiveForReconciliation(roomCode, async (current) => {
      if (current.roomId !== originalMetadata.roomId) {
        throw new Error("Deferred timeout room identity changed.");
      }
      const state = await this.repository.readDeferredRoomMutationState!(
        roomCode,
        playerId,
      );
      if (!state.room) {
        if (
          prepared.snapshot.players.length !== 1
          || prepared.snapshot.players[0]?.playerId !== playerId
          || prepared.disconnectGeneration !== disconnectGeneration
          || prepared.reconnectDeadlineAt.getTime() !== reconnectDeadlineAt.getTime()
        ) {
          throw new Error("Deleted-room timeout outcome is not provable.");
        }
        const result = this.rooms.commitReconciledDisconnectedPlayerRemoval(
          prepared,
          {
            deleted: true,
            hostChanged: prepared.snapshot.hostId === playerId,
          },
          reservation,
        );
        this.coordinator.removeFencedDeletedRoom(
          roomCode,
          originalMetadata.roomId,
          originalMetadata.version,
        );
        this.rooms.clearPersistenceFence(roomCode, reservation);
        resolve(result);
        return "complete";
      }
      if (state.room.roomId !== originalMetadata.roomId || !state.member) {
        throw new Error("Deferred timeout room or membership identity changed.");
      }

      const canonicalMetadata = this.toPersistenceMetadata(state);
      const committed =
        state.room.version === incrementVersion(originalMetadata.version)
        && state.member.membershipStatus === "removed"
        && state.member.connectionStatus === "disconnected"
        && state.member.disconnectGeneration === disconnectGeneration
        && state.member.reconnectDeadlineAt === null;
      if (committed) {
        const hostChanged = prepared.snapshot.hostId === playerId;
        if (
          hostChanged
          && (!state.room.hostPlayerId || state.room.hostPlayerId === playerId)
        ) {
          throw new Error("Committed timeout host transfer is ambiguous.");
        }
        this.coordinator.synchronizeFencedMetadata(canonicalMetadata);
        const result = this.rooms.commitReconciledDisconnectedPlayerRemoval(
          prepared,
          {
            deleted: false,
            hostChanged,
            ...(hostChanged && state.room.hostPlayerId
              ? { hostPlayerId: state.room.hostPlayerId }
              : {}),
          },
          reservation,
        );
        this.coordinator.clearFencedRoom(roomCode, state.room.roomId);
        this.rooms.clearPersistenceFence(roomCode, reservation);
        resolve(result);
        return "complete";
      }

      const notCommitted =
        state.room.version === originalMetadata.version
        && state.member.membershipStatus === "active"
        && state.member.connectionStatus === "disconnected"
        && state.member.disconnectGeneration === disconnectGeneration
        && state.member.reconnectDeadlineAt?.getTime() === reconnectDeadlineAt.getTime();
      if (!notCommitted) {
        throw new Error("Deferred timeout has an ambiguous database outcome.");
      }
      this.rooms.assertReconciledRoomSnapshot(prepared.snapshot, reservation);
      this.coordinator.synchronizeFencedMetadata(canonicalMetadata);
      this.coordinator.clearFencedRoom(roomCode, state.room.roomId);
      this.rooms.clearPersistenceFence(roomCode, reservation);
      return "retry";
    });
  }

  private toPersistenceMetadata(
    state: DeferredRoomMutationState,
  ): RoomPersistenceMetadata {
    if (!state.room) {
      throw new Error("Cannot synchronize metadata for a deleted room.");
    }
    return {
      roomCode: state.room.roomCode,
      roomId: state.room.roomId,
      version: state.room.version,
      gameStatus: state.room.gameStatus,
      currentGameId: state.room.currentGameId,
      lifecycleStatus: state.room.lifecycleStatus,
    };
  }

  fenceRoom(roomCode: RoomCode): void {
    const metadata = this.coordinator.getMetadata(roomCode);
    this.rooms.fenceRoom(roomCode);
    try {
      this.coordinator.fenceRoom(roomCode, metadata?.roomId);
    } catch {
      throw new AppError(
        "UNKNOWN",
        "The room is unavailable pending reconciliation.",
      );
    }
  }

  private requireRegisteredRoom(roomCode: RoomCode): RoomPersistenceMetadata {
    const metadata = this.coordinator.getMetadata(roomCode);
    if (metadata) {
      return metadata;
    }
    this.fenceRoom(roomCode);
    throw new AppError(
      "UNKNOWN",
      "The room is unavailable pending reconciliation.",
    );
  }

  private async runForSocket<T>(
    socketId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.inFlightSockets.has(socketId)) {
      throw new AppError(
        "UNKNOWN",
        "A room operation is already in progress for this connection.",
      );
    }
    this.inFlightSockets.add(socketId);
    let finishOperation!: () => void;
    const operationFinished = new Promise<void>((resolve) => {
      finishOperation = resolve;
    });
    this.inFlightSocketOperations.set(socketId, operationFinished);
    try {
      return await operation();
    } finally {
      this.inFlightSockets.delete(socketId);
      this.inFlightSocketOperations.delete(socketId);
      finishOperation();
    }
  }

  private async persistWaitingRoomSettings(
    prepared: PreparedWaitingRoomSettingsUpdate,
    metadata: RoomPersistenceMetadata,
  ): Promise<Room> {
    if (!this.repository.updateWaitingRoomSettings) {
      throw new AppError(
        "FEATURE_UNAVAILABLE",
        "Durable room settings updates are unavailable.",
      );
    }

    let updated: UpdatedWaitingRoomSettingsInfo;
    try {
      updated = await this.repository.updateWaitingRoomSettings({
        roomCode: prepared.roomCode,
        requestingPlayerId: prepared.playerId,
        settings: prepared.settings,
        expectedRoomId: metadata.roomId,
        expectedVersion: metadata.version,
      });
    } catch (error) {
      if (error instanceof RoomSettingsUpdateError) {
        if (
          error.code === "STALE_VERSION"
          || error.code === "ROOM_NOT_FOUND"
          || error.code === "ROOM_NOT_ACTIVE"
          || error.code === "MEMBERSHIP_NOT_ACTIVE"
          || error.code === "NOT_HOST"
          || error.code === "ROOM_MODE_MISMATCH"
          || error.code === "GAME_ALREADY_STARTED"
        ) {
          this.tryFenceRoom(metadata.roomCode, metadata.roomId);
        }
        if (error.code === "NOT_HOST" || error.code === "MEMBERSHIP_NOT_ACTIVE") {
          throw new AppError("NOT_AUTHORIZED", error.message);
        }
        if (error.code === "ROOM_FULL") {
          throw new AppError("ROOM_FULL", error.message);
        }
        if (error.code === "GAME_ALREADY_STARTED") {
          throw new AppError("GAME_NOT_ACTIVE", error.message);
        }
        if (error.code === "ROOM_MODE_MISMATCH") {
          throw new AppError("GAME_NOT_READY", error.message);
        }
        if (error.code === "ROOM_NOT_FOUND") {
          throw new AppError("ROOM_NOT_FOUND", error.message);
        }
      }
      this.tryFenceRoom(metadata.roomCode, metadata.roomId);
      throw new AppError(
        "UNKNOWN",
        "The room is unavailable pending reconciliation.",
      );
    }

    if (
      updated.roomCode !== metadata.roomCode
      || updated.roomId !== metadata.roomId
      || updated.gameMode !== prepared.settings.gameMode
      || updated.lifecycleStatus !== "active"
      || updated.currentGameId !== metadata.currentGameId
    ) {
      this.tryFenceRoom(metadata.roomCode, metadata.roomId);
      throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
    }

    try {
      this.coordinator.recordCommittedMutation(
        metadata.roomCode,
        metadata.version,
        updated,
      );
    } catch {
      this.tryFenceRoom(metadata.roomCode, metadata.roomId);
      throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
    }

    try {
      return this.rooms.commitPreparedWaitingRoomSettings(prepared);
    } catch {
      this.tryFenceRoom(metadata.roomCode, metadata.roomId);
      throw new AppError("UNKNOWN", "The room changed and requires reconciliation.");
    }
  }

  private tryFenceRoom(roomCode: RoomCode, roomId: string): void {
    this.rooms.fenceRoom(roomCode);
    try {
      this.coordinator.fenceRoom(roomCode, roomId);
    } catch {
      // The room remains unavailable because it is not committed to live memory.
    }
  }
}
