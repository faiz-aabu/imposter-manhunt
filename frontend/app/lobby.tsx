import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import {
  CONNECTION_EVENTS,
  ERROR_EVENTS,
  ROOM_EVENTS,
} from "@impostor/api";
import type {
  PlayerJoinedPayload,
  PlayerLeftPayload,
  Room,
  RoomUpdatePayload,
  ServerErrorPayload,
  ValidationErrorPayload,
} from "@impostor/api";
import {
  Chip,
  HudPanel,
  PlayerRow,
  PrimaryButton,
  Screen,
  TopHudBar,
} from "../src/components";
import { getReconnectSession } from "../src/services/player-session";
import { getPublicRoom } from "../src/services/room-rest";
import { emitWithAcknowledgement } from "../src/services/socket-requests";
import { getSocketClient } from "../src/services/socket-client";
import { useConnectionStore } from "../src/store/connection-store";
import { useRoomStore } from "../src/store/room-store";
import { colors, spacing, typography } from "../src/theme";

const PLAYER_COLORS = [
  colors.violet,
  colors.teal,
  colors.pink,
  colors.gold,
  colors.blue,
  colors.green,
];

export default function LobbyRoute() {
  const router = useRouter();
  const room = useRoomStore((state) => state.room);
  const roomCode = room?.code;
  const playerId = useRoomStore((state) => state.playerId);
  const notice = useRoomStore((state) => state.notice);
  const activity = useRoomStore((state) => state.activity);
  const setSession = useRoomStore((state) => state.setSession);
  const setRoom = useRoomStore((state) => state.setRoom);
  const setActivity = useRoomStore((state) => state.setActivity);
  const setNotice = useRoomStore((state) => state.setNotice);
  const connectionStatus = useConnectionStore((state) => state.status);
  const [isRestoring, setIsRestoring] = useState(!room || !playerId);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);

  useEffect(() => {
    if (room && playerId) {
      setIsRestoring(false);
      return;
    }

    let active = true;
    setIsRestoring(true);
    setRestoreError(null);
    const restoreSession = async () => {
      try {
        const reconnectSession = await getReconnectSession();
        if (!reconnectSession) {
          router.replace("/");
          return;
        }

        const response = await emitWithAcknowledgement({
          event: CONNECTION_EVENTS.RECONNECT,
          payload: reconnectSession,
        });
        if (!response.ok) {
          throw new Error(response.error.message);
        }

        const publicRoom = await getPublicRoom(reconnectSession.roomCode);
        if (active) {
          setSession(publicRoom, reconnectSession.playerId);
        }
      } catch (error) {
        if (active) {
          setRestoreError(
            error instanceof Error
              ? error.message
              : "Could not restore the room session.",
          );
        }
      } finally {
        if (active) {
          setIsRestoring(false);
        }
      }
    };

    void restoreSession();
    return () => {
      active = false;
    };
  }, [playerId, room, router, setSession]);

  useEffect(() => {
    if (!roomCode || !playerId) {
      return;
    }

    let active = true;
    let wasDisconnected = false;
    let socket: ReturnType<typeof getSocketClient>;

    try {
      socket = getSocketClient();
      wasDisconnected = !socket.connected;
    } catch (error) {
      setLobbyError(
        error instanceof Error
          ? error.message
          : "Could not connect to the room server.",
      );
      return;
    }

    const updateRoom = (payload: RoomUpdatePayload) => {
      if (payload.room.code === roomCode) {
        setRoom(payload.room);
        setLobbyError(null);
      }
    };
    const playerJoined = (payload: PlayerJoinedPayload) => {
      if (payload.roomCode === roomCode) {
        setActivity(`${payload.player.nickname} joined the room.`);
      }
    };
    const playerLeft = (payload: PlayerLeftPayload) => {
      if (payload.roomCode !== roomCode) {
        return;
      }
      const previousRoom = useRoomStore.getState().room;
      const playerName =
        previousRoom?.players.find((player) => player.id === payload.playerId)
          ?.nickname ?? "A player";
      setActivity(`${playerName} left the room.`);
    };
    const serverError = (payload: ServerErrorPayload) => {
      setLobbyError(payload.message);
    };
    const validationError = (payload: ValidationErrorPayload) => {
      setLobbyError(payload.message);
    };
    const reconnectMembership = async () => {
      try {
        const reconnectSession = await getReconnectSession();
        if (
          !reconnectSession ||
          reconnectSession.roomCode !== roomCode ||
          reconnectSession.playerId !== playerId
        ) {
          throw new Error("The saved room session is no longer available.");
        }

        const response = await emitWithAcknowledgement({
          event: CONNECTION_EVENTS.RECONNECT,
          payload: reconnectSession,
        });
        if (!response.ok) {
          throw new Error(response.error.message);
        }

        const publicRoom = await getPublicRoom(roomCode);
        if (active) {
          setRoom(publicRoom);
          setLobbyError(null);
        }
      } catch (error) {
        if (active) {
          setLobbyError(
            error instanceof Error
              ? error.message
              : "Could not restore the room connection.",
          );
        }
      }
    };
    const onDisconnect = () => {
      wasDisconnected = true;
    };
    const onConnect = () => {
      if (wasDisconnected) {
        wasDisconnected = false;
        void reconnectMembership();
      }
    };

    socket.on(ROOM_EVENTS.UPDATE, updateRoom);
    socket.on(ROOM_EVENTS.PLAYER_JOINED, playerJoined);
    socket.on(ROOM_EVENTS.PLAYER_LEFT, playerLeft);
    socket.on(ERROR_EVENTS.SERVER_ERROR, serverError);
    socket.on(ERROR_EVENTS.VALIDATION_ERROR, validationError);
    socket.on(CONNECTION_EVENTS.DISCONNECT, onDisconnect);
    socket.on("connect", onConnect);

    return () => {
      active = false;
      socket.off(ROOM_EVENTS.UPDATE, updateRoom);
      socket.off(ROOM_EVENTS.PLAYER_JOINED, playerJoined);
      socket.off(ROOM_EVENTS.PLAYER_LEFT, playerLeft);
      socket.off(ERROR_EVENTS.SERVER_ERROR, serverError);
      socket.off(ERROR_EVENTS.VALIDATION_ERROR, validationError);
      socket.off(CONNECTION_EVENTS.DISCONNECT, onDisconnect);
      socket.off("connect", onConnect);
    };
  }, [playerId, roomCode, setActivity, setLobbyError, setRoom]);

  if (isRestoring) {
    return (
      <Screen>
        <View style={styles.statusScreen}>
          <ActivityIndicator color={colors.teal} />
          <Text style={styles.statusTitle}>Restoring your room...</Text>
        </View>
      </Screen>
    );
  }

  if (restoreError || !room || !playerId) {
    return (
      <Screen>
        <View style={styles.statusScreen}>
          <Text style={styles.statusTitle}>Room unavailable</Text>
          <Text style={styles.mutedText}>
            {restoreError ?? "No active room session was found."}
          </Text>
          <PrimaryButton
            title="Back to home"
            variant="secondary"
            onPress={() => router.replace("/")}
          />
        </View>
      </Screen>
    );
  }

  const isHost = room.hostId === playerId;
  const players = room.players;
  const connectionMessage =
    connectionStatus === "connected"
      ? "Connected to the room"
      : connectionStatus === "reconnecting"
        ? "Reconnecting to the room..."
        : connectionStatus === "connecting"
          ? "Connecting to the room..."
          : "Connection lost. Trying to reconnect...";

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <TopHudBar
        leftLabel="Room code"
        leftValue={room.code}
        rightLabel="Players"
        rightValue={`${players.length} / ${room.settings.maxPlayers}`}
        leftValueStyle={typography.roomCode}
        style={styles.topBar}
      />

      <View style={styles.summaryRow}>
        <Chip
          label={`${players.length} / ${room.settings.maxPlayers} players`}
          variant="muted"
        />
        <Text
          style={[
            styles.connectionText,
            connectionStatus === "connected"
              ? styles.connectedText
              : styles.disconnectedText,
          ]}
        >
          {connectionMessage}
        </Text>
      </View>

      {notice ? (
        <HudPanel style={styles.noticePanel}>
          <Text style={styles.mutedText}>{notice}</Text>
          <PrimaryButton
            title="Dismiss"
            variant="secondary"
            onPress={() => setNotice(null)}
            style={styles.dismissButton}
          />
        </HudPanel>
      ) : null}

      {activity ? (
        <Text accessibilityLiveRegion="polite" style={styles.activity}>
          {activity}
        </Text>
      ) : null}
      {lobbyError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {lobbyError}
        </Text>
      ) : null}

      <HudPanel style={styles.playersPanel}>
        <View style={styles.panelHeading}>
          <Text style={styles.sectionTitle}>Players</Text>
          <Chip
            label={`${players.length} / ${room.settings.maxPlayers}`}
            variant="teal"
          />
        </View>
        <View style={styles.playerList}>
          {players.map((player, index) => {
            const isPlayerHost = player.id === room.hostId;
            const playerIsConnected =
              player.connectionStatus === "connected";
            return (
              <PlayerRow
                key={player.id}
                name={player.nickname}
                avatarColor={PLAYER_COLORS[index % PLAYER_COLORS.length]}
                chip={
                  isPlayerHost
                    ? { label: "Host", variant: "gold" }
                    : undefined
                }
                status={
                  isPlayerHost
                    ? undefined
                    : playerIsConnected
                      ? "Ready"
                      : "Joining"
                }
              />
            );
          })}
        </View>
      </HudPanel>

      <View style={styles.gameSection}>
        <Text style={styles.sectionTitle}>Pick a game</Text>
        {isHost ? (
          <>
            <Text style={styles.mutedText}>
              Choose a game for everyone in the room.
            </Text>
            <PrimaryButton
              title="Choose a game"
              onPress={() => router.push("/games")}
              style={styles.primaryAction}
            />
          </>
        ) : (
          <HudPanel style={styles.waitingPanel}>
            <Text style={styles.waitingTitle}>Waiting for the host</Text>
            <Text style={styles.mutedText}>
              The host will choose which game to play.
            </Text>
          </HudPanel>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.xxl,
    gap: spacing.xl,
  },
  topBar: {
    marginBottom: spacing.xs,
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  connectionText: {
    ...typography.small,
    flex: 1,
    textAlign: "right",
  },
  connectedText: {
    color: colors.green,
  },
  disconnectedText: {
    color: colors.gold,
  },
  noticePanel: {
    gap: spacing.md,
  },
  dismissButton: {
    height: 44,
  },
  activity: {
    ...typography.small,
    color: colors.teal,
  },
  playersPanel: {
    gap: spacing.lg,
  },
  panelHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    ...typography.gameCardTitle,
    color: colors.text,
  },
  playerList: {
    gap: spacing.md,
  },
  gameSection: {
    gap: spacing.md,
  },
  mutedText: {
    ...typography.small,
    color: colors.textMuted,
  },
  primaryAction: {
    marginTop: spacing.xs,
  },
  waitingPanel: {
    gap: spacing.sm,
  },
  waitingTitle: {
    ...typography.body,
    color: colors.text,
  },
  error: {
    ...typography.small,
    color: colors.pink,
  },
  statusScreen: {
    flex: 1,
    justifyContent: "center",
    gap: spacing.xl,
  },
  statusTitle: {
    ...typography.title,
    color: colors.text,
  },
});
