import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ROLE_REVEAL_DURATION_SECONDS } from "@impostor/api";
import type {
  ClassicImpostorSettings,
  GameEndedPayload,
  GameStartedPayload,
  GameStateUpdatePayload,
  DiscussionPayload,
  ImpostorRevealPayload,
  PlayerId,
  RoomCode,
  RoomSettings,
  VoteResultsPayload,
} from "@impostor/api";
import { ClassicImpostorService } from "./classic-game-service.js";
import type { ClassicGameEvents, GameRuntime, GameTimer } from "./classic-game-service.js";
import { RoomService } from "../../rooms/room-service.js";
import { RoomPersistenceCoordinator } from "../../rooms/room-persistence-coordinator.js";
import { RoomPersistenceCommands } from "../../rooms/room-persistence-commands.js";
import type {
  CreatedRoomInfo,
  CreateRoomWithHostInput,
  JoinedRoomInfo,
  JoinRoomInput,
  TransitionRoomGameStatusInput,
  TransitionedRoomGameStatusInfo,
} from "../../rooms/postgres-room-repository.js";
import { AppError } from "../../utils/app-error.js";

const GAME_SETTINGS: ClassicImpostorSettings = {
  impostorCount: 1,
  discussionDurationSeconds: 30,
  votingDurationSeconds: 10,
};

type ImpostorGameStateUpdate = GameStateUpdatePayload & {
  state: Extract<GameStateUpdatePayload["state"], { roundNumber: number }>;
};

function asImpostorGameStateUpdate(
  payload: GameStateUpdatePayload,
): ImpostorGameStateUpdate {
  if (!("roundNumber" in payload.state)) {
    throw new Error("Expected an Impostor game-state update.");
  }
  return { ...payload, state: payload.state };
}

function getRoleRevealDeadline(
  state: GameStateUpdatePayload["state"] | undefined,
): string | undefined {
  if (!state || !("roundNumber" in state) || state.phase !== "role_reveal") {
    throw new Error("Expected the role-reveal state.");
  }
  return state.roleRevealEndsAt;
}

function getDiscussionDeadline(
  state: GameStateUpdatePayload["state"] | undefined,
): string | undefined {
  if (!state || !("roundNumber" in state) || state.phase !== "discussion") {
    throw new Error("Expected the discussion state.");
  }
  return state.discussionEndsAt;
}

