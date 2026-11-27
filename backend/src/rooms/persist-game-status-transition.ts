import type { GameSessionId, RoomCode } from "@impostor/api";
import { AppError } from "../utils/app-error.js";
import type { RoomGameStatusReservation, RoomService } from "./room-service.js";
import type { RoomPersistenceCommands } from "./room-persistence-commands.js";

export function fenceDurableGameRoom(
  rooms: RoomService,
  commands: RoomPersistenceCommands,
  roomCode: RoomCode,
): void {
  rooms.fenceRoom(roomCode);
  try {
    commands.fenceRoom(roomCode);
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "durable_game_room_fence_failed",
        roomCode,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
  }
}

export async function persistGameStatusTransition<T>(
  rooms: RoomService,
  commands: RoomPersistenceCommands,
  roomCode: RoomCode,
  gameId: GameSessionId,
  commit: (reservation: RoomGameStatusReservation) => T,
): Promise<T> {
  const reservation = await commands.acquireGameStatusReservation(
    roomCode,
    "starting",
    gameId,
  );
  try {
    try {
      await commands.transitionRoomGameStatus({
        roomCode,
        expectedStatus: "starting",
        nextStatus: "in_progress",
        expectedCurrentGameId: gameId,
        nextGameId: gameId,
        initiatedBy: { kind: "game-service" },
        reservation,
      });
    } catch (error) {
      fenceDurableGameRoom(rooms, commands, roomCode);
      throw error;
    }

    try {
      return commit(reservation);
    } catch (error) {
      fenceDurableGameRoom(rooms, commands, roomCode);
      console.error(
        JSON.stringify({
          level: "error",
          event: "durable_game_activation_commit_failed",
          roomCode,
          gameId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      throw new AppError(
        "UNKNOWN",
        "The durable game transition committed but live state could not be synchronized safely.",
      );
    }
  } finally {
    rooms.releaseGameStatusReservation(reservation);
  }
}

export async function persistGameCompletion<T>(
  rooms: RoomService,
  commands: RoomPersistenceCommands,
  roomCode: RoomCode,
  gameId: GameSessionId,
  expectedStatus: "starting" | "in_progress",
  commit: (reservation: RoomGameStatusReservation) => T,
): Promise<T> {
  const reservation = await commands.acquireGameStatusReservation(
    roomCode,
    expectedStatus,
    gameId,
  );
  try {
    try {
      await commands.finishGame(
        roomCode,
        gameId,
        expectedStatus,
        reservation,
      );
    } catch (error) {
      fenceDurableGameRoom(rooms, commands, roomCode);
      throw error;
    }

    try {
      return commit(reservation);
    } catch (error) {
      fenceDurableGameRoom(rooms, commands, roomCode);
      console.error(
        JSON.stringify({
          level: "error",
          event: "durable_game_completion_commit_failed",
          roomCode,
          gameId,
          error: error instanceof Error ? error.name : "unknown",
        }),
      );
      throw new AppError(
        "UNKNOWN",
        "The durable game completion committed but live state could not be synchronized safely.",
      );
    }
  } finally {
    rooms.releaseGameStatusReservation(reservation);
  }
}

export async function persistFinishedGameReturnToLobby<T>(
  rooms: RoomService,
  commands: RoomPersistenceCommands,
  roomCode: RoomCode,
  socketId: string,
  gameId: GameSessionId,
  commit: (reservation: RoomGameStatusReservation) => T,
): Promise<T> {
  const reservation = await commands.acquireGameStatusReservation(
    roomCode,
    "finished",
    gameId,
    socketId,
  );
  try {
    try {
      await commands.returnFinishedGameToLobby(
        roomCode,
        socketId,
        gameId,
        reservation,
      );
    } catch (error) {
      fenceDurableGameRoom(rooms, commands, roomCode);
      throw error;
    }

    try {
      return commit(reservation);
    } catch (error) {
      fenceDurableGameRoom(rooms, commands, roomCode);
      console.error(
        JSON.stringify({
          level: "error",
          event: "durable_game_lobby_commit_failed",
          roomCode,
          gameId,
          error: error instanceof AppError
            ? `${error.code}: ${error.message}`
            : error instanceof Error
              ? error.name
              : "unknown",
        }),
      );
      throw new AppError(
        "UNKNOWN",
        "The durable lobby transition committed but live state could not be synchronized safely.",
      );
    }
  } finally {
    rooms.releaseGameStatusReservation(reservation);
  }
}
