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
import type { RoomGameStatusReservation } from "../../rooms/room-service.js";
import type { RoomPersistenceCommands } from "../../rooms/room-persistence-commands.js";
import {
  persistFinishedGameReturnToLobby,
  persistGameCompletion,
  persistGameStatusTransition,
} from "../../rooms/persist-game-status-transition.js";
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

export interface PreparedWordGameStart {
  readonly roomCode: RoomCode;
  readonly gameId: GameSessionId;
}

interface WordGameStartPlan {
  readonly socketId: string;
  readonly game: WordGameRecord;
  readonly roleRevealEndsAt: Date;
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
  votingPhaseId: number;
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
  private readonly pendingFinishes = new Map<GameSessionId, Promise<void>>();
  private readonly pendingLobbyReturns = new Map<RoomCode, Promise<Room>>();
  private readonly preparedStarts = new WeakMap<
    PreparedWordGameStart,
    WordGameStartPlan
  >();

  constructor(
    private readonly rooms: RoomService,
    private readonly events: WordImpostorGameEvents,
    private readonly runtime: GameRuntime = defaultRuntime,
    private readonly persistenceCommands?: RoomPersistenceCommands,
  ) {
    this.rooms.onGameplaySuspended((suspension) => {
      const game = this.currentGames.get(suspension.roomCode);
      if (game && game.session.id === suspension.gameId) {
        this.clearTimer(game);
      }
    });
  }

  startGame(roomCode: RoomCode, socketId: string): WordGameSession {
    return this.commitPreparedStart(this.prepareStart(roomCode, socketId));
  }

  prepareStart(roomCode: RoomCode, socketId: string): PreparedWordGameStart {
    this.rooms.assertGameplayAvailable(roomCode);
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
    const roleRevealEndsAt = this.addSeconds(
      now,
      ROLE_REVEAL_DURATION_SECONDS,
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
        roleRevealEndsAt: roleRevealEndsAt.toISOString(),
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
      votingPhaseId: 0,
    };

    const prepared = Object.freeze({ roomCode, gameId: sessionId });
    this.preparedStarts.set(prepared, {
      socketId,
      game,
      roleRevealEndsAt,
    });
    return prepared;
  }

  discardPreparedStart(prepared: PreparedWordGameStart): void {
    this.preparedStarts.delete(prepared);
  }

  commitPreparedStart(
    prepared: PreparedWordGameStart,
    reservation?: RoomGameStatusReservation,
  ): WordGameSession {
    this.rooms.assertGameplayAvailable(prepared.roomCode, prepared.gameId);
    const plan = this.preparedStarts.get(prepared);
    if (!plan) {
      throw new AppError("GAME_NOT_ACTIVE", "Prepared game start is no longer available.");
    }
    this.preparedStarts.delete(prepared);
    const { game, socketId, roleRevealEndsAt } = plan;
    const { roomCode } = prepared;
    const sessionId = game.session.id;
    try {
      this.schedule(
        game,
        Math.max(0, roleRevealEndsAt.getTime() - this.runtime.now().getTime()),
        () => {
          void this.beginDiscussion(game, roleRevealEndsAt).catch((error: unknown) =>
            this.handleDurableActivationFailure(roomCode, sessionId, error),
          );
        },
      );
    } catch (error) {
      this.clearTimer(game);
      throw error;
    }

    let room: Room;
    try {
      room = this.rooms.beginImpostorGame(
        roomCode,
        socketId,
        sessionId,
        "impostor-word",
        reservation,
      );
    } catch (error) {
      this.clearTimer(game);
      throw error;
    }

    const previousGame = this.currentGames.get(roomCode);
    if (previousGame) {
      this.clearTimer(previousGame);
      this.gamesById.delete(previousGame.session.id);
    }
    this.currentGames.set(roomCode, game);
    this.gamesById.set(sessionId, game);

    this.events.roomUpdated(room);
    this.events.gameStarted(roomCode, {
      session: this.copySession(game.session),
    });

    return this.copySession(game.session);
  }

