export interface BackendConfig {
  port: number;
  allowedOrigins: string[];
  reconnectGracePeriodMs: number;
  nodeEnv: "development" | "test" | "production";
  clientIpMode: "socket" | "railway";
  trustProxyHops: number;
  requireHttps: boolean;
  guestProfiles: SupabaseGuestProfileConfig | null;
  lateGameExposureDurations: LateGameExposureDurations | null;
}

export interface LateGameExposureDurations {
  clueDurationSeconds: number;
  warningDurationSeconds: number;
}

export interface SupabaseGuestProfileConfig {
  url: string;
  serviceRoleKey: string;
}

const DEFAULT_PORT = 3000;
const DEFAULT_RECONNECT_GRACE_PERIOD_MS = 120_000;
const DEFAULT_LATE_GAME_EXPOSURE_DURATIONS: LateGameExposureDurations = {
  clueDurationSeconds: 15,
  warningDurationSeconds: 5,
};
const MAX_RECONNECT_GRACE_PERIOD_MS = 86_400_000;
const MAX_TRUST_PROXY_HOPS = 5;

function parseNodeEnvironment(
  value: string | undefined,
): BackendConfig["nodeEnv"] {
  const nodeEnv = value ?? "development";
  if (
    nodeEnv !== "development" &&
    nodeEnv !== "test" &&
    nodeEnv !== "production"
  ) {
    throw new Error("NODE_ENV must be development, test, or production.");
  }
  return nodeEnv;
}

function parseClientIpMode(
  value: string | undefined,
): BackendConfig["clientIpMode"] {
  const mode = value ?? "socket";
  if (mode !== "socket" && mode !== "railway") {
    throw new Error("CLIENT_IP_MODE must be socket or railway.");
  }
  return mode;
}

function parseAllowedOrigins(
  value: string | undefined,
  nodeEnv: BackendConfig["nodeEnv"],
): string[] {
  if (value === undefined || value.trim() === "") {
    if (nodeEnv === "production") {
      throw new Error(
        "ALLOWED_ORIGINS must be configured explicitly in production.",
      );
    }
    return ["*"];
  }

  const entries = value.split(",").map((origin) => origin.trim());
  if (entries.some((origin) => origin.length === 0)) {
    throw new Error("ALLOWED_ORIGINS must not contain empty entries.");
  }
  if (entries.includes("*")) {
    if (nodeEnv === "production" || entries.length !== 1) {
      throw new Error(
        "ALLOWED_ORIGINS may use * only by itself outside production.",
      );
    }
    return ["*"];
  }

  return entries.map((origin) => parseOrigin(origin, nodeEnv));
}

function parseOrigin(
  origin: string,
  nodeEnv: BackendConfig["nodeEnv"],
): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("ALLOWED_ORIGINS entries must be valid origins.");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "ALLOWED_ORIGINS entries must contain only an HTTP or HTTPS origin.",
    );
  }
  if (nodeEnv === "production" && parsed.protocol !== "https:") {
    throw new Error("Production ALLOWED_ORIGINS entries must use HTTPS.");
  }

  return parsed.origin;
}

function parseIntegerSetting(
  name: string,
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }

  return parsed;
}

