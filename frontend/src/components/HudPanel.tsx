import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";
import { colors, panelShadow, radii, spacing } from "../theme";

interface HudPanelProps {
  children: ReactNode;
  highlightColor?: string;
  style?: StyleProp<ViewStyle>;
}

export function HudPanel({
  children,
  highlightColor,
  style,
}: HudPanelProps) {
  return (
    <View
      style={[
        styles.panel,
        highlightColor ? { borderColor: highlightColor } : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.panel,
    borderColor: colors.panelBorder,
    borderWidth: 1,
    borderRadius: radii.panel,
    padding: spacing.xl,
    ...panelShadow,
  },
});
