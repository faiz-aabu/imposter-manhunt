import type { TextStyle } from "react-native";

export const fontFamilies = {
  medium: "Inter_500Medium",
  semiBold: "Inter_600SemiBold",
  bold: "Inter_700Bold",
} as const;

export const typography = {
  headline: {
    fontFamily: fontFamilies.bold,
    fontSize: 40,
    lineHeight: 48,
  },
  title: {
    fontFamily: fontFamilies.bold,
    fontSize: 34,
    lineHeight: 40,
  },
  timer: {
    fontFamily: fontFamilies.bold,
    fontSize: 19,
    lineHeight: 24,
  },
  body: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 17,
    lineHeight: 24,
  },
  small: {
    fontFamily: fontFamilies.medium,
    fontSize: 13,
    lineHeight: 18,
  },
  label: {
    fontFamily: fontFamilies.semiBold,
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  button: {
    fontFamily: fontFamilies.bold,
    fontSize: 17,
    lineHeight: 22,
  },
  gameCardTitle: {
    fontFamily: fontFamilies.bold,
    fontSize: 20,
    lineHeight: 26,
  },
  chip: {
    fontFamily: fontFamilies.bold,
    fontSize: 12,
    lineHeight: 16,
  },
  codeInput: {
    fontFamily: fontFamilies.bold,
    fontSize: 36,
    lineHeight: 44,
  },
  mapActionLabel: {
    fontFamily: fontFamilies.bold,
    fontSize: 14,
    lineHeight: 19,
  },
  mapActionSubLabel: {
    fontFamily: fontFamilies.medium,
    fontSize: 11,
    lineHeight: 15,
  },
  fontStatusTitle: {
    fontSize: 20,
    lineHeight: 26,
    fontWeight: "700",
  },
  fontStatusMessage: {
    fontSize: 14,
    lineHeight: 20,
  },
  roomCode: {
    letterSpacing: 2,
  },
} satisfies Record<string, TextStyle>;
