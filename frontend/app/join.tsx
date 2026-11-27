import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { ArrowLeft, Users } from "lucide-react-native";
import {
  Chip,
  CodeInput,
  HudPanel,
  IconButton,
  PrimaryButton,
  Screen,
  TextField,
} from "../src/components";
import { getPublicRoom } from "../src/services/room-rest";
import { emitWithAcknowledgement } from "../src/services/socket-requests";
import { getSavedNickname } from "../src/services/player-session";
import { persistRoomEntry } from "../src/services/room-entry";
import { useRoomStore } from "../src/store/room-store";
import { colors, spacing, typography } from "../src/theme";
import { useTranslation } from "../src/i18n/use-translation";
import { localizeSharedError } from "../src/i18n/shared-errors";
import { nicknameSchema, roomCodeSchema, ROOM_EVENTS } from "@impostor/api";
import type { Room } from "@impostor/api";

const ROOM_LOOKUP_TIMEOUT_MS = 10_000;

type RoomLookup =
  | { status: "idle" }
  | { status: "loading"; code: string }
  | { status: "found"; code: string; room: Room }
  | { status: "error"; code: string; message: string };

export default function JoinRoute() {
  const router = useRouter();
  const t = useTranslation();
  const translationRef = useRef(t);
  translationRef.current = t;
  const [nickname, setNickname] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [lookup, setLookup] = useState<RoomLookup>({ status: "idle" });
  const [joinError, setJoinError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const setRoomSession = useRoomStore((state) => state.setSession);

  useEffect(() => {
    let active = true;
    getSavedNickname()
      .then((savedNickname) => {
        if (active && savedNickname !== null) {
          setNickname(savedNickname);
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setJoinError(
            error instanceof Error
              ? translationRef.current("join.nicknameLoadError", {
                  message: error.message,
                })
              : translationRef.current("join.nicknameFallback"),
          );
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const parsedCode = roomCodeSchema.safeParse(roomCode);
    if (!parsedCode.success) {
      setLookup({ status: "idle" });
      return;
    }

    const code = parsedCode.data;
    const controller = new AbortController();
    let lookupTimedOut = false;
    const timeout = setTimeout(() => {
      lookupTimedOut = true;
      controller.abort();
    }, ROOM_LOOKUP_TIMEOUT_MS);
    setJoinError(null);
    setLookup({ status: "loading", code });
    getPublicRoom(code, controller.signal)
      .then((room) => {
        if (!controller.signal.aborted) {
          setLookup({ status: "found", code, room });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted && !lookupTimedOut) {
          return;
        }
        setLookup({
          status: "error",
          code,
          message: lookupTimedOut
            ? translationRef.current("join.lookupTimeout")
            : error instanceof Error
              ? error.message
              : translationRef.current("join.lookupError"),
        });
      })
      .finally(() => clearTimeout(timeout));

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [roomCode]);

  const confirmedRoom =
    lookup.status === "found" && lookup.code === roomCode
      ? lookup.room
      : null;
  const isLookingUp =
    lookup.status === "loading" && lookup.code === roomCode;
  const lookupError =
    lookup.status === "error" && lookup.code === roomCode
      ? lookup.message
      : null;
  const localizedLookupError = localizeSharedError(lookupError, t);
  const localizedJoinError = localizeSharedError(joinError, t);
  const playerCount = confirmedRoom?.players.length ?? 0;
  const duplicateNickname = useMemo(
    () =>
      confirmedRoom?.players.some(
        (player) =>
          player.nickname.trim().toLocaleLowerCase() ===
          nickname.trim().toLocaleLowerCase(),
      ) ?? false,
    [confirmedRoom, nickname],
  );
  const isRoomFull =
    confirmedRoom !== null &&
    playerCount >= confirmedRoom.settings.maxPlayers;
  const hostName =
    confirmedRoom?.players.find(
      (player) => player.id === confirmedRoom.hostId,
    )?.nickname ?? t("join.hostFallback");

  const handleJoinRoom = async () => {
    if (!confirmedRoom) {
      return;
    }
    const parsedNickname = nicknameSchema.safeParse(nickname);
    if (!parsedNickname.success) {
      setJoinError(
        t("join.nicknameInvalid"),
      );
      return;
    }
    if (duplicateNickname) {
      setJoinError(t("join.nicknameAlreadyUsed"));
      return;
    }
    if (isRoomFull) {
      setJoinError(t("join.roomFull"));
      return;
    }

    setJoinError(null);
    setIsJoining(true);
    try {
      const response = await emitWithAcknowledgement({
        event: ROOM_EVENTS.JOIN,
        payload: {
          roomCode: confirmedRoom.code,
          nickname: parsedNickname.data,
        },
      });
      if (!response.ok) {
        setJoinError(response.error.message);
        return;
      }

      const notice = await persistRoomEntry(
        response.data,
        parsedNickname.data,
      );
      setRoomSession(response.data.room, response.data.playerId, notice);
      router.replace("/lobby");
    } catch (error) {
      setJoinError(
        error instanceof Error
          ? error.message
          : t("join.roomError"),
      );
    } finally {
      setIsJoining(false);
    }
  };

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <IconButton
        accessibilityLabel={t("join.backAccessibility")}
        icon={ArrowLeft}
        onPress={() => router.replace("/")}
        style={styles.backButton}
      />

      <Text style={styles.title}>{t("join.title")}</Text>

      <TextField
        autoCapitalize="words"
        label={t("join.nicknameLabel")}
        onChangeText={(value) => {
          setNickname(value);
          setJoinError(null);
        }}
        placeholder={t("join.nicknamePlaceholder")}
        value={nickname}
      />

      <View style={styles.codeSection}>
        <Text style={styles.sectionLabel}>{t("join.roomCode")}</Text>
        <CodeInput
          accessibilityLabelForIndex={(current, total) =>
            t("join.codeCharacter", { current, total })
          }
          value={roomCode}
          onChangeText={(value) => {
            setRoomCode(value);
            setJoinError(null);
          }}
        />
      </View>

      {isLookingUp ? (
        <View style={styles.lookupStatus}>
          <ActivityIndicator color={colors.teal} />
          <Text style={styles.mutedText}>{t("join.looking")}</Text>
        </View>
      ) : null}

      {confirmedRoom ? (
        <HudPanel highlightColor={colors.green} style={styles.roomPanel}>
          <View style={styles.roomHeader}>
            <View style={styles.statusDot} />
            <Text style={styles.roomFoundTitle}>{t("join.roomFound")}</Text>
            <Chip label={confirmedRoom.code} variant="teal" />
          </View>
          <Text style={styles.hostText}>
            {t("join.hostedBy", { name: hostName })}
          </Text>
          <View style={styles.playerCountRow}>
            <Users color={colors.textMuted} size={18} />
            <Text style={styles.playerCountText}>
              {t("join.playersInside", {
                players: playerCount,
                maximum: confirmedRoom.settings.maxPlayers,
              })}
            </Text>
          </View>
          {isRoomFull ? (
            <Text style={styles.error}>{t("join.roomFull")}</Text>
          ) : null}
          {duplicateNickname ? (
            <Text style={styles.error}>
              {t("join.duplicateNickname")}
            </Text>
          ) : null}
        </HudPanel>
      ) : null}

      {localizedLookupError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {localizedLookupError}
        </Text>
      ) : null}
      {localizedJoinError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {localizedJoinError}
        </Text>
      ) : null}

      <PrimaryButton
        title={t("join.joinRoom")}
        onPress={handleJoinRoom}
        disabled={!confirmedRoom || isRoomFull || duplicateNickname}
        loading={isJoining}
        style={styles.joinButton}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.xxl,
    gap: spacing.xl,
  },
  backButton: {
    marginBottom: spacing.xs,
  },
  title: {
    ...typography.title,
    color: colors.text,
  },
  codeSection: {
    gap: spacing.md,
  },
  sectionLabel: {
    ...typography.label,
    color: colors.textMuted,
  },
  lookupStatus: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
  },
  mutedText: {
    ...typography.small,
    color: colors.textMuted,
  },
  roomPanel: {
    gap: spacing.md,
  },
  roomHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.green,
  },
  roomFoundTitle: {
    ...typography.body,
    color: colors.text,
    flex: 1,
  },
  hostText: {
    ...typography.small,
    color: colors.textMuted,
  },
  playerCountRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  playerCountText: {
    ...typography.small,
    color: colors.text,
  },
  error: {
    ...typography.small,
    color: colors.pink,
  },
  joinButton: {
    marginTop: spacing.xs,
  },
});