function parseOptionalPositiveIntegerSetting(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

function parseLateGameExposureDurations(
  environment: NodeJS.ProcessEnv,
): LateGameExposureDurations | null {
  const clueDurationSeconds = parseOptionalPositiveIntegerSetting(
    "MANHUNT_LATE_GAME_CLUE_DURATION_SECONDS",
    environment.MANHUNT_LATE_GAME_CLUE_DURATION_SECONDS,
  );
  const warningDurationSeconds = parseOptionalPositiveIntegerSetting(
    "MANHUNT_LATE_GAME_WARNING_DURATION_SECONDS",
    environment.MANHUNT_LATE_GAME_WARNING_DURATION_SECONDS,
  );
  if (clueDurationSeconds === undefined && warningDurationSeconds === undefined) {
    return { ...DEFAULT_LATE_GAME_EXPOSURE_DURATIONS };
  }
  if (clueDurationSeconds === undefined || warningDurationSeconds === undefined) {
    throw new Error(
      "MANHUNT_LATE_GAME_CLUE_DURATION_SECONDS and MANHUNT_LATE_GAME_WARNING_DURATION_SECONDS must be configured together.",
    );
  }
  if (
    clueDurationSeconds !==
      DEFAULT_LATE_GAME_EXPOSURE_DURATIONS.clueDurationSeconds ||
    warningDurationSeconds !==
      DEFAULT_LATE_GAME_EXPOSURE_DURATIONS.warningDurationSeconds
  ) {
    throw new Error(
      "Manhunt late-game exposure durations must match the approved configuration.",
    );
  }
  return { clueDurationSeconds, warningDurationSeconds };
}

function parseGuestProfilesConfig(
  environment: NodeJS.ProcessEnv,
  nodeEnv: BackendConfig["nodeEnv"],
): SupabaseGuestProfileConfig | null {
  const urlValue = environment.SUPABASE_URL?.trim();
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!urlValue && !serviceRoleKey) {
    return null;
  }
  if (!urlValue || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured together.",
    );
  }
  if (serviceRoleKey.startsWith("sb_publishable_")) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY must be a server-only service-role key, not a publishable key.",
    );
  }

  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("SUPABASE_URL must be a valid HTTPS URL.");
  }

  const isLocalHttp =
    nodeEnv !== "production" &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]");
  if (
    (url.protocol !== "https:" && !isLocalHttp) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "SUPABASE_URL must be an HTTPS project origin (HTTP is allowed only for a local development instance).",
    );
  }

  return {
    url: url.origin,
    serviceRoleKey,
  };
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BackendConfig {
  const nodeEnv = parseNodeEnvironment(environment.NODE_ENV);
  const clientIpMode = parseClientIpMode(environment.CLIENT_IP_MODE);
  const allowedOrigins = parseAllowedOrigins(
    environment.ALLOWED_ORIGINS,
    nodeEnv,
  );
  if (
    environment.RAILWAY_SERVICE_ID?.trim() &&
    clientIpMode !== "railway"
  ) {
    throw new Error(
      "CLIENT_IP_MODE=railway is required when running on Railway.",
    );
  }
  if (clientIpMode === "railway" && nodeEnv !== "production") {
    throw new Error("CLIENT_IP_MODE=railway is only valid in production.");
  }
  const guestProfiles = parseGuestProfilesConfig(environment, nodeEnv);
  const lateGameExposureDurations =
    parseLateGameExposureDurations(environment);

  let trustProxyHops = 0;
  if (clientIpMode === "railway") {
    if (environment.TRUST_PROXY_HOPS?.trim()) {
      throw new Error(
        "TRUST_PROXY_HOPS must be unset when CLIENT_IP_MODE=railway.",
      );
    }
  } else {
    trustProxyHops = parseIntegerSetting(
      "TRUST_PROXY_HOPS",
      environment.TRUST_PROXY_HOPS,
      0,
      0,
      MAX_TRUST_PROXY_HOPS,
    );
    if (nodeEnv === "production" && trustProxyHops === 0) {
      throw new Error(
        "TRUST_PROXY_HOPS must be at least 1 in production when CLIENT_IP_MODE=socket.",
      );
    }
  }

  return {
    port: parseIntegerSetting("PORT", environment.PORT, DEFAULT_PORT, 1, 65_535),
    allowedOrigins,
    reconnectGracePeriodMs: parseIntegerSetting(
      "RECONNECT_GRACE_PERIOD_MS",
      environment.RECONNECT_GRACE_PERIOD_MS,
      DEFAULT_RECONNECT_GRACE_PERIOD_MS,
      1,
      MAX_RECONNECT_GRACE_PERIOD_MS,
    ),
    nodeEnv,
    clientIpMode,
    trustProxyHops,
    requireHttps: nodeEnv === "production",
    guestProfiles,
    lateGameExposureDurations,
  };
}
