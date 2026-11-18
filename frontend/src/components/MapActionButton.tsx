import { Pressable, StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { colors, radii, spacing, typography } from "../theme";

interface MapActionButtonProps {
  icon: LucideIcon;
  label: string;
  subLabel: string;
  accentColor: string;
  onPress: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function MapActionButton({
  icon: Icon,
  label,
  subLabel,
  accentColor,
  onPress,
  disabled = false,
  style,
}: MapActionButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${subLabel}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
        style,
      ]}
    >
      <Icon color={accentColor} size={22} strokeWidth={2} />
      <View style={styles.textBlock}>
        <Text numberOfLines={1} style={styles.label}>
          {label}
        </Text>
        <Text numberOfLines={1} style={styles.subLabel}>
          {subLabel}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.input,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
  },
  textBlock: {
    flex: 1,
  },
  label: {
    ...typography.mapActionLabel,
    color: colors.text,
  },
  subLabel: {
    ...typography.mapActionSubLabel,
    color: colors.textMuted,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.8,
  },
});
