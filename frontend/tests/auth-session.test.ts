import assert from "node:assert/strict";
import test from "node:test";
import {
  getRuntimeSupabaseAuthEnvironment,
  getMissingSupabaseAuthConfiguration,
  getSupabaseAuthConfig,
  getAuthEntryRoute,
  isValidEmail,
  normalizeEmail,
} from "../src/services/supabase-auth-config";
import {
  createSecureAuthStorage,
  getSecureAuthStorageKey,
} from "../src/services/secure-auth-storage";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AuthLifecycleController,
  LOCAL_SIGN_OUT_OPTIONS,
} from "../src/services/auth-lifecycle";
import type { AuthLifecycleState } from "../src/services/auth-lifecycle";

test("runtime Supabase environment reads Expo public variables", () => {
  const previousUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const previousPublishableKey =
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const previousAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

  try {
    process.env.EXPO_PUBLIC_SUPABASE_URL =
      "https://runtime.example.supabase.co";
    process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
      "sb_publishable_runtime_test";
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

    const publishableConfig = getSupabaseAuthConfig(
      getRuntimeSupabaseAuthEnvironment(),
    );
    assert.equal(publishableConfig?.url, "https://runtime.example.supabase.co");
    assert.equal(
      publishableConfig?.publishableKey.startsWith("sb_publishable_"),
      true,
    );

    delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY =
      "sb_publishable_runtime_anon_test";

    const anonConfig = getSupabaseAuthConfig(
      getRuntimeSupabaseAuthEnvironment(),
    );
    assert.equal(anonConfig?.storageKey, "runtime");
    assert.deepEqual(
      getMissingSupabaseAuthConfiguration(
        getRuntimeSupabaseAuthEnvironment(),
      ),
      [],
    );
  } finally {
    if (previousUrl === undefined) {
      delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    } else {
      process.env.EXPO_PUBLIC_SUPABASE_URL = previousUrl;
    }

    if (previousPublishableKey === undefined) {
      delete process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    } else {
      process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY =
        previousPublishableKey;
    }

    if (previousAnonKey === undefined) {
      delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    } else {
      process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = previousAnonKey;
    }
  }
});

