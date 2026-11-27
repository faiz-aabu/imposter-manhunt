import assert from "node:assert/strict";
import test from "node:test";
import {
  isNonHostImpostorRematchUpdate,
  returnFinishedImpostorGameToLobby,
} from "../src/services/impostor-rematch.ts";
import { useClassicGameStore } from "../src/store/classic-game-store.ts";
import { useRoomStore } from "../src/store/room-store.ts";
import { useWordGameStore } from "../src/store/word-game-store.ts";
import { resetImpostorGameStores } from "../src/store/reset-impostor-game-stores.ts";

const waitingRoom = {
  code: "ABCD",
  hostId: "host-player",
  players: [{ id: "host-player" }],
  settings: { gameMode: "impostor-classic" },
  gameStatus: "waiting",
  createdAt: "2025-01-01T00:00:00.000Z",
};

test("host rematch sends the same room code and navigates only after server confirmation", async () => {
  let requestPayload;
  let returnedRoom;
  const completed = await returnFinishedImpostorGameToLobby({
    roomCode: "ABCD",
    isHost: true,
    request: async (payload) => {
      requestPayload = payload;
      return { ok: true, data: { room: waitingRoom } };
    },
    onReturned: (room) => {
      returnedRoom = room;
    },
    onError: (message) => assert.fail(message),
  });

  assert.equal(completed, true);
  assert.deepEqual(requestPayload, { roomCode: "ABCD" });
  assert.equal(returnedRoom, waitingRoom);
});

test("rejected rematch leaves navigation untouched and displays the server error", async () => {
  let navigated = false;
  let displayedError;
  const completed = await returnFinishedImpostorGameToLobby({
    roomCode: "ABCD",
    isHost: true,
    request: async () => ({
      ok: false,
      error: { code: "GAME_NOT_ACTIVE", message: "The game is still active." },
    }),
    onReturned: () => {
      navigated = true;
    },
    onError: (message) => {
      displayedError = message;
    },
  });

  assert.equal(completed, false);
  assert.equal(navigated, false);
  assert.equal(displayedError, "The game is still active.");
});

test("non-host rematch attempts do not send a reset request", async () => {
  let requestSent = false;
  let displayedError;
  const completed = await returnFinishedImpostorGameToLobby({
    roomCode: "ABCD",
    isHost: false,
    request: async () => {
      requestSent = true;
      return { ok: true, data: { room: waitingRoom } };
    },
    onReturned: () => assert.fail("A non-host must not navigate."),
    onError: (message) => {
      displayedError = message;
    },
  });

  assert.equal(completed, false);
  assert.equal(requestSent, false);
  assert.equal(displayedError, "Only the host can return this room to the lobby.");
});

test("room updates return non-hosts to the same lobby and leave hosts to confirm their request", () => {
  const finishedRoom = { ...waitingRoom, gameStatus: "finished" };
  assert.equal(
    isNonHostImpostorRematchUpdate(
      finishedRoom,
      waitingRoom,
      "guest-player",
      true,
    ),
    true,
  );
  assert.equal(
    isNonHostImpostorRematchUpdate(
      finishedRoom,
      waitingRoom,
      "host-player",
      true,
    ),
    false,
  );
  assert.equal(
    isNonHostImpostorRematchUpdate(
      finishedRoom,
      waitingRoom,
      "guest-player",
      false,
    ),
    false,
  );
});

test("clearing Impostor game stores preserves room and player identity", () => {
  useRoomStore.getState().setSession(waitingRoom, "host-player");
  useClassicGameStore.setState({
    session: { id: "classic-old-session" },
    role: { sessionId: "classic-old-session", role: "impostor" },
    result: { gameId: "classic-old-session" },
  });
  useWordGameStore.setState({
    session: { id: "word-old-session" },
    role: {
      sessionId: "word-old-session",
      role: "civilian",
      secretWord: "private-old-word",
    },
    result: { gameId: "word-old-session" },
  });

  resetImpostorGameStores();

  assert.equal(useClassicGameStore.getState().session, null);
  assert.equal(useClassicGameStore.getState().role, null);
  assert.equal(useClassicGameStore.getState().result, null);
  assert.equal(useWordGameStore.getState().session, null);
  assert.equal(useWordGameStore.getState().role, null);
  assert.equal(useWordGameStore.getState().result, null);
  assert.equal(useRoomStore.getState().room?.code, "ABCD");
  assert.equal(useRoomStore.getState().playerId, "host-player");
});
