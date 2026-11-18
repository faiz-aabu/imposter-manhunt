import { StyleSheet, Text, View } from "react-native";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import { colors, radii, spacing, typography } from "../theme";

interface TopHudBarProps {
  leftLabel: string;
  leftValue: string;
  rightLabel: string;
  rightValue: string;
  leftValueColor?: string;
  rightValueColor?: string;
  leftValueStyle?: StyleProp<TextStyle>;
  style?: StyleProp<ViewStyle>;
}

export function TopHudBar({
  leftLabel,
  leftValue,
  rightLabel,
  rightValue,
  leftValueColor = colors.teal,
  rightValueColor = colors.gold,
  leftValueStyle,
  style,
}: TopHudBarProps) {
  return (
    <View style={[styles.bar, style]}>
      <View style={styles.section}>
        <Text style={styles.label}>{leftLabel}</Text>
        <Text
          numberOfLines={1}
          style={[styles.value, { color: leftValueColor }, leftValueStyle]}
        >
          {leftValue}
        </Text>
      </View>
      <View style={[styles.section, styles.rightSection]}>
        <Text style={styles.label}>{rightLabel}</Text>
        <Text
          numberOfLines={1}
          style={[styles.value, { color: rightValueColor }]}
        >
          {rightValue}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 60,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.xl,
    borderRadius: radii.input,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
  },
  section: {
    flex: 1,
    gap: 2,
  },
  rightSection: {
    alignItems: "flex-end",
  },
  label: {
    ...typography.label,
    color: colors.textMuted,
  },
  value: {
    ...typography.timer,
  },
});
