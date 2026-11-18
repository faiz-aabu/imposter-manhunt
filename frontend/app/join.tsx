import { useEffect, useMemo, useState } from "react";
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
              ? `Could not load the saved nickname: ${error.message}`
              : "Could not load the saved nickname.",
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
            ? "Room lookup timed out. Check your connection and try again."
            : error instanceof Error
              ? error.message
              : "Could not find that room. Check the code and try again.",
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
    )?.nickname ?? "Host";

  const handleJoinRoom = async () => {
    if (!confirmedRoom) {
      return;
    }
    const parsedNickname = nicknameSchema.safeParse(nickname);
    if (!parsedNickname.success) {
      setJoinError(
        parsedNickname.error.issues[0]?.message ?? "Enter a valid nickname.",
      );
      return;
    }
    if (duplicateNickname) {
      setJoinError("That nickname is already being used in this room.");
      return;
    }
    if (isRoomFull) {
      setJoinError("This room is full.");
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
          : "Could not join the room. Please try again.",
      );
    } finally {
      setIsJoining(false);
    }
  };

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <IconButton
        accessibilityLabel="Back to home"
        icon={ArrowLeft}
        onPress={() => router.replace("/")}
        style={styles.backButton}
      />

      <Text style={styles.title}>Join a room</Text>

      <TextField
        autoCapitalize="words"
        label="Your nickname"
        onChangeText={(value) => {
          setNickname(value);
          setJoinError(null);
        }}
        placeholder="Enter your name"
        value={nickname}
      />

      <View style={styles.codeSection}>
        <Text style={styles.sectionLabel}>Room code</Text>
        <CodeInput
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
          <Text style={styles.mutedText}>Looking for that room...</Text>
        </View>
      ) : null}

      {confirmedRoom ? (
        <HudPanel highlightColor={colors.green} style={styles.roomPanel}>
          <View style={styles.roomHeader}>
            <View style={styles.statusDot} />
            <Text style={styles.roomFoundTitle}>Room found</Text>
            <Chip label={confirmedRoom.code} variant="teal" />
          </View>
          <Text style={styles.hostText}>Hosted by {hostName}</Text>
          <View style={styles.playerCountRow}>
            <Users color={colors.textMuted} size={18} />
            <Text style={styles.playerCountText}>
              {playerCount} / {confirmedRoom.settings.maxPlayers} players inside
            </Text>
          </View>
          {isRoomFull ? (
            <Text style={styles.error}>This room is full.</Text>
          ) : null}
          {duplicateNickname ? (
            <Text style={styles.error}>
              That nickname is already being used in this room.
            </Text>
          ) : null}
        </HudPanel>
      ) : null}

      {lookupError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {lookupError}
        </Text>
      ) : null}
      {joinError ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {joinError}
        </Text>
      ) : null}

      <PrimaryButton
        title="Join room"
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
