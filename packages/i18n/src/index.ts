import i18next, { type i18n as I18n } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ru from './locales/ru.json';

export const SUPPORTED_LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const resources = { en: { translation: en }, ru: { translation: ru } } as const;

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
  }
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/** First supported language from the user's preference list (`navigator.languages`); English otherwise. */
export function detectLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

/** Creates an isolated i18next instance (one per app; tests create their own). */
export function createI18n(locale: Locale): I18n {
  const instance = i18next.createInstance();
  void instance.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: 'en',
    supportedLngs: [...SUPPORTED_LOCALES],
    interpolation: { escapeValue: false }, // React escapes.
    returnNull: false,
    initAsync: false,
    saveMissing: false,
  });
  return instance;
}

export { I18nextProvider, useTranslation } from 'react-i18next';
export type { I18n };
