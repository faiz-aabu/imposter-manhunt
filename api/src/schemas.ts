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
} from "./constants.js";
import type {
  CatchAttemptPayload,
  CatchConfirmationResponsePayload,
  CountdownSyncPayload,
  CreateRoomPayload,
  FreezePlayerPayload,
  JoinRoomPayload,
  LeaveRoomPayload,
  LocationUpdatePayload,
  RevealLocationsPayload,
  RoleRequestPayload,
  StartGamePayload,
  UpdateRoomSettingsPayload,
  VoteSubmissionPayload,
  WordImpostorRoleRequestPayload,
  WordImpostorVoteSubmissionPayload,
  ManhuntUpdateSettingsPayload,
  ManhuntReadyUpdatePayload,
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
    targetPlayerId: playerIdSchema,
  })
  .strict() satisfies z.ZodType<FreezePlayerPayload>;

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
