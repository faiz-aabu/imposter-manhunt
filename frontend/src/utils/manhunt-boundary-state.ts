import type {
  ManhuntBoundary,
  ManhuntCountdownCancelledPayload,
  ManhuntTeamAssignmentPayload,
  PlayerId,
} from "@impostor/api";

export interface ManhuntBoundaryCacheState {
  roomCode: string | null;
  boundary: ManhuntBoundary | null;
}

export function clearBoundaryForHunterAssignment(
  state: ManhuntBoundaryCacheState,
  roomCode: string,
  playerId: PlayerId,
  assignment: ManhuntTeamAssignmentPayload,
): ManhuntBoundaryCacheState {
  if (
    state.roomCode !== roomCode ||
    assignment.playerId !== playerId ||
    assignment.team !== "hunter"
  ) {
    return state;
  }
  return { roomCode, boundary: null };
}

export function clearBoundaryAfterCountdownCancellation(
  state: ManhuntBoundaryCacheState,
  roomCode: string,
  sessionId: string,
  cancellation: ManhuntCountdownCancelledPayload,
): ManhuntBoundaryCacheState {
  if (
    state.roomCode !== roomCode ||
    cancellation.roomCode !== roomCode ||
    cancellation.sessionId !== sessionId
  ) {
    return state;
  }
  return { roomCode, boundary: null };
}
