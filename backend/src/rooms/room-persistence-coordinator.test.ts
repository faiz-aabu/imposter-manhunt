import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { RoomPersistenceCoordinator } from "./room-persistence-coordinator.js";
import type { RoomPersistenceMetadata } from "./room-persistence-coordinator.js";

function createdRoom(
  roomCode = "ABCD",
  roomId: string = randomUUID(),
  version = "1",
): {
  roomCode: string;
  roomId: string;
  gameMode: "impostor-classic";
  hostPlayerId: string;
  lifecycleStatus: "active";
  currentGameId: null;
  version: string;
} {
  return {
    roomCode,
    roomId,
    gameMode: "impostor-classic",
    hostPlayerId: randomUUID(),
    lifecycleStatus: "active",
    currentGameId: null,
    version,
  };
}

function registeredRoom(
  coordinator: RoomPersistenceCoordinator,
  roomCode = "ABCD",
  roomId: string = randomUUID(),
  version = "1",
): RoomPersistenceMetadata {
  return coordinator.registerCreatedRoom(createdRoom(roomCode, roomId, version));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("registers newly created and recovered durable rooms", () => {
  const coordinator = new RoomPersistenceCoordinator();
  const created = createdRoom("ABCD");
  assert.deepEqual(coordinator.registerCreatedRoom(created), {
    roomCode: "ABCD",
    roomId: created.roomId,
    version: "1",
    gameStatus: "waiting",
    currentGameId: null,
    lifecycleStatus: "active",
  });

  const recovered = {
    roomCode: "EFGH",
    roomId: randomUUID(),
    version: "9007199254740993",
    gameStatus: "waiting" as const,
    currentGameId: null,
    lifecycleStatus: "active" as const,
  };
  assert.deepEqual(coordinator.registerRecoveredRoom(recovered), recovered);
});

test("rejects duplicate room codes and durable room IDs", () => {
  const coordinator = new RoomPersistenceCoordinator();
  const first = createdRoom("ABCD");
  coordinator.registerCreatedRoom(first);

  assert.throws(
    () => coordinator.registerCreatedRoom(createdRoom("ABCD")),
    /Room code is already registered/,
  );
  assert.throws(
    () => coordinator.registerCreatedRoom(createdRoom("EFGH", first.roomId)),
    /Durable room ID is already registered/,
  );
});

test("returns defensive metadata copies", () => {
  const coordinator = new RoomPersistenceCoordinator();
  const registered = registeredRoom(coordinator);

  Reflect.set(registered, "version", "99");
  const fetched = coordinator.getMetadata("ABCD");
  assert.equal(fetched?.version, "1");
  assert.notEqual(fetched, registered);
});

test("uses BigInt to validate exactly one decimal-string version increment", () => {
  const coordinator = new RoomPersistenceCoordinator();
  const created = createdRoom("ABCD", randomUUID(), "9007199254740993");
  coordinator.registerCreatedRoom(created);

  assert.throws(
    () => coordinator.recordCommittedMutation("ABCD", created.version, {
      roomCode: created.roomCode,
      roomId: created.roomId,
      version: "9007199254740995",
    }),
    /advance the version exactly once/,
  );
  assert.equal(coordinator.getMetadata("ABCD")?.version, created.version);

  const updated = coordinator.recordCommittedMutation("ABCD", created.version, {
    roomCode: created.roomCode,
    roomId: created.roomId,
    version: "9007199254740994",
    gameStatus: "starting",
    currentGameId: randomUUID(),
  });
  assert.equal(updated?.version, "9007199254740994");
  assert.equal(updated?.gameStatus, "starting");
  assert.notEqual(updated?.currentGameId, null);
});

test("rejects stale expected versions without changing metadata", () => {
  const coordinator = new RoomPersistenceCoordinator();
  const created = createdRoom();
  coordinator.registerCreatedRoom(created);

  assert.throws(
    () => coordinator.recordCommittedMutation("ABCD", "2", {
      roomCode: "ABCD",
      roomId: created.roomId,
      version: "3",
    }),
    /stale expected version/,
  );
  assert.equal(coordinator.getMetadata("ABCD")?.version, "1");
});

test("does not advance metadata when an exclusive database callback rejects", async () => {
  const coordinator = new RoomPersistenceCoordinator();
  registeredRoom(coordinator);

  await assert.rejects(
    coordinator.runExclusive("ABCD", async () => {
      throw new Error("database write failed");
    }),
    /database write failed/,
  );
  assert.equal(coordinator.getMetadata("ABCD")?.version, "1");
  assert.equal(coordinator.pendingRoomQueueCount, 0);
});

test("removes metadata after a confirmed deletion without requiring a next version", () => {
  const coordinator = new RoomPersistenceCoordinator();
  const created = createdRoom();
  coordinator.registerCreatedRoom(created);

  const result = coordinator.recordCommittedMutation("ABCD", "1", {
    roomCode: "ABCD",
    roomId: created.roomId,
    deleted: true,
  });
  assert.equal(result, undefined);
  assert.equal(coordinator.getMetadata("ABCD"), undefined);
  assert.deepEqual(coordinator.registerCreatedRoom(created), {
    roomCode: "ABCD",
    roomId: created.roomId,
    version: "1",
    gameStatus: "waiting",
    currentGameId: null,
    lifecycleStatus: "active",
  });
});

test("retires only the fenced expired identity and permits safe room-code reuse", () => {
  const coordinator = new RoomPersistenceCoordinator();
  const expired = createdRoom("ABCD");
  coordinator.registerCreatedRoom(expired);
  coordinator.recordCommittedMutation("ABCD", "1", {
    roomCode: "ABCD",
    roomId: expired.roomId,
    version: "2",
    lifecycleStatus: "expired",
  });
  coordinator.fenceRoom("ABCD", expired.roomId);

  assert.throws(
    () => coordinator.removeExpiredRoom("ABCD", randomUUID(), "2"),
    /Expired room identity changed/,
  );
  assert.equal(coordinator.getMetadata("ABCD")?.roomId, expired.roomId);

  coordinator.removeExpiredRoom("ABCD", expired.roomId, "2");
  assert.equal(coordinator.getMetadata("ABCD"), undefined);
  assert.equal(coordinator.isFenced("ABCD"), false);
  const replacement = createdRoom("ABCD");
  assert.notEqual(replacement.roomId, expired.roomId);
  assert.equal(
    coordinator.registerCreatedRoom(replacement).roomId,
    replacement.roomId,
  );
});

test("serializes operations for one room in FIFO order", async () => {
  const coordinator = new RoomPersistenceCoordinator();
  registeredRoom(coordinator);
  const firstEntered = deferred<void>();
  const releaseFirst = deferred<void>();
  const order: string[] = [];

  const first = coordinator.runExclusive("ABCD", async () => {
    order.push("first-start");
    firstEntered.resolve();
    await releaseFirst.promise;
    order.push("first-end");
  });
  await firstEntered.promise;
  const second = coordinator.runExclusive("ABCD", () => {
    order.push("second");
  });

  assert.deepEqual(order, ["first-start"]);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("allows different rooms to execute concurrently", async () => {
  const coordinator = new RoomPersistenceCoordinator();
  registeredRoom(coordinator, "ABCD");
  registeredRoom(coordinator, "EFGH");
  const firstEntered = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondEntered = deferred<void>();

  const first = coordinator.runExclusive("ABCD", async () => {
    firstEntered.resolve();
    await releaseFirst.promise;
  });
  await firstEntered.promise;
  const second = coordinator.runExclusive("EFGH", () => {
    secondEntered.resolve();
  });
  await secondEntered.promise;

  releaseFirst.resolve();
  await Promise.all([first, second]);
});

test("continues a room queue after an operation rejects", async () => {
  const coordinator = new RoomPersistenceCoordinator();
  registeredRoom(coordinator);
  const order: string[] = [];
  const failed = coordinator.runExclusive("ABCD", () => {
    order.push("failed");
    throw new Error("operation failed");
  });
  const next = coordinator.runExclusive("ABCD", () => {
    order.push("next");
  });

  await assert.rejects(failed, /operation failed/);
  await next;
  assert.deepEqual(order, ["failed", "next"]);
  assert.equal(coordinator.pendingRoomQueueCount, 0);
});

test("does not run queued work against a room code reused after deletion", async () => {
  const coordinator = new RoomPersistenceCoordinator();
  const original = registeredRoom(coordinator);
  const entered = deferred<void>();
  const release = deferred<void>();
  let replacementOperationRan = false;

  const deletion = coordinator.runExclusive("ABCD", async () => {
    entered.resolve();
    await release.promise;
    coordinator.removeDeletedRoom("ABCD", "1", {
      roomCode: "ABCD",
      roomId: original.roomId,
      deleted: true,
    });
    coordinator.registerCreatedRoom(createdRoom("ABCD"));
  });
  await entered.promise;
  const staleOperation = coordinator.runExclusive("ABCD", () => {
    replacementOperationRan = true;
  });

  release.resolve();
  await deletion;
  await assert.rejects(staleOperation, /room was replaced/);
  assert.equal(replacementOperationRan, false);
  assert.equal(coordinator.pendingRoomQueueCount, 0);
});

test("removes queue entries after successful operations", async () => {
  const coordinator = new RoomPersistenceCoordinator();
  registeredRoom(coordinator);

  await coordinator.runExclusive("ABCD", () => "complete");
  assert.equal(coordinator.pendingRoomQueueCount, 0);
});

test("retries known admission-capacity rejection once capacity is released", async () => {
  const coordinator = new RoomPersistenceCoordinator();
  registeredRoom(coordinator);
  registeredRoom(coordinator, "EFGH");
  const entered = deferred<void>();
  const release = deferred<void>();
  const first = coordinator.runExclusive("ABCD", async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const queued = Array.from({ length: 127 }, () =>
    coordinator.runExclusive("ABCD", () => undefined),
  );
  await assert.rejects(
    coordinator.runExclusive("ABCD", () => undefined),
    /Room operation queue is full/,
  );

  let attempts = 0;
  const deferredOperation = coordinator.runExclusiveWithCapacityRetry(
    "ABCD",
    () => {
      attempts += 1;
      return "processed";
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts, 0);

  await coordinator.runExclusive("EFGH", () => "independent room");
  release.resolve();
  const [firstResult, ...queuedResults] = await Promise.all([
    first,
    ...queued,
    deferredOperation,
  ]);
  assert.equal(firstResult, undefined);
  assert.equal(queuedResults.at(-1), "processed");
  assert.equal(attempts, 1);
  assert.equal(coordinator.pendingRoomQueueCount, 0);
});

test("does not infer a committed version from an operation return value", async () => {
  const coordinator = new RoomPersistenceCoordinator();
  const created = registeredRoom(coordinator);

  await coordinator.runExclusive("ABCD", (metadata) => ({
    ...metadata,
    version: "2",
  }));
  assert.equal(coordinator.getMetadata("ABCD")?.version, "1");
  assert.equal(created.version, "1");
});

test("rejects malformed room UUIDs and decimal versions", () => {
  const coordinator = new RoomPersistenceCoordinator();
  assert.throws(
    () => coordinator.registerCreatedRoom(createdRoom("ABCD", "not-a-uuid")),
    /must be a UUID/,
  );
  assert.throws(
    () => coordinator.registerCreatedRoom(createdRoom("ABCD", randomUUID(), "01")),
    /positive decimal string/,
  );
});
