import assert from "node:assert/strict";
import test from "node:test";
import {
  canStartClassicImpostorGame,
  clampClassicImpostorCount,
  getClassicImpostorCountStepperMaximum,
  getMaximumClassicImpostorCount,
} from "../src/utils/classic-impostor-player-limit.ts";

const expectedMaximums = new Map([
  [3, 1],
  [4, 1],
  [5, 2],
  [6, 2],
  [7, 3],
  [8, 3],
]);

function startGameRequirements(playerCount, impostorCount) {
  return {
    isHost: true,
    isConnected: true,
    isWaiting: true,
    playerCount,
    minimumPlayerCount: 3,
    allPlayersConnected: true,
    settingsAreValid: true,
    impostorCount,
  };
}

test("Classic impostor maximum matches the server rule for 3 through 8 players", () => {
  for (const [playerCount, expectedMaximum] of expectedMaximums) {
    assert.equal(getMaximumClassicImpostorCount(playerCount), expectedMaximum);
    assert.equal(
      getClassicImpostorCountStepperMaximum(playerCount),
      expectedMaximum,
    );
    assert.equal(
      canStartClassicImpostorGame(
        startGameRequirements(playerCount, expectedMaximum),
      ),
      true,
    );
    assert.equal(
      canStartClassicImpostorGame(
        startGameRequirements(playerCount, expectedMaximum + 1),
      ),
      false,
    );
  }
});

test("the Classic impostor control clamps invalid selections to the current maximum", () => {
  for (const [playerCount, maximum] of expectedMaximums) {
    assert.equal(clampClassicImpostorCount(maximum + 1, playerCount), maximum);
    assert.equal(
      clampClassicImpostorCount(maximum, playerCount),
      maximum,
    );
  }
});

test("reducing player count clamps impostors and keeps Start Game validity current", () => {
  const selectedAtFivePlayers = 2;
  assert.equal(
    canStartClassicImpostorGame(
      startGameRequirements(5, selectedAtFivePlayers),
    ),
    true,
  );
  assert.equal(
    canStartClassicImpostorGame(
      startGameRequirements(4, selectedAtFivePlayers),
    ),
    false,
  );

  const clampedSelection = clampClassicImpostorCount(
    selectedAtFivePlayers,
    4,
  );
  assert.equal(clampedSelection, 1);
  assert.equal(
    canStartClassicImpostorGame(startGameRequirements(4, clampedSelection)),
    true,
  );
});
