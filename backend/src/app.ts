import express from "express";
import type {
  ErrorRequestHandler,
  RequestHandler,
  Response,
} from "express";
import {
  createGuestProfileSchema,
  linkGuestProfileSchema,
  restoreGuestProfileSchema,
  roomCodeSchema,
} from "@impostor/api";
import type {
  ApiErrorCode,
  CreateGuestProfileResponse,
  GetHealthResponse,
  GetRoomResponse,
  LinkGuestProfileResponse,
  RestErrorResponse,
  RestoreGuestProfileResponse,
} from "@impostor/api";
import type { BackendConfig } from "./config/env.js";
import { GuestProfileService } from "./guest-profiles/guest-profile-service.js";
import { RoomService } from "./rooms/room-service.js";
import { InMemoryRateLimiter } from "./services/rate-limiter.js";
import { AppError } from "./utils/app-error.js";
import { getClientIp } from "./utils/client-ip.js";
import { isOriginAllowed } from "./utils/cors.js";
import { isSecureTransport } from "./utils/transport.js";

const GUEST_PROFILE_RATE_LIMIT_WINDOW_MS = 60_000;
const GUEST_PROFILE_CREATE_LIMIT = 5;
const GUEST_PROFILE_RESTORE_LIMIT = 12;
const GUEST_PROFILE_LINK_LIMIT = 10;

export interface BackendReadinessResponse {
  readonly processAlive: true;
  readonly acceptingTraffic: boolean;
  readonly durableRuntimeReadiness: string;
  readonly durableRuntimeInitialized: boolean;
  readonly databaseLeaseOwned: boolean | null;
  readonly waitingRoomRecoveryCompleted: boolean;
  readonly shuttingDown: boolean;
  readonly unresolved: {
    readonly trackedReconciliations: number;
    readonly exhaustedReconciliations: number;
    readonly pendingExpirations: number;
    readonly pendingExpirationCleanup: number;
    readonly scheduledReconnectTimeouts: number;
    readonly pendingTimeoutSideEffects: number;
  };
}

