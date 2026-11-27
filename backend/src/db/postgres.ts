import { Pool } from "pg";
import type { PoolClient, PoolConfig } from "pg";

export type IdleClientErrorHandler = (
  error: Error,
  client: PoolClient,
) => void;

export function createPostgresPool(
  config: PoolConfig,
  onIdleClientError?: IdleClientErrorHandler,
): Pool {
  const pool = new Pool(config);
  if (onIdleClientError) {
    pool.on("error", onIdleClientError);
  }
  return pool;
}

// Reserved pair 0x524F4F4D ("ROOM") and 0x52554E54 ("RUNT") identifies this
// application's single live room runtime across backend instances.
const ROOM_RUNTIME_LOCK_KEY_1 = 0x524F4F4D;
const ROOM_RUNTIME_LOCK_KEY_2 = 0x52554E54;

export class RoomRuntimeLeaseUnavailableError extends Error {
  constructor() {
    super("Another backend instance already owns the room runtime lease.");
    this.name = "RoomRuntimeLeaseUnavailableError";
  }
}

export class RoomRuntimeLeaseReleaseError extends Error {
  constructor() {
    super("PostgreSQL did not release the room runtime advisory lock.");
    this.name = "RoomRuntimeLeaseReleaseError";
  }
}

export class RoomRuntimeLeaseLostError extends Error {
  constructor(
    readonly reason: string,
    readonly code?: string,
  ) {
    super(
      code
        ? `Room runtime lease ownership is uncertain (${reason}; ${code}).`
        : `Room runtime lease ownership is uncertain (${reason}).`,
    );
    this.name = "RoomRuntimeLeaseLostError";
  }
}

export interface RoomRuntimeLease {
  readonly fencingEpoch: string;
  checkOwnership(): Promise<void>;
  onLost(listener: (error: RoomRuntimeLeaseLostError) => void): () => void;
  release(): Promise<void>;
}

function releaseClientAndRethrow(
  client: PoolClient,
  error: unknown,
  destroy: boolean,
): never {
  try {
    client.release(destroy);
  } catch (releaseError) {
    throw new AggregateError(
      [error, releaseError],
      "Room runtime lease acquisition failed and its client could not be released",
      { cause: error },
    );
  }
  throw error;
}

function safeDatabaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const { code } = error;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
    ? code
    : undefined;
}

async function incrementRoomRuntimeFencingEpoch(
  client: PoolClient,
): Promise<string> {
  await client.query("BEGIN");
  try {
    const result = await client.query<{ epoch: string }>(
      `UPDATE public.room_runtime_fencing
       SET epoch = epoch + 1
       WHERE singleton_id = 1
       RETURNING epoch::text`,
    );
    const epoch = result.rows[0]?.epoch;
    if (!epoch || !/^[1-9]\d*$/.test(epoch)) {
      throw new Error("PostgreSQL did not return a valid room-runtime fencing epoch.");
    }
    await client.query("COMMIT");
    return epoch;
  } catch (operationError) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [operationError, rollbackError],
        "Room-runtime fencing epoch update and rollback both failed.",
        { cause: operationError },
      );
    }
    throw operationError;
  }
}

/**
 * The returned session lease owns both the advisory lock and a database-backed
 * fencing epoch. Its owner must keep the connection for the runtime lifetime,
 * monitor it, and reject writes after ownership becomes uncertain.
 */
