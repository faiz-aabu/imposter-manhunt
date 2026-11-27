import { z } from "zod";
import {
  GAME_MODES,
  MAX_DISCUSSION_DURATION_SECONDS,
  MAX_LOCATION_ACCURACY_METERS,
  MAX_PLAYER_ID_LENGTH,
  MAX_PLAYERS_PER_ROOM,
  MIN_DISCUSSION_DURATION_SECONDS,
  MIN_VOTING_DURATION_SECONDS,
  MAX_VOTING_DURATION_SECONDS,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  ROOM_CODE_PATTERN,
  ROOM_CODE_LENGTH,
  MIN_PLAYERS_PER_ROOM,
  WORD_IMPOSTOR_CATEGORIES,
  MIN_MANHUNT_HUNTERS,
  MIN_MANHUNT_BOUNDARY_RADIUS_METERS,
  MAX_MANHUNT_BOUNDARY_RADIUS_METERS,
  MANHUNT_GAME_DURATION_OPTIONS_SECONDS,
  MANHUNT_MISSION_CIRCLE_RADIUS_METERS,
  MANHUNT_FOOTSTEPS_DURATION_SECONDS,
  MANHUNT_FOOTSTEPS_MAX_USES_PER_GAME,
  MANHUNT_SMOKE_BOMB_DURATION_SECONDS,
  MANHUNT_SMOKE_BOMB_MAX_USES_PER_GAME,
  MANHUNT_GHOST_DURATION_SECONDS,
  MANHUNT_FREEZE_DECOY_DURATION_SECONDS,
  MANHUNT_FREEZE_DECOY_MAX_USES_PER_GAME,
  MANHUNT_LATE_GAME_EXPOSURE_MIN_LOCATION_AGE_SECONDS,
  MANHUNT_LATE_GAME_EXPOSURE_MAX_LOCATION_AGE_SECONDS,
} from "./constants.js";
import type {
  CatchAttemptPayload,
  CatchConfirmationResponsePayload,
  ClockSyncPayload,
  CountdownSyncPayload,
  CreateRoomPayload,
  FreezePlayerPayload,
  FootstepsRequestPayload,
  JoinRoomPayload,
  LeaveRoomPayload,
  LocationUpdatePayload,
  RevealLocationsPayload,
  RoleRequestPayload,
  ReturnToLobbyPayload,
  StartGamePayload,
  UpdateRoomSettingsPayload,
  VoteSubmissionPayload,
  WordImpostorRoleRequestPayload,
  WordImpostorVoteSubmissionPayload,
  ManhuntUpdateSettingsPayload,
  ManhuntReadyUpdatePayload,
  ManhuntMissionAssignmentPayload,
  ManhuntMissionRevealPayload,
  ManhuntFreezeWarningPayload,
  PlayerFrozenPayload,
  PlayerFreezeEndedPayload,
  ManhuntFootstepsGuidancePayload,
  ManhuntFootstepsStatePayload,
  SmokeBombRequestPayload,
  ManhuntSmokeBombEffectPayload,
  ManhuntSmokeBombStatePayload,
  GhostRequestPayload,
  ManhuntGhostEffectPayload,
  ManhuntGhostStatePayload,
  FreezeDecoyRequestPayload,
  ManhuntFreezeDecoyPayload,
  ManhuntFreezeDecoyStatePayload,
  ManhuntFreezeDecoyUsageStatePayload,
  ManhuntLateGameCluePayload,
  ManhuntLateGameClueStatePayload,
  ManhuntLateGameWarningPayload,
  ManhuntLateGameWarningStatePayload,
} from "./payloads.js";
import type {
  ClassicImpostorSettings,
  Coordinates,
  RoomSettings,
  WordImpostorSettings,
  ManhuntSettings,
} from "./types/index.js";

export const nicknameSchema = z
  .string()
  .trim()
  .min(NICKNAME_MIN_LENGTH)
  .max(NICKNAME_MAX_LENGTH);

export const createGuestProfileSchema = z
  .object({
    nickname: nicknameSchema,
  })
  .strict();

export const guestCredentialSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/);

export const restoreGuestProfileSchema = z
  .object({
    credential: guestCredentialSchema,
  })
  .strict();

export const linkGuestProfileSchema = z
  .object({
    credential: guestCredentialSchema,
  })
  .strict();

export const roomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(
    ROOM_CODE_PATTERN,
    `Room code must contain ${ROOM_CODE_LENGTH} letters A-Z.`,
  );

