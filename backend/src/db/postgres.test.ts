import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { Pool } from "pg";
import type { PoolClient, PoolConfig } from "pg";
import {
  acquireRoomRuntimeLease,
  createPostgresPool,
  RoomRuntimeLeaseLostError,
  RoomRuntimeLeaseReleaseError,
  RoomRuntimeLeaseUnavailableError,
  withPostgresTransaction,
} from "./postgres.js";

interface QueryCall {
  text: string;
  values?: unknown[];
}

function createMockPool(
  queryFailure?: (text: string) => Error | undefined,
) {
  const calls: QueryCall[] = [];
  let releaseCount = 0;
  let connectCount = 0;
  const client = {
    async query(text: string, values?: unknown[]) {
      calls.push({ text, values });
      const error = queryFailure?.(text);
      if (error) {
        throw error;
      }
      return { rows: [] };
    },
    release() {
      releaseCount += 1;
    },
  } as unknown as PoolClient;
  const pool: Pick<Pool, "connect"> = {
    async connect() {
      connectCount += 1;
      return client;
    },
  };

  return {
    pool,
    client,
    calls,
    get connectCount() {
      return connectCount;
    },
    get releaseCount() {
      return releaseCount;
    },
  };
}

interface LeaseMockOptions {
  acquired?: boolean;
  unlocked?: boolean;
  queryFailure?: {
    statement: "acquire" | "epoch" | "health" | "unlock";
    error: Error;
  };
  lockHeld?: boolean;
  reportedEpoch?: string;
}

function createMockLeasePool(options: LeaseMockOptions = {}) {
  const calls: QueryCall[] = [];
  const queriedClients: object[] = [];
  const releaseArguments: (Error | boolean | undefined)[] = [];
  let releaseCount = 0;
  let poolQueryCount = 0;
  let epoch = 0;
  const client = Object.assign(new EventEmitter(), {
    async query(this: object, text: string, values?: unknown[]) {
      calls.push({ text, values });
      queriedClients.push(this);
      if (
        options.queryFailure?.statement === "acquire"
        && text.includes("pg_try_advisory_lock")
      ) {
        throw options.queryFailure.error;
      }
      if (
        options.queryFailure?.statement === "unlock"
        && text.includes("pg_advisory_unlock")
      ) {
        throw options.queryFailure.error;
      }
      if (
        options.queryFailure?.statement === "epoch"
        && text.includes("UPDATE public.room_runtime_fencing")
      ) {
        throw options.queryFailure.error;
      }
      if (
        options.queryFailure?.statement === "health"
        && text.includes("pg_catalog.pg_locks")
      ) {
        throw options.queryFailure.error;
      }
      if (text.includes("pg_try_advisory_lock")) {
        return { rows: [{ acquired: options.acquired ?? true }] };
      }
      if (text.includes("UPDATE public.room_runtime_fencing")) {
        epoch += 1;
        return { rows: [{ epoch: String(epoch) }] };
      }
      if (text.includes("pg_catalog.pg_locks")) {
        return {
          rows: [{
            epoch: options.reportedEpoch ?? String(epoch),
            lock_held: options.lockHeld ?? true,
          }],
        };
      }
      if (text.includes("pg_advisory_unlock")) {
        return { rows: [{ unlocked: options.unlocked ?? true }] };
      }
      return { rows: [] };
    },
    release(error?: Error | boolean) {
      releaseCount += 1;
      releaseArguments.push(error);
    },
  }) as unknown as PoolClient;
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      poolQueryCount += 1;
      throw new Error("Pool.query must not be used for session advisory locks.");
    },
  } as unknown as Pick<Pool, "connect"> & {
    query: (...args: unknown[]) => Promise<unknown>;
  };

  return {
    pool,
    client,
    calls,
    queriedClients,
    releaseArguments,
    get releaseCount() {
      return releaseCount;
    },
    get poolQueryCount() {
      return poolQueryCount;
    },
  };
}

test("creates a pool from injected config and registers idle-client errors", async () => {
  const config: PoolConfig = {
    host: "127.0.0.1",
    port: 55432,
    database: "injected_database",
    user: "injected_user",
    password: "unused-test-password",
    max: 3,
  };
  const idleErrorHandler = () => {};
  const pool = createPostgresPool(config, idleErrorHandler);

  try {
    assert.equal(pool.options.host, config.host);
    assert.equal(pool.options.port, config.port);
    assert.equal(pool.options.database, config.database);
    assert.equal(pool.options.user, config.user);
    assert.equal(pool.listenerCount("error"), 1);
    assert.equal(pool.listeners("error")[0], idleErrorHandler);
  } finally {
    await pool.end();
  }
});

