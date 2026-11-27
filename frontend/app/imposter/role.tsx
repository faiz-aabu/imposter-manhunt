import { useCallback, useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { ArrowRight, Eye, EyeOff, ShieldAlert } from "lucide-react-native";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { IMPOSTOR_EVENTS, WORD_IMPOSTOR_EVENTS } from "@impostor/api";
import {
  Chip,
  HudPanel,
  PrimaryButton,
  Screen,
  TopHudBar,
} from "../../src/components";
import { useServerCountdown } from "../../src/hooks/use-server-countdown";
import { getSocketClient } from "../../src/services/socket-client";
import { useClassicGameStore } from "../../src/store/classic-game-store";
import { useWordGameStore } from "../../src/store/word-game-store";
import { useConnectionStore } from "../../src/store/connection-store";
import { useRoomStore } from "../../src/store/room-store";
import { useTranslation } from "../../src/i18n/use-translation";
import { localizeImpostorError } from "../../src/i18n/impostor-errors";
import { colors, radii, spacing, typography } from "../../src/theme";

const ROLE_REQUEST_TIMEOUT_MS = 10_000;

export default function ImpostorRoleRoute() {
  const router = useRouter();
  const t = useTranslation();
  const room = useRoomStore((state) => state.room);
  const playerId = useRoomStore((state) => state.playerId);
  const connectionStatus = useConnectionStore((state) => state.status);
  const classicSession = useClassicGameStore((state) => state.session);
  const classicState = useClassicGameStore((state) => state.state);
  const classicRole = useClassicGameStore((state) => state.role);
  const classicRoleLoading = useClassicGameStore((state) => state.roleLoading);
  const classicError = useClassicGameStore((state) => state.error);
  const classicTimeOffset = useClassicGameStore(
    (state) => state.serverTimeOffsetMs,
  );
  const beginClassicRoleRequest = useClassicGameStore(
    (state) => state.beginRoleRequest,
  );
  const setClassicError = useClassicGameStore((state) => state.setError);
  const clearClassicError = useClassicGameStore((state) => state.clearError);
  const wordSession = useWordGameStore((state) => state.session);
  const wordState = useWordGameStore((state) => state.state);
  const wordRole = useWordGameStore((state) => state.role);
  const wordRoleLoading = useWordGameStore((state) => state.roleLoading);
  const wordError = useWordGameStore((state) => state.error);
  const wordTimeOffset = useWordGameStore(
    (state) => state.serverTimeOffsetMs,
  );
  const beginWordRoleRequest = useWordGameStore(
    (state) => state.beginRoleRequest,
  );
  const setWordError = useWordGameStore((state) => state.setError);
  const clearWordError = useWordGameStore((state) => state.clearError);
  const session = wordSession ?? classicSession;
  const isWordSession = wordSession !== null;
  const gameState = isWordSession ? wordState : classicState;
  const role = isWordSession ? wordRole : classicRole;
  const roleLoading = isWordSession ? wordRoleLoading : classicRoleLoading;
  const error = isWordSession ? wordError : classicError;
  const serverTimeOffsetMs = isWordSession
    ? wordTimeOffset
    : classicTimeOffset;
  const requestStarted = isWordSession
    ? beginWordRoleRequest
    : beginClassicRoleRequest;
  const setError = isWordSession ? setWordError : setClassicError;
  const clearError = isWordSession ? clearWordError : clearClassicError;
  const [isRevealed, setIsRevealed] = useState(false);

  const requestRole = useCallback(() => {
    if (!session || !room || room.code !== session.roomCode) {
      return;
    }
    if (connectionStatus !== "connected") {
      setError("Reconnect to the server before requesting your role.");
      return;
    }
    if (!requestStarted(session.id)) {
      return;
    }
    try {
      if (session.gameMode === "impostor-word") {
        getSocketClient().emit(WORD_IMPOSTOR_EVENTS.ROLE_REQUEST, {
          roomCode: session.roomCode,
          sessionId: session.id,
        });
      } else {
        getSocketClient().emit(IMPOSTOR_EVENTS.ROLE_REQUEST, {
          roomCode: session.roomCode,
          sessionId: session.id,
        });
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not request your role.",
      );
    }
  }, [connectionStatus, requestStarted, room, session, setError]);

  useEffect(() => {
    if (session && !role && connectionStatus === "connected") {
      requestRole();
    }
  }, [connectionStatus, requestRole, role, session]);

  useEffect(() => {
    if (!roleLoading) {
      return;
    }
    const timer = setTimeout(() => {
      const current = isWordSession
        ? useWordGameStore.getState()
        : useClassicGameStore.getState();
      if (current.role?.sessionId !== session?.id) {
        current.setError("The server did not return your role. Try again.");
      }
    }, ROLE_REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isWordSession, roleLoading, session?.id]);

  useEffect(() => {
    setIsRevealed(false);
  }, [session?.id]);

  const countdown = useServerCountdown(
    gameState?.phase === "role_reveal"
      ? gameState.roleRevealEndsAt
      : undefined,
    serverTimeOffsetMs,
  );

  if (!session || !gameState || !room || !playerId) {
    return (
      <Screen>
        <View style={styles.centered}>
          <Text style={styles.title}>{t("impostor.role.waitingTitle")}</Text>
          <Text style={styles.mutedText}>
            {t("impostor.role.waitingDescription")}
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

  if (room.code !== session.roomCode) {
    return (
      <Screen>
        <View style={styles.centered}>
          <Text style={styles.title}>
            {t("impostor.role.sessionMismatchTitle")}
          </Text>
          <Text style={styles.mutedText}>
            {t("impostor.role.sessionMismatchDescription")}
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

  const phaseAllowsContinue =
    gameState.phase !== "role_reveal" && role !== null;
  const roleTitle =
    role?.role === "impostor"
      ? t("impostor.role.impostor")
      : role
        ? t("impostor.role.civilian")
        : null;
  const privateWord =
    isWordSession && role?.role === "civilian" ? role.secretWord : null;
  const canRevealRole =
    Boolean(role) &&
    (isWordSession
      ? gameState.phase !== "reveal"
      : gameState.phase === "role_reveal");

  const continueGame = () => {
    clearError();
    if (gameState.phase === "discussion") {
      router.replace("/imposter/discussion");
    } else if (gameState.phase === "voting") {
      router.replace("/imposter/vote");
    } else if (gameState.phase === "reveal") {
      router.replace("/imposter/reveal");
    }
  };

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <TopHudBar
        leftLabel={t("common.roomCode")}
        leftValue={room.code}
        rightLabel={t("common.round")}
        rightValue={`${gameState.roundNumber}`}
      />

      <View style={styles.heading}>
        <Chip label={t("impostor.role.privateChip")} variant="gold" />
        <Text style={styles.title}>
          {t(
            isWordSession
              ? "impostor.role.wordTitle"
              : "impostor.role.secretTitle",
          )}
        </Text>
        <Text style={styles.mutedText}>
          {t(
            isWordSession
              ? "impostor.role.wordPrivacy"
              : "impostor.role.rolePrivacy",
          )}
        </Text>
      </View>

      <HudPanel
        highlightColor={role?.role === "impostor" ? colors.pink : colors.teal}
        style={styles.rolePanel}
      >
        <View style={styles.roleIcon}>
          <ShieldAlert
            color={role?.role === "impostor" ? colors.pink : colors.teal}
            size={28}
            strokeWidth={2}
          />
        </View>
        {canRevealRole ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              isRevealed
                ? t("impostor.role.revealedAccessibility")
                : t("impostor.role.revealAccessibility")
            }
            onPressIn={() => setIsRevealed(true)}
            onPressOut={() => setIsRevealed(false)}
            style={({ pressed }) => [
              styles.revealCard,
              isRevealed ? styles.revealedCard : null,
              pressed ? styles.pressedCard : null,
            ]}
          >
            {isRevealed ? (
              <>
                <Eye color={colors.text} size={22} />
                <Text
                  style={[
                    styles.roleTitle,
                    role?.role === "impostor"
                      ? styles.impostorRole
                      : styles.civilianRole,
                  ]}
                >
                  {roleTitle}
                </Text>
                {privateWord ? (
                  <Text style={styles.secretWord}>{privateWord}</Text>
                ) : null}
              </>
            ) : (
              <>
                <EyeOff color={colors.textMuted} size={22} />
                <Text style={styles.hiddenRole}>
                  {t("impostor.role.holdToReveal")}
                </Text>
              </>
            )}
          </Pressable>
        ) : roleTitle ? (
          <View style={styles.roleSummary}>
            <Text
              style={[
                styles.roleTitle,
                role?.role === "impostor"
                  ? styles.impostorRole
                  : styles.civilianRole,
              ]}
            >
              {roleTitle}
            </Text>
          </View>
        ) : (
          <View style={styles.loadingRole}>
            <Text style={styles.hiddenRole}>
              {roleLoading
                ? t("impostor.role.requesting")
                : connectionStatus === "reconnecting"
                  ? t("impostor.role.reconnecting")
                  : t("impostor.role.waiting")}
            </Text>
            {error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {localizeImpostorError(error, t)}
              </Text>
            ) : null}
            {connectionStatus === "connected" && !roleLoading ? (
              <PrimaryButton
                title={t("impostor.role.request")}
                variant="secondary"
                onPress={requestRole}
                style={styles.requestButton}
              />
            ) : null}
          </View>
        )}
      </HudPanel>

      {gameState.phase === "role_reveal" ? (
        <HudPanel style={styles.timerPanel}>
          <Text style={styles.timerLabel}>
            {t("impostor.role.revealEnds")}
          </Text>
          <Text style={styles.timer}>{countdown.label}</Text>
          <Text style={styles.mutedText}>
            {t("impostor.role.timerDescription")}
          </Text>
        </HudPanel>
      ) : (
        <HudPanel style={styles.timerPanel}>
          <Text style={styles.timerLabel}>
            {t("impostor.role.serverReady")}
          </Text>
          <Text style={styles.mutedText}>
            {t("impostor.role.serverReadyDescription")}
          </Text>
        </HudPanel>
      )}

      {connectionStatus !== "connected" ? (
        <Text style={styles.warning}>
          {connectionStatus === "reconnecting"
            ? t("impostor.role.reconnectingGame")
            : t("impostor.role.connectionLost")}
        </Text>
      ) : null}
      {error && role ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {localizeImpostorError(error, t)}
        </Text>
      ) : null}

      <PrimaryButton
        title={
          gameState.phase === "role_reveal"
            ? t("impostor.role.waitingForServer")
            : t("impostor.role.continue")
        }
        leftIcon={ArrowRight}
        disabled={!phaseAllowsContinue}
        onPress={continueGame}
      />
    </Screen>
  );
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
  mutedText: {
    ...typography.small,
    color: colors.textMuted,
  },
  rolePanel: {
    minHeight: 224,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xl,
  },
  roleIcon: {
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.avatar,
    backgroundColor: colors.panelRaised,
  },
  revealCard: {
    width: "100%",
    minHeight: 88,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    backgroundColor: colors.panelRaised,
  },
  revealedCard: {
    backgroundColor: colors.panel,
    borderColor: colors.teal,
  },
  pressedCard: {
    opacity: 0.8,
  },
  roleTitle: {
    ...typography.gameCardTitle,
    textTransform: "uppercase",
  },
  impostorRole: {
    color: colors.pink,
  },
  civilianRole: {
    color: colors.teal,
  },
  hiddenRole: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: "center",
  },
  roleSummary: {
    minHeight: 64,
    justifyContent: "center",
  },
  secretWord: {
    ...typography.headline,
    color: colors.gold,
    textAlign: "center",
  },
  loadingRole: {
    width: "100%",
    alignItems: "center",
    gap: spacing.md,
  },
  requestButton: {
    height: 48,
  },
  timerPanel: {
    alignItems: "center",
    gap: spacing.sm,
  },
  timerLabel: {
    ...typography.label,
    color: colors.textMuted,
  },
  timer: {
    ...typography.headline,
    color: colors.teal,
  },
  warning: {
    ...typography.small,
    color: colors.gold,
    textAlign: "center",
  },
  error: {
    ...typography.small,
    color: colors.pink,
    textAlign: "center",
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    gap: spacing.xl,
  },
});