export const classicImpostorSettingsSchema = z
  .object({
    impostorCount: z.number().int().min(1).max(MAX_PLAYERS_PER_ROOM - 1),
    discussionDurationSeconds: z
      .number()
      .int()
      .min(MIN_DISCUSSION_DURATION_SECONDS)
      .max(MAX_DISCUSSION_DURATION_SECONDS),
    votingDurationSeconds: z
      .number()
      .int()
      .min(MIN_VOTING_DURATION_SECONDS)
      .max(MAX_VOTING_DURATION_SECONDS),
  })
  .strict() satisfies z.ZodType<ClassicImpostorSettings>;

export const wordImpostorSettingsSchema = z
  .object({
    category: z.enum(WORD_IMPOSTOR_CATEGORIES),
    impostorCount: z.number().int().min(1).max(MAX_PLAYERS_PER_ROOM - 1),
    discussionDurationSeconds: z
      .number()
      .int()
      .min(MIN_DISCUSSION_DURATION_SECONDS)
      .max(MAX_DISCUSSION_DURATION_SECONDS),
    votingDurationSeconds: z
      .number()
      .int()
      .min(MIN_VOTING_DURATION_SECONDS)
      .max(MAX_VOTING_DURATION_SECONDS),
  })
  .strict() satisfies z.ZodType<WordImpostorSettings>;

export const coordinatesSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict() satisfies z.ZodType<Coordinates>;

export const manhuntBoundarySchema = z
  .object({
    center: coordinatesSchema,
    radiusMeters: z
      .number()
      .finite()
      .min(MIN_MANHUNT_BOUNDARY_RADIUS_METERS)
      .max(MAX_MANHUNT_BOUNDARY_RADIUS_METERS),
  })
  .strict();

export const manhuntSettingsSchema = z
  .object({
    hunterCount: z.number().int().min(MIN_MANHUNT_HUNTERS).max(MAX_PLAYERS_PER_ROOM - 1),
    boundary: manhuntBoundarySchema,
    gameDurationSeconds: z.union([
      z.literal(MANHUNT_GAME_DURATION_OPTIONS_SECONDS[0]),
      z.literal(MANHUNT_GAME_DURATION_OPTIONS_SECONDS[1]),
      z.literal(MANHUNT_GAME_DURATION_OPTIONS_SECONDS[2]),
    ]).default(3_600),
  })
  .strict() satisfies z.ZodType<ManhuntSettings>;

const roomSettingsBaseSchema = z
  .object({
    gameMode: z.enum(GAME_MODES),
    maxPlayers: z
      .number()
      .int()
      .min(MIN_PLAYERS_PER_ROOM)
      .max(MAX_PLAYERS_PER_ROOM),
    isPrivate: z.boolean(),
    classicImpostor: classicImpostorSettingsSchema.optional(),
    wordImpostor: wordImpostorSettingsSchema.optional(),
    manhunt: manhuntSettingsSchema.optional(),
  })
  .strict();

export const roomSettingsSchema = roomSettingsBaseSchema.superRefine(
  (settings, context) => {
    if (
      settings.classicImpostor !== undefined &&
      settings.gameMode !== "impostor-classic"
    ) {
      context.addIssue({
        code: "custom",
        path: ["classicImpostor"],
        message: "Classic Impostor settings require impostor-classic mode.",
      });
    }
    if (
      settings.wordImpostor !== undefined &&
      settings.gameMode !== "impostor-word"
    ) {
      context.addIssue({
        code: "custom",
        path: ["wordImpostor"],
        message: "Word Impostor settings require impostor-word mode.",
      });
    }
    if (
      settings.manhunt !== undefined &&
      settings.gameMode !== "manhunt"
    ) {
      context.addIssue({
        code: "custom",
        path: ["manhunt"],
        message: "Manhunt settings require manhunt mode.",
      });
    }
  },
) satisfies z.ZodType<RoomSettings>;

const playerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PLAYER_ID_LENGTH);

export const createRoomSchema = z
  .object({
    nickname: nicknameSchema,
    settings: roomSettingsSchema.optional(),
  })
  .strict() satisfies z.ZodType<CreateRoomPayload>;

export const joinRoomSchema = z
  .object({
    roomCode: roomCodeSchema,
    nickname: nicknameSchema,
  })
  .strict() satisfies z.ZodType<JoinRoomPayload>;

export const leaveRoomSchema = z
  .object({
    roomCode: roomCodeSchema,
  })
  .strict() satisfies z.ZodType<LeaveRoomPayload>;

