import { randomInt, randomUUID } from "node:crypto";
import {
  DEFAULT_DISCUSSION_DURATION_SECONDS,
  DEFAULT_IMPOSTOR_COUNT,
  DEFAULT_VOTING_DURATION_SECONDS,
  DEFAULT_WORD_IMPOSTOR_CATEGORY,
  MIN_WORD_IMPOSTOR_PLAYERS,
  ROLE_REVEAL_DURATION_SECONDS,
  wordImpostorSettingsSchema,
} from "@impostor/api";
import type {
  DiscussionPayload,
  GameEndedPayload,
  GameResult,
  GameSession,
  GameSessionId,
  GameStartedPayload,
  GameStateUpdatePayload,
  ImpostorGameState,
  PlayerId,
  Room,
  RoomCode,
  VoteResultsPayload,
  VoteTally,
  WordCategory,
  WordImpostorDiscussionPayload,
  WordImpostorRevealPayload,
  WordImpostorRoleAssignmentPayload,
  WordImpostorSettings,
  WordImpostorVoteResultsPayload,
} from "@impostor/api";
import type { GameRuntime, GameTimer } from "./classic-game-service.js";
import { WORD_CATALOG } from "../../data/word-categories.js";
import { RoomService } from "../../rooms/room-service.js";
import { AppError } from "../../utils/app-error.js";

type WordGameSession = Extract<GameSession, { state: ImpostorGameState }> & {
  gameMode: "impostor-word";
};
type WordRole = "impostor" | "civilian";

export interface WordImpostorGameEvents {
  gameStarted(roomCode: RoomCode, payload: GameStartedPayload): void;
  roomUpdated(room: Room): void;
  stateUpdated(roomCode: RoomCode, payload: GameStateUpdatePayload): void;
  discussionStarted(
    roomCode: RoomCode,
    payload: WordImpostorDiscussionPayload,
  ): void;
  voteResults(
    roomCode: RoomCode,
    payload: WordImpostorVoteResultsPayload,
  ): void;
  gameEnded(roomCode: RoomCode, payload: GameEndedPayload): void;
  rolesRevealed(roomCode: RoomCode, payload: WordImpostorRevealPayload): void;
}

export interface WordImpostorVoteHistoryEntry {
  roundNumber: number;
  isRevote: boolean;
  votes: Array<{ voterId: PlayerId; targetPlayerId: PlayerId }>;
  tallies: VoteTally[];
  tiedPlayerIds: PlayerId[];
  eliminatedPlayerId: PlayerId | null;
  resolvedAt: string;
}

export interface WordImpostorGameHistory {
  sessionId: GameSessionId;
  voting: WordImpostorVoteHistoryEntry[];
  result?: GameResult;
}

export interface WordImpostorResumeSnapshot {
  started: GameStartedPayload;
  state: GameStateUpdatePayload;
  role?: WordImpostorRoleAssignmentPayload;
  ended?: GameEndedPayload;
  reveal?: WordImpostorRevealPayload;
}

interface WordGameRecord {
  roomCode: RoomCode;
  session: WordGameSession;
  settings: WordImpostorSettings;
  category: WordCategory;
  secretWord: string;
  roles: Map<PlayerId, WordRole>;
  eliminatedPlayerIds: Set<PlayerId>;
  votes: Map<PlayerId, PlayerId>;
  votingHistory: WordImpostorVoteHistoryEntry[];
  voteCandidates?: Set<PlayerId>;
  voteAttempt: number;
  result?: GameResult;
  timer?: GameTimer;
}

const DEFAULT_WORD_SETTINGS: WordImpostorSettings = {
  category: DEFAULT_WORD_IMPOSTOR_CATEGORY,
  impostorCount: DEFAULT_IMPOSTOR_COUNT,
  discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
  votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
};

