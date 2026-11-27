import type {
  ManhuntLateGameCluePayload,
  ManhuntLateGameClueStatePayload,
  ManhuntLateGameWarningPayload,
  ManhuntLateGameWarningStatePayload,
} from "@impostor/api";

export function getVisibleLateGameClue(
  state: ManhuntLateGameClueStatePayload | null,
  serverNowMs: number,
): ManhuntLateGameCluePayload | null {
  const clue = state?.clue;
  return clue && Date.parse(clue.expiresAt) > serverNowMs ? clue : null;
}

export function getVisibleLateGameWarning(
  state: ManhuntLateGameWarningStatePayload | null,
  serverNowMs: number,
): ManhuntLateGameWarningPayload | null {
  const warning = state?.warning;
  return warning && Date.parse(warning.expiresAt) > serverNowMs
    ? warning
    : null;
}
