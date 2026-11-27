import { create } from "zustand";
import {
  MANHUNT_FREEZE_DURATION_SECONDS,
  MANHUNT_FREEZE_WARNING_SECONDS,
  MANHUNT_FOOTSTEPS_DURATION_SECONDS,
  MANHUNT_GHOST_DURATION_SECONDS,
  MANHUNT_SMOKE_BOMB_DURATION_SECONDS,
  MANHUNT_FREEZE_DECOY_DURATION_SECONDS,
} from "@impostor/api";
import type {
  GameEndedPayload,
  GameSession,
  GameStateUpdatePayload,
  CatchRequestStatusPayload,
  CountdownPayload,
  LocationFlashPayload,
  ManhuntMissionAssignmentPayload,
  ManhuntMissionRevealPayload,
  ManhuntFreezeWarningPayload,
  PlayerFrozenPayload,
  PlayerFreezeEndedPayload,
  ManhuntFootstepsStatePayload,
  ManhuntGhostStatePayload,
  ManhuntSmokeBombStatePayload,
  ManhuntFreezeDecoyStatePayload,
  ManhuntFreezeDecoyUsageStatePayload,
  ManhuntLateGameClueStatePayload,
  ManhuntLateGameWarningStatePayload,
  ManhuntGameState,
  ManhuntTeam,
  Player,
  PlayerCaughtPayload,
  PlayerId,
} from "@impostor/api";

type ManhuntSession = Extract<GameSession, { state: ManhuntGameState }>;

type ManhuntFreezeState =
  | { phase: "warning"; payload: ManhuntFreezeWarningPayload }
  | { phase: "frozen"; payload: PlayerFrozenPayload };

