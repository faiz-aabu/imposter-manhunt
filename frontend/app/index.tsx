import { useEffect, useState } from "react";
import {
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { Diamond } from "lucide-react-native";
import {
  Chip,
  HudPanel,
  PrimaryButton,
  Screen,
  TextField,
} from "../src/components";
import { useConnectionStore } from "../src/store/connection-store";
import { useRoomStore } from "../src/store/room-store";
import {
  getSavedNickname,
  saveNickname,
} from "../src/services/player-session";
import { persistRoomEntry } from "../src/services/room-entry";
import { emitWithAcknowledgement } from "../src/services/socket-requests";
import { colors, radii, spacing, typography } from "../src/theme";
import { nicknameSchema, ROOM_EVENTS } from "@impostor/api";

export default function HomeRoute() {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isConnected = useConnectionStore((state) => state.isConnected);
  const connectionStatus = useConnectionStore((state) => state.status);
  const connectionError = useConnectionStore(
    (state) => state.latestConnectionError,
  );
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
          setErrorMessage(
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
    const savedValue = nickname.trim();
    if (!savedValue) {
      return;
    }

    let active = true;
    const timeout = setTimeout(() => {
      saveNickname(savedValue).catch((error: unknown) => {
        if (active) {
          setErrorMessage(
            error instanceof Error
              ? `Could not save the nickname: ${error.message}`
              : "Could not save the nickname.",
          );
        }
      });
    }, 350);

    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [nickname]);

  const handleCreateRoom = async () => {
    const parsedNickname = nicknameSchema.safeParse(nickname);
    if (!parsedNickname.success) {
      setErrorMessage(
        parsedNickname.error.issues[0]?.message ?? "Enter a valid nickname.",
      );
      return;
    }

    setErrorMessage(null);
    setIsLoading(true);
    try {
      const response = await emitWithAcknowledgement({
        event: ROOM_EVENTS.CREATE,
        payload: { nickname: parsedNickname.data },
      });
      if (!response.ok) {
        setErrorMessage(response.error.message);
        return;
      }

      const notice = await persistRoomEntry(
        response.data,
        parsedNickname.data,
      );
      setRoomSession(response.data.room, response.data.playerId, notice);
      router.replace("/lobby");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not create a room. Please try again.",
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleNicknameChange = (value: string) => {
    setNickname(value);
    setErrorMessage(null);
  };

  return (
    <Screen
      scrollable
      contentContainerStyle={styles.content}
    >
      <View style={styles.brandRow}>
        <View style={styles.brandIcon}>
          <Diamond color={colors.violet} size={24} strokeWidth={2.2} />
        </View>
        <Text style={styles.eyebrow}>Party games</Text>
      </View>

      <Text style={styles.headline}>Impostor &amp; Manhunt</Text>

      <HudPanel style={styles.mapPanel}>
        <View style={styles.mapPreview}>
          <View style={styles.mapRoadHorizontal} />
          <View style={styles.mapRoadVertical} />
          <View style={styles.mapPark} />
          <View style={styles.mapBoundary} />
          <View style={styles.mapPlayer}>
            <View style={styles.mapDiamond} />
          </View>
          <View style={styles.pinkDot} />
          <View style={styles.greenDot} />
          <Chip label="Manhunt" variant="gold" style={styles.mapChip} />
        </View>
      </HudPanel>

      <Text style={styles.tagline}>
        One room. Two ways to outsmart your friends.
      </Text>

      <TextField
        autoCapitalize="words"
        label="Your nickname"
        onChangeText={handleNicknameChange}
        placeholder="Enter your name"
        value={nickname}
        style={styles.nicknameField}
      />

      {!isConnected ? (
        <Text style={styles.connectionHint}>
          {connectionError ??
            (connectionStatus === "error"
              ? "Could not connect to the game server."
              : "Connecting to the game server...")}
        </Text>
      ) : null}
      {errorMessage ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorMessage}
        </Text>
      ) : null}

      <PrimaryButton
        title="Create a room"
        onPress={handleCreateRoom}
        loading={isLoading}
        style={styles.createButton}
      />

      <PrimaryButton
        title="Join with a code"
        variant="secondary"
        onPress={() => router.push("/join")}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.xxl,
    gap: spacing.xl,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  brandIcon: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.input,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
  },
  eyebrow: {
    ...typography.label,
    color: colors.textMuted,
  },
  headline: {
    ...typography.headline,
    color: colors.text,
  },
  mapPanel: {
    padding: spacing.sm,
  },
  mapPreview: {
    height: 176,
    overflow: "hidden",
    borderRadius: radii.input,
    backgroundColor: colors.mapBase,
  },
  mapRoadHorizontal: {
    position: "absolute",
    top: "48%",
    left: "-5%",
    width: "110%",
    height: 22,
    backgroundColor: colors.mapRoad,
    borderTopWidth: 2,
    borderBottomWidth: 2,
    borderColor: colors.mapRoadOutline,
    transform: [{ rotate: "-8deg" }],
  },
  mapRoadVertical: {
    position: "absolute",
    top: "-15%",
    left: "64%",
    width: 18,
    height: "130%",
    backgroundColor: colors.mapRoad,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderColor: colors.mapRoadOutline,
    transform: [{ rotate: "11deg" }],
  },
  mapPark: {
    position: "absolute",
    top: "12%",
    left: "10%",
    width: "30%",
    height: "30%",
    borderRadius: radii.panel,
    backgroundColor: colors.mapPark,
  },
  mapBoundary: {
    position: "absolute",
    top: "14%",
    left: "14%",
    width: "70%",
    height: "70%",
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: colors.mapBoundary,
    borderRadius: radii.panel,
    transform: [{ rotate: "-8deg" }],
  },
  mapPlayer: {
    position: "absolute",
    top: "32%",
    left: "45%",
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
    backgroundColor: colors.pinkMap,
    borderWidth: 3,
    borderColor: colors.text,
  },
  mapDiamond: {
    width: 14,
    height: 14,
    backgroundColor: colors.violet,
    transform: [{ rotate: "45deg" }],
  },
  pinkDot: {
    position: "absolute",
    top: "22%",
    right: "16%",
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.pink,
  },
  greenDot: {
    position: "absolute",
    bottom: "20%",
    left: "24%",
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.green,
  },
  mapChip: {
    position: "absolute",
    right: spacing.md,
    bottom: spacing.md,
  },
  tagline: {
    ...typography.body,
    color: colors.textMuted,
  },
  nicknameField: {
    marginTop: spacing.xs,
  },
  connectionHint: {
    ...typography.small,
    color: colors.textMuted,
    textAlign: "center",
  },
  error: {
    ...typography.small,
    color: colors.pink,
  },
  createButton: {
    marginTop: spacing.xs,
  },
});
