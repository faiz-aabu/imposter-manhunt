import { useEffect, useRef, useState } from "react";
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
  LanguageSelector,
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
import { useTranslation } from "../src/i18n/use-translation";
import { localizeSharedError } from "../src/i18n/shared-errors";
import { nicknameSchema, ROOM_EVENTS } from "@impostor/api";

export default function HomeRoute() {
  const router = useRouter();
  const t = useTranslation();
  const translationRef = useRef(t);
  translationRef.current = t;
  const [nickname, setNickname] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isConnected = useConnectionStore((state) => state.isConnected);
  const connectionStatus = useConnectionStore((state) => state.status);
  const connectionError = useConnectionStore(
    (state) => state.latestConnectionError,
  );
  const localizedConnectionError = localizeSharedError(connectionError, t);
  const localizedErrorMessage = localizeSharedError(errorMessage, t);
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
              ? translationRef.current("home.nicknameLoadError", {
                  message: error.message,
                })
              : translationRef.current("home.nicknameLoadFallback"),
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
              ? translationRef.current("home.nicknameSaveError", {
                  message: error.message,
                })
              : translationRef.current("home.nicknameSaveFallback"),
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
        t("home.nicknameInvalid"),
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
          : t("home.createRoomError"),
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
        <Text style={styles.eyebrow}>{t("home.brand")}</Text>
      </View>

      <Text style={styles.headline}>{t("home.title")}</Text>

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
          <Chip
            label={t("home.previewManhunt")}
            variant="gold"
            style={styles.mapChip}
          />
        </View>
      </HudPanel>

      <Text style={styles.tagline}>
        {t("home.tagline")}
      </Text>

      <LanguageSelector />

      <TextField
        autoCapitalize="words"
        label={t("home.nicknameLabel")}
        onChangeText={handleNicknameChange}
        placeholder={t("home.nicknamePlaceholder")}
        value={nickname}
        style={styles.nicknameField}
      />

      {!isConnected ? (
        <Text style={styles.connectionHint}>
          {localizedConnectionError ??
            (connectionStatus === "error"
              ? t("home.connectionError")
              : t("home.connecting"))}
        </Text>
      ) : null}
      {localizedErrorMessage ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {localizedErrorMessage}
        </Text>
      ) : null}

      <PrimaryButton
        title={t("home.createRoom")}
        onPress={handleCreateRoom}
        loading={isLoading}
        style={styles.createButton}
      />

      <PrimaryButton
        title={t("home.joinWithCode")}
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
