import { create } from "zustand";
import type {
  DiscussionPayload,
  GameEndedPayload,
  GameSession,
  GameStateUpdatePayload,
  ImpostorGameState,
  Player,
  PlayerId,
  VoteResultsPayload,
  WordImpostorRevealPayload,
  WordImpostorRoleAssignmentPayload,
} from "@impostor/api";

type WordGameSession = Extract<
  GameSession,
  { state: ImpostorGameState }
> & { gameMode: "impostor-word" };

interface WordGameState {
  session: WordGameSession | null;
  state: ImpostorGameState | null;
  role: WordImpostorRoleAssignmentPayload | null;
  discussion: DiscussionPayload | null;
  voteResults: VoteResultsPayload | null;
  result: GameEndedPayload["result"] | null;
  reveal: WordImpostorRevealPayload | null;
  playersAtStart: Player[];
  serverTimeOffsetMs: number;
  roleLoading: boolean;
  roleRequestSessionId: string | null;
  selectedTargetId: PlayerId | null;
  currentVoteKey: string | null;
  submittedVoteKey: string | null;
  voteSent: boolean;
  error: string | null;
  setSession: (session: WordGameSession, players: Player[]) => void;
  setPlayersAtStart: (players: Player[]) => void;
  setGameState: (payload: GameStateUpdatePayload) => void;
  setRole: (payload: WordImpostorRoleAssignmentPayload) => void;
  setDiscussion: (payload: DiscussionPayload) => void;
  setVoteResults: (payload: VoteResultsPayload) => void;
  setResult: (payload: GameEndedPayload) => void;
  setReveal: (payload: WordImpostorRevealPayload) => void;
  beginRoleRequest: (sessionId: string) => boolean;
  setSelectedTarget: (playerId: PlayerId | null) => void;
  markVoteSent: (voteKey: string, playerId: PlayerId) => boolean;
  setError: (message: string | null) => void;
  clearError: () => void;
  reset: () => void;
}

const initialState = {
  session: null,
  state: null,
  role: null,
  discussion: null,
  voteResults: null,
  result: null,
  reveal: null,
  playersAtStart: [],
  serverTimeOffsetMs: 0,
  roleLoading: false,
  roleRequestSessionId: null,
  selectedTargetId: null,
  currentVoteKey: null,
  submittedVoteKey: null,
  voteSent: false,
  error: null,
} satisfies Omit<
  WordGameState,
  | "setSession"
  | "setPlayersAtStart"
  | "setGameState"
  | "setRole"
  | "setDiscussion"
  | "setVoteResults"
  | "setResult"
  | "setReveal"
  | "beginRoleRequest"
  | "setSelectedTarget"
  | "markVoteSent"
  | "setError"
  | "clearError"
  | "reset"
>;

