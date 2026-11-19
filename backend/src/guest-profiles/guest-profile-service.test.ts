import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { createBackendServer } from "../server.js";
import type { BackendServer } from "../server.js";
import type { BackendConfig } from "../config/env.js";
import { GuestProfileService } from "./guest-profile-service.js";

const TEST_SERVICE_ROLE_KEY = "test-service-role-key";
const TEST_CONFIG: BackendConfig = {
  port: 0,
  allowedOrigins: ["*"],
  reconnectGracePeriodMs: 5_000,
  nodeEnv: "test",
  clientIpMode: "socket",
  trustProxyHops: 0,
  requireHttps: false,
  guestProfiles: {
    url: "https://supabase.example",
    serviceRoleKey: TEST_SERVICE_ROLE_KEY,
  },
};

const TEST_PROFILE = {
  id: "c693bd38-4aeb-4f90-b2d8-cce00c41f71d",
  nickname: "Guest Player",
  created_at: "2026-11-19T10:00:00.000Z",
  updated_at: "2026-11-19T10:00:00.000Z",
};

async function startTestServer(
  context: TestContext,
  config: BackendConfig,
  service: GuestProfileService,
): Promise<{ server: BackendServer; url: string }> {
  const server = createBackendServer(config, undefined, service);
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Test HTTP server did not bind to a TCP port.");
  }
  context.after(() => server.close());
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function createJsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function getRequestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  if (input instanceof Request) {
    return new URL(input.url);
  }
  return new URL(input);
}

test("guest profile creation calls the atomic RPC with only the credential hash", async (t) => {
  let requestUrl: URL | undefined;
  let requestInit: RequestInit | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    requestUrl = getRequestUrl(input);
    requestInit = init;
    return createJsonResponse([TEST_PROFILE]);
  };
  const service = new GuestProfileService(TEST_CONFIG.guestProfiles, fetcher);
  const { url } = await startTestServer(t, TEST_CONFIG, service);

  const response = await fetch(`${url}/guest-profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname: "  Guest Player  " }),
  });
  assert.equal(response.status, 201);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("credential" in body) ||
    typeof body.credential !== "string" ||
    !("profile" in body)
  ) {
    throw new Error("Expected a credential in the creation response.");
  }
  const returnedCredential = body.credential;
  assert.match(returnedCredential, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(body.profile, {
    id: TEST_PROFILE.id,
    nickname: TEST_PROFILE.nickname,
    createdAt: TEST_PROFILE.created_at,
    updatedAt: TEST_PROFILE.updated_at,
  });

  assert.equal(requestUrl?.pathname, "/rest/v1/rpc/create_guest_profile");
  assert.equal(requestUrl?.search, "");
  assert.equal(requestInit?.method, "POST");
  assert.equal(
    new Headers(requestInit?.headers).get("authorization"),
    `Bearer ${TEST_SERVICE_ROLE_KEY}`,
  );
  assert.equal(
    new Headers(requestInit?.headers).get("apikey"),
    TEST_SERVICE_ROLE_KEY,
  );
  const requestBody = JSON.parse(String(requestInit?.body)) as {
    p_nickname: string;
    p_token_hash: string;
  };
  assert.equal(requestBody.p_nickname, "Guest Player");
  assert.match(requestBody.p_token_hash, /^\\x[a-f0-9]{64}$/);
  assert.equal(
    requestBody.p_token_hash,
    `\\x${createHash("sha256").update(returnedCredential).digest("hex")}`,
  );
  assert.equal(JSON.stringify(requestBody).includes(returnedCredential), false);
  assert.equal(JSON.stringify(body).includes(TEST_SERVICE_ROLE_KEY), false);
});

test("guest profile restoration returns only public guest profile fields", async (t) => {
  let requestUrl: URL | undefined;
  const fetcher: typeof fetch = async (input) => {
    requestUrl = getRequestUrl(input);
    return createJsonResponse([
      {
        profiles: TEST_PROFILE,
      },
    ]);
  };
  const service = new GuestProfileService(TEST_CONFIG.guestProfiles, fetcher);
  const { url } = await startTestServer(t, TEST_CONFIG, service);
  const credential = Buffer.alloc(32, 7).toString("base64url");
  const response = await fetch(`${url}/guest-profiles/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential }),
  });

  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert.deepEqual(body, {
    profile: {
      id: TEST_PROFILE.id,
      nickname: TEST_PROFILE.nickname,
      createdAt: TEST_PROFILE.created_at,
      updatedAt: TEST_PROFILE.updated_at,
    },
  });
  assert.equal(JSON.stringify(body).includes(credential), false);
  assert.equal(JSON.stringify(body).includes("token_hash"), false);
  assert.equal(requestUrl?.pathname, "/rest/v1/guest_credentials");
  assert.equal(
    requestUrl?.searchParams.get("token_hash"),
    `eq.\\x${createHash("sha256").update(credential).digest("hex")}`,
  );
  assert.equal(requestUrl?.searchParams.get("revoked_at"), "is.null");
  assert.match(
    requestUrl?.searchParams.get("expires_at") ?? "",
    /^gt\.\d{4}-\d\d-\d\dT/,
  );
  assert.equal(
    requestUrl?.searchParams.get("profiles.supabase_user_id"),
    "is.null",
  );
});

