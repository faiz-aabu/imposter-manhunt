import {
  MANHUNT_EVENTS,
  manhuntMissionAssignmentSchema,
  manhuntMissionRevealSchema,
} from "@impostor/api";
import type {
  ManhuntMissionAssignmentPayload,
  ManhuntMissionRevealPayload,
} from "@impostor/api";
import {
  getServerDeadlineRemainingMs,
  scheduleServerDeadline,
} from "./server-clock-sync";
import { useManhuntGameStore } from "../store/manhunt-game-store";
import { useRoomStore } from "../store/room-store";

export interface ManhuntMissionSocket {
  on(
    event: typeof MANHUNT_EVENTS.MISSION_ASSIGNMENT,
    listener: (payload: ManhuntMissionAssignmentPayload) => void,
  ): unknown;
  on(
    event: typeof MANHUNT_EVENTS.MISSION_REVEAL,
    listener: (payload: ManhuntMissionRevealPayload) => void,
  ): unknown;
  off(
    event: typeof MANHUNT_EVENTS.MISSION_ASSIGNMENT,
    listener: (payload: ManhuntMissionAssignmentPayload) => void,
  ): unknown;
  off(
    event: typeof MANHUNT_EVENTS.MISSION_REVEAL,
    listener: (payload: ManhuntMissionRevealPayload) => void,
  ): unknown;
}

export interface ManhuntMissionEventSubscription {
  clearRevealTimer: () => void;
  dispose: () => void;
}

export function subscribeToManhuntMissionEvents(
  socket: ManhuntMissionSocket,
): ManhuntMissionEventSubscription {
  let cancelRevealTimer: (() => void) | undefined;

  const clearRevealTimer = () => {
    cancelRevealTimer?.();
    cancelRevealTimer = undefined;
  };

  const isSameReveal = (
    current: ManhuntMissionRevealPayload | null,
    expected: ManhuntMissionRevealPayload,
  ) =>
    current?.sessionId === expected.sessionId &&
    current.visibleUntil === expected.visibleUntil &&
    current.outcome === expected.outcome;

  const scheduleRevealExpiry = (
    reveal: ManhuntMissionRevealPayload,
  ): void => {
    clearRevealTimer();
    const game = useManhuntGameStore.getState();
    if (!isSameReveal(game.missionReveal, reveal)) {
      return;
    }
    const remainingMs = getServerDeadlineRemainingMs(
      reveal.visibleUntil,
      game.serverTimeOffsetMs,
    );
    if (remainingMs === null || remainingMs <= 0) {
      game.clearMissionReveal();
      return;
    }
    cancelRevealTimer = scheduleServerDeadline(
      reveal.visibleUntil,
      game.serverTimeOffsetMs,
      () => {
        cancelRevealTimer = undefined;
        const current = useManhuntGameStore.getState();
        if (!isSameReveal(current.missionReveal, reveal)) {
          return;
        }
        const currentRemainingMs = getServerDeadlineRemainingMs(
          reveal.visibleUntil,
          current.serverTimeOffsetMs,
        );
        if (currentRemainingMs === null || currentRemainingMs <= 0) {
          current.clearMissionReveal();
        } else {
          scheduleRevealExpiry(reveal);
        }
      },
    );
  };

  const unsubscribeStore = useManhuntGameStore.subscribe((state, previous) => {
    if (state.missionReveal !== previous.missionReveal) {
      if (state.missionReveal) {
        scheduleRevealExpiry(state.missionReveal);
      } else {
        clearRevealTimer();
      }
    } else if (
      state.serverTimeOffsetMs !== previous.serverTimeOffsetMs &&
      state.missionReveal
    ) {
      scheduleRevealExpiry(state.missionReveal);
    }
  });

  const missionAssigned = (payload: ManhuntMissionAssignmentPayload) => {
    const parsed = manhuntMissionAssignmentSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const game = useManhuntGameStore.getState();
    if (
      game.session?.id !== parsed.data.sessionId ||
      game.session.roomCode !== useRoomStore.getState().room?.code ||
      game.ownTeam !== "runner" ||
      game.ownPlayerId !== parsed.data.playerId
    ) {
      return;
    }
    game.setMissionAssignment(parsed.data);
  };

  const missionRevealed = (payload: ManhuntMissionRevealPayload) => {
    const parsed = manhuntMissionRevealSchema.safeParse(payload);
    if (!parsed.success) {
      return;
    }
    const game = useManhuntGameStore.getState();
    const isRecipientTeam =
      (parsed.data.outcome === "success" && game.ownTeam === "runner") ||
      (parsed.data.outcome === "failure" && game.ownTeam === "hunter");
    const visibleUntil = Date.parse(parsed.data.visibleUntil);
    const remainingMs = getServerDeadlineRemainingMs(
      parsed.data.visibleUntil,
      game.serverTimeOffsetMs,
    );
    if (
      !game.session ||
      game.session.id !== parsed.data.sessionId ||
      game.session.roomCode !== useRoomStore.getState().room?.code ||
      !isRecipientTeam ||
      !Number.isFinite(visibleUntil) ||
      remainingMs === null
    ) {
      return;
    }
    if (remainingMs <= 0) {
      if (isSameReveal(game.missionReveal, parsed.data)) {
        clearRevealTimer();
        game.clearMissionReveal();
      }
      return;
    }
    game.setMissionReveal(parsed.data);
  };

  socket.on(MANHUNT_EVENTS.MISSION_ASSIGNMENT, missionAssigned);
  socket.on(MANHUNT_EVENTS.MISSION_REVEAL, missionRevealed);

  return {
    clearRevealTimer,
    dispose: () => {
      socket.off(MANHUNT_EVENTS.MISSION_ASSIGNMENT, missionAssigned);
      socket.off(MANHUNT_EVENTS.MISSION_REVEAL, missionRevealed);
      unsubscribeStore();
      clearRevealTimer();
    },
  };
}
