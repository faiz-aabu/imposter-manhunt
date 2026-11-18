import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Crown, ShieldAlert } from "lucide-react-native";
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
  const room = useRoomStore((state) => state.room);
  const classicSession = useClassicGameStore((state) => state.session);
  const classicResult = useClassicGameStore((state) => state.result);
  const classicReveal = useClassicGameStore((state) => state.reveal);
  const classicPlayersAtStart = useClassicGameStore(
    (state) => state.playersAtStart,
  );
  const resetClassicGame = useClassicGameStore((state) => state.reset);
  const classicError = useClassicGameStore((state) => state.error);
  const wordSession = useWordGameStore((state) => state.session);
  const wordResult = useWordGameStore((state) => state.result);
  const wordReveal = useWordGameStore((state) => state.reveal);
  const wordPlayersAtStart = useWordGameStore((state) => state.playersAtStart);
  const resetWordGame = useWordGameStore((state) => state.reset);
  const wordError = useWordGameStore((state) => state.error);
  const isWordSession = wordSession !== null;
  const session = wordSession ?? classicSession;
  const result = isWordSession ? wordResult : classicResult;
  const playersAtStart = isWordSession
    ? wordPlayersAtStart
    : classicPlayersAtStart;
  const error = isWordSession ? wordError : classicError;
  const connectionStatus = useConnectionStore((state) => state.status);

  if (!session) {
    return (
      <Screen>
        <View style={styles.centered}>
          <Text style={styles.title}>Results unavailable</Text>
          <Text style={styles.mutedText}>
            There is no active Impostor game session in this app state.
          </Text>
          <PrimaryButton
            title="Back to lobby"
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
  const returnToLobby = () => {
    resetClassicGame();
    resetWordGame();
    router.replace("/lobby");
  };

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <TopHudBar
        leftLabel="Room code"
        leftValue={session.roomCode}
        rightLabel="Result"
        rightValue={result?.outcome === "win" ? "Complete" : "Final"}
      />

      <View style={styles.heading}>
        <Chip label="Game over" variant="gold" />
        <Text style={styles.title}>{getResultTitle(result?.outcome)}</Text>
        {result?.outcome === "win" && winnerNames.length > 0 ? (
          <View style={styles.winnerLine}>
            <Crown color={colors.gold} size={20} />
            <Text style={styles.winnerNames}>{winnerNames.join(", ")}</Text>
          </View>
        ) : null}
        {result?.outcome === "cancelled" ? (
          <Text style={styles.mutedText}>
            The server ended the game before a winner was declared.
          </Text>
        ) : null}
        {result && result.winnerPlayerIds.length > 0 && winnerNames.length === 0 ? (
          <Text style={styles.mutedText}>
            The server declared a winner, but their player names are unavailable.
          </Text>
        ) : null}
      </View>

      {!result || !revealIsReady ? (
        <HudPanel style={styles.waitingPanel}>
          <ActivityIndicator color={colors.teal} />
          <Text style={styles.mutedText}>
            {!result
              ? "Waiting for the server to confirm the final result..."
              : "Waiting for the server's official role reveal..."}
          </Text>
        </HudPanel>
      ) : (
        <HudPanel style={styles.rolesPanel}>
          <View style={styles.panelHeading}>
            <ShieldAlert color={colors.pink} size={20} />
            <Text style={styles.sectionTitle}>
              {isWordSession ? "Final word and roles" : "Final roles"}
            </Text>
          </View>
          <Text style={styles.mutedText}>
            These roles are shown after the server's final reveal.
          </Text>
          {isWordSession && wordReveal ? (
            <View style={styles.wordPanel}>
              <Text style={styles.wordCategory}>
                {formatCategory(wordReveal.category)}
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
                      ? "Role unavailable"
                      : isImpostor
                        ? "Impostor"
                        : "Civilian"
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
            ? "Reconnecting to restore the complete result..."
            : "Connection lost. The displayed result is from the last server update."}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}

      <PrimaryButton
        title="Return to lobby"
        onPress={returnToLobby}
      />
    </Screen>
  );
}

function formatCategory(category: string): string {
  return `${category.charAt(0).toUpperCase()}${category.slice(1)}`;
}

function getResultTitle(
  outcome: "win" | "draw" | "cancelled" | undefined,
): string {
  switch (outcome) {
    case "win":
      return "The game has a winner";
    case "draw":
      return "The game ended in a draw";
    case "cancelled":
      return "The game was cancelled";
    default:
      return "Final results";
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
