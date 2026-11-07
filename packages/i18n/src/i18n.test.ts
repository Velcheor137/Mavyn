import { describe, expect, it } from 'vitest';
import en from './locales/en.json';
import ru from './locales/ru.json';
import { createI18n, detectLocale } from './index.ts';

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const PLURAL = /_(zero|one|two|few|many|other)$/;
const baseKeys = (keys: Iterable<string>) => new Set([...keys].map((k) => k.replace(PLURAL, '')));
const vars = (s: string) => [...s.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

describe('translation catalogs', () => {
  const enFlat = flatten(en as Tree);
  const ruFlat = flatten(ru as Tree);

  it('have the same keys (ignoring plural suffixes)', () => {
    const enBase = baseKeys(enFlat.keys());
    const ruBase = baseKeys(ruFlat.keys());
    expect([...enBase].filter((k) => !ruBase.has(k))).toEqual([]);
    expect([...ruBase].filter((k) => !enBase.has(k))).toEqual([]);
  });

  it('define every plural form each language needs', () => {
    const forms = { en: ['one', 'other'], ru: ['one', 'few', 'many', 'other'] };
    for (const [lang, flat] of [['en', enFlat], ['ru', ruFlat]] as const) {
      const pluralBases = baseKeys([...flat.keys()].filter((k) => PLURAL.test(k)));
      for (const base of pluralBases) {
        for (const form of forms[lang]) expect(flat.has(`${base}_${form}`), `${lang}: ${base}_${form}`).toBe(true);
      }
    }
  });

  it('use the same interpolation variables', () => {
    for (const [key, value] of enFlat) {
      const ruKey = ruFlat.has(key) ? key : `${key.replace(PLURAL, '')}_other`;
      const ruValue = ruFlat.get(ruKey);
      if (ruValue === undefined) continue;
      expect(vars(ruValue), key).toEqual(vars(value));
    }
  });

  it('have no empty strings', () => {
    for (const [key, value] of [...enFlat, ...ruFlat]) expect(value.trim(), key).not.toBe('');
  });
});

describe('runtime', () => {
  it('detects locales with English fallback', () => {
    expect(detectLocale(['ru-RU', 'en'])).toBe('ru');
    expect(detectLocale(['de-DE', 'en-US'])).toBe('en');
    expect(detectLocale(['uk-UA'])).toBe('en');
    expect(detectLocale([])).toBe('en');
  });

  it('pluralises Russian correctly', () => {
    const i18n = createI18n('ru');
    const t = (count: number) => i18n.t('document.words', { count });
    expect(t(1)).toBe('1 слово');
    expect(t(2)).toBe('2 слова');
    expect(t(5)).toBe('5 слов');
    expect(t(11)).toBe('11 слов');
    expect(t(21)).toBe('21 слово');
    expect(t(22)).toBe('22 слова');
    expect(t(111)).toBe('111 слов');
    expect(t(1.5)).toBe('1.5 слова');
  });

  it('switches language at runtime without reinitialising', async () => {
    const i18n = createI18n('en');
    expect(i18n.t('sidebar.library')).toBe('Library');
    await i18n.changeLanguage('ru');
    expect(i18n.t('sidebar.library')).toBe('Библиотека');
    expect(i18n.t('errors.file.external_change' as 'errors.unknown')).not.toBe('errors.file.external_change');
  });
});
