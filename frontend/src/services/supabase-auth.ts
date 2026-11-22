import "react-native-url-polyfill/auto";
import * as SecureStore from "expo-secure-store";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSecureAuthStorage } from "./secure-auth-storage";
import { getSupabaseAuthConfig } from "./supabase-auth-config";

let authClient: SupabaseClient | null | undefined;

export function setSupabaseAuthClientForTesting(
  client: SupabaseClient | null,
): void {
  authClient = client;
}

export function getSupabaseAuthClient(): SupabaseClient | null {
  if (authClient !== undefined) {
    return authClient;
  }

  const config = getSupabaseAuthConfig();
  if (!config) {
    authClient = null;
    return null;
  }

  authClient = createClient(config.url, config.publishableKey, {
    auth: {
      storage: createSecureAuthStorage(config.storageKey, SecureStore),
      storageKey: `sb-${config.storageKey}-auth-token`,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  return authClient;
}