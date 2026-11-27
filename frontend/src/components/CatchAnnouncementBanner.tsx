import { StyleSheet, Text, View } from "react-native";
import { Target } from "lucide-react-native";
import type { CatchConfirmedPayload } from "@impostor/api";
import { colors, radii, spacing, typography } from "../theme";
import { useTranslation } from "../i18n/use-translation";

interface CatchAnnouncementBannerProps {
  announcement: CatchConfirmedPayload;
}

export function CatchAnnouncementBanner({
  announcement,
}: CatchAnnouncementBannerProps) {
  const t = useTranslation();

  return (
    <View style={styles.banner}>
      <Target color={colors.pinkMap} size={19} strokeWidth={2} />
      <Text numberOfLines={1} style={styles.message}>
        {t("manhunt.map.catchAnnouncement", {
          nickname: announcement.caughtNickname,
        })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    marginHorizontal: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    backgroundColor: colors.bg,
  },
  message: {
    ...typography.small,
    flex: 1,
    color: colors.text,
  },
  nickname: {
    fontFamily: typography.body.fontFamily,
    color: colors.text,
  },
});
