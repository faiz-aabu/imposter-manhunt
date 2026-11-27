import {
  GAME_EVENTS,
  MANHUNT_EVENTS,
  manhuntFreezeWarningSchema,
  playerFrozenSchema,
  playerFreezeEndedSchema,
  manhuntFootstepsStateSchema,
  manhuntSmokeBombStateSchema,
  manhuntGhostStateSchema,
  manhuntFreezeDecoyStateSchema,
  manhuntFreezeDecoyUsageStateSchema,
  manhuntLateGameClueStateSchema,
  manhuntLateGameWarningStateSchema,
} from "@impostor/api";
import type {
  CountdownPayload,
  GameStartedPayload,
  GameStateUpdatePayload,
  ManhuntBoundaryUpdatePayload,
  ManhuntCountdownCancelledPayload,
  ManhuntFreezeWarningPayload,
  ManhuntTeamAssignmentPayload,
  PlayerFrozenPayload,
  PlayerFreezeEndedPayload,
  ManhuntFootstepsStatePayload,
  ManhuntSmokeBombStatePayload,
  ManhuntGhostStatePayload,
  ManhuntFreezeDecoyStatePayload,
  ManhuntFreezeDecoyUsageStatePayload,
  ManhuntLateGameClueStatePayload,
  ManhuntLateGameWarningStatePayload,
  PlayerId,
  Room,
} from "@impostor/api";
import type { Socket } from "socket.io-client";
import { useClassicGameStore } from "../store/classic-game-store";
import { useManhuntGameStore } from "../store/manhunt-game-store";
import { useRoomStore } from "../store/room-store";
import { useWordGameStore } from "../store/word-game-store";
import {
  clearBoundaryAfterCountdownCancellation,
  clearBoundaryForHunterAssignment,
} from "../utils/manhunt-boundary-state";
import { getManhuntRoleRoute } from "../utils/manhunt-role-countdown";

type ManhuntRoute =
  | "/manhunt/countdown"
  | "/manhunt/map"
  | "/manhunt/results";

interface ManhuntEventDependencies {
  router: { replace: (route: ManhuntRoute) => void };
  getRoom: () => Room | null;
  getPlayerId: () => PlayerId | null;
  synchronizeCountdown: (payload: CountdownPayload) => void;
  announceHuntStarted: () => void;
  onSessionStarted: () => void;
  onCountdownEnded: () => void;
}

interface ReconnectEventDependencies {
  getManhuntRoomCode: () => string | null;
  getOtherGameRoomCode: () => string | null;
  isDisconnected: () => boolean;
  markConnected: () => void;
  currentRoute: () => string;
  restoreMembership: (roomCode: string) => Promise<void>;
}

export function registerGameReconnectListener(
  socket: Pick<Socket, "on" | "off">,
  dependencies: ReconnectEventDependencies,
): () => void {
  const onConnect = () => {
    if (!dependencies.isDisconnected()) {
      return;
    }
    dependencies.markConnected();
    const roomCode =
      dependencies.getManhuntRoomCode() ??
      dependencies.getOtherGameRoomCode();
    if (roomCode && dependencies.currentRoute() !== "lobby") {
      void dependencies.restoreMembership(roomCode);
    }
  };
  socket.on("connect", onConnect);
  return () => socket.off("connect", onConnect);
}

