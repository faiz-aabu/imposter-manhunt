import assert from "node:assert/strict";
import { test } from "node:test";
import { ROLE_REVEAL_DURATION_SECONDS } from "@impostor/api";
import type {
  ClassicImpostorSettings,
  GameEndedPayload,
  GameStartedPayload,
  GameStateUpdatePayload,
  ImpostorRevealPayload,
  PlayerId,
  RoomCode,
  VoteResultsPayload,
} from "@impostor/api";
import { ClassicImpostorService } from "./classic-game-service.js";
import type { ClassicGameEvents, GameRuntime, GameTimer } from "./classic-game-service.js";
import { RoomService } from "../../rooms/room-service.js";
import { AppError } from "../../utils/app-error.js";

const GAME_SETTINGS: ClassicImpostorSettings = {
  impostorCount: 1,
  discussionDurationSeconds: 30,
  votingDurationSeconds: 10,
};

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
  service: ClassicImpostorService;
  runtime: ManualRuntime;
  roomCode: RoomCode;
  hostSocketId: string;
  playerIds: PlayerId[];
  sessionId: string;
  events: {
    started: GameStartedPayload[];
    states: GameStateUpdatePayload[];
    votes: VoteResultsPayload[];
    ended: GameEndedPayload[];
    reveals: ImpostorRevealPayload[];
  };
}

