import { GAME_MODES, WORD_IMPOSTOR_CATEGORIES } from "../constants.js";

export type PlayerId = string;
export type RoomCode = string;
export type GameSessionId = string;
export type ISODateString = string;

export type GameMode = (typeof GAME_MODES)[number];
export type ImpostorGameMode = Extract<
  GameMode,
  "impostor-classic" | "impostor-word"
>;

export type GameStatus = "waiting" | "starting" | "in_progress" | "finished";
export type ConnectionStatus = "connected" | "disconnected" | "reconnecting";
export type PlayerStatus =
  | "waiting"
  | "active"
  | "eliminated"
  | "frozen"
  | "caught"
  | "escaped";

export interface Player {
  id: PlayerId;
  nickname: string;
  connectionStatus: ConnectionStatus;
  status: PlayerStatus;
  joinedAt: ISODateString;
}

export interface RoomSettings {
  gameMode: GameMode;
  maxPlayers: number;
  isPrivate: boolean;
  classicImpostor?: ClassicImpostorSettings;
  wordImpostor?: WordImpostorSettings;
  manhunt?: ManhuntSettings;
}

export type PublicRoomSettings = Omit<RoomSettings, "manhunt"> & {
  manhunt?: ManhuntPublicSettings;
};

export interface ClassicImpostorSettings {
  impostorCount: number;
  discussionDurationSeconds: number;
  votingDurationSeconds: number;
}

export type WordCategory = (typeof WORD_IMPOSTOR_CATEGORIES)[number];

export interface WordImpostorSettings {
  category: WordCategory;
  impostorCount: number;
  discussionDurationSeconds: number;
  votingDurationSeconds: number;
}

export interface Room {
  code: RoomCode;
  hostId: PlayerId;
  players: Player[];
  settings: PublicRoomSettings;
  gameStatus: GameStatus;
  currentGameId?: GameSessionId;
  createdAt: ISODateString;
}

export type ImpostorPhase = "role_reveal" | "discussion" | "voting" | "reveal";

export interface ImpostorGameState {
  phase: ImpostorPhase;
  roundNumber: number;
  roleRevealEndsAt?: ISODateString;
  discussionEndsAt?: ISODateString;
  votingEndsAt?: ISODateString;
  votingPhaseId?: number;
  votesSubmitted: number;
  eligibleVoters: number;
  eliminatedPlayerIds: PlayerId[];
  revotePlayerIds?: PlayerId[];
}

export type ManhuntPhase = "setup" | "countdown" | "active" | "finished";
export type ManhuntTeam = "hunter" | "runner";

export interface ManhuntBoundary {
  center: Coordinates;
  radiusMeters: number;
}

export interface ManhuntSettings {
  hunterCount: number;
  boundary: ManhuntBoundary;
  gameDurationSeconds?: 1_800 | 2_700 | 3_600;
}

export type ManhuntPublicSettings = Omit<ManhuntSettings, "boundary">;

export interface ManhuntTeamAssignment {
  playerId: PlayerId;
  team: ManhuntTeam;
}

export interface ManhuntGameState {
  phase: ManhuntPhase;
  settings: ManhuntPublicSettings;
  readyPlayerIds: PlayerId[];
  countdownEndsAt?: ISODateString;
  runnerHeadStartEndsAt?: ISODateString;
  activeSince?: ISODateString;
  nextLocationFlashAt?: ISODateString;
  gameEndsAt?: ISODateString;
  nextShrinkAt?: ISODateString;
  shrinkWarningEndsAt?: ISODateString;
  shrinkStage?: number;
  zoneShrinkEndsAt?: ISODateString;
  zoneShrinkFromRadiusMeters?: number;
  zoneShrinkToRadiusMeters?: number;
}

export type PublicGameState = ImpostorGameState | ManhuntGameState;

interface BaseGameSession {
  id: GameSessionId;
  roomCode: RoomCode;
  status: GameStatus;
  startedAt: ISODateString;
  endedAt?: ISODateString;
}

export type GameSession =
  | (BaseGameSession & {
      gameMode: ImpostorGameMode;
      state: ImpostorGameState;
    })
  | (BaseGameSession & {
      gameMode: "manhunt";
      state: ManhuntGameState;
    });

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface LocationUpdate {
  playerId: PlayerId;
  coordinates: Coordinates;
  accuracyMeters?: number;
  recordedAt: ISODateString;
}

export interface Vote {
  voterId: PlayerId;
  targetPlayerId: PlayerId;
  submittedAt: ISODateString;
}

export interface VoteTally {
  targetPlayerId: PlayerId;
  count: number;
}

export interface GameResult {
  gameId: GameSessionId;
  roomCode: RoomCode;
  gameMode: GameMode;
  outcome: "win" | "draw" | "cancelled";
  winnerPlayerIds: PlayerId[];
  endedAt: ISODateString;
}