export function createApp(
  config: BackendConfig,
  rooms: RoomService,
  guestProfiles = new GuestProfileService(config.guestProfiles),
  getReadiness: () => BackendReadinessResponse = () => ({
    processAlive: true,
    acceptingTraffic: true,
    durableRuntimeReadiness: "disabled",
    durableRuntimeInitialized: false,
    databaseLeaseOwned: null,
    waitingRoomRecoveryCompleted: false,
    shuttingDown: false,
    unresolved: {
      trackedReconciliations: 0,
      exhaustedReconciliations: 0,
      pendingExpirations: 0,
      pendingExpirationCleanup: 0,
      scheduledReconnectTimeouts: 0,
      pendingTimeoutSideEffects: 0,
    },
  }),
): express.Express {
  const app = express();
  const guestProfileRateLimiter = new InMemoryRateLimiter();
  app.set(
    "trust proxy",
    config.clientIpMode === "railway" ? false : config.trustProxyHops,
  );
  app.disable("x-powered-by");
  app.use(createSecurityHeaders(config));
  app.use(createHttpsMiddleware(config));
  app.use(createCorsMiddleware(config));
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (_request, response: Response<GetHealthResponse>) => {
    response.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/ready", (_request, response) => {
    const readiness = getReadiness();
    response
      .status(readiness.acceptingTraffic ? 200 : 503)
      .json(readiness);
  });

  app.post(
    "/guest-profiles",
    async (
      request,
      response: Response<CreateGuestProfileResponse | RestErrorResponse>,
      next,
    ) => {
      try {
        requireGuestProfileFeature(guestProfiles);
        consumeGuestProfileRateLimit(
          request,
          config,
          guestProfileRateLimiter,
          "create",
          GUEST_PROFILE_CREATE_LIMIT,
        );
        const parsed = createGuestProfileSchema.safeParse(request.body);
        if (!parsed.success) {
          throw new AppError(
            "INVALID_PAYLOAD",
            "Guest profile request is invalid.",
          );
        }

        const created = await guestProfiles.create(parsed.data.nickname);
        response.status(201).json(created);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/guest-profiles/restore",
    async (
      request,
      response: Response<RestoreGuestProfileResponse | RestErrorResponse>,
      next,
    ) => {
      try {
        requireGuestProfileFeature(guestProfiles);
        consumeGuestProfileRateLimit(
          request,
          config,
          guestProfileRateLimiter,
          "restore",
          GUEST_PROFILE_RESTORE_LIMIT,
        );
        const parsed = restoreGuestProfileSchema.safeParse(request.body);
        if (!parsed.success) {
          throw new AppError(
            "INVALID_PAYLOAD",
            "Guest profile restoration request is invalid.",
          );
        }

        response.json(await guestProfiles.restore(parsed.data.credential));
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    "/guest-profiles/link",
    async (
      request,
      response: Response<LinkGuestProfileResponse | RestErrorResponse>,
      next,
    ) => {
      try {
        requireGuestProfileFeature(guestProfiles);
        consumeGuestProfileRateLimit(
          request,
          config,
          guestProfileRateLimiter,
          "link",
          GUEST_PROFILE_LINK_LIMIT,
        );
        const parsed = linkGuestProfileSchema.safeParse(request.body);
        if (!parsed.success) {
          throw new AppError(
            "INVALID_PAYLOAD",
            "Guest profile linking request is invalid.",
          );
        }

        const authorization = request.get("authorization");
        const bearer = authorization?.match(/^Bearer ([^\s]+)$/i);
        if (!bearer?.[1]) {
          throw new AppError(
            "INVALID_CREDENTIAL",
            "A valid signed-in session is required.",
          );
        }

        response.json(
          await guestProfiles.linkToAccount(parsed.data.credential, bearer[1]),
        );
      } catch (error) {
        next(error);
      }
    },
  );

  app.get(
    "/rooms/:code",
    (request, response: Response<GetRoomResponse | RestErrorResponse>, next) => {
      const parsedCode = roomCodeSchema.safeParse(request.params.code);
      if (!parsedCode.success) {
        response.status(400).json({
          error: {
            code: "INVALID_PAYLOAD",
            message: "Room code is invalid.",
          },
        });
        return;
      }

      const room = rooms.getPublicRoom(parsedCode.data);
      if (!room) {
        response.status(404).json({
          error: {
            code: "ROOM_NOT_FOUND",
            message: "Room does not exist.",
          },
        });
        return;
      }

      try {
        response.json(room satisfies GetRoomResponse);
      } catch (error) {
        next(error);
      }
    },
  );

  app.use((_request, response: Response<RestErrorResponse>) => {
    response.status(404).json({
      error: {
        code: "UNKNOWN",
        message: "Route does not exist.",
      },
    });
  });
  app.use(createErrorHandler(config));

  return app;
}

function requireGuestProfileFeature(
  guestProfiles: GuestProfileService,
): void {
  if (!guestProfiles.isConfigured) {
    throw new AppError(
      "FEATURE_UNAVAILABLE",
      "Guest profiles are not configured on this server.",
    );
  }
}

function consumeGuestProfileRateLimit(
  request: express.Request,
  config: BackendConfig,
  limiter: InMemoryRateLimiter,
  action: "create" | "restore" | "link",
  limit: number,
): void {
  const clientIp = getClientIp(
    request.headers,
    request.socket.remoteAddress,
    config.clientIpMode,
    config.trustProxyHops,
  );
  if (!clientIp) {
    throw new AppError(
      "NOT_AUTHORIZED",
      "The client address could not be determined.",
    );
  }
  if (
    !limiter.consume(
      `guest-profile:${action}:${clientIp}`,
      limit,
      GUEST_PROFILE_RATE_LIMIT_WINDOW_MS,
    )
  ) {
    throw new AppError(
      "RATE_LIMITED",
      "Too many guest profile requests. Please try again later.",
    );
  }
}

function createSecurityHeaders(config: BackendConfig): RequestHandler {
  return (request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=()",
    );
    response.setHeader("Cache-Control", "no-store");
    if (
      config.requireHttps &&
      isSecureTransport(
        request,
        config.clientIpMode,
        config.trustProxyHops,
      )
    ) {
      response.setHeader("Strict-Transport-Security", "max-age=31536000");
    }
    next();
  };
}

function createHttpsMiddleware(config: BackendConfig): RequestHandler {
  return (request, response, next) => {
    if (
      !config.requireHttps ||
      request.path === "/health" ||
      isSecureTransport(
        request,
        config.clientIpMode,
        config.trustProxyHops,
      )
    ) {
      next();
      return;
    }

    sendRestError(
      response,
      426,
      "NOT_AUTHORIZED",
      "HTTPS is required.",
    );
  };
}

function createCorsMiddleware(config: BackendConfig): RequestHandler {
  return (request, response, next) => {
    const origin = request.get("origin");
    if (!isOriginAllowed(origin, config.allowedOrigins)) {
      next(
        new AppError("NOT_AUTHORIZED", "Origin is not allowed.", 403),
      );
      return;
    }

    if (origin) {
      response.setHeader(
        "Access-Control-Allow-Origin",
        config.allowedOrigins.includes("*") ? "*" : origin,
      );
      response.setHeader("Vary", "Origin");
    }
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    response.setHeader("Access-Control-Max-Age", "600");

    if (request.method === "OPTIONS") {
      response.sendStatus(204);
      return;
    }
    next();
  };
}

function createErrorHandler(config: BackendConfig): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }

    if (error instanceof AppError) {
      sendRestError(response, error.statusCode, error.code, error.message);
      return;
    }

    if (isJsonParseError(error)) {
      sendRestError(
        response,
        400,
        "INVALID_PAYLOAD",
        "Request body must contain valid JSON.",
      );
      return;
    }

    if (isEntityTooLargeError(error)) {
      sendRestError(
        response,
        413,
        "INVALID_PAYLOAD",
        "Request body exceeds the allowed size.",
      );
      return;
    }

    console.error(JSON.stringify({
      level: "error",
      message: "Unhandled HTTP request error.",
      ...(config.nodeEnv === "production"
        ? {}
        : {
            error: error instanceof Error ? error.stack ?? error.message : String(error),
          }),
    }));
    sendRestError(
      response,
      500,
      "UNKNOWN",
      "An unexpected server error occurred.",
    );
  };
}

function isEntityTooLargeError(
  error: unknown,
): error is { type: "entity.too.large" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.too.large"
  );
}

function sendRestError(
  response: Response<RestErrorResponse>,
  statusCode: number,
  code: ApiErrorCode,
  message: string,
): void {
  response.status(statusCode).json({
    error: { code, message },
  });
}

function isJsonParseError(
  error: unknown,
): error is { type: "entity.parse.failed" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.parse.failed"
  );
}

