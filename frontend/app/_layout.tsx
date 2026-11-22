import {
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { Stack } from "expo-router";
import { useFonts } from "expo-font";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { useClassicGameEvents } from "../src/hooks/use-classic-game-events";
import { colors, spacing, typography } from "../src/theme";
import { useSocketConnection } from "../src/hooks/use-socket-connection";
import { useAuthStore } from "../src/store/auth-store";

const FONT_LOAD_TIMEOUT_MS = 10_000;

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  const [fontLoadTimedOut, setFontLoadTimedOut] = useState(false);

  useClassicGameEvents();
  useSocketConnection(true);
  const initializeAuth = useAuthStore((state) => state.initialize);
  const disposeAuth = useAuthStore((state) => state.dispose);

  useEffect(() => {
    void initializeAuth();
    return () => disposeAuth();
  }, [disposeAuth, initializeAuth]);

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
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        <Stack.Screen name="account" options={{ headerShown: false }} />
        <Stack.Screen name="games" options={{ headerShown: false }} />
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
        title="Inter could not be loaded"
        message={`${fontError.message} Restart the app after checking the bundled font assets.`}
      />
    );
  }

  if (fontLoadTimedOut) {
    return (
      <FontStatusScreen
        title="Fonts are taking longer than expected"
        message="Inter has not finished loading. Check the Expo logs and restart the app."
      />
    );
  }

  return (
    <FontStatusScreen
      loading
      title="Impostor & Manhunt"
      message="Loading the app fonts..."
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
