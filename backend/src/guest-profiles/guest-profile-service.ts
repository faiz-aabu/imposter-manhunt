import { createHash, randomBytes } from "node:crypto";
import type {
  CreateGuestProfileResponse,
  GuestProfile,
  RestoreGuestProfileResponse,
} from "@impostor/api";
import type { SupabaseGuestProfileConfig } from "../config/env.js";
import { AppError } from "../utils/app-error.js";

const SUPABASE_REQUEST_TIMEOUT_MS = 10_000;
const INVALID_CREDENTIAL_MESSAGE = "Guest credential is invalid or expired.";
const SERVICE_UNAVAILABLE_MESSAGE =
  "Guest profile service is temporarily unavailable.";
const CREATE_OUTCOME_UNKNOWN_MESSAGE =
  "Guest profile creation could not be confirmed; a retry may create a duplicate profile.";

export class GuestProfileService {
  constructor(
    private readonly config: SupabaseGuestProfileConfig | null,
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {}

  get isConfigured(): boolean {
    return this.config !== null;
  }

  async create(nickname: string): Promise<CreateGuestProfileResponse> {
    const config = this.requireConfig();
    const credential = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256")
      .update(credential, "utf8")
      .digest("hex");
    const endpoint = new URL(
      "/rest/v1/rpc/create_guest_profile",
      config.url,
    );

    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "POST",
        headers: this.createHeaders(config),
        body: JSON.stringify({
          p_nickname: nickname,
          p_token_hash: `\\x${tokenHash}`,
        }),
        signal: AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      throw new AppError("UNKNOWN", CREATE_OUTCOME_UNKNOWN_MESSAGE, 503);
    }

    if (!response.ok) {
      throw new AppError("UNKNOWN", CREATE_OUTCOME_UNKNOWN_MESSAGE, 503);
    }

    let rows: unknown;
    try {
      rows = await response.json();
    } catch {
      throw new AppError("UNKNOWN", CREATE_OUTCOME_UNKNOWN_MESSAGE, 503);
    }

    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new AppError("UNKNOWN", CREATE_OUTCOME_UNKNOWN_MESSAGE, 503);
    }
    const profile = toGuestProfile(rows[0]);
    if (!profile || profile.nickname !== nickname) {
      throw new AppError("UNKNOWN", CREATE_OUTCOME_UNKNOWN_MESSAGE, 503);
    }

