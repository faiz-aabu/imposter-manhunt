import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const backendDirectory = resolve(scriptDirectory, "..");
const expectedEnvironment = {
  DURABLE_ROOM_CI_DATABASE: "1",
  ROOM_REPOSITORY_TEST_DATABASE: "durable_room_test",
  ROOM_REPOSITORY_TEST_USER: "postgres",
  ROOM_RUNTIME_FENCING_TEST_DATABASE: "durable_room_test",
  ROOM_RUNTIME_FENCING_TEST_USER: "postgres",
  ROOM_RUNTIME_LEASE_TEST_DATABASE: "durable_room_test",
  ROOM_RUNTIME_LEASE_TEST_USER: "postgres",
};

for (const [name, expected] of Object.entries(expectedEnvironment)) {
  if (process.env[name] !== expected) {
    console.error(
      `${name} must be set to ${JSON.stringify(expected)} for disposable PostgreSQL integration tests.`,
    );
    process.exitCode = 1;
    process.exit();
  }
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: backendDirectory,
    env: process.env,
    encoding: "utf8",
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

const migrationStatus = runNode([
  resolve(scriptDirectory, "prepare-durable-room-test-db.mjs"),
]);
if (migrationStatus !== 0) {
  process.exitCode = migrationStatus;
  process.exit();
}

const testFiles = [
  "src/db/postgres.test.ts",
  "src/rooms/postgres-room-repository.test.ts",
  "src/rooms/durable-room-runtime.test.ts",
  "src/rooms/postgres-room-expiration.integration.test.ts",
];
for (const testFile of testFiles) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-reporter=tap",
      testFile,
    ],
    {
      cwd: backendDirectory,
      env: process.env,
      encoding: "utf8",
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    process.exit();
  }

  const skipped = output.match(/^# skipped (\d+)$/m);
  if (!skipped) {
    console.error(`Could not verify the test summary for ${testFile}.`);
    process.exitCode = 1;
    process.exit();
  }
  if (Number(skipped[1]) !== 0) {
    console.error(
      `${testFile} must execute every integration case; found ${skipped[1]} skipped.`,
    );
    process.exitCode = 1;
    process.exit();
  }
}
