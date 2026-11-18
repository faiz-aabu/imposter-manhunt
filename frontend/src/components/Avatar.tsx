import { StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { colors, radii, typography } from "../theme";

interface AvatarProps {
  name: string;
  fillColor?: string;
  style?: StyleProp<ViewStyle>;
}

export function Avatar({
  name,
  fillColor = colors.teal,
  style,
}: AvatarProps) {
  const initial = name.trim().charAt(0).toUpperCase();

  return (
    <View
      accessible
      accessibilityLabel={name}
      style={[styles.avatar, { backgroundColor: fillColor }, style]}
    >
      <Text style={styles.initial}>{initial}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.avatar,
  },
  initial: {
    ...typography.body,
    color: colors.textOnAccent,
    textTransform: "uppercase",
  },
});
