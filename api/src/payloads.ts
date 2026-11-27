import {
  CLOCK_EVENTS,
  CONNECTION_EVENTS,
  ERROR_EVENTS,
  GAME_EVENTS,
  IMPOSTOR_EVENTS,
  MANHUNT_EVENTS,
  ROOM_EVENTS,
  WORD_IMPOSTOR_EVENTS,
} from "./events.js";
import type {
  Coordinates,
  GameResult,
  GameSession,
  GameSessionId,
  ISODateString,
  ManhuntBoundary,
  ManhuntPublicSettings,
  Player,
  PlayerId,
  PublicGameState,
  Room,
  RoomCode,
  RoomSettings,
  VoteTally,
  WordCategory,
} from "./types/index.js";

export interface CreateRoomPayload {
  nickname: string;
  settings?: RoomSettings;
}

export interface JoinRoomPayload {
  roomCode: RoomCode;
  nickname: string;
}

export interface LeaveRoomPayload {
  roomCode: RoomCode;
}

export interface UpdateRoomSettingsPayload {
  roomCode: RoomCode;
  settings: RoomSettings;
}

export interface ReturnToLobbyPayload {
  roomCode: RoomCode;
}

export interface RoleRequestPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
}

export interface StartGamePayload {
  roomCode: RoomCode;
}

export interface CreateRoomResponse {
  room: Room;
  playerId: PlayerId;
  reconnectToken: string;
}

export type JoinRoomResponse = CreateRoomResponse;

export interface RoomUpdatePayload {
  room: Room;
}

export interface PlayerJoinedPayload {
  roomCode: RoomCode;
  player: Player;
}

export interface PlayerLeftPayload {
  roomCode: RoomCode;
  playerId: PlayerId;
}

export interface ReconnectPayload {
  roomCode: RoomCode;
  playerId: PlayerId;
  reconnectToken: string;
}

export interface DisconnectPayload {
  reason: string;
}

export interface ClockSyncPayload {
  requestId: number;
}

export interface ClockSyncResponsePayload {
  requestId: number;
  serverTime: ISODateString;
}

export interface PlayerReconnectedPayload {
  roomCode: RoomCode;
  player: Player;
}

export interface GameStartedPayload {
  session: GameSession;
}

export interface GameStateUpdatePayload {
  sessionId: GameSessionId;
  roomCode: RoomCode;
  state: PublicGameState;
  updatedAt: ISODateString;
}

export interface GameEndedPayload {
  result: GameResult;
}

export type ImpostorRoleAssignmentPayload =
  | {
      sessionId: GameSessionId;
      role: "impostor";
      secretWord?: never;
    }
  | {
      sessionId: GameSessionId;
      role: "player";
      secretWord?: string;
    };

export interface DiscussionPayload {
  sessionId: GameSessionId;
  startsAt: ISODateString;
  endsAt: ISODateString;
}

export interface VoteSubmissionPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  votingEndsAt: ISODateString;
  votingPhaseId: number;
  targetPlayerId: PlayerId;
}

export interface VoteResultsPayload {
  sessionId: GameSessionId;
  tallies: VoteTally[];
  eliminatedPlayerId: PlayerId | null;
  roundNumber: number;
  isRevote: boolean;
  tiedPlayerIds?: PlayerId[];
}

export interface WordImpostorRoleRequestPayload extends RoleRequestPayload {}

export interface WordImpostorVoteSubmissionPayload
  extends VoteSubmissionPayload {}

export type WordImpostorRoleAssignmentPayload =
  | {
      sessionId: GameSessionId;
      role: "impostor";
      secretWord?: never;
    }
  | {
      sessionId: GameSessionId;
      role: "civilian";
      secretWord: string;
    };

export interface WordImpostorDiscussionPayload extends DiscussionPayload {}

export interface WordImpostorVoteResultsPayload extends VoteResultsPayload {}

export interface WordImpostorPlayerRole {
  playerId: PlayerId;
  role: "impostor" | "civilian";
}

export interface WordImpostorRevealPayload {
  sessionId: GameSessionId;
  category: WordCategory;
  secretWord: string;
  playerRoles: WordImpostorPlayerRole[];
}

export interface ImpostorRevealPayload {
  sessionId: GameSessionId;
  impostorPlayerIds: PlayerId[];
  secretWord?: string;
}

export interface LocationUpdatePayload {
  roomCode: RoomCode;
  coordinates: Coordinates;
  accuracyMeters?: number;
  clientTimestamp?: ISODateString;
}

export interface ManhuntUpdateSettingsPayload {
  roomCode: RoomCode;
  settings: import("./types/index.js").ManhuntSettings;
}

