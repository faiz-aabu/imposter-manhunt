import * as SecureStore from "expo-secure-store";
import { createLanguageStore } from "../i18n/language-store";

export const useLanguageStore = createLanguageStore(SecureStore);
