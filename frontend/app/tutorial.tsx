import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  HudPanel,
  LanguageSelector,
  PrimaryButton,
  Screen,
} from "../src/components";
import { tutorialPages, tutorialWelcomeKeys } from "../src/i18n/tutorial-content";
import { useTranslation } from "../src/i18n/use-translation";
import { markTutorialCompleted } from "../src/services/tutorial-progress";
import { colors, radii, spacing, typography } from "../src/theme";

export default function TutorialRoute() {
  const router = useRouter();
  const t = useTranslation();
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const [pageIndex, setPageIndex] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const returnPath = returnTo === "/lobby" ? "/lobby" : "/";
  const pageCount = tutorialPages.length + 1;
  const isWelcomePage = pageIndex === 0;
  const isLastPage = pageIndex === pageCount - 1;
  const currentPage = isWelcomePage
    ? null
    : tutorialPages[pageIndex - 1];

  const finishTutorial = async () => {
    setIsSaving(true);
    setErrorMessage(null);
    try {
      await markTutorialCompleted();
      router.replace(returnPath);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? t("tutorial.saveError", { message: error.message })
          : t("tutorial.saveErrorFallback"),
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Screen scrollable contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>{t("tutorial.header")}</Text>
        <Text style={styles.pageCount}>
          {t("tutorial.pageCount", {
            current: pageIndex + 1,
            total: pageCount,
          })}
        </Text>
      </View>

      <View
        accessibilityRole="progressbar"
        accessibilityLabel={t("tutorial.progress")}
        accessibilityValue={{ min: 1, max: pageCount, now: pageIndex + 1 }}
        style={styles.progressTrack}
      >
        <View
          style={[
            styles.progressFill,
            { width: `${((pageIndex + 1) / pageCount) * 100}%` },
          ]}
        />
      </View>

      <LanguageSelector />

      {isWelcomePage ? (
        <View style={styles.welcome}>
          <Text style={styles.welcomeTitle}>
            {t(tutorialWelcomeKeys.title)}
          </Text>
          <Text style={styles.tagline}>{t(tutorialWelcomeKeys.tagline)}</Text>
          <HudPanel style={styles.panel}>
            <Text style={styles.description}>
              {t(tutorialWelcomeKeys.description)}
            </Text>
          </HudPanel>
        </View>
      ) : currentPage ? (
        <View style={styles.page}>
          <Text style={styles.eyebrow}>
            {t(currentPage.label).toUpperCase()}
          </Text>
          <Text style={styles.title}>{t(currentPage.title)}</Text>
          <Text style={styles.description}>
            {t(currentPage.description)}
          </Text>
          <View style={styles.points}>
            {currentPage.points.map((point) => (
              <HudPanel key={point.title} style={styles.point}>
                <Text style={styles.pointTitle}>{t(point.title)}</Text>
                <Text style={styles.pointDescription}>
                  {t(point.description)}
                </Text>
              </HudPanel>
            ))}
          </View>
        </View>
      ) : null}

      {errorMessage ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorMessage}
        </Text>
      ) : null}

      <View style={styles.actions}>
        {pageIndex > 0 ? (
          <PrimaryButton
            title={t("tutorial.back")}
            variant="secondary"
            disabled={isSaving}
            onPress={() => setPageIndex((index) => index - 1)}
          />
        ) : null}
        {isLastPage ? (
          <PrimaryButton
            title={t("tutorial.finish")}
            loading={isSaving}
            onPress={() => void finishTutorial()}
          />
        ) : (
          <PrimaryButton
            title={
              isWelcomePage ? t("tutorial.start") : t("tutorial.next")
            }
            disabled={isSaving}
            onPress={() => setPageIndex((index) => index + 1)}
          />
        )}
        {!isLastPage ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: isSaving }}
            disabled={isSaving}
            onPress={() => void finishTutorial()}
            style={styles.skipButton}
          >
            <Text style={styles.skipText}>{t("tutorial.skip")}</Text>
          </Pressable>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: {
    flexGrow: 1,
    gap: spacing.xl,
    paddingTop: spacing.xxl,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  eyebrow: {
    ...typography.label,
    color: colors.textMuted,
  },
  pageCount: {
    ...typography.small,
    color: colors.textMuted,
  },
  progressTrack: {
    height: 6,
    overflow: "hidden",
    borderRadius: radii.panel,
    backgroundColor: colors.panelBorder,
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.teal,
  },
  welcome: {
    flex: 1,
    justifyContent: "center",
    gap: spacing.xl,
  },
  welcomeTitle: {
    ...typography.headline,
    color: colors.text,
  },
  tagline: {
    ...typography.title,
    color: colors.teal,
  },
  page: {
    gap: spacing.md,
  },
  title: {
    ...typography.headline,
    color: colors.text,
  },
  description: {
    ...typography.body,
    color: colors.textMuted,
  },
  panel: {
    marginTop: spacing.sm,
  },
  points: {
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  point: {
    gap: spacing.xs,
    padding: spacing.lg,
  },
  pointTitle: {
    ...typography.gameCardTitle,
    color: colors.text,
  },
  pointDescription: {
    ...typography.small,
    color: colors.textMuted,
  },
  error: {
    ...typography.small,
    color: colors.pink,
  },
  actions: {
    gap: spacing.md,
    marginTop: "auto",
    paddingTop: spacing.md,
  },
  skipButton: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  skipText: {
    ...typography.button,
    color: colors.textMuted,
  },
});