interface ManualTimer {
  dueAt: number;
  callback: () => void;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ManualRuntime implements GameRuntime {
  private currentTime = Date.parse("2025-01-01T00:00:00.000Z");
  private nextTimerId = 0;
  private readonly timers = new Map<number, ManualTimer>();
  latestScheduledCallback?: () => void;

  now(): Date {
    return new Date(this.currentTime);
  }

  schedule(callback: () => void, delayMs: number): GameTimer {
    const timerId = this.nextTimerId++;
    this.latestScheduledCallback = callback;
    this.timers.set(timerId, {
      dueAt: this.currentTime + delayMs,
      callback,
    });
    return { cancel: () => this.timers.delete(timerId) };
  }

  get pendingTimerCount(): number {
    return this.timers.size;
  }

  advanceWithoutRunningTimers(delayMs: number): void {
    this.currentTime += delayMs;
  }

  runNextDueTimer(): () => void {
    const timer = this.takeNextDueTimer();
    if (!timer) {
      throw new Error("No due timer is scheduled.");
    }
    timer.callback();
    return timer.callback;
  }

  advance(delayMs: number): void {
    this.currentTime += delayMs;
    while (true) {
      const timer = this.takeNextDueTimer();
      if (!timer) {
        return;
      }
      timer.callback();
    }
  }

  private takeNextDueTimer(): ManualTimer | undefined {
    const next = [...this.timers.entries()]
      .filter(([, timer]) => timer.dueAt <= this.currentTime)
      .sort(([, first], [, second]) => first.dueAt - second.dueAt)[0];
    if (!next) {
      return undefined;
    }
    this.timers.delete(next[0]);
    return next[1];
  }
}

interface GameHarness {
  rooms: RoomService;
  service: ClassicImpostorService;
  runtime: ManualRuntime;
  roomCode: RoomCode;
  hostSocketId: string;
  playerIds: PlayerId[];
  socketIds: Array<string | undefined>;
  reconnectCounts: number[];
  reconnectTokens: string[];
  sessionId: string;
  events: {
    started: GameStartedPayload[];
    states: ImpostorGameStateUpdate[];
    discussions: DiscussionPayload[];
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
  persistenceCommandsFactory?: (
    rooms: RoomService,
    roomCode: RoomCode,
    hostPlayerId: PlayerId,
  ) => RoomPersistenceCommands;
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
  const socketIds = [hostSocketId];
  const reconnectCounts = [0];
  const reconnectTokens = [created.reconnectToken];
  for (let index = 1; index < playerCount; index += 1) {
    const joined = rooms.joinRoom(
      { roomCode, nickname: `Player ${index}` },
      `socket-${index}`,
    );
    playerIds.push(joined.playerId);
    socketIds.push(`socket-${index}`);
    reconnectCounts.push(0);
    reconnectTokens.push(joined.reconnectToken);
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
  const callbacks: ClassicGameEvents = {
    gameStarted: (_code, payload) => events.started.push(payload),
    roomUpdated: () => undefined,
    stateUpdated: (_code, payload) =>
      events.states.push(asImpostorGameStateUpdate(payload)),
    discussionStarted: (_code, payload) => events.discussions.push(payload),
    voteResults: (_code, payload) => events.votes.push(payload),
    gameEnded: (_code, payload) => events.ended.push(payload),
    rolesRevealed: (_code, payload) => events.reveals.push(payload),
  };
  const persistenceCommands = options.persistenceCommandsFactory?.(
    rooms,
    roomCode,
    playerIds[0]!,
  );
  const service = new ClassicImpostorService(
    rooms,
    callbacks,
    runtime,
    persistenceCommands,
  );
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
    socketIds,
    reconnectCounts,
    reconnectTokens,
    sessionId: session?.id ?? "",
    events,
  };
}

function createTransitionResult(
  input: TransitionRoomGameStatusInput,
  version: string,
): TransitionedRoomGameStatusInfo {
  return {
    roomId: input.expectedRoomId,
    roomCode: input.roomCode,
    gameMode: "impostor-classic",
    gameStatus: input.nextStatus,
    lifecycleStatus: "active",
    currentGameId: input.nextGameId,
    version,
  };
}

function createDurableActivationFixture() {
  const activationEntered = deferred<void>();
  const finishActivation = deferred<TransitionedRoomGameStatusInfo>();
  const completionEntered = deferred<void>();
  const finishCompletion = deferred<TransitionedRoomGameStatusInfo>();
  const coordinator = new RoomPersistenceCoordinator();
  const transitions: TransitionRoomGameStatusInput[] = [];
  const timeoutRemovals: PlayerId[] = [];
  const departures: PlayerId[] = [];
  let commands!: RoomPersistenceCommands;
  let activationInput: TransitionRoomGameStatusInput | undefined;
  const harness = createHarness({
    startGame: false,
    persistenceCommandsFactory: (rooms, roomCode, hostPlayerId) => {
      coordinator.registerCreatedRoom({
        roomCode,
        roomId: randomUUID(),
        gameMode: "impostor-classic",
        hostPlayerId,
        lifecycleStatus: "active",
        currentGameId: null,
        version: "1",
      });
      commands = new RoomPersistenceCommands(
        rooms,
        {
          async createRoomWithHost(
            _input: CreateRoomWithHostInput,
          ): Promise<CreatedRoomInfo> {
            throw new Error("Unexpected room creation.");
          },
          async joinRoom(_input: JoinRoomInput): Promise<JoinedRoomInfo> {
            throw new Error("Unexpected room join.");
          },
          async leaveRoom(input) {
            departures.push(input.playerId);
            const metadata = coordinator.getMetadata(input.roomCode);
            assert.ok(metadata);
            return {
              roomId: metadata.roomId,
              roomCode: input.roomCode,
              playerId: input.playerId,
              deleted: false as const,
              hostChanged: false,
              lifecycleStatus: "active" as const,
              currentGameId: metadata.currentGameId,
              version: (BigInt(input.expectedVersion!) + 1n).toString(),
            };
          },
          async removeDisconnectedPlayer(input) {
            timeoutRemovals.push(input.playerId);
            const metadata = coordinator.getMetadata(input.roomCode);
            assert.ok(metadata);
            return {
              status: "removed" as const,
              roomId: metadata.roomId,
              roomCode: input.roomCode,
              playerId: input.playerId,
              deleted: false as const,
              lifecycleStatus: "active" as const,
              currentGameId: metadata.currentGameId,
              version: (BigInt(input.expectedVersion!) + 1n).toString(),
            };
          },
          async transitionRoomGameStatus(input) {
            transitions.push(input);
            if (input.nextStatus === "in_progress") {
              activationInput = input;
              activationEntered.resolve();
              return finishActivation.promise;
            }
            if (input.nextStatus === "finished") {
              completionEntered.resolve();
              return finishCompletion.promise;
            }
            return createTransitionResult(
              input,
              (BigInt(input.expectedVersion) + 1n).toString(),
            );
          },
        },
        coordinator,
      );
      return commands;
    },
  });
  return {
    harness,
    commands,
    coordinator,
    transitions,
    timeoutRemovals,
    departures,
    activationEntered: activationEntered.promise,
    finishActivation,
    completionEntered: completionEntered.promise,
    finishCompletion,
    get activationInput() {
      return activationInput;
    },
  };
}

async function commitDurableStart(
  fixture: ReturnType<typeof createDurableActivationFixture>,
): Promise<void> {
  const { harness, commands } = fixture;
  const reservation = await commands.acquireGameStatusReservation(
    harness.roomCode,
    "waiting",
    null,
    harness.hostSocketId,
  );
  try {
    const prepared = harness.service.prepareStart(
      harness.roomCode,
      harness.hostSocketId,
    );
    await commands.transitionRoomGameStatus({
      roomCode: harness.roomCode,
      expectedStatus: "waiting",
      nextStatus: "starting",
      expectedCurrentGameId: null,
      nextGameId: prepared.gameId,
      initiatedBy: {
        kind: "host",
        playerId: reservation.hostPlayerId!,
      },
      reservation,
    });
    harness.service.commitPreparedStart(prepared, reservation);
  } finally {
    harness.rooms.releaseGameStatusReservation(reservation);
  }
}

function disconnectPlayerForDurableTimeout(
  harness: GameHarness,
  playerIndex: number,
): { playerId: PlayerId; deadline: Date } {
  const playerId = harness.playerIds[playerIndex];
  const socketId = harness.socketIds[playerIndex];
  assert.ok(playerId);
  assert.ok(socketId);
  const prepared = harness.rooms.prepareSocketDisconnect(socketId);
  assert.ok(prepared);
  const deadline = new Date(Date.parse("2025-01-01T00:01:00.000Z"));
  harness.rooms.commitPreparedSocketDisconnect(prepared, {
    disconnectGeneration: "1",
    reconnectDeadlineAt: deadline,
  });
  return { playerId, deadline };
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

function disconnectPlayer(harness: GameHarness, playerId: PlayerId): void {
  const index = harness.playerIds.indexOf(playerId);
  assert.notEqual(index, -1);
  const socketId = harness.socketIds[index];
  assert.ok(socketId);
  assert.ok(harness.rooms.disconnectSocket(socketId));
  harness.socketIds[index] = undefined;
  harness.service.onPlayerConnectionChanged(harness.roomCode);
}

function reconnectPlayer(harness: GameHarness, playerId: PlayerId): void {
  const index = harness.playerIds.indexOf(playerId);
  assert.notEqual(index, -1);
  const reconnectToken = harness.reconnectTokens[index];
  assert.ok(reconnectToken);
  const socketId = `reconnected-${index}-${harness.reconnectCounts[index]}`;
  harness.reconnectCounts[index] = (harness.reconnectCounts[index] ?? 0) + 1;
  harness.rooms.reconnect(
    { roomCode: harness.roomCode, playerId, reconnectToken },
    socketId,
  );
  harness.socketIds[index] = socketId;
  harness.service.onPlayerConnectionChanged(harness.roomCode);
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

test("suspension blocks Classic actions and stale role-reveal callbacks", () => {
  const harness = createHarness();
  const scope = harness.rooms.getGameplaySuspensionScope(
    harness.roomCode,
    harness.sessionId,
  );
  assert.ok(scope);
  const staleCallback = harness.runtime.latestScheduledCallback;

  harness.rooms.suspendGameplay(
    harness.roomCode,
    scope,
    "durable_timeout_post_commit_side_effect_failure",
  );

  assert.throws(
    () => harness.service.requestRole(
      harness.roomCode,
      harness.sessionId,
      harness.playerIds[0]!,
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  staleCallback?.();
  assert.equal(harness.events.discussions.length, 0);
  assert.equal(harness.runtime.pendingTimerCount, 0);
  assert.equal(
    harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!),
    undefined,
  );
});

test("suspending one Classic room leaves another room's actions and timers active", () => {
  const harness = createHarness();
  const otherHost = harness.rooms.createRoom(
    {
      nickname: "Other host",
      settings: {
        gameMode: "impostor-classic",
        maxPlayers: 10,
        isPrivate: false,
        classicImpostor: GAME_SETTINGS,
      },
    },
    "other-host",
  );
  const otherPlayerIds = [otherHost.playerId];
  for (let index = 1; index < 4; index += 1) {
    const joined = harness.rooms.joinRoom(
      { roomCode: otherHost.room.code, nickname: `Other ${index}` },
      `other-${index}`,
    );
    otherPlayerIds.push(joined.playerId);
  }
  const otherGame = harness.service.startGame(otherHost.room.code, "other-host");
  const otherRoles = new Map(
    otherPlayerIds.map((playerId) => [
      playerId,
      harness.service.requestRole(otherHost.room.code, otherGame.id, playerId).role,
    ]),
  );
  const otherImpostor = otherPlayerIds.find(
    (playerId) => otherRoles.get(playerId) === "impostor",
  );
  assert.ok(otherImpostor);
  const otherCivilian = otherPlayerIds.find(
    (playerId) => playerId !== otherImpostor,
  );
  assert.ok(otherCivilian);
  const scope = harness.rooms.getGameplaySuspensionScope(
    harness.roomCode,
    harness.sessionId,
  );
  assert.ok(scope);
  harness.rooms.suspendGameplay(
    harness.roomCode,
    scope,
    "durable_timeout_post_commit_side_effect_failure",
  );

  assert.throws(
    () => harness.service.requestRole(
      harness.roomCode,
      harness.sessionId,
      harness.playerIds[0]!,
    ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);

  assert.equal(
    harness.service.getResumeSnapshot(otherHost.room.code, otherHost.playerId)
      ?.state.state.phase,
    "discussion",
  );
  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  for (const voterId of otherPlayerIds) {
    harness.service.submitVote(
      otherHost.room.code,
      voterId,
      voterId === otherImpostor ? otherCivilian : otherImpostor,
    );
  }
  assert.equal(harness.events.ended.at(-1)?.result.outcome, "win");
  assert.equal(harness.rooms.getPublicRoom(otherHost.room.code)?.gameStatus, "finished");
  assert.equal(
    harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!),
    undefined,
  );
});

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
        {
          roomCode: harness.roomCode,
          settings: {
            gameMode: "impostor-classic",
            maxPlayers: room.settings.maxPlayers,
            isPrivate: room.settings.isPrivate,
            classicImpostor: GAME_SETTINGS,
          },
        },
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

test("Classic start preparation is immutable and has no committed side effects", () => {
  const harness = createHarness({ startGame: false });
  const prepared = harness.service.prepareStart(
    harness.roomCode,
    harness.hostSocketId,
  );

  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(
    Reflect.set(prepared, "gameId", "mutated-game-id"),
    false,
  );
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "waiting");
  assert.equal(harness.events.started.length, 0);
  assert.equal(harness.runtime.pendingTimerCount, 0);
  assert.throws(
    () =>
      harness.service.requestRole(
        harness.roomCode,
        prepared.gameId,
        harness.playerIds[0]!,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );

  const started = harness.service.commitPreparedStart(prepared);
  assert.equal(started.id, prepared.gameId);
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "starting");
  assert.equal(harness.events.started.length, 1);
  assert.equal(harness.runtime.pendingTimerCount, 1);
  assert.throws(
    () => harness.service.commitPreparedStart(prepared),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  harness.service.close();
});

test("durable Classic activation waits for persistence before discussion", async () => {
  const fixture = createDurableActivationFixture();
  const { harness } = fixture;
  await commitDurableStart(fixture);

  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  await fixture.activationEntered;
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
    "starting",
  );
  assert.equal(
    harness.service.getResumeSnapshot(
      harness.roomCode,
      harness.playerIds[0]!,
    )?.started.session.status,
    "starting",
  );
  assert.equal(
    harness.events.started[0]?.session.state.phase,
    "role_reveal",
  );
  assert.equal(harness.events.discussions.length, 0);

  assert.ok(fixture.activationInput);
  fixture.finishActivation.resolve(
    createTransitionResult(
      fixture.activationInput,
      (BigInt(fixture.activationInput.expectedVersion) + 1n).toString(),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
    "in_progress",
  );
  assert.equal(
    harness.service.getResumeSnapshot(
      harness.roomCode,
      harness.playerIds[0]!,
    )?.started.session.status,
    "in_progress",
  );
  assert.equal(harness.events.discussions.length, 1);
  harness.service.close();
});

test("durable Classic cancellation persists before finish events and supports a rematch after lobby return", async () => {
  const fixture = createDurableActivationFixture();
  const { harness } = fixture;
  await commitDurableStart(fixture);
  const gameId = harness.events.started[0]!.session.id;
  const game = (Reflect.get(harness.service, "currentGames") as Map<
    RoomCode,
    object
  >).get(harness.roomCode);
  assert.ok(game);

  const finish = Reflect.get(harness.service, "finishGame");
  const pendingFinish = Reflect.apply(
    finish,
    harness.service,
    [game, "cancelled", []],
  ) as Promise<void>;
  const duplicateFinish = Reflect.apply(
    finish,
    harness.service,
    [game, "cancelled", []],
  ) as Promise<void>;
  assert.equal(duplicateFinish, pendingFinish);
  await fixture.completionEntered;

  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "starting");
  assert.equal(harness.events.ended.length, 0);
  assert.equal(
    fixture.transitions.at(-1)?.expectedCurrentGameId,
    gameId,
  );
  assert.equal(fixture.transitions.at(-1)?.nextStatus, "finished");

  assert.ok(fixture.transitions.at(-1));
  fixture.finishCompletion.resolve(
    createTransitionResult(
      fixture.transitions.at(-1)!,
      (BigInt(fixture.transitions.at(-1)!.expectedVersion) + 1n).toString(),
    ),
  );
  await pendingFinish;
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "finished");
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.currentGameId,
    gameId,
  );
  assert.equal(harness.events.ended.length, 1);

  const lobby = await harness.service.returnToLobbyPersisted(
    harness.roomCode,
    harness.hostSocketId,
  );
  assert.equal(lobby.gameStatus, "waiting");
  assert.equal(lobby.currentGameId, undefined);
  assert.equal(fixture.transitions.at(-1)?.expectedStatus, "finished");
  assert.equal(fixture.transitions.at(-1)?.nextStatus, "waiting");

  await commitDurableStart(fixture);
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "starting");
  assert.notEqual(harness.events.started.at(-1)?.session.id, gameId);
  harness.service.close();
});

test("uncertain durable Classic completion remains fenced without publishing a finish", async () => {
  const fixture = createDurableActivationFixture();
  const { harness, coordinator } = fixture;
  await commitDurableStart(fixture);
  const game = (Reflect.get(harness.service, "currentGames") as Map<
    RoomCode,
    object
  >).get(harness.roomCode);
  assert.ok(game);

  const pendingFinish = Reflect.apply(
    Reflect.get(harness.service, "finishGame"),
    harness.service,
    [game, "cancelled", []],
  ) as Promise<void>;
  await fixture.completionEntered;
  fixture.finishCompletion.reject(new Error("uncertain finish commit"));
  await assert.rejects(pendingFinish);

  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "starting");
  assert.equal(harness.events.ended.length, 0);
  assert.equal(coordinator.isFenced(harness.roomCode), true);
  assert.throws(
    () => harness.rooms.assertRoomNotReserved(harness.roomCode),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNKNOWN",
  );
  harness.service.close();
});

