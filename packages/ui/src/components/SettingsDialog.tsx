import { SUPPORTED_LOCALES, useTranslation, type Locale } from '@mdr/i18n';
import { ACCENTS, usePreferences, type ContentWidth, type FontFamily, type ThemeMode, type ViewMode } from '../preferences.ts';
import { useServices } from '../services.tsx';
import { Field, Modal, Switch } from './primitives.tsx';
import { SyncSettings } from './SyncSettings.tsx';

const LOCALE_NAMES: Record<Locale, string> = { en: 'English', ru: 'Русский' };

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { t } = useTranslation();
  const prefs = usePreferences();
  const { appVersion } = useServices();

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('settings.title')} closeLabel={t('settings.close')} wide>
      <div className="settings">
        <section>
          <h3 className="settings-heading">{t('settings.language')}</h3>
          <Field label={t('settings.languageLabel')} htmlFor="pref-locale">
            <select id="pref-locale" className="input" value={prefs.locale ?? 'auto'} onChange={(e) => prefs.set({ locale: e.currentTarget.value === 'auto' ? null : (e.currentTarget.value as Locale) })}>
              <option value="auto">{t('settings.languageAuto')}</option>
              {SUPPORTED_LOCALES.map((locale) => (
                <option key={locale} value={locale} lang={locale}>
                  {LOCALE_NAMES[locale]}
                </option>
              ))}
            </select>
          </Field>
        </section>

        <section>
          <h3 className="settings-heading">{t('sync.title')}</h3>
          <SyncSettings />
        </section>

        <section>
          <h3 className="settings-heading">{t('settings.appearance')}</h3>
          <Field label={t('settings.theme')}>
            <div className="segmented" role="radiogroup" aria-label={t('settings.theme')}>
              {(['light', 'dark', 'system'] as ThemeMode[]).map((mode) => (
                <button key={mode} type="button" role="radio" aria-checked={prefs.theme === mode} className="segmented-item" onClick={() => prefs.set({ theme: mode })}>
                  {t(mode === 'light' ? 'settings.themeLight' : mode === 'dark' ? 'settings.themeDark' : 'settings.themeSystem')}
                </button>
              ))}
            </div>
          </Field>
          <Field label={t('settings.accent')}>
            <div className="flex gap-2 flex-wrap items-center" role="radiogroup" aria-label={t('settings.accent')}>
              {ACCENTS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={prefs.accent === color}
                  aria-label={color}
                  className="swatch"
                  style={{ backgroundColor: color }}
                  onClick={() => prefs.set({ accent: color })}
                />
              ))}
              <input type="color" className="swatch-input" value={prefs.accent} aria-label={t('settings.accent')} onChange={(e) => prefs.set({ accent: e.currentTarget.value })} />
            </div>
          </Field>
        </section>

        <section>
          <h3 className="settings-heading">{t('settings.reading')}</h3>
          <Field label={t('settings.fontFamily')} htmlFor="pref-font">
            <select id="pref-font" className="input" value={prefs.fontFamily} onChange={(e) => prefs.set({ fontFamily: e.currentTarget.value as FontFamily })}>
              <option value="sans">{t('settings.fontSans')}</option>
              <option value="serif">{t('settings.fontSerif')}</option>
              <option value="mono">{t('settings.fontMono')}</option>
            </select>
          </Field>
          <Field label={`${t('settings.fontSize')}: ${prefs.fontSize}px`} htmlFor="pref-size">
            <input id="pref-size" type="range" min={12} max={28} value={prefs.fontSize} onChange={(e) => prefs.set({ fontSize: Number(e.currentTarget.value) })} />
          </Field>
          <Field label={`${t('settings.lineHeight')}: ${prefs.lineHeight.toFixed(1)}`} htmlFor="pref-lh">
            <input id="pref-lh" type="range" min={1.2} max={2.4} step={0.1} value={prefs.lineHeight} onChange={(e) => prefs.set({ lineHeight: Number(e.currentTarget.value) })} />
          </Field>
          <Field label={t('settings.contentWidth')} htmlFor="pref-width">
            <select id="pref-width" className="input" value={prefs.contentWidth} onChange={(e) => prefs.set({ contentWidth: e.currentTarget.value as ContentWidth })}>
              <option value="narrow">{t('settings.widthNarrow')}</option>
              <option value="medium">{t('settings.widthMedium')}</option>
              <option value="wide">{t('settings.widthWide')}</option>
              <option value="full">{t('settings.widthFull')}</option>
            </select>
          </Field>
          <Switch id="pref-codewrap" label={t('settings.codeWrap')} checked={prefs.codeWrap} onChange={(v) => prefs.set({ codeWrap: v })} />
          <Switch id="pref-codeln" label={t('settings.codeLineNumbers')} checked={prefs.codeLineNumbers} onChange={(v) => prefs.set({ codeLineNumbers: v })} />
        </section>

        <section>
          <h3 className="settings-heading">{t('settings.editor')}</h3>
          <Field label={t('document.viewMode')} htmlFor="pref-mode">
            <select id="pref-mode" className="input" value={prefs.defaultViewMode} onChange={(e) => prefs.set({ defaultViewMode: e.currentTarget.value as ViewMode })}>
              <option value="reader">{t('document.reader')}</option>
              <option value="source">{t('document.source')}</option>
              <option value="split">{t('document.split')}</option>
            </select>
          </Field>
          <Switch id="pref-editorln" label={t('settings.editorLineNumbers')} checked={prefs.editorLineNumbers} onChange={(v) => prefs.set({ editorLineNumbers: v })} />
          <Switch id="pref-editorwrap" label={t('settings.editorWrap')} checked={prefs.editorWrap} onChange={(v) => prefs.set({ editorWrap: v })} />
          <Field label={`${t('settings.autosaveDelay')}: ${t('settings.milliseconds', { value: prefs.autosaveDelayMs })}`} htmlFor="pref-autosave">
            <input id="pref-autosave" type="range" min={200} max={5000} step={100} value={prefs.autosaveDelayMs} onChange={(e) => prefs.set({ autosaveDelayMs: Number(e.currentTarget.value) })} />
          </Field>
        </section>

        <section>
          <h3 className="settings-heading">{t('settings.markdown')}</h3>
          <Field label={t('settings.profile')} htmlFor="pref-profile">
            <select id="pref-profile" className="input" value={prefs.profile} onChange={(e) => prefs.set({ profile: e.currentTarget.value as typeof prefs.profile })}>
              <option value="commonmark">{t('settings.profileCommonmark')}</option>
              <option value="gfm">{t('settings.profileGfm')}</option>
              <option value="extended">{t('settings.profileExtended')}</option>
            </select>
          </Field>
          <Switch id="pref-html" label={t('settings.allowHtml')} checked={prefs.allowHtml} onChange={(v) => prefs.set({ allowHtml: v })} />
        </section>

        <section>
          <h3 className="settings-heading">{t('settings.about')}</h3>
          <p>
            {t('app.name')} · {t('settings.version', { version: appVersion })}
          </p>
          <p className="muted">{t('settings.storage')}</p>
        </section>
      </div>
    </Modal>
  );
}