export const updateRoomSettingsSchema = z
  .object({
    roomCode: roomCodeSchema,
    settings: roomSettingsSchema,
  })
  .strict() satisfies z.ZodType<UpdateRoomSettingsPayload>;

export const returnToLobbySchema = z
  .object({
    roomCode: roomCodeSchema,
  })
  .strict() satisfies z.ZodType<ReturnToLobbyPayload>;

export const startGameSchema = z
  .object({
    roomCode: roomCodeSchema,
  })
  .strict() satisfies z.ZodType<StartGamePayload>;

export const roleRequestSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
  })
  .strict() satisfies z.ZodType<RoleRequestPayload>;

export const voteSubmissionSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    votingEndsAt: z.iso.datetime(),
    votingPhaseId: z.number().int().positive(),
    targetPlayerId: playerIdSchema,
  })
  .strict() satisfies z.ZodType<VoteSubmissionPayload>;

export const wordImpostorRoleRequestSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
  })
  .strict() satisfies z.ZodType<WordImpostorRoleRequestPayload>;

export const wordImpostorVoteSubmissionSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    votingEndsAt: z.iso.datetime(),
    votingPhaseId: z.number().int().positive(),
    targetPlayerId: playerIdSchema,
  })
  .strict() satisfies z.ZodType<WordImpostorVoteSubmissionPayload>;

export const locationUpdateSchema = z
  .object({
    roomCode: roomCodeSchema,
    coordinates: coordinatesSchema,
    accuracyMeters: z
      .number()
      .finite()
      .positive()
      .max(MAX_LOCATION_ACCURACY_METERS)
      .optional(),
    clientTimestamp: z.iso.datetime().optional(),
  })
  .strict() satisfies z.ZodType<LocationUpdatePayload>;

const manhuntMissionRevealedLocationSchema = z
  .object({
    playerId: playerIdSchema,
    coordinates: coordinatesSchema,
    status: z.enum([
      "waiting",
      "active",
      "eliminated",
      "frozen",
      "caught",
      "escaped",
    ]),
  })
  .strict();

export const manhuntMissionAssignmentSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(128),
    playerId: playerIdSchema,
    center: coordinatesSchema,
    radiusMeters: z.literal(MANHUNT_MISSION_CIRCLE_RADIUS_METERS),
    revealedAt: z.iso.datetime(),
    deadlineAt: z.iso.datetime(),
    status: z.enum(["active", "completed", "failed", "cancelled"]),
  })
  .strict() satisfies z.ZodType<ManhuntMissionAssignmentPayload>;

export const manhuntMissionRevealSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(128),
    outcome: z.enum(["success", "failure"]),
    locations: z.array(manhuntMissionRevealedLocationSchema).max(MAX_PLAYERS_PER_ROOM),
    visibleUntil: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<ManhuntMissionRevealPayload>;

export const revealLocationsSchema = z
  .object({
    roomCode: roomCodeSchema,
    targetPlayerIds: z
      .array(playerIdSchema)
      .max(MAX_PLAYERS_PER_ROOM)
      .optional(),
  })
  .strict() satisfies z.ZodType<RevealLocationsPayload>;

export const freezePlayerSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    requestId: z.uuid(),
  })
  .strict() satisfies z.ZodType<FreezePlayerPayload>;

export const manhuntFreezeWarningSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    playerId: playerIdSchema,
    requestId: z.uuid(),
    warningStartedAt: z.iso.datetime(),
    warningEndsAt: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<ManhuntFreezeWarningPayload>;

export const playerFrozenSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    playerId: playerIdSchema,
    requestId: z.uuid(),
    frozenAt: z.iso.datetime(),
    frozenUntil: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<PlayerFrozenPayload>;

export const playerFreezeEndedSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    playerId: playerIdSchema,
    requestId: z.uuid(),
    endedAt: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<PlayerFreezeEndedPayload>;

export const footstepsRequestSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    requestId: z.uuid(),
  })
  .strict() satisfies z.ZodType<FootstepsRequestPayload>;

export const manhuntFootstepsGuidanceSchema = z
  .object({
    requestId: z.uuid(),
    bearingDegrees: z.number().finite().min(0).lt(360),
    startedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    ({ startedAt, expiresAt }) =>
      Date.parse(expiresAt) - Date.parse(startedAt) ===
      MANHUNT_FOOTSTEPS_DURATION_SECONDS * 1_000,
  ) satisfies z.ZodType<ManhuntFootstepsGuidancePayload>;

export const manhuntFootstepsStateSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    playerId: playerIdSchema,
    remainingUses: z
      .number()
      .int()
      .min(0)
      .max(MANHUNT_FOOTSTEPS_MAX_USES_PER_GAME),
    serverNow: z.iso.datetime(),
    guidances: z
      .array(manhuntFootstepsGuidanceSchema)
      .max(MANHUNT_FOOTSTEPS_MAX_USES_PER_GAME),
  })
  .strict() satisfies z.ZodType<ManhuntFootstepsStatePayload>;

