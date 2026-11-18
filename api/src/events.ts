export const ROOM_EVENTS = {
  CREATE: "room:create",
  JOIN: "room:join",
  LEAVE: "room:leave",
  UPDATE_SETTINGS: "room:update_settings",
  UPDATE: "room:update",
  PLAYER_JOINED: "room:player_joined",
  PLAYER_LEFT: "room:player_left",
} as const;

export const CONNECTION_EVENTS = {
  RECONNECT: "connection:reconnect",
  DISCONNECT: "disconnect",
  PLAYER_RECONNECTED: "connection:player_reconnected",
} as const;

export const GAME_EVENTS = {
  START_GAME: "game:start",
  GAME_STARTED: "game:started",
  STATE_UPDATE: "game:state_update",
  GAME_ENDED: "game:ended",
} as const;

export const IMPOSTOR_EVENTS = {
  ROLE_ASSIGNMENT: "impostor:role_assignment",
  DISCUSSION: "impostor:discussion",
  VOTE_SUBMISSION: "impostor:vote_submission",
  ROLE_REQUEST: "impostor:role_request",
  VOTE_RESULTS: "impostor:vote_results",
  REVEAL: "impostor:reveal",
} as const;

export const WORD_IMPOSTOR_EVENTS = {
  ROLE_REQUEST: "word_impostor:role_request",
  ROLE_ASSIGNMENT: "word_impostor:role_assignment",
  DISCUSSION: "word_impostor:discussion",
  VOTE_SUBMISSION: "word_impostor:vote_submission",
  VOTE_RESULTS: "word_impostor:vote_results",
  REVEAL: "word_impostor:reveal",
} as const;

export const MANHUNT_EVENTS = {
  UPDATE_SETTINGS: "manhunt:update_settings",
  SETTINGS_UPDATE: "manhunt:settings_update",
  TEAM_ASSIGNMENT: "manhunt:team_assignment",
  READY_UPDATE: "manhunt:ready_update",
  COUNTDOWN: "manhunt:countdown",
  COUNTDOWN_SYNC: "manhunt:countdown_sync",
  COUNTDOWN_CANCELLED: "manhunt:countdown_cancelled",
  LOCATION_UPDATE: "manhunt:location_update",
  LOCATION_FLASH: "manhunt:location_flash",
  REVEAL: "manhunt:reveal",
  FREEZE: "manhunt:freeze",
  PLAYER_FROZEN: "manhunt:player_frozen",
  CATCH: "manhunt:catch",
  CATCH_CONFIRMATION_REQUEST: "manhunt:catch_confirmation_request",
  CATCH_CONFIRMATION_RESPONSE: "manhunt:catch_confirmation_response",
  CATCH_REQUEST_STATUS: "manhunt:catch_request_status",
  CATCH_CONFIRMED: "manhunt:catch_confirmed",
  PLAYER_CAUGHT: "manhunt:player_caught",
  PROXIMITY_ALERT: "manhunt:proximity_alert",
} as const;

export const ERROR_EVENTS = {
  SERVER_ERROR: "error:server",
  VALIDATION_ERROR: "error:validation",
} as const;

export const SOCKET_EVENTS = {
  ROOM: ROOM_EVENTS,
  CONNECTION: CONNECTION_EVENTS,
  GAME: GAME_EVENTS,
  IMPOSTOR: IMPOSTOR_EVENTS,
  WORD_IMPOSTOR: WORD_IMPOSTOR_EVENTS,
  MANHUNT: MANHUNT_EVENTS,
  ERROR: ERROR_EVENTS,
} as const;

type EventValues<T> = T[keyof T];

export type SocketEventName =
  | EventValues<typeof ROOM_EVENTS>
  | EventValues<typeof CONNECTION_EVENTS>
  | EventValues<typeof GAME_EVENTS>
  | EventValues<typeof IMPOSTOR_EVENTS>
  | EventValues<typeof WORD_IMPOSTOR_EVENTS>
  | EventValues<typeof MANHUNT_EVENTS>
  | EventValues<typeof ERROR_EVENTS>;