test("commits on the checked-out client and releases it after success", async () => {
  const mock = createMockPool();

  const result = await withPostgresTransaction(mock.pool, async (client) => {
    assert.strictEqual(client, mock.client);
    await client.query(
      "INSERT INTO transaction_test (value) VALUES ($1)",
      ["committed"],
    );
    return "done";
  });

  assert.equal(result, "done");
  assert.equal(mock.connectCount, 1);
  assert.deepEqual(
    mock.calls.map(({ text }) => text),
    [
      "BEGIN",
      "INSERT INTO transaction_test (value) VALUES ($1)",
      "COMMIT",
    ],
  );
  assert.deepEqual(mock.calls[1].values, ["committed"]);
  assert.equal(mock.releaseCount, 1);
});

test("rolls back callback failures on the same client and releases it", async () => {
  const mock = createMockPool();
  const operationError = new Error("operation failed");

  await assert.rejects(
    withPostgresTransaction(mock.pool, async (client) => {
      assert.strictEqual(client, mock.client);
      await client.query(
        "INSERT INTO transaction_test (value) VALUES ($1)",
        ["rolled back"],
      );
      throw operationError;
    }),
    (error) => error === operationError,
  );

  assert.equal(mock.connectCount, 1);
  assert.deepEqual(
    mock.calls.map(({ text }) => text),
    [
      "BEGIN",
      "INSERT INTO transaction_test (value) VALUES ($1)",
      "ROLLBACK",
    ],
  );
  assert.deepEqual(mock.calls[1].values, ["rolled back"]);
  assert.equal(mock.releaseCount, 1);
});

