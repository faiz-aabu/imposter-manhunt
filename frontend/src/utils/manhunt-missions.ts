import {
  MANHUNT_LOCATION_MAX_AGE_SECONDS,
  MANHUNT_MISSION_CIRCLE_RADIUS_METERS,
  MANHUNT_MISSION_DWELL_SECONDS,
  MANHUNT_MISSION_MAX_ACCURACY_METERS,
  MANHUNT_MISSION_MAX_SAMPLE_GAP_SECONDS,
} from "@impostor/api";
import type {
  Coordinates,
  ManhuntMissionAssignmentPayload,
  ManhuntMissionRevealPayload,
  ManhuntTeam,
} from "@impostor/api";
import type { TranslationKey } from "../i18n/locales";

export interface MissionProgressState {
  startedAtMs: number | null;
  lastSampleAtMs: number | null;
  lastLocationTimestampMs: number | null;
}

export interface MissionLocationSample {
  timestamp: number;
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
  };
}

export const EMPTY_MISSION_PROGRESS: MissionProgressState = {
  startedAtMs: null,
  lastSampleAtMs: null,
  lastLocationTimestampMs: null,
};

export function getVisibleMissionAssignment(
  ownTeam: ManhuntTeam | null,
  ownPlayerId: string | null,
  assignment: ManhuntMissionAssignmentPayload | null,
): ManhuntMissionAssignmentPayload | null {
  return ownTeam === "runner" &&
    ownPlayerId !== null &&
    assignment?.playerId === ownPlayerId
    ? assignment
    : null;
}

export function isMissionCircleVisible(
  assignment: ManhuntMissionAssignmentPayload | null,
  nowMs: number,
): boolean {
  if (assignment?.status !== "active" || !Number.isFinite(nowMs)) {
    return false;
  }
  const deadlineMs = Date.parse(assignment.deadlineAt);
  return Number.isFinite(deadlineMs) && deadlineMs > nowMs;
}

export function getMissionRevealMessage(
  ownTeam: ManhuntTeam | null,
  reveal: ManhuntMissionRevealPayload | null,
  t: (key: TranslationKey) => string,
): string | null {
  if (!reveal) {
    return null;
  }
  if (reveal.outcome === "success" && ownTeam === "runner") {
    return t("manhunt.map.missionSuccessReveal");
  }
  if (reveal.outcome === "failure" && ownTeam === "hunter") {
    return t("manhunt.map.missionFailureReveal");
  }
  return null;
}

export function updateMissionProgress(
  previous: MissionProgressState,
  assignment: ManhuntMissionAssignmentPayload | null,
  sample: MissionLocationSample | null,
  nowMs: number,
): MissionProgressState {
  const accuracy = sample?.coords.accuracy;
  if (
    assignment?.status !== "active" ||
    !isMissionCircleVisible(assignment, nowMs) ||
    !sample ||
    !Number.isFinite(sample.timestamp) ||
    !Number.isFinite(nowMs) ||
    nowMs - sample.timestamp > MANHUNT_LOCATION_MAX_AGE_SECONDS * 1_000 ||
    sample.timestamp > nowMs + 2_000 ||
    typeof accuracy !== "number" ||
    !Number.isFinite(accuracy) ||
    accuracy <= 0 ||
    accuracy > MANHUNT_MISSION_MAX_ACCURACY_METERS ||
    !isCoordinate(sample.coords.latitude, -90, 90) ||
    !isCoordinate(sample.coords.longitude, -180, 180) ||
    !assignment.center
  ) {
    return EMPTY_MISSION_PROGRESS;
  }

  if (
    previous.lastLocationTimestampMs !== null &&
    sample.timestamp <= previous.lastLocationTimestampMs
  ) {
    return previous.lastSampleAtMs !== null &&
      nowMs - previous.lastSampleAtMs <=
        MANHUNT_MISSION_MAX_SAMPLE_GAP_SECONDS * 1_000
      ? previous
      : EMPTY_MISSION_PROGRESS;
  }

  if (
    haversineMeters(assignment.center, sample.coords) + accuracy >
    MANHUNT_MISSION_CIRCLE_RADIUS_METERS
  ) {
    return EMPTY_MISSION_PROGRESS;
  }

  const gapExceeded =
    previous.lastSampleAtMs === null ||
    nowMs - previous.lastSampleAtMs >
      MANHUNT_MISSION_MAX_SAMPLE_GAP_SECONDS * 1_000;
  return {
    startedAtMs: gapExceeded ? nowMs : previous.startedAtMs,
    lastSampleAtMs: nowMs,
    lastLocationTimestampMs: sample.timestamp,
  };
}

export function getMissionProgressSeconds(
  progress: MissionProgressState,
  assignment: ManhuntMissionAssignmentPayload | null,
  nowMs: number,
): number {
  if (assignment?.status === "completed") {
    return MANHUNT_MISSION_DWELL_SECONDS;
  }
  if (
    assignment?.status !== "active" ||
    !isMissionCircleVisible(assignment, nowMs) ||
    progress.startedAtMs === null ||
    progress.lastSampleAtMs === null ||
    nowMs - progress.lastSampleAtMs >
      MANHUNT_MISSION_MAX_SAMPLE_GAP_SECONDS * 1_000
  ) {
    return 0;
  }
  return Math.min(
    MANHUNT_MISSION_DWELL_SECONDS,
    Math.max(0, (nowMs - progress.startedAtMs) / 1_000),
  );
}

export function formatMissionCountdown(
  deadlineAt: string,
  nowMs: number,
): string {
  const deadlineMs = Date.parse(deadlineAt);
  if (!Number.isFinite(deadlineMs)) {
    return "--:--";
  }
  const totalSeconds = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function isCoordinate(
  value: number,
  minimum: number,
  maximum: number,
): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function haversineMeters(first: Coordinates, second: Coordinates): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const firstLatitude = toRadians(first.latitude);
  const secondLatitude = toRadians(second.latitude);
  const latitudeDelta = secondLatitude - firstLatitude;
  const longitudeDelta = toRadians(second.longitude - first.longitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(haversine));
}
