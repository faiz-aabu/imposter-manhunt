import { useEffect, useRef } from "react";
import { useRouter, useSegments } from "expo-router";
import {
  CONNECTION_EVENTS,
  ERROR_EVENTS,
  GAME_EVENTS,
  IMPOSTOR_EVENTS,
  ROOM_EVENTS,
  WORD_IMPOSTOR_EVENTS,
  MANHUNT_EVENTS,
} from "@impostor/api";
import type {
  DiscussionPayload,
  GameEndedPayload,
  GameSession,
  GameStartedPayload,
  GameStateUpdatePayload,
  ImpostorGameState,
  ImpostorRevealPayload,
  ImpostorRoleAssignmentPayload,
  PlayerJoinedPayload,
  PlayerLeftPayload,
  RoomUpdatePayload,
  ServerErrorPayload,
  VoteResultsPayload,
  ValidationErrorPayload,
  WordImpostorDiscussionPayload,
  WordImpostorRevealPayload,
  WordImpostorRoleAssignmentPayload,
  WordImpostorVoteResultsPayload,
  LocationFlashPayload,
  PlayerCaughtPayload,
  CountdownPayload,
  ManhuntCountdownCancelledPayload,
} from "@impostor/api";
import { getReconnectSession } from "../services/player-session";
import {
  requestServerClock,
  ServerClockSynchronizer,
} from "../services/server-clock-sync";
import { getPublicRoom } from "../services/room-rest";
import { isNonHostImpostorRematchUpdate } from "../services/impostor-rematch";
import { emitWithAcknowledgement } from "../services/socket-requests";
import { getSocketClient } from "../services/socket-client";
import { useClassicGameStore } from "../store/classic-game-store";
import { useWordGameStore } from "../store/word-game-store";
import { useRoomStore } from "../store/room-store";
import { useManhuntGameStore } from "../store/manhunt-game-store";
import { useConnectionStore } from "../store/connection-store";
import { resetImpostorGameStores } from "../store/reset-impostor-game-stores";
import {
  registerGameReconnectListener,
  registerManhuntGameEventListeners,
} from "./manhunt-game-event-listeners";
import { getManhuntRoleRoute } from "../utils/manhunt-role-countdown";
import { subscribeToManhuntMissionEvents } from "../services/manhunt-mission-events";

type ImpostorGameSession = Extract<
  GameSession,
  { state: ImpostorGameState }
>;

const ROUTE_BY_PHASE = {
  role_reveal: "/imposter/role",
  discussion: "/imposter/discussion",
  voting: "/imposter/vote",
  reveal: "/imposter/reveal",
} as const;
const CLOCK_SYNC_ERROR =
  "Could not synchronize the server clock. Countdown timing is unavailable.";