export interface ManhuntSettingsUpdatePayload {
  roomCode: RoomCode;
  settings: ManhuntPublicSettings;
}

export interface ManhuntBoundaryUpdatePayload {
  roomCode: RoomCode;
  boundary: ManhuntBoundary | null;
}

export interface ManhuntTeamAssignmentPayload {
  sessionId: GameSessionId;
  playerId: PlayerId;
  team: import("./types/index.js").ManhuntTeam;
}

export interface ManhuntReadyUpdatePayload {
  roomCode: RoomCode;
  readyPlayerIds?: PlayerId[];
  ready?: boolean;
}

export interface ManhuntLocationAcknowledgementPayload {
  sessionId: GameSessionId;
  recordedAt: ISODateString;
}

export interface RevealedLocation {
  playerId: PlayerId;
  coordinates: Coordinates;
  status: import("./types/index.js").PlayerStatus;
}

export interface LocationFlashPayload {
  sessionId: GameSessionId;
  locations: RevealedLocation[];
  visibleUntil: ISODateString;
}

export interface ManhuntMissionAssignmentPayload {
  sessionId: GameSessionId;
  playerId: PlayerId;
  center: Coordinates;
  radiusMeters: 5;
  revealedAt: ISODateString;
  deadlineAt: ISODateString;
  status: "active" | "completed" | "failed" | "cancelled";
}

export interface ManhuntMissionRevealPayload {
  sessionId: GameSessionId;
  outcome: "success" | "failure";
  locations: RevealedLocation[];
  visibleUntil: ISODateString;
}

export interface RevealLocationsPayload {
  roomCode: RoomCode;
  targetPlayerIds?: PlayerId[];
}

export interface FreezePlayerPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  requestId: string;
}

export interface ManhuntFreezeWarningPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  playerId: PlayerId;
  requestId: string;
  warningStartedAt: ISODateString;
  warningEndsAt: ISODateString;
}

export interface PlayerFrozenPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  playerId: PlayerId;
  requestId: string;
  frozenAt: ISODateString;
  frozenUntil: ISODateString;
}

export interface PlayerFreezeEndedPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  playerId: PlayerId;
  requestId: string;
  endedAt: ISODateString;
}

export interface FootstepsRequestPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  requestId: string;
}

export interface ManhuntFootstepsGuidancePayload {
  requestId: string;
  bearingDegrees: number;
  startedAt: ISODateString;
  expiresAt: ISODateString;
}

export interface ManhuntFootstepsStatePayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  playerId: PlayerId;
  remainingUses: number;
  serverNow: ISODateString;
  guidances: ManhuntFootstepsGuidancePayload[];
}

export interface SmokeBombRequestPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  requestId: string;
}

export interface ManhuntSmokeBombEffectPayload {
  requestId: string;
  startedAt: ISODateString;
  expiresAt: ISODateString;
}

export interface ManhuntSmokeBombStatePayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  playerId: PlayerId;
  remainingUses: number;
  serverNow: ISODateString;
  activeEffects: ManhuntSmokeBombEffectPayload[];
}

export interface GhostRequestPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  requestId: string;
}

export interface ManhuntGhostEffectPayload {
  requestId: string;
  startedAt: ISODateString;
  expiresAt: ISODateString;
}

export interface ManhuntGhostStatePayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  playerId: PlayerId;
  usageLimit: number | null;
  remainingUses: number | null;
  serverNow: ISODateString;
  activeEffects: ManhuntGhostEffectPayload[];
}

export interface FreezeDecoyRequestPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  requestId: string;
}

export interface ManhuntFreezeDecoyPayload {
  decoyId: string;
  coordinates: Coordinates;
  startedAt: ISODateString;
  expiresAt: ISODateString;
}

export interface ManhuntFreezeDecoyStatePayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  serverNow: ISODateString;
  decoys: ManhuntFreezeDecoyPayload[];
}

export interface ManhuntFreezeDecoyUsageStatePayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  playerId: PlayerId;
  remainingUses: number;
  serverNow: ISODateString;
}

export interface ManhuntLateGameCluePayload {
  clueId: string;
  coordinates: Coordinates;
  recordedAt: ISODateString;
  exposedAt: ISODateString;
  expiresAt: ISODateString;
}

export interface ManhuntLateGameClueStatePayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  serverNow: ISODateString;
  clue: ManhuntLateGameCluePayload | null;
}

export interface ManhuntLateGameWarningPayload {
  exposureId: string;
  startedAt: ISODateString;
  expiresAt: ISODateString;
}

export interface ManhuntLateGameWarningStatePayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  playerId: PlayerId;
  serverNow: ISODateString;
  warning: ManhuntLateGameWarningPayload | null;
}

export interface CatchAttemptPayload {
  roomCode: RoomCode;
  targetPlayerId: PlayerId;
}

