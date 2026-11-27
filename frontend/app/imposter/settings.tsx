import { useEffect, useState } from "react";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { ArrowLeft, Minus, Play, Plus, Timer, Users } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  DEFAULT_DISCUSSION_DURATION_SECONDS,
  DEFAULT_IMPOSTOR_COUNT,
  DEFAULT_VOTING_DURATION_SECONDS,
  GAME_EVENTS,
  MAX_DISCUSSION_DURATION_SECONDS,
  MAX_VOTING_DURATION_SECONDS,
  MIN_CLASSIC_IMPOSTOR_PLAYERS,
  MIN_DISCUSSION_DURATION_SECONDS,
  MIN_VOTING_DURATION_SECONDS,
  ROOM_EVENTS,
  DEFAULT_WORD_IMPOSTOR_CATEGORY,
  DEFAULT_WORD_IMPOSTOR_COUNT,
  MIN_WORD_IMPOSTOR_PLAYERS,
  WORD_IMPOSTOR_CATEGORIES,
  classicImpostorSettingsSchema,
  wordImpostorSettingsSchema,
} from "@impostor/api";
import type {
  ClassicImpostorSettings,
  RoomUpdatePayload,
  WordCategory,
  WordImpostorSettings,
} from "@impostor/api";
import {
  Chip,
  HudPanel,
  IconButton,
  PrimaryButton,
  Screen,
  TopHudBar,
} from "../../src/components";
import { emitWithAcknowledgement } from "../../src/services/socket-requests";
import { getSocketClient } from "../../src/services/socket-client";
import { useClassicGameStore } from "../../src/store/classic-game-store";
import { useConnectionStore } from "../../src/store/connection-store";
import { useRoomStore } from "../../src/store/room-store";
import { useWordGameStore } from "../../src/store/word-game-store";
import { useTranslation } from "../../src/i18n/use-translation";
import { localizeImpostorError } from "../../src/i18n/impostor-errors";
import type { TranslationKey } from "../../src/i18n/locales";
import { colors, radii, spacing, typography } from "../../src/theme";
import {
  canStartClassicImpostorGame,
  clampClassicImpostorCount,
  getClassicImpostorCountStepperMaximum,
  getMaximumClassicImpostorCount,
} from "../../src/utils/classic-impostor-player-limit";

const INITIAL_SETTINGS: ClassicImpostorSettings = {
  impostorCount: DEFAULT_IMPOSTOR_COUNT,
  discussionDurationSeconds: DEFAULT_DISCUSSION_DURATION_SECONDS,
  votingDurationSeconds: DEFAULT_VOTING_DURATION_SECONDS,
};

