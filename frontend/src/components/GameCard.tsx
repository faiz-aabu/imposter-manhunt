import { Pressable, StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { ChevronRight } from "lucide-react-native";
import { Chip } from "./Chip";
import type { ChipVariant } from "./Chip";
import { colors, radii, spacing, typography } from "../theme";

interface GameCardProps {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  chipLabel: string;
  tileColor: string;
  onPress: () => void;
  chipVariant?: ChipVariant;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function GameCard({
  icon: Icon,
  title,
  subtitle,
  chipLabel,
  tileColor,
  onPress,
  chipVariant = "teal",
  disabled = false,
  style,
}: GameCardProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${subtitle}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
        style,
      ]}
    >
      <View style={[styles.iconTile, { backgroundColor: tileColor }]}>
        <Icon color={colors.textOnAccent} size={28} strokeWidth={2} />
      </View>
      <View style={styles.content}>
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <Text numberOfLines={2} style={styles.subtitle}>
          {subtitle}
        </Text>
        <Chip label={chipLabel} variant={chipVariant} />
      </View>
      <ChevronRight color={colors.textMuted} size={22} strokeWidth={2} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: "100%",
    minHeight: 96,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radii.panel,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
  },
  iconTile: {
    width: 60,
    height: 60,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.input,
  },
  content: {
    flex: 1,
    gap: spacing.xs,
  },
  title: {
    ...typography.gameCardTitle,
    color: colors.text,
  },
  subtitle: {
    ...typography.small,
    color: colors.textMuted,
  },
  disabled: {
    opacity: 0.45,
  },
  pressed: {
    opacity: 0.82,
  },
});
