import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type {
  CreateRoomResponse,
  JoinRoomResponse,
  ReconnectPayload,
} from "@impostor/api";

const CLIENT_SESSION_ID_KEY = "impostor.clientSessionId";
const RECONNECT_SESSION_KEY = "impostor.reconnectSession";
const PLAYER_NICKNAME_KEY = "impostor.playerNickname";

let clientSessionIdPromise: Promise<string> | null = null;

export async function getOrCreateClientSessionId(): Promise<string> {
  if (!clientSessionIdPromise) {
    clientSessionIdPromise = loadOrCreateClientSessionId();
  }

  try {
    return await clientSessionIdPromise;
  } catch (error) {
    clientSessionIdPromise = null;
    throw error;
  }
}

export async function storeReconnectSession(
  response: CreateRoomResponse | JoinRoomResponse,
): Promise<void> {
  if (!response.reconnectToken.trim()) {
    throw new Error("The server did not return a valid reconnect token.");
  }

  const reconnectSession: ReconnectPayload = {
    roomCode: response.room.code,
    playerId: response.playerId,
    reconnectToken: response.reconnectToken,
  };

  await SecureStore.setItemAsync(
    RECONNECT_SESSION_KEY,
    JSON.stringify(reconnectSession),
  );
}

export async function getReconnectSession(): Promise<ReconnectPayload | null> {
  const storedValue = await SecureStore.getItemAsync(RECONNECT_SESSION_KEY);
  if (storedValue === null) {
    return null;
  }

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(storedValue);
  } catch {
    throw new Error("The stored reconnect session is not valid JSON.");
  }

  if (!isReconnectPayload(parsedValue)) {
    throw new Error("The stored reconnect session has an invalid shape.");
  }

  return parsedValue;
}

export async function clearReconnectSession(): Promise<void> {
  await SecureStore.deleteItemAsync(RECONNECT_SESSION_KEY);
}

export async function getSavedNickname(): Promise<string | null> {
  return SecureStore.getItemAsync(PLAYER_NICKNAME_KEY);
}

export async function saveNickname(nickname: string): Promise<void> {
  await SecureStore.setItemAsync(PLAYER_NICKNAME_KEY, nickname);
}

async function loadOrCreateClientSessionId(): Promise<string> {
  const savedId = await SecureStore.getItemAsync(CLIENT_SESSION_ID_KEY);
  if (savedId) {
    return savedId;
  }

  const clientSessionId = Crypto.randomUUID();
  await SecureStore.setItemAsync(CLIENT_SESSION_ID_KEY, clientSessionId);
  return clientSessionId;
}

function isReconnectPayload(value: unknown): value is ReconnectPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.roomCode === "string" &&
    typeof candidate.playerId === "string" &&
    typeof candidate.reconnectToken === "string" &&
    candidate.reconnectToken.length > 0
  );
}