export default function ImpostorSettingsRoute() {
  const router = useRouter();
  const t = useTranslation();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const room = useRoomStore((state) => state.room);
  const playerId = useRoomStore((state) => state.playerId);
  const setRoom = useRoomStore((state) => state.setRoom);
  const connectionStatus = useConnectionStore((state) => state.status);
  const connectionError = useConnectionStore(
    (state) => state.latestConnectionError,
  );
  const resetGame = useClassicGameStore((state) => state.reset);
  const [settings, setSettings] =
    useState<ClassicImpostorSettings>(
      () => room?.settings.classicImpostor ?? INITIAL_SETTINGS,
    );
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const savedSettings = room?.settings.classicImpostor;
    setSettings({
      impostorCount:
        savedSettings?.impostorCount ?? INITIAL_SETTINGS.impostorCount,
      discussionDurationSeconds:
        savedSettings?.discussionDurationSeconds ??
        INITIAL_SETTINGS.discussionDurationSeconds,
      votingDurationSeconds:
        savedSettings?.votingDurationSeconds ??
        INITIAL_SETTINGS.votingDurationSeconds,
    });
  }, [
    room?.code,
    room?.settings.classicImpostor?.impostorCount,
    room?.settings.classicImpostor?.discussionDurationSeconds,
    room?.settings.classicImpostor?.votingDurationSeconds,
  ]);

  useEffect(() => {
    if (!room?.code || mode === "impostor-word") {
      return;
    }

    const roomCode = room.code;
    const socket = getSocketClient();
    const roomUpdated = (payload: RoomUpdatePayload) => {
      if (payload.room.code === roomCode) {
        setRoom(payload.room);
      }
    };

    socket.on(ROOM_EVENTS.UPDATE, roomUpdated);
    return () => {
      socket.off(ROOM_EVENTS.UPDATE, roomUpdated);
    };
  }, [mode, room?.code, setRoom]);

  const playerCount = room?.players.length ?? 0;
  useEffect(() => {
    if (mode === "impostor-word") {
      return;
    }
    setSettings((current) => {
      const impostorCount = clampClassicImpostorCount(
        current.impostorCount,
        playerCount,
      );
      return impostorCount === current.impostorCount
        ? current
        : { ...current, impostorCount };
    });
  }, [mode, playerCount]);

  if (!room || !playerId) {
    return <Redirect href="/lobby" />;
  }

  const isHost = room.hostId === playerId;
  const isClassicMode = mode === undefined || mode === "impostor-classic";
  const isWordMode = mode === "impostor-word";
  if (!isHost || (!isClassicMode && !isWordMode)) {
    return (
      <Screen>
        <View style={styles.centered}>
          <IconButton
            accessibilityLabel={t("impostor.setup.backToGames")}
            icon={ArrowLeft}
            onPress={() => router.replace("/games")}
          />
          <Text style={styles.title}>
            {isHost
              ? t("impostor.setup.unsupportedTitle")
              : t("impostor.setup.hostOnly")}
          </Text>
          <Text style={styles.mutedText}>
            {isHost
              ? t("impostor.setup.unsupportedDescription")
              : t("impostor.setup.hostOnlyDescription")}
          </Text>
          <PrimaryButton
            title={t("impostor.setup.backToGames")}
            variant="secondary"
            onPress={() => router.replace("/games")}
          />
        </View>
      </Screen>
    );
  }
  if (isWordMode) {
    return (
      <WordImpostorSettingsScreen
        room={room}
        playerId={playerId}
        connectionStatus={connectionStatus}
        connectionError={connectionError}
      />
    );
  }
  const connectedPlayers = room.players.filter(
    (player) => player.connectionStatus === "connected",
  ).length;
  const allPlayersConnected = connectedPlayers === room.players.length;
  const maximumImpostors = getMaximumClassicImpostorCount(room.players.length);
  const stepperImpostorMaximum = getClassicImpostorCountStepperMaximum(
    room.players.length,
  );
  const settingsAreValid =
    classicImpostorSettingsSchema.safeParse(settings).success;
  const canStart = canStartClassicImpostorGame({
    isHost,
    isConnected: connectionStatus === "connected",
    isWaiting: room.gameStatus === "waiting",
    playerCount: room.players.length,
    minimumPlayerCount: MIN_CLASSIC_IMPOSTOR_PLAYERS,
    allPlayersConnected,
    settingsAreValid,
    impostorCount: settings.impostorCount,
  });

  const adjustSetting = (
    key: keyof ClassicImpostorSettings,
    amount: number,
    minimum: number,
    maximum: number,
  ) => {
    setSettings((current) => ({
      ...current,
      [key]:
        key === "impostorCount"
          ? clampClassicImpostorCount(
              current.impostorCount + amount,
              room.players.length,
            )
          : Math.min(maximum, Math.max(minimum, current[key] + amount)),
    }));
    setError(null);
  };

  const startClassicGame = async () => {
    if (isStarting || !canStart) {
      return;
    }
    setIsStarting(true);
    setError(null);

    try {
      const update = await emitWithAcknowledgement({
        event: ROOM_EVENTS.UPDATE_SETTINGS,
        payload: {
          roomCode: room.code,
          settings: {
            gameMode: "impostor-classic",
            maxPlayers: room.settings.maxPlayers,
            isPrivate: room.settings.isPrivate,
            classicImpostor: settings,
          },
        },
      });
      if (!update.ok) {
        throw new Error(update.error.message);
      }
      setRoom(update.data.room);

      resetGame();
      const started = await emitWithAcknowledgement({
        event: GAME_EVENTS.START_GAME,
        payload: { roomCode: room.code },
      });
      if (!started.ok) {
        throw new Error(started.error.message);
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The game could not be started.",
      );
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <IconButton
          accessibilityLabel={t("impostor.setup.backToGames")}
          icon={ArrowLeft}
          onPress={() => router.back()}
        />
        <Chip label={t("impostor.mode.classic")} variant="teal" />
      </View>

      <TopHudBar
        leftLabel={t("common.roomCode")}
        leftValue={room.code}
        rightLabel={t("common.players")}
        rightValue={`${room.players.length} / ${room.settings.maxPlayers}`}
        leftValueStyle={typography.roomCode}
      />

      <View style={styles.intro}>
        <Text style={styles.title}>{t("impostor.setup.classicTitle")}</Text>
        <Text style={styles.mutedText}>
          {t("impostor.setup.classicDescription")}
        </Text>
      </View>

      <HudPanel style={styles.settingsPanel}>
        <Stepper
          icon={Users}
          label={t("impostor.setup.impostors")}
          t={t}
          value={`${settings.impostorCount}`}
          onDecrease={() =>
            adjustSetting(
              "impostorCount",
              -1,
              1,
              stepperImpostorMaximum,
            )
          }
          onIncrease={() =>
            adjustSetting(
              "impostorCount",
              1,
              1,
              stepperImpostorMaximum,
            )
          }
          decreaseDisabled={settings.impostorCount <= 1}
          increaseDisabled={
            settings.impostorCount >= stepperImpostorMaximum
          }
        />
        <View style={styles.divider} />
        <Stepper
          icon={Timer}
          label={t("impostor.setup.discussion")}
          value={formatDuration(settings.discussionDurationSeconds, t)}
          t={t}
          onDecrease={() =>
            adjustSetting(
              "discussionDurationSeconds",
              -30,
              MIN_DISCUSSION_DURATION_SECONDS,
              MAX_DISCUSSION_DURATION_SECONDS,
            )
          }
          onIncrease={() =>
            adjustSetting(
              "discussionDurationSeconds",
              30,
              MIN_DISCUSSION_DURATION_SECONDS,
              MAX_DISCUSSION_DURATION_SECONDS,
            )
          }
          decreaseDisabled={
            settings.discussionDurationSeconds <=
            MIN_DISCUSSION_DURATION_SECONDS
          }
          increaseDisabled={
            settings.discussionDurationSeconds >=
            MAX_DISCUSSION_DURATION_SECONDS
          }
        />
        <View style={styles.divider} />
        <Stepper
          icon={Timer}
          label={t("impostor.setup.voting")}
          value={formatDuration(settings.votingDurationSeconds, t)}
          t={t}
          onDecrease={() =>
            adjustSetting(
              "votingDurationSeconds",
              -10,
              MIN_VOTING_DURATION_SECONDS,
              MAX_VOTING_DURATION_SECONDS,
            )
          }
          onIncrease={() =>
            adjustSetting(
              "votingDurationSeconds",
              10,
              MIN_VOTING_DURATION_SECONDS,
              MAX_VOTING_DURATION_SECONDS,
            )
          }
          decreaseDisabled={
            settings.votingDurationSeconds <= MIN_VOTING_DURATION_SECONDS
          }
          increaseDisabled={
            settings.votingDurationSeconds >= MAX_VOTING_DURATION_SECONDS
          }
        />
      </HudPanel>

      {room.players.length < MIN_CLASSIC_IMPOSTOR_PLAYERS ? (
        <Text style={styles.warning}>
          {t("impostor.setup.minimumPlayers", {
            count: MIN_CLASSIC_IMPOSTOR_PLAYERS,
          })}
        </Text>
      ) : settings.impostorCount > maximumImpostors ? (
        <Text style={styles.warning}>
          {t(
            maximumImpostors === 1
              ? "impostor.setup.impostorLimitOne"
              : "impostor.setup.impostorLimitMany",
            { count: maximumImpostors, players: room.players.length },
          )}
        </Text>
      ) : !allPlayersConnected ? (
        <Text style={styles.warning}>
          {t("impostor.setup.waitReconnect")}
        </Text>
      ) : null}
      {connectionStatus !== "connected" ? (
        <Text style={styles.warning}>
          {connectionStatus === "reconnecting"
            ? t("impostor.setup.reconnecting")
            : connectionError
              ? localizeImpostorError(connectionError, t)
              : t("impostor.setup.connectToContinue")}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {localizeImpostorError(error, t)}
        </Text>
      ) : null}

      <PrimaryButton
        title={t("impostor.setup.start")}
        leftIcon={Play}
        loading={isStarting}
        disabled={!canStart}
        onPress={() => void startClassicGame()}
      />
      <PrimaryButton
        title={t("impostor.setup.backToGames")}
        variant="secondary"
        onPress={() => router.replace("/games")}
      />
    </Screen>
  );
}

