import type {
  PlayerId,
  ReturnToLobbyPayload,
  Room,
  RoomUpdatePayload,
} from "@impostor/api";
import type { SocketAcknowledgement } from "./socket-types";

interface ReturnToLobbyOptions {
  roomCode: string;
  isHost: boolean;
  request: (
    payload: ReturnToLobbyPayload,
  ) => Promise<SocketAcknowledgement<RoomUpdatePayload>>;
  onReturned: (room: Room) => void;
  onError: (message: string) => void;
}

export async function returnFinishedImpostorGameToLobby({
  roomCode,
  isHost,
  request,
  onReturned,
  onError,
}: ReturnToLobbyOptions): Promise<boolean> {
  if (!isHost) {
    onError("Only the host can return this room to the lobby.");
    return false;
  }

  try {
    const response = await request({ roomCode });
    if (!response.ok) {
      onError(response.error.message);
      return false;
    }

    const room = response.data.room;
    if (room.code !== roomCode || room.gameStatus !== "waiting") {
      onError("The server did not confirm the lobby reset.");
      return false;
    }

    onReturned(room);
    return true;
  } catch (error) {
    onError(
      error instanceof Error
        ? error.message
        : "Could not return the room to the lobby.",
    );
    return false;
  }
}

export function isNonHostImpostorRematchUpdate(
  previousRoom: Room | null,
  updatedRoom: Room,
  playerId: PlayerId | null,
  hasMatchingGameSession: boolean,
): boolean {
  return Boolean(
    previousRoom &&
      hasMatchingGameSession &&
      previousRoom.code === updatedRoom.code &&
      previousRoom.gameStatus === "finished" &&
      updatedRoom.gameStatus === "waiting" &&
      (previousRoom.settings.gameMode === "impostor-classic" ||
        previousRoom.settings.gameMode === "impostor-word") &&
      previousRoom.hostId !== playerId,
  );
}
