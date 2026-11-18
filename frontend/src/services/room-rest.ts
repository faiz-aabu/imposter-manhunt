import { roomCodeSchema, roomSettingsSchema } from "@impostor/api";
import type {
  ApiErrorCode,
  ConnectionStatus,
  GameStatus,
  GetRoomResponse,
  Player,
  PlayerStatus,
  RestErrorResponse,
  RoomCode,
} from "@impostor/api";
import { getApiBaseUrl } from "./socket-client";

const CONNECTION_STATUSES = [
  "connected",
  "disconnected",
  "reconnecting",
] satisfies ConnectionStatus[];

const PLAYER_STATUSES = [
  "waiting",
  "active",
  "eliminated",
  "frozen",
  "caught",
  "escaped",
] satisfies PlayerStatus[];

const GAME_STATUSES = [
  "waiting",
  "starting",
  "in_progress",
  "finished",
] satisfies GameStatus[];

const API_ERROR_CODES = [
  "ROOM_NOT_FOUND",
  "ROOM_FULL",
  "NOT_AUTHORIZED",
  "GAME_NOT_ACTIVE",
  "INVALID_PAYLOAD",
  "UNKNOWN",
] satisfies ApiErrorCode[];

export async function getPublicRoom(
  roomCode: RoomCode,
  signal?: AbortSignal,
): Promise<GetRoomResponse> {
  const baseUrl = getApiBaseUrl().replace(/\/+$/, "");
  const response = await fetch(
    `${baseUrl}/rooms/${encodeURIComponent(roomCode)}`,
    { signal },
  );
  const body = await readJsonBody(response);

  if (!response.ok) {
    const restError = parseRestError(body);
    throw new Error(
      restError?.error.message ??
        (response.status === 404
          ? "Room does not exist."
          : `Room lookup failed (${response.status}).`),
    );
  }

  if (!isPublicRoom(body)) {
    throw new Error("The server returned an invalid room response.");
  }

  return body;
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    if (response.ok) {
      throw new Error("The server returned invalid JSON.");
    }

    return null;
  }
}

function parseRestError(value: unknown): RestErrorResponse | null {
  if (!isRecord(value) || !isRecord(value.error)) {
    return null;
  }
  if (
    !isApiErrorCode(value.error.code) ||
    typeof value.error.message !== "string"
  ) {
    return null;
  }
  return {
    error: {
      code: value.error.code,
      message: value.error.message,
    },
  };
}

function isPublicRoom(value: unknown): value is GetRoomResponse {
  if (!isRecord(value)) {
    return false;
  }

  const roomCode = roomCodeSchema.safeParse(value.code);
  const settings = roomSettingsSchema.safeParse(value.settings);
  if (
    !roomCode.success ||
    !settings.success ||
    typeof value.hostId !== "string" ||
    typeof value.gameStatus !== "string" ||
    !GAME_STATUSES.includes(value.gameStatus as GameStatus) ||
    typeof value.createdAt !== "string" ||
    !Array.isArray(value.players) ||
    !value.players.every(isPlayer)
  ) {
    return false;
  }

  return (
    value.currentGameId === undefined ||
    typeof value.currentGameId === "string"
  );
}

function isPlayer(value: unknown): value is Player {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.nickname === "string" &&
    typeof value.connectionStatus === "string" &&
    CONNECTION_STATUSES.includes(value.connectionStatus as ConnectionStatus) &&
    typeof value.status === "string" &&
    PLAYER_STATUSES.includes(value.status as PlayerStatus) &&
    typeof value.joinedAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return (
    typeof value === "string" &&
    API_ERROR_CODES.some((code) => code === value)
  );
}