export function registerManhuntGameEventListeners(
  socket: Pick<Socket, "on" | "off">,
  dependencies: ManhuntEventDependencies,
): () => void {
  const gameStarted = ({ session }: GameStartedPayload) => {
    if (session.gameMode !== "manhunt") {
      return;
    }
    const room = dependencies.getRoom();
    if (room && room.code !== session.roomCode) {
      return;
    }
    dependencies.onSessionStarted();
    useClassicGameStore.getState().reset();
    useWordGameStore.getState().reset();
    useManhuntGameStore
      .getState()
      .setSession(session, room?.players ?? []);
    dependencies.router.replace(
      session.state.phase === "active" ? "/manhunt/map" : "/manhunt/countdown",
    );
  };

  const gameStateUpdated = (payload: GameStateUpdatePayload) => {
    const game = useManhuntGameStore.getState();
    if (
      game.session?.id !== payload.sessionId ||
      game.session.roomCode !== payload.roomCode ||
      !("settings" in payload.state)
    ) {
      return;
    }
    const shouldAnnounceHuntStarted =
      game.gameState?.phase === "countdown" &&
      payload.state.phase === "active" &&
      game.ownTeam === "hunter";
    game.setGameState(payload);
    if (payload.state.phase !== "countdown") {
      dependencies.onCountdownEnded();
    }
    if (payload.state.phase === "finished") {
      dependencies.router.replace("/manhunt/results");
    } else if (payload.state.phase === "countdown") {
      dependencies.router.replace(
        game.ownTeam === "runner"
          ? "/manhunt/map"
          : "/manhunt/countdown",
      );
    } else if (payload.state.phase === "active") {
      if (shouldAnnounceHuntStarted) {
        dependencies.announceHuntStarted();
      }
      dependencies.router.replace("/manhunt/map");
    }
  };

  const boundaryUpdated = (payload: ManhuntBoundaryUpdatePayload) => {
    useRoomStore
      .getState()
      .setManhuntBoundary(payload.roomCode, payload.boundary);
  };

  const countdownCancelled = (
    payload: ManhuntCountdownCancelledPayload,
  ) => {
    const room = dependencies.getRoom();
    const game = useManhuntGameStore.getState();
    if (
      room?.code !== payload.roomCode ||
      game.session?.id !== payload.sessionId
    ) {
      return;
    }
    const roomStore = useRoomStore.getState();
    const currentBoundary = {
      roomCode: roomStore.manhuntBoundaryRoomCode,
      boundary: roomStore.manhuntBoundary,
    };
    const clearedBoundary = clearBoundaryAfterCountdownCancellation(
      currentBoundary,
      room.code,
      game.session.id,
      payload,
    );
    if (clearedBoundary !== currentBoundary) {
      roomStore.setManhuntBoundary(
        clearedBoundary.roomCode ?? room.code,
        clearedBoundary.boundary,
      );
    }
  };

  const teamAssigned = (payload: ManhuntTeamAssignmentPayload) => {
    const playerId = dependencies.getPlayerId();
    const room = dependencies.getRoom();
    const game = useManhuntGameStore.getState();
    if (
      !playerId ||
      playerId !== payload.playerId ||
      !room ||
      !game.session ||
      game.session.roomCode !== room.code
    ) {
      return;
    }
    if (payload.team === "hunter") {
      const roomStore = useRoomStore.getState();
      const currentBoundary = {
        roomCode: roomStore.manhuntBoundaryRoomCode,
        boundary: roomStore.manhuntBoundary,
      };
      const clearedBoundary = clearBoundaryForHunterAssignment(
        currentBoundary,
        room.code,
        playerId,
        payload,
      );
      if (clearedBoundary !== currentBoundary) {
        roomStore.setManhuntBoundary(
          clearedBoundary.roomCode ?? room.code,
          clearedBoundary.boundary,
        );
      }
    }
    if (game.session.id !== payload.sessionId) {
      return;
    }
    game.setOwnTeam(payload.sessionId, payload.playerId, payload.team);
    if (game.gameState?.phase === "countdown") {
      dependencies.router.replace(getManhuntRoleRoute(payload.team));
    } else if (
      game.gameState?.phase === "active" &&
      payload.team === "hunter" &&
      !game.huntStartedAnnouncement
    ) {
      dependencies.announceHuntStarted();
    }
  };

  const countdownUpdated = (payload: CountdownPayload) => {
    if (dependencies.getRoom()?.code === payload.roomCode) {
      dependencies.synchronizeCountdown(payload);
    }
  };

  const freezeWarning = (payload: ManhuntFreezeWarningPayload) => {
    const parsed = manhuntFreezeWarningSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.roomCode !== dependencies.getRoom()?.code ||
      parsed.data.playerId !== dependencies.getPlayerId()
    ) {
      return;
    }
    useManhuntGameStore.getState().setFreezeWarning(parsed.data);
  };

  const playerFrozen = (payload: PlayerFrozenPayload) => {
    const parsed = playerFrozenSchema.safeParse(payload);
    if (
      !parsed.success ||
      parsed.data.roomCode !== dependencies.getRoom()?.code ||
      parsed.data.playerId !== dependencies.getPlayerId()
    ) {
      return;
    }
    useManhuntGameStore.getState().setPlayerFrozen(parsed.data);
  };

  const playerFreezeEnded = (payload: PlayerFreezeEndedPayload) => {
    const parsed = playerFreezeEndedSchema.safeParse(payload);
    const game = useManhuntGameStore.getState();
    if (
      !parsed.success ||
      parsed.data.roomCode !== dependencies.getRoom()?.code ||
      parsed.data.playerId !== dependencies.getPlayerId() ||
      game.session?.id !== parsed.data.sessionId ||
      game.ownTeam !== "runner" ||
      game.ownPlayerId !== parsed.data.playerId
    ) {
      return;
    }
    game.clearFreeze(parsed.data);
  };

  const footstepsState = (payload: ManhuntFootstepsStatePayload) => {
    const parsed = manhuntFootstepsStateSchema.safeParse(payload);
    const game = useManhuntGameStore.getState();
    if (
      !parsed.success ||
      parsed.data.roomCode !== dependencies.getRoom()?.code ||
      parsed.data.playerId !== dependencies.getPlayerId() ||
      game.session?.id !== parsed.data.sessionId ||
      game.ownTeam !== "hunter" ||
      game.ownPlayerId !== parsed.data.playerId
    ) {
      return;
    }
    game.setFootstepsState(parsed.data);
  };

  const smokeBombState = (payload: ManhuntSmokeBombStatePayload) => {
    const parsed = manhuntSmokeBombStateSchema.safeParse(payload);
    const game = useManhuntGameStore.getState();
    if (
      !parsed.success ||
      parsed.data.roomCode !== dependencies.getRoom()?.code ||
      parsed.data.playerId !== dependencies.getPlayerId() ||
      game.session?.id !== parsed.data.sessionId ||
      game.ownTeam !== "runner" ||
      game.ownPlayerId !== parsed.data.playerId
    ) {
      return;
    }
    game.setSmokeBombState(parsed.data);
  };

  const ghostState = (payload: ManhuntGhostStatePayload) => {
    const parsed = manhuntGhostStateSchema.safeParse(payload);
    const game = useManhuntGameStore.getState();
    if (
      !parsed.success ||
      parsed.data.roomCode !== dependencies.getRoom()?.code ||
      parsed.data.playerId !== dependencies.getPlayerId() ||
      game.session?.id !== parsed.data.sessionId ||
      game.ownTeam !== "runner" ||
      game.ownPlayerId !== parsed.data.playerId
    ) {
      return;
    }
    game.setGhostState(parsed.data);
  };

  const freezeDecoyState = (payload: ManhuntFreezeDecoyStatePayload) => {
    const parsed = manhuntFreezeDecoyStateSchema.safeParse(payload);
    const game = useManhuntGameStore.getState();
    if (
      !parsed.success ||
      parsed.data.roomCode !== dependencies.getRoom()?.code ||
      game.session?.id !== parsed.data.sessionId ||
      game.ownTeam !== "hunter" ||
      game.ownPlayerId !== dependencies.getPlayerId()
    ) {
      return;
    }
    game.setFreezeDecoyState(parsed.data);
  };

  const freezeDecoyUsageState = (
    payload: ManhuntFreezeDecoyUsageStatePayload,
  ) => {
    const parsed = manhuntFreezeDecoyUsageStateSchema.safeParse(payload);
    const game = useManhuntGameStore.getState();
    if (
      !parsed.success ||
      parsed.data.roomCode !== dependencies.getRoom()?.code ||
      parsed.data.playerId !== dependencies.getPlayerId() ||
      game.session?.id !== parsed.data.sessionId ||
      game.ownTeam !== "runner" ||
      game.ownPlayerId !== parsed.data.playerId
    ) {
      return;
    }
    game.setFreezeDecoyUsageState(parsed.data);
  };

  const lateGameClueState = (payload: ManhuntLateGameClueStatePayload) => {
    const parsed = manhuntLateGameClueStateSchema.safeParse(payload);
    const game = useManhuntGameStore.getState();
    if (
      !parsed.success ||
      parsed.data.roomCode !== dependencies.getRoom()?.code ||
      game.session?.id !== parsed.data.sessionId ||
      game.ownTeam !== "hunter" ||
      game.ownPlayerId !== dependencies.getPlayerId()
    ) {
      return;
    }
    game.setLateGameClueState(parsed.data);
  };

  const lateGameWarningState = (
    payload: ManhuntLateGameWarningStatePayload,
  ) => {
    const parsed = manhuntLateGameWarningStateSchema.safeParse(payload);
    const game = useManhuntGameStore.getState();
    if (
      !parsed.success ||
      parsed.data.roomCode !== dependencies.getRoom()?.code ||
      parsed.data.playerId !== dependencies.getPlayerId() ||
      game.session?.id !== parsed.data.sessionId ||
      game.ownTeam !== "runner" ||
      game.ownPlayerId !== parsed.data.playerId
    ) {
      return;
    }
    game.setLateGameWarningState(parsed.data);
  };

  socket.on(GAME_EVENTS.GAME_STARTED, gameStarted);
  socket.on(GAME_EVENTS.STATE_UPDATE, gameStateUpdated);
  socket.on(MANHUNT_EVENTS.BOUNDARY_UPDATE, boundaryUpdated);
  socket.on(MANHUNT_EVENTS.COUNTDOWN_CANCELLED, countdownCancelled);
  socket.on(MANHUNT_EVENTS.TEAM_ASSIGNMENT, teamAssigned);
  socket.on(MANHUNT_EVENTS.COUNTDOWN, countdownUpdated);
  socket.on(MANHUNT_EVENTS.FREEZE_WARNING, freezeWarning);
  socket.on(MANHUNT_EVENTS.PLAYER_FROZEN, playerFrozen);
  socket.on(MANHUNT_EVENTS.PLAYER_FREEZE_ENDED, playerFreezeEnded);
  socket.on(MANHUNT_EVENTS.FOOTSTEPS_STATE, footstepsState);
  socket.on(MANHUNT_EVENTS.SMOKE_BOMB_STATE, smokeBombState);
  socket.on(MANHUNT_EVENTS.GHOST_STATE, ghostState);
  socket.on(MANHUNT_EVENTS.FREEZE_DECOY_STATE, freezeDecoyState);
  socket.on(
    MANHUNT_EVENTS.FREEZE_DECOY_USAGE_STATE,
    freezeDecoyUsageState,
  );
  socket.on(MANHUNT_EVENTS.LATE_GAME_CLUE_STATE, lateGameClueState);
  socket.on(MANHUNT_EVENTS.LATE_GAME_WARNING_STATE, lateGameWarningState);

  return () => {
    socket.off(GAME_EVENTS.GAME_STARTED, gameStarted);
    socket.off(GAME_EVENTS.STATE_UPDATE, gameStateUpdated);
    socket.off(MANHUNT_EVENTS.BOUNDARY_UPDATE, boundaryUpdated);
    socket.off(MANHUNT_EVENTS.COUNTDOWN_CANCELLED, countdownCancelled);
    socket.off(MANHUNT_EVENTS.TEAM_ASSIGNMENT, teamAssigned);
    socket.off(MANHUNT_EVENTS.COUNTDOWN, countdownUpdated);
    socket.off(MANHUNT_EVENTS.FREEZE_WARNING, freezeWarning);
    socket.off(MANHUNT_EVENTS.PLAYER_FROZEN, playerFrozen);
    socket.off(MANHUNT_EVENTS.PLAYER_FREEZE_ENDED, playerFreezeEnded);
    socket.off(MANHUNT_EVENTS.FOOTSTEPS_STATE, footstepsState);
    socket.off(MANHUNT_EVENTS.SMOKE_BOMB_STATE, smokeBombState);
    socket.off(MANHUNT_EVENTS.GHOST_STATE, ghostState);
    socket.off(MANHUNT_EVENTS.FREEZE_DECOY_STATE, freezeDecoyState);
    socket.off(
      MANHUNT_EVENTS.FREEZE_DECOY_USAGE_STATE,
      freezeDecoyUsageState,
    );
    socket.off(MANHUNT_EVENTS.LATE_GAME_CLUE_STATE, lateGameClueState);
    socket.off(MANHUNT_EVENTS.LATE_GAME_WARNING_STATE, lateGameWarningState);
  };
}
