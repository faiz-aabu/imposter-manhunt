import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ROLE_REVEAL_DURATION_SECONDS,
  wordImpostorSettingsSchema,
} from "@impostor/api";
import type {
  GameEndedPayload,
  GameStartedPayload,
  GameStateUpdatePayload,
  PlayerId,
  RoomCode,
  VoteResultsPayload,
  WordCategory,
  WordImpostorDiscussionPayload,
  WordImpostorRevealPayload,
  WordImpostorRoleAssignmentPayload,
} from "@impostor/api";
import { WordImpostorService } from "./word-game-service.js";
import type {
  WordImpostorGameEvents,
} from "./word-game-service.js";
import type {
  GameRuntime,
  GameTimer,
} from "./classic-game-service.js";
import { RoomService } from "../../rooms/room-service.js";
import { AppError } from "../../utils/app-error.js";
import { WORD_CATALOG } from "../../data/word-categories.js";

const GAME_SETTINGS = {
  category: "animals",
  impostorCount: 1,
  discussionDurationSeconds: 30,
  votingDurationSeconds: 10,
} as const;

interface ManualTimer {
  dueAt: number;
  callback: () => void;
}

class ManualRuntime implements GameRuntime {
  private currentTime = Date.parse("2025-01-01T00:00:00.000Z");
  private nextTimerId = 0;
  private readonly timers = new Map<number, ManualTimer>();

  now(): Date {
    return new Date(this.currentTime);
  }

  schedule(callback: () => void, delayMs: number): GameTimer {
    const timerId = this.nextTimerId++;
    this.timers.set(timerId, {
      dueAt: this.currentTime + delayMs,
      callback,
    });
    return { cancel: () => this.timers.delete(timerId) };
  }

  get pendingTimerCount(): number {
    return this.timers.size;
  }

  advance(delayMs: number): void {
    this.currentTime += delayMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= this.currentTime)
        .sort(([, first], [, second]) => first.dueAt - second.dueAt)[0];
      if (!next) {
        return;
      }
      const [timerId, timer] = next;
      this.timers.delete(timerId);
      timer.callback();
    }
  }
}

interface GameHarness {
  rooms: RoomService;
  service: WordImpostorService;
  runtime: ManualRuntime;
  roomCode: RoomCode;
  hostSocketId: string;
  playerIds: PlayerId[];
  sessionId: string;
  category: WordCategory;
  events: {
    started: GameStartedPayload[];
    states: GameStateUpdatePayload[];
    discussions: WordImpostorDiscussionPayload[];
    votes: VoteResultsPayload[];
    ended: GameEndedPayload[];
    reveals: WordImpostorRevealPayload[];
  };
}

function createHarness(options: {
  playerCount?: number;
  impostorCount?: number;
  category?: WordCategory;
  startGame?: boolean;
} = {}): GameHarness {
  const playerCount = options.playerCount ?? 4;
  const hostSocketId = "socket-0";
  const category = options.category ?? GAME_SETTINGS.category;
  const rooms = new RoomService();
  const created = rooms.createRoom(
    {
      nickname: "Player 0",
      settings: {
        gameMode: "impostor-word",
        maxPlayers: 10,
        isPrivate: false,
        wordImpostor: {
          ...GAME_SETTINGS,
          category,
          ...(options.impostorCount === undefined
            ? {}
            : { impostorCount: options.impostorCount }),
        },
      },
    },
    hostSocketId,
  );
  const roomCode = created.room.code;
  const playerIds = [created.playerId];
  for (let index = 1; index < playerCount; index += 1) {
    const joined = rooms.joinRoom(
      { roomCode, nickname: `Player ${index}` },
      `socket-${index}`,
    );
    playerIds.push(joined.playerId);
  }

  const runtime = new ManualRuntime();
  const events: GameHarness["events"] = {
    started: [],
    states: [],
    discussions: [],
    votes: [],
    ended: [],
    reveals: [],
  };
  const callbacks: WordImpostorGameEvents = {
    gameStarted: (_code, payload) => events.started.push(payload),
    roomUpdated: () => undefined,
    stateUpdated: (_code, payload) => events.states.push(payload),
    discussionStarted: (_code, payload) => events.discussions.push(payload),
    voteResults: (_code, payload) => events.votes.push(payload),
    gameEnded: (_code, payload) => events.ended.push(payload),
    rolesRevealed: (_code, payload) => events.reveals.push(payload),
  };
  const service = new WordImpostorService(rooms, callbacks, runtime);
  const session =
    options.startGame === false
      ? undefined
      : service.startGame(roomCode, hostSocketId);
  return {
    rooms,
    service,
    runtime,
    roomCode,
    hostSocketId,
    playerIds,
    sessionId: session?.id ?? "",
    category,
    events,
  };
}

