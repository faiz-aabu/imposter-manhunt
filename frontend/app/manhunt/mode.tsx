import { useRouter } from "expo-router";
import { ArrowLeft } from "lucide-react-native";
import { StyleSheet, Text, View } from "react-native";
import { IconButton, PrimaryButton, Screen } from "../../src/components";
import { useRoomStore } from "../../src/store/room-store";
import { colors, spacing, typography } from "../../src/theme";
import { useState } from "react";
import { ROOM_EVENTS } from "@impostor/api";
import { emitWithAcknowledgement } from "../../src/services/socket-requests";
import { localizeManhuntError } from "../../src/i18n/manhunt-errors";
import { useTranslation } from "../../src/i18n/use-translation";

export default function ModeRoute() {
  const router = useRouter();
  const t = useTranslation();
  const room = useRoomStore((state) => state.room);
  const setRoom = useRoomStore((state) => state.setRoom);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const continueToSetup = async () => {
    if (!room || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await emitWithAcknowledgement({
        event: ROOM_EVENTS.UPDATE_SETTINGS,
        payload: {
          roomCode: room.code,
          settings: {
            gameMode: "manhunt",
            maxPlayers: room.settings.maxPlayers,
            isPrivate: room.settings.isPrivate,
          },
        },
      });
      if (!response.ok) throw new Error(response.error.message);
      setRoom(response.data.room);
      router.replace("/manhunt/setup");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Could not configure Manhunt.",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Screen contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <IconButton
          icon={ArrowLeft}
          accessibilityLabel={t("manhunt.common.back")}
          onPress={() => router.back()}
        />
      </View>
      <Text style={styles.title}>{t("manhunt.mode.title")}</Text>
      <Text style={styles.subtitle}>
        {t("manhunt.mode.description")}
      </Text>
      <PrimaryButton
        title={t("manhunt.mode.continue")}
        loading={isSubmitting}
        disabled={!room || isSubmitting}
        onPress={() => void continueToSetup()}
      />
      {error ? (
        <Text style={styles.errorText}>
          {localizeManhuntError(error, t) ?? error}
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.xxl,
    gap: spacing.lg,
  },
  header: {
    alignItems: "flex-start",
  },
  title: {
    ...typography.title,
    color: colors.text,
  },
  subtitle: {
    ...typography.body,
    color: colors.textMuted,
  },
  errorText: {
    ...typography.small,
    color: colors.pink,
  },
});
