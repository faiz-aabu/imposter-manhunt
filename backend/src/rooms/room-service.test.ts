import assert from "node:assert/strict";
import test from "node:test";
import type { RoomSettings } from "@impostor/api";
import { RoomService } from "./room-service.js";
import { AppError } from "../utils/app-error.js";
import { InMemoryRateLimiter } from "../services/rate-limiter.js";

test("room service creates unique rooms and enforces room capacity", () => {
  const rooms = new RoomService();
  const created = rooms.createRoom(
    {
      nickname: "Host",
      settings: {
        gameMode: "impostor-classic",
        maxPlayers: 2,
        isPrivate: false,
      },
    },
    "host-socket",
  );
  const anotherRoom = rooms.createRoom(
    { nickname: "Another Host" },
    "another-host-socket",
  );
  const joined = rooms.joinRoom(
    { roomCode: created.room.code, nickname: "Guest" },
    "guest-socket",
  );

  assert.match(created.room.code, /^[A-Z]{4}$/);
  assert.notEqual(created.room.code, anotherRoom.room.code);
  assert.equal(joined.room.players.length, 2);
  assert.throws(
    () =>
      rooms.joinRoom(
        { roomCode: created.room.code, nickname: "Third" },
        "third-socket",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "ROOM_FULL",
  );
  assert.throws(
    () =>
      rooms.joinRoom(
        { roomCode: created.room.code, nickname: "Duplicate" },
        "guest-socket",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );
});

test("host transfer and empty-room deletion follow membership changes", () => {
  const rooms = new RoomService();
  const host = rooms.createRoom({ nickname: "Host" }, "host-socket");
  const guest = rooms.joinRoom(
    { roomCode: host.room.code, nickname: "Guest" },
    "guest-socket",
  );

  const hostLeave = rooms.leaveRoom(host.room.code, "host-socket");
  assert.equal(hostLeave.room?.hostId, guest.playerId);
  assert.equal(hostLeave.hostChanged, true);

  const lastPlayerLeave = rooms.leaveRoom(host.room.code, "guest-socket");
  assert.equal(lastPlayerLeave.deleted, true);
  assert.equal(rooms.getPublicRoom(host.room.code), undefined);
});

test("only the host updates settings and cannot lower the limit below occupancy", () => {
  const rooms = new RoomService();
  const host = rooms.createRoom({ nickname: "Host" }, "host-socket");
  const guest = rooms.joinRoom(
    { roomCode: host.room.code, nickname: "Guest" },
    "guest-socket",
  );
  const settings: RoomSettings = {
    gameMode: "manhunt",
    maxPlayers: 3,
    isPrivate: true,
  };

  assert.throws(
    () =>
      rooms.updateRoomSettings(
        { roomCode: host.room.code, settings },
        "guest-socket",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );

  const updated = rooms.updateRoomSettings(
    { roomCode: host.room.code, settings },
    "host-socket",
  );
  assert.deepEqual(updated.settings, settings);

  assert.throws(
    () =>
      rooms.updateRoomSettings(
        {
          roomCode: host.room.code,
          settings: { ...settings, maxPlayers: 1 },
        },
        "host-socket",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "INVALID_PAYLOAD",
  );
  assert.notEqual(guest.playerId, host.playerId);
});

test("reconnection restores the same player without exposing its token", () => {
  const rooms = new RoomService();
  const created = rooms.createRoom({ nickname: "Host" }, "old-socket");
  const disconnected = rooms.disconnectSocket("old-socket");

  assert.ok(disconnected);
  assert.equal(
    disconnected.room.players[0]?.connectionStatus,
    "disconnected",
  );
  assert.equal(JSON.stringify(disconnected.room).includes("reconnectToken"), false);
  assert.throws(
    () =>
      rooms.reconnect(
        {
          roomCode: created.room.code,
          playerId: created.playerId,
          reconnectToken: "wrong-token",
        },
        "invalid-socket",
      ),
    (error: unknown) =>
      error instanceof AppError && error.code === "NOT_AUTHORIZED",
  );

  const reconnected = rooms.reconnect(
    {
      roomCode: created.room.code,
      playerId: created.playerId,
      reconnectToken: created.reconnectToken,
    },
    "new-socket",
  );
  assert.equal(reconnected.payload.player.id, created.playerId);
  assert.equal(reconnected.room.players.length, 1);
  assert.equal(reconnected.room.players[0]?.connectionStatus, "connected");
  assert.equal(
    rooms.removeDisconnectedPlayer(created.room.code, created.playerId),
    undefined,
  );
});

test("rate limiter expires attempts outside the configured window", () => {
  const limiter = new InMemoryRateLimiter();
  assert.equal(limiter.consume("client", 2, 1_000, 10_000), true);
  assert.equal(limiter.consume("client", 2, 1_000, 10_100), true);
  assert.equal(limiter.consume("client", 2, 1_000, 10_200), false);
  assert.equal(limiter.consume("client", 2, 1_000, 11_001), true);
});