function WordImpostorSettingsScreen({
  room,
  playerId,
  connectionStatus,
  connectionError,
}: {
  room: NonNullable<ReturnType<typeof useRoomStore.getState>["room"]>;
  playerId: NonNullable<ReturnType<typeof useRoomStore.getState>["playerId"]>;
  connectionStatus: ReturnType<typeof useConnectionStore.getState>["status"];
  connectionError: string | null;
}) {
  const router = useRouter();
  const t = useTranslation();
  const setRoom = useRoomStore((state) => state.setRoom);
  const resetClassicGame = useClassicGameStore((state) => state.reset);
  const resetWordGame = useWordGameStore((state) => state.reset);
  const [settings, setSettings] = useState<WordImpostorSettings>(() => ({
    category:
      room.settings.wordImpostor?.category ??
      DEFAULT_WORD_IMPOSTOR_CATEGORY,
    impostorCount:
      room.settings.wordImpostor?.impostorCount ??
      DEFAULT_WORD_IMPOSTOR_COUNT,
    discussionDurationSeconds:
      room.settings.wordImpostor?.discussionDurationSeconds ??
      DEFAULT_DISCUSSION_DURATION_SECONDS,
    votingDurationSeconds:
      room.settings.wordImpostor?.votingDurationSeconds ??
      DEFAULT_VOTING_DURATION_SECONDS,
  }));
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const savedSettings = room.settings.wordImpostor;
    setSettings({
      category:
        savedSettings?.category ?? DEFAULT_WORD_IMPOSTOR_CATEGORY,
      impostorCount:
        savedSettings?.impostorCount ?? DEFAULT_WORD_IMPOSTOR_COUNT,
      discussionDurationSeconds:
        savedSettings?.discussionDurationSeconds ??
        DEFAULT_DISCUSSION_DURATION_SECONDS,
      votingDurationSeconds:
        savedSettings?.votingDurationSeconds ??
        DEFAULT_VOTING_DURATION_SECONDS,
    });
  }, [room.code, room.settings.wordImpostor]);

  const connectedPlayers = room.players.filter(
    (player) => player.connectionStatus === "connected",
  ).length;
  const allPlayersConnected = connectedPlayers === room.players.length;
  const serverImpostorMaximum = Math.floor(
    (room.players.length - 1) / 2,
  );
  const stepperImpostorMaximum = Math.max(1, serverImpostorMaximum);
  const settingsAreValid = wordImpostorSettingsSchema.safeParse(settings).success;
  const canStart =
    room.hostId === playerId &&
    connectionStatus === "connected" &&
    room.gameStatus === "waiting" &&
    room.players.length >= MIN_WORD_IMPOSTOR_PLAYERS &&
    allPlayersConnected &&
    settingsAreValid &&
    settings.impostorCount <= serverImpostorMaximum;

  const adjustSetting = (
    key: "impostorCount" | "discussionDurationSeconds" | "votingDurationSeconds",
    amount: number,
    minimum: number,
    maximum: number,
  ) => {
    setSettings((current) => ({
      ...current,
      [key]: Math.min(maximum, Math.max(minimum, current[key] + amount)),
    }));
    setError(null);
  };

  const selectCategory = (category: WordCategory) => {
    setSettings((current) => ({ ...current, category }));
    setError(null);
  };

  const startWordGame = async () => {
    if (isStarting || !canStart) {
      return;
    }
    const parsedSettings = wordImpostorSettingsSchema.safeParse(settings);
    if (!parsedSettings.success) {
      setError("Choose valid Word Impostor settings before starting.");
      return;
    }

    setIsStarting(true);
    setError(null);
    try {
      const update = await emitWithAcknowledgement({
        event: ROOM_EVENTS.UPDATE_SETTINGS,
        payload: {
          roomCode: room.code,
          settings: {
            gameMode: "impostor-word",
            maxPlayers: room.settings.maxPlayers,
            isPrivate: room.settings.isPrivate,
            wordImpostor: parsedSettings.data,
          },
        },
      });
      if (!update.ok) {
        throw new Error(update.error.message);
      }
      setRoom(update.data.room);

      resetClassicGame();
      resetWordGame();
      const started = await emitWithAcknowledgement({
        event: GAME_EVENTS.START_GAME,
        payload: { roomCode: room.code },
      });
      if (!started.ok) {
        throw new Error(started.error.message);
      }
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "The game could not be started.",
      );
    } finally {
      setIsStarting(false);
    }
  };

  if (room.hostId !== playerId) {
    return (
      <Screen>
        <View style={styles.centered}>
          <Text style={styles.title}>{t("impostor.setup.hostOnly")}</Text>
          <Text style={styles.mutedText}>
            {t("impostor.setup.hostOnlyDescription")}
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
      <View style={styles.header}>
        <IconButton
          accessibilityLabel={t("impostor.setup.backToGames")}
          icon={ArrowLeft}
          onPress={() => router.back()}
        />
        <Chip label={t("impostor.mode.word")} variant="teal" />
      </View>

      <TopHudBar
        leftLabel={t("common.roomCode")}
        leftValue={room.code}
        rightLabel={t("common.players")}
        rightValue={`${room.players.length} / ${room.settings.maxPlayers}`}
        leftValueStyle={typography.roomCode}
      />

      <View style={styles.intro}>
        <Text style={styles.title}>{t("impostor.setup.wordTitle")}</Text>
        <Text style={styles.mutedText}>
          {t("impostor.setup.wordDescription")}
        </Text>
      </View>

      <HudPanel style={styles.settingsPanel}>
        <Text style={styles.stepperText}>
          {t("impostor.setup.category")}
        </Text>
        <View style={styles.categoryGrid}>
          {WORD_IMPOSTOR_CATEGORIES.map((category) => (
            <Pressable
              key={category}
              accessibilityRole="button"
              accessibilityLabel={`${t("impostor.setup.category")} ${formatCategory(category, t)}`}
              accessibilityState={{ selected: settings.category === category }}
              onPress={() => selectCategory(category)}
              style={[
                styles.categoryOption,
                settings.category === category
                  ? styles.selectedCategory
                  : null,
              ]}
            >
              <Text
                style={[
                  styles.categoryLabel,
                  settings.category === category
                    ? styles.selectedCategoryLabel
                    : null,
                ]}
              >
                {formatCategory(category, t)}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.divider} />
        <Stepper
          icon={Users}
          label={t("impostor.setup.impostors")}
          t={t}
          value={`${settings.impostorCount}`}
          onDecrease={() =>
            adjustSetting(
              "impostorCount",
              -1,
              1,
              stepperImpostorMaximum,
            )
          }
          onIncrease={() =>
            adjustSetting(
              "impostorCount",
              1,
              1,
              stepperImpostorMaximum,
            )
          }
          decreaseDisabled={settings.impostorCount <= 1}
          increaseDisabled={
            settings.impostorCount >= stepperImpostorMaximum
          }
        />
        <View style={styles.divider} />
        <Stepper
          icon={Timer}
          label={t("impostor.setup.discussion")}
          value={formatDuration(settings.discussionDurationSeconds, t)}
          t={t}
          onDecrease={() =>
            adjustSetting(
              "discussionDurationSeconds",
              -30,
              MIN_DISCUSSION_DURATION_SECONDS,
              MAX_DISCUSSION_DURATION_SECONDS,
            )
          }
          onIncrease={() =>
            adjustSetting(
              "discussionDurationSeconds",
              30,
              MIN_DISCUSSION_DURATION_SECONDS,
              MAX_DISCUSSION_DURATION_SECONDS,
            )
          }
          decreaseDisabled={
            settings.discussionDurationSeconds <=
            MIN_DISCUSSION_DURATION_SECONDS
          }
          increaseDisabled={
            settings.discussionDurationSeconds >=
            MAX_DISCUSSION_DURATION_SECONDS
          }
        />
        <View style={styles.divider} />
        <Stepper
          icon={Timer}
          label={t("impostor.setup.voting")}
          value={formatDuration(settings.votingDurationSeconds, t)}
          t={t}
          onDecrease={() =>
            adjustSetting(
              "votingDurationSeconds",
              -10,
              MIN_VOTING_DURATION_SECONDS,
              MAX_VOTING_DURATION_SECONDS,
            )
          }
          onIncrease={() =>
            adjustSetting(
              "votingDurationSeconds",
              10,
              MIN_VOTING_DURATION_SECONDS,
              MAX_VOTING_DURATION_SECONDS,
            )
          }
          decreaseDisabled={
            settings.votingDurationSeconds <= MIN_VOTING_DURATION_SECONDS
          }
          increaseDisabled={
            settings.votingDurationSeconds >=
            MAX_VOTING_DURATION_SECONDS
          }
        />
      </HudPanel>

      {room.players.length < MIN_WORD_IMPOSTOR_PLAYERS ? (
        <Text style={styles.warning}>
          {t("impostor.setup.minimumPlayers", {
            count: MIN_WORD_IMPOSTOR_PLAYERS,
          })}
        </Text>
      ) : settings.impostorCount > serverImpostorMaximum ? (
        <Text style={styles.warning}>
          {t("impostor.setup.reduceImpostors", {
            count: serverImpostorMaximum,
          })}
        </Text>
      ) : !allPlayersConnected ? (
        <Text style={styles.warning}>
          {t("impostor.setup.waitReconnect")}
        </Text>
      ) : null}
      {connectionStatus !== "connected" ? (
        <Text style={styles.warning}>
          {connectionStatus === "reconnecting"
            ? t("impostor.setup.reconnecting")
            : connectionError
              ? localizeImpostorError(connectionError, t)
              : t("impostor.setup.connectToContinue")}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {localizeImpostorError(error, t)}
        </Text>
      ) : null}

      <PrimaryButton
        title={t("impostor.setup.start")}
        leftIcon={Play}
        loading={isStarting}
        disabled={!canStart}
        onPress={() => void startWordGame()}
      />
      <PrimaryButton
        title={t("impostor.setup.backToGames")}
        variant="secondary"
        onPress={() => router.replace("/games")}
      />
    </Screen>
  );
}

interface StepperProps {
  icon: LucideIcon;
  label: string;
  value: string;
  t: ReturnType<typeof useTranslation>;
  onDecrease: () => void;
  onIncrease: () => void;
  decreaseDisabled: boolean;
  increaseDisabled: boolean;
}

function Stepper({
  icon: Icon,
  label,
  value,
  t,
  onDecrease,
  onIncrease,
  decreaseDisabled,
  increaseDisabled,
}: StepperProps) {
  return (
    <View style={styles.stepper}>
      <View style={styles.stepperLabel}>
        <Icon color={colors.teal} size={20} strokeWidth={2} />
        <Text style={styles.stepperText}>{label}</Text>
      </View>
      <View style={styles.stepperControls}>
        <StepButton
          icon={Minus}
          label={t("impostor.setup.decrease", { setting: label })}
          disabled={decreaseDisabled}
          onPress={onDecrease}
        />
        <Text style={styles.stepperValue}>{value}</Text>
        <StepButton
          icon={Plus}
          label={t("impostor.setup.increase", { setting: label })}
          disabled={increaseDisabled}
          onPress={onIncrease}
        />
      </View>
    </View>
  );
}

function StepButton({
  icon: Icon,
  label,
  disabled,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.stepButton, disabled ? styles.disabled : null]}
    >
      <Icon color={disabled ? colors.textMuted : colors.text} size={18} />
    </Pressable>
  );
}

