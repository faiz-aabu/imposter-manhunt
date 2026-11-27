import {
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { Stack, usePathname, useRouter } from "expo-router";
import { useFonts } from "expo-font";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useClassicGameEvents } from "../src/hooks/use-classic-game-events";
import { colors, spacing, typography } from "../src/theme";
import { useSocketConnection } from "../src/hooks/use-socket-connection";
import { getReconnectSession } from "../src/services/player-session";
import { hasCompletedTutorial } from "../src/services/tutorial-progress";
import { useTranslation } from "../src/i18n/use-translation";
import { useLanguageStore } from "../src/services/language-preference";
import { useRoomStore } from "../src/store/room-store";
import { shouldShowFirstLaunchTutorial } from "../src/utils/tutorial";

const FONT_LOAD_TIMEOUT_MS = 10_000;

export default function RootLayout() {
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslation();
  const [fontsLoaded, fontError] = useFonts({
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  const [fontLoadTimedOut, setFontLoadTimedOut] = useState(false);

  useClassicGameEvents();
  useSocketConnection(true);

  useEffect(() => {
    void useLanguageStore.getState().hydrate();
  }, []);

  useEffect(() => {
    if (!fontsLoaded || pathname !== "/") {
      return;
    }

    let active = true;
    const checkTutorial = async () => {
      try {
        const [tutorialCompleted, reconnectSession] = await Promise.all([
          hasCompletedTutorial(),
          getReconnectSession(),
        ]);
        if (
          active &&
          shouldShowFirstLaunchTutorial(
            tutorialCompleted,
            reconnectSession !== null,
            useRoomStore.getState().room !== null,
          )
        ) {
          router.replace({
            pathname: "/tutorial",
            params: { returnTo: "/" },
          });
        }
      } catch (error) {
        if (active) {
          Alert.alert(
            t("tutorial.checkErrorTitle"),
            error instanceof Error
              ? error.message
              : t("tutorial.checkErrorFallback"),
          );
        }
      }
    };

    void checkTutorial();
    return () => {
      active = false;
    };
  }, [fontsLoaded, pathname, router, t]);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      return;
    }

    const timeout = setTimeout(
      () => setFontLoadTimedOut(true),
      FONT_LOAD_TIMEOUT_MS,
    );
    return () => clearTimeout(timeout);
  }, [fontError, fontsLoaded]);

  if (fontsLoaded) {
    return (
      <Stack>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="join" options={{ headerShown: false }} />
        <Stack.Screen name="lobby" options={{ headerShown: false }} />
        <Stack.Screen name="games" options={{ headerShown: false }} />
        <Stack.Screen name="tutorial" options={{ headerShown: false }} />
        <Stack.Screen
          name="imposter/settings"
          options={{ headerShown: false }}
        />
        <Stack.Screen name="imposter/role" options={{ headerShown: false }} />
        <Stack.Screen
          name="imposter/discussion"
          options={{ headerShown: false }}
        />
        <Stack.Screen name="imposter/vote" options={{ headerShown: false }} />
        <Stack.Screen
          name="imposter/reveal"
          options={{ headerShown: false }}
        />
        <Stack.Screen name="manhunt/map" options={{ headerShown: false }} />
        <Stack.Screen name="manhunt/mode" options={{ headerShown: false }} />
        <Stack.Screen name="manhunt/setup" options={{ headerShown: false }} />
        <Stack.Screen name="manhunt/countdown" options={{ headerShown: false }} />
        <Stack.Screen name="manhunt/results" options={{ headerShown: false }} />
        <Stack.Screen
          name="design-system-preview"
          options={{ headerShown: false }}
        />
      </Stack>
    );
  }

  if (fontError) {
    return (
      <FontStatusScreen
        title={t("shared.font.loadFailureTitle")}
        message={t("shared.font.loadFailureMessage", {
          detail: fontError.message,
        })}
      />
    );
  }

  if (fontLoadTimedOut) {
    return (
      <FontStatusScreen
        title={t("shared.font.timeoutTitle")}
        message={t("shared.font.timeoutMessage")}
      />
    );
  }

  return (
    <FontStatusScreen
      loading
      title="Impostor & Manhunt"
      message={t("shared.font.loading")}
    />
  );
}

function FontStatusScreen({
  title,
  message,
  loading = false,
}: {
  title: string;
  message: string;
  loading?: boolean;
}) {
  return (
    <View style={styles.statusScreen}>
      {loading ? <ActivityIndicator color={colors.teal} /> : null}
      <Text style={styles.statusTitle}>{title}</Text>
      <Text style={styles.statusMessage}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  statusScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    padding: spacing.xxl,
    backgroundColor: colors.bg,
  },
  statusTitle: {
    ...typography.fontStatusTitle,
    color: colors.text,
    textAlign: "center",
  },
  statusMessage: {
    ...typography.fontStatusMessage,
    color: colors.textMuted,
    textAlign: "center",
  },
});