test("missing Supabase public variables are reported by name", () => {
  assert.deepEqual(
    getMissingSupabaseAuthConfiguration({}),
    [
      "EXPO_PUBLIC_SUPABASE_URL",
      "EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    ],
  );
});

test("valid HTTPS Supabase public configuration is accepted", () => {
  const config = getSupabaseAuthConfig({
    EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  });
  assert.deepEqual(config, {
    url: "https://example.supabase.co",
    publishableKey: "sb_publishable_test",
    storageKey: "example",
  });
});

test("HTTP, malformed, and secret-key configurations are rejected", () => {
  assert.equal(
    getSupabaseAuthConfig({
      EXPO_PUBLIC_SUPABASE_URL: "http://example.supabase.co",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    }),
    null,
  );
  assert.equal(
    getSupabaseAuthConfig({
      EXPO_PUBLIC_SUPABASE_URL: "not-a-url",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    }),
    null,
  );
  assert.equal(
    getSupabaseAuthConfig({
      EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_test",
    }),
    null,
  );
});

test("email normalization and validation are separate from nickname handling", () => {
  assert.equal(normalizeEmail("  Player@Example.COM "), "player@example.com");
  assert.equal(isValidEmail("player@example.com"), true);
  assert.equal(isValidEmail("not-an-email"), false);
});

test("existing anon-key variable safely configures the public client", () => {
  const config = getSupabaseAuthConfig({
    EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    EXPO_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_existing",
  });
  assert.equal(config?.publishableKey, "sb_publishable_existing");
  assert.equal(
    getMissingSupabaseAuthConfiguration({
      EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      EXPO_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_existing",
    }).length,
    0,
  );
});

test("valid ANON_KEY only configures the public client", () => {
  const config = getSupabaseAuthConfig({
    EXPO_PUBLIC_SUPABASE_URL: "  https://example.supabase.co  ",
    EXPO_PUBLIC_SUPABASE_ANON_KEY: "  sb_publishable_anon_only  ",
  });
  assert.equal(config?.url, "https://example.supabase.co");
  assert.equal(config?.publishableKey, "sb_publishable_anon_only");
});

test("valid PUBLISHABLE_KEY only configures the public client", () => {
  const config = getSupabaseAuthConfig({
    EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: " sb_publishable_only ",
  });
  assert.equal(config?.publishableKey, "sb_publishable_only");
});

test("empty PUBLISHABLE_KEY falls back to valid ANON_KEY", () => {
  const config = getSupabaseAuthConfig({
    EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "   ",
    EXPO_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_anon_fallback",
  });
  assert.equal(config?.publishableKey, "sb_publishable_anon_fallback");
});

test("both Supabase key variables missing returns no configuration", () => {
  assert.equal(
    getSupabaseAuthConfig({
      EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    }),
    null,
  );
});

test("invalid Supabase key formats are rejected", () => {
  assert.equal(
    getSupabaseAuthConfig({
      EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "not-a-valid-key",
    }),
    null,
  );
  assert.equal(
    getSupabaseAuthConfig({
      EXPO_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      EXPO_PUBLIC_SUPABASE_ANON_KEY: "sb_secret_must_not_be_used",
    }),
    null,
  );
});

test("invalid or unsafe Supabase URLs are rejected", () => {
  assert.equal(
    getSupabaseAuthConfig({
      EXPO_PUBLIC_SUPABASE_URL: "http://example.supabase.co",
      EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    }),
    null,
  );
  assert.equal(
    getSupabaseAuthConfig({
      EXPO_PUBLIC_SUPABASE_URL: "not-a-url",
      EXPO_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test",
    }),
    null,
  );
});

test("Supabase storage forwards exact keys and isolates projects", async () => {
  const values = new Map<string, string>();
  const secureStore = {
    getItemAsync: async (key: string) => values.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => {
      values.set(key, value);
    },
    deleteItemAsync: async (key: string) => {
      values.delete(key);
    },
  };
  const storageA = createSecureAuthStorage("project-a", secureStore);
  const storageB = createSecureAuthStorage("project-b", secureStore);

  await storageA.setItem("sb-project-a-auth-token", "session-a");
  await storageA.setItem("sb-project-a-auth-token-user", "user-a");
  await storageB.setItem("sb-project-b-auth-token", "session-b");

  assert.equal(
    await storageA.getItem("sb-project-a-auth-token"),
    "session-a",
  );
  assert.equal(
    await storageA.getItem("sb-project-a-auth-token-user"),
    "user-a",
  );
  await storageA.removeItem("sb-project-a-auth-token");
  assert.equal(
    await storageA.getItem("sb-project-a-auth-token"),
    null,
  );
  assert.equal(
    await storageA.getItem("sb-project-a-auth-token-user"),
    "user-a",
  );
  assert.equal(
    await storageB.getItem("sb-project-b-auth-token"),
    "session-b",
  );
  assert.equal(
    getSecureAuthStorageKey("project-a", "session-key"),
    "impostor.supabase.project-a.session-key",
  );

  values.set("impostor.nickname", "Guest Name");
  values.set("impostor.reconnectSession", "room-reconnect");
  await storageA.removeItem("sb-project-a-auth-token");
  assert.equal(values.get("impostor.nickname"), "Guest Name");
  assert.equal(values.get("impostor.reconnectSession"), "room-reconnect");
});

test("auth initialization restores a session and clears loading", async () => {
  let unsubscribed = false;
  let state: AuthLifecycleState = { status: "loading", email: null };
  const controller = new AuthLifecycleController(
    (nextState) => { state = nextState; },
  );
  const client = {
    auth: {
      getSession: async () => ({
        data: {
          session: {
            user: { email: "player@example.com" },
          },
        },
      }),
      onAuthStateChange: () => ({
        data: {
          subscription: { unsubscribe: () => { unsubscribed = true; } },
        },
      }),
    },
  } as unknown as SupabaseClient;
  await controller.initialize(client);
  assert.equal(state.status, "signed-in");
  assert.equal(state.email, "player@example.com");
  controller.dispose();
  assert.equal(unsubscribed, true);
});

test("auth initialization rejection becomes signed out", async () => {
  let state: AuthLifecycleState = { status: "loading", email: null };
  const controller = new AuthLifecycleController(
    (nextState) => { state = nextState; },
  );
  const client = {
    auth: {
      getSession: async () => {
        throw new Error("storage unavailable");
      },
      onAuthStateChange: () => ({
        data: {
          subscription: { unsubscribe: () => undefined },
        },
      }),
    },
  } as unknown as SupabaseClient;
  await controller.initialize(client);
  assert.equal(state.status, "signed-out");
  assert.equal(state.email, null);
  controller.dispose();
});

test("missing Auth configuration settles initialization as signed out", async () => {
  let state: AuthLifecycleState = { status: "loading", email: null };
  const controller = new AuthLifecycleController(
    (nextState) => { state = nextState; },
  );

  await controller.initialize(null);

  assert.deepEqual(state, { status: "signed-out", email: null });
  controller.dispose();
});

test("auth events win over stale session restoration", async () => {
  let resolveSession:
    | ((result: { data: { session: null } }) => void)
    | undefined;
  let authStateChanged:
    | ((
        event: string,
        session: { user: { email: string } } | null,
      ) => void)
    | undefined;
  let state: AuthLifecycleState = { status: "loading", email: null };
  const controller = new AuthLifecycleController(
    (nextState) => { state = nextState; },
  );
  const client = {
    auth: {
      getSession: () =>
        new Promise<{ data: { session: null } }>((resolve) => {
          resolveSession = resolve;
        }),
      onAuthStateChange: (
        callback: (
          event: string,
          session: { user: { email: string } } | null,
        ) => void,
      ) => {
        authStateChanged = callback;
        return {
          data: { subscription: { unsubscribe: () => undefined } },
        };
      },
    },
  } as unknown as SupabaseClient;

  const initialization = controller.initialize(client);
  authStateChanged?.("SIGNED_IN", {
    user: { email: "new@example.com" },
  });
  resolveSession?.({ data: { session: null } });
  await initialization;

  assert.deepEqual(state, {
    status: "signed-in",
    email: "new@example.com",
  });
  controller.dispose();
});

test("repeated initialization ignores callbacks from the prior subscription", async () => {
  const callbacks: Array<
    (event: string, session: { user: { email: string } } | null) => void
  > = [];
  let unsubscribeCount = 0;
  let state: AuthLifecycleState = { status: "loading", email: null };
  const controller = new AuthLifecycleController(
    (nextState) => { state = nextState; },
  );
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: (
        callback: (
          event: string,
          session: { user: { email: string } } | null,
        ) => void,
      ) => {
        callbacks.push(callback);
        return {
          data: {
            subscription: {
              unsubscribe: () => { unsubscribeCount += 1; },
            },
          },
        };
      },
    },
  } as unknown as SupabaseClient;

  const firstInitialization = controller.initialize(client);
  const secondInitialization = controller.initialize(client);
  await Promise.all([firstInitialization, secondInitialization]);
  callbacks[0]?.("SIGNED_IN", { user: { email: "stale@example.com" } });

  assert.equal(unsubscribeCount, 1);
  assert.deepEqual(state, { status: "signed-out", email: null });
  controller.dispose();
  assert.equal(unsubscribeCount, 2);
});