export const smokeBombRequestSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    requestId: z.uuid(),
  })
  .strict() satisfies z.ZodType<SmokeBombRequestPayload>;

export const manhuntSmokeBombEffectSchema = z
  .object({
    requestId: z.uuid(),
    startedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    ({ startedAt, expiresAt }) =>
      Date.parse(expiresAt) - Date.parse(startedAt) ===
      MANHUNT_SMOKE_BOMB_DURATION_SECONDS * 1_000,
  ) satisfies z.ZodType<ManhuntSmokeBombEffectPayload>;

export const manhuntSmokeBombStateSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    playerId: playerIdSchema,
    remainingUses: z
      .number()
      .int()
      .min(0)
      .max(MANHUNT_SMOKE_BOMB_MAX_USES_PER_GAME),
    serverNow: z.iso.datetime(),
    activeEffects: z
      .array(manhuntSmokeBombEffectSchema)
      .max(MANHUNT_SMOKE_BOMB_MAX_USES_PER_GAME),
  })
  .strict() satisfies z.ZodType<ManhuntSmokeBombStatePayload>;

export const ghostRequestSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    requestId: z.uuid(),
  })
  .strict() satisfies z.ZodType<GhostRequestPayload>;

export const manhuntGhostEffectSchema = z
  .object({
    requestId: z.uuid(),
    startedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    ({ startedAt, expiresAt }) =>
      Date.parse(expiresAt) - Date.parse(startedAt) ===
      MANHUNT_GHOST_DURATION_SECONDS * 1_000,
  ) satisfies z.ZodType<ManhuntGhostEffectPayload>;

export const manhuntGhostStateSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    playerId: playerIdSchema,
    usageLimit: z.number().int().positive().nullable(),
    remainingUses: z.number().int().nonnegative().nullable(),
    serverNow: z.iso.datetime(),
    activeEffects: z.array(manhuntGhostEffectSchema),
  })
  .strict()
  .refine(
    ({ usageLimit, remainingUses, activeEffects }) =>
      (usageLimit === null &&
        remainingUses === null &&
        activeEffects.length === 0) ||
      (usageLimit !== null &&
        remainingUses !== null &&
        remainingUses <= usageLimit &&
        activeEffects.length <= usageLimit),
  ) satisfies z.ZodType<ManhuntGhostStatePayload>;

export const freezeDecoyRequestSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    requestId: z.uuid(),
  })
  .strict() satisfies z.ZodType<FreezeDecoyRequestPayload>;

export const manhuntFreezeDecoySchema = z
  .object({
    decoyId: z.uuid(),
    coordinates: coordinatesSchema,
    startedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    ({ startedAt, expiresAt }) =>
      Date.parse(expiresAt) - Date.parse(startedAt) ===
      MANHUNT_FREEZE_DECOY_DURATION_SECONDS * 1_000,
  ) satisfies z.ZodType<ManhuntFreezeDecoyPayload>;

export const manhuntFreezeDecoyStateSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    serverNow: z.iso.datetime(),
    decoys: z
      .array(manhuntFreezeDecoySchema)
      .max(MAX_PLAYERS_PER_ROOM * MANHUNT_FREEZE_DECOY_MAX_USES_PER_GAME),
  })
  .strict()
  .refine(
    ({ decoys }) =>
      new Set(decoys.map(({ decoyId }) => decoyId)).size === decoys.length,
  ) satisfies z.ZodType<ManhuntFreezeDecoyStatePayload>;

export const manhuntFreezeDecoyUsageStateSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    playerId: playerIdSchema,
    remainingUses: z
      .number()
      .int()
      .min(0)
      .max(MANHUNT_FREEZE_DECOY_MAX_USES_PER_GAME),
    serverNow: z.iso.datetime(),
  })
  .strict() satisfies z.ZodType<ManhuntFreezeDecoyUsageStatePayload>;

