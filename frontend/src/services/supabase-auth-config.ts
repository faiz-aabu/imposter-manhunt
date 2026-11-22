export interface SupabaseAuthConfig {
  url: string;
  publishableKey: string;
  storageKey: string;
}

export function getRuntimeSupabaseAuthEnvironment(): Record<
  string,
  string | undefined
> {
  return {
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  };
}

export function getSupabaseAuthConfig(
  environment: Record<string, string | undefined> =
    getRuntimeSupabaseAuthEnvironment(),
): SupabaseAuthConfig | null {
  const url = environment.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = firstNonEmptyValue(
    environment.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    environment.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  );

  if (!url || !publishableKey) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.pathname !== "/" ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    return null;
  }

  if (
    !publishableKey.startsWith("sb_publishable_") &&
    !isLegacyAnonJwt(publishableKey)
  ) {
    return null;
  }

  return {
    url: parsedUrl.origin,
    publishableKey,
    storageKey: parsedUrl.hostname.split(".")[0] ?? "client",
  };
}

export function getMissingSupabaseAuthConfiguration(
  environment: Record<string, string | undefined> =
    getRuntimeSupabaseAuthEnvironment(),
): string[] {
  const missing: string[] = [];
  if (!environment.EXPO_PUBLIC_SUPABASE_URL?.trim()) {
    missing.push("EXPO_PUBLIC_SUPABASE_URL");
  }
  if (!firstNonEmptyValue(
    environment.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    environment.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  )) {
    missing.push("EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  }
  return missing;
}

function firstNonEmptyValue(
  ...values: Array<string | undefined>
): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function isLegacyAnonJwt(key: string): boolean {
  if (!key.startsWith("eyJ")) {
    return false;
  }
  const segments = key.split(".");
  if (segments.length !== 3) {
    return false;
  }
  try {
    const payloadSegment = segments[1] ?? "";
    const payloadJson = decodeBase64Url(payloadSegment);
    const payload = JSON.parse(payloadJson) as { role?: unknown };
    return payload.role === "anon";
  } catch {
    return false;
  }
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  if (typeof globalThis.atob === "function") {
    return globalThis.atob(padded);
  }
  throw new Error("Base64 decoding is unavailable.");
}

export function getAuthEntryRoute(
  status: "loading" | "signed-out" | "signed-in",
): "/sign-in" | "/account" {
  return status === "signed-in" ? "/account" : "/sign-in";
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}