test("Classic completion reservation blocks departure and orders timeout removal after finish", async () => {
  const fixture = createDurableActivationFixture();
  const { harness, commands, timeoutRemovals, departures } = fixture;
  await commitDurableStart(fixture);
  const gameId = harness.events.started[0]!.session.id;
  const timedOut = disconnectPlayerForDurableTimeout(harness, 3);
  const game = (Reflect.get(harness.service, "currentGames") as Map<
    RoomCode,
    object
  >).get(harness.roomCode);
  assert.ok(game);

  const finish = Reflect.get(harness.service, "finishGame");
  const pendingFinish = Reflect.apply(
    finish,
    harness.service,
    [game, "cancelled", []],
  ) as Promise<void>;
  await fixture.completionEntered;

  assert.throws(
    () => harness.rooms.leaveRoom(harness.roomCode, harness.socketIds[1]!),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  let departureSettled = false;
  const departure = commands.leaveRoom(
    harness.roomCode,
    harness.socketIds[1]!,
  ).then(
    (result) => {
      departureSettled = true;
      return { result };
    },
    (error: unknown) => {
      departureSettled = true;
      return { error };
    },
  );
  await Promise.resolve();
  assert.equal(departureSettled, false);
  let timeoutSettled = false;
  const pendingRemoval = commands.removeDisconnectedPlayer(
    harness.roomCode,
    timedOut.playerId,
    "1",
    timedOut.deadline,
    new Date(timedOut.deadline.getTime() + 1),
  ).then((result) => {
    timeoutSettled = true;
    return result;
  });
  await Promise.resolve();
  assert.equal(timeoutSettled, false);
  assert.ok(
    harness.rooms.getPublicRoom(harness.roomCode)?.players.some(
      (player) => player.id === timedOut.playerId,
    ),
  );

  fixture.finishCompletion.resolve(
    createTransitionResult(
      fixture.transitions.at(-1)!,
      (BigInt(fixture.transitions.at(-1)!.expectedVersion) + 1n).toString(),
    ),
  );
  await pendingFinish;
  const departureResult = await departure;
  if ("error" in departureResult) {
    assert.ok(
      departureResult.error instanceof AppError
      && departureResult.error.code === "GAME_NOT_ACTIVE",
    );
    assert.ok(
      harness.rooms.getPublicRoom(harness.roomCode)?.players.some(
        (player) => player.id === harness.playerIds[1],
      ),
    );
    assert.deepEqual(departures, []);
  } else {
    assert.equal(departureResult.result.playerId, harness.playerIds[1]);
    assert.deepEqual(departures, [harness.playerIds[1]]);
  }
  const removal = await pendingRemoval;
  assert.ok(removal);
  assert.deepEqual(timeoutRemovals, [timedOut.playerId]);
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.players.some(
      (player) => player.id === timedOut.playerId,
    ),
    false,
  );
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "finished");
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.currentGameId, gameId);
  assert.equal(harness.events.ended.length, 1);
  harness.service.close();
});

