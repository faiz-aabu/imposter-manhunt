import { useMemo } from "react";
import { useRouter } from "expo-router";
import { AlertCircle, Check, Vote } from "lucide-react-native";
import { StyleSheet, Text, View } from "react-native";
import {
  IMPOSTOR_EVENTS,
  WORD_IMPOSTOR_EVENTS,
} from "@impostor/api";
import {
  Chip,
  HudPanel,
  PrimaryButton,
  Screen,
  TopHudBar,
  VoteOption,
} from "../../src/components";
import {
  isCountdownOpen,
  useServerCountdown,
} from "../../src/hooks/use-server-countdown";
import { getSocketClient } from "../../src/services/socket-client";
import {
  getCurrentVoteKey,
  useClassicGameStore,
} from "../../src/store/classic-game-store";
import {
  getCurrentWordVoteKey,
  useWordGameStore,
} from "../../src/store/word-game-store";
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

export default function ImpostorVoteRoute() {
  const router = useRouter();
  const t = useTranslation();
  const room = useRoomStore((state) => state.room);
  const playerId = useRoomStore((state) => state.playerId);
  const classicSession = useClassicGameStore((state) => state.session);
  const classicState = useClassicGameStore((state) => state.state);
  const classicVoteResults = useClassicGameStore((state) => state.voteResults);
  const classicPlayersAtStart = useClassicGameStore(
    (state) => state.playersAtStart,
  );
  const classicSelectedTarget = useClassicGameStore(
    (state) => state.selectedTargetId,
  );
  const classicSubmittedVoteKey = useClassicGameStore(
    (state) => state.submittedVoteKey,
  );
  const classicVoteSent = useClassicGameStore((state) => state.voteSent);
  const classicError = useClassicGameStore((state) => state.error);
  const classicSelectTarget = useClassicGameStore(
    (state) => state.setSelectedTarget,
  );
  const classicMarkVoteSent = useClassicGameStore(
    (state) => state.markVoteSent,
  );
  const classicSetError = useClassicGameStore((state) => state.setError);
  const classicTimeOffset = useClassicGameStore(
    (state) => state.serverTimeOffsetMs,
  );
  const wordSession = useWordGameStore((state) => state.session);
  const wordState = useWordGameStore((state) => state.state);
  const wordVoteResults = useWordGameStore((state) => state.voteResults);
  const wordPlayersAtStart = useWordGameStore((state) => state.playersAtStart);
  const wordSelectedTarget = useWordGameStore(
    (state) => state.selectedTargetId,
  );
  const wordSubmittedVoteKey = useWordGameStore(
    (state) => state.submittedVoteKey,
  );
  const wordVoteSent = useWordGameStore((state) => state.voteSent);
  const wordError = useWordGameStore((state) => state.error);
  const wordSelectTarget = useWordGameStore(
    (state) => state.setSelectedTarget,
  );
  const wordMarkVoteSent = useWordGameStore((state) => state.markVoteSent);
  const wordSetError = useWordGameStore((state) => state.setError);
  const wordTimeOffset = useWordGameStore(
    (state) => state.serverTimeOffsetMs,
  );
  const session = wordSession ?? classicSession;
  const isWordSession = wordSession !== null;
  const gameState = isWordSession ? wordState : classicState;
  const voteResults = isWordSession ? wordVoteResults : classicVoteResults;
  const playersAtStart = isWordSession
    ? wordPlayersAtStart
    : classicPlayersAtStart;
  const selectedTargetId = isWordSession
    ? wordSelectedTarget
    : classicSelectedTarget;
  const submittedVoteKey = isWordSession
    ? wordSubmittedVoteKey
    : classicSubmittedVoteKey;
  const voteSent = isWordSession ? wordVoteSent : classicVoteSent;
  const error = isWordSession ? wordError : classicError;
  const selectTarget = isWordSession
    ? wordSelectTarget
    : classicSelectTarget;
  const markVoteSent = isWordSession
    ? wordMarkVoteSent
    : classicMarkVoteSent;
  const setError = isWordSession ? wordSetError : classicSetError;
  const connectionStatus = useConnectionStore((state) => state.status);
  const serverClockStatus = useConnectionStore(
    (state) => state.serverClockStatus,
  );
  const serverTimeOffsetMs = isWordSession
    ? wordTimeOffset
    : classicTimeOffset;
  const countdown = useServerCountdown(
    gameState?.phase === "voting" ? gameState.votingEndsAt : undefined,
    serverTimeOffsetMs,
  );

  const voteCandidates = useMemo(
    () => gameState?.revotePlayerIds,
    [gameState?.revotePlayerIds],
  );
  const eligiblePlayers = useMemo(
    () =>
      room?.players.filter(
        (player) =>
          player.status !== "eliminated" &&
          player.id !== playerId &&
          (!voteCandidates || voteCandidates.includes(player.id)),
      ) ?? [],
    [playerId, room?.players, voteCandidates],
  );
  const currentPlayer = room?.players.find(
    (player) => player.id === playerId,
  );
  const currentVoteKey =
    session && gameState?.phase === "voting"
      ? isWordSession
        ? getCurrentWordVoteKey(session.id, gameState)
        : getCurrentVoteKey(session.id, gameState)
      : null;
  const votingEndsAt =
    gameState?.phase === "voting" ? gameState.votingEndsAt : undefined;
  const votingPhaseId =
    gameState?.phase === "voting" ? gameState.votingPhaseId : undefined;
  const hasSubmittedCurrentVote =
    currentVoteKey !== null && submittedVoteKey === currentVoteKey;
  const selectedTargetIsEligible = eligiblePlayers.some(
    (player) => player.id === selectedTargetId,
  );
  const canSubmit =
    connectionStatus === "connected" &&
    gameState?.phase === "voting" &&
    isCountdownOpen(countdown.remainingSeconds) &&
    currentPlayer?.status !== "eliminated" &&
    selectedTargetIsEligible &&
    !hasSubmittedCurrentVote &&
    !voteSent;
  const canChooseTarget =
    connectionStatus === "connected" &&
    gameState?.phase === "voting" &&
    isCountdownOpen(countdown.remainingSeconds) &&
    currentPlayer?.status !== "eliminated" &&
    !hasSubmittedCurrentVote &&
    !voteSent;

  const submitVote = () => {
    if (
      !session ||
      !room ||
      !selectedTargetId ||
      !currentVoteKey ||
      !votingEndsAt ||
      votingPhaseId === undefined ||
      !canSubmit ||
      !markVoteSent(currentVoteKey, selectedTargetId)
    ) {
      return;
    }

    try {
      const socket = getSocketClient();
      if (!socket.connected) {
        setError("Reconnect before submitting your vote.");
        return;
      }
      if (session.gameMode === "impostor-word") {
        socket.emit(WORD_IMPOSTOR_EVENTS.VOTE_SUBMISSION, {
          roomCode: session.roomCode,
          sessionId: session.id,
          votingEndsAt,
          votingPhaseId,
          targetPlayerId: selectedTargetId,
        });
      } else {
        socket.emit(IMPOSTOR_EVENTS.VOTE_SUBMISSION, {
          roomCode: session.roomCode,
          sessionId: session.id,
          votingEndsAt,
          votingPhaseId,
          targetPlayerId: selectedTargetId,
        });
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Your vote could not be sent.",
      );
    }
  };

  if (!session || !gameState || !room || !playerId || room.code !== session.roomCode) {
    return (
      <Screen>
        <View style={styles.centered}>
          <Text style={styles.title}>{t("impostor.vote.restoringTitle")}</Text>
          <Text style={styles.mutedText}>
            {t("impostor.vote.restoringDescription")}
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

  const hasRevote = (gameState.revotePlayerIds?.length ?? 0) > 0;
  const resultPlayer =
    voteResults?.eliminatedPlayerId
      ? room.players.find(
          (player) => player.id === voteResults.eliminatedPlayerId,
        ) ??
        playersAtStart.find(
            (player) => player.id === voteResults.eliminatedPlayerId,
          )
      : undefined;

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
            hasRevote
              ? t("impostor.vote.revote")
              : isWordSession
                ? t("impostor.mode.word")
                : t("impostor.vote.label")
          }
          variant={hasRevote ? "pink" : "teal"}
        />
        <Text style={styles.title}>
          {hasRevote
            ? t("impostor.vote.againTitle")
            : isWordSession
              ? t("impostor.vote.wordTitle")
              : t("impostor.vote.classicTitle")}
        </Text>
        <Text style={styles.mutedText}>
          {t("impostor.vote.privateInstructions")}
        </Text>
      </View>

      <HudPanel style={styles.timerPanel}>
        <Text style={styles.timerLabel}>{t("impostor.vote.endsIn")}</Text>
        <Text style={styles.timer}>{countdown.label}</Text>
        {gameState.phase === "voting" ? (
          <Text style={styles.mutedText}>
            {t("impostor.vote.countSummary", {
              submitted: gameState.votesSubmitted,
              eligible: gameState.eligibleVoters,
            })}
          </Text>
        ) : (
          <Text style={styles.mutedText}>
            {t("impostor.vote.waiting")}
          </Text>
        )}
      </HudPanel>

      {connectionStatus !== "connected" ? (
        <Text style={styles.warning}>
          {connectionStatus === "reconnecting"
            ? t("impostor.vote.reconnecting")
            : t("impostor.vote.connectionLost")}
        </Text>
      ) : null}
      {gameState.phase === "voting" &&
      serverTimeOffsetMs === null &&
      connectionStatus === "connected" ? (
        <Text style={styles.warning}>
          {serverClockStatus === "failed"
            ? t("impostor.vote.clockFailed")
            : t("impostor.vote.clockSyncing")}
        </Text>
      ) : null}

      {hasRevote ? (
        <HudPanel style={styles.noticePanel}>
          <View style={styles.noticeHeading}>
            <AlertCircle color={colors.pink} size={20} />
            <Text style={styles.sectionTitle}>
              {t("impostor.vote.revoteRequested")}
            </Text>
          </View>
          <Text style={styles.mutedText}>
            {t("impostor.vote.tiedTargets")}
          </Text>
        </HudPanel>
      ) : null}

      {resultPlayer ? (
        <HudPanel style={styles.resultPanel}>
          <Text style={styles.sectionTitle}>
            {t("impostor.vote.eliminatedTitle", {
              player: resultPlayer.nickname,
            })}
          </Text>
          <Text style={styles.mutedText}>
            {t("impostor.vote.resultConfirmed", {
              round: voteResults?.roundNumber ?? "",
            })}
          </Text>
        </HudPanel>
      ) : null}
      {isWordSession && voteResults ? (
        <HudPanel style={styles.resultPanel}>
          <Text style={styles.sectionTitle}>
            {t("impostor.vote.serverTotals")}
          </Text>
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
                      ? "impostor.vote.voteCountOne"
                      : "impostor.vote.voteCountMany",
                    { count: tally.count },
                  )}
                </Text>
              </View>
            ) : null;
          })}
        </HudPanel>
      ) : null}

      {gameState.phase === "voting" && currentPlayer?.status !== "eliminated" ? (
        <HudPanel style={styles.optionsPanel}>
          <View style={styles.panelHeading}>
            <Text style={styles.sectionTitle}>
              {t("impostor.vote.choosePlayer")}
            </Text>
            <Chip
              label={t("impostor.vote.eligibleCount", {
                count: eligiblePlayers.length,
              })}
              variant="muted"
            />
          </View>
          {eligiblePlayers.length > 0 ? (
            <View style={styles.options}>
              {eligiblePlayers.map((player) => (
                <VoteOption
                  key={player.id}
                  name={player.nickname}
                  avatarColor={
                    PLAYER_COLORS[
                      room.players.findIndex((entry) => entry.id === player.id) %
                        PLAYER_COLORS.length
                    ]
                  }
                  selected={selectedTargetId === player.id}
                  disabled={!canChooseTarget}
                  onPress={() => selectTarget(player.id)}
                  outLabel={t("impostor.vote.out")}
                  selectedLabel={t("impostor.vote.yourVote")}
                />
              ))}
            </View>
          ) : (
            <Text style={styles.mutedText}>
              {t("impostor.vote.noTargets")}
            </Text>
          )}
        </HudPanel>
      ) : gameState.phase === "voting" ? (
        <HudPanel style={styles.noticePanel}>
          <Text style={styles.sectionTitle}>
            {t("impostor.vote.eliminated")}
          </Text>
          <Text style={styles.mutedText}>
            {t("impostor.vote.noLaterVotes")}
          </Text>
        </HudPanel>
      ) : null}

      {voteSent || hasSubmittedCurrentVote ? (
        <View style={styles.sentNotice}>
          <Check color={colors.green} size={18} />
          <Text style={styles.sentText}>
            {t("impostor.vote.sentWaiting")}
          </Text>
        </View>
      ) : null}
      {countdown.remainingSeconds === 0 && gameState.phase === "voting" ? (
        <Text style={styles.mutedText}>
          {t("impostor.vote.timeEnded")}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {localizeImpostorError(error, t)}
        </Text>
      ) : null}

      <PrimaryButton
        title={
          voteSent
            ? t("impostor.vote.sent")
            : t("impostor.vote.submit")
        }
        leftIcon={Vote}
        disabled={!canSubmit}
        onPress={submitVote}
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
    color: colors.pink,
  },
  noticePanel: {
    gap: spacing.md,
    borderColor: colors.pink,
  },
  noticeHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  resultPanel: {
    gap: spacing.sm,
    borderColor: colors.gold,
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
  optionsPanel: {
    gap: spacing.lg,
  },
  panelHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  sectionTitle: {
    ...typography.body,
    color: colors.text,
    flexShrink: 1,
  },
  options: {
    gap: spacing.md,
  },
  sentNotice: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  sentText: {
    ...typography.small,
    color: colors.green,
    flexShrink: 1,
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
