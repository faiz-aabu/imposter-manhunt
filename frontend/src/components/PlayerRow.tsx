import { StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { Avatar } from "./Avatar";
import { Chip } from "./Chip";
import type { ChipProps } from "./Chip";
import { colors, spacing, typography } from "../theme";

interface PlayerRowProps {
  name: string;
  avatarColor?: string;
  chip?: ChipProps;
  status?: string;
  style?: StyleProp<ViewStyle>;
}

export function PlayerRow({
  name,
  avatarColor,
  chip,
  status,
  style,
}: PlayerRowProps) {
  return (
    <View style={[styles.row, style]}>
      <Avatar name={name} fillColor={avatarColor} />
      <Text numberOfLines={1} style={styles.name}>
        {name}
      </Text>
      {chip ? <Chip {...chip} /> : null}
      {!chip && status ? <Text style={styles.status}>{status}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  name: {
    ...typography.body,
    color: colors.text,
    flex: 1,
  },
  status: {
    ...typography.small,
    color: colors.textMuted,
  },
});
