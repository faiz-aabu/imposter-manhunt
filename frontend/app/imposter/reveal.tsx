import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useState } from "react";
import { useRouter } from "expo-router";
import { Crown, ShieldAlert } from "lucide-react-native";
import { ROOM_EVENTS } from "@impostor/api";
import {
  Chip,
  HudPanel,
  PlayerRow,
  PrimaryButton,
  Screen,
  TopHudBar,
} from "../../src/components";
import { useClassicGameStore } from "../../src/store/classic-game-store";
import { useWordGameStore } from "../../src/store/word-game-store";
import { useConnectionStore } from "../../src/store/connection-store";
import { useRoomStore } from "../../src/store/room-store";
import { resetImpostorGameStores } from "../../src/store/reset-impostor-game-stores";
import { returnFinishedImpostorGameToLobby } from "../../src/services/impostor-rematch";
import { emitWithAcknowledgement } from "../../src/services/socket-requests";
import { useTranslation } from "../../src/i18n/use-translation";
import { localizeImpostorError } from "../../src/i18n/impostor-errors";
import type { TranslationKey } from "../../src/i18n/locales";
import { colors, radii, spacing, typography } from "../../src/theme";

const PLAYER_COLORS = [
  colors.violet,
  colors.teal,
  colors.pink,
  colors.gold,
  colors.blue,
  colors.green,
];

export default function ImpostorResultsRoute() {
  const router = useRouter();
  const t = useTranslation();
  const room = useRoomStore((state) => state.room);
  const classicSession = useClassicGameStore((state) => state.session);
  const classicResult = useClassicGameStore((state) => state.result);
  const classicReveal = useClassicGameStore((state) => state.reveal);
  const classicPlayersAtStart = useClassicGameStore(
    (state) => state.playersAtStart,
  );
  const classicError = useClassicGameStore((state) => state.error);
  const wordSession = useWordGameStore((state) => state.session);
  const wordResult = useWordGameStore((state) => state.result);
  const wordReveal = useWordGameStore((state) => state.reveal);
  const wordPlayersAtStart = useWordGameStore((state) => state.playersAtStart);
  const wordError = useWordGameStore((state) => state.error);
  const isWordSession = wordSession !== null;
  const session = wordSession ?? classicSession;
  const result = isWordSession ? wordResult : classicResult;
  const playersAtStart = isWordSession
    ? wordPlayersAtStart
    : classicPlayersAtStart;
  const error = isWordSession ? wordError : classicError;
  const connectionStatus = useConnectionStore((state) => state.status);
  const playerId = useRoomStore((state) => state.playerId);
  const isHost = room?.hostId === playerId;
  const [isReturning, setIsReturning] = useState(false);
  const [rematchError, setRematchError] = useState<string | null>(null);

  if (!session) {
    return (
      <Screen>
        <View style={styles.centered}>
          <Text style={styles.title}>
            {t("impostor.reveal.unavailableTitle")}
          </Text>
          <Text style={styles.mutedText}>
            {t("impostor.reveal.unavailableDescription")}
          </Text>
          <PrimaryButton
            title={t("games.backToLobby")}
            variant="secondary"
            onPress={() => router.replace("/lobby")}
          />
        </View>
      </Screen>
    );
  }

  const players =
    playersAtStart.length > 0 ? playersAtStart : room?.players ?? [];
  const revealIsReady = isWordSession
    ? wordReveal !== null
    : classicReveal !== null;
  const winnerNames =
    result?.winnerPlayerIds
      .map((winnerId) =>
        players.find((player) => player.id === winnerId)?.nickname,
      )
      .filter((name): name is string => name !== undefined) ?? [];
  const returnToLobby = async () => {
    if (
      !room ||
      room.code !== session.roomCode ||
      !isHost ||
      connectionStatus !== "connected" ||
      isReturning
    ) {
      return;
    }

    setIsReturning(true);
    setRematchError(null);
    const returned = await returnFinishedImpostorGameToLobby({
      roomCode: session.roomCode,
      isHost,
      request: (payload) =>
        emitWithAcknowledgement({
          event: ROOM_EVENTS.RETURN_TO_LOBBY,
          payload,
        }),
      onReturned: (updatedRoom) => {
        useRoomStore.getState().setRoom(updatedRoom);
        resetImpostorGameStores();
        router.replace("/lobby");
      },
      onError: setRematchError,
    });
    if (!returned) {
      setIsReturning(false);
    }
  };

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <TopHudBar
        leftLabel={t("common.roomCode")}
        leftValue={session.roomCode}
        rightLabel={t("common.result")}
        rightValue={
          result?.outcome === "win"
            ? t("common.complete")
            : t("common.final")
        }
      />

      <View style={styles.heading}>
        <Chip label={t("impostor.reveal.gameOver")} variant="gold" />
        <Text style={styles.title}>{getResultTitle(result?.outcome, t)}</Text>
        {result?.outcome === "win" && winnerNames.length > 0 ? (
          <View style={styles.winnerLine}>
            <Crown color={colors.gold} size={20} />
            <Text style={styles.winnerNames}>{winnerNames.join(", ")}</Text>
          </View>
        ) : null}
        {result?.outcome === "cancelled" ? (
          <Text style={styles.mutedText}>
            {t("impostor.reveal.cancelledDescription")}
          </Text>
        ) : null}
        {result && result.winnerPlayerIds.length > 0 && winnerNames.length === 0 ? (
          <Text style={styles.mutedText}>
            {t("impostor.reveal.winnerNamesUnavailable")}
          </Text>
        ) : null}
      </View>

      {!result || !revealIsReady ? (
        <HudPanel style={styles.waitingPanel}>
          <ActivityIndicator color={colors.teal} />
          <Text style={styles.mutedText}>
            {!result
            ? t("impostor.reveal.waitingResult")
            : t("impostor.reveal.waitingRoles")}
          </Text>
        </HudPanel>
      ) : (
        <HudPanel style={styles.rolesPanel}>
          <View style={styles.panelHeading}>
            <ShieldAlert color={colors.pink} size={20} />
            <Text style={styles.sectionTitle}>
              {t(
                isWordSession
                  ? "impostor.reveal.wordAndRoles"
                  : "impostor.reveal.roles",
              )}
            </Text>
          </View>
          <Text style={styles.mutedText}>
            {t("impostor.reveal.rolesDescription")}
          </Text>
          {isWordSession && wordReveal ? (
            <View style={styles.wordPanel}>
              <Text style={styles.wordCategory}>
                {formatCategory(wordReveal.category, t)}
              </Text>
              <Text style={styles.secretWord}>{wordReveal.secretWord}</Text>
            </View>
          ) : null}
          <View style={styles.playerList}>
            {players.map((player, index) => {
              const isImpostor = isWordSession
                ? wordReveal?.playerRoles.find(
                    (entry) => entry.playerId === player.id,
                  )?.role === "impostor"
                : classicReveal?.impostorPlayerIds.includes(player.id) ?? false;
              const wordRole = isWordSession
                ? wordReveal?.playerRoles.find(
                    (entry) => entry.playerId === player.id,
                  )?.role
                : undefined;
              return (
                <PlayerRow
                  key={player.id}
                  name={player.nickname}
                  avatarColor={PLAYER_COLORS[index % PLAYER_COLORS.length]}
                  status={
                    isWordSession && !wordRole
                      ? t("impostor.reveal.roleUnavailable")
                      : isImpostor
                        ? t("impostor.role.impostor")
                        : t("impostor.role.civilian")
                  }
                />
              );
            })}
          </View>
        </HudPanel>
      )}

      {connectionStatus !== "connected" ? (
        <Text style={styles.warning}>
          {connectionStatus === "reconnecting"
            ? t("impostor.reveal.reconnecting")
            : t("impostor.reveal.connectionLost")}
        </Text>
      ) : null}
      {error || rematchError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {localizeImpostorError(rematchError ?? error, t)}
        </Text>
      ) : null}

      {isHost ? (
        <PrimaryButton
          title={t("impostor.reveal.returnToLobby")}
          onPress={() => void returnToLobby()}
          disabled={connectionStatus !== "connected"}
          loading={isReturning}
        />
      ) : (
        <Text style={styles.mutedText}>
          {t("impostor.reveal.hostReturns")}
        </Text>
      )}
    </Screen>
  );
}

