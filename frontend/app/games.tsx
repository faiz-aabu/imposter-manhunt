import { Redirect, useRouter } from "expo-router";
import {
  ArrowLeft,
  CaseSensitive,
  CircleHelp,
  Target,
} from "lucide-react-native";
import { StyleSheet, Text, View } from "react-native";
import {
  Chip,
  GameCard,
  IconButton,
  LanguageSelector,
  PrimaryButton,
  Screen,
  TopHudBar,
} from "../src/components";
import { useRoomStore } from "../src/store/room-store";
import { colors, spacing, typography } from "../src/theme";
import { useTranslation } from "../src/i18n/use-translation";

export default function GamesRoute() {
  const router = useRouter();
  const t = useTranslation();
  const room = useRoomStore((state) => state.room);
  const playerId = useRoomStore((state) => state.playerId);

  if (!room || !playerId) {
    return <Redirect href="/lobby" />;
  }

  if (room.hostId !== playerId) {
    return (
      <Screen>
        <View style={styles.permissionScreen}>
          <IconButton
            accessibilityLabel={t("games.backAccessibility")}
            icon={ArrowLeft}
            onPress={() => router.replace("/lobby")}
          />
          <Text style={styles.title}>{t("games.hostOnly")}</Text>
          <Text style={styles.subtitle}>
            {t("games.hostOnlyDescription")}
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

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <TopHudBar
        leftLabel={t("common.roomCode")}
        leftValue={room.code}
        rightLabel={t("common.players")}
        rightValue={`${room.players.length} / ${room.settings.maxPlayers}`}
        leftValueStyle={typography.roomCode}
        style={styles.topBar}
      />
      <View style={styles.hostChipRow}>
        <Chip label={t("games.host")} variant="gold" />
      </View>

      <Text style={styles.title}>{t("games.title")}</Text>
      <LanguageSelector />

      <View style={styles.cards}>
        <GameCard
          icon={Target}
          title={t("games.manhunt")}
          subtitle={t("games.manhuntDescription")}
          chipLabel={t("games.gpsMap")}
          chipVariant="pink"
          tileColor={colors.pink}
          onPress={() => router.push("/manhunt/mode")}
        />
        <GameCard
          icon={CircleHelp}
          title={t("games.classic")}
          subtitle={t("games.classicDescription")}
          chipLabel={t("games.faceToFace")}
          chipVariant="white"
          tileColor={colors.violet}
          onPress={() =>
            router.push({
              pathname: "/imposter/settings",
              params: { mode: "impostor-classic" },
            })
          }
        />
        <GameCard
          icon={CaseSensitive}
          title={t("games.word")}
          subtitle={t("games.wordDescription")}
          chipLabel={t("games.secretWord")}
          chipVariant="teal"
          tileColor={colors.teal}
          onPress={() =>
            router.push({
              pathname: "/imposter/settings",
              params: { mode: "impostor-word" },
            })
          }
        />
      </View>

      <PrimaryButton
        title={t("games.backToLobby")}
        variant="secondary"
        onPress={() => router.replace("/lobby")}
        style={styles.backToLobby}
      />
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
  hostChipRow: {
    alignItems: "flex-end",
  },
  title: {
    ...typography.title,
    color: colors.text,
  },
  cards: {
    gap: spacing.md,
  },
  backToLobby: {
    marginTop: spacing.xs,
  },
  permissionScreen: {
    flex: 1,
    justifyContent: "center",
    gap: spacing.xl,
  },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
  },
});
