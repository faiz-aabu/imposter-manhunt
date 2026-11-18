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
  PrimaryButton,
  Screen,
  TopHudBar,
} from "../src/components";
import { useRoomStore } from "../src/store/room-store";
import { colors, spacing, typography } from "../src/theme";

export default function GamesRoute() {
  const router = useRouter();
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
            accessibilityLabel="Back to lobby"
            icon={ArrowLeft}
            onPress={() => router.replace("/lobby")}
          />
          <Text style={styles.title}>Host only</Text>
          <Text style={styles.subtitle}>
            Only the room host can choose a game.
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

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <TopHudBar
        leftLabel="Room code"
        leftValue={room.code}
        rightLabel="Players"
        rightValue={`${room.players.length} / ${room.settings.maxPlayers}`}
        leftValueStyle={typography.roomCode}
        style={styles.topBar}
      />
      <View style={styles.hostChipRow}>
        <Chip label="Host" variant="gold" />
      </View>

      <Text style={styles.title}>What are we playing?</Text>

      <View style={styles.cards}>
        <GameCard
          icon={Target}
          title="Manhunt"
          subtitle="Seekers and hunters chase civilians in real life"
          chipLabel="GPS map"
          chipVariant="pink"
          tileColor={colors.pink}
          onPress={() => router.push("/manhunt/mode")}
        />
        <GameCard
          icon={CircleHelp}
          title="Classic Imposter"
          subtitle="No word. Ask questions and spot the liar"
          chipLabel="Face to face"
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
          title="Word Imposter"
          subtitle="Everyone gets a secret word. One doesn't"
          chipLabel="Secret word"
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
        title="Back to lobby"
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
