import { useEffect, useState } from "react";
import { Text, StyleSheet, View } from "react-native";
import { Chip, Screen } from "../../src/components";
import { useManhuntGameStore } from "../../src/store/manhunt-game-store";
import { colors, spacing, typography } from "../../src/theme";

export default function CountdownRoute() {
  const gameState = useManhuntGameStore((state) => state.gameState);
  const ownTeam = useManhuntGameStore((state) => state.ownTeam);
  const countdown = useManhuntGameStore((state) => state.countdown);
  const countdownServerOffsetMs = useManhuntGameStore(
    (state) => state.countdownServerOffsetMs,
  );
  const [localNow, setLocalNow] = useState(Date.now);
  const isCountdown = gameState?.phase === "countdown";

  useEffect(() => {
    if (!isCountdown || !countdown) {
      return;
    }
    const timer = setInterval(() => setLocalNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [countdown, isCountdown]);

  const remainingSeconds =
    isCountdown && countdown && countdownServerOffsetMs !== null
      ? Math.max(
          0,
          Math.ceil(
            (Date.parse(countdown.endsAt) -
              (localNow + countdownServerOffsetMs)) /
              1_000,
          ),
        )
      : null;

  return (
    <Screen contentContainerStyle={styles.content}>
      <Chip label="MANHUNT" variant="pink" />
      <Text style={styles.title}>Starting Manhunt</Text>
      {ownTeam ? (
        <Text style={styles.teamText}>
          Your team: {ownTeam === "hunter" ? "Hunter" : "Runner"}
        </Text>
      ) : null}
      {remainingSeconds !== null ? (
        <View accessibilityLiveRegion="polite" style={styles.countdown}>
          <Text style={styles.countdownValue}>{remainingSeconds}</Text>
          <Text style={styles.countdownLabel}>
            {remainingSeconds === 1 ? "second" : "seconds"}
          </Text>
        </View>
      ) : (
        <Text style={styles.subtitle}>
          {isCountdown
            ? "Synchronizing with the server countdown..."
            : "Waiting for the authoritative server start."}
        </Text>
      )}
      <Text style={styles.subtitle}>
        The map opens when the server confirms the start.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
  },
  title: {
    ...typography.title,
    color: colors.text,
  },
  teamText: {
    ...typography.body,
    color: colors.teal,
  },
  countdown: {
    alignItems: "center",
    gap: spacing.xs,
  },
  countdownValue: {
    ...typography.headline,
    color: colors.teal,
    fontVariant: ["tabular-nums"],
  },
  countdownLabel: {
    ...typography.body,
    color: colors.textMuted,
  },
  subtitle: {
    ...typography.small,
    color: colors.textMuted,
  },
});
