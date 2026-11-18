import { Pressable, StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { Avatar } from "./Avatar";
import { Chip } from "./Chip";
import { colors, radii, spacing, typography } from "../theme";

interface VoteOptionProps {
  name: string;
  onPress: () => void;
  selected?: boolean;
  out?: boolean;
  disabled?: boolean;
  avatarColor?: string;
  style?: StyleProp<ViewStyle>;
}

export function VoteOption({
  name,
  onPress,
  selected = false,
  out = false,
  disabled = false,
  avatarColor,
  style,
}: VoteOptionProps) {
  const isDisabled = disabled || out;

  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: isDisabled }}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        selected ? styles.selected : null,
        isDisabled ? styles.disabled : null,
        pressed && !isDisabled ? styles.pressed : null,
        style,
      ]}
    >
      <Avatar name={name} fillColor={avatarColor} />
      <Text numberOfLines={1} style={styles.name}>
        {name}
      </Text>
      {out ? (
        <Chip label="Out" variant="muted" />
      ) : selected ? (
        <Chip label="Your vote" variant="pink" />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  option: {
    width: "100%",
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    borderRadius: radii.input,
    backgroundColor: colors.panel,
    borderWidth: 1,
    borderColor: colors.panelBorder,
  },
  selected: {
    backgroundColor: colors.pinkTint,
    borderColor: colors.pink,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.82,
  },
  name: {
    ...typography.body,
    color: colors.text,
    flex: 1,
  },
});