const defaultRuntime: GameRuntime = {
  now: () => new Date(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

export class WordImpostorService {
  private readonly currentGames = new Map<RoomCode, WordGameRecord>();
  private readonly gamesById = new Map<GameSessionId, WordGameRecord>();

  constructor(
    private readonly rooms: RoomService,
    private readonly events: WordImpostorGameEvents,
    private readonly runtime: GameRuntime = defaultRuntime,
  ) {}

  startGame(roomCode: RoomCode, socketId: string): WordGameSession {
    const roomBeforeStart = this.rooms.getPublicRoom(roomCode);
    if (!roomBeforeStart) {
      throw new AppError("ROOM_NOT_FOUND", "Room does not exist.");
    }

    this.rooms.assertHost(roomCode, socketId);
    if (roomBeforeStart.settings.gameMode !== "impostor-word") {
      throw new AppError(
        "GAME_NOT_READY",
        "This room is not configured for Word Impostor.",
      );
    }
    if (roomBeforeStart.players.length < MIN_WORD_IMPOSTOR_PLAYERS) {
      throw new AppError(
        "GAME_NOT_READY",
        `Word Impostor requires at least ${MIN_WORD_IMPOSTOR_PLAYERS} players.`,
      );
    }
    if (
      roomBeforeStart.players.some(
        (player) => player.connectionStatus !== "connected",
      )
    ) {
      throw new AppError(
        "GAME_NOT_READY",
        "All players must be connected before the game can start.",
      );
    }

    const settingsResult = wordImpostorSettingsSchema.safeParse(
      roomBeforeStart.settings.wordImpostor ?? DEFAULT_WORD_SETTINGS,
    );
    if (!settingsResult.success) {
      throw new AppError(
        "INVALID_PAYLOAD",
        "Word Impostor settings are invalid.",
      );
    }
    const maximumImpostors = Math.floor(
      (roomBeforeStart.players.length - 1) / 2,
    );
    if (settingsResult.data.impostorCount > maximumImpostors) {
      throw new AppError(
        "GAME_NOT_READY",
        `At most ${maximumImpostors} impostor(s) are valid for this room.`,
      );
    }
    const words = WORD_CATALOG[settingsResult.data.category];
    const secretWord = words[randomInt(words.length)];
    if (!secretWord) {
      throw new AppError(
        "GAME_NOT_READY",
        "No words are available for the selected category.",
      );
    }

    const previousGame = this.currentGames.get(roomCode);
    if (
      previousGame &&
      (previousGame.session.status === "starting" ||
        previousGame.session.status === "in_progress")
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "A game is already in progress.");
    }

    const now = this.runtime.now();
    const sessionId = randomUUID();
    const roleAssignments = assignWordRoles(
      roomBeforeStart.players.map((player) => player.id),
      settingsResult.data.impostorCount,
    );
    const session: WordGameSession = {
      id: sessionId,
      roomCode,
      status: "starting",
      startedAt: now.toISOString(),
      gameMode: "impostor-word",
      state: {
        phase: "role_reveal",
        roundNumber: 1,
        roleRevealEndsAt: this.addSeconds(
          now,
          ROLE_REVEAL_DURATION_SECONDS,
        ).toISOString(),
        votesSubmitted: 0,
        eligibleVoters: roomBeforeStart.players.length,
        eliminatedPlayerIds: [],
      },
    };
    const game: WordGameRecord = {
      roomCode,
      session,
      settings: settingsResult.data,
      category: settingsResult.data.category,
      secretWord,
      roles: roleAssignments,
      eliminatedPlayerIds: new Set(),
      votes: new Map(),
      votingHistory: [],
      voteAttempt: 0,
    };

    const room = this.rooms.beginGame(roomCode, socketId, sessionId);
    if (previousGame) {
      this.clearTimer(previousGame);
      this.gamesById.delete(previousGame.session.id);
    }
    this.currentGames.set(roomCode, game);
    this.gamesById.set(sessionId, game);

    this.events.roomUpdated(room);
    this.events.gameStarted(roomCode, {
      session: this.copySession(session),
    });
    this.schedule(game, ROLE_REVEAL_DURATION_SECONDS * 1_000, () =>
      this.beginDiscussion(game),
    );

    return this.copySession(session);
  }

  requestRole(
    roomCode: RoomCode,
    sessionId: GameSessionId,
    playerId: PlayerId,
  ): WordImpostorRoleAssignmentPayload {
    const game = this.gamesById.get(sessionId);
    const role =
      game?.roomCode === roomCode ? game.roles.get(playerId) : undefined;
    if (!game || !role) {
      throw new AppError(
        "NOT_AUTHORIZED",
        "The requested role is unavailable to this player.",
      );
    }

    return role === "impostor"
      ? { sessionId, role }
      : { sessionId, role, secretWord: game.secretWord };
  }

  submitVote(
    roomCode: RoomCode,
    voterId: PlayerId,
    targetPlayerId: PlayerId,
  ): void {
    const game = this.currentGames.get(roomCode);
    if (
      !game ||
      game.session.status !== "in_progress" ||
      game.session.state.phase !== "voting"
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "Voting is not currently active.");
    }
    if (
      !game.roles.has(voterId) ||
      game.eliminatedPlayerIds.has(voterId) ||
      !this.rooms.getSocketIdForPlayer(roomCode, voterId)
    ) {
      throw new AppError("NOT_AUTHORIZED", "This player is not eligible to vote.");
    }
    if (game.votes.has(voterId)) {
      throw new AppError(
        "DUPLICATE_VOTE",
        "A vote has already been submitted this round.",
      );
    }

    const eligibleTarget =
      game.roles.has(targetPlayerId) &&
      !game.eliminatedPlayerIds.has(targetPlayerId) &&
      targetPlayerId !== voterId &&
      (!game.voteCandidates || game.voteCandidates.has(targetPlayerId));
    if (!eligibleTarget) {
      throw new AppError(
        "INVALID_VOTE",
        "The selected player is not an eligible vote target.",
      );
    }

    game.votes.set(voterId, targetPlayerId);
    game.session.state.votesSubmitted = game.votes.size;
    this.emitState(game);

    if (game.votes.size >= this.getEligibleVoterIds(game).length) {
      this.resolveVote(game);
    }
  }

  getResumeSnapshot(
    roomCode: RoomCode,
    playerId: PlayerId,
  ): WordImpostorResumeSnapshot | undefined {
    const game = this.currentGames.get(roomCode);
    if (!game || !game.roles.has(playerId)) {
      return undefined;
    }

    const snapshot: WordImpostorResumeSnapshot = {
      started: { session: this.copySession(game.session) },
      state: this.toStateUpdate(game),
    };
    if (game.session.status !== "finished") {
      snapshot.role = this.requestRole(roomCode, game.session.id, playerId);
    } else {
      snapshot.ended = { result: this.copyResult(game.result) };
      snapshot.reveal = this.toFinalReveal(game);
    }
    return snapshot;
  }

  getHistory(sessionId: GameSessionId): WordImpostorGameHistory | undefined {
    const game = this.gamesById.get(sessionId);
    if (!game) {
      return undefined;
    }
    return {
      sessionId,
      voting: game.votingHistory.map((entry) => ({
        ...entry,
        votes: entry.votes.map((vote) => ({ ...vote })),
        tallies: entry.tallies.map((tally) => ({ ...tally })),
        tiedPlayerIds: [...entry.tiedPlayerIds],
      })),
      ...(game.result ? { result: this.copyResult(game.result) } : {}),
    };
  }

  onPlayerRemoved(roomCode: RoomCode, roomStillExists: boolean): void {
    const game = this.currentGames.get(roomCode);
    if (!roomStillExists) {
      this.onRoomDeleted(roomCode);
      return;
    }
    if (!game || game.session.status === "finished") {
      return;
    }
    this.finishGame(game, "cancelled", []);
  }

  onRoomDeleted(roomCode: RoomCode): void {
    const game = this.currentGames.get(roomCode);
    if (!game) {
      return;
    }
    this.clearTimer(game);
    this.currentGames.delete(roomCode);
    this.gamesById.delete(game.session.id);
  }

  close(): void {
    for (const game of this.currentGames.values()) {
      this.clearTimer(game);
    }
    this.currentGames.clear();
    this.gamesById.clear();
  }

  private beginDiscussion(game: WordGameRecord): void {
    if (!this.isCurrentActiveGame(game)) {
      return;
    }
    this.clearTimer(game);
    if (game.session.status === "starting") {
      const room = this.rooms.activateGame(game.roomCode, game.session.id);
      this.events.roomUpdated(room);
      game.session.status = "in_progress";
    }

    const now = this.runtime.now();
    const endsAt = this.addSeconds(now, game.settings.discussionDurationSeconds);
    game.session.state.phase = "discussion";
    game.session.state.discussionEndsAt = endsAt.toISOString();
    game.session.state.votesSubmitted = 0;
    game.session.state.eligibleVoters = this.getEligibleVoterIds(game).length;
    delete game.session.state.roleRevealEndsAt;
    delete game.session.state.votingEndsAt;
    delete game.session.state.revotePlayerIds;
    game.votes.clear();
    game.voteCandidates = undefined;
    game.voteAttempt = 0;

    const discussion: DiscussionPayload = {
      sessionId: game.session.id,
      startsAt: now.toISOString(),
      endsAt: endsAt.toISOString(),
    };
    this.events.discussionStarted(game.roomCode, discussion);
    this.emitState(game);
    this.schedule(game, game.settings.discussionDurationSeconds * 1_000, () =>
      this.beginVoting(game),
    );
  }

  private beginVoting(
    game: WordGameRecord,
    tiedPlayerIds?: PlayerId[],
  ): void {
    if (!this.isCurrentActiveGame(game)) {
      return;
    }
    this.clearTimer(game);

    const eligibleVoters = this.getEligibleVoterIds(game);
    if (eligibleVoters.length === 0) {
      this.finishGame(game, "cancelled", []);
      return;
    }

    const now = this.runtime.now();
    const endsAt = this.addSeconds(now, game.settings.votingDurationSeconds);
    game.session.state.phase = "voting";
    game.session.state.votesSubmitted = 0;
    game.session.state.eligibleVoters = eligibleVoters.length;
    game.session.state.votingEndsAt = endsAt.toISOString();
    delete game.session.state.discussionEndsAt;
    if (tiedPlayerIds) {
      game.voteCandidates = new Set(tiedPlayerIds);
      game.session.state.revotePlayerIds = [...tiedPlayerIds];
    } else {
      game.voteCandidates = undefined;
      delete game.session.state.revotePlayerIds;
    }
    game.votes.clear();

    this.emitState(game);
    this.schedule(game, game.settings.votingDurationSeconds * 1_000, () =>
      this.resolveVote(game),
    );
  }

  private resolveVote(game: WordGameRecord): void {
    if (
      !this.isCurrentActiveGame(game) ||
      game.session.state.phase !== "voting"
    ) {
      return;
    }
    this.clearTimer(game);

    const candidates = [...game.roles.keys()].filter(
      (playerId) =>
        !game.eliminatedPlayerIds.has(playerId) &&
        (!game.voteCandidates || game.voteCandidates.has(playerId)),
    );
    if (candidates.length === 0) {
      this.finishGame(game, "cancelled", []);
      return;
    }

    const tallies = candidates.map((targetPlayerId) => ({
      targetPlayerId,
      count: [...game.votes.values()].filter(
        (votedId) => votedId === targetPlayerId,
      ).length,
    }));
    const highestVoteCount = Math.max(...tallies.map((tally) => tally.count));
    const tiedPlayerIds = tallies
      .filter((tally) => tally.count === highestVoteCount)
      .map((tally) => tally.targetPlayerId);
    const isRevote = game.voteAttempt > 0;

    if (highestVoteCount === 0) {
      this.recordVoteResult(game, tallies, [], null, isRevote);
      game.session.state.roundNumber += 1;
      this.beginDiscussion(game);
      return;
    }

    if (tiedPlayerIds.length > 1) {
      this.recordVoteResult(game, tallies, tiedPlayerIds, null, isRevote);
      game.voteAttempt += 1;
      this.beginVoting(game, tiedPlayerIds);
      return;
    }

    const eliminatedPlayerId = tiedPlayerIds[0];
    if (!eliminatedPlayerId) {
      this.finishGame(game, "cancelled", []);
      return;
    }

    game.eliminatedPlayerIds.add(eliminatedPlayerId);
    game.session.state.eliminatedPlayerIds = [
      ...game.eliminatedPlayerIds,
    ];
    const room = this.rooms.eliminatePlayer(
      game.roomCode,
      game.session.id,
      eliminatedPlayerId,
    );
    const resolvedAt = this.runtime.now().toISOString();
    game.votingHistory.push({
      roundNumber: game.session.state.roundNumber,
      isRevote,
      votes: this.toVoteList(game),
      tallies: tallies.map((tally) => ({ ...tally })),
      tiedPlayerIds: [],
      eliminatedPlayerId,
      resolvedAt,
    });
    this.events.voteResults(game.roomCode, {
      sessionId: game.session.id,
      tallies,
      eliminatedPlayerId,
      roundNumber: game.session.state.roundNumber,
      isRevote,
    });
    this.events.roomUpdated(room);

    const winner = this.getWinner(game);
    if (winner) {
      this.finishGame(game, "win", winner);
      return;
    }

    game.session.state.roundNumber += 1;
    this.beginDiscussion(game);
  }

  private recordVoteResult(
    game: WordGameRecord,
    tallies: VoteTally[],
    tiedPlayerIds: PlayerId[],
    eliminatedPlayerId: PlayerId | null,
    isRevote: boolean,
  ): void {
    const resolvedAt = this.runtime.now().toISOString();
    const payload: WordImpostorVoteResultsPayload = {
      sessionId: game.session.id,
      tallies,
      eliminatedPlayerId,
      roundNumber: game.session.state.roundNumber,
      isRevote,
      tiedPlayerIds,
    };
    game.votingHistory.push({
      roundNumber: game.session.state.roundNumber,
      isRevote,
      votes: this.toVoteList(game),
      tallies: tallies.map((tally) => ({ ...tally })),
      tiedPlayerIds: [...tiedPlayerIds],
      eliminatedPlayerId,
      resolvedAt,
    });
    this.events.voteResults(game.roomCode, payload);
  }

  private getWinner(game: WordGameRecord): PlayerId[] | undefined {
    const remaining = [...game.roles.entries()].filter(
      ([playerId]) => !game.eliminatedPlayerIds.has(playerId),
    );
    const impostorIds = remaining
      .filter(([, role]) => role === "impostor")
      .map(([playerId]) => playerId);
    const civilianIds = remaining
      .filter(([, role]) => role === "civilian")
      .map(([playerId]) => playerId);

    if (impostorIds.length === 0) {
      return civilianIds;
    }
    if (impostorIds.length >= civilianIds.length) {
      return impostorIds;
    }
    return undefined;
  }

  private finishGame(
    game: WordGameRecord,
    outcome: GameResult["outcome"],
    winnerPlayerIds: PlayerId[],
  ): void {
    if (game.session.status === "finished") {
      return;
    }
    this.clearTimer(game);
    const endedAt = this.runtime.now().toISOString();
    game.session.status = "finished";
    game.session.endedAt = endedAt;
    game.session.state.phase = "reveal";
    delete game.session.state.roleRevealEndsAt;
    delete game.session.state.discussionEndsAt;
    delete game.session.state.votingEndsAt;
    delete game.session.state.revotePlayerIds;
    const room = this.rooms.finishGame(game.roomCode, game.session.id);
    if (room) {
      this.events.roomUpdated(room);
    }

    const result: GameResult = {
      gameId: game.session.id,
      roomCode: game.roomCode,
      gameMode: "impostor-word",
      outcome,
      winnerPlayerIds: [...winnerPlayerIds],
      endedAt,
    };
    game.result = result;
    this.emitState(game);
    this.events.gameEnded(game.roomCode, {
      result: this.copyResult(result),
    });
    this.events.rolesRevealed(game.roomCode, this.toFinalReveal(game));
  }

  private toFinalReveal(game: WordGameRecord): WordImpostorRevealPayload {
    return {
      sessionId: game.session.id,
      category: game.category,
      secretWord: game.secretWord,
      playerRoles: [...game.roles.entries()].map(([playerId, role]) => ({
        playerId,
        role,
      })),
    };
  }

  private emitState(game: WordGameRecord): void {
    this.events.stateUpdated(game.roomCode, this.toStateUpdate(game));
  }

  private toStateUpdate(game: WordGameRecord): GameStateUpdatePayload {
    return {
      sessionId: game.session.id,
      roomCode: game.roomCode,
      state: {
        ...game.session.state,
        eliminatedPlayerIds: [...game.session.state.eliminatedPlayerIds],
        ...(game.session.state.revotePlayerIds
          ? { revotePlayerIds: [...game.session.state.revotePlayerIds] }
          : {}),
      },
      updatedAt: this.runtime.now().toISOString(),
    };
  }

  private copySession(session: WordGameSession): WordGameSession {
    return {
      ...session,
      state: {
        ...session.state,
        eliminatedPlayerIds: [...session.state.eliminatedPlayerIds],
        ...(session.state.revotePlayerIds
          ? { revotePlayerIds: [...session.state.revotePlayerIds] }
          : {}),
      },
    };
  }

  private copyResult(result: GameResult | undefined): GameResult {
    if (!result) {
      throw new AppError("GAME_NOT_ACTIVE", "Game results are unavailable.");
    }
    return { ...result, winnerPlayerIds: [...result.winnerPlayerIds] };
  }

  private toVoteList(
    game: WordGameRecord,
  ): Array<{ voterId: PlayerId; targetPlayerId: PlayerId }> {
    return [...game.votes.entries()].map(([voterId, targetPlayerId]) => ({
      voterId,
      targetPlayerId,
    }));
  }

  private getEligibleVoterIds(game: WordGameRecord): PlayerId[] {
    const connectedPlayerIds = new Set(
      this.rooms
        .getPublicRoom(game.roomCode)
        ?.players.filter((player) => player.connectionStatus === "connected")
        .map((player) => player.id) ?? [],
    );
    return [...game.roles.keys()].filter(
      (playerId) =>
        connectedPlayerIds.has(playerId) &&
        !game.eliminatedPlayerIds.has(playerId),
    );
  }

  private isCurrentActiveGame(game: WordGameRecord): boolean {
    return (
      this.currentGames.get(game.roomCode) === game &&
      game.session.status !== "finished"
    );
  }

  private schedule(
    game: WordGameRecord,
    delayMs: number,
    callback: () => void,
  ): void {
    this.clearTimer(game);
    game.timer = this.runtime.schedule(() => {
      game.timer = undefined;
      callback();
    }, delayMs);
  }

  private clearTimer(game: WordGameRecord): void {
    game.timer?.cancel();
    game.timer = undefined;
  }

  private addSeconds(date: Date, seconds: number): Date {
    return new Date(date.getTime() + seconds * 1_000);
  }
}

function assignWordRoles(
  playerIds: PlayerId[],
  impostorCount: number,
): Map<PlayerId, WordRole> {
  const shuffled = [...playerIds];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex]!,
      shuffled[index]!,
    ];
  }

  const impostorIds = new Set(shuffled.slice(0, impostorCount));
  return new Map(
    playerIds.map((playerId) => [
      playerId,
      impostorIds.has(playerId) ? "impostor" : "civilian",
    ]),
  );
}
