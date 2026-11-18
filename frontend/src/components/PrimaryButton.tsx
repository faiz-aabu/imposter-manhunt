import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { colors, radii, spacing, typography } from "../theme";

export type PrimaryButtonVariant =
  | "teal"
  | "pink"
  | "gold"
  | "green"
  | "secondary";

interface PrimaryButtonProps {
  title: string;
  onPress: () => void;
  variant?: PrimaryButtonVariant;
  leftIcon?: LucideIcon;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

const variantStyles = {
  teal: { backgroundColor: colors.teal, borderColor: colors.teal },
  pink: { backgroundColor: colors.pink, borderColor: colors.pink },
  gold: { backgroundColor: colors.gold, borderColor: colors.gold },
  green: { backgroundColor: colors.green, borderColor: colors.green },
  secondary: {
    backgroundColor: colors.panel,
    borderColor: colors.panelBorder,
  },
} satisfies Record<PrimaryButtonVariant, ViewStyle>;

export function PrimaryButton({
  title,
  onPress,
  variant = "teal",
  leftIcon: Icon,
  disabled = false,
  loading = false,
  accessibilityLabel,
  style,
}: PrimaryButtonProps) {
  const isDisabled = disabled || loading;
  const foreground =
    variant === "secondary" ? colors.text : colors.textOnAccent;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variantStyles[variant],
        isDisabled ? styles.disabled : null,
        pressed && !isDisabled ? styles.pressed : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={foreground} />
      ) : (
        <View style={styles.content}>
          {Icon ? (
            <Icon color={foreground} size={20} strokeWidth={2} />
          ) : null}
          <Text style={[styles.title, { color: foreground }]}>{title}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: "100%",
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.button,
    borderWidth: 1,
    paddingHorizontal: spacing.xl,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
  },
  title: {
    ...typography.button,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.82,
  },
});
