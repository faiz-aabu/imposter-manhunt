import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  CONNECTION_EVENTS,
  ERROR_EVENTS,
  GAME_EVENTS,
  IMPOSTOR_EVENTS,
  MANHUNT_EVENTS,
  ROOM_EVENTS,
  WORD_IMPOSTOR_EVENTS,
} from "@impostor/api";
import type {
  CreateRoomResponse,
  CatchConfirmedPayload,
  CatchConfirmationRequestPayload,
  CountdownPayload,
  CountdownSyncResponsePayload,
  GameStateUpdatePayload,
  GameStartedPayload,
  JoinRoomResponse,
  ManhuntLocationAcknowledgementPayload,
  ImpostorRoleAssignmentPayload,
  PlayerJoinedPayload,
  PlayerLeftPayload,
  PlayerReconnectedPayload,
  RoomUpdatePayload,
  ValidationErrorPayload,
  WordImpostorRoleAssignmentPayload,
} from "@impostor/api";
import { io as createSocketClient } from "socket.io-client";
import type { Socket } from "socket.io-client";
import { createBackendServer } from "./server.js";
import type { BackendServer } from "./server.js";
import type { BackendConfig } from "./config/env.js";
import type { SocketAcknowledgement } from "./sockets/socket-types.js";

type TestClient = Socket;

const TEST_CONFIG: BackendConfig = {
  port: 0,
  allowedOrigins: ["*"],
  reconnectGracePeriodMs: 5_000,
  nodeEnv: "test",
  clientIpMode: "socket",
  trustProxyHops: 0,
  requireHttps: false,
};

async function createTestServer(
  testContext: TestContext,
  configOverrides: Partial<BackendConfig> = {},
): Promise<{ server: BackendServer; url: string }> {
  const server = createBackendServer({ ...TEST_CONFIG, ...configOverrides });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Test HTTP server did not bind to a TCP port.");
  }

  const clients: TestClient[] = [];
  testContext.after(async () => {
    for (const client of clients) {
      client.disconnect();
    }
    await server.close();
  });

  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function connectClient(
  url: string,
  clients: TestClient[],
  extraHeaders?: Record<string, string>,
  transports: ("polling" | "websocket")[] = ["websocket"],
): Promise<TestClient> {
  const client = createSocketClient(url, {
    autoConnect: false,
    reconnection: false,
    timeout: 3_000,
    transports,
    extraHeaders,
  });
  clients.push(client);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.disconnect();
      reject(new Error("Socket.IO client connection timed out."));
    }, 5_000);
    client.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    client.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    client.connect();
  });

  return client;
}

function emitWithAck<T>(
  client: TestClient,
  eventName: string,
  payload: unknown,
): Promise<SocketAcknowledgement<T>> {
  return new Promise((resolve, reject) => {
    client.timeout(3_000).emit(
      eventName,
      payload,
      (error: Error | null, response: SocketAcknowledgement<T>) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(response);
      },
    );
  });
}

function waitForEvent<T>(client: TestClient, eventName: string): Promise<T> {
  return new Promise((resolve) => {
    client.once(eventName, (payload: T) => resolve(payload));
  });
}

function waitForEventWhere<T>(
  client: TestClient,
  eventName: string,
  predicate: (payload: T) => boolean,
): Promise<T> {
  return new Promise((resolve) => {
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      client.off(eventName, handler);
      resolve(payload);
    };
    client.on(eventName, handler);
  });
}

