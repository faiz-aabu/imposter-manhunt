import { existsSync } from "node:fs";
import { loadConfig } from "./config/env.js";
import { createBackendServer } from "./server.js";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const server = createBackendServer(loadConfig());
let isShuttingDown = false;

void server
  .listen()
  .then((address) => {
    console.info(
      JSON.stringify({
        level: "info",
        message: "Backend server listening.",
        port: address.port,
      }),
    );
  })
  .catch((error: unknown) => {
    console.error(
      JSON.stringify({
        level: "error",
        message: "Backend server failed to start.",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exitCode = 1;
  });

function shutdown(signal: NodeJS.Signals): void {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.info(
    JSON.stringify({
      level: "info",
      message: "Backend server shutting down.",
      signal,
    }),
  );

  void server
    .close()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          level: "error",
          message: "Backend server shutdown failed.",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exitCode = 1;
    });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
