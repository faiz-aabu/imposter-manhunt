import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./env.js";

test("development config defaults to permissive origins and approved exposure durations", () => {
  const config = loadConfig({});

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.clientIpMode, "socket");
  assert.deepEqual(config.allowedOrigins, ["*"]);
  assert.equal(config.trustProxyHops, 0);
  assert.equal(config.requireHttps, false);
  assert.equal(config.guestProfiles, null);
  assert.deepEqual(config.lateGameExposureDurations, {
    clueDurationSeconds: 15,
    warningDurationSeconds: 5,
  });
});

test("late-game exposure configuration accepts only approved durations", () => {
  const configured = loadConfig({
    MANHUNT_LATE_GAME_CLUE_DURATION_SECONDS: "15",
    MANHUNT_LATE_GAME_WARNING_DURATION_SECONDS: "5",
  });
  assert.deepEqual(configured.lateGameExposureDurations, {
    clueDurationSeconds: 15,
    warningDurationSeconds: 5,
  });

  assert.throws(
    () =>
      loadConfig({
        MANHUNT_LATE_GAME_CLUE_DURATION_SECONDS: "23",
        MANHUNT_LATE_GAME_WARNING_DURATION_SECONDS: "7",
      }),
    /must match the approved configuration/,
  );
  assert.throws(
    () =>
      loadConfig({
        MANHUNT_LATE_GAME_CLUE_DURATION_SECONDS: "23",
      }),
    /must be configured together/,
  );
  assert.throws(
    () =>
      loadConfig({
        MANHUNT_LATE_GAME_WARNING_DURATION_SECONDS: "0",
      }),
    /must be a positive safe integer/,
  );
});

test("guest profile Supabase configuration is optional but validated when supplied", () => {
  const config = loadConfig({
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  });
  assert.deepEqual(config.guestProfiles, {
    url: "https://project.supabase.co",
    serviceRoleKey: "test-service-role-key",
  });

  assert.throws(
    () => loadConfig({ SUPABASE_URL: "https://project.supabase.co" }),
    /must be configured together/,
  );
  assert.throws(
    () =>
      loadConfig({
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      }),
    /must be configured together/,
  );
  assert.throws(
    () =>
      loadConfig({
        SUPABASE_URL: "https://project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "sb_publishable_test",
      }),
    /not a publishable key/,
  );
  assert.throws(
    () =>
      loadConfig({
        SUPABASE_URL: "http://project.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
      }),
    /HTTPS project origin/,
  );

  const localConfig = loadConfig({
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
  });
  assert.equal(localConfig.guestProfiles?.url, "http://127.0.0.1:54321");
});

test("socket proxy mode requires HTTPS origins and an explicit production hop count", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "production" }),
    /ALLOWED_ORIGINS must be configured/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        ALLOWED_ORIGINS: "*",
        TRUST_PROXY_HOPS: "1",
      }),
    /may use \* only by itself outside production/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        ALLOWED_ORIGINS: "http://game.example",
        TRUST_PROXY_HOPS: "1",
      }),
    /Production ALLOWED_ORIGINS entries must use HTTPS/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        ALLOWED_ORIGINS: "https://game.example",
      }),
    /TRUST_PROXY_HOPS must be at least 1/,
  );

  const config = loadConfig({
    NODE_ENV: "production",
    ALLOWED_ORIGINS: "https://game.example",
    TRUST_PROXY_HOPS: "1",
  });
  assert.deepEqual(config.allowedOrigins, ["https://game.example"]);
  assert.equal(config.trustProxyHops, 1);
  assert.equal(config.requireHttps, true);
});

test("Railway mode is explicit and does not use a proxy hop count", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    CLIENT_IP_MODE: "railway",
    RAILWAY_SERVICE_ID: "service-id",
    ALLOWED_ORIGINS: "https://game.example",
  });
  assert.equal(config.clientIpMode, "railway");
  assert.equal(config.trustProxyHops, 0);
  assert.equal(config.requireHttps, true);

  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        RAILWAY_SERVICE_ID: "service-id",
        ALLOWED_ORIGINS: "https://game.example",
        TRUST_PROXY_HOPS: "1",
      }),
    /CLIENT_IP_MODE=railway is required/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        CLIENT_IP_MODE: "railway",
        RAILWAY_SERVICE_ID: "service-id",
        ALLOWED_ORIGINS: "https://game.example",
        TRUST_PROXY_HOPS: "1",
      }),
    /TRUST_PROXY_HOPS must be unset/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "development",
        CLIENT_IP_MODE: "railway",
      }),
    /only valid in production/,
  );
  assert.throws(
    () => loadConfig({ CLIENT_IP_MODE: "proxy" }),
    /CLIENT_IP_MODE must be socket or railway/,
  );
});

test("environment and origin configuration reject invalid values", () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: "staging" }),
    /NODE_ENV must be development, test, or production/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "development",
        ALLOWED_ORIGINS: "https://game.example/path",
      }),
    /must contain only an HTTP or HTTPS origin/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "development",
        TRUST_PROXY_HOPS: "six",
      }),
    /TRUST_PROXY_HOPS must be an integer/,
  );
});