  requestRole(
    roomCode: RoomCode,
    sessionId: GameSessionId,
    playerId: PlayerId,
  ): WordImpostorRoleAssignmentPayload {
    this.rooms.assertGameplayAvailable(roomCode, sessionId);
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

  returnToLobby(roomCode: RoomCode, socketId: string): Room {
    this.rooms.assertGameplayAvailable(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    );
    if (this.persistenceCommands) {
      throw new AppError(
        "FEATURE_UNAVAILABLE",
        "Durable rooms must use the persisted lobby transition.",
      );
    }
    this.rooms.assertHost(roomCode, socketId);
    const room = this.rooms.getPublicRoom(roomCode);
    const game = this.currentGames.get(roomCode);
    if (
      !room ||
      room.gameStatus !== "finished" ||
      !game ||
      game.session.status !== "finished" ||
      room.currentGameId !== game.session.id
    ) {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Only a finished Word Impostor game can return to the lobby.",
      );
    }

    this.clearTimer(game);
    this.currentGames.delete(roomCode);
    this.gamesById.delete(game.session.id);
    return this.rooms.returnFinishedImpostorGameToLobby(
      roomCode,
      socketId,
      game.session.id,
    );
  }

  returnToLobbyPersisted(
    roomCode: RoomCode,
    socketId: string,
  ): Promise<Room> {
    this.rooms.assertGameplayAvailable(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    );
    const pending = this.pendingLobbyReturns.get(roomCode);
    if (pending) {
      return pending;
    }
    const operation = this.returnToLobbyPersistedCore(roomCode, socketId);
    const tracked = operation.finally(() => {
      if (this.pendingLobbyReturns.get(roomCode) === tracked) {
        this.pendingLobbyReturns.delete(roomCode);
      }
    });
    this.pendingLobbyReturns.set(roomCode, tracked);
    return tracked;
  }

  private async returnToLobbyPersistedCore(
    roomCode: RoomCode,
    socketId: string,
  ): Promise<Room> {
    this.rooms.assertHost(roomCode, socketId);
    const room = this.rooms.getPublicRoom(roomCode);
    if (room?.gameStatus === "waiting" && !room.currentGameId) {
      return room;
    }
    const game = this.currentGames.get(roomCode);
    if (
      !room
      || room.gameStatus !== "finished"
      || !game
      || game.session.status !== "finished"
      || room.currentGameId !== game.session.id
    ) {
      throw new AppError(
        "GAME_NOT_ACTIVE",
        "Only a finished Word Impostor game can return to the lobby.",
      );
    }
    const commands = this.persistenceCommands;
    if (!commands) {
      return this.returnToLobby(roomCode, socketId);
    }

    return persistFinishedGameReturnToLobby(
      this.rooms,
      commands,
      roomCode,
      socketId,
      game.session.id,
      (reservation) => {
        const lobby = this.rooms.returnFinishedGameToLobby(
          roomCode,
          socketId,
          game.session.id,
          reservation,
        );
        this.clearTimer(game);
        this.currentGames.delete(roomCode);
        this.gamesById.delete(game.session.id);
        return lobby;
      },
    );
  }