function createHarness(options: {
  playerCount?: number;
  impostorCount?: number;
  gameMode?: "impostor-classic" | "impostor-word";
  startGame?: boolean;
} = {}): GameHarness {
  const playerCount = options.playerCount ?? 4;
  const hostSocketId = "socket-0";
  const rooms = new RoomService();
  const created = rooms.createRoom(
    {
      nickname: "Player 0",
      settings: {
        gameMode: options.gameMode ?? "impostor-classic",
        maxPlayers: 10,
        isPrivate: false,
        ...(options.gameMode === "impostor-word"
          ? {}
          : {
              classicImpostor: {
                ...GAME_SETTINGS,
                ...(options.impostorCount === undefined
                  ? {}
                  : { impostorCount: options.impostorCount }),
              },
            }),
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
    votes: [],
    ended: [],
    reveals: [],
  };
  const callbacks: ClassicGameEvents = {
    gameStarted: (_code, payload) => events.started.push(payload),
    roomUpdated: () => undefined,
    stateUpdated: (_code, payload) => events.states.push(payload),
    discussionStarted: () => undefined,
    voteResults: (_code, payload) => events.votes.push(payload),
    gameEnded: (_code, payload) => events.ended.push(payload),
    rolesRevealed: (_code, payload) => events.reveals.push(payload),
  };
  const service = new ClassicImpostorService(rooms, callbacks, runtime);
  const session = options.startGame === false
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
    events,
  };
}

function getRoles(
  harness: GameHarness,
): Map<PlayerId, "impostor" | "player"> {
  return new Map(
    harness.playerIds.map((playerId) => [
      playerId,
      harness.service.requestRole(
        harness.roomCode,
        harness.sessionId,
        playerId,
      ).role,
    ]),
  );
}

function enterVoting(harness: GameHarness): void {
  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  assert.equal(harness.events.states.at(-1)?.state.phase, "voting");
}

function submitVotesForTarget(
  harness: GameHarness,
  targetPlayerId: PlayerId,
  alternateTargetId: PlayerId,
): void {
  const eligiblePlayerIds =
    harness.rooms
      .getPublicRoom(harness.roomCode)
      ?.players.filter((player) => player.status === "active")
      .map((player) => player.id) ?? [];
  for (const voterId of eligiblePlayerIds) {
    harness.service.submitVote(
      harness.roomCode,
      voterId,
      voterId === targetPlayerId ? alternateTargetId : targetPlayerId,
    );
  }
}

test("host start assigns server-side roles without exposing them publicly", () => {
  const harness = createHarness();
  const room = harness.rooms.getPublicRoom(harness.roomCode);
  assert.ok(room);
  assert.equal(harness.events.started.length, 1);
  assert.equal(room.gameStatus, "starting");
  assert.equal(
    JSON.stringify({ room, started: harness.events.started[0] }).includes(
      "impostorPlayerIds",
    ),
    false,
  );
  assert.throws(
    () =>
      harness.rooms.updateRoomSettings(
        { roomCode: harness.roomCode, settings: room.settings },
        harness.hostSocketId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );

  const roles = getRoles(harness);
  assert.equal(
    [...roles.values()].filter((role) => role === "impostor").length,
    1,
  );
  assert.equal(
    [...roles.values()].filter((role) => role === "player").length,
    harness.playerIds.length - 1,
  );
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
  harness.service.close();
});

test("only the host can start and invalid player counts are rejected", () => {
  const nonHostHarness = createHarness();
  assert.throws(
    () => nonHostHarness.service.startGame(nonHostHarness.roomCode, "socket-1"),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );
  nonHostHarness.service.close();

  const tooFewPlayers = createHarness({ playerCount: 2, startGame: false });
  assert.throws(
    () =>
      tooFewPlayers.service.startGame(
        tooFewPlayers.roomCode,
        tooFewPlayers.hostSocketId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_READY",
  );
  tooFewPlayers.service.close();

  const disconnectedPlayer = createHarness({ startGame: false });
  disconnectedPlayer.rooms.disconnectSocket("socket-3");
  assert.throws(
    () =>
      disconnectedPlayer.service.startGame(
        disconnectedPlayer.roomCode,
        disconnectedPlayer.hostSocketId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_READY",
  );
  disconnectedPlayer.service.close();

  const tooManyImpostors = createHarness({
    playerCount: 3,
    impostorCount: 2,
    startGame: false,
  });
  assert.throws(
    () =>
      tooManyImpostors.service.startGame(
        tooManyImpostors.roomCode,
        tooManyImpostors.hostSocketId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_READY",
  );
  tooManyImpostors.service.close();
});

test("role reveal transitions to discussion and then server-timed voting", () => {
  const harness = createHarness();
  assert.equal(harness.runtime.pendingTimerCount, 1);

  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "in_progress");
  assert.equal(harness.events.states.at(-1)?.state.phase, "discussion");
  assert.equal(harness.runtime.pendingTimerCount, 1);

  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  assert.equal(harness.events.states.at(-1)?.state.phase, "voting");
  assert.equal(harness.runtime.pendingTimerCount, 1);
  harness.service.close();
  assert.equal(harness.runtime.pendingTimerCount, 0);
});

test("votes reject self, unknown, and duplicate choices", () => {
  const harness = createHarness();
  enterVoting(harness);
  const [voterId, targetPlayerId] = harness.playerIds;
  assert.ok(voterId);
  assert.ok(targetPlayerId);
  assert.throws(
    () => harness.service.submitVote(harness.roomCode, voterId, voterId),
    (error: unknown) =>
      error instanceof AppError && error.code === "INVALID_VOTE",
  );
  assert.throws(
    () =>
      harness.service.submitVote(
        harness.roomCode,
        voterId,
        "unknown-player",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "INVALID_VOTE",
  );

  harness.service.submitVote(harness.roomCode, voterId, targetPlayerId);
  assert.throws(
    () => harness.service.submitVote(harness.roomCode, voterId, targetPlayerId),
    (error: unknown) =>
      error instanceof AppError && error.code === "DUPLICATE_VOTE",
  );
  harness.service.close();
});

test("tied votes trigger a revote among tied players; eliminated players cannot vote", () => {
  const harness = createHarness();
  const roles = getRoles(harness);
  const civilians = harness.playerIds.filter(
    (playerId) => roles.get(playerId) === "player",
  );
  const firstCandidate = civilians[0];
  const secondCandidate = civilians[1];
  assert.ok(firstCandidate);
  assert.ok(secondCandidate);
  enterVoting(harness);

  let otherVoterIndex = 0;
  for (const voterId of harness.playerIds) {
    const target =
      voterId === firstCandidate
        ? secondCandidate
        : voterId === secondCandidate
          ? firstCandidate
          : otherVoterIndex++ === 0
            ? firstCandidate
            : secondCandidate;
    harness.service.submitVote(harness.roomCode, voterId, target);
  }

  const tie = harness.events.votes.at(-1);
  assert.ok(tie);
  assert.equal(tie.eliminatedPlayerId, null);
  assert.equal(tie.tiedPlayerIds?.length, 2);
  const revoteState = harness.events.states.at(-1)?.state;
  assert.ok(revoteState?.phase === "voting");
  assert.deepEqual(
    new Set(revoteState.revotePlayerIds),
    new Set([firstCandidate, secondCandidate]),
  );

  for (const voterId of harness.playerIds) {
    harness.service.submitVote(
      harness.roomCode,
      voterId,
      voterId === firstCandidate ? secondCandidate : firstCandidate,
    );
  }
  assert.equal(harness.events.votes.at(-1)?.eliminatedPlayerId, firstCandidate);
  assert.equal(
    harness.rooms
      .getPublicRoom(harness.roomCode)
      ?.players.find((player) => player.id === firstCandidate)?.status,
    "eliminated",
  );
  assert.equal(harness.events.states.at(-1)?.state.phase, "discussion");
  const history = harness.service.getHistory(harness.sessionId);
  assert.equal(history?.voting.length, 2);
  assert.equal(history?.eliminations[0]?.playerId, firstCandidate);

  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  assert.throws(
    () =>
      harness.service.submitVote(
        harness.roomCode,
        firstCandidate,
        secondCandidate,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );
  harness.service.close();
});

test("voting timeout with no votes advances without an endless zero-vote revote", () => {
  const harness = createHarness();
  enterVoting(harness);
  harness.runtime.advance(GAME_SETTINGS.votingDurationSeconds * 1_000);

  assert.equal(harness.events.votes.at(-1)?.eliminatedPlayerId, null);
  assert.deepEqual(harness.events.votes.at(-1)?.tiedPlayerIds, []);
  const nextRoundState = harness.events.states.at(-1)?.state;
  assert.ok(nextRoundState?.phase === "discussion");
  assert.equal(nextRoundState.roundNumber, 2);
  assert.equal(harness.runtime.pendingTimerCount, 1);
  harness.service.close();
});

test("eliminating the impostor awards civilians the win and clears timers", () => {
  const harness = createHarness();
  const roles = getRoles(harness);
  const impostorId = harness.playerIds.find(
    (playerId) => roles.get(playerId) === "impostor",
  );
  const civilianId = harness.playerIds.find(
    (playerId) => roles.get(playerId) === "player",
  );
  assert.ok(impostorId);
  assert.ok(civilianId);
  enterVoting(harness);
  submitVotesForTarget(harness, impostorId, civilianId);

  const result = harness.events.ended.at(-1)?.result;
  assert.ok(result);
  assert.equal(result.outcome, "win");
  assert.deepEqual(
    new Set(result.winnerPlayerIds),
    new Set(harness.playerIds.filter((playerId) => roles.get(playerId) === "player")),
  );
  assert.deepEqual(harness.events.reveals.at(-1)?.impostorPlayerIds, [impostorId]);
  assert.equal(harness.runtime.pendingTimerCount, 0);
  harness.service.close();
});

test("impostors win when their number reaches the civilians", () => {
  const harness = createHarness();
  const roles = getRoles(harness);
  const impostorId = harness.playerIds.find(
    (playerId) => roles.get(playerId) === "impostor",
  );
  const civilians = harness.playerIds.filter(
    (playerId) => roles.get(playerId) === "player",
  );
  const firstCivilian = civilians[0];
  const secondCivilian = civilians[1];
  assert.ok(impostorId);
  assert.ok(firstCivilian);
  assert.ok(secondCivilian);

  enterVoting(harness);
  submitVotesForTarget(harness, firstCivilian, secondCivilian);
  assert.equal(harness.events.ended.length, 0);
  assert.equal(harness.events.states.at(-1)?.state.phase, "discussion");

  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  submitVotesForTarget(harness, secondCivilian, impostorId);

  const result = harness.events.ended.at(-1)?.result;
  assert.ok(result);
  assert.equal(result.outcome, "win");
  assert.deepEqual(result.winnerPlayerIds, [impostorId]);
  assert.equal(harness.runtime.pendingTimerCount, 0);
  harness.service.close();
});

test("removing a player cancels an active game and cleans up its timer", () => {
  const harness = createHarness();
  assert.equal(harness.runtime.pendingTimerCount, 1);

  harness.service.onPlayerRemoved(harness.roomCode, true);

  assert.equal(harness.events.ended.at(-1)?.result.outcome, "cancelled");
  assert.equal(harness.runtime.pendingTimerCount, 0);
  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  assert.equal(harness.events.states.at(-1)?.state.phase, "reveal");
  harness.service.close();
});