function formatDuration(
  seconds: number,
  t: ReturnType<typeof useTranslation>,
): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0
    ? t("impostor.setup.durationMinutes", { minutes })
    : t("impostor.setup.durationMinutesSeconds", {
        minutes,
        seconds: String(remainder).padStart(2, "0"),
      });
}

function formatCategory(
  category: WordCategory,
  t: ReturnType<typeof useTranslation>,
): string {
  const categoryKeys: Record<WordCategory, TranslationKey> = {
    animals: "impostor.setup.category.animals",
    food: "impostor.setup.category.food",
    places: "impostor.setup.category.places",
    objects: "impostor.setup.category.objects",
  };
  return t(categoryKeys[category]);
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.xxl,
    gap: spacing.xl,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  intro: {
    gap: spacing.sm,
  },
  title: {
    ...typography.title,
    color: colors.text,
  },
  mutedText: {
    ...typography.small,
    color: colors.textMuted,
  },
  settingsPanel: {
    gap: spacing.lg,
  },
  categoryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  categoryOption: {
    minHeight: 44,
    minWidth: "47%",
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    backgroundColor: colors.panelRaised,
  },
  selectedCategory: {
    borderColor: colors.teal,
    backgroundColor: colors.panel,
  },
  categoryLabel: {
    ...typography.small,
    color: colors.textMuted,
  },
  selectedCategoryLabel: {
    color: colors.teal,
  },
  stepper: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  stepperLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  stepperText: {
    ...typography.body,
    color: colors.text,
  },
  stepperControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  stepperValue: {
    ...typography.body,
    color: colors.teal,
    minWidth: 48,
    textAlign: "center",
  },
  stepButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.avatar,
    backgroundColor: colors.panelRaised,
    borderWidth: 1,
    borderColor: colors.panelBorder,
  },
  disabled: {
    opacity: 0.45,
  },
  divider: {
    height: 1,
    backgroundColor: colors.panelDivider,
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
