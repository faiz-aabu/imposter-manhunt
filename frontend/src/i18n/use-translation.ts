import { useCallback } from "react";
import { useLanguageStore } from "../services/language-preference";
import { translate } from "./translate";
import type { TranslationValues } from "./translate";
import type { TranslationKey } from "./locales";

export function useTranslation() {
  const language = useLanguageStore((state) => state.language);
  return useCallback(
    (key: TranslationKey, values?: TranslationValues) =>
      translate(language, key, values),
    [language],
  );
}