function getRoles(
  harness: GameHarness,
): Map<PlayerId, WordImpostorRoleAssignmentPayload> {
  return new Map(
    harness.playerIds.map((playerId) => [
      playerId,
      harness.service.requestRole(
        harness.roomCode,
        harness.sessionId,
        playerId,
      ),
    ]),
  );
}

function enterVoting(harness: GameHarness): void {
  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  assert.equal(harness.events.states.at(-1)?.state.phase, "voting");
}

function voteOut(
  harness: GameHarness,
  targetPlayerId: PlayerId,
  alternateTargetId: PlayerId,
): void {
  for (const voterId of harness.playerIds) {
    harness.service.submitVote(
      harness.roomCode,
      voterId,
      voterId === targetPlayerId ? alternateTargetId : targetPlayerId,
    );
  }
}

test("Word Impostor requires the host, three connected players, and valid settings", () => {
  const nonHost = createHarness({ startGame: false });
  assert.throws(
    () => nonHost.service.startGame(nonHost.roomCode, "socket-1"),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );
  nonHost.service.close();

  const tooFew = createHarness({ playerCount: 2, startGame: false });
  assert.throws(
    () =>
      tooFew.service.startGame(tooFew.roomCode, tooFew.hostSocketId),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_READY",
  );
  tooFew.service.close();

  const disconnected = createHarness({ startGame: false });
  disconnected.rooms.disconnectSocket("socket-3");
  assert.throws(
    () =>
      disconnected.service.startGame(
        disconnected.roomCode,
        disconnected.hostSocketId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_READY",
  );
  disconnected.service.close();

  assert.equal(
    wordImpostorSettingsSchema.safeParse({
      ...GAME_SETTINGS,
      category: "unknown",
    }).success,
    false,
  );
});

test("server assigns one shared civilian word and keeps roles and word private", () => {
  const harness = createHarness();
  const roles = getRoles(harness);
  const impostors = [...roles.values()].filter(
    (assignment) => assignment.role === "impostor",
  );
  const civilians = [...roles.values()].filter(
    (
      assignment,
    ): assignment is Extract<
      WordImpostorRoleAssignmentPayload,
      { role: "civilian" }
    > => assignment.role === "civilian",
  );

  assert.equal(impostors.length, 1);
  assert.equal(civilians.length, harness.playerIds.length - 1);
  assert.equal(new Set(civilians.map(({ secretWord }) => secretWord)).size, 1);
  assert.ok(civilians[0]?.secretWord);
  assert.ok(
    WORD_CATALOG[harness.category].includes(civilians[0]?.secretWord ?? ""),
  );
  assert.equal(
    "secretWord" in (impostors[0] ?? {}),
    false,
  );

  const publicData = JSON.stringify({
    room: harness.rooms.getPublicRoom(harness.roomCode),
    started: harness.events.started,
    states: harness.events.states,
    discussions: harness.events.discussions,
    votes: harness.events.votes,
  });
  assert.equal(publicData.includes(civilians[0]?.secretWord ?? ""), false);
  assert.equal(publicData.includes("playerRoles"), false);
  assert.throws(
    () =>
      harness.service.requestRole(
        harness.roomCode,
        harness.sessionId,
        "not-a-room-player",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );

  const resumedCivilian = harness.playerIds.find((playerId) => {
    const assignment = roles.get(playerId);
    return assignment?.role === "civilian";
  });
  assert.ok(resumedCivilian);
  assert.deepEqual(
    harness.service.getResumeSnapshot(harness.roomCode, resumedCivilian)?.role,
    roles.get(resumedCivilian),
  );
  harness.service.close();
});

test("discussion and voting are controlled by server deadlines", () => {
  const harness = createHarness();
  assert.equal(harness.runtime.pendingTimerCount, 1);
  assert.equal(harness.events.started[0]?.session.state.phase, "role_reveal");

  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "in_progress");
  assert.equal(harness.events.states.at(-1)?.state.phase, "discussion");
  assert.ok(harness.events.discussions.at(-1)?.endsAt);

  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  const votingState = harness.events.states.at(-1)?.state;
  assert.ok(votingState?.phase === "voting");
  assert.ok(votingState.votingEndsAt);
  harness.service.close();
});

test("votes reject self-votes, invalid targets, duplicate submissions, and eliminated voters", () => {
  const harness = createHarness();
  enterVoting(harness);
  const first = harness.playerIds[0];
  const second = harness.playerIds[1];
  assert.ok(first);
  assert.ok(second);

  assert.throws(
    () => harness.service.submitVote(harness.roomCode, first, first),
    (error: unknown) =>
      error instanceof AppError && error.code === "INVALID_VOTE",
  );
  assert.throws(
    () =>
      harness.service.submitVote(harness.roomCode, first, "unknown-player"),
    (error: unknown) =>
      error instanceof AppError && error.code === "INVALID_VOTE",
  );

  harness.service.submitVote(harness.roomCode, first, second);
  assert.throws(
    () => harness.service.submitVote(harness.roomCode, first, second),
    (error: unknown) =>
      error instanceof AppError && error.code === "DUPLICATE_VOTE",
  );
  harness.service.close();

  const eliminated = createHarness();
  const roles = getRoles(eliminated);
  const target = eliminated.playerIds.find(
    (playerId) => roles.get(playerId)?.role === "civilian",
  );
  const alternate = eliminated.playerIds.find(
    (playerId) => playerId !== target,
  );
  assert.ok(target);
  assert.ok(alternate);
  enterVoting(eliminated);
  voteOut(eliminated, target, alternate);
  assert.equal(
    eliminated.rooms
      .getPublicRoom(eliminated.roomCode)
      ?.players.find((player) => player.id === target)?.status,
    "eliminated",
  );
  eliminated.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  assert.throws(
    () =>
      eliminated.service.submitVote(
        eliminated.roomCode,
        target,
        alternate,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );
  eliminated.service.close();
});

test("tied votes trigger a revote restricted to tied candidates", () => {
  const harness = createHarness();
  const first = harness.playerIds[0];
  const second = harness.playerIds[1];
  const third = harness.playerIds[2];
  const fourth = harness.playerIds[3];
  assert.ok(first);
  assert.ok(second);
  assert.ok(third);
  assert.ok(fourth);
  enterVoting(harness);

  harness.service.submitVote(harness.roomCode, first, second);
  harness.service.submitVote(harness.roomCode, second, first);
  harness.service.submitVote(harness.roomCode, third, first);
  harness.service.submitVote(harness.roomCode, fourth, second);

  assert.equal(harness.events.votes.at(-1)?.eliminatedPlayerId, null);
  assert.deepEqual(
    new Set(harness.events.votes.at(-1)?.tiedPlayerIds),
    new Set([first, second]),
  );
  const revoteState = harness.events.states.at(-1)?.state;
  assert.ok(revoteState?.phase === "voting");
  assert.deepEqual(
    new Set(revoteState.revotePlayerIds),
    new Set([first, second]),
  );

  harness.service.submitVote(harness.roomCode, first, second);
  harness.service.submitVote(harness.roomCode, second, first);
  harness.service.submitVote(harness.roomCode, third, first);
  harness.service.submitVote(harness.roomCode, fourth, first);
  assert.equal(harness.events.votes.at(-1)?.eliminatedPlayerId, first);
  assert.equal(harness.service.getHistory(harness.sessionId)?.voting.length, 2);
  harness.service.close();
});

test("voting timeout resolves partial votes and safely skips a round with no votes", () => {
  const harness = createHarness();
  enterVoting(harness);
  const roles = getRoles(harness);
  const target = harness.playerIds.find(
    (playerId) => roles.get(playerId)?.role === "civilian",
  );
  const voter = harness.playerIds.find((playerId) => playerId !== target);
  assert.ok(voter);
  assert.ok(target);
  harness.service.submitVote(harness.roomCode, voter, target);
  harness.runtime.advance(GAME_SETTINGS.votingDurationSeconds * 1_000);

  assert.equal(harness.events.votes.at(-1)?.eliminatedPlayerId, target);
  assert.equal(harness.events.states.at(-1)?.state.phase, "discussion");
  harness.service.close();

  const noVotes = createHarness();
  enterVoting(noVotes);
  noVotes.runtime.advance(GAME_SETTINGS.votingDurationSeconds * 1_000);
  assert.equal(noVotes.events.votes.at(-1)?.eliminatedPlayerId, null);
  assert.deepEqual(noVotes.events.votes.at(-1)?.tiedPlayerIds, []);
  const nextRound = noVotes.events.states.at(-1)?.state;
  assert.ok(nextRound?.phase === "discussion");
  assert.equal(nextRound.roundNumber, 2);
  noVotes.service.close();
});

test("civilian victory follows elimination of the last impostor", () => {
  const harness = createHarness();
  const roles = getRoles(harness);
  const impostor = harness.playerIds.find(
    (playerId) => roles.get(playerId)?.role === "impostor",
  );
  const civilian = harness.playerIds.find(
    (playerId) => roles.get(playerId)?.role === "civilian",
  );
  assert.ok(impostor);
  assert.ok(civilian);

  enterVoting(harness);
  voteOut(harness, impostor, civilian);
  const result = harness.events.ended.at(-1)?.result;
  assert.equal(result?.outcome, "win");
  assert.deepEqual(
    new Set(result?.winnerPlayerIds),
    new Set(
      harness.playerIds.filter(
        (playerId) => roles.get(playerId)?.role === "civilian",
      ),
    ),
  );
  harness.service.close();
});

test("impostor victory occurs when impostors equal the remaining civilians", () => {
  const harness = createHarness({ playerCount: 3 });
  const roles = getRoles(harness);
  const impostor = harness.playerIds.find(
    (playerId) => roles.get(playerId)?.role === "impostor",
  );
  const civilians = harness.playerIds.filter(
    (playerId) => roles.get(playerId)?.role === "civilian",
  );
  const target = civilians[0];
  const alternate = civilians[1];
  assert.ok(impostor);
  assert.ok(target);
  assert.ok(alternate);

  enterVoting(harness);
  harness.service.submitVote(harness.roomCode, impostor, target);
  harness.service.submitVote(harness.roomCode, target, alternate);
  harness.service.submitVote(harness.roomCode, alternate, target);
  assert.equal(harness.events.ended.at(-1)?.result.outcome, "win");
  assert.deepEqual(harness.events.ended.at(-1)?.result.winnerPlayerIds, [
    impostor,
  ]);
  harness.service.close();
});

test("secret word and every role are revealed only after the game ends", () => {
  const harness = createHarness();
  const roles = getRoles(harness);
  const impostor = harness.playerIds.find(
    (playerId) => roles.get(playerId)?.role === "impostor",
  );
  const civilians = harness.playerIds.filter(
    (playerId) => roles.get(playerId)?.role === "civilian",
  );
  const civilian = civilians[0];
  assert.ok(impostor);
  assert.ok(civilian);

  const privateWord = roles.get(civilian);
  assert.ok(privateWord?.role === "civilian");
  assert.equal(harness.events.reveals.length, 0);
  const publicBeforeEnd = JSON.stringify({
    room: harness.rooms.getPublicRoom(harness.roomCode),
    started: harness.events.started,
    states: harness.events.states,
  });
  assert.equal(publicBeforeEnd.includes(privateWord.secretWord), false);

  enterVoting(harness);
  voteOut(harness, impostor, civilian);
  const reveal = harness.events.reveals.at(-1);
  assert.equal(reveal?.secretWord, privateWord.secretWord);
  assert.equal(reveal?.category, GAME_SETTINGS.category);
  assert.equal(reveal?.playerRoles.length, harness.playerIds.length);
  assert.equal(
    reveal?.playerRoles.find((entry) => entry.playerId === impostor)?.role,
    "impostor",
  );
  assert.deepEqual(
    harness.service.getResumeSnapshot(harness.roomCode, civilian)?.reveal,
    reveal,
  );
  harness.service.close();
});

test("room removal and service shutdown clear active phase timers", () => {
  const harness = createHarness();
  assert.equal(harness.runtime.pendingTimerCount, 1);
  harness.service.onPlayerRemoved(harness.roomCode, true);
  assert.equal(harness.events.ended.at(-1)?.result.outcome, "cancelled");
  assert.equal(harness.events.reveals.at(-1)?.playerRoles.length, 4);
  assert.equal(harness.runtime.pendingTimerCount, 0);
  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  assert.equal(harness.events.states.at(-1)?.state.phase, "reveal");
  harness.service.close();

  const roomDeleted = createHarness();
  roomDeleted.service.onRoomDeleted(roomDeleted.roomCode);
  assert.equal(roomDeleted.runtime.pendingTimerCount, 0);
  roomDeleted.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  assert.equal(roomDeleted.events.states.length, 0);
  roomDeleted.service.close();
});
