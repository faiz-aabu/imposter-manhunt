import { create } from "zustand";
import type { Language } from "./locales";

export const LANGUAGE_PREFERENCE_KEY = "impostor.languagePreference";

export interface LanguagePreferenceStorage {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
}

interface LanguageState {
  language: Language;
  hasHydrated: boolean;
  loadFailed: boolean;
  saveFailed: boolean;
  revision: number;
  hydrate: () => Promise<void>;
  setLanguage: (language: Language) => Promise<void>;
}

export function isLanguage(value: string | null): value is Language {
  return value === "en" || value === "es" || value === "fr" || value === "it";
}

export function createLanguageStore(storage: LanguagePreferenceStorage) {
  let hydration: Promise<void> | null = null;
  let writes = Promise.resolve();

  return create<LanguageState>((set, get) => ({
    language: "en",
    hasHydrated: false,
    loadFailed: false,
    saveFailed: false,
    revision: 0,
    hydrate: () => {
      if (!hydration) {
        const startingRevision = get().revision;
        hydration = storage
          .getItemAsync(LANGUAGE_PREFERENCE_KEY)
          .then((savedLanguage) => {
            set((state) => ({
              language:
                state.revision === startingRevision && isLanguage(savedLanguage)
                  ? savedLanguage
                  : state.language,
              hasHydrated: true,
            }));
          })
          .catch(() => {
            set({ hasHydrated: true, loadFailed: true });
          });
      }
      return hydration;
    },
    setLanguage: async (language) => {
      set((state) => ({
        language,
        revision: state.revision + 1,
        saveFailed: false,
      }));
      const write = writes
        .catch(() => undefined)
        .then(() =>
          storage.setItemAsync(LANGUAGE_PREFERENCE_KEY, language),
        );
      writes = write;
      try {
        await write;
      } catch (error) {
        set({ saveFailed: true });
        throw error;
      }
    },
  }));
}
