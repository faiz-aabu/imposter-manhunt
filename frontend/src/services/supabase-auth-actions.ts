import { getSupabaseAuthClient } from "./supabase-auth";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LOCAL_SIGN_OUT_OPTIONS } from "./auth-lifecycle";

export async function sendEmailOtp(email: string): Promise<void> {
  const client = getSupabaseAuthClient();
  if (!client) {
    throw new Error(
      "Email sign-in is not configured. Add the required public Supabase variables.",
    );
  }

  const { error } = await client.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
    },
  });
  if (error) {
    throw error;
  }
}

export async function verifyEmailOtp(
  email: string,
  code: string,
): Promise<void> {
  const client = getSupabaseAuthClient();
  if (!client) {
    throw new Error(
      "Email sign-in is not configured. Add the required public Supabase variables.",
    );
  }

  const { error } = await client.auth.verifyOtp({
    email,
    token: code,
    type: "email",
  });
  if (error) {
    throw error;
  }
}

export async function signOutAuth(
  client: SupabaseClient | null = getSupabaseAuthClient(),
): Promise<void> {
  if (!client) {
    return;
  }

  const { error } = await client.auth.signOut(LOCAL_SIGN_OUT_OPTIONS);
  if (error) {
    throw error;
  }
}