test("HTTP health and room routes return structured public responses", async (t) => {
  const { server, url } = await createTestServer(t);
  const address = server.httpServer.address();
  assert.notEqual(address, null);
  assert.notEqual(typeof address, "string");
  if (!address || typeof address === "string") {
    throw new Error("Backend server did not bind to a TCP address.");
  }
  assert.equal(address.address, "0.0.0.0");

  const healthResponse = await fetch(`${url}/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(healthResponse.headers.get("x-frame-options"), "DENY");
  assert.equal(healthResponse.headers.get("referrer-policy"), "no-referrer");
  const healthBody: unknown = await healthResponse.json();
  assert.equal(
    typeof healthBody === "object" &&
      healthBody !== null &&
      "status" in healthBody &&
      healthBody.status === "ok",
    true,
  );
  assert.equal(
    typeof healthBody === "object" &&
      healthBody !== null &&
      "timestamp" in healthBody &&
      typeof healthBody.timestamp === "string",
    true,
  );

  const missingRoomResponse = await fetch(`${url}/rooms/NOPE`);
  assert.equal(missingRoomResponse.status, 404);

  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  const host = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Host" },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }

  const roomResponse = await fetch(
    `${url}/rooms/${createResult.data.room.code.toLowerCase()}`,
  );
  assert.equal(roomResponse.status, 200);
  const publicRoom = await roomResponse.json();
  assert.equal(publicRoom.code, createResult.data.room.code);
  assert.equal(JSON.stringify(publicRoom).includes("reconnectToken"), false);
  assert.equal(
    JSON.stringify(publicRoom).includes(createResult.data.reconnectToken),
    false,
  );
  assert.equal(server.roomService.getPublicRoom(createResult.data.room.code)?.hostId, createResult.data.playerId);
});

test("production enforces HTTPS and exact browser origins", async (t) => {
  const { url } = await createTestServer(t, {
    nodeEnv: "production",
    allowedOrigins: ["https://game.example"],
    trustProxyHops: 1,
    requireHttps: true,
  });

  const insecureResponse = await fetch(`${url}/rooms/NOPE`);
  assert.equal(insecureResponse.status, 426);
  assert.equal(insecureResponse.headers.get("strict-transport-security"), null);

  const spoofedForwardingChain = await fetch(`${url}/rooms/NOPE`, {
    headers: { "x-forwarded-proto": "https,http" },
  });
  assert.equal(spoofedForwardingChain.status, 426);

  const secureResponse = await fetch(`${url}/rooms/NOPE`, {
    headers: {
      "x-forwarded-proto": "https",
      origin: "https://game.example",
    },
  });
  assert.equal(secureResponse.status, 404);
  assert.equal(
    secureResponse.headers.get("strict-transport-security"),
    "max-age=31536000",
  );
  assert.equal(
    secureResponse.headers.get("access-control-allow-origin"),
    "https://game.example",
  );

  const rejectedOrigin = await fetch(`${url}/rooms/NOPE`, {
    headers: {
      "x-forwarded-proto": "https",
      origin: "https://untrusted.example",
    },
  });
  assert.equal(rejectedOrigin.status, 403);

  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
  });
  await connectClient(url, clients, {
    "x-forwarded-proto": "https",
    origin: "https://game.example",
  });
  await assert.rejects(
    connectClient(url, clients, { origin: "https://game.example" }),
  );
});

test("Socket.IO supports HTTP long-polling and WebSocket transports", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
  });

  await connectClient(url, clients, undefined, ["polling"]);
  await connectClient(url, clients, undefined, ["websocket"]);
});

test("two clients receive room updates; leaving transfers host status", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });
  const host = await connectClient(url, clients);
  const guest = await connectClient(url, clients);

  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Host" },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }

  const joinedEvent = waitForEvent<PlayerJoinedPayload>(
    host,
    ROOM_EVENTS.PLAYER_JOINED,
  );
  const updateEvent = waitForEvent<RoomUpdatePayload>(
    host,
    ROOM_EVENTS.UPDATE,
  );
  const joinResult = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    { roomCode: createResult.data.room.code, nickname: "Guest" },
  );
  assert.equal(joinResult.ok, true);
  if (!joinResult.ok) {
    return;
  }

  assert.equal((await joinedEvent).player.id, joinResult.data.playerId);
  assert.equal((await updateEvent).room.players.length, 2);

  const playerLeftEvent = waitForEvent<PlayerLeftPayload>(
    guest,
    ROOM_EVENTS.PLAYER_LEFT,
  );
  const hostTransferUpdate = waitForEvent<RoomUpdatePayload>(
    guest,
    ROOM_EVENTS.UPDATE,
  );
  const leaveResult = await emitWithAck<void>(host, ROOM_EVENTS.LEAVE, {
    roomCode: createResult.data.room.code,
  });
  assert.equal(leaveResult.ok, true);
  assert.equal((await playerLeftEvent).playerId, createResult.data.playerId);
  assert.equal(
    (await hostTransferUpdate).room.hostId,
    joinResult.data.playerId,
  );
});

test("only the host starts a game and role responses are private to the requester", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });
  const host = await connectClient(url, clients);
  const guest = await connectClient(url, clients);
  const thirdPlayer = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Host" },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }
  const joinResult = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    {
      roomCode: createResult.data.room.code,
      nickname: "Guest",
    },
  );
  assert.equal(joinResult.ok, true);
  if (!joinResult.ok) {
    return;
  }
  const thirdJoinResult = await emitWithAck<JoinRoomResponse>(
    thirdPlayer,
    ROOM_EVENTS.JOIN,
    {
      roomCode: createResult.data.room.code,
      nickname: "Third",
    },
  );
  assert.equal(thirdJoinResult.ok, true);
  if (!thirdJoinResult.ok) {
    return;
  }

  const guestResult = await emitWithAck<void>(guest, GAME_EVENTS.START_GAME, {
    roomCode: createResult.data.room.code,
  });
  assert.equal(guestResult.ok, false);
  if (!guestResult.ok) {
    assert.equal(guestResult.error.code, "NOT_AUTHORIZED");
  }

  const hostStartedEvent = waitForEvent<GameStartedPayload>(
    host,
    GAME_EVENTS.GAME_STARTED,
  );
  const guestStartedEvent = waitForEvent<GameStartedPayload>(
    guest,
    GAME_EVENTS.GAME_STARTED,
  );
  const hostResult = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
    roomCode: createResult.data.room.code,
  });
  assert.equal(hostResult.ok, true);
  const started = (await hostStartedEvent).session;
  assert.equal(started.status, "starting");
  assert.equal((await guestStartedEvent).session.id, started.id);
  assert.equal(JSON.stringify(started).includes("impostorPlayerIds"), false);

  let guestRoleAssignmentCount = 0;
  guest.on(IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, () => {
    guestRoleAssignmentCount += 1;
  });
  const hostRoleAssignment = waitForEvent<ImpostorRoleAssignmentPayload>(
    host,
    IMPOSTOR_EVENTS.ROLE_ASSIGNMENT,
  );
  host.emit(IMPOSTOR_EVENTS.ROLE_REQUEST, {
    roomCode: createResult.data.room.code,
    sessionId: started.id,
  });
  const assignedRole = await hostRoleAssignment;
  assert.equal(assignedRole.sessionId, started.id);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(guestRoleAssignmentCount, 0);

  const validationEvent = waitForEvent<ValidationErrorPayload>(
    guest,
    ERROR_EVENTS.VALIDATION_ERROR,
  );
  guest.emit(IMPOSTOR_EVENTS.ROLE_REQUEST, {
    roomCode: createResult.data.room.code,
    sessionId: started.id,
    playerId: createResult.data.playerId,
  });
  assert.equal((await validationEvent).code, "INVALID_PAYLOAD");
});

test("reconnecting players receive only their own active-game role", async (t) => {
  const { server, url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });
  const host = await connectClient(url, clients);
  const guest = await connectClient(url, clients);
  const thirdPlayer = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Host" },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }
  const guestJoin = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    { roomCode: createResult.data.room.code, nickname: "Guest" },
  );
  const thirdJoin = await emitWithAck<JoinRoomResponse>(
    thirdPlayer,
    ROOM_EVENTS.JOIN,
    { roomCode: createResult.data.room.code, nickname: "Third" },
  );
  assert.equal(guestJoin.ok, true);
  assert.equal(thirdJoin.ok, true);
  if (!guestJoin.ok || !thirdJoin.ok) {
    return;
  }

  const startedEvent = waitForEvent<GameStartedPayload>(
    guest,
    GAME_EVENTS.GAME_STARTED,
  );
  const startResult = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
    roomCode: createResult.data.room.code,
  });
  assert.equal(startResult.ok, true);
  const sessionId = (await startedEvent).session.id;

  let hostRoleAssignmentCount = 0;
  host.on(IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, () => {
    hostRoleAssignmentCount += 1;
  });
  guest.disconnect();
  const replacement = await connectClient(url, clients);
  const resumedGame = waitForEvent<GameStartedPayload>(
    replacement,
    GAME_EVENTS.GAME_STARTED,
  );
  const resumedState = waitForEvent<GameStateUpdatePayload>(
    replacement,
    GAME_EVENTS.STATE_UPDATE,
  );
  const resumedRole = waitForEvent<ImpostorRoleAssignmentPayload>(
    replacement,
    IMPOSTOR_EVENTS.ROLE_ASSIGNMENT,
  );
  const reconnectResult = await emitWithAck<PlayerReconnectedPayload>(
    replacement,
    CONNECTION_EVENTS.RECONNECT,
    {
      roomCode: createResult.data.room.code,
      playerId: guestJoin.data.playerId,
      reconnectToken: guestJoin.data.reconnectToken,
    },
  );
  assert.equal(reconnectResult.ok, true);
  assert.equal((await resumedGame).session.id, sessionId);
  assert.equal((await resumedState).sessionId, sessionId);
  assert.deepEqual(await resumedRole, server.classicImpostorService.requestRole(
    createResult.data.room.code,
    sessionId,
    guestJoin.data.playerId,
  ));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(hostRoleAssignmentCount, 0);
});

test("room capacity is enforced and valid reconnect restores the same member", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  const host = await connectClient(url, clients);
  const guest = await connectClient(url, clients);
  const thirdPlayer = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Host",
      settings: {
        gameMode: "impostor-word",
        maxPlayers: 2,
        isPrivate: false,
      },
    },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }

  const joinResult = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    { roomCode: createResult.data.room.code, nickname: "Guest" },
  );
  assert.equal(joinResult.ok, true);
  const fullResult = await emitWithAck<JoinRoomResponse>(
    thirdPlayer,
    ROOM_EVENTS.JOIN,
    { roomCode: createResult.data.room.code, nickname: "Third" },
  );
  assert.equal(fullResult.ok, false);
  if (fullResult.ok) {
    return;
  }
  assert.equal(fullResult.error.code, "ROOM_FULL");

  const disconnectedUpdate = waitForEvent<RoomUpdatePayload>(
    guest,
    ROOM_EVENTS.UPDATE,
  );
  host.disconnect();
  const disconnectedRoom = (await disconnectedUpdate).room;
  assert.equal(
    disconnectedRoom.players.find(
      (player) => player.id === createResult.data.playerId,
    )?.connectionStatus,
    "disconnected",
  );

  const replacement = await connectClient(url, clients);
  const reconnectedNotice = waitForEvent<PlayerReconnectedPayload>(
    guest,
    CONNECTION_EVENTS.PLAYER_RECONNECTED,
  );
  const restoredUpdate = waitForEvent<RoomUpdatePayload>(
    guest,
    ROOM_EVENTS.UPDATE,
  );
  const reconnectResult = await emitWithAck<PlayerReconnectedPayload>(
    replacement,
    CONNECTION_EVENTS.RECONNECT,
    {
      roomCode: createResult.data.room.code,
      playerId: createResult.data.playerId,
      reconnectToken: createResult.data.reconnectToken,
    },
  );
  assert.equal(reconnectResult.ok, true);
  if (!reconnectResult.ok) {
    return;
  }

  assert.equal((await reconnectedNotice).player.id, createResult.data.playerId);
  const restoredRoom = (await restoredUpdate).room;
  assert.equal(restoredRoom.players.length, 2);
  assert.equal(
    restoredRoom.players.find(
      (player) => player.id === createResult.data.playerId,
    )?.connectionStatus,
    "connected",
  );
  assert.equal(JSON.stringify(restoredRoom).includes("reconnectToken"), false);
});

test("configured CORS origins are allowed and other browser origins are rejected", async (t) => {
  const { url } = await createTestServer(t, {
    allowedOrigins: ["https://game.example"],
  });
  const allowedResponse = await fetch(`${url}/health`, {
    headers: { Origin: "https://game.example" },
  });
  assert.equal(allowedResponse.status, 200);
  assert.equal(
    allowedResponse.headers.get("access-control-allow-origin"),
    "https://game.example",
  );

  const rejectedResponse = await fetch(`${url}/health`, {
    headers: { Origin: "https://untrusted.example" },
  });
  assert.equal(rejectedResponse.status, 403);
});

test("disconnected players are removed after the reconnect grace period", async (t) => {
  const { url } = await createTestServer(t, {
    reconnectGracePeriodMs: 100,
  });
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });
  const host = await connectClient(url, clients);
  const guest = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    { nickname: "Host" },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }
  const joinResult = await emitWithAck<JoinRoomResponse>(
    guest,
    ROOM_EVENTS.JOIN,
    { roomCode: createResult.data.room.code, nickname: "Guest" },
  );
  assert.equal(joinResult.ok, true);

  const disconnectedUpdate = waitForEvent<RoomUpdatePayload>(
    guest,
    ROOM_EVENTS.UPDATE,
  );
  host.disconnect();
  assert.equal(
    (await disconnectedUpdate).room.players.find(
      (player) => player.id === createResult.data.playerId,
    )?.connectionStatus,
    "disconnected",
  );

  const leftEvent = waitForEvent<PlayerLeftPayload>(
    guest,
    ROOM_EVENTS.PLAYER_LEFT,
  );
  const updatedRoom = waitForEvent<RoomUpdatePayload>(
    guest,
    ROOM_EVENTS.UPDATE,
  );
  assert.equal((await leftEvent).playerId, createResult.data.playerId);
  const remainingRoom = (await updatedRoom).room;
  assert.equal(remainingRoom.players.length, 1);
  assert.equal(remainingRoom.hostId, joinResult.data.playerId);
});

test("room creation is rate-limited per remote address", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const client = await connectClient(url, clients);
    const result = await emitWithAck<CreateRoomResponse>(
      client,
      ROOM_EVENTS.CREATE,
      { nickname: `Player ${attempt}` },
    );
    if (attempt < 5) {
      assert.equal(result.ok, true);
    } else {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error.message, /Too many attempts/);
      }
    }
  }
});

test("Railway mode validates X-Real-IP and rate-limits without X-Forwarded-For", async (t) => {
  const { url } = await createTestServer(t, {
    nodeEnv: "production",
    allowedOrigins: ["https://game.example"],
    clientIpMode: "railway",
    trustProxyHops: 0,
    requireHttps: true,
  });
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
  });

  await assert.rejects(
    connectClient(url, clients, { "x-forwarded-proto": "https" }),
  );
  await assert.rejects(
    connectClient(url, clients, {
      "x-real-ip": "203.0.113.8, 198.51.100.2",
      "x-forwarded-proto": "https",
    }),
  );

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const client = await connectClient(url, clients, {
      "x-real-ip": "203.0.113.8",
      "x-forwarded-for": `198.51.100.${attempt + 1}`,
      "x-forwarded-proto": "https",
    });
    const result = await emitWithAck<CreateRoomResponse>(
      client,
      ROOM_EVENTS.CREATE,
      { nickname: `Railway player ${attempt}` },
    );
    assert.equal(result.ok, attempt < 5);
    if (!result.ok && attempt === 5) {
      assert.match(result.error.message, /Too many attempts/);
    }
  }
});

test("Manhunt location updates are rate-limited per player", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) client.disconnect();
  });
  const client = await connectClient(url, clients);
  const created = await emitWithAck<CreateRoomResponse>(
    client,
    ROOM_EVENTS.CREATE,
    { nickname: "Player" },
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result: SocketAcknowledgement<ManhuntLocationAcknowledgementPayload> =
      await emitWithAck<ManhuntLocationAcknowledgementPayload>(
        client,
        MANHUNT_EVENTS.LOCATION_UPDATE,
        { roomCode: created.data.room.code },
      );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_PAYLOAD");
  }

  const limited = await emitWithAck<ManhuntLocationAcknowledgementPayload>(
    client,
    MANHUNT_EVENTS.LOCATION_UPDATE,
    { roomCode: created.data.room.code },
  );
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.match(limited.error.message, /Too many attempts/);
});

test("invalid game modes are rejected with a shared validation error", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });
  const client = await connectClient(url, clients);
  const validationEvent = waitForEvent<ValidationErrorPayload>(
    client,
    ERROR_EVENTS.VALIDATION_ERROR,
  );
  const result = await emitWithAck<CreateRoomResponse>(
    client,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Player",
      settings: {
        gameMode: "infection",
        maxPlayers: 8,
        isPrivate: false,
      },
    },
  );

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "INVALID_PAYLOAD");
  }
  assert.equal((await validationEvent).code, "INVALID_PAYLOAD");
});

test("Manhunt catch confirmation is private and announcements reach only the same game", async (t) => {
    const { url } = await createTestServer(t);
    const clients: TestClient[] = [];
    t.after(() => {
      for (const client of clients) {
        client.disconnect();
      }
    });

    const hunterCandidate = await connectClient(url, clients);
    const runnerCandidate = await connectClient(url, clients);
    const thirdPlayer = await connectClient(url, clients);
    const otherRoomHost = await connectClient(url, clients);
    const otherRoomGuest = await connectClient(url, clients);

    const createResult = await emitWithAck<CreateRoomResponse>(
      hunterCandidate,
      ROOM_EVENTS.CREATE,
      {
        nickname: "Hunter Candidate",
        settings: {
          gameMode: "manhunt",
          maxPlayers: 8,
          isPrivate: false,
        },
      },
    );
    assert.equal(createResult.ok, true);
    if (!createResult.ok) return;
    const roomCode = createResult.data.room.code;
    const runnerJoin = await emitWithAck<JoinRoomResponse>(
      runnerCandidate,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: "Runner Candidate" },
    );
    const thirdJoin = await emitWithAck<JoinRoomResponse>(
      thirdPlayer,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: "Third Player" },
    );
    assert.equal(runnerJoin.ok, true);
    assert.equal(thirdJoin.ok, true);
    if (!runnerJoin.ok || !thirdJoin.ok) return;

    const otherRoomCreate = await emitWithAck<CreateRoomResponse>(
      otherRoomHost,
      ROOM_EVENTS.CREATE,
      {
        nickname: "Other Room Host",
        settings: {
          gameMode: "manhunt",
          maxPlayers: 8,
          isPrivate: false,
        },
      },
    );
    assert.equal(otherRoomCreate.ok, true);
    if (!otherRoomCreate.ok) return;
    const otherRoomJoin = await emitWithAck<JoinRoomResponse>(
      otherRoomGuest,
      ROOM_EVENTS.JOIN,
      {
        roomCode: otherRoomCreate.data.room.code,
        nickname: "Other Room Guest",
      },
    );
    assert.equal(otherRoomJoin.ok, true);
    if (!otherRoomJoin.ok) return;

    const settingsResult = await emitWithAck<RoomUpdatePayload>(
      hunterCandidate,
      MANHUNT_EVENTS.UPDATE_SETTINGS,
      {
        roomCode,
        settings: {
          hunterCount: 1,
          boundary: {
            center: { latitude: 0, longitude: 0 },
            radiusMeters: 500,
          },
        },
      },
    );
    assert.equal(settingsResult.ok, true);

    const gameStarted = [
      waitForEvent<GameStartedPayload>(
        hunterCandidate,
        GAME_EVENTS.GAME_STARTED,
      ),
      waitForEvent<GameStartedPayload>(
        runnerCandidate,
        GAME_EVENTS.GAME_STARTED,
      ),
      waitForEvent<GameStartedPayload>(thirdPlayer, GAME_EVENTS.GAME_STARTED),
    ];
    const countdownEvents = [
      waitForEvent<CountdownPayload>(hunterCandidate, MANHUNT_EVENTS.COUNTDOWN),
      waitForEvent<CountdownPayload>(runnerCandidate, MANHUNT_EVENTS.COUNTDOWN),
      waitForEvent<CountdownPayload>(thirdPlayer, MANHUNT_EVENTS.COUNTDOWN),
    ];
    const activeStateUpdates = [
      hunterCandidate,
      runnerCandidate,
    ].map((client) =>
      waitForEventWhere<GameStateUpdatePayload>(
        client,
        GAME_EVENTS.STATE_UPDATE,
        (payload) =>
          payload.roomCode === roomCode &&
          "teams" in payload.state &&
          payload.state.phase === "active",
      ),
    );
    const startResult = await emitWithAck<void>(
      hunterCandidate,
      GAME_EVENTS.START_GAME,
      { roomCode },
    );
    assert.equal(startResult.ok, true);
    const started = await Promise.all(gameStarted);
    const session = started[0]?.session;
    if (!session || session.gameMode !== "manhunt") {
      throw new Error("Manhunt start did not return a Manhunt session.");
    }
    assert.deepEqual(
      started.map((event) => event.session.id),
      [session.id, session.id, session.id],
    );
    assert.equal(session.state.phase, "countdown");
    const countdowns = await Promise.all(countdownEvents);
    assert.deepEqual(
      countdowns.map((event) => event.endsAt),
      [
        session.state.countdownEndsAt,
        session.state.countdownEndsAt,
        session.state.countdownEndsAt,
      ],
    );
    assert.equal(
      new Set(countdowns.map((event) => event.sessionId)).size,
      1,
    );
    const thirdDisconnected = waitForEventWhere<RoomUpdatePayload>(
      hunterCandidate,
      ROOM_EVENTS.UPDATE,
      (payload) =>
        payload.room.code === roomCode &&
        payload.room.players.some(
          (player) =>
            player.id === thirdJoin.data.playerId &&
            player.connectionStatus === "disconnected",
        ),
    );
    thirdPlayer.disconnect();
    await thirdDisconnected;
    const replacementThird = await connectClient(url, clients);
    const restoredStarted = waitForEvent<GameStartedPayload>(
      replacementThird,
      GAME_EVENTS.GAME_STARTED,
    );
    const restoredState = waitForEvent<GameStateUpdatePayload>(
      replacementThird,
      GAME_EVENTS.STATE_UPDATE,
    );
    const restoredCountdown = waitForEvent<CountdownPayload>(
      replacementThird,
      MANHUNT_EVENTS.COUNTDOWN,
    );
    const reconnectResult = await emitWithAck<PlayerReconnectedPayload>(
      replacementThird,
      CONNECTION_EVENTS.RECONNECT,
      {
        roomCode,
        playerId: thirdJoin.data.playerId,
        reconnectToken: thirdJoin.data.reconnectToken,
      },
    );
    assert.equal(reconnectResult.ok, true);
    const resumed = await restoredStarted;
    const resumedState = await restoredState;
    const resumedCountdown = await restoredCountdown;
    assert.equal(resumed.session.id, session.id);
    assert.equal(resumed.session.state.phase, "countdown");
    assert.equal(resumedState.state.phase, "countdown");
    assert.equal(resumedCountdown.endsAt, session.state.countdownEndsAt);
    const replacementActiveState = waitForEventWhere<GameStateUpdatePayload>(
      replacementThird,
      GAME_EVENTS.STATE_UPDATE,
      (payload) =>
        payload.roomCode === roomCode &&
        payload.sessionId === session.id &&
        "teams" in payload.state &&
        payload.state.phase === "active",
    );

    const participants = [
      {
        client: hunterCandidate,
        playerId: createResult.data.playerId,
        nickname: "Hunter Candidate",
      },
      {
        client: runnerCandidate,
        playerId: runnerJoin.data.playerId,
        nickname: "Runner Candidate",
      },
      {
        client: replacementThird,
        playerId: thirdJoin.data.playerId,
        nickname: "Third Player",
      },
    ];
    const hunter = participants.find(({ playerId }) =>
      session.state.teams.some(
        (assignment) =>
          assignment.playerId === playerId && assignment.team === "hunter",
      ),
    );
    const runner = participants.find(({ playerId }) =>
      session.state.teams.some(
        (assignment) =>
          assignment.playerId === playerId && assignment.team === "runner",
      ),
    );
    assert.ok(hunter);
    assert.ok(runner);
    if (!hunter || !runner) return;

    const earlyLocation = await emitWithAck<ManhuntLocationAcknowledgementPayload>(
      hunter.client,
      MANHUNT_EVENTS.LOCATION_UPDATE,
      {
        roomCode,
        coordinates: { latitude: 0, longitude: 0 },
      },
    );
    assert.equal(earlyLocation.ok, false);
    if (!earlyLocation.ok) {
      assert.equal(earlyLocation.error.code, "GAME_NOT_ACTIVE");
    }

    const sync = await emitWithAck<CountdownSyncResponsePayload>(
      hunter.client,
      MANHUNT_EVENTS.COUNTDOWN_SYNC,
      { roomCode, sessionId: session.id },
    );
    assert.equal(sync.ok, true);
    if (sync.ok) {
      assert.equal(sync.data.endsAt, session.state.countdownEndsAt);
    }
    const invalidSyncPayload = waitForEvent<ValidationErrorPayload>(
      hunter.client,
      ERROR_EVENTS.VALIDATION_ERROR,
    );
    hunter.client.emit(MANHUNT_EVENTS.COUNTDOWN_SYNC, {
      roomCode,
      sessionId: session.id,
      endsAt: "2099-01-01T00:00:00.000Z",
    });
    assert.equal((await invalidSyncPayload).code, "INVALID_PAYLOAD");

    const officialStarts = await Promise.all([
      ...activeStateUpdates,
      replacementActiveState,
    ]);
    assert.equal(
      officialStarts.every((event) => event.state.phase === "active"),
      true,
    );

    for (const participant of [hunter, runner]) {
      const locationResult =
        await emitWithAck<ManhuntLocationAcknowledgementPayload>(
          participant.client,
          MANHUNT_EVENTS.LOCATION_UPDATE,
          {
            roomCode,
            coordinates: { latitude: 0, longitude: 0 },
            accuracyMeters: 1,
          },
        );
      assert.equal(locationResult.ok, true);
    }

    const confirmation = waitForEvent<CatchConfirmationRequestPayload>(
      runner.client,
      MANHUNT_EVENTS.CATCH_CONFIRMATION_REQUEST,
    );
    let thirdPlayerReceivedPrivateRequest = false;
    const onUnexpectedPrivateRequest = () => {
      thirdPlayerReceivedPrivateRequest = true;
    };
    thirdPlayer.on(
      MANHUNT_EVENTS.CATCH_CONFIRMATION_REQUEST,
      onUnexpectedPrivateRequest,
    );
    hunter.client.emit(MANHUNT_EVENTS.CATCH, {
      roomCode,
      targetPlayerId: runner.playerId,
    });
    const request = await confirmation;
    assert.equal(request.sessionId, session.id);
    assert.equal(request.roomCode, roomCode);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(thirdPlayerReceivedPrivateRequest, false);
    thirdPlayer.off(
      MANHUNT_EVENTS.CATCH_CONFIRMATION_REQUEST,
      onUnexpectedPrivateRequest,
    );

    let otherRoomAnnouncementCount = 0;
    const onOtherRoomAnnouncement = () => {
      otherRoomAnnouncementCount += 1;
    };
    otherRoomHost.on(MANHUNT_EVENTS.CATCH_CONFIRMED, onOtherRoomAnnouncement);
    otherRoomGuest.on(MANHUNT_EVENTS.CATCH_CONFIRMED, onOtherRoomAnnouncement);
    const announcements = participants.map(({ client }) =>
      waitForEvent<CatchConfirmedPayload>(
        client,
        MANHUNT_EVENTS.CATCH_CONFIRMED,
      ),
    );
    const responseResult = await emitWithAck<void>(
      runner.client,
      MANHUNT_EVENTS.CATCH_CONFIRMATION_RESPONSE,
      {
        roomCode,
        requestId: request.requestId,
        accepted: true,
      },
    );
    assert.equal(responseResult.ok, true);
    const receivedAnnouncements = await Promise.all(announcements);
    assert.equal(
      receivedAnnouncements.every(
        (announcement) =>
          announcement.roomCode === roomCode &&
          announcement.sessionId === session.id &&
          announcement.caughtNickname === runner.nickname,
      ),
      true,
    );
    for (const announcement of receivedAnnouncements) {
      assert.deepEqual(Object.keys(announcement).sort(), [
        "caughtAt",
        "caughtNickname",
        "requestId",
        "roomCode",
        "sessionId",
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(otherRoomAnnouncementCount, 0);
    otherRoomHost.off(
      MANHUNT_EVENTS.CATCH_CONFIRMED,
      onOtherRoomAnnouncement,
    );
    otherRoomGuest.off(
      MANHUNT_EVENTS.CATCH_CONFIRMED,
      onOtherRoomAnnouncement,
    );
  });

test("Word Impostor sockets enforce host start and privately restore each player's role", async (t) => {
  const { server, url } = await createTestServer(t);
    const clients: TestClient[] = [];
    t.after(() => {
      for (const client of clients) {
        client.disconnect();
      }
    });
    const host = await connectClient(url, clients);
    const guest = await connectClient(url, clients);
    const thirdPlayer = await connectClient(url, clients);
    const createResult = await emitWithAck<CreateRoomResponse>(
      host,
      ROOM_EVENTS.CREATE,
      {
        nickname: "Host",
        settings: {
          gameMode: "impostor-word",
          maxPlayers: 8,
          isPrivate: false,
          wordImpostor: {
            category: "food",
            impostorCount: 1,
            discussionDurationSeconds: 30,
            votingDurationSeconds: 10,
          },
        },
      },
    );
    assert.equal(createResult.ok, true);
    if (!createResult.ok) {
      return;
    }
    const roomCode = createResult.data.room.code;
    const guestJoin = await emitWithAck<JoinRoomResponse>(
      guest,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: "Guest" },
    );
    assert.equal(guestJoin.ok, true);
    if (!guestJoin.ok) {
      return;
    }

    const tooFewResult = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
      roomCode,
    });
    assert.equal(tooFewResult.ok, false);
    if (!tooFewResult.ok) {
      assert.equal(tooFewResult.error.code, "GAME_NOT_READY");
    }

    const thirdJoin = await emitWithAck<JoinRoomResponse>(
      thirdPlayer,
      ROOM_EVENTS.JOIN,
      { roomCode, nickname: "Third" },
    );
    assert.equal(thirdJoin.ok, true);
    if (!thirdJoin.ok) {
      return;
    }
    const nonHostResult = await emitWithAck<void>(
      guest,
      GAME_EVENTS.START_GAME,
      { roomCode },
    );
    assert.equal(nonHostResult.ok, false);
    if (!nonHostResult.ok) {
      assert.equal(nonHostResult.error.code, "NOT_AUTHORIZED");
    }

    const startedEvents = [
      waitForEvent<GameStartedPayload>(host, GAME_EVENTS.GAME_STARTED),
      waitForEvent<GameStartedPayload>(guest, GAME_EVENTS.GAME_STARTED),
      waitForEvent<GameStartedPayload>(thirdPlayer, GAME_EVENTS.GAME_STARTED),
    ];
    const startResult = await emitWithAck<void>(host, GAME_EVENTS.START_GAME, {
      roomCode,
    });
    assert.equal(startResult.ok, true);
    const [hostStarted, guestStarted, thirdStarted] = await Promise.all(
      startedEvents,
    );
    const sessionId = hostStarted.session.id;
    assert.equal(guestStarted.session.id, sessionId);
    assert.equal(thirdStarted.session.id, sessionId);
    assert.equal(hostStarted.session.gameMode, "impostor-word");

    const roleCounts = [0, 0, 0];
    const roleClients = [host, guest, thirdPlayer];
    roleClients.forEach((client, index) => {
      client.on(WORD_IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, () => {
        roleCounts[index] = (roleCounts[index] ?? 0) + 1;
      });
    });
    const roleEvents = roleClients.map((client) =>
      waitForEvent<WordImpostorRoleAssignmentPayload>(
        client,
        WORD_IMPOSTOR_EVENTS.ROLE_ASSIGNMENT,
      ),
    );
    roleClients.forEach((client) => {
      client.emit(WORD_IMPOSTOR_EVENTS.ROLE_REQUEST, {
        roomCode,
        sessionId,
      });
    });
    const assignments = await Promise.all(roleEvents);
    assert.equal(
      assignments.filter((assignment) => assignment.role === "impostor").length,
      1,
    );
    const civilianWords = assignments.flatMap((assignment) =>
      assignment.role === "civilian" ? [assignment.secretWord] : [],
    );
    assert.equal(new Set(civilianWords).size, 1);
    assert.equal(
      assignments.every(
        (assignment) =>
          assignment.role !== "impostor" || !("secretWord" in assignment),
      ),
      true,
    );
    assert.deepEqual(roleCounts, [1, 1, 1]);
    assert.equal(
      JSON.stringify(server.roomService.getPublicRoom(roomCode)).includes(
        civilianWords[0] ?? "",
      ),
      false,
    );

    const invalidRoleRequest = waitForEvent<ValidationErrorPayload>(
      guest,
      ERROR_EVENTS.VALIDATION_ERROR,
    );
    guest.emit(WORD_IMPOSTOR_EVENTS.ROLE_REQUEST, {
      roomCode,
      sessionId,
      playerId: createResult.data.playerId,
    });
    assert.equal((await invalidRoleRequest).code, "INVALID_PAYLOAD");

    const invalidVotePayload = waitForEvent<ValidationErrorPayload>(
      guest,
      ERROR_EVENTS.VALIDATION_ERROR,
    );
    guest.emit(WORD_IMPOSTOR_EVENTS.VOTE_SUBMISSION, {
      roomCode,
      targetPlayerId: createResult.data.playerId,
      voterId: createResult.data.playerId,
    });
    assert.equal((await invalidVotePayload).code, "INVALID_PAYLOAD");

    const guestRole = assignments[1];
    assert.ok(guestRole);
    guest.disconnect();
    const replacement = await connectClient(url, clients);
    const resumedStart = waitForEvent<GameStartedPayload>(
      replacement,
      GAME_EVENTS.GAME_STARTED,
    );
    const resumedState = waitForEvent<GameStateUpdatePayload>(
      replacement,
      GAME_EVENTS.STATE_UPDATE,
    );
    const resumedRole = waitForEvent<WordImpostorRoleAssignmentPayload>(
      replacement,
      WORD_IMPOSTOR_EVENTS.ROLE_ASSIGNMENT,
    );
    const reconnectResult = await emitWithAck<PlayerReconnectedPayload>(
      replacement,
      CONNECTION_EVENTS.RECONNECT,
      {
        roomCode,
        playerId: guestJoin.data.playerId,
        reconnectToken: guestJoin.data.reconnectToken,
      },
    );
    assert.equal(reconnectResult.ok, true);
    assert.equal((await resumedStart).session.id, sessionId);
    assert.equal((await resumedState).sessionId, sessionId);
    assert.deepEqual(await resumedRole, guestRole);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(roleCounts, [1, 1, 1]);
  });

test("repeated join attempts are rate-limited independently of room capacity", async (t) => {
  const { url } = await createTestServer(t);
  const clients: TestClient[] = [];
  t.after(() => {
    for (const client of clients) {
      client.disconnect();
    }
  });
  const host = await connectClient(url, clients);
  const createResult = await emitWithAck<CreateRoomResponse>(
    host,
    ROOM_EVENTS.CREATE,
    {
      nickname: "Host",
      settings: {
        gameMode: "impostor-classic",
        maxPlayers: 12,
        isPrivate: false,
      },
    },
  );
  assert.equal(createResult.ok, true);
  if (!createResult.ok) {
    return;
  }

  for (let attempt = 0; attempt < 13; attempt += 1) {
    const client = await connectClient(url, clients);
    const result: SocketAcknowledgement<JoinRoomResponse> =
      await emitWithAck<JoinRoomResponse>(
      client,
      ROOM_EVENTS.JOIN,
      {
        roomCode: createResult.data.room.code,
        nickname: `Guest ${attempt}`,
      },
    );
    if (attempt < 11) {
      assert.equal(result.ok, true);
    } else if (attempt === 11) {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "ROOM_FULL");
      }
    } else {
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.match(result.error.message, /Too many attempts/);
      }
    }
  }
});
