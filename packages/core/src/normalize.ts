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

const MARKDOWN_NAME = /\.(md|markdown|mdown|mkd|mdx)$/i;

/** CSV/TSV text documents: shown as a table (editable), with the raw text one switch away. */
export function isTableName(fileName: string): boolean {
  return /\.(csv|tsv)$/i.test(fileName);
}

/**
 * How a text document is shown: Markdown (reader + editor) or plain text/code (editor only, with
 * syntax highlighting by file name). Derived from the name, so a rename switches it.
 */
export function textFormat(fileName: string): 'markdown' | 'plain' {
  return MARKDOWN_NAME.test(fileName) ? 'markdown' : 'plain';
}

/**
 * Title of a text document. Markdown: the first ATX heading, else the file name without the
 * extension. Plain text and code: the whole file name (`main.py`), since `#` lines are comments
 * there. Mirrored by `derive_title` on the server.
 */
export function deriveTitle(source: string, fileName?: string): string {
  if (fileName && textFormat(fileName) === 'plain') return fileName;
  const match = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(source.slice(0, 4096));
  if (match?.[1]) return match[1].trim();
  if (fileName) return fileName.replace(MARKDOWN_NAME, '');
  return '';
}