export interface CatchConfirmationRequestPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  requestId: string;
  hunterNickname: string;
  expiresAt: ISODateString;
}

export interface CatchConfirmationResponsePayload {
  roomCode: RoomCode;
  requestId: string;
  accepted: boolean;
}

export type CatchRequestStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "expired"
  | "cancelled";

export interface CatchRequestStatusPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  requestId: string;
  status: CatchRequestStatus;
}

export interface CatchConfirmedPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  requestId: string;
  caughtNickname: string;
  caughtAt: ISODateString;
}

export type ManhuntProximityLevel = "near" | "very_near";

export interface ManhuntProximityAlertPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  level: ManhuntProximityLevel;
}

export interface PlayerCaughtPayload {
  roomCode: RoomCode;
  catcherPlayerId: PlayerId;
  caughtPlayerId: PlayerId;
  caughtAt: ISODateString;
}

export interface CountdownPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  remainingSeconds: number;
  endsAt: ISODateString;
  runnerHeadStartEndsAt: ISODateString;
  serverNow: ISODateString;
}

export interface CountdownSyncPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
}

export interface CountdownSyncResponsePayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  endsAt: ISODateString;
  runnerHeadStartEndsAt: ISODateString;
  serverNow: ISODateString;
}

export interface ManhuntCountdownCancelledPayload {
  roomCode: RoomCode;
  sessionId: GameSessionId;
  reason: "player_disconnected" | "player_left" | "room_unavailable";
}

export type ApiErrorCode =
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "NOT_AUTHORIZED"
  | "INVALID_CREDENTIAL"
  | "GAME_NOT_ACTIVE"
  | "GAME_NOT_READY"
  | "DUPLICATE_VOTE"
  | "INVALID_VOTE"
  | "INVALID_PAYLOAD"
  | "FEATURE_UNAVAILABLE"
  | "RATE_LIMITED"
  | "UNKNOWN";

export interface ServerErrorPayload {
  code: ApiErrorCode;
  message: string;
  requestId?: string;
}

export interface ValidationIssue {
  path: Array<string | number>;
  message: string;
}

export interface ValidationErrorPayload extends ServerErrorPayload {
  code: "INVALID_PAYLOAD";
  issues: ValidationIssue[];
}

export interface ClientToServerPayloads {
  [ROOM_EVENTS.CREATE]: CreateRoomPayload;
  [ROOM_EVENTS.JOIN]: JoinRoomPayload;
  [ROOM_EVENTS.LEAVE]: LeaveRoomPayload;
  [ROOM_EVENTS.UPDATE_SETTINGS]: UpdateRoomSettingsPayload;
  [ROOM_EVENTS.RETURN_TO_LOBBY]: ReturnToLobbyPayload;
  [CONNECTION_EVENTS.RECONNECT]: ReconnectPayload;
  [CLOCK_EVENTS.SYNC]: ClockSyncPayload;
  [GAME_EVENTS.START_GAME]: StartGamePayload;
  [IMPOSTOR_EVENTS.VOTE_SUBMISSION]: VoteSubmissionPayload;
  [IMPOSTOR_EVENTS.ROLE_REQUEST]: RoleRequestPayload;
  [WORD_IMPOSTOR_EVENTS.ROLE_REQUEST]: WordImpostorRoleRequestPayload;
  [WORD_IMPOSTOR_EVENTS.VOTE_SUBMISSION]: WordImpostorVoteSubmissionPayload;
  [MANHUNT_EVENTS.LOCATION_UPDATE]: LocationUpdatePayload;
  [MANHUNT_EVENTS.UPDATE_SETTINGS]: ManhuntUpdateSettingsPayload;
  [MANHUNT_EVENTS.READY_UPDATE]: ManhuntReadyUpdatePayload;
  [MANHUNT_EVENTS.REVEAL]: RevealLocationsPayload;
  [MANHUNT_EVENTS.FREEZE]: FreezePlayerPayload;
  [MANHUNT_EVENTS.FOOTSTEPS]: FootstepsRequestPayload;
  [MANHUNT_EVENTS.SMOKE_BOMB]: SmokeBombRequestPayload;
  [MANHUNT_EVENTS.GHOST]: GhostRequestPayload;
  [MANHUNT_EVENTS.FREEZE_DECOY]: FreezeDecoyRequestPayload;
  [MANHUNT_EVENTS.CATCH]: CatchAttemptPayload;
  [MANHUNT_EVENTS.CATCH_CONFIRMATION_RESPONSE]: CatchConfirmationResponsePayload;
  [MANHUNT_EVENTS.COUNTDOWN_SYNC]: CountdownSyncPayload;
}

