import { Pressable, StyleSheet, Text, View } from "react-native";
import { languageOptions } from "../i18n/locales";
import { useTranslation } from "../i18n/use-translation";
import { useLanguageStore } from "../services/language-preference";
import { colors, radii, spacing, typography } from "../theme";

export function LanguageSelector() {
  const t = useTranslation();
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);
  const loadFailed = useLanguageStore((state) => state.loadFailed);
  const saveFailed = useLanguageStore((state) => state.saveFailed);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{t("language.title")}</Text>
      <View style={styles.options}>
        {languageOptions.map((option) => {
          const selected = language === option.code;
          return (
            <Pressable
              key={option.code}
              accessibilityRole="radio"
              accessibilityLabel={option.nativeName}
              accessibilityState={{ checked: selected }}
              onPress={() => {
                void setLanguage(option.code).catch(() => undefined);
              }}
              style={({ pressed }) => [
                styles.option,
                selected ? styles.selected : null,
                pressed ? styles.pressed : null,
              ]}
            >
              <Text
                style={[
                  styles.optionText,
                  selected ? styles.selectedText : null,
                ]}
              >
                {option.nativeName}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {loadFailed || saveFailed ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {loadFailed ? t("language.loadError") : t("language.saveError")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  label: {
    ...typography.label,
    color: colors.textMuted,
  },
  options: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
  },
  option: {
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.panelBorder,
    backgroundColor: colors.panel,
    paddingHorizontal: spacing.md,
  },
  selected: {
    borderColor: colors.teal,
    backgroundColor: colors.panel,
  },
  optionText: {
    ...typography.small,
    color: colors.textMuted,
  },
  selectedText: {
    color: colors.teal,
  },
  pressed: {
    opacity: 0.75,
  },
  error: {
    ...typography.small,
    color: colors.pink,
  },
});
