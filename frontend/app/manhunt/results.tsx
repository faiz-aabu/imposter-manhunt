import { useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { Chip, PrimaryButton, Screen } from "../../src/components";
import { useManhuntGameStore } from "../../src/store/manhunt-game-store";
import { useRoomStore } from "../../src/store/room-store";
import { colors, spacing, typography } from "../../src/theme";

export default function ResultsRoute() {
  const router = useRouter();
  const result = useManhuntGameStore((state) => state.result);
  const players = useManhuntGameStore((state) => state.playersAtStart);
  const room = useRoomStore((state) => state.room);
  const caughtPlayerIds = useManhuntGameStore(
    (state) => state.caughtPlayerIds,
  );
  const winnerTeam = result
    ? room?.players
        .filter((player) => result.result.winnerPlayerIds.includes(player.id))
        .length
      ? "Hunters"
      : "No winner"
    : null;

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <Chip label="MANHUNT RESULTS" variant={result ? "gold" : "white"} />
      <Text style={styles.title}>{winnerTeam ?? "Waiting for result"}</Text>
      {!result ? (
        <Text style={styles.subtitle}>
          Waiting for the authoritative game-end event.
        </Text>
      ) : (
        <View style={styles.panel}>
          {players.map((player) => {
            const caught = caughtPlayerIds.includes(player.id);
            return (
              <View key={player.id} style={styles.playerRow}>
                <Text style={styles.playerName}>{player.nickname}</Text>
                <Text style={styles.statusText}>
                  {caught ? "Caught" : player.status}
                </Text>
              </View>
            );
          })}
        </View>
      )}
      <PrimaryButton
        title="Back to room"
        variant="secondary"
        onPress={() => router.replace("/lobby")}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.xxl,
    gap: spacing.lg,
  },
  title: {
    ...typography.title,
    color: colors.text,
  },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
  },
  panel: {
    backgroundColor: colors.panel,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    padding: spacing.lg,
    gap: spacing.md,
  },
  playerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  playerName: {
    ...typography.body,
    color: colors.text,
  },
  statusText: {
    ...typography.small,
    color: colors.textMuted,
  },
});
