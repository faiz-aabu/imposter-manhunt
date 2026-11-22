import { create } from "zustand";
import { getSupabaseAuthClient } from "../services/supabase-auth";
import { AuthLifecycleController } from "../services/auth-lifecycle";
import type { AuthLifecycleState } from "../services/auth-lifecycle";

export type AuthStatus = "loading" | "signed-out" | "signed-in";

interface AuthState {
  status: AuthStatus;
  email: string | null;
  initialize: () => Promise<void>;
  dispose: () => void;
  refresh: () => Promise<void>;
  clear: () => void;
}

let lifecycleController: AuthLifecycleController | null = null;

export const useAuthStore = create<AuthState>((set) => {
  lifecycleController = new AuthLifecycleController(
    (state: AuthLifecycleState) => set(state),
  );

  return {
    status: "loading",
    email: null,
    initialize: async () => {
      await lifecycleController?.initialize(getSupabaseAuthClient());
    },
    dispose: () => lifecycleController?.dispose(),
    refresh: async () => {
      await lifecycleController?.refresh(getSupabaseAuthClient());
    },
    clear: () => set({ status: "signed-out", email: null }),
  };
});
