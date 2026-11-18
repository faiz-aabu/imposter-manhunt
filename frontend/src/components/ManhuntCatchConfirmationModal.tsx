import { ActivityIndicator, Modal, StyleSheet, Text, View } from "react-native";
import { Check, Target, X } from "lucide-react-native";
import type { CatchConfirmationRequestPayload } from "@impostor/api";
import { colors, radii, spacing, typography } from "../theme";
import { PrimaryButton } from "./PrimaryButton";

interface ManhuntCatchConfirmationModalProps {
  request: CatchConfirmationRequestPayload | null;
  busy: boolean;
  error: string | null;
  onAccept: () => void;
  onReject: () => void;
}

export function ManhuntCatchConfirmationModal({
  request,
  busy,
  error,
  onAccept,
  onReject,
}: ManhuntCatchConfirmationModalProps) {
  return (
    <Modal
      visible={request !== null}
      transparent
      animationType="fade"
      onRequestClose={() => undefined}
    >
      <View style={styles.backdrop}>
        <View accessibilityViewIsModal style={styles.card}>
          <Target color={colors.pinkMap} size={28} strokeWidth={2} />
          <Text style={styles.title}>Catch confirmation</Text>
          <Text style={styles.message}>
            {request?.hunterNickname ?? "A hunter"} says they caught you.
            {"\n"}Accept only if you agree this is accurate.
          </Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {busy ? (
            <View style={styles.progress}>
              <ActivityIndicator color={colors.teal} />
              <Text style={styles.progressText}>Sending your response...</Text>
            </View>
          ) : null}
          <PrimaryButton
            title="Accept catch"
            leftIcon={Check}
            variant="pink"
            disabled={busy}
            onPress={onAccept}
          />
          <PrimaryButton
            title="Reject catch"
            leftIcon={X}
            variant="secondary"
            disabled={busy}
            onPress={onReject}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: spacing.xl,
    backgroundColor: "rgba(0,0,0,0.78)",
  },
  card: {
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.xl,
    borderRadius: radii.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    backgroundColor: colors.panel,
  },
  title: {
    ...typography.body,
    color: colors.text,
  },
  message: {
    ...typography.small,
    color: colors.textMuted,
    textAlign: "center",
  },
  error: {
    ...typography.small,
    color: colors.pink,
    textAlign: "center",
  },
  progress: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  progressText: {
    ...typography.small,
    color: colors.textMuted,
  },
});
