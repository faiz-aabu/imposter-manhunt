import { useRouter } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { Chip, PrimaryButton, Screen } from "../../src/components";
import { useManhuntGameStore } from "../../src/store/manhunt-game-store";
import { useRoomStore } from "../../src/store/room-store";
import { colors, spacing, typography } from "../../src/theme";
import { useTranslation } from "../../src/i18n/use-translation";
import type { PlayerStatus } from "@impostor/api";
import type { TranslationKey } from "../../src/i18n/locales";

const playerStatusKeys: Record<PlayerStatus, TranslationKey> = {
  waiting: "manhunt.results.waitingStatus",
  active: "manhunt.results.activeStatus",
  eliminated: "manhunt.results.eliminatedStatus",
  frozen: "manhunt.results.frozenStatus",
  caught: "manhunt.results.caught",
  escaped: "manhunt.results.escapedStatus",
} as const;

export default function ResultsRoute() {
  const router = useRouter();
  const t = useTranslation();
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
        ? t("manhunt.results.hunters")
        : t("manhunt.results.noWinner")
    : null;

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
        <Chip
          label={t("manhunt.results.label")}
          variant={result ? "gold" : "white"}
        />
        <Text style={styles.title}>
          {winnerTeam ?? t("manhunt.results.waiting")}
        </Text>
      {!result ? (
        <Text style={styles.subtitle}>
            {t("manhunt.results.waitingEvent")}
        </Text>
      ) : (
        <View style={styles.panel}>
          {players.map((player) => {
            const caught = caughtPlayerIds.includes(player.id);
            return (
              <View key={player.id} style={styles.playerRow}>
                <Text style={styles.playerName}>{player.nickname}</Text>
                <Text style={styles.statusText}>
                  {caught
                    ? t("manhunt.results.caught")
                    : t(playerStatusKeys[player.status])}
                </Text>
              </View>
            );
          })}
        </View>
      )}
      <PrimaryButton
        title={t("manhunt.results.backToRoom")}
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