export const manhuntLateGameClueSchema = z
  .object({
    clueId: z.uuid(),
    coordinates: coordinatesSchema,
    recordedAt: z.iso.datetime(),
    exposedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    ({ recordedAt, exposedAt }) => {
      const ageMs = Date.parse(exposedAt) - Date.parse(recordedAt);
      return (
        ageMs >= MANHUNT_LATE_GAME_EXPOSURE_MIN_LOCATION_AGE_SECONDS * 1_000 &&
        ageMs <= MANHUNT_LATE_GAME_EXPOSURE_MAX_LOCATION_AGE_SECONDS * 1_000
      );
    },
  )
  .refine(
    ({ exposedAt, expiresAt }) => Date.parse(expiresAt) > Date.parse(exposedAt),
  ) satisfies z.ZodType<ManhuntLateGameCluePayload>;

export const manhuntLateGameClueStateSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    serverNow: z.iso.datetime(),
    clue: manhuntLateGameClueSchema.nullable(),
  })
  .strict() satisfies z.ZodType<ManhuntLateGameClueStatePayload>;

export const manhuntLateGameWarningSchema = z
  .object({
    exposureId: z.uuid(),
    startedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .refine(
    ({ startedAt, expiresAt }) => Date.parse(expiresAt) > Date.parse(startedAt),
  ) satisfies z.ZodType<ManhuntLateGameWarningPayload>;

export const manhuntLateGameWarningStateSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
    playerId: playerIdSchema,
    serverNow: z.iso.datetime(),
    warning: manhuntLateGameWarningSchema.nullable(),
  })
  .strict() satisfies z.ZodType<ManhuntLateGameWarningStatePayload>;

export const catchAttemptSchema = z
  .object({
    roomCode: roomCodeSchema,
    targetPlayerId: playerIdSchema,
  })
  .strict() satisfies z.ZodType<CatchAttemptPayload>;

export const catchConfirmationResponseSchema = z
  .object({
    roomCode: roomCodeSchema,
    requestId: z.uuid(),
    accepted: z.boolean(),
  })
  .strict() satisfies z.ZodType<CatchConfirmationResponsePayload>;

export const clockSyncSchema = z
  .object({
    requestId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict() satisfies z.ZodType<ClockSyncPayload>;

export const manhuntCountdownSyncSchema = z
  .object({
    roomCode: roomCodeSchema,
    sessionId: z.string().trim().min(1).max(128),
  })
  .strict() satisfies z.ZodType<CountdownSyncPayload>;

export const manhuntUpdateSettingsSchema = z
  .object({
    roomCode: roomCodeSchema,
    settings: manhuntSettingsSchema,
  })
  .strict() satisfies z.ZodType<ManhuntUpdateSettingsPayload>;

export const manhuntReadySchema = z
  .object({
    roomCode: roomCodeSchema,
    ready: z.boolean(),
  })
  .strict() satisfies z.ZodType<ManhuntReadyUpdatePayload>;

export type NicknameInput = z.infer<typeof nicknameSchema>;
export type RoomCodeInput = z.infer<typeof roomCodeSchema>;
export type RoomSettingsInput = z.infer<typeof roomSettingsSchema>;
export type ClassicImpostorSettingsInput = z.infer<
  typeof classicImpostorSettingsSchema
>;
export type WordImpostorSettingsInput = z.infer<
  typeof wordImpostorSettingsSchema
>;
export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type JoinRoomInput = z.infer<typeof joinRoomSchema>;
export type LeaveRoomInput = z.infer<typeof leaveRoomSchema>;
export type UpdateRoomSettingsInput = z.infer<
  typeof updateRoomSettingsSchema
>;
export type StartGameInput = z.infer<typeof startGameSchema>;
export type RoleRequestInput = z.infer<typeof roleRequestSchema>;
export type VoteSubmissionInput = z.infer<typeof voteSubmissionSchema>;
export type WordImpostorRoleRequestInput = z.infer<
  typeof wordImpostorRoleRequestSchema
>;
export type WordImpostorVoteSubmissionInput = z.infer<
  typeof wordImpostorVoteSubmissionSchema
>;
export type CoordinatesInput = z.infer<typeof coordinatesSchema>;
export type LocationUpdateInput = z.infer<typeof locationUpdateSchema>;
export type RevealLocationsInput = z.infer<typeof revealLocationsSchema>;
export type FreezePlayerInput = z.infer<typeof freezePlayerSchema>;
export type CatchAttemptInput = z.infer<typeof catchAttemptSchema>;
export type CatchConfirmationResponseInput = z.infer<
  typeof catchConfirmationResponseSchema
>;
export type ManhuntUpdateSettingsInput = z.infer<
  typeof manhuntUpdateSettingsSchema
>;