  submitVote(
    roomCode: RoomCode,
    voterId: PlayerId,
    targetPlayerId: PlayerId,
    sessionId?: GameSessionId,
    expectedVotingEndsAt?: string,
    expectedVotingPhaseId?: number,
  ): void {
    this.rooms.assertGameplayAvailable(
      roomCode,
      sessionId ?? this.currentGames.get(roomCode)?.session.id,
    );
    const game = this.currentGames.get(roomCode);
    if (
      !game ||
      (sessionId !== undefined && game.session.id !== sessionId) ||
      game.session.status !== "in_progress" ||
      game.session.state.phase !== "voting"
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "Voting is not currently active.");
    }
    const votingEndsAt = game.session.state.votingEndsAt;
    if (
      !votingEndsAt ||
      (expectedVotingEndsAt !== undefined &&
        expectedVotingEndsAt !== votingEndsAt) ||
      game.session.state.votingPhaseId !== game.votingPhaseId ||
      (expectedVotingPhaseId !== undefined &&
        expectedVotingPhaseId !== game.votingPhaseId)
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
    const deadline = Date.parse(votingEndsAt);
    if (
      !Number.isFinite(deadline) ||
      this.runtime.now().getTime() >= deadline
    ) {
      this.resolveVote(game, game.votingPhaseId);
      throw new AppError("GAME_NOT_ACTIVE", "Voting is not currently active.");
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
    const eligibleVoters = this.getEligibleVoterIds(game);
    game.session.state.votesSubmitted = eligibleVoters.filter((playerId) =>
      game.votes.has(playerId),
    ).length;
    this.emitState(game);

    if (
      eligibleVoters.length > 0 &&
      eligibleVoters.every((playerId) => game.votes.has(playerId))
    ) {
      this.resolveVote(game, game.votingPhaseId, true);
    }
  }

  getResumeSnapshot(
    roomCode: RoomCode,
    playerId: PlayerId,
  ): WordImpostorResumeSnapshot | undefined {
    const game = this.currentGames.get(roomCode);
    if (game && this.rooms.isGameplaySuspended(roomCode, game.session.id)) {
      return undefined;
    }
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

  onPlayerRemoved(
    roomCode: RoomCode,
    roomStillExists: boolean,
  ): void | Promise<void> {
    if (this.rooms.isGameplaySuspended(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    )) {
      return;
    }
    const game = this.currentGames.get(roomCode);
    if (!roomStillExists) {
      this.onRoomDeleted(roomCode);
      return;
    }
    if (!game || game.session.status === "finished") {
      return;
    }
    return this.finishGame(game, "cancelled", []);
  }

  onPlayerConnectionChanged(roomCode: RoomCode): void {
    if (this.rooms.isGameplaySuspended(
      roomCode,
      this.currentGames.get(roomCode)?.session.id,
    )) {
      return;
    }
    const game = this.currentGames.get(roomCode);
    if (!game || game.session.status === "finished") {
      return;
    }

    const eligibleVoters = this.getEligibleVoterIds(game);
    const votesSubmitted = eligibleVoters.filter((playerId) =>
      game.votes.has(playerId),
    ).length;
    const stateChanged =
      game.session.state.eligibleVoters !== eligibleVoters.length ||
      game.session.state.votesSubmitted !== votesSubmitted;

    game.session.state.eligibleVoters = eligibleVoters.length;
    game.session.state.votesSubmitted = votesSubmitted;
    if (stateChanged) {
      this.emitState(game);
    }

    if (
      game.session.state.phase === "voting" &&
      eligibleVoters.length > 0 &&
      eligibleVoters.every((playerId) => game.votes.has(playerId))
    ) {
      this.resolveVote(game, game.votingPhaseId, true);
    }
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

  private async beginDiscussion(
    game: WordGameRecord,
    scheduledStartsAt?: Date,
  ): Promise<void> {
    if (!this.isCurrentActiveGame(game)) {
      return;
    }
    const roomBeforeActivation = this.rooms.getPublicRoom(game.roomCode);
    if (
      !roomBeforeActivation
      || roomBeforeActivation.currentGameId !== game.session.id
      || (
        roomBeforeActivation.gameStatus !== "starting"
        && roomBeforeActivation.gameStatus !== "in_progress"
      )
    ) {
      throw new AppError("GAME_NOT_ACTIVE", "The game can no longer start.");
    }
    this.clearTimer(game);

    const startsAt = scheduledStartsAt ?? this.runtime.now();
    const now = this.runtime.now();
    if (startsAt.getTime() > now.getTime()) {
      this.schedule(game, startsAt.getTime() - now.getTime(), () =>
        this.beginDiscussion(game, startsAt).catch((error: unknown) =>
          this.handleDurableActivationFailure(
            game.roomCode,
            game.session.id,
            error,
          ),
        ),
      );
      return;
    }

    if (game.session.status === "starting") {
      if (this.persistenceCommands) {
        await persistGameStatusTransition(
          this.rooms,
          this.persistenceCommands,
          game.roomCode,
          game.session.id,
          (reservation) => {
            const room = this.rooms.activateGame(
              game.roomCode,
              game.session.id,
              reservation,
            );
            this.events.roomUpdated(room);
            game.session.status = "in_progress";
          },
        );
      } else {
        const room = this.rooms.activateGame(game.roomCode, game.session.id);
        this.events.roomUpdated(room);
        game.session.status = "in_progress";
      }
    }

    const endsAt = this.addSeconds(
      startsAt,
      game.settings.discussionDurationSeconds,
    );
    if (endsAt.getTime() <= this.runtime.now().getTime()) {
      delete game.session.state.roleRevealEndsAt;
      this.beginVoting(game, undefined, endsAt);
      return;
    }

    game.session.state.phase = "discussion";
    game.session.state.discussionEndsAt = endsAt.toISOString();
    game.session.state.votesSubmitted = 0;
    game.session.state.eligibleVoters = this.getEligibleVoterIds(game).length;
    delete game.session.state.roleRevealEndsAt;
    delete game.session.state.votingEndsAt;
    delete game.session.state.votingPhaseId;
    delete game.session.state.revotePlayerIds;
    game.votes.clear();
    game.voteCandidates = undefined;
    game.voteAttempt = 0;

    const discussion: DiscussionPayload = {
      sessionId: game.session.id,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    };
    this.events.discussionStarted(game.roomCode, discussion);
    this.emitState(game);
    this.schedule(
      game,
      Math.max(0, endsAt.getTime() - this.runtime.now().getTime()),
      () => this.beginVoting(game, undefined, endsAt),
    );
  }

  private beginVoting(
    game: WordGameRecord,
    tiedPlayerIds?: PlayerId[],
    scheduledStartsAt?: Date,
  ): void {
    if (!this.isCurrentActiveGame(game)) {
      return;
    }
    this.clearTimer(game);

    const now = this.runtime.now();
    const startsAt = scheduledStartsAt ?? now;
    if (startsAt.getTime() > now.getTime()) {
      this.schedule(game, startsAt.getTime() - now.getTime(), () =>
        this.beginVoting(game, tiedPlayerIds, startsAt),
      );
      return;
    }

    const eligibleVoters = this.getEligibleVoterIds(game);
    const endsAt = this.addSeconds(
      startsAt,
      game.settings.votingDurationSeconds,
    );
    game.votingPhaseId += 1;
    const votingPhaseId = game.votingPhaseId;
    game.session.state.phase = "voting";
    game.session.state.votesSubmitted = 0;
    game.session.state.eligibleVoters = eligibleVoters.length;
    game.session.state.votingEndsAt = endsAt.toISOString();
    game.session.state.votingPhaseId = votingPhaseId;
    delete game.session.state.discussionEndsAt;
    if (tiedPlayerIds) {
      game.voteCandidates = new Set(tiedPlayerIds);
      game.session.state.revotePlayerIds = [...tiedPlayerIds];
    } else {
      game.voteCandidates = undefined;
      delete game.session.state.revotePlayerIds;
    }
    game.votes.clear();
    delete game.session.state.roleRevealEndsAt;

    this.emitState(game);
    const remainingMs = endsAt.getTime() - this.runtime.now().getTime();
    if (remainingMs <= 0) {
      this.resolveVote(game, votingPhaseId);
      return;
    }
    this.schedule(game, remainingMs, () =>
      this.resolveVote(game, votingPhaseId),
    );
  }

  private resolveVote(
    game: WordGameRecord,
    votingPhaseId: number,
    allowBeforeDeadline = false,
  ): void {
    if (
      !this.isCurrentActiveGame(game) ||
      game.session.state.phase !== "voting" ||
      game.votingPhaseId !== votingPhaseId
    ) {
      return;
    }

    const votingEndsAt = game.session.state.votingEndsAt;
    if (!votingEndsAt) {
      return;
    }
    const deadline = Date.parse(votingEndsAt);
    if (!Number.isFinite(deadline)) {
      return;
    }
    const remainingMs = deadline - this.runtime.now().getTime();
    if (!allowBeforeDeadline && remainingMs > 0) {
      this.schedule(game, remainingMs, () =>
        this.resolveVote(game, votingPhaseId),
      );
      return;
    }

    this.clearTimer(game);
    delete game.session.state.votingEndsAt;
    delete game.session.state.votingPhaseId;

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
  ): Promise<void> {
    if (game.session.status === "finished") {
      return Promise.resolve();
    }
    const existing = this.pendingFinishes.get(game.session.id);
    if (existing) {
      return existing;
    }

    const operation = this.finishGameCore(game, outcome, winnerPlayerIds);
    const tracked = operation.finally(() => {
      if (this.pendingFinishes.get(game.session.id) === tracked) {
        this.pendingFinishes.delete(game.session.id);
      }
    });
    this.pendingFinishes.set(game.session.id, tracked);
    void tracked.catch((error: unknown) => {
      console.error(
        JSON.stringify({
          level: "error",
          event: "word_game_completion_failed",
          roomCode: game.roomCode,
          gameId: game.session.id,
          error: error instanceof AppError
            ? error.code
            : error instanceof Error
              ? error.name
              : "unknown",
        }),
      );
    });
    return tracked;
  }

  private async finishGameCore(
    game: WordGameRecord,
    outcome: GameResult["outcome"],
    winnerPlayerIds: PlayerId[],
  ): Promise<void> {
    this.clearTimer(game);
    const commit = (reservation?: RoomGameStatusReservation) => {
      const room = this.rooms.finishGame(
        game.roomCode,
        game.session.id,
        reservation,
      );
      if (!room) {
        throw new AppError("GAME_NOT_ACTIVE", "The Word game is no longer current.");
      }
      const endedAt = this.runtime.now().toISOString();
      game.session.status = "finished";
      game.session.endedAt = endedAt;
      game.session.state.phase = "reveal";
      delete game.session.state.roleRevealEndsAt;
      delete game.session.state.discussionEndsAt;
      delete game.session.state.votingEndsAt;
      delete game.session.state.votingPhaseId;
      delete game.session.state.revotePlayerIds;

      const result: GameResult = {
        gameId: game.session.id,
        roomCode: game.roomCode,
        gameMode: "impostor-word",
        outcome,
        winnerPlayerIds: [...winnerPlayerIds],
        endedAt,
      };
      game.result = result;
      this.events.roomUpdated(room);
      this.emitState(game);
      this.events.gameEnded(game.roomCode, {
        result: this.copyResult(result),
      });
      this.events.rolesRevealed(game.roomCode, this.toFinalReveal(game));
    };

    if (this.persistenceCommands) {
      const room = this.rooms.getPublicRoom(game.roomCode);
      if (!room || room.currentGameId !== game.session.id) {
        throw new AppError("GAME_NOT_ACTIVE", "The Word game is no longer current.");
      }
      if (room.gameStatus !== "starting" && room.gameStatus !== "in_progress") {
        if (room.gameStatus === "finished") {
          return;
        }
        throw new AppError("GAME_NOT_ACTIVE", "The Word game cannot be finished.");
      }
      await persistGameCompletion(
        this.rooms,
        this.persistenceCommands,
        game.roomCode,
        game.session.id,
        room.gameStatus,
        (reservation) => commit(reservation),
      );
      return;
    }
    commit();
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
    return [...game.roles.keys()].filter(
      (playerId) =>
        !game.eliminatedPlayerIds.has(playerId) &&
        this.rooms.getSocketIdForPlayer(game.roomCode, playerId) !== undefined,
    );
  }

  private isCurrentActiveGame(game: WordGameRecord): boolean {
    return (
      this.currentGames.get(game.roomCode) === game &&
      game.session.status !== "finished" &&
      !this.rooms.isGameplaySuspended(game.roomCode, game.session.id)
    );
  }

  private schedule(
    game: WordGameRecord,
    delayMs: number,
    callback: () => void,
  ): void {
    this.clearTimer(game);
    if (this.rooms.isGameplaySuspended(game.roomCode, game.session.id)) {
      return;
    }
    let timer: GameTimer;
    timer = this.runtime.schedule(() => {
      if (game.timer !== timer) {
        return;
      }
      game.timer = undefined;
      if (this.rooms.isGameplaySuspended(game.roomCode, game.session.id)) {
        return;
      }
      callback();
    }, delayMs);
    game.timer = timer;
  }

  private handleDurableActivationFailure(
    roomCode: RoomCode,
    gameId: GameSessionId,
    error: unknown,
  ): void {
    if (this.persistenceCommands) {
      this.rooms.fenceRoom(roomCode);
      try {
        this.persistenceCommands.fenceRoom(roomCode);
      } catch (fenceError) {
        console.error(
          JSON.stringify({
            level: "error",
            event: "durable_game_activation_fence_failed",
            roomCode,
            gameId,
            error: fenceError instanceof Error ? fenceError.message : "unknown",
          }),
        );
      }
    }
    console.error(
      JSON.stringify({
        level: "error",
        event: "game_activation_failed",
        roomCode,
        gameId,
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
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
