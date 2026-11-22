import type { SupportedStorage } from "@supabase/supabase-js";

const STORAGE_KEY_PREFIX = "impostor.supabase";

export interface SecureAuthStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export function getSecureAuthStorageKey(
  projectKey: string,
  supabaseKey: string,
): string {
  return `${STORAGE_KEY_PREFIX}.${projectKey}.${supabaseKey}`;
}

export function createSecureAuthStorage(
  projectKey: string,
  secureStore: SecureAuthStore,
): SupportedStorage {
  return {
    getItem: async (key: string) =>
      secureStore.getItemAsync(getSecureAuthStorageKey(projectKey, key)),
    setItem: async (key: string, value: string) =>
      secureStore.setItemAsync(
        getSecureAuthStorageKey(projectKey, key),
        value,
      ),
    removeItem: async (key: string) =>
      secureStore.deleteItemAsync(getSecureAuthStorageKey(projectKey, key)),
  };
}