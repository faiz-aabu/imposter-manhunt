import {
  GAME_MODES,
  MANHUNT_GAME_DURATION_OPTIONS_SECONDS,
  WORD_IMPOSTOR_CATEGORIES,
} from "../constants.js";

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
  settings: RoomSettings;
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
  votesSubmitted: number;
  eligibleVoters: number;
  eliminatedPlayerIds: PlayerId[];
  revotePlayerIds?: PlayerId[];
}

export type ManhuntPhase = "setup" | "countdown" | "active" | "finished";
export type ManhuntTeam = "hunter" | "runner";
export type ManhuntGameDurationSeconds =
  (typeof MANHUNT_GAME_DURATION_OPTIONS_SECONDS)[number];

export interface ManhuntBoundary {
  center: Coordinates;
  radiusMeters: number;
}

export interface ManhuntSettings {
  hunterCount: number;
  gameDurationSeconds?: ManhuntGameDurationSeconds;
  boundary: ManhuntBoundary;
}

export interface ManhuntTeamAssignment {
  playerId: PlayerId;
  team: ManhuntTeam;
}

export interface ManhuntGameState {
  phase: ManhuntPhase;
  settings: ManhuntSettings;
  teams: ManhuntTeamAssignment[];
  readyPlayerIds: PlayerId[];
  countdownEndsAt?: ISODateString;
  activeSince?: ISODateString;
  gameEndsAt?: ISODateString;
  nextLocationFlashAt?: ISODateString;
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
