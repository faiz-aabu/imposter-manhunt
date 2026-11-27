import assert from "node:assert/strict";
import test from "node:test";
import {
  getCurrentVoteKey,
  useClassicGameStore,
} from "../src/store/classic-game-store.ts";
import {
  getCurrentWordVoteKey,
  useWordGameStore,
} from "../src/store/word-game-store.ts";

const startTime = "2026-01-01T00:00:00.000Z";
const earlierPhase = {
  phase: "voting",
  roundNumber: 2,
  votingEndsAt: "2026-01-01T00:01:00.000Z",
  votingPhaseId: 7,
  votesSubmitted: 1,
  eligibleVoters: 3,
  eliminatedPlayerIds: [],
  revotePlayerIds: ["player-a", "player-b"],
};
const laterPhase = {
  ...earlierPhase,
  votingEndsAt: "2026-01-01T00:02:00.000Z",
  votingPhaseId: 8,
};

function makeSession(id, state, gameMode) {
  return {
    id,
    roomCode: "ROOM",
    gameMode,
    startedAt: startTime,
    state,
  };
}

function makeUpdate(sessionId, state) {
  return {
    sessionId,
    roomCode: "ROOM",
    state,
    updatedAt: startTime,
  };
}

const storeCases = [
  {
    name: "Classic",
    store: useClassicGameStore,
    getVoteKey: getCurrentVoteKey,
    gameMode: "impostor-classic",
  },
  {
    name: "Word",
    store: useWordGameStore,
    getVoteKey: getCurrentWordVoteKey,
    gameMode: "impostor-word",
  },
];

for (const { name, store, getVoteKey, gameMode } of storeCases) {
  test(`${name}: vote keys distinguish server-issued voting phases`, () => {
    const earlierKey = getVoteKey("session-1", earlierPhase);
    const laterKey = getVoteKey("session-1", laterPhase);

    assert.notEqual(earlierKey, laterKey);
    assert.equal(
      getVoteKey("session-1", { ...earlierPhase, votingPhaseId: undefined }),
      null,
    );
  });

  test(`${name}: voting fails closed when the server phase identity is missing`, () => {
    store.getState().reset();
    const stateWithoutPhaseId = {
      ...earlierPhase,
      votingPhaseId: undefined,
    };
    store
      .getState()
      .setSession(makeSession("session-1", stateWithoutPhaseId, gameMode), []);

    assert.equal(store.getState().currentVoteKey, null);
    assert.equal(
      store.getState().markVoteSent("client-generated-key", "player-a"),
      false,
    );
  });

  test(`${name}: a later revote clears the earlier submission and allows voting`, () => {
    store.getState().reset();
    store.getState().setSession(
      makeSession("session-1", earlierPhase, gameMode),
      [],
    );
    const earlierKey = getVoteKey("session-1", earlierPhase);

    assert.equal(store.getState().markVoteSent(earlierKey, "player-a"), true);
    assert.equal(store.getState().markVoteSent(earlierKey, "player-b"), false);

    store.getState().setGameState(makeUpdate("session-1", laterPhase));
    const laterKey = getVoteKey("session-1", laterPhase);

    assert.notEqual(earlierKey, laterKey);
    assert.equal(store.getState().submittedVoteKey, null);
    assert.equal(store.getState().voteSent, false);
    assert.equal(store.getState().markVoteSent(laterKey, "player-b"), true);
  });

  test(`${name}: reconnect restores the current phase without restoring an obsolete vote key`, () => {
    store.getState().reset();
    store.getState().setSession(
      makeSession("session-1", earlierPhase, gameMode),
      [],
    );
    const earlierKey = getVoteKey("session-1", earlierPhase);
    assert.equal(store.getState().markVoteSent(earlierKey, "player-a"), true);

    store
      .getState()
      .setSession(makeSession("session-1", laterPhase, gameMode), []);

    const laterKey = getVoteKey("session-1", laterPhase);
    assert.equal(store.getState().currentVoteKey, laterKey);
    assert.equal(store.getState().submittedVoteKey, null);
    assert.equal(store.getState().voteSent, false);
    assert.equal(store.getState().markVoteSent(laterKey, "player-b"), true);
  });

  test(`${name}: same-phase reconnect preserves duplicate protection and a new session is isolated`, () => {
    store.getState().reset();
    store.getState().setSession(
      makeSession("session-1", earlierPhase, gameMode),
      [],
    );
    const earlierKey = getVoteKey("session-1", earlierPhase);
    assert.equal(store.getState().markVoteSent(earlierKey, "player-a"), true);

    store
      .getState()
      .setSession(makeSession("session-1", earlierPhase, gameMode), []);
    assert.equal(store.getState().currentVoteKey, earlierKey);
    assert.equal(store.getState().submittedVoteKey, earlierKey);
    assert.equal(store.getState().markVoteSent(earlierKey, "player-b"), false);

    store
      .getState()
      .setSession(makeSession("session-2", earlierPhase, gameMode), []);
    const newSessionKey = getVoteKey("session-2", earlierPhase);
    assert.notEqual(newSessionKey, earlierKey);
    assert.equal(store.getState().currentVoteKey, newSessionKey);
    assert.equal(store.getState().submittedVoteKey, null);
    assert.equal(store.getState().voteSent, false);
    assert.equal(store.getState().markVoteSent(newSessionKey, "player-b"), true);
  });
}