function formatCategory(
  category: string,
  t: ReturnType<typeof useTranslation>,
): string {
  const categoryKeys: Record<string, TranslationKey> = {
    animals: "impostor.setup.category.animals",
    food: "impostor.setup.category.food",
    places: "impostor.setup.category.places",
    objects: "impostor.setup.category.objects",
  };
  const key = categoryKeys[category];
  return key ? t(key) : category;
}

function getResultTitle(
  outcome: "win" | "draw" | "cancelled" | undefined,
  t: ReturnType<typeof useTranslation>,
): string {
  switch (outcome) {
    case "win":
      return t("impostor.reveal.gameWinner");
    case "draw":
      return t("impostor.reveal.draw");
    case "cancelled":
      return t("impostor.reveal.cancelled");
    default:
      return t("impostor.reveal.finalResults");
  }
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.xxl,
    gap: spacing.xl,
  },
  heading: {
    gap: spacing.md,
  },
  title: {
    ...typography.title,
    color: colors.text,
  },
  winnerLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  winnerNames: {
    ...typography.body,
    color: colors.gold,
    flexShrink: 1,
  },
  mutedText: {
    ...typography.small,
    color: colors.textMuted,
  },
  waitingPanel: {
    alignItems: "center",
    gap: spacing.md,
  },
  rolesPanel: {
    gap: spacing.md,
  },
  wordPanel: {
    alignItems: "center",
    gap: spacing.xs,
    paddingVertical: spacing.md,
    borderRadius: radii.input,
    backgroundColor: colors.panelRaised,
  },
  wordCategory: {
    ...typography.label,
    color: colors.textMuted,
  },
  secretWord: {
    ...typography.headline,
    color: colors.gold,
    textAlign: "center",
  },
  panelHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typography.body,
    color: colors.text,
  },
  playerList: {
    gap: spacing.md,
  },
  warning: {
    ...typography.small,
    color: colors.gold,
  },
  error: {
    ...typography.small,
    color: colors.pink,
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    gap: spacing.xl,
  },
});