test("guest profile endpoints reject invalid payloads without calling Supabase", async (t) => {
  let supabaseRequestCount = 0;
  const service = new GuestProfileService(
    TEST_CONFIG.guestProfiles,
    async () => {
      supabaseRequestCount += 1;
      return createJsonResponse([]);
    },
  );
  const { url } = await startTestServer(t, TEST_CONFIG, service);
  const createResponse = await fetch(`${url}/guest-profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname: "  " }),
  });
  const restoreResponse = await fetch(`${url}/guest-profiles/restore`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: "short", profileId: "client-controlled" }),
  });

  assert.equal(createResponse.status, 400);
  assert.equal(restoreResponse.status, 400);
  assert.equal(supabaseRequestCount, 0);
});

test("invalid and expired guest credentials receive the same generic response", async (t) => {
  const service = new GuestProfileService(
    TEST_CONFIG.guestProfiles,
    async () => createJsonResponse([]),
  );
  const { url } = await startTestServer(t, TEST_CONFIG, service);
  const responses = [];

  for (const credential of [
    Buffer.alloc(32, 1).toString("base64url"),
    Buffer.alloc(32, 2).toString("base64url"),
  ]) {
    responses.push(
      await fetch(`${url}/guest-profiles/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential }),
      }),
    );
  }

  assert.deepEqual(
    responses.map((response) => response.status),
    [401, 401],
  );
  assert.deepEqual(
    await Promise.all(responses.map((response) => response.json())),
    [
      {
        error: {
          code: "INVALID_CREDENTIAL",
          message: "Guest credential is invalid or expired.",
        },
      },
      {
        error: {
          code: "INVALID_CREDENTIAL",
          message: "Guest credential is invalid or expired.",
        },
      },
    ],
  );
});

test("guest profile requests are rate limited by the trusted client IP", async (t) => {
  let supabaseRequestCount = 0;
  const service = new GuestProfileService(
    TEST_CONFIG.guestProfiles,
    async () => {
      supabaseRequestCount += 1;
      return createJsonResponse([TEST_PROFILE]);
    },
  );
  const { url } = await startTestServer(t, TEST_CONFIG, service);
  const responses = [];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    responses.push(
      await fetch(`${url}/guest-profiles`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nickname: "Guest Player" }),
      }),
    );
  }

  assert.deepEqual(
    responses.map((response) => response.status),
    [201, 201, 201, 201, 201, 429],
  );
  assert.equal(supabaseRequestCount, 5);
});

test(
  "a guest profile RPC error returns a generic error without leaking database details",
  async (t) => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const service = new GuestProfileService(
      TEST_CONFIG.guestProfiles,
      async (input, init) => {
        requests.push({ url: getRequestUrl(input), init });
        return createJsonResponse(
          { message: "database detail not for clients" },
          500,
        );
      },
    );
    const { url } = await startTestServer(t, TEST_CONFIG, service);
    const response = await fetch(`${url}/guest-profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "Guest Player" }),
    });

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: {
        code: "UNKNOWN",
        message:
          "Guest profile creation could not be confirmed; a retry may create a duplicate profile.",
      },
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.init?.method, "POST");
    assert.equal(
      requests[0]?.url.pathname,
      "/rest/v1/rpc/create_guest_profile",
    );
  },
);

test(
  "an ambiguous guest profile request failure warns against automatic retries",
  async (t) => {
    const service = new GuestProfileService(
      TEST_CONFIG.guestProfiles,
      async () => {
        throw new Error("simulated lost response");
      },
    );
    const { url } = await startTestServer(t, TEST_CONFIG, service);
    const response = await fetch(`${url}/guest-profiles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nickname: "Guest Player" }),
    });

    assert.equal(response.status, 503);
    const responseBody = await response.json();
    assert.deepEqual(responseBody, {
      error: {
        code: "UNKNOWN",
        message:
          "Guest profile creation could not be confirmed; a retry may create a duplicate profile.",
      },
    });
    assert.equal(
      JSON.stringify(responseBody).includes("simulated lost response"),
      false,
    );
  },
);

test("guest profile endpoints are unavailable but harmless when unconfigured", async (t) => {
  const service = new GuestProfileService(null, async () => {
    throw new Error("Supabase should not be called when disabled.");
  });
  const { url } = await startTestServer(
    t,
    { ...TEST_CONFIG, guestProfiles: null },
    service,
  );

  const response = await fetch(`${url}/guest-profiles`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname: "Guest Player" }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: {
      code: "FEATURE_UNAVAILABLE",
      message: "Guest profiles are not configured on this server.",
    },
  });
});