export async function acquireRoomRuntimeLease(
  pool: Pick<Pool, "connect">,
): Promise<RoomRuntimeLease> {
  const client = await pool.connect();
  let acquired: boolean | undefined;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      [ROOM_RUNTIME_LOCK_KEY_1, ROOM_RUNTIME_LOCK_KEY_2],
    );
    acquired = result.rows[0]?.acquired;
  } catch (error) {
    return releaseClientAndRethrow(client, error, true);
  }

  if (acquired === false) {
    const error = new RoomRuntimeLeaseUnavailableError();
    return releaseClientAndRethrow(client, error, false);
  }
  if (acquired !== true) {
    const error = new Error("PostgreSQL did not report the advisory lock result.");
    return releaseClientAndRethrow(client, error, true);
  }

  let fencingEpoch: string;
  try {
    fencingEpoch = await incrementRoomRuntimeFencingEpoch(client);
  } catch (error) {
    return releaseClientAndRethrow(
      client,
      new RoomRuntimeLeaseLostError(
        "fencing_epoch_acquisition_failed",
        safeDatabaseErrorCode(error),
      ),
      true,
    );
  }

  const lostListeners = new Set<
    (error: RoomRuntimeLeaseLostError) => void
  >();
  let lostError: RoomRuntimeLeaseLostError | undefined;
  let released = false;
  const handleClientError = (error: Error) => {
    notifyLost("lease_connection_error", error);
  };
  const handleClientEnd = () => {
    notifyLost("lease_connection_ended");
  };
  const detachConnectionListeners = () => {
    client.off("error", handleClientError);
    client.off("end", handleClientEnd);
  };
  const notifyLost = (
    reason: string,
    error?: unknown,
  ): RoomRuntimeLeaseLostError => {
    if (lostError) {
      return lostError;
    }
    lostError = new RoomRuntimeLeaseLostError(
      reason,
      safeDatabaseErrorCode(error),
    );
    for (const listener of lostListeners) {
      listener(lostError);
    }
    lostListeners.clear();
    return lostError;
  };

  client.on("error", handleClientError);
  client.on("end", handleClientEnd);

  let releasePromise: Promise<void> | undefined;
  return {
    fencingEpoch,
    async checkOwnership(): Promise<void> {
      if (lostError) {
        throw lostError;
      }
      if (released) {
        throw new RoomRuntimeLeaseLostError("lease_already_released");
      }

      let result;
      try {
        result = await client.query<{
          epoch: string;
          lock_held: boolean;
        }>(
          `SELECT runtime.epoch::text AS epoch,
                  EXISTS (
                    SELECT 1
                    FROM pg_catalog.pg_locks AS lock
                    WHERE lock.locktype = 'advisory'
                      AND lock.pid = pg_backend_pid()
                      AND lock.classid = $1::oid
                      AND lock.objid = $2::oid
                      AND lock.objsubid = 2
                      AND lock.mode = 'ExclusiveLock'
                      AND lock.granted
                  ) AS lock_held
           FROM public.room_runtime_fencing AS runtime
           WHERE runtime.singleton_id = 1`,
          [ROOM_RUNTIME_LOCK_KEY_1, ROOM_RUNTIME_LOCK_KEY_2],
        );
      } catch (error) {
        throw notifyLost("lease_health_check_failed", error);
      }

      const status = result.rows[0];
      if (!status) {
        throw notifyLost("fencing_epoch_missing");
      }
      if (!status.lock_held) {
        throw notifyLost("advisory_lock_missing");
      }
      if (status.epoch !== fencingEpoch) {
        throw notifyLost("fencing_epoch_changed");
      }
    },
    onLost(listener): () => void {
      if (lostError) {
        listener(lostError);
        return () => {};
      }
      if (released) {
        listener(new RoomRuntimeLeaseLostError("lease_already_released"));
        return () => {};
      }
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
    release(): Promise<void> {
      if (!releasePromise) {
        released = true;
        detachConnectionListeners();
        lostListeners.clear();
        releasePromise = (async () => {
          let failed = false;
          let failure: unknown;
          try {
            const unlockResult = await client.query<{ unlocked: boolean }>(
              "SELECT pg_advisory_unlock($1, $2) AS unlocked",
              [ROOM_RUNTIME_LOCK_KEY_1, ROOM_RUNTIME_LOCK_KEY_2],
            );
            if (unlockResult.rows[0]?.unlocked !== true) {
              throw new RoomRuntimeLeaseReleaseError();
            }
          } catch (error) {
            failed = true;
            failure = error;
          }

          try {
            client.release(failed);
          } catch (releaseError) {
            if (failed) {
              throw new AggregateError(
                [failure, releaseError],
                "Room runtime lease release and client cleanup both failed",
                { cause: failure },
              );
            }
            throw releaseError;
          }

          if (failed) {
            throw failure;
          }
        })();
      }
      return releasePromise;
    },
  };
}

// All statements in a PostgreSQL transaction must use its checked-out client.
export async function withPostgresTransaction<T>(
  pool: Pick<Pool, "connect">,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (operationError) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError(
        [operationError, rollbackError],
        "PostgreSQL transaction failed and rollback also failed",
        { cause: operationError },
      );
    }

    throw operationError;
  } finally {
    client.release();
  }
}