export const useWordGameStore = create<WordGameState>((set, get) => ({
  ...initialState,
  setSession: (session, players) =>
    set((current) => {
      if (current.session?.id === session.id) {
        return {
          session,
          state: session.state,
          playersAtStart:
            current.playersAtStart.length > 0
              ? current.playersAtStart
              : [...players],
        };
      }

      return {
        ...initialState,
        session,
        state: session.state,
        playersAtStart: [...players],
        serverTimeOffsetMs: Date.parse(session.startedAt) - Date.now(),
      };
    }),
  setPlayersAtStart: (players) =>
    set((current) =>
      current.playersAtStart.length > 0
        ? {}
        : { playersAtStart: [...players] },
    ),
  setGameState: (payload) =>
    set((current) => {
      if (
        !current.session ||
        current.session.id !== payload.sessionId ||
        payload.roomCode !== current.session.roomCode ||
        !("roundNumber" in payload.state)
      ) {
        return {};
      }

      const state = payload.state;
      const roundChanged =
        current.state !== null &&
        current.state.roundNumber !== state.roundNumber;
      const nextVoteKey =
        state.phase === "voting"
          ? makeVoteKey(payload.sessionId, state)
          : null;
      const votePhaseChanged = nextVoteKey !== get().currentVoteKey;

      return {
        state,
        session: {
          ...current.session,
          state,
          status:
            state.phase === "role_reveal"
              ? "starting"
              : state.phase === "reveal"
                ? "finished"
                : "in_progress",
        },
        serverTimeOffsetMs:
          new Date(payload.updatedAt).getTime() - Date.now(),
        ...(roundChanged ? { voteResults: null } : {}),
        ...(votePhaseChanged
          ? {
              currentVoteKey: nextVoteKey,
              selectedTargetId: null,
              submittedVoteKey: null,
              voteSent: false,
            }
          : {}),
      };
    }),
  setRole: (payload) =>
    set((current) =>
      current.session?.id === payload.sessionId
        ? {
            role: payload,
            roleLoading: false,
            roleRequestSessionId: null,
            error: null,
          }
        : {},
    ),
  setDiscussion: (payload) =>
    set((current) =>
      current.session?.id === payload.sessionId
        ? {
            discussion: payload,
            serverTimeOffsetMs: Date.parse(payload.startsAt) - Date.now(),
          }
        : {},
    ),
  setVoteResults: (payload) =>
    set((current) => {
      if (current.session?.id !== payload.sessionId) {
        return {};
      }
      const startsRevote =
        payload.eliminatedPlayerId === null &&
        (payload.tiedPlayerIds?.length ?? 0) > 0;
      return {
        voteResults: payload,
        ...(startsRevote
          ? {
              selectedTargetId: null,
              submittedVoteKey: null,
              voteSent: false,
            }
          : {}),
      };
    }),
  setResult: (payload) =>
    set((current) =>
      current.session?.id === payload.result.gameId &&
      payload.result.gameMode === "impostor-word"
        ? {
            result: payload.result,
            session: {
              ...current.session,
              status: "finished",
              endedAt: payload.result.endedAt,
            },
          }
        : {},
    ),
  setReveal: (payload) =>
    set((current) =>
      current.session?.id === payload.sessionId
        ? { reveal: payload }
        : {},
    ),
  beginRoleRequest: (sessionId) => {
    const current = get();
    if (
      current.session?.id !== sessionId ||
      current.role?.sessionId === sessionId ||
      current.roleRequestSessionId === sessionId
    ) {
      return false;
    }
    set({ roleLoading: true, roleRequestSessionId: sessionId, error: null });
    return true;
  },
  setSelectedTarget: (playerId) =>
    set((current) =>
      current.voteSent ? {} : { selectedTargetId: playerId },
    ),
  markVoteSent: (voteKey, playerId) => {
    const current = get();
    if (
      current.currentVoteKey !== voteKey ||
      current.state?.phase !== "voting" ||
      current.submittedVoteKey === voteKey
    ) {
      return false;
    }
    set({
      selectedTargetId: playerId,
      submittedVoteKey: voteKey,
      voteSent: true,
      error: null,
    });
    return true;
  },
  setError: (message) =>
    set((current) => ({
      error: message,
      ...(message && current.roleLoading
        ? { roleLoading: false, roleRequestSessionId: null }
        : {}),
      ...(message && current.voteSent
        ? {
            voteSent: false,
            submittedVoteKey: null,
            selectedTargetId: null,
          }
        : {}),
    })),
  clearError: () => set({ error: null }),
  reset: () => set(initialState),
}));

export function getCurrentWordVoteKey(
  sessionId: string,
  state: ImpostorGameState,
): string {
  return makeVoteKey(sessionId, state);
}

function makeVoteKey(sessionId: string, state: ImpostorGameState): string {
  const candidates = state.revotePlayerIds
    ? [...state.revotePlayerIds].sort().join(",")
    : "all";
  return `${sessionId}:${state.roundNumber}:${candidates}`;
}
