import { localizeImpostorError } from "./impostor-errors";
import { localizeManhuntError } from "./manhunt-errors";
import type { TranslationKey } from "./locales";
import type { TranslationValues } from "./translate";

type Translate = (key: TranslationKey, values?: TranslationValues) => string;

const localizedErrors: Record<string, TranslationKey> = {
  "The server disconnected this client.": "shared.error.serverDisconnected",
  "Could not configure the server connection.":
    "shared.error.connectionConfiguration",
  "EXPO_PUBLIC_API_URL is not set. Configure it in frontend/.env.local.":
    "shared.error.apiUrlMissing",
  "EXPO_PUBLIC_API_URL must be a valid HTTP or HTTPS URL.":
    "shared.error.apiUrlInvalid",
  "EXPO_PUBLIC_API_URL must use HTTP or HTTPS.":
    "shared.error.apiUrlProtocol",
  "EXPO_PUBLIC_API_URL must use HTTPS for public hosts. HTTP is allowed only for localhost or private-network development.":
    "shared.error.apiUrlHttps",
  "The server returned an invalid room response.":
    "shared.error.invalidRoomResponse",
  "The server returned invalid JSON.": "shared.error.invalidJson",
  "The server did not return a valid reconnect token.":
    "shared.error.reconnectToken",
  "The stored reconnect session is not valid JSON.":
    "shared.error.reconnectJson",
  "The stored reconnect session has an invalid shape.":
    "shared.error.reconnectShape",
  "Room creation payload is invalid.": "shared.error.roomCreationInvalid",
  "Room settings are invalid.": "shared.error.roomSettingsInvalid",
  "Room joining payload is invalid.": "shared.error.roomJoinInvalid",
  "Room settings payload is invalid.":
    "shared.error.roomSettingsPayloadInvalid",
  "This room is no longer accepting players.":
    "shared.error.roomNoLongerAccepting",
  "Room has reached its player limit.": "shared.error.roomLimitReached",
  "Room settings cannot be changed after a game has started.":
    "shared.error.roomSettingsLocked",
  "The player limit cannot be lower than the current room size.":
    "shared.error.playerLimitBelowCurrent",
  "The room is configured for a different game mode.":
    "shared.error.differentGameMode",
  "Return the finished game to the lobby before starting another.":
    "shared.error.returnFinishedGameFirst",
  "The game can no longer start.": "shared.error.gameCanNoLongerStart",
  "Reconnect credentials are invalid or expired.":
    "shared.error.reconnectCredentialsInvalid",
  "This connection is already a member of another room.":
    "shared.error.connectionAlreadyMember",
  "This connection has already joined a room.":
    "shared.error.connectionAlreadyJoined",
  "This connection is not a member of the requested room.":
    "shared.error.connectionNotMember",
  "Only the room host can perform this action.": "shared.error.hostOnly",
  "Player is not in this room.": "shared.error.playerNotInRoom",
  "Unable to allocate a unique room code. Please try again.":
    "shared.error.roomCodeUnavailable",
};

export function localizeSharedError(
  message: string | null,
  t: Translate,
): string | null {
  if (!message) {
    return null;
  }

  const key = localizedErrors[message];
  if (key) {
    return t(key);
  }

  const roomLookup = message.match(/^Room lookup failed \((\d+)\)\.$/);
  if (roomLookup) {
    return t("shared.error.roomLookupStatus", {
      status: Number(roomLookup[1]),
    });
  }

  const impostorError = localizeImpostorError(message, t);
  if (impostorError !== message) {
    return impostorError;
  }

  const manhuntError = localizeManhuntError(message, t);
  return manhuntError ?? message;
}