test("reports both the operation and rollback failures without losing the original", async () => {
  const rollbackError = new Error("rollback failed");
  const operationError = new Error("operation failed");
  const mock = createMockPool((text) =>
    text === "ROLLBACK" ? rollbackError : undefined,
  );

  await assert.rejects(
    withPostgresTransaction(mock.pool, async () => {
      throw operationError;
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(
        error.message,
        "PostgreSQL transaction failed and rollback also failed",
      );
      assert.strictEqual(error.cause, operationError);
      assert.deepEqual(error.errors, [operationError, rollbackError]);
      return true;
    },
  );

  assert.deepEqual(
    mock.calls.map(({ text }) => text),
    ["BEGIN", "ROLLBACK"],
  );
  assert.equal(mock.releaseCount, 1);
});

test("acquires and releases the room-runtime lease on the same client", async () => {
  const mock = createMockLeasePool();
  const lease = await acquireRoomRuntimeLease(mock.pool);

  assert.equal(mock.calls.length, 4);
  assert.match(mock.calls[0]?.text ?? "", /pg_try_advisory_lock\(\$1, \$2\)/);
  const acquisitionStatements = mock.calls.slice(1).map(({ text }) => text);
  assert.equal(acquisitionStatements[0], "BEGIN");
  assert.match(acquisitionStatements[1] ?? "", /UPDATE public\.room_runtime_fencing/);
  assert.equal(acquisitionStatements[2], "COMMIT");
  assert.equal(mock.calls[0]?.values?.length, 2);
  assert.ok(mock.calls[0]?.values?.every(Number.isInteger));
  assert.equal(lease.fencingEpoch, "1");
  await lease.checkOwnership();
  assert.equal(mock.calls.length, 5);

  await lease.release();

  assert.equal(mock.calls.length, 6);
  assert.match(mock.calls[5]?.text ?? "", /pg_advisory_unlock\(\$1, \$2\)/);
  assert.deepEqual(mock.calls[5]?.values, mock.calls[0]?.values);
  assert.equal(
    mock.queriedClients.every((queriedClient) => queriedClient === mock.client),
    true,
  );
  assert.equal(mock.releaseCount, 1);
  assert.equal(mock.poolQueryCount, 0);
});

test("release is idempotent and only unlocks and returns the client once", async () => {
  const mock = createMockLeasePool();
  const lease = await acquireRoomRuntimeLease(mock.pool);

  const firstRelease = lease.release();
  const secondRelease = lease.release();
  assert.strictEqual(secondRelease, firstRelease);
  await Promise.all([firstRelease, secondRelease]);

  assert.equal(
    mock.calls.filter(({ text }) => text.includes("pg_advisory_unlock")).length,
    1,
  );
  assert.equal(mock.releaseCount, 1);
  assert.equal(mock.poolQueryCount, 0);
});

test("a held lease rejects another acquisition and returns its client", async () => {
  const mock = createMockLeasePool({ acquired: false });

  await assert.rejects(
    acquireRoomRuntimeLease(mock.pool),
    RoomRuntimeLeaseUnavailableError,
  );

  assert.equal(mock.calls.length, 1);
  assert.deepEqual(mock.releaseArguments, [false]);
  assert.equal(mock.poolQueryCount, 0);
});

test("an acquisition database error remains observable and destroys the client", async () => {
  const databaseError = new Error("advisory lock query failed");
  const mock = createMockLeasePool({
    queryFailure: { statement: "acquire", error: databaseError },
  });

  await assert.rejects(
    acquireRoomRuntimeLease(mock.pool),
    (error) => error === databaseError,
  );

  assert.deepEqual(mock.releaseArguments, [true]);
  assert.equal(mock.poolQueryCount, 0);
});

test("fencing epoch acquisition failure releases and destroys the lease client", async () => {
  const mock = createMockLeasePool({
    queryFailure: {
      statement: "epoch",
      error: new Error("private epoch update detail"),
    },
  });

  await assert.rejects(
    acquireRoomRuntimeLease(mock.pool),
    (error) =>
      error instanceof RoomRuntimeLeaseLostError
      && error.reason === "fencing_epoch_acquisition_failed"
      && !error.message.includes("private epoch update detail"),
  );

  assert.deepEqual(mock.releaseArguments, [true]);
  assert.equal(mock.poolQueryCount, 0);
});

test("a false unlock result reports a release failure and returns the client", async () => {
  const mock = createMockLeasePool({ unlocked: false });
  const lease = await acquireRoomRuntimeLease(mock.pool);

  await assert.rejects(
    lease.release(),
    RoomRuntimeLeaseReleaseError,
  );

  assert.equal(mock.calls.length, 5);
  assert.deepEqual(mock.calls[4]?.values, mock.calls[0]?.values);
  assert.deepEqual(mock.releaseArguments, [true]);
  assert.equal(mock.poolQueryCount, 0);
});

test("an unlock database error remains observable and destroys the client", async () => {
  const databaseError = new Error("advisory unlock query failed");
  const mock = createMockLeasePool({
    queryFailure: { statement: "unlock", error: databaseError },
  });
  const lease = await acquireRoomRuntimeLease(mock.pool);

  await assert.rejects(
    lease.release(),
    (error) => error === databaseError,
  );

  assert.deepEqual(mock.releaseArguments, [true]);
  assert.equal(mock.poolQueryCount, 0);
});

test("lease health checks the retained advisory-lock connection and epoch", async () => {
  const mock = createMockLeasePool();
  const lease = await acquireRoomRuntimeLease(mock.pool);

  await lease.checkOwnership();

  assert.match(mock.calls[4]?.text ?? "", /pg_catalog\.pg_locks/);
  assert.match(mock.calls[4]?.text ?? "", /room_runtime_fencing/);
  assert.equal(mock.queriedClients.every((client) => client === mock.client), true);
  await lease.release();
});

test("connection errors and termination notify lease loss only once", async () => {
  const mock = createMockLeasePool();
  const lease = await acquireRoomRuntimeLease(mock.pool);
  const losses: RoomRuntimeLeaseLostError[] = [];
  lease.onLost((error) => losses.push(error));

  mock.client.emit("error", new Error("private connection detail"));
  mock.client.emit("end");

  assert.equal(losses.length, 1);
  assert.equal(losses[0]?.reason, "lease_connection_error");
  assert.equal(losses[0]?.message.includes("private connection detail"), false);
  await assert.rejects(lease.checkOwnership(), RoomRuntimeLeaseLostError);
  await lease.release();
});

test("connection termination is treated as lease loss", async () => {
  const mock = createMockLeasePool();
  const lease = await acquireRoomRuntimeLease(mock.pool);
  const losses: RoomRuntimeLeaseLostError[] = [];
  lease.onLost((error) => losses.push(error));

  mock.client.emit("end");

  assert.equal(losses.length, 1);
  assert.equal(losses[0]?.reason, "lease_connection_ended");
  await lease.release();
});

test("an uncertain ownership check fails closed and reports only a safe code", async () => {
  const healthFailure = Object.assign(new Error("private query detail"), {
    code: "08006",
  });
  const mock = createMockLeasePool({
    queryFailure: { statement: "health", error: healthFailure },
  });
  const lease = await acquireRoomRuntimeLease(mock.pool);
  const losses: RoomRuntimeLeaseLostError[] = [];
  lease.onLost((error) => losses.push(error));

  await assert.rejects(
    lease.checkOwnership(),
    (error) => {
      assert.ok(error instanceof RoomRuntimeLeaseLostError);
      assert.equal(error.reason, "lease_health_check_failed");
      assert.equal(error.code, "08006");
      assert.equal(error.message.includes("private query detail"), false);
      return true;
    },
  );
  assert.equal(losses.length, 1);
  await lease.release();
});

test("a missing advisory lock fails the ownership check", async () => {
  const mock = createMockLeasePool({ lockHeld: false });
  const lease = await acquireRoomRuntimeLease(mock.pool);

  await assert.rejects(
    lease.checkOwnership(),
    (error) =>
      error instanceof RoomRuntimeLeaseLostError
      && error.reason === "advisory_lock_missing",
  );
  await lease.release();
});

test("a changed fencing epoch fails the ownership check", async () => {
  const mock = createMockLeasePool({ reportedEpoch: "2" });
  const lease = await acquireRoomRuntimeLease(mock.pool);

  await assert.rejects(
    lease.checkOwnership(),
    (error) =>
      error instanceof RoomRuntimeLeaseLostError
      && error.reason === "fencing_epoch_changed",
  );
  await lease.release();
});

const runtimeLeaseIntegrationEnabled =
  process.env.DURABLE_ROOM_CI_DATABASE === "1";
const runtimeLeaseTestDatabase = runtimeLeaseIntegrationEnabled
  ? process.env.ROOM_RUNTIME_LEASE_TEST_DATABASE
  : undefined;
const runtimeLeaseTestUser = runtimeLeaseIntegrationEnabled
  ? process.env.ROOM_RUNTIME_LEASE_TEST_USER
  : undefined;

test(
  "an exclusive lease is shared across independent PostgreSQL connections",
  {
    skip: !runtimeLeaseTestDatabase || !runtimeLeaseTestUser,
  },
  async (t) => {
    if (!runtimeLeaseTestDatabase || !runtimeLeaseTestUser) {
      return;
    }

    const config: PoolConfig = {
      host: "127.0.0.1",
      port: 55432,
      database: runtimeLeaseTestDatabase,
      user: runtimeLeaseTestUser,
      max: 1,
    };
    const poolA = createPostgresPool(config);
    const poolB = createPostgresPool(config);
    let leaseA: Awaited<ReturnType<typeof acquireRoomRuntimeLease>> | undefined;
    let leaseB: Awaited<ReturnType<typeof acquireRoomRuntimeLease>> | undefined;

    const getBackendPid = async (pool: Pool): Promise<number> => {
      const client = await pool.connect();
      try {
        const result = await client.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const pid = result.rows[0]?.pid;
        if (pid === undefined) {
          throw new Error("PostgreSQL did not return a backend process ID.");
        }
        return pid;
      } finally {
        client.release();
      }
    };

    try {
      const [pidA, pidB] = await Promise.all([
        getBackendPid(poolA),
        getBackendPid(poolB),
      ]);
      assert.notEqual(pidA, pidB);

      leaseA = await acquireRoomRuntimeLease(poolA);
      await assert.rejects(
        acquireRoomRuntimeLease(poolB),
        RoomRuntimeLeaseUnavailableError,
      );

      await leaseA.release();
      leaseA = undefined;
      leaseB = await acquireRoomRuntimeLease(poolB);
      await leaseB.release();
      leaseB = undefined;
    } finally {
      if (leaseA) {
        await leaseA.release();
      }
      if (leaseB) {
        await leaseB.release();
      }
      await Promise.all([poolA.end(), poolB.end()]);
    }
  },
);
