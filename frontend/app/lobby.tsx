import { useEffect, useRef, useState } from "react";
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
import { useTranslation } from "../src/i18n/use-translation";
import { localizeSharedError } from "../src/i18n/shared-errors";
import { languageOptions, translations } from "../src/i18n/locales";
import type { TranslationKey } from "../src/i18n/locales";
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
  const t = useTranslation();
  const translationRef = useRef(t);
  translationRef.current = t;
  const room = useRoomStore((state) => state.room);
  const roomCode = room?.code;
  const playerId = useRoomStore((state) => state.playerId);
  const notice = useRoomStore((state) => state.notice);
  const activity = useRoomStore((state) => state.activity);
  const localizedActivity = localizeActivity(activity, t);
  const localizedNotice = localizeNotice(notice, t);
  const setSession = useRoomStore((state) => state.setSession);
  const setRoom = useRoomStore((state) => state.setRoom);
  const setActivity = useRoomStore((state) => state.setActivity);
  const setNotice = useRoomStore((state) => state.setNotice);
  const connectionStatus = useConnectionStore((state) => state.status);
  const [isRestoring, setIsRestoring] = useState(!room || !playerId);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [lobbyError, setLobbyError] = useState<string | null>(null);
  const localizedLobbyError = localizeSharedError(lobbyError, t);

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
              ? translationRef.current("lobby.restoreReason", {
                  message:
                    localizeSharedError(
                      error.message,
                      translationRef.current,
                    ) ?? error.message,
                })
              : translationRef.current("lobby.restoreError"),
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
          : translationRef.current("lobby.connectError"),
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
        setActivity(
          translationRef.current("lobby.joinedActivity", {
            name: payload.player.nickname,
          }),
        );
      }
    };
    const playerLeft = (payload: PlayerLeftPayload) => {
      if (payload.roomCode !== roomCode) {
        return;
      }
      const previousRoom = useRoomStore.getState().room;
      const playerName =
        previousRoom?.players.find((player) => player.id === payload.playerId)
          ?.nickname ?? translationRef.current("lobby.playerFallback");
      setActivity(
        translationRef.current("lobby.leftActivity", { name: playerName }),
      );
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
          throw new Error(
            translationRef.current("lobby.sessionUnavailable"),
          );
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
              : translationRef.current("lobby.connectionRestoreError"),
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
          <Text style={styles.statusTitle}>{t("lobby.restoring")}</Text>
        </View>
      </Screen>
    );
  }

  if (restoreError || !room || !playerId) {
    return (
      <Screen>
        <View style={styles.statusScreen}>
          <Text style={styles.statusTitle}>{t("lobby.unavailable")}</Text>
          <Text style={styles.mutedText}>
            {localizeSharedError(restoreError, t) ?? t("lobby.noSession")}
          </Text>
          <PrimaryButton
            title={t("lobby.backHome")}
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
      ? t("lobby.connection.connected")
      : connectionStatus === "reconnecting"
        ? t("lobby.connection.reconnecting")
        : connectionStatus === "connecting"
          ? t("lobby.connection.connecting")
          : t("lobby.connection.lost");

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <TopHudBar
        leftLabel={t("common.roomCode")}
        leftValue={room.code}
        rightLabel={t("common.players")}
        rightValue={`${players.length} / ${room.settings.maxPlayers}`}
        leftValueStyle={typography.roomCode}
        style={styles.topBar}
      />

      <View style={styles.summaryRow}>
        <Chip
          label={t("lobby.playerCount", {
            players: players.length,
            maximum: room.settings.maxPlayers,
          })}
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

      <PrimaryButton
        title={t("lobby.howToPlay")}
        variant="secondary"
        onPress={() =>
          router.push({
            pathname: "/tutorial",
            params: { returnTo: "/lobby" },
          })
        }
      />

      {notice ? (
        <HudPanel style={styles.noticePanel}>
          <Text style={styles.mutedText}>{localizedNotice}</Text>
          <PrimaryButton
            title={t("lobby.dismiss")}
            variant="secondary"
            onPress={() => setNotice(null)}
            style={styles.dismissButton}
          />
        </HudPanel>
      ) : null}

      {localizedActivity ? (
        <Text accessibilityLiveRegion="polite" style={styles.activity}>
          {localizedActivity}
        </Text>
      ) : null}
      {localizedLobbyError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {localizedLobbyError}
        </Text>
      ) : null}

      <HudPanel style={styles.playersPanel}>
        <View style={styles.panelHeading}>
          <Text style={styles.sectionTitle}>{t("lobby.players")}</Text>
          <Chip
            label={t("lobby.playerCount", {
              players: players.length,
              maximum: room.settings.maxPlayers,
            })}
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
                    ? { label: t("lobby.host"), variant: "gold" }
                    : undefined
                }
                status={
                  isPlayerHost
                    ? undefined
                    : playerIsConnected
                      ? t("lobby.ready")
                      : t("lobby.joining")
                }
              />
            );
          })}
        </View>
      </HudPanel>

      <View style={styles.gameSection}>
        <Text style={styles.sectionTitle}>{t("lobby.pickGame")}</Text>
        {isHost ? (
          <>
            <Text style={styles.mutedText}>
              {t("lobby.chooseGameDescription")}
            </Text>
            <PrimaryButton
              title={t("lobby.chooseGame")}
              onPress={() => router.push("/games")}
              style={styles.primaryAction}
            />
          </>
        ) : (
          <HudPanel style={styles.waitingPanel}>
            <Text style={styles.waitingTitle}>{t("lobby.waitingTitle")}</Text>
            <Text style={styles.mutedText}>
              {t("lobby.waitingDescription")}
            </Text>
          </HudPanel>
        )}
      </View>
    </Screen>
  );
}

function localizeActivity(
  activity: string | null,
  t: (key: TranslationKey, values?: Record<string, string | number>) => string,
): string | null {
  if (!activity) {
    return null;
  }

  for (const { code } of languageOptions) {
    for (const key of ["lobby.joinedActivity", "lobby.leftActivity"] as const) {
      const template = translations[code][key];
      const placeholderIndex = template.indexOf("{name}");
      if (placeholderIndex < 0) {
        continue;
      }
      const prefix = template.slice(0, placeholderIndex);
      const suffix = template.slice(placeholderIndex + "{name}".length);
      if (activity.startsWith(prefix) && activity.endsWith(suffix)) {
        const name = activity.slice(
          prefix.length,
          activity.length - suffix.length,
        );
        return t(key, { name });
      }
    }
  }

  return activity;
}

function localizeNotice(
  notice: string | null,
  t: (key: TranslationKey) => string,
): string | null {
  if (!notice) {
    return null;
  }

  for (const { code } of languageOptions) {
    for (const key of [
      "lobby.sessionSaveNotice",
      "lobby.hostReturnedNotice",
    ] as const) {
      if (notice === translations[code][key]) {
        return t(key);
      }
    }
  }

  return notice;
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