test("stale refresh results do not overwrite newer auth events", async () => {
  let refreshSession:
    | ((result: { data: { session: null } }) => void)
    | undefined;
  let authStateChanged:
    | ((
        event: string,
        session: { user: { email: string } } | null,
      ) => void)
    | undefined;
  let sessionCalls = 0;
  let state: AuthLifecycleState = { status: "loading", email: null };
  const controller = new AuthLifecycleController(
    (nextState) => { state = nextState; },
  );
  const client = {
    auth: {
      getSession: () => {
        sessionCalls += 1;
        if (sessionCalls === 1) {
          return Promise.resolve({ data: { session: null } });
        }
        return new Promise<{ data: { session: null } }>((resolve) => {
          refreshSession = resolve;
        });
      },
      onAuthStateChange: (
        callback: (
          event: string,
          session: { user: { email: string } } | null,
        ) => void,
      ) => {
        authStateChanged = callback;
        return {
          data: { subscription: { unsubscribe: () => undefined } },
        };
      },
    },
  } as unknown as SupabaseClient;

  await controller.initialize(client);
  const refresh = controller.refresh(client);
  authStateChanged?.("SIGNED_IN", { user: { email: "fresh@example.com" } });
  refreshSession?.({ data: { session: null } });
  await refresh;

  assert.deepEqual(state, {
    status: "signed-in",
    email: "fresh@example.com",
  });
  controller.dispose();
});

test("local sign-out scope is explicit", async () => {
  let signOutOptions: unknown;
  const client = {
    auth: {
      signOut: async (options: unknown) => {
        signOutOptions = options;
        return { error: null };
      },
    },
  };
  await client.auth.signOut(LOCAL_SIGN_OUT_OPTIONS);
  assert.deepEqual(signOutOptions, { scope: "local" });
});

test("auth entry routing preserves guest entry and account entry", () => {
  assert.equal(getAuthEntryRoute("signed-out"), "/sign-in");
  assert.equal(getAuthEntryRoute("signed-in"), "/account");
  assert.equal(getAuthEntryRoute("loading"), "/sign-in");
});