import { StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { colors, radii, spacing, typography } from "../theme";

export type ChipVariant =
  | "gold"
  | "teal"
  | "pink"
  | "blue"
  | "white"
  | "muted";

interface ChipProps {
  label: string;
  variant: ChipVariant;
  style?: StyleProp<ViewStyle>;
}

const variantStyles = {
  gold: { backgroundColor: colors.gold, color: colors.textOnAccent },
  teal: { backgroundColor: colors.teal, color: colors.textOnAccent },
  pink: { backgroundColor: colors.pink, color: colors.textOnAccent },
  blue: { backgroundColor: colors.blue, color: colors.textOnAccent },
  white: { backgroundColor: colors.text, color: colors.textOnAccent },
  muted: { backgroundColor: colors.panelBorder, color: colors.textMuted },
} satisfies Record<ChipVariant, { backgroundColor: string; color: string }>;

export function Chip({ label, variant, style }: ChipProps) {
  const variantStyle = variantStyles[variant];

  return (
    <View
      accessible
      accessibilityRole="text"
      style={[
        styles.chip,
        { backgroundColor: variantStyle.backgroundColor },
        style,
      ]}
    >
      <Text style={[styles.label, { color: variantStyle.color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    alignSelf: "flex-start",
    minHeight: 24,
    justifyContent: "center",
    paddingHorizontal: spacing.md,
    borderRadius: radii.chip,
  },
  label: {
    ...typography.chip,
  },
});

export type { ChipProps };
