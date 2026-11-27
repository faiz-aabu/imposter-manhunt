import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  Chip,
  HudPanel,
  PlayerRow,
  PrimaryButton,
  Screen,
  TopHudBar,
} from "../../src/components";
import { useServerCountdown } from "../../src/hooks/use-server-countdown";
import { useClassicGameStore } from "../../src/store/classic-game-store";
import { useWordGameStore } from "../../src/store/word-game-store";
import { useConnectionStore } from "../../src/store/connection-store";
import { useRoomStore } from "../../src/store/room-store";
import { useTranslation } from "../../src/i18n/use-translation";
import { localizeImpostorError } from "../../src/i18n/impostor-errors";
import { colors, spacing, typography } from "../../src/theme";

const PLAYER_COLORS = [
  colors.violet,
  colors.teal,
  colors.pink,
  colors.gold,
  colors.blue,
  colors.green,
];

export default function DiscussionRoute() {
  const router = useRouter();
  const t = useTranslation();
  const room = useRoomStore((state) => state.room);
  const classicSession = useClassicGameStore((state) => state.session);
  const classicState = useClassicGameStore((state) => state.state);
  const classicDiscussion = useClassicGameStore((state) => state.discussion);
  const classicVoteResults = useClassicGameStore((state) => state.voteResults);
  const classicPlayersAtStart = useClassicGameStore(
    (state) => state.playersAtStart,
  );
  const classicError = useClassicGameStore((state) => state.error);
  const classicTimeOffset = useClassicGameStore(
    (state) => state.serverTimeOffsetMs,
  );
  const wordSession = useWordGameStore((state) => state.session);
  const wordState = useWordGameStore((state) => state.state);
  const wordDiscussion = useWordGameStore((state) => state.discussion);
  const wordVoteResults = useWordGameStore((state) => state.voteResults);
  const wordPlayersAtStart = useWordGameStore((state) => state.playersAtStart);
  const wordError = useWordGameStore((state) => state.error);
  const wordTimeOffset = useWordGameStore((state) => state.serverTimeOffsetMs);
  const session = wordSession ?? classicSession;
  const isWordSession = wordSession !== null;
  const gameState = isWordSession ? wordState : classicState;
  const discussion = isWordSession ? wordDiscussion : classicDiscussion;
  const voteResults = isWordSession ? wordVoteResults : classicVoteResults;
  const playersAtStart = isWordSession
    ? wordPlayersAtStart
    : classicPlayersAtStart;
  const error = isWordSession ? wordError : classicError;
  const serverTimeOffsetMs = isWordSession
    ? wordTimeOffset
    : classicTimeOffset;
  const connectionStatus = useConnectionStore((state) => state.status);
  const countdown = useServerCountdown(
    gameState?.phase === "discussion"
      ? gameState.discussionEndsAt ?? discussion?.endsAt
      : undefined,
    serverTimeOffsetMs,
  );

  if (!session || !gameState || !room || room.code !== session.roomCode) {
    return (
      <Screen>
        <View style={styles.centered}>
          <ActivityIndicator color={colors.teal} />
          <Text style={styles.title}>
            {t("impostor.discussion.restoringTitle")}
          </Text>
          <Text style={styles.mutedText}>
            {t("impostor.discussion.restoringDescription")}
          </Text>
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {localizeImpostorError(error, t)}
            </Text>
          ) : null}
          <PrimaryButton
            title={t("games.backToLobby")}
            variant="secondary"
            onPress={() => router.replace("/lobby")}
          />
        </View>
      </Screen>
    );
  }

  const resultRound = voteResults?.roundNumber;
  const eliminatedPlayer =
    voteResults?.eliminatedPlayerId === null
      ? undefined
      : room.players.find(
          (player) => player.id === voteResults?.eliminatedPlayerId,
        ) ??
        playersAtStart.find(
            (player) => player.id === voteResults?.eliminatedPlayerId,
          );
  const isTie =
    voteResults?.eliminatedPlayerId === null &&
    (voteResults.tiedPlayerIds?.length ?? 0) > 0;
  const isNoVoteResult =
    voteResults?.eliminatedPlayerId === null &&
    (voteResults.tiedPlayerIds?.length ?? 0) === 0;

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <TopHudBar
        leftLabel={t("common.roomCode")}
        leftValue={room.code}
        rightLabel={t("common.round")}
        rightValue={`${gameState.roundNumber}`}
      />

      <View style={styles.heading}>
        <Chip
          label={
            isWordSession
              ? t("impostor.mode.word")
              : t("impostor.discussion.label")
          }
          variant="teal"
        />
        <Text style={styles.title}>
          {t(
            isWordSession
              ? "impostor.discussion.wordTitle"
              : "impostor.discussion.classicTitle",
          )}
        </Text>
        <Text style={styles.mutedText}>
          {t(
            isWordSession
              ? "impostor.discussion.wordDescription"
              : "impostor.discussion.classicDescription",
          )}
        </Text>
      </View>

      {gameState.phase === "discussion" ? (
        <HudPanel style={styles.timerPanel}>
          <Text style={styles.timerLabel}>
            {t("impostor.discussion.endsIn")}
          </Text>
          <Text style={styles.timer}>{countdown.label}</Text>
          {countdown.remainingSeconds === 0 ? (
            <Text style={styles.mutedText}>
              {t("impostor.discussion.waitingVoting")}
            </Text>
          ) : null}
          {isWordSession && voteResults ? (
            <View style={styles.tallies}>
              {voteResults.tallies.map((tally) => {
                const player =
                  room.players.find(
                    (entry) => entry.id === tally.targetPlayerId,
                  ) ??
                  playersAtStart.find(
                    (entry) => entry.id === tally.targetPlayerId,
                  );
                return player ? (
                  <View key={tally.targetPlayerId} style={styles.tallyRow}>
                    <Text style={styles.mutedText}>{player.nickname}</Text>
                    <Text style={styles.tallyCount}>
                      {t(
                        tally.count === 1
                          ? "impostor.discussion.voteCountOne"
                          : "impostor.discussion.voteCountMany",
                        { count: tally.count },
                      )}
                    </Text>
                  </View>
                ) : null;
              })}
            </View>
          ) : null}
        </HudPanel>
      ) : (
        <HudPanel style={styles.timerPanel}>
          <Text style={styles.timerLabel}>
            {t("impostor.discussion.currentPhase")}
          </Text>
          <Text style={styles.phaseText}>
            {phaseLabel(gameState.phase, t)}
          </Text>
        </HudPanel>
      )}

      {connectionStatus !== "connected" ? (
        <Text style={styles.warning}>
          {connectionStatus === "reconnecting"
            ? t("impostor.discussion.reconnecting")
            : t("impostor.discussion.connectionLost")}
        </Text>
      ) : null}

      {voteResults ? (
        <HudPanel style={styles.resultPanel}>
          <Text style={styles.sectionTitle}>
            {t("impostor.discussion.roundResult", {
              round: resultRound ?? "",
            })}
          </Text>
          {eliminatedPlayer ? (
            <Text style={styles.resultText}>
              {t("impostor.discussion.eliminated", {
                player: eliminatedPlayer.nickname,
              })}
            </Text>
          ) : isTie ? (
            <Text style={styles.resultText}>
              {t("impostor.discussion.tieRevote")}
            </Text>
          ) : isNoVoteResult ? (
            <Text style={styles.resultText}>
              {t("impostor.discussion.noVotes")}
            </Text>
          ) : null}
        </HudPanel>
      ) : null}

      <HudPanel style={styles.playersPanel}>
        <View style={styles.panelHeading}>
          <Text style={styles.sectionTitle}>{t("common.players")}</Text>
          <Chip
          label={t("impostor.discussion.playersInRoom", {
            count: room.players.length,
          })}
            variant="muted"
          />
        </View>
        <View style={styles.playerList}>
          {room.players.map((player, index) => (
            <PlayerRow
              key={player.id}
              name={player.nickname}
              avatarColor={PLAYER_COLORS[index % PLAYER_COLORS.length]}
              status={
                player.status === "eliminated"
                ? t("impostor.discussion.eliminatedStatus")
                  : player.connectionStatus === "connected"
                  ? t("impostor.discussion.inGameStatus")
                  : t("impostor.discussion.disconnectedStatus")
              }
            />
          ))}
        </View>
      </HudPanel>

      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {localizeImpostorError(error, t)}
        </Text>
      ) : null}
    </Screen>
  );
}

function phaseLabel(
  phase: string,
  t: ReturnType<typeof useTranslation>,
): string {
  switch (phase) {
    case "role_reveal":
      return t("impostor.discussion.phaseRoleReveal");
    case "voting":
      return t("impostor.discussion.phaseVoting");
    case "reveal":
      return t("impostor.discussion.phaseResults");
    default:
      return t("impostor.discussion.label");
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
  mutedText: {
    ...typography.small,
    color: colors.textMuted,
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
  phaseText: {
    ...typography.gameCardTitle,
    color: colors.text,
  },
  resultPanel: {
    gap: spacing.sm,
    borderColor: colors.gold,
  },
  resultText: {
    ...typography.body,
    color: colors.text,
  },
  tallies: {
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  tallyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  tallyCount: {
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