export function useClassicGameEvents(): void {
  const router = useRouter();
  const segments = useSegments();
  const currentRoute = segments.join("/");
  const routeRef = useRef(currentRoute);
  routeRef.current = currentRoute;

  useEffect(() => {
    let socket: ReturnType<typeof getSocketClient>;
    try {
      socket = getSocketClient();
    } catch (error) {
      useClassicGameStore
        .getState()
        .setError(
          error instanceof Error
            ? error.message
            : "Could not initialize the game connection.",
        );
      return;
    }

    let disconnected = false;
    let isRestoringMembership = false;
    let countdownSyncInFlight = false;
    let countdownSyncTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingCountdownSync: CountdownPayload | null = null;
    let huntStartedTimer: ReturnType<typeof setTimeout> | undefined;
    const clockSynchronizer = new ServerClockSynchronizer(
      (offsetMs) => {
        useClassicGameStore.getState().setServerTimeOffset(offsetMs);
        useWordGameStore.getState().setServerTimeOffset(offsetMs);
        if (
          offsetMs !== null &&
          useConnectionStore.getState().latestConnectionError ===
            CLOCK_SYNC_ERROR
        ) {
          useConnectionStore.getState().setLatestConnectionError(null);
        }
      },
      () => {
        const connection = useConnectionStore.getState();
        if (!connection.latestConnectionError) {
          connection.setLatestConnectionError(CLOCK_SYNC_ERROR);
        }
      },
      (status) => {
        useConnectionStore.getState().setServerClockStatus(status);
      },
    );
    const synchronizeServerClock = () => {
      if (socket.connected) {
        void clockSynchronizer.synchronize((requestId, signal) =>
          requestServerClock(socket, requestId, signal),
        );
      }
    };

    const announceHuntStarted = () => {
      if (huntStartedTimer) {
        clearTimeout(huntStartedTimer);
      }
      useManhuntGameStore.getState().setHuntStartedAnnouncement(true);
      huntStartedTimer = setTimeout(() => {
        useManhuntGameStore.getState().setHuntStartedAnnouncement(false);
        huntStartedTimer = undefined;
      }, 5_000);
    };

    const navigateToState = (
      session: ImpostorGameSession,
      phase: keyof typeof ROUTE_BY_PHASE,
    ) => {
      const room = useRoomStore.getState().room;
      if (room && room.code !== session.roomCode) {
        return;
      }

      const target = ROUTE_BY_PHASE[phase];
      const targetRoute = target.slice(1);
      if (
        phase === "discussion" &&
        routeRef.current === "imposter/role"
      ) {
        return;
      }
      if (routeRef.current === targetRoute) {
        return;
      }
      routeRef.current = targetRoute;
      router.replace(target);
    };

    const synchronizeCountdown = (payload: CountdownPayload) => {
      if (countdownSyncInFlight) {
        pendingCountdownSync = payload;
        return;
      }
      const current = useManhuntGameStore.getState();
      if (
        !current.session ||
        current.session.id !== payload.sessionId ||
        current.session.roomCode !== payload.roomCode ||
        current.gameState?.phase !== "countdown"
      ) {
        return;
      }
      countdownSyncInFlight = true;
      const requestStartedAt = Date.now();
      void emitWithAcknowledgement({
        event: MANHUNT_EVENTS.COUNTDOWN_SYNC,
        payload: {
          roomCode: payload.roomCode,
          sessionId: payload.sessionId,
        },
      })
        .then((response) => {
          const responseReceivedAt = Date.now();
          if (!response.ok) {
            throw new Error(response.error.message);
          }
          if (
            response.data.roomCode !== payload.roomCode ||
            response.data.sessionId !== payload.sessionId ||
            response.data.endsAt !== payload.endsAt ||
            response.data.runnerHeadStartEndsAt !==
              payload.runnerHeadStartEndsAt
          ) {
            return;
          }
          useManhuntGameStore.getState().setCountdown(
            { ...payload, serverNow: response.data.serverNow },
            (requestStartedAt + responseReceivedAt) / 2,
          );
        })
        .catch(() => {
          const current = useManhuntGameStore.getState();
          if (
            !current.session ||
            current.session.id !== payload.sessionId ||
            current.session.roomCode !== payload.roomCode ||
            current.gameState?.phase !== "countdown" ||
            countdownSyncTimer
          ) {
            return;
          }
          countdownSyncTimer = setTimeout(() => {
            countdownSyncTimer = undefined;
            synchronizeCountdown(payload);
          }, 500);
        })
        .finally(() => {
          countdownSyncInFlight = false;
          const pending = pendingCountdownSync;
          pendingCountdownSync = null;
          if (pending) {
            synchronizeCountdown(pending);
          }
        });
    };

    let missionEvents:
      | ReturnType<typeof subscribeToManhuntMissionEvents>
      | undefined;
    const syncMissionSubscription = () => {
      const current = useManhuntGameStore.getState();
      if (
        current.session &&
        current.gameState?.phase !== "finished" &&
        !current.result
      ) {
        missionEvents ??= subscribeToManhuntMissionEvents(socket);
      } else {
        missionEvents?.dispose();
        missionEvents = undefined;
      }
    };
    syncMissionSubscription();
    const unsubscribeMissionStore =
      useManhuntGameStore.subscribe(syncMissionSubscription);

    const unsubscribeManhuntEvents = registerManhuntGameEventListeners(
      socket,
      {
        router,
        getRoom: () => useRoomStore.getState().room,
        getPlayerId: () => useRoomStore.getState().playerId,
        synchronizeCountdown,
        announceHuntStarted,
        onSessionStarted: () => {
          if (huntStartedTimer) {
            clearTimeout(huntStartedTimer);
            huntStartedTimer = undefined;
          }
        },
        onCountdownEnded: () => {
          if (countdownSyncTimer) {
            clearTimeout(countdownSyncTimer);
            countdownSyncTimer = undefined;
          }
          pendingCountdownSync = null;
        },
      },
    );

    const navigateForSession = (session: ImpostorGameSession) => {
      navigateToState(session, session.state.phase);
    };

    const gameStarted = ({ session }: GameStartedPayload) => {
      if (!isImpostorGameSession(session)) {
        return;
      }
      const room = useRoomStore.getState().room;
      if (room && room.code !== session.roomCode) {
        return;
      }

      const players = room?.code === session.roomCode ? room.players : [];
      if (session.gameMode === "impostor-word") {
        useClassicGameStore.getState().reset();
        useWordGameStore
          .getState()
          .setSession({ ...session, gameMode: "impostor-word" }, players);
      } else {
        useWordGameStore.getState().reset();
        useClassicGameStore
          .getState()
          .setSession({ ...session, gameMode: "impostor-classic" }, players);
      }
      navigateForSession(session);
    };

    const gameStateUpdated = (payload: GameStateUpdatePayload) => {
      const wordGame = useWordGameStore.getState();
      if (
        wordGame.session?.id === payload.sessionId &&
        wordGame.session.roomCode === payload.roomCode &&
        "roundNumber" in payload.state
      ) {
        wordGame.setGameState(payload);
        navigateToState(wordGame.session, payload.state.phase);
        return;
      }

      const current = useClassicGameStore.getState();
      if (
        !current.session ||
        current.session.id !== payload.sessionId ||
        current.session.roomCode !== payload.roomCode ||
        !("roundNumber" in payload.state)
      ) {
        return;
      }
      current.setGameState(payload);
      navigateToState(current.session, payload.state.phase);
    };

    const roleAssigned = (payload: ImpostorRoleAssignmentPayload) => {
      useClassicGameStore.getState().setRole(payload);
    };
    const discussionStarted = (payload: DiscussionPayload) => {
      useClassicGameStore.getState().setDiscussion(payload);
    };
    const voteResults = (payload: VoteResultsPayload) => {
      useClassicGameStore.getState().setVoteResults(payload);
    };
    const gameEnded = (payload: GameEndedPayload) => {
      if (payload.result.gameMode === "manhunt") {
        if (huntStartedTimer) {
          clearTimeout(huntStartedTimer);
          huntStartedTimer = undefined;
        }
        missionEvents?.dispose();
        missionEvents = undefined;
        useManhuntGameStore.getState().setResult(payload);
        router.replace("/manhunt/results");
        return;
      }
      if (payload.result.gameMode === "impostor-word") {
        useWordGameStore.getState().setResult(payload);
      } else {
        useClassicGameStore.getState().setResult(payload);
      }
    };
    const rolesRevealed = (payload: ImpostorRevealPayload) => {
      useClassicGameStore.getState().setReveal(payload);
    };
    const wordRoleAssigned = (
      payload: WordImpostorRoleAssignmentPayload,
    ) => {
      useWordGameStore.getState().setRole(payload);
    };
    const wordDiscussionStarted = (
      payload: WordImpostorDiscussionPayload,
    ) => {
      useWordGameStore.getState().setDiscussion(payload);
    };
    const wordVoteResults = (payload: WordImpostorVoteResultsPayload) => {
      useWordGameStore.getState().setVoteResults(payload);
    };
    const wordRolesRevealed = (payload: WordImpostorRevealPayload) => {
      useWordGameStore.getState().setReveal(payload);
    };
    let revealTimer: ReturnType<typeof setTimeout> | undefined;
    const manhuntLocationFlashed = (payload: LocationFlashPayload) => {
      if (revealTimer) {
        clearTimeout(revealTimer);
      }
      if (countdownSyncTimer) {
        clearTimeout(countdownSyncTimer);
      }
      pendingCountdownSync = null;
      useManhuntGameStore.getState().setReveal(payload);
      const remainingMs = Math.max(
        0,
        Date.parse(payload.visibleUntil) - Date.now(),
      );
      revealTimer = setTimeout(() => {
        useManhuntGameStore.getState().clearReveal();
        revealTimer = undefined;
      }, remainingMs);
    };
    const manhuntPlayerCaught = (payload: PlayerCaughtPayload) => {
      useManhuntGameStore.getState().setCaught(payload);
    };
    const manhuntCountdownCancelled = (
      payload: ManhuntCountdownCancelledPayload,
    ) => {
      const game = useManhuntGameStore.getState();
      if (
        !game.session ||
        game.session.roomCode !== payload.roomCode ||
        game.session.id !== payload.sessionId
      ) {
        return;
      }
      if (countdownSyncTimer) {
        clearTimeout(countdownSyncTimer);
        countdownSyncTimer = undefined;
      }
      if (huntStartedTimer) {
        clearTimeout(huntStartedTimer);
        huntStartedTimer = undefined;
      }
      pendingCountdownSync = null;
      game.reset();
      if (useRoomStore.getState().room?.code === payload.roomCode) {
        router.replace("/manhunt/setup");
      }
    };
    const roomUpdated = (payload: RoomUpdatePayload) => {
      const currentRoom = useRoomStore.getState().room;
      if (currentRoom && currentRoom.code !== payload.room.code) {
        return;
      }
      const classicSession = useClassicGameStore.getState().session;
      const wordSession = useWordGameStore.getState().session;
      const returningNonHost = isNonHostImpostorRematchUpdate(
        currentRoom,
        payload.room,
        useRoomStore.getState().playerId,
        classicSession?.roomCode === payload.room.code ||
          wordSession?.roomCode === payload.room.code,
      );
      useRoomStore.getState().setRoom(payload.room);
      if (returningNonHost) {
        resetImpostorGameStores();
        useRoomStore
          .getState()
          .setNotice("The host returned this room to the lobby.");
        router.replace("/lobby");
        return;
      }

      const game = useClassicGameStore.getState();
      if (
        game.session?.roomCode === payload.room.code &&
        game.playersAtStart.length === 0
      ) {
        game.setPlayersAtStart(payload.room.players);
      }
      const wordGame = useWordGameStore.getState();
      if (
        wordGame.session?.roomCode === payload.room.code &&
        wordGame.playersAtStart.length === 0
      ) {
        wordGame.setPlayersAtStart(payload.room.players);
      }
      if (
        useManhuntGameStore.getState().session?.roomCode === payload.room.code
      ) {
        useManhuntGameStore
          .getState()
          .setPlayersAtStart(payload.room.players);
      }
    };
    const playerJoined = (payload: PlayerJoinedPayload) => {
      const room = useRoomStore.getState().room;
      if (room?.code === payload.roomCode) {
        useRoomStore
          .getState()
          .setActivity(`${payload.player.nickname} joined the room.`);
      }
    };
    const playerLeft = (payload: PlayerLeftPayload) => {
      const room = useRoomStore.getState().room;
      if (room?.code !== payload.roomCode) {
        return;
      }
      const playerName =
        room.players.find((player) => player.id === payload.playerId)?.nickname ??
        "A player";
      useRoomStore.getState().setActivity(`${playerName} left the room.`);
    };
    const serverError = (payload: ServerErrorPayload) => {
      setCurrentGameError(payload.message);
    };
    const validationError = (payload: ValidationErrorPayload) => {
      setCurrentGameError(payload.message);
    };
    const onDisconnect = () => {
      disconnected = true;
      clockSynchronizer.invalidate();
      useManhuntGameStore.getState().clearReveal();
      if (revealTimer) {
        clearTimeout(revealTimer);
        revealTimer = undefined;
      }
      if (huntStartedTimer) {
        clearTimeout(huntStartedTimer);
        huntStartedTimer = undefined;
      }
      useManhuntGameStore.getState().setHuntStartedAnnouncement(false);
    };
    async function restoreMembership(roomCode: string): Promise<void> {
      if (isRestoringMembership) {
        return;
      }
      isRestoringMembership = true;
      try {
        const reconnectSession = await getReconnectSession();
        if (!reconnectSession || reconnectSession.roomCode !== roomCode) {
          throw new Error("The saved room session is no longer available.");
        }
        const playerId = useRoomStore.getState().playerId;
        if (playerId && reconnectSession.playerId !== playerId) {
          throw new Error("The saved player session does not match this room.");
        }

        const response = await emitWithAcknowledgement({
          event: CONNECTION_EVENTS.RECONNECT,
          payload: reconnectSession,
        });
        if (!response.ok) {
          throw new Error(response.error.message);
        }

        const room = await getPublicRoom(roomCode);
        useRoomStore.getState().setSession(room, reconnectSession.playerId);
        const session = getCurrentGameSession();
        const manhunt = useManhuntGameStore.getState();
        if (
          manhunt.session &&
          manhunt.session.roomCode === roomCode &&
          [
            "index",
            "join",
            "lobby",
            "games",
            "manhunt/setup",
            "manhunt/mode",
            "manhunt/countdown",
            "manhunt/map",
            "manhunt/results",
          ].includes(currentRoute)
        ) {
          if (
            room.gameStatus === "waiting" &&
            room.currentGameId !== manhunt.session.id
          ) {
            manhunt.reset();
            router.replace("/manhunt/setup");
          } else if (manhunt.gameState?.phase === "finished") {
            router.replace("/manhunt/results");
          } else if (
            manhunt.gameState?.phase === "countdown" &&
            manhunt.ownTeam
          ) {
            router.replace(getManhuntRoleRoute(manhunt.ownTeam));
          } else if (manhunt.gameState?.phase === "active") {
            router.replace("/manhunt/map");
          }
          return;
        }
        if (session?.roomCode === roomCode) {
          useClassicGameStore
            .getState()
            .setPlayersAtStart(room.players);
          useWordGameStore.getState().setPlayersAtStart(room.players);
          navigateForSession(session);
        }
      } catch (error) {
        useClassicGameStore.getState().setError(
          error instanceof Error
            ? error.message
            : "Could not restore the game connection.",
        );
      } finally {
        isRestoringMembership = false;
      }
    }

    const unsubscribeReconnectListener = registerGameReconnectListener(
      socket,
      {
        getManhuntRoomCode: () =>
          useManhuntGameStore.getState().session?.roomCode ?? null,
        getOtherGameRoomCode: () =>
          getCurrentGameSession()?.roomCode ?? null,
        isDisconnected: () => disconnected,
        markConnected: () => {
          disconnected = false;
        },
        currentRoute: () => routeRef.current,
        restoreMembership,
      },
    );

    const unsubscribeRoom = useRoomStore.subscribe((state) => {
      const session = getCurrentGameSession();
      const room = state.room;
      if (session && room?.code === session.roomCode) {
        useClassicGameStore
          .getState()
          .setPlayersAtStart(room.players);
        useWordGameStore.getState().setPlayersAtStart(room.players);
        navigateForSession(session);
      }
    });

    socket.on(GAME_EVENTS.GAME_STARTED, gameStarted);
    socket.on(GAME_EVENTS.STATE_UPDATE, gameStateUpdated);
    socket.on(IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, roleAssigned);
    socket.on(IMPOSTOR_EVENTS.DISCUSSION, discussionStarted);
    socket.on(IMPOSTOR_EVENTS.VOTE_RESULTS, voteResults);
    socket.on(GAME_EVENTS.GAME_ENDED, gameEnded);
    socket.on(IMPOSTOR_EVENTS.REVEAL, rolesRevealed);
    socket.on(WORD_IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, wordRoleAssigned);
    socket.on(WORD_IMPOSTOR_EVENTS.DISCUSSION, wordDiscussionStarted);
    socket.on(WORD_IMPOSTOR_EVENTS.VOTE_RESULTS, wordVoteResults);
    socket.on(WORD_IMPOSTOR_EVENTS.REVEAL, wordRolesRevealed);
    socket.on(
      MANHUNT_EVENTS.COUNTDOWN_CANCELLED,
      manhuntCountdownCancelled,
    );
    socket.on(MANHUNT_EVENTS.LOCATION_FLASH, manhuntLocationFlashed);
    socket.on(MANHUNT_EVENTS.PLAYER_CAUGHT, manhuntPlayerCaught);
    socket.on(ROOM_EVENTS.UPDATE, roomUpdated);
    socket.on(ROOM_EVENTS.PLAYER_JOINED, playerJoined);
    socket.on(ROOM_EVENTS.PLAYER_LEFT, playerLeft);
    socket.on(ERROR_EVENTS.SERVER_ERROR, serverError);
    socket.on(ERROR_EVENTS.VALIDATION_ERROR, validationError);
    socket.on(CONNECTION_EVENTS.DISCONNECT, onDisconnect);
    socket.on("connect", synchronizeServerClock);
    if (socket.connected) {
      synchronizeServerClock();
    }

    return () => {
      unsubscribeRoom();
      unsubscribeManhuntEvents();
      unsubscribeMissionStore();
      missionEvents?.dispose();
      unsubscribeReconnectListener();
      socket.off(GAME_EVENTS.GAME_STARTED, gameStarted);
      socket.off(GAME_EVENTS.STATE_UPDATE, gameStateUpdated);
      socket.off(IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, roleAssigned);
      socket.off(IMPOSTOR_EVENTS.DISCUSSION, discussionStarted);
      socket.off(IMPOSTOR_EVENTS.VOTE_RESULTS, voteResults);
      socket.off(GAME_EVENTS.GAME_ENDED, gameEnded);
      socket.off(IMPOSTOR_EVENTS.REVEAL, rolesRevealed);
      socket.off(WORD_IMPOSTOR_EVENTS.ROLE_ASSIGNMENT, wordRoleAssigned);
      socket.off(WORD_IMPOSTOR_EVENTS.DISCUSSION, wordDiscussionStarted);
      socket.off(WORD_IMPOSTOR_EVENTS.VOTE_RESULTS, wordVoteResults);
      socket.off(WORD_IMPOSTOR_EVENTS.REVEAL, wordRolesRevealed);
      socket.off(
        MANHUNT_EVENTS.COUNTDOWN_CANCELLED,
        manhuntCountdownCancelled,
      );
      socket.off(MANHUNT_EVENTS.LOCATION_FLASH, manhuntLocationFlashed);
      socket.off(MANHUNT_EVENTS.PLAYER_CAUGHT, manhuntPlayerCaught);
      if (revealTimer) {
        clearTimeout(revealTimer);
      }
      if (countdownSyncTimer) {
        clearTimeout(countdownSyncTimer);
      }
      if (huntStartedTimer) {
        clearTimeout(huntStartedTimer);
      }
      socket.off(ROOM_EVENTS.UPDATE, roomUpdated);
      socket.off(ROOM_EVENTS.PLAYER_JOINED, playerJoined);
      socket.off(ROOM_EVENTS.PLAYER_LEFT, playerLeft);
      socket.off(ERROR_EVENTS.SERVER_ERROR, serverError);
      socket.off(ERROR_EVENTS.VALIDATION_ERROR, validationError);
      socket.off(CONNECTION_EVENTS.DISCONNECT, onDisconnect);
      socket.off("connect", synchronizeServerClock);
      clockSynchronizer.invalidate();
    };
  }, [router]);

  useEffect(() => {
    const session = getCurrentGameSession();
    if (
      !session ||
      !["index", "join", "lobby", "games", "imposter/settings"].includes(
        currentRoute,
      )
    ) {
      return;
    }
    router.replace(ROUTE_BY_PHASE[session.state.phase]);
  }, [currentRoute, router]);
}

function isImpostorGameSession(
  session: GameSession,
): session is ImpostorGameSession {
  return session.gameMode === "impostor-classic" ||
    session.gameMode === "impostor-word";
}

function getCurrentGameSession(): ImpostorGameSession | null {
  return (
    useWordGameStore.getState().session ??
    useClassicGameStore.getState().session
  );
}

function setCurrentGameError(message: string): void {
  if (useManhuntGameStore.getState().session) {
    useManhuntGameStore.getState().setError(message);
  } else if (useWordGameStore.getState().session) {
    useWordGameStore.getState().setError(message);
  } else {
    useClassicGameStore.getState().setError(message);
  }
}
