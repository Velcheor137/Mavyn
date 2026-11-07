/**
 * Comparison key for names, tags and search terms: NFC + locale-independent lowercase. Russian
 * `ё` is folded to `е` because users type both interchangeably.
 */
export function foldKey(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('und').replaceAll('ё', 'е');
}

const collators = new Map<string, Intl.Collator>();

/** Locale-aware, numeric-aware, case-insensitive comparison for sorting names in the UI. */
export function compareNames(a: string, b: string, locale: string): number {
  let collator = collators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    collators.set(locale, collator);
  }
  return collator.compare(a.normalize('NFC'), b.normalize('NFC'));
}

/** Title from the first ATX heading or the file name without the extension. */
export function deriveTitle(source: string, fileName?: string): string {
  const match = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(source.slice(0, 4096));
  if (match?.[1]) return match[1].trim();
  if (fileName) return fileName.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');
  return '';
}
