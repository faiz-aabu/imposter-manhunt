import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import {
  PrimaryButton,
  Screen,
  TextField,
} from "../src/components";
import {
  getMissingSupabaseAuthConfiguration,
  getSupabaseAuthConfig,
  isValidEmail,
  normalizeEmail,
} from "../src/services/supabase-auth-config";
import {
  sendEmailOtp,
  verifyEmailOtp,
} from "../src/services/supabase-auth-actions";
import { useAuthStore } from "../src/store/auth-store";
import { colors, spacing, typography } from "../src/theme";

const RESEND_COOLDOWN_SECONDS = 60;

export default function SignInRoute() {
  const router = useRouter();
  const authStatus = useAuthStore((state) => state.status);
  const refreshAuth = useAuthStore((state) => state.refresh);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resendSeconds, setResendSeconds] = useState(0);
  const submissionInFlight = useRef(false);
  const missingConfiguration = getMissingSupabaseAuthConfiguration();
  const invalidConfiguration =
    missingConfiguration.length === 0 &&
    getSupabaseAuthConfig() === null;

  useEffect(() => {
    if (authStatus === "signed-in") {
      router.replace("/account");
    }
  }, [authStatus, router]);

  useEffect(() => {
    if (resendSeconds <= 0) {
      return;
    }
    const timeout = setTimeout(
      () => setResendSeconds((seconds) => Math.max(0, seconds - 1)),
      1000,
    );
    return () => clearTimeout(timeout);
  }, [resendSeconds]);

  const requestCode = async () => {
    if (
      submissionInFlight.current ||
      (codeSent && resendSeconds > 0)
    ) {
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      setErrorMessage("Enter a valid email address.");
      return;
    }
    if (missingConfiguration.length > 0) {
      setErrorMessage(
        "Email sign-in is not configured. Required public Supabase configuration is missing.",
      );
      return;
    }

    submissionInFlight.current = true;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await sendEmailOtp(normalizedEmail);
      setEmail(normalizedEmail);
      setCode("");
      setCodeSent(true);
      setResendSeconds(RESEND_COOLDOWN_SECONDS);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not send a verification code. Check your connection and try again.",
      );
    } finally {
      submissionInFlight.current = false;
      setIsLoading(false);
    }
  };

  const verifyCode = async () => {
    if (submissionInFlight.current) {
      return;
    }

    const normalizedCode = code.trim();
    if (!/^\d{6}$/.test(normalizedCode)) {
      setErrorMessage("Enter the 6-digit verification code.");
      return;
    }

    submissionInFlight.current = true;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await verifyEmailOtp(normalizeEmail(email), normalizedCode);
      await refreshAuth();
      router.replace("/account");
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "The code is invalid or expired. Request a new code and try again.",
      );
    } finally {
      submissionInFlight.current = false;
      setIsLoading(false);
    }
  };

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <Text style={styles.title}>
        {codeSent ? "Enter verification code" : "Continue with email"}
      </Text>
      <Text style={styles.body}>
        {codeSent
          ? `A 6-digit code was sent to ${normalizeEmail(email)}.`
          : "Use a one-time email code. No password is required."}
      </Text>

      {!codeSent ? (
        <TextField
          autoCapitalize="none"
          keyboardType="email-address"
          label="Email"
          onChangeText={(value) => {
            setEmail(value);
            setErrorMessage(null);
          }}
          placeholder="you@example.com"
          value={email}
        />
      ) : (
        <TextField
          autoCapitalize="none"
          keyboardType="number-pad"
          label="Verification code"
          onChangeText={(value) => {
            setCode(value.replace(/[^0-9]/g, "").slice(0, 6));
            setErrorMessage(null);
          }}
          placeholder="123456"
          value={code}
        />
      )}

      {(missingConfiguration.length > 0 || invalidConfiguration) && !codeSent ? (
        <Text accessibilityRole="alert" style={styles.configurationWarning}>
          Email sign-in configuration is missing or invalid. The app will remain
          available for guest play.
        </Text>
      ) : null}

      {errorMessage ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorMessage}
        </Text>
      ) : null}

      <PrimaryButton
        title={codeSent ? "Verify code" : "Send verification code"}
        onPress={() => {
          void (codeSent ? verifyCode() : requestCode());
        }}
        loading={isLoading}
        disabled={
          (missingConfiguration.length > 0 || invalidConfiguration) &&
          !codeSent
        }
      />

      {codeSent ? (
        <PrimaryButton
          title={
            resendSeconds > 0
              ? `Resend code in ${resendSeconds}s`
              : "Resend code"
          }
          variant="secondary"
          onPress={() => {
            void requestCode();
          }}
          loading={isLoading}
          disabled={isLoading || resendSeconds > 0}
        />
      ) : null}

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
  body: {
    ...typography.body,
    color: colors.textMuted,
  },
  error: {
    ...typography.small,
    color: colors.pink,
  },
  configurationWarning: {
    ...typography.small,
    color: colors.gold,
  },
});