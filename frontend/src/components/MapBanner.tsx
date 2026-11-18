import { StyleSheet, Text, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { colors, radii, spacing, typography } from "../theme";

interface MapBannerProps {
  message: string;
  timer: string;
  style?: StyleProp<ViewStyle>;
}

export function MapBanner({ message, timer, style }: MapBannerProps) {
  return (
    <View style={[styles.banner, style]}>
      <Text numberOfLines={1} style={styles.message}>
        {message}
      </Text>
      <Text numberOfLines={1} style={styles.timer}>
        {timer}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radii.input,
    backgroundColor: colors.text,
  },
  message: {
    ...typography.small,
    color: colors.textOnAccent,
    flex: 1,
  },
  timer: {
    ...typography.timer,
    color: colors.mapBannerTimer,
  },
});
