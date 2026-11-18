import type { ViewStyle } from "react-native";

export const radii = {
  panel: 18,
  button: 16,
  input: 12,
  chip: 999,
  avatar: 999,
} as const;

export const panelShadow = {
  shadowColor: "rgba(0, 0, 0, 0.35)",
  shadowOffset: { width: 0, height: 6 },
  shadowOpacity: 1,
  shadowRadius: 18,
  elevation: 6,
} satisfies ViewStyle;