test("discarding a prepared Classic start removes its uncommitted plan", () => {
  const harness = createHarness({ startGame: false });
  const prepared = harness.service.prepareStart(
    harness.roomCode,
    harness.hostSocketId,
  );
  harness.service.discardPreparedStart(prepared);

  assert.throws(
    () => harness.service.commitPreparedStart(prepared),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "waiting");
  assert.equal(harness.events.started.length, 0);
  assert.equal(Reflect.get(harness.service, "currentGames").size, 0);
  harness.service.close();
});

test("Classic timer setup failure emits no start event", () => {
  const harness = createHarness({ startGame: false });
  harness.runtime.schedule = () => {
    throw new Error("timer setup failed");
  };

  assert.throws(
    () => harness.service.startGame(harness.roomCode, harness.hostSocketId),
    /timer setup failed/,
  );
  assert.equal(harness.events.started.length, 0);
  assert.equal(harness.runtime.pendingTimerCount, 0);
  assert.equal(Reflect.get(harness.service, "currentGames").size, 0);
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "waiting");
  harness.service.close();
});

test("uncertain durable Classic activation remains starting and fences the room", async () => {
  const fixture = createDurableActivationFixture();
  const { harness } = fixture;
  await commitDurableStart(fixture);

  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  await fixture.activationEntered;
  fixture.finishActivation.reject(new Error("connection lost after commit"));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
    "starting",
  );
  assert.equal(harness.events.discussions.length, 0);
  assert.throws(
    () => harness.rooms.assertRoomNotReserved(harness.roomCode),
    (error: unknown) =>
      error instanceof AppError && error.code === "UNKNOWN",
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

test("maximum Classic impostor counts are accepted and always leave a civilian", () => {
  for (let playerCount = 3; playerCount <= 8; playerCount += 1) {
    const maximumImpostors = Math.floor((playerCount - 1) / 2);
    const validGame = createHarness({
      playerCount,
      impostorCount: maximumImpostors,
    });
    const roles = getRoles(validGame);
    assert.equal(
      [...roles.values()].filter((role) => role === "impostor").length,
      maximumImpostors,
    );
    assert.ok([...roles.values()].includes("player"));
    validGame.service.close();

    const invalidGame = createHarness({
      playerCount,
      impostorCount: maximumImpostors + 1,
      startGame: false,
    });
    assert.throws(
      () =>
        invalidGame.service.startGame(
          invalidGame.roomCode,
          invalidGame.hostSocketId,
        ),
      (error: unknown) =>
        error instanceof AppError && error.code === "GAME_NOT_READY",
    );
    invalidGame.service.close();
  }
});

test("role reveal transitions to discussion and then server-timed voting", () => {
  const harness = createHarness();
  assert.equal(harness.runtime.pendingTimerCount, 1);
  const roleRevealEndsAt = getRoleRevealDeadline(
    harness.events.started[0]?.session.state,
  );
  assert.ok(roleRevealEndsAt);

  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "in_progress");
  assert.equal(harness.events.states.at(-1)?.state.phase, "discussion");
  const discussion = harness.events.discussions.at(-1);
  assert.equal(discussion?.startsAt, roleRevealEndsAt);
  assert.equal(
    discussion?.endsAt,
    new Date(
      Date.parse(roleRevealEndsAt) +
        GAME_SETTINGS.discussionDurationSeconds * 1_000,
    ).toISOString(),
  );
  const discussionEndsAt = discussion?.endsAt;
  assert.ok(discussionEndsAt);
  assert.equal(harness.runtime.pendingTimerCount, 1);

  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  const votingState = harness.events.states.at(-1)?.state;
  assert.equal(votingState?.phase, "voting");
  assert.equal(
    votingState?.votingEndsAt,
    new Date(
      Date.parse(discussionEndsAt) +
        GAME_SETTINGS.votingDurationSeconds * 1_000,
    ).toISOString(),
  );
  assert.equal(harness.runtime.pendingTimerCount, 1);
  harness.service.close();
  assert.equal(harness.runtime.pendingTimerCount, 0);
});

test("delayed role reveal keeps discussion and initial voting deadlines anchored", () => {
  const harness = createHarness();
  const roleRevealEndsAt = getRoleRevealDeadline(
    harness.events.started[0]?.session.state,
  );
  assert.ok(roleRevealEndsAt);

  harness.runtime.advanceWithoutRunningTimers(
    ROLE_REVEAL_DURATION_SECONDS * 1_000 + 5_000,
  );
  harness.runtime.runNextDueTimer();

  const discussion = harness.events.discussions.at(-1);
  assert.equal(discussion?.startsAt, roleRevealEndsAt);
  assert.equal(
    discussion?.endsAt,
    new Date(
      Date.parse(roleRevealEndsAt) +
        GAME_SETTINGS.discussionDurationSeconds * 1_000,
    ).toISOString(),
  );
  assert.equal(harness.events.states.at(-1)?.state.phase, "discussion");

  const remainingDiscussionMs =
    Date.parse(discussion!.endsAt) - harness.runtime.now().getTime();
  assert.ok(remainingDiscussionMs > 0);
  harness.runtime.advance(remainingDiscussionMs);
  const votingState = harness.events.states.at(-1)?.state;
  assert.equal(votingState?.phase, "voting");
  assert.equal(
    votingState?.votingEndsAt,
    new Date(
      Date.parse(discussion!.endsAt) +
        GAME_SETTINGS.votingDurationSeconds * 1_000,
    ).toISOString(),
  );
  harness.service.close();
});

test("late role reveal skips expired discussion instead of exposing it", () => {
  const harness = createHarness();
  const roleRevealEndsAt = getRoleRevealDeadline(
    harness.events.started[0]?.session.state,
  );
  assert.ok(roleRevealEndsAt);
  const discussionEndsAt =
    Date.parse(roleRevealEndsAt) +
    GAME_SETTINGS.discussionDurationSeconds * 1_000;

  harness.runtime.advanceWithoutRunningTimers(
    ROLE_REVEAL_DURATION_SECONDS * 1_000 +
      GAME_SETTINGS.discussionDurationSeconds * 1_000 +
      2_000,
  );
  harness.runtime.runNextDueTimer();

  assert.equal(harness.events.discussions.length, 0);
  assert.equal(harness.events.states.at(-1)?.state.phase, "voting");
  assert.equal(
    harness.events.states.at(-1)?.state.votingEndsAt,
    new Date(
      discussionEndsAt + GAME_SETTINGS.votingDurationSeconds * 1_000,
    ).toISOString(),
  );
  harness.service.close();
});

test("late role reveal immediately expires an already-overdue initial vote", () => {
  const harness = createHarness();
  const roleRevealEndsAt = getRoleRevealDeadline(
    harness.events.started[0]?.session.state,
  );
  assert.ok(roleRevealEndsAt);
  const discussionEndsAt =
    Date.parse(roleRevealEndsAt) +
    GAME_SETTINGS.discussionDurationSeconds * 1_000;
  const votingEndsAt =
    discussionEndsAt + GAME_SETTINGS.votingDurationSeconds * 1_000;

  harness.runtime.advanceWithoutRunningTimers(
    ROLE_REVEAL_DURATION_SECONDS * 1_000 +
      GAME_SETTINGS.discussionDurationSeconds * 1_000 +
      GAME_SETTINGS.votingDurationSeconds * 1_000 +
      1_000,
  );
  harness.runtime.runNextDueTimer();

  const phaseSequence = harness.events.states.map((update) => update.state.phase);
  assert.deepEqual(phaseSequence, ["voting", "discussion"]);
  assert.equal(
    harness.events.states[0]?.state.votingEndsAt,
    new Date(votingEndsAt).toISOString(),
  );
  assert.equal(harness.events.votes.length, 1);
  assert.equal(harness.events.votes[0]?.eliminatedPlayerId, null);
  assert.deepEqual(harness.events.votes[0]?.tiedPlayerIds, []);
  assert.equal(harness.runtime.pendingTimerCount, 1);
  harness.service.close();
});

test("delayed discussion callback preserves the absolute initial voting deadline", () => {
  const harness = createHarness();
  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  const discussionEndsAt = harness.events.discussions.at(-1)?.endsAt;
  assert.ok(discussionEndsAt);

  harness.runtime.advanceWithoutRunningTimers(
    GAME_SETTINGS.discussionDurationSeconds * 1_000 + 2_000,
  );
  const discussionCallback = harness.runtime.runNextDueTimer();
  const votingState = harness.events.states.at(-1)?.state;
  assert.equal(votingState?.phase, "voting");
  assert.equal(
    votingState?.votingEndsAt,
    new Date(
      Date.parse(discussionEndsAt) +
        GAME_SETTINGS.votingDurationSeconds * 1_000,
    ).toISOString(),
  );
  assert.equal(
    Date.parse(votingState!.votingEndsAt!) - harness.runtime.now().getTime(),
    (GAME_SETTINGS.votingDurationSeconds - 2) * 1_000,
  );

  const statesBeforeDuplicate = harness.events.states.length;
  discussionCallback();
  assert.equal(harness.events.states.length, statesBeforeDuplicate);
  assert.equal(harness.events.votes.length, 0);
  harness.service.close();
});

test("delayed discussion callback immediately resolves an overdue initial vote", () => {
  const harness = createHarness();
  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  const discussionEndsAt = harness.events.discussions.at(-1)?.endsAt;
  assert.ok(discussionEndsAt);
  const votingEndsAt =
    Date.parse(discussionEndsAt) +
    GAME_SETTINGS.votingDurationSeconds * 1_000;

  harness.runtime.advanceWithoutRunningTimers(
    GAME_SETTINGS.discussionDurationSeconds * 1_000 +
      GAME_SETTINGS.votingDurationSeconds * 1_000 +
      1_000,
  );
  harness.runtime.runNextDueTimer();

  assert.deepEqual(
    harness.events.states.map((update) => update.state.phase),
    ["discussion", "voting", "discussion"],
  );
  assert.equal(
    harness.events.states[1]?.state.votingEndsAt,
    new Date(votingEndsAt).toISOString(),
  );
  assert.equal(harness.events.votes.length, 1);
  assert.deepEqual(harness.events.votes[0]?.tiedPlayerIds, []);
  assert.equal(
    harness.events.discussions.at(-1)?.startsAt,
    harness.runtime.now().toISOString(),
  );
  harness.service.close();
});

test("repeated role and discussion callbacks do not advance either phase twice", () => {
  const harness = createHarness();
  const roleCallback = harness.runtime.latestScheduledCallback;
  assert.ok(roleCallback);
  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  roleCallback();
  assert.equal(harness.events.discussions.length, 1);

  const discussionCallback = harness.runtime.latestScheduledCallback;
  assert.ok(discussionCallback);
  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  discussionCallback();
  const votingStateCount = harness.events.states.filter(
    (update) => update.state.phase === "voting",
  ).length;
  discussionCallback();

  assert.equal(harness.events.discussions.length, 1);
  assert.equal(
    harness.events.states.filter((update) => update.state.phase === "voting")
      .length,
    votingStateCount,
  );
  assert.equal(votingStateCount, 1);
  harness.service.close();
});

test("an old role reveal callback cannot advance a rematch", () => {
  const harness = createHarness();
  const staleCallback = harness.runtime.latestScheduledCallback;
  assert.ok(staleCallback);

  harness.service.onPlayerRemoved(harness.roomCode, true);
  harness.service.returnToLobby(harness.roomCode, harness.hostSocketId);
  const rematch = harness.service.startGame(
    harness.roomCode,
    harness.hostSocketId,
  );
  const stateCount = harness.events.states.length;
  const discussionCount = harness.events.discussions.length;

  staleCallback();

  assert.notEqual(rematch.id, harness.sessionId);
  assert.equal(harness.events.states.length, stateCount);
  assert.equal(harness.events.discussions.length, discussionCount);
  assert.equal(
    harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!)
      ?.state.state.phase,
    "role_reveal",
  );
  assert.equal(harness.runtime.pendingTimerCount, 1);
  harness.service.close();
});

