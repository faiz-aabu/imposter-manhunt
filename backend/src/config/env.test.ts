import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "./env.js";

test("development config defaults to permissive origins and no trusted proxies", () => {
  const config = loadConfig({});

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.clientIpMode, "socket");
  assert.deepEqual(config.allowedOrigins, ["*"]);
  assert.equal(config.trustProxyHops, 0);
  assert.equal(config.requireHttps, false);
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
