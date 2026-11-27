import { translations } from "./locales";
import type {
  Language,
  LocaleMessages,
  TranslationKey,
} from "./locales";

export type TranslationValues = Record<string, string | number>;
export type TranslationCatalogs = Partial<
  Record<Language, Partial<LocaleMessages>>
>;

export function translate(
  language: Language,
  key: TranslationKey,
  values?: TranslationValues,
  catalogs: TranslationCatalogs = translations,
): string {
  const template = catalogs[language]?.[key] ?? translations.en[key];
  if (!values) {
    return template;
  }
  return template.replace(/\{([^}]+)\}/g, (placeholder, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name)
      ? String(values[name])
      : placeholder,
  );
}