interface ManhuntGameStateStore {
  session: ManhuntSession | null;
  gameState: ManhuntGameState | null;
  playersAtStart: Player[];
  ownTeam: ManhuntTeam | null;
  ownPlayerId: PlayerId | null;
  reveal: LocationFlashPayload | null;
  missionAssignment: ManhuntMissionAssignmentPayload | null;
  missionReveal: ManhuntMissionRevealPayload | null;
  freezeState: ManhuntFreezeState | null;
  footstepsState: ManhuntFootstepsStatePayload | null;
  smokeBombState: ManhuntSmokeBombStatePayload | null;
  ghostState: ManhuntGhostStatePayload | null;
  freezeDecoyState: ManhuntFreezeDecoyStatePayload | null;
  freezeDecoyUsageState: ManhuntFreezeDecoyUsageStatePayload | null;
  lateGameClueState: ManhuntLateGameClueStatePayload | null;
  lateGameWarningState: ManhuntLateGameWarningStatePayload | null;
  completedFreezeRequestIds: string[];
  caughtPlayerIds: PlayerId[];
  result: GameEndedPayload | null;
  countdown: CountdownPayload | null;
  countdownServerOffsetMs: number | null;
  serverTimeOffsetMs: number;
  huntStartedAnnouncement: boolean;
  catchPending: boolean;
  catchRequestStatus: CatchRequestStatusPayload | null;
  error: string | null;
  setSession: (session: GameSession, players: Player[]) => void;
  setGameState: (payload: GameStateUpdatePayload) => void;
  setPlayersAtStart: (players: Player[]) => void;
  setOwnTeam: (
    sessionId: string,
    playerId: PlayerId,
    team: ManhuntTeam,
  ) => void;
  setReveal: (payload: LocationFlashPayload) => void;
  clearReveal: () => void;
  setMissionAssignment: (
    payload: ManhuntMissionAssignmentPayload,
  ) => void;
  setMissionReveal: (payload: ManhuntMissionRevealPayload) => void;
  clearMissionReveal: () => void;
  setFreezeWarning: (payload: ManhuntFreezeWarningPayload) => void;
  setPlayerFrozen: (payload: PlayerFrozenPayload) => void;
  clearFreeze: (payload?: PlayerFreezeEndedPayload) => void;
  setFootstepsState: (
    payload: ManhuntFootstepsStatePayload,
    receivedAt?: number,
  ) => void;
  clearFootstepsState: () => void;
  setSmokeBombState: (
    payload: ManhuntSmokeBombStatePayload,
    receivedAt?: number,
  ) => void;
  clearSmokeBombState: () => void;
  setGhostState: (
    payload: ManhuntGhostStatePayload,
    receivedAt?: number,
  ) => void;
  clearGhostState: () => void;
  setFreezeDecoyState: (
    payload: ManhuntFreezeDecoyStatePayload,
    receivedAt?: number,
  ) => void;
  clearFreezeDecoyState: () => void;
  setFreezeDecoyUsageState: (
    payload: ManhuntFreezeDecoyUsageStatePayload,
    receivedAt?: number,
  ) => void;
  clearFreezeDecoyUsageState: () => void;
  setLateGameClueState: (
    payload: ManhuntLateGameClueStatePayload,
    receivedAt?: number,
  ) => void;
  clearLateGameClueState: (clueId?: string) => void;
  setLateGameWarningState: (
    payload: ManhuntLateGameWarningStatePayload,
    receivedAt?: number,
  ) => void;
  clearLateGameWarningState: (exposureId?: string) => void;
  setCaught: (payload: PlayerCaughtPayload) => void;
  setResult: (payload: GameEndedPayload) => void;
  setCatchPending: (pending: boolean) => void;
  setCatchRequestStatus: (payload: CatchRequestStatusPayload | null) => void;
  setCountdown: (payload: CountdownPayload, receivedAt?: number) => void;
  setHuntStartedAnnouncement: (visible: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useManhuntGameStore = create<ManhuntGameStateStore>((set, get) => ({
  session: null,
  gameState: null,
  playersAtStart: [],
  ownTeam: null,
  ownPlayerId: null,
  reveal: null,
  missionAssignment: null,
  missionReveal: null,
  freezeState: null,
  footstepsState: null,
  smokeBombState: null,
  ghostState: null,
  freezeDecoyState: null,
  freezeDecoyUsageState: null,
  lateGameClueState: null,
  lateGameWarningState: null,
  completedFreezeRequestIds: [],
  caughtPlayerIds: [],
  result: null,
  countdown: null,
  countdownServerOffsetMs: null,
  serverTimeOffsetMs: 0,
  huntStartedAnnouncement: false,
  catchPending: false,
  catchRequestStatus: null,
  error: null,
  setSession: (session, players) => {
    if (session.gameMode !== "manhunt") {
      return;
    }
    set({
      session,
      gameState: session.state,
      playersAtStart: players,
      ownTeam: null,
      ownPlayerId: null,
      caughtPlayerIds: [],
      result: null,
      countdown: null,
      countdownServerOffsetMs: null,
      serverTimeOffsetMs:
        Date.parse(session.startedAt) - Date.now(),
      huntStartedAnnouncement: false,
      reveal: null,
      missionAssignment: null,
      missionReveal: null,
      freezeState: null,
      footstepsState: null,
      smokeBombState: null,
      completedFreezeRequestIds: [],
      freezeDecoyState: null,
      freezeDecoyUsageState: null,
      lateGameClueState: null,
      lateGameWarningState: null,
      catchPending: false,
      catchRequestStatus: null,
      error: null,
    });
  },
  setGameState: (payload, receivedAt = Date.now()) => {
    const session = get().session;
    if (
      !session ||
      session.id !== payload.sessionId ||
      session.roomCode !== payload.roomCode ||
      !("settings" in payload.state)
    ) {
      return;
    }
    set({
      gameState: payload.state,
      session: { ...session, state: payload.state },
      serverTimeOffsetMs: Date.parse(payload.updatedAt) - receivedAt,
      reveal: payload.state.phase === "active" ? get().reveal : null,
      ...(payload.state.phase === "finished"
        ? {
            huntStartedAnnouncement: false,
            missionAssignment: null,
            missionReveal: null,
          }
        : {}),
      ...(payload.state.phase !== "active" ? { freezeState: null } : {}),
      ...(payload.state.phase !== "active" ? { footstepsState: null } : {}),
      ...(payload.state.phase !== "active" ? { smokeBombState: null } : {}),
      ...(payload.state.phase !== "active" ? { ghostState: null } : {}),
      ...(payload.state.phase !== "active"
        ? { freezeDecoyState: null, freezeDecoyUsageState: null }
        : {}),
      ...(payload.state.phase !== "active"
        ? { lateGameClueState: null, lateGameWarningState: null }
        : {}),
      ...(payload.state.phase !== "countdown"
        ? { countdown: null, countdownServerOffsetMs: null }
        : payload.state.countdownEndsAt !== get().countdown?.endsAt ||
            payload.state.runnerHeadStartEndsAt !==
              get().countdown?.runnerHeadStartEndsAt
          ? { countdown: null, countdownServerOffsetMs: null }
          : {}),
    });
  },
  setPlayersAtStart: (players) => set({ playersAtStart: players }),
  setOwnTeam: (sessionId, playerId, team) => {
    const session = get().session;
    if (!session || session.id !== sessionId) {
      return;
    }
    const current = get();
    set({
      ownTeam: team,
      ownPlayerId: playerId,
      ...(team !== "runner" || current.ownPlayerId !== playerId
        ? { missionAssignment: null }
        : {}),
      ...(team === "runner"
        ? {
            missionReveal:
              current.missionReveal?.outcome === "success"
                ? current.missionReveal
                : null,
          }
        : {
            missionReveal:
              current.missionReveal?.outcome === "failure"
                ? current.missionReveal
                : null,
          }),
      ...(team !== "runner" ? { freezeState: null } : {}),
      ...(team !== "hunter" || current.ownPlayerId !== playerId
        ? { footstepsState: null }
        : {}),
      ...(team !== "runner" || current.ownPlayerId !== playerId
        ? { smokeBombState: null }
        : {}),
      ...(team !== "runner" || current.ownPlayerId !== playerId
        ? { ghostState: null }
        : {}),
      ...(team !== "hunter" ? { lateGameClueState: null } : {}),
      ...(team !== "runner" ? { lateGameWarningState: null } : {}),
    });
  },
  setReveal: (payload) =>
    set({
      reveal: payload,
      caughtPlayerIds: get().caughtPlayerIds,
    }),
  clearReveal: () => set({ reveal: null }),
  setMissionAssignment: (payload) => {
    const current = get();
    if (
      !current.session ||
      current.session.id !== payload.sessionId ||
      current.gameState?.phase !== "active" ||
      current.ownTeam !== "runner" ||
      current.ownPlayerId !== payload.playerId
    ) {
      return;
    }
    const existing = current.missionAssignment;
    if (
      existing?.sessionId === payload.sessionId &&
      existing.playerId === payload.playerId &&
      existing.status !== "active" &&
      existing.status !== payload.status
    ) {
      return;
    }
    set({ missionAssignment: payload });
  },
  setMissionReveal: (payload) => {
    const current = get();
    const isRecipientTeam =
      (payload.outcome === "success" && current.ownTeam === "runner") ||
      (payload.outcome === "failure" && current.ownTeam === "hunter");
    if (
      !current.session ||
      current.session.id !== payload.sessionId ||
      !isRecipientTeam
    ) {
      return;
    }
    set({ missionReveal: payload });
  },
  clearMissionReveal: () => set({ missionReveal: null }),
  setFreezeWarning: (payload) => {
    const current = get();
    const warningStartedAt = Date.parse(payload.warningStartedAt);
    const warningEndsAt = Date.parse(payload.warningEndsAt);
    if (
      !current.session ||
      current.result ||
      current.session.id !== payload.sessionId ||
      current.session.roomCode !== payload.roomCode ||
      current.gameState?.phase !== "active" ||
      current.ownTeam !== "runner" ||
      current.ownPlayerId !== payload.playerId ||
      current.completedFreezeRequestIds.includes(payload.requestId) ||
      !Number.isFinite(warningStartedAt) ||
      warningEndsAt - warningStartedAt !==
        MANHUNT_FREEZE_WARNING_SECONDS * 1_000
    ) {
      return;
    }
    const existing = current.freezeState;
    const existingDeadline =
      existing?.phase === "warning"
        ? Date.parse(existing.payload.warningEndsAt)
        : existing?.phase === "frozen"
          ? Date.parse(existing.payload.frozenUntil)
          : 0;
    if (
      existing &&
      (existing.payload.requestId === payload.requestId ||
        existingDeadline > Date.now() + current.serverTimeOffsetMs)
    ) {
      return;
    }
    set({ freezeState: { phase: "warning", payload } });
  },
  setPlayerFrozen: (payload) => {
    const current = get();
    const frozenAt = Date.parse(payload.frozenAt);
    const frozenUntil = Date.parse(payload.frozenUntil);
    if (
      !current.session ||
      current.result ||
      current.session.id !== payload.sessionId ||
      current.session.roomCode !== payload.roomCode ||
      current.gameState?.phase !== "active" ||
      current.ownTeam !== "runner" ||
      current.ownPlayerId !== payload.playerId ||
      current.completedFreezeRequestIds.includes(payload.requestId) ||
      !Number.isFinite(frozenAt) ||
      frozenUntil - frozenAt !== MANHUNT_FREEZE_DURATION_SECONDS * 1_000
    ) {
      return;
    }
    const existing = current.freezeState;
    if (
      existing?.payload.requestId === payload.requestId &&
      (existing.phase === "frozen" ||
        (existing.phase === "warning" &&
          frozenAt < Date.parse(existing.payload.warningEndsAt)))
    ) {
      return;
    }
    const existingDeadline =
      existing?.phase === "warning"
        ? Date.parse(existing.payload.warningEndsAt)
        : existing?.phase === "frozen"
          ? Date.parse(existing.payload.frozenUntil)
          : 0;
    if (
      existing &&
      existing.payload.requestId !== payload.requestId &&
      existingDeadline > Date.now() + current.serverTimeOffsetMs
    ) {
      return;
    }
    set({ freezeState: { phase: "frozen", payload } });
  },
  clearFreeze: (payload) =>
    set((state) => {
      const requestId =
        payload?.requestId ?? state.freezeState?.payload.requestId;
      if (
        payload &&
        state.freezeState?.payload.requestId !== payload.requestId
      ) {
        return state;
      }
      return {
        freezeState: null,
        ...(requestId &&
        !state.completedFreezeRequestIds.includes(requestId)
          ? {
              completedFreezeRequestIds: [
                ...state.completedFreezeRequestIds,
                requestId,
              ],
            }
          : {}),
      };
    }),
  setFootstepsState: (payload, receivedAt = Date.now()) => {
    const current = get();
    const existing = current.footstepsState;
    if (
      !current.session ||
      current.result ||
      current.session.id !== payload.sessionId ||
      current.session.roomCode !== payload.roomCode ||
      current.gameState?.phase !== "active" ||
      current.ownTeam !== "hunter" ||
      current.ownPlayerId !== payload.playerId ||
      (existing &&
        (Date.parse(payload.serverNow) < Date.parse(existing.serverNow) ||
          payload.remainingUses > existing.remainingUses))
    ) {
      return;
    }
    if (
      payload.guidances.some((guidance) => {
        const previous = existing?.guidances.find(
          (entry) => entry.requestId === guidance.requestId,
        );
        return (
          previous !== undefined &&
          (previous.startedAt !== guidance.startedAt ||
            previous.expiresAt !== guidance.expiresAt ||
            previous.bearingDegrees !== guidance.bearingDegrees)
        );
      }) ||
      payload.guidances.some(
        (guidance) =>
          Date.parse(guidance.expiresAt) - Date.parse(guidance.startedAt) !==
          MANHUNT_FOOTSTEPS_DURATION_SECONDS * 1_000,
      )
    ) {
      return;
    }
    set({
      footstepsState: payload,
      serverTimeOffsetMs: Date.parse(payload.serverNow) - receivedAt,
    });
  },
  clearFootstepsState: () => set({ footstepsState: null }),
  setSmokeBombState: (payload, receivedAt = Date.now()) => {
    const current = get();
    const existing = current.smokeBombState;
    if (
      !current.session ||
      current.result ||
      current.session.id !== payload.sessionId ||
      current.session.roomCode !== payload.roomCode ||
      current.gameState?.phase !== "active" ||
      current.ownTeam !== "runner" ||
      current.ownPlayerId !== payload.playerId ||
      (existing &&
        (Date.parse(payload.serverNow) < Date.parse(existing.serverNow) ||
          payload.remainingUses > existing.remainingUses))
    ) {
      return;
    }
    if (
      payload.activeEffects.some((effect) => {
        const previous = existing?.activeEffects.find(
          (entry) => entry.requestId === effect.requestId,
        );
        return (
          previous !== undefined &&
          (previous.startedAt !== effect.startedAt ||
            previous.expiresAt !== effect.expiresAt)
        );
      }) ||
      payload.activeEffects.some(
        (effect) =>
          Date.parse(effect.expiresAt) - Date.parse(effect.startedAt) !==
          MANHUNT_SMOKE_BOMB_DURATION_SECONDS * 1_000,
      )
    ) {
      return;
    }
    set({
      smokeBombState: payload,
      serverTimeOffsetMs: Date.parse(payload.serverNow) - receivedAt,
    });
  },
  clearSmokeBombState: () => set({ smokeBombState: null }),
  setGhostState: (payload, receivedAt = Date.now()) => {
    const current = get();
    const existing = current.ghostState;
    if (
      !current.session ||
      current.result ||
      current.session.id !== payload.sessionId ||
      current.session.roomCode !== payload.roomCode ||
      current.gameState?.phase !== "active" ||
      current.ownTeam !== "runner" ||
      current.ownPlayerId !== payload.playerId ||
      (existing &&
        (Date.parse(payload.serverNow) < Date.parse(existing.serverNow) ||
          payload.usageLimit !== existing.usageLimit ||
          (existing.remainingUses !== null &&
            payload.remainingUses !== null &&
            payload.remainingUses > existing.remainingUses)))
    ) {
      return;
    }
    if (
      payload.activeEffects.some((effect) => {
        const previous = existing?.activeEffects.find(
          (entry) => entry.requestId === effect.requestId,
        );
        return (
          previous !== undefined &&
          (previous.startedAt !== effect.startedAt ||
            previous.expiresAt !== effect.expiresAt)
        );
      }) ||
      payload.activeEffects.some(
        (effect) =>
          Date.parse(effect.expiresAt) - Date.parse(effect.startedAt) !==
          MANHUNT_GHOST_DURATION_SECONDS * 1_000,
      )
    ) {
      return;
    }
    set({
      ghostState: payload,
      serverTimeOffsetMs: Date.parse(payload.serverNow) - receivedAt,
    });
  },
  clearGhostState: () => set({ ghostState: null }),
  setFreezeDecoyState: (payload, receivedAt = Date.now()) => {
    const current = get();
    const existing = current.freezeDecoyState;
    if (
      !current.session ||
      current.result ||
      current.session.id !== payload.sessionId ||
      current.session.roomCode !== payload.roomCode ||
      current.gameState?.phase !== "active" ||
      current.ownTeam !== "hunter" ||
      (existing &&
        Date.parse(payload.serverNow) < Date.parse(existing.serverNow))
    ) {
      return;
    }
    if (
      payload.decoys.some((decoy) => {
        const previous = existing?.decoys.find(
          (entry) => entry.decoyId === decoy.decoyId,
        );
        return (
          Date.parse(decoy.expiresAt) - Date.parse(decoy.startedAt) !==
            MANHUNT_FREEZE_DECOY_DURATION_SECONDS * 1_000 ||
          (previous !== undefined &&
            (previous.startedAt !== decoy.startedAt ||
              previous.expiresAt !== decoy.expiresAt ||
              previous.coordinates.latitude !== decoy.coordinates.latitude ||
              previous.coordinates.longitude !== decoy.coordinates.longitude))
        );
      })
    ) {
      return;
    }
    set({
      freezeDecoyState: payload,
      serverTimeOffsetMs: Date.parse(payload.serverNow) - receivedAt,
    });
  },
  clearFreezeDecoyState: () => set({ freezeDecoyState: null }),
  setFreezeDecoyUsageState: (payload, receivedAt = Date.now()) => {
    const current = get();
    const existing = current.freezeDecoyUsageState;
    if (
      !current.session ||
      current.result ||
      current.session.id !== payload.sessionId ||
      current.session.roomCode !== payload.roomCode ||
      current.gameState?.phase !== "active" ||
      current.ownTeam !== "runner" ||
      current.ownPlayerId !== payload.playerId ||
      (existing &&
        (Date.parse(payload.serverNow) < Date.parse(existing.serverNow) ||
          payload.remainingUses > existing.remainingUses))
    ) {
      return;
    }
    set({
      freezeDecoyUsageState: payload,
      serverTimeOffsetMs: Date.parse(payload.serverNow) - receivedAt,
    });
  },
  clearFreezeDecoyUsageState: () =>
    set({ freezeDecoyUsageState: null }),
  setLateGameClueState: (payload, receivedAt = Date.now()) => {
    const current = get();
    const existing = current.lateGameClueState;
    if (
      !current.session ||
      current.result ||
      current.session.id !== payload.sessionId ||
      current.session.roomCode !== payload.roomCode ||
      current.gameState?.phase !== "active" ||
      current.ownTeam !== "hunter" ||
      (existing &&
        Date.parse(payload.serverNow) < Date.parse(existing.serverNow))
    ) {
      return;
    }
    if (
      payload.clue &&
      existing?.clue?.clueId === payload.clue.clueId &&
      (existing.clue.recordedAt !== payload.clue.recordedAt ||
        existing.clue.exposedAt !== payload.clue.exposedAt ||
        existing.clue.expiresAt !== payload.clue.expiresAt ||
        existing.clue.coordinates.latitude !==
          payload.clue.coordinates.latitude ||
        existing.clue.coordinates.longitude !==
          payload.clue.coordinates.longitude)
    ) {
      return;
    }
    set({
      lateGameClueState: payload,
      serverTimeOffsetMs: Date.parse(payload.serverNow) - receivedAt,
    });
  },
  clearLateGameClueState: (clueId) =>
    set((state) =>
      !state.lateGameClueState ||
      (clueId &&
        state.lateGameClueState.clue?.clueId !== clueId)
        ? {}
        : {
            lateGameClueState: {
              ...state.lateGameClueState,
              clue: null,
            },
          },
    ),
  setLateGameWarningState: (payload, receivedAt = Date.now()) => {
    const current = get();
    const existing = current.lateGameWarningState;
    if (
      !current.session ||
      current.result ||
      current.session.id !== payload.sessionId ||
      current.session.roomCode !== payload.roomCode ||
      current.gameState?.phase !== "active" ||
      current.ownTeam !== "runner" ||
      current.ownPlayerId !== payload.playerId ||
      (existing &&
        Date.parse(payload.serverNow) < Date.parse(existing.serverNow))
    ) {
      return;
    }
    if (
      payload.warning &&
      existing?.warning?.exposureId === payload.warning.exposureId &&
      (existing.warning.startedAt !== payload.warning.startedAt ||
        existing.warning.expiresAt !== payload.warning.expiresAt)
    ) {
      return;
    }
    set({
      lateGameWarningState: payload,
      serverTimeOffsetMs: Date.parse(payload.serverNow) - receivedAt,
    });
  },
  clearLateGameWarningState: (exposureId) =>
    set((state) =>
      !state.lateGameWarningState ||
      (exposureId &&
        state.lateGameWarningState.warning?.exposureId !== exposureId)
        ? {}
        : {
            lateGameWarningState: {
              ...state.lateGameWarningState,
              warning: null,
            },
          },
    ),
  setCaught: (payload) =>
    set((state) => ({
      catchPending: false,
      freezeState:
        state.ownPlayerId === payload.caughtPlayerId
          ? null
          : state.freezeState,
      smokeBombState:
        state.ownPlayerId === payload.caughtPlayerId
          ? null
          : state.smokeBombState,
      ghostState:
        state.ownPlayerId === payload.caughtPlayerId
          ? null
          : state.ghostState,
      freezeDecoyUsageState:
        state.ownPlayerId === payload.caughtPlayerId
          ? null
          : state.freezeDecoyUsageState,
      lateGameWarningState:
        state.ownPlayerId === payload.caughtPlayerId
          ? null
          : state.lateGameWarningState,
      completedFreezeRequestIds:
        state.ownPlayerId === payload.caughtPlayerId &&
        state.freezeState &&
        !state.completedFreezeRequestIds.includes(
          state.freezeState.payload.requestId,
        )
          ? [
              ...state.completedFreezeRequestIds,
              state.freezeState.payload.requestId,
            ]
          : state.completedFreezeRequestIds,
      caughtPlayerIds: state.caughtPlayerIds.includes(payload.caughtPlayerId)
        ? state.caughtPlayerIds
        : [...state.caughtPlayerIds, payload.caughtPlayerId],
      reveal: state.reveal
        ? {
            ...state.reveal,
            locations: state.reveal.locations.filter(
              (location) => location.playerId !== payload.caughtPlayerId,
            ),
          }
        : null,
    })),
  setResult: (payload) =>
    set({
      result: payload,
      reveal: null,
      missionAssignment: null,
      missionReveal: null,
      freezeState: null,
      footstepsState: null,
      smokeBombState: null,
      ghostState: null,
      freezeDecoyState: null,
      freezeDecoyUsageState: null,
      lateGameClueState: null,
      lateGameWarningState: null,
      completedFreezeRequestIds: [],
      catchPending: false,
    }),
  setCatchPending: (pending) => set({ catchPending: pending }),
  setCatchRequestStatus: (payload) =>
    set({
      catchRequestStatus: payload,
      ...(payload?.status === "pending" ? { catchPending: true } : {}),
      ...(payload && payload.status !== "pending"
        ? { catchPending: false }
        : {}),
    }),
  setCountdown: (payload, receivedAt = Date.now()) => {
    const state = get();
    if (
      !state.session ||
      !state.gameState ||
      state.session.id !== payload.sessionId ||
      state.session.roomCode !== payload.roomCode ||
      state.gameState.phase !== "countdown" ||
      state.gameState.countdownEndsAt !== payload.endsAt ||
      state.gameState.runnerHeadStartEndsAt !==
        payload.runnerHeadStartEndsAt
    ) {
      return;
    }
    set({
      countdown: payload,
      countdownServerOffsetMs: Date.parse(payload.serverNow) - receivedAt,
      serverTimeOffsetMs: Date.parse(payload.serverNow) - receivedAt,
    });
  },
  setHuntStartedAnnouncement: (visible) =>
    set({ huntStartedAnnouncement: visible }),
  setError: (error) => set({ error }),
  reset: () =>
    set({
      session: null,
      gameState: null,
      playersAtStart: [],
      ownTeam: null,
      ownPlayerId: null,
      reveal: null,
      missionAssignment: null,
      missionReveal: null,
      freezeState: null,
      footstepsState: null,
      smokeBombState: null,
      ghostState: null,
      freezeDecoyState: null,
      freezeDecoyUsageState: null,
      lateGameClueState: null,
      lateGameWarningState: null,
      completedFreezeRequestIds: [],
      caughtPlayerIds: [],
      result: null,
      countdown: null,
      countdownServerOffsetMs: null,
      serverTimeOffsetMs: 0,
      huntStartedAnnouncement: false,
      catchPending: false,
      catchRequestStatus: null,
      error: null,
    }),
}));
