import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import {
  PrimaryButton,
  Screen,
} from "../src/components";
import { signOutAuth } from "../src/services/supabase-auth-actions";
import { useAuthStore } from "../src/store/auth-store";
import { colors, spacing, typography } from "../src/theme";

export default function AccountRoute() {
  const router = useRouter();
  const email = useAuthStore((state) => state.email);
  const authStatus = useAuthStore((state) => state.status);
  const clearAuth = useAuthStore((state) => state.clear);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (authStatus === "signed-out") {
      router.replace("/sign-in");
    }
  }, [authStatus, router]);

  if (authStatus === "loading") {
    return (
      <Screen>
        <ActivityIndicator color={colors.teal} />
        <Text style={styles.title}>Loading account...</Text>
      </Screen>
    );
  }

  const signOut = async () => {
    setIsSigningOut(true);
    setErrorMessage(null);
    try {
      await signOutAuth();
      clearAuth();
      router.replace("/");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not sign out. Try again.",
      );
    } finally {
      setIsSigningOut(false);
    }
  };

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <Text style={styles.title}>Account</Text>
      <Text style={styles.label}>Signed in with email</Text>
      <Text style={styles.email}>{email ?? "Unknown email"}</Text>

      {errorMessage ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorMessage}
        </Text>
      ) : null}

      <PrimaryButton
        title="Sign Out"
        variant="pink"
        onPress={() => {
          void signOut();
        }}
        loading={isSigningOut}
      />
      <PrimaryButton
        title="Back to guest play"
        variant="secondary"
        onPress={() => router.replace("/")}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingTop: spacing.xxl,
    gap: spacing.xl,
  },
  title: {
    ...typography.title,
    color: colors.text,
  },
  label: {
    ...typography.label,
    color: colors.textMuted,
  },
  email: {
    ...typography.body,
    color: colors.text,
  },
  error: {
    ...typography.small,
    color: colors.pink,
  },
});