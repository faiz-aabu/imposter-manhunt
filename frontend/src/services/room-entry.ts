import type {
  CreateRoomResponse,
  JoinRoomResponse,
} from "@impostor/api";
import { saveNickname, storeReconnectSession } from "./player-session";

export async function persistRoomEntry(
  response: CreateRoomResponse | JoinRoomResponse,
  nickname: string,
): Promise<string | null> {
  const results = await Promise.allSettled([
    saveNickname(nickname),
    storeReconnectSession(response),
  ]);
  if (results.every((result) => result.status === "fulfilled")) {
    return null;
  }

  return "The room is ready, but some session details could not be saved securely on this device.";
}