test("reconnect preserves role reveal and discussion deadlines", () => {
  const harness = createHarness();
  const playerId = harness.playerIds[1];
  assert.ok(playerId);
  const roleRevealEndsAt = getRoleRevealDeadline(
    harness.service.getResumeSnapshot(harness.roomCode, playerId)?.state.state,
  );
  assert.ok(roleRevealEndsAt);

  disconnectPlayer(harness, playerId);
  reconnectPlayer(harness, playerId);
  assert.equal(
    getRoleRevealDeadline(
      harness.service.getResumeSnapshot(harness.roomCode, playerId)?.state.state,
    ),
    roleRevealEndsAt,
  );

  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  const discussionEndsAt = getDiscussionDeadline(
    harness.service.getResumeSnapshot(harness.roomCode, playerId)?.state.state,
  );
  assert.ok(discussionEndsAt);
  disconnectPlayer(harness, playerId);
  reconnectPlayer(harness, playerId);
  assert.equal(
    getDiscussionDeadline(
      harness.service.getResumeSnapshot(harness.roomCode, playerId)?.state.state,
    ),
    discussionEndsAt,
  );
  harness.service.close();
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
  const votingState = harness.events.states.at(-1)?.state;
  assert.ok(votingState?.phase === "voting");
  assert.ok(votingState.votingEndsAt);
  harness.runtime.advanceWithoutRunningTimers(
    Date.parse(votingState.votingEndsAt) -
      harness.runtime.now().getTime() -
      1,
  );
  assert.throws(
    () => harness.service.submitVote(harness.roomCode, voterId, targetPlayerId),
    (error: unknown) =>
      error instanceof AppError && error.code === "DUPLICATE_VOTE",
  );
  harness.service.close();
});

