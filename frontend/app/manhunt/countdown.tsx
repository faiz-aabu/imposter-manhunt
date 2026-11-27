import { useEffect, useState } from "react";
import { Text, StyleSheet, View } from "react-native";
import { Chip, Screen } from "../../src/components";
import { useManhuntGameStore } from "../../src/store/manhunt-game-store";
import { colors, spacing, typography } from "../../src/theme";
import { useTranslation } from "../../src/i18n/use-translation";
import { MANHUNT_RUNNER_HEAD_START_SECONDS } from "@impostor/api";

export default function CountdownRoute() {
  const t = useTranslation();
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
      <Text style={styles.title}>
        {ownTeam === "hunter"
          ? t("manhunt.countdown.titleHunter")
          : t("manhunt.countdown.titleStarting")}
      </Text>
      {ownTeam ? (
        <Text style={styles.teamText}>
          {t("manhunt.countdown.yourTeam", {
            team: t(
              ownTeam === "hunter"
                ? "manhunt.team.hunter"
                : "manhunt.team.runner",
            ),
          })}
        </Text>
      ) : null}
      {ownTeam === "hunter" ? (
        <Text style={styles.subtitle}>
          {t("manhunt.countdown.headStart", {
            seconds: MANHUNT_RUNNER_HEAD_START_SECONDS,
          })}
        </Text>
      ) : null}
      {remainingSeconds !== null ? (
        <View accessibilityLiveRegion="polite" style={styles.countdown}>
          <Text style={styles.countdownValue}>{remainingSeconds}</Text>
          <Text style={styles.countdownLabel}>
            {t(
              remainingSeconds === 1
                ? "manhunt.countdown.second"
                : "manhunt.countdown.seconds",
            )}
          </Text>
        </View>
      ) : (
        <Text style={styles.subtitle}>
          {isCountdown
            ? t("manhunt.countdown.syncing")
            : t("manhunt.countdown.waiting")}
        </Text>
      )}
      <Text style={styles.subtitle}>
        {ownTeam === "hunter"
          ? t("manhunt.countdown.stay")
          : t("manhunt.countdown.mapOpens")}
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
    textAlign: "center",
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