export interface ServerToClientPayloads {
  [ROOM_EVENTS.UPDATE]: RoomUpdatePayload;
  [ROOM_EVENTS.PLAYER_JOINED]: PlayerJoinedPayload;
  [ROOM_EVENTS.PLAYER_LEFT]: PlayerLeftPayload;
  [CONNECTION_EVENTS.PLAYER_RECONNECTED]: PlayerReconnectedPayload;
  [GAME_EVENTS.GAME_STARTED]: GameStartedPayload;
  [GAME_EVENTS.STATE_UPDATE]: GameStateUpdatePayload;
  [GAME_EVENTS.GAME_ENDED]: GameEndedPayload;
  [IMPOSTOR_EVENTS.ROLE_ASSIGNMENT]: ImpostorRoleAssignmentPayload;
  [IMPOSTOR_EVENTS.DISCUSSION]: DiscussionPayload;
  [IMPOSTOR_EVENTS.VOTE_RESULTS]: VoteResultsPayload;
  [IMPOSTOR_EVENTS.REVEAL]: ImpostorRevealPayload;
  [WORD_IMPOSTOR_EVENTS.ROLE_ASSIGNMENT]: WordImpostorRoleAssignmentPayload;
  [WORD_IMPOSTOR_EVENTS.DISCUSSION]: WordImpostorDiscussionPayload;
  [WORD_IMPOSTOR_EVENTS.VOTE_RESULTS]: WordImpostorVoteResultsPayload;
  [WORD_IMPOSTOR_EVENTS.REVEAL]: WordImpostorRevealPayload;
  [MANHUNT_EVENTS.LOCATION_FLASH]: LocationFlashPayload;
  [MANHUNT_EVENTS.LATE_GAME_CLUE_STATE]: ManhuntLateGameClueStatePayload;
  [MANHUNT_EVENTS.LATE_GAME_WARNING_STATE]: ManhuntLateGameWarningStatePayload;
  [MANHUNT_EVENTS.FREEZE_WARNING]: ManhuntFreezeWarningPayload;
  [MANHUNT_EVENTS.PLAYER_FROZEN]: PlayerFrozenPayload;
  [MANHUNT_EVENTS.PLAYER_FREEZE_ENDED]: PlayerFreezeEndedPayload;
  [MANHUNT_EVENTS.FOOTSTEPS_STATE]: ManhuntFootstepsStatePayload;
  [MANHUNT_EVENTS.SMOKE_BOMB_STATE]: ManhuntSmokeBombStatePayload;
  [MANHUNT_EVENTS.GHOST_STATE]: ManhuntGhostStatePayload;
  [MANHUNT_EVENTS.FREEZE_DECOY_STATE]: ManhuntFreezeDecoyStatePayload;
  [MANHUNT_EVENTS.FREEZE_DECOY_USAGE_STATE]: ManhuntFreezeDecoyUsageStatePayload;
  [MANHUNT_EVENTS.CATCH_CONFIRMATION_REQUEST]: CatchConfirmationRequestPayload;
  [MANHUNT_EVENTS.CATCH_REQUEST_STATUS]: CatchRequestStatusPayload;
  [MANHUNT_EVENTS.CATCH_CONFIRMED]: CatchConfirmedPayload;
  [MANHUNT_EVENTS.PLAYER_CAUGHT]: PlayerCaughtPayload;
  [MANHUNT_EVENTS.PROXIMITY_ALERT]: ManhuntProximityAlertPayload;
  [MANHUNT_EVENTS.COUNTDOWN]: CountdownPayload;
  [MANHUNT_EVENTS.COUNTDOWN_CANCELLED]: ManhuntCountdownCancelledPayload;
  [MANHUNT_EVENTS.SETTINGS_UPDATE]: ManhuntSettingsUpdatePayload;
  [MANHUNT_EVENTS.BOUNDARY_UPDATE]: ManhuntBoundaryUpdatePayload;
  [MANHUNT_EVENTS.TEAM_ASSIGNMENT]: ManhuntTeamAssignmentPayload;
  [MANHUNT_EVENTS.READY_UPDATE]: ManhuntReadyUpdatePayload;
  [MANHUNT_EVENTS.MISSION_ASSIGNMENT]: ManhuntMissionAssignmentPayload;
  [MANHUNT_EVENTS.MISSION_REVEAL]: ManhuntMissionRevealPayload;
  [CONNECTION_EVENTS.DISCONNECT]: DisconnectPayload;
  [ERROR_EVENTS.SERVER_ERROR]: ServerErrorPayload;
  [ERROR_EVENTS.VALIDATION_ERROR]: ValidationErrorPayload;
}

export interface SocketEventPayloads
  extends ClientToServerPayloads,
    ServerToClientPayloads {}