test("votes preserve pre-deadline ballots and reject submissions at the deadline", () => {
  const harness = createHarness();
  enterVoting(harness);
  const roles = getRoles(harness);
  const target = harness.playerIds.find(
    (playerId) => roles.get(playerId) === "player",
  );
  const voter = harness.playerIds.find((playerId) => playerId !== target);
  const lateVoter = harness.playerIds.find(
    (playerId) => playerId !== target && playerId !== voter,
  );
  const votingState = harness.events.states.at(-1)?.state;
  assert.ok(votingState?.phase === "voting");
  assert.ok(target);
  assert.ok(voter);
  assert.ok(lateVoter);
  const votingEndsAt = votingState.votingEndsAt;
  assert.ok(votingEndsAt);
  const votingTimer = harness.runtime.latestScheduledCallback;
  assert.ok(votingTimer);

  harness.runtime.advanceWithoutRunningTimers(
    Date.parse(votingEndsAt) - harness.runtime.now().getTime() - 1,
  );
  harness.service.submitVote(
    harness.roomCode,
    voter,
    target,
    harness.sessionId,
    votingEndsAt,
  );
  assert.equal(harness.events.states.at(-1)?.state.votesSubmitted, 1);

  harness.runtime.advanceWithoutRunningTimers(1);
  assert.throws(
    () =>
      harness.service.submitVote(
        harness.roomCode,
        lateVoter,
        target,
        harness.sessionId,
        votingEndsAt,
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "GAME_NOT_ACTIVE" &&
      error.message === "Voting is not currently active.",
  );
  assert.equal(harness.events.votes.length, 1);
  assert.equal(harness.events.states.at(-1)?.state.phase, "discussion");
  assert.deepEqual(
    harness.service.getHistory(harness.sessionId)?.voting[0]?.votes,
    [{ voterId: voter, targetPlayerId: target }],
  );

  const discussionTimerCount = harness.runtime.pendingTimerCount;
  votingTimer();
  assert.equal(harness.events.votes.length, 1);
  assert.equal(harness.runtime.pendingTimerCount, discussionTimerCount);
  harness.service.close();
});

test("duplicate votes at the deadline resolve overdue voting once and preserve the ballot", () => {
  const harness = createHarness();
  enterVoting(harness);
  const roles = getRoles(harness);
  const target = harness.playerIds.find(
    (playerId) => roles.get(playerId) === "player",
  );
  const voter = harness.playerIds.find((playerId) => playerId !== target);
  const votingState = harness.events.states.at(-1)?.state;
  assert.ok(votingState?.phase === "voting");
  assert.ok(votingState.votingEndsAt);
  assert.ok(votingState.votingPhaseId);
  assert.ok(target);
  assert.ok(voter);
  const votingEndsAt = votingState.votingEndsAt;
  const votingPhaseId = votingState.votingPhaseId;
  const votingTimer = harness.runtime.latestScheduledCallback;
  assert.ok(votingTimer);

  harness.runtime.advanceWithoutRunningTimers(
    Date.parse(votingEndsAt) - harness.runtime.now().getTime() - 1,
  );
  harness.service.submitVote(
    harness.roomCode,
    voter,
    target,
    harness.sessionId,
    votingEndsAt,
    votingPhaseId,
  );
  harness.runtime.advanceWithoutRunningTimers(1);

  assert.throws(
    () =>
      harness.service.submitVote(
        harness.roomCode,
        voter,
        target,
        harness.sessionId,
        votingEndsAt,
        votingPhaseId,
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "GAME_NOT_ACTIVE" &&
      error.message === "Voting is not currently active.",
  );

  const history = harness.service.getHistory(harness.sessionId);
  assert.equal(harness.events.votes.length, 1);
  assert.equal(history?.voting.length, 1);
  assert.deepEqual(history?.voting[0]?.votes, [{ voterId: voter, targetPlayerId: target }]);
  assert.equal(harness.events.states.at(-1)?.state.phase, "discussion");
  const timerCountAfterResolution = harness.runtime.pendingTimerCount;
  votingTimer();
  assert.equal(harness.events.votes.length, 1);
  assert.equal(harness.service.getHistory(harness.sessionId)?.voting.length, 1);
  assert.equal(harness.runtime.pendingTimerCount, timerCountAfterResolution);
  harness.service.close();
});

test("late votes remain rejected when the timeout callback wins the race", () => {
  const harness = createHarness();
  enterVoting(harness);
  const voter = harness.playerIds[0];
  const target = harness.playerIds[1];
  const votingState = harness.events.states.at(-1)?.state;
  assert.ok(votingState?.phase === "voting");
  assert.ok(voter);
  assert.ok(target);
  const votingEndsAt = votingState.votingEndsAt;
  assert.ok(votingEndsAt);
  const votingTimer = harness.runtime.latestScheduledCallback;
  assert.ok(votingTimer);

  harness.runtime.advanceWithoutRunningTimers(
    Date.parse(votingEndsAt) - harness.runtime.now().getTime() + 1,
  );
  votingTimer();
  assert.equal(harness.events.votes.length, 1);
  assert.throws(
    () =>
      harness.service.submitVote(
        harness.roomCode,
        voter,
        target,
        harness.sessionId,
        votingEndsAt,
      ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "GAME_NOT_ACTIVE" &&
      error.message === "Voting is not currently active.",
  );
  votingTimer();
  assert.equal(harness.events.votes.length, 1);
  harness.service.close();
});

test("connection changes refresh voter eligibility without resetting votes or deadlines", () => {
  const harness = createHarness();
  const disconnectedPlayer = harness.playerIds[3];
  const firstVoter = harness.playerIds[0];
  const secondVoter = harness.playerIds[1];
  assert.ok(disconnectedPlayer);
  assert.ok(firstVoter);
  assert.ok(secondVoter);

  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  const discussionDeadline = harness.events.states.at(-1)?.state.discussionEndsAt;
  assert.ok(discussionDeadline);
  disconnectPlayer(harness, disconnectedPlayer);
  assert.equal(harness.events.states.at(-1)?.state.eligibleVoters, 3);
  assert.equal(
    harness.events.states.at(-1)?.state.discussionEndsAt,
    discussionDeadline,
  );
  assert.equal(harness.events.ended.length, 0);

  reconnectPlayer(harness, disconnectedPlayer);
  assert.equal(harness.events.states.at(-1)?.state.eligibleVoters, 4);
  assert.equal(
    harness.events.states.at(-1)?.state.discussionEndsAt,
    discussionDeadline,
  );

  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  const votingDeadline = harness.events.states.at(-1)?.state.votingEndsAt;
  assert.ok(votingDeadline);
  disconnectPlayer(harness, disconnectedPlayer);
  assert.equal(harness.events.states.at(-1)?.state.eligibleVoters, 3);
  assert.equal(
    harness.events.states.at(-1)?.state.votingEndsAt,
    votingDeadline,
  );
  assert.throws(
    () =>
      harness.service.submitVote(
        harness.roomCode,
        disconnectedPlayer,
        firstVoter,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );

  harness.service.submitVote(
    harness.roomCode,
    firstVoter,
    disconnectedPlayer,
  );
  harness.service.submitVote(
    harness.roomCode,
    secondVoter,
    disconnectedPlayer,
  );
  assert.equal(harness.events.states.at(-1)?.state.votesSubmitted, 2);

  disconnectPlayer(harness, secondVoter);
  assert.equal(harness.events.states.at(-1)?.state.eligibleVoters, 2);
  assert.equal(harness.events.states.at(-1)?.state.votesSubmitted, 1);
  reconnectPlayer(harness, secondVoter);
  assert.equal(harness.events.states.at(-1)?.state.eligibleVoters, 3);
  assert.equal(harness.events.states.at(-1)?.state.votesSubmitted, 2);
  assert.equal(
    harness.events.states.at(-1)?.state.votingEndsAt,
    votingDeadline,
  );
  assert.throws(
    () =>
      harness.service.submitVote(
        harness.roomCode,
        secondVoter,
        disconnectedPlayer,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "DUPLICATE_VOTE",
  );

  reconnectPlayer(harness, disconnectedPlayer);
  assert.equal(harness.events.states.at(-1)?.state.eligibleVoters, 4);
  harness.service.submitVote(
    harness.roomCode,
    disconnectedPlayer,
    firstVoter,
  );
  assert.equal(harness.events.ended.length, 0);
  harness.service.close();
});

test("all temporarily disconnected players do not cancel voting", () => {
  const harness = createHarness();
  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  for (const playerId of harness.playerIds) {
    disconnectPlayer(harness, playerId);
  }

  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  assert.equal(harness.events.states.at(-1)?.state.phase, "voting");
  assert.equal(harness.events.states.at(-1)?.state.eligibleVoters, 0);
  assert.equal(harness.events.ended.length, 0);
  assert.equal(harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus, "in_progress");

  const reconnectedPlayer = harness.playerIds[0];
  assert.ok(reconnectedPlayer);
  const votingDeadline = harness.events.states.at(-1)?.state.votingEndsAt;
  reconnectPlayer(harness, reconnectedPlayer);
  assert.equal(harness.events.states.at(-1)?.state.eligibleVoters, 1);
  assert.equal(
    harness.events.states.at(-1)?.state.votingEndsAt,
    votingDeadline,
  );
  assert.equal(harness.events.ended.length, 0);
  harness.service.close();
});

test("eliminated players cannot vote after reconnecting", () => {
  const harness = createHarness();
  const roles = getRoles(harness);
  const eliminatedPlayer = harness.playerIds.find(
    (playerId) => roles.get(playerId) === "player",
  );
  const alternateTarget = harness.playerIds.find(
    (playerId) => playerId !== eliminatedPlayer,
  );
  assert.ok(eliminatedPlayer);
  assert.ok(alternateTarget);

  enterVoting(harness);
  submitVotesForTarget(harness, eliminatedPlayer, alternateTarget);
  assert.equal(
    harness.rooms
      .getPublicRoom(harness.roomCode)
      ?.players.find((player) => player.id === eliminatedPlayer)?.status,
    "eliminated",
  );

  disconnectPlayer(harness, eliminatedPlayer);
  reconnectPlayer(harness, eliminatedPlayer);
  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  assert.equal(harness.events.states.at(-1)?.state.phase, "voting");
  assert.throws(
    () =>
      harness.service.submitVote(
        harness.roomCode,
        eliminatedPlayer,
        alternateTarget,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
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
  const firstVotingState = harness.events.states.at(-1)?.state;
  assert.ok(firstVotingState?.phase === "voting");
  const firstVotingEndsAt = firstVotingState.votingEndsAt;
  const firstVotingPhaseId = firstVotingState.votingPhaseId;
  assert.ok(firstVotingEndsAt);
  assert.ok(firstVotingPhaseId);

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
  assert.notEqual(revoteState.votingPhaseId, firstVotingPhaseId);
  assert.equal(revoteState.votingEndsAt, firstVotingEndsAt);
  const staleVoter = harness.playerIds[0];
  assert.ok(staleVoter);
  assert.throws(
    () =>
      harness.service.submitVote(
        harness.roomCode,
        staleVoter,
        staleVoter === firstCandidate ? secondCandidate : firstCandidate,
        harness.sessionId,
        firstVotingEndsAt,
        firstVotingPhaseId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  assert.equal(revoteState.votesSubmitted, 0);

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

test("a stale phase ID cannot resolve an expired Classic revote", () => {
  const harness = createHarness();
  const civilians = harness.playerIds.filter(
    (playerId) => getRoles(harness).get(playerId) === "player",
  );
  const firstCandidate = civilians[0];
  const secondCandidate = civilians[1];
  assert.ok(firstCandidate);
  assert.ok(secondCandidate);
  enterVoting(harness);
  const firstVotingState = harness.events.states.at(-1)?.state;
  assert.ok(firstVotingState?.phase === "voting");
  assert.ok(firstVotingState.votingEndsAt);
  assert.ok(firstVotingState.votingPhaseId);

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

  const revoteState = harness.events.states.at(-1)?.state;
  assert.ok(revoteState?.phase === "voting");
  assert.ok(revoteState.votingPhaseId);
  assert.equal(revoteState.votingEndsAt, firstVotingState.votingEndsAt);
  assert.notEqual(revoteState.votingPhaseId, firstVotingState.votingPhaseId);
  harness.runtime.advanceWithoutRunningTimers(
    Date.parse(firstVotingState.votingEndsAt) -
      harness.runtime.now().getTime(),
  );

  const staleVoter = harness.playerIds[0];
  assert.ok(staleVoter);
  assert.throws(
    () =>
      harness.service.submitVote(
        harness.roomCode,
        staleVoter,
        staleVoter === firstCandidate ? secondCandidate : firstCandidate,
        harness.sessionId,
        firstVotingState.votingEndsAt,
        firstVotingState.votingPhaseId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );

  const currentState = harness.events.states.at(-1)?.state;
  assert.ok(currentState?.phase === "voting");
  assert.equal(currentState.votingPhaseId, revoteState.votingPhaseId);
  assert.equal(currentState.votesSubmitted, 0);
  assert.equal(harness.events.votes.length, 1);
  assert.equal(harness.service.getHistory(harness.sessionId)?.voting.length, 1);
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

test("host rematch resets completed state while preserving room identity and reconnect access", () => {
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

  const oldSessionId = harness.sessionId;
  const finishedRoom = harness.rooms.getPublicRoom(harness.roomCode);
  const staleCallback = harness.runtime.latestScheduledCallback;
  const firstStartedSession = harness.events.started[0]?.session;
  assert.equal(finishedRoom?.gameStatus, "finished");
  assert.ok(staleCallback);
  assert.ok(firstStartedSession && firstStartedSession.gameMode !== "manhunt");
  assert.throws(
    () => harness.service.startGame(harness.roomCode, harness.hostSocketId),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  assert.throws(
    () => harness.service.returnToLobby(harness.roomCode, "socket-1"),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
    "finished",
  );

  const lobby = harness.service.returnToLobby(
    harness.roomCode,
    harness.hostSocketId,
  );
  assert.equal(lobby.code, finishedRoom?.code);
  assert.equal(lobby.hostId, finishedRoom?.hostId);
  assert.deepEqual(
    lobby.players.map((player) => player.id),
    finishedRoom?.players.map((player) => player.id),
  );
  assert.deepEqual(lobby.settings, finishedRoom?.settings);
  assert.equal(lobby.createdAt, finishedRoom?.createdAt);
  assert.equal(lobby.gameStatus, "waiting");
  assert.equal(lobby.currentGameId, undefined);
  assert.ok(lobby.players.every((player) => player.status === "waiting"));
  assert.equal(harness.service.getHistory(oldSessionId), undefined);
  assert.equal(
    harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!),
    undefined,
  );
  assert.throws(
    () =>
      harness.service.requestRole(
        harness.roomCode,
        oldSessionId,
        harness.playerIds[0]!,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );
  assert.equal(harness.runtime.pendingTimerCount, 0);

  const reconnectPlayerId = harness.playerIds[1];
  const reconnectToken = harness.reconnectTokens[1];
  const disconnectedSocketId = harness.socketIds[1];
  assert.ok(reconnectPlayerId);
  assert.ok(reconnectToken);
  assert.ok(disconnectedSocketId);
  assert.ok(harness.rooms.disconnectSocket(disconnectedSocketId));
  assert.throws(
    () => harness.service.startGame(harness.roomCode, harness.hostSocketId),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_READY",
  );
  const reconnected = harness.rooms.reconnect(
    { roomCode: harness.roomCode, playerId: reconnectPlayerId, reconnectToken },
    "rematch-reconnected-player",
  );
  assert.equal(reconnected.payload.player.id, reconnectPlayerId);

  const updatedSettings: RoomSettings = {
    gameMode: "impostor-classic",
    maxPlayers: lobby.settings.maxPlayers,
    isPrivate: lobby.settings.isPrivate,
    classicImpostor: {
      ...GAME_SETTINGS,
      votingDurationSeconds: GAME_SETTINGS.votingDurationSeconds + 5,
    },
  };
  assert.deepEqual(
    harness.rooms.updateRoomSettings(
      { roomCode: harness.roomCode, settings: updatedSettings },
      harness.hostSocketId,
    ).settings,
    updatedSettings,
  );
  const newSession = harness.service.startGame(
    harness.roomCode,
    harness.hostSocketId,
  );
  assert.notEqual(newSession.id, oldSessionId);
  assert.notEqual(
    newSession.state.roleRevealEndsAt,
    firstStartedSession.state.roleRevealEndsAt,
  );
  assert.equal(
    harness.service.requestRole(
      harness.roomCode,
      newSession.id,
      harness.playerIds[0]!,
    ).sessionId,
    newSession.id,
  );
  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  harness.runtime.advance(GAME_SETTINGS.discussionDurationSeconds * 1_000);
  assert.equal(harness.events.states.at(-1)?.state.phase, "voting");
  const stateUpdateCount = harness.events.states.length;
  staleCallback();
  assert.equal(harness.events.states.length, stateUpdateCount);
  assert.equal(
    harness.service.getResumeSnapshot(harness.roomCode, harness.playerIds[0]!)
      ?.state.state.phase,
    "voting",
  );
  assert.throws(
    () =>
      harness.service.submitVote(
        harness.roomCode,
        harness.playerIds[0]!,
        harness.playerIds[1]!,
        oldSessionId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  harness.service.close();
});

test("active Classic Impostor games cannot be returned to the lobby", () => {
  const harness = createHarness();
  harness.runtime.advance(ROLE_REVEAL_DURATION_SECONDS * 1_000);
  assert.throws(
    () =>
      harness.service.returnToLobby(
        harness.roomCode,
        harness.hostSocketId,
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "GAME_NOT_ACTIVE",
  );
  assert.equal(
    harness.rooms.getPublicRoom(harness.roomCode)?.gameStatus,
    "in_progress",
  );
  assert.equal(harness.runtime.pendingTimerCount, 1);
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