    return { profile, credential };
  }

  async restore(credential: string): Promise<RestoreGuestProfileResponse> {
    const config = this.requireConfig();
    const tokenHash = createHash("sha256")
      .update(credential, "utf8")
      .digest("hex");
    const endpoint = new URL("/rest/v1/guest_credentials", config.url);
    endpoint.searchParams.set(
      "select",
      "profiles!inner(id,nickname,created_at,updated_at)",
    );
    endpoint.searchParams.set("token_hash", `eq.\\x${tokenHash}`);
    endpoint.searchParams.set("revoked_at", "is.null");
    endpoint.searchParams.set(
      "expires_at",
      `gt.${new Date().toISOString()}`,
    );
    endpoint.searchParams.set("profiles.supabase_user_id", "is.null");
    endpoint.searchParams.set("profiles.anonymized_at", "is.null");
    endpoint.searchParams.set(
      "profiles.merged_into_profile_id",
      "is.null",
    );

    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "GET",
        headers: this.createHeaders(config),
        signal: AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      throw new AppError("UNKNOWN", SERVICE_UNAVAILABLE_MESSAGE, 503);
    }

    if (!response.ok) {
      throw new AppError("UNKNOWN", SERVICE_UNAVAILABLE_MESSAGE, 503);
    }

    let rows: unknown;
    try {
      rows = await response.json();
    } catch {
      throw new AppError("UNKNOWN", SERVICE_UNAVAILABLE_MESSAGE, 503);
    }

    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new AppError("INVALID_CREDENTIAL", INVALID_CREDENTIAL_MESSAGE);
    }

    const profile = getRestoredProfile(rows[0]);
    if (!profile) {
      throw new AppError("INVALID_CREDENTIAL", INVALID_CREDENTIAL_MESSAGE);
    }

    return { profile };
  }

  async linkToAccount(
    credential: string,
    accessToken: string,
  ): Promise<{ profile: GuestProfile }> {
    const config = this.requireConfig();
    const userEndpoint = new URL("/auth/v1/user", config.url);

    let userResponse: Response;
    try {
      userResponse = await this.fetcher(userEndpoint, {
        method: "GET",
        headers: this.createHeaders(config, {
          Authorization: `Bearer ${accessToken}`,
        }),
        signal: AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      throw new AppError(
        "UNKNOWN",
        "Account verification is temporarily unavailable.",
        503,
      );
    }

    if (!userResponse.ok) {
      throw new AppError(
        "INVALID_CREDENTIAL",
        "Your sign-in session is invalid or expired.",
      );
    }

    let user: unknown;
    try {
      user = await userResponse.json();
    } catch {
      throw new AppError(
        "UNKNOWN",
        "Account verification is temporarily unavailable.",
        503,
      );
    }

    if (
      typeof user !== "object" ||
      user === null ||
      !("id" in user) ||
      typeof user.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        user.id,
      )
    ) {
      throw new AppError(
        "INVALID_CREDENTIAL",
        "Your sign-in session is invalid or expired.",
      );
    }

    const tokenHash = createHash("sha256")
      .update(credential, "utf8")
      .digest("hex");
    const linkEndpoint = new URL(
      "/rest/v1/rpc/link_guest_profile_to_auth_user",
      config.url,
    );

    let linkResponse: Response;
    try {
      linkResponse = await this.fetcher(linkEndpoint, {
        method: "POST",
        headers: this.createHeaders(config),
        body: JSON.stringify({
          p_token_hash: `\\x${tokenHash}`,
          p_supabase_user_id: user.id,
        }),
        signal: AbortSignal.timeout(SUPABASE_REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      throw new AppError(
        "UNKNOWN",
        "Account linking is temporarily unavailable.",
        503,
      );
    }

    if (!linkResponse.ok) {
      let databaseCode: unknown;
      try {
        const errorBody: unknown = await linkResponse.json();
        if (
          typeof errorBody === "object" &&
          errorBody !== null &&
          "code" in errorBody
        ) {
          databaseCode = errorBody.code;
        }
      } catch {
        // Keep database details out of the public response.
      }

      if (databaseCode === "28000") {
        throw new AppError(
          "INVALID_CREDENTIAL",
          "Guest credential is invalid, expired, or cannot be linked.",
        );
      }
      throw new AppError(
        "UNKNOWN",
        "Account linking is temporarily unavailable.",
        503,
      );
    }

    let rows: unknown;
    try {
      rows = await linkResponse.json();
    } catch {
      throw new AppError(
        "UNKNOWN",
        "Account linking could not be confirmed.",
        503,
      );
    }

    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new AppError(
        "INVALID_CREDENTIAL",
        "Guest credential is invalid, expired, or cannot be linked.",
      );
    }

    const profile = toGuestProfile(rows[0]);
    if (!profile) {
      throw new AppError(
        "UNKNOWN",
        "Account linking could not be confirmed.",
        503,
      );
    }

    return { profile };
  }

  private requireConfig(): SupabaseGuestProfileConfig {
    if (!this.config) {
      throw new AppError(
        "FEATURE_UNAVAILABLE",
        "Guest profiles are not configured on this server.",
      );
    }
    return this.config;
  }

  private createHeaders(
    config: SupabaseGuestProfileConfig,
    additionalHeaders: Record<string, string> = {},
  ): HeadersInit {
    return {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json",
      ...additionalHeaders,
    };
  }
}

function getRestoredProfile(value: unknown): GuestProfile | null {
  if (typeof value !== "object" || value === null || !("profiles" in value)) {
    return null;
  }

  const profiles = Array.isArray(value.profiles)
    ? value.profiles
    : [value.profiles];
  return profiles.length === 1 ? toGuestProfile(profiles[0]) : null;
}

function toGuestProfile(value: unknown): GuestProfile | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("id" in value) ||
    !("nickname" in value) ||
    !("created_at" in value) ||
    !("updated_at" in value) ||
    typeof value.id !== "string" ||
    typeof value.nickname !== "string" ||
    typeof value.created_at !== "string" ||
    typeof value.updated_at !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    nickname: value.nickname,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}
