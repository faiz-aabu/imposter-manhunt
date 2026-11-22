import { create } from "zustand";
import type {
  GameEndedPayload,
  GameSession,
  GameStateUpdatePayload,
  CatchRequestStatusPayload,
  CountdownPayload,
  LocationFlashPayload,
  ManhuntGameState,
  ManhuntTeam,
  ManhuntTeamAssignment,
  Player,
  PlayerCaughtPayload,
  PlayerId,
} from "@impostor/api";

type ManhuntSession = Extract<GameSession, { state: ManhuntGameState }>;

interface ManhuntGameStateStore {
  session: ManhuntSession | null;
  gameState: ManhuntGameState | null;
  playersAtStart: Player[];
  assignments: ManhuntTeamAssignment[];
  ownTeam: ManhuntTeam | null;
  reveal: LocationFlashPayload | null;
  caughtPlayerIds: PlayerId[];
  result: GameEndedPayload | null;
  countdown: CountdownPayload | null;
  countdownServerOffsetMs: number | null;
  serverTimeOffsetMs: number;
  catchPending: boolean;
  catchRequestStatus: CatchRequestStatusPayload | null;
  error: string | null;
  setSession: (session: GameSession, players: Player[]) => void;
  setGameState: (payload: GameStateUpdatePayload) => void;
  setPlayersAtStart: (players: Player[]) => void;
  setAssignments: (
    sessionId: string,
    assignments: ManhuntTeamAssignment[],
  ) => void;
  setOwnTeam: (playerId: PlayerId) => void;
  setReveal: (payload: LocationFlashPayload) => void;
  clearReveal: () => void;
  setCaught: (payload: PlayerCaughtPayload) => void;
  setResult: (payload: GameEndedPayload) => void;
  setCatchPending: (pending: boolean) => void;
  setCatchRequestStatus: (payload: CatchRequestStatusPayload | null) => void;
  setCountdown: (payload: CountdownPayload, receivedAt?: number) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useManhuntGameStore = create<ManhuntGameStateStore>((set, get) => ({
  session: null,
  gameState: null,
  playersAtStart: [],
  assignments: [],
  ownTeam: null,
  reveal: null,
  caughtPlayerIds: [],
  result: null,
  countdown: null,
  countdownServerOffsetMs: null,
  serverTimeOffsetMs: 0,
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
      assignments: session.state.teams,
      caughtPlayerIds: [],
      result: null,
      countdown: null,
      countdownServerOffsetMs: null,
      serverTimeOffsetMs:
        Date.parse(session.startedAt) - Date.now(),
      reveal: null,
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
      !("teams" in payload.state)
    ) {
      return;
    }
    set({
      gameState: payload.state,
      session: { ...session, state: payload.state },
      assignments: payload.state.teams,
      serverTimeOffsetMs: Date.parse(payload.updatedAt) - receivedAt,
      reveal: payload.state.phase === "active" ? get().reveal : null,
      ...(payload.state.phase !== "countdown"
        ? { countdown: null, countdownServerOffsetMs: null }
        : payload.state.countdownEndsAt !== get().countdown?.endsAt
          ? { countdown: null, countdownServerOffsetMs: null }
          : {}),
    });
  },
  setPlayersAtStart: (players) => set({ playersAtStart: players }),
  setAssignments: (sessionId, assignments) => {
    const session = get().session;
    if (!session || session.id !== sessionId) {
      return;
    }
    set({
      assignments,
      gameState: { ...session.state, teams: assignments },
      session: {
        ...session,
        state: { ...session.state, teams: assignments },
      },
    });
  },
  setOwnTeam: (playerId) => {
    const assignment = get().assignments.find(
      (entry) => entry.playerId === playerId,
    );
    set({ ownTeam: assignment?.team ?? null });
  },
  setReveal: (payload) =>
    set({
      reveal: payload,
      caughtPlayerIds: get().caughtPlayerIds,
    }),
  clearReveal: () => set({ reveal: null }),
  setCaught: (payload) =>
    set((state) => ({
      catchPending: false,
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
    set({ result: payload, reveal: null, catchPending: false }),
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
      state.gameState.countdownEndsAt !== payload.endsAt
    ) {
      return;
    }
    set({
      countdown: payload,
      countdownServerOffsetMs: Date.parse(payload.serverNow) - receivedAt,
      serverTimeOffsetMs: Date.parse(payload.serverNow) - receivedAt,
    });
  },
  setError: (error) => set({ error }),
  reset: () =>
    set({
      session: null,
      gameState: null,
      playersAtStart: [],
      assignments: [],
      ownTeam: null,
      reveal: null,
      caughtPlayerIds: [],
      result: null,
      countdown: null,
      countdownServerOffsetMs: null,
      serverTimeOffsetMs: 0,
      catchPending: false,
      catchRequestStatus: null,
      error: null,
    }),
}));
