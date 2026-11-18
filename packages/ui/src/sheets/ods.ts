import { strToU8, strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { serializeElement } from '../xml.ts';
import { dateToSerial, emptySheet, eachCell, extent, serialToDate, setCell, type BorderSide, type Cell, type CellStyle, type CellValue, type Workbook } from './model.ts';

/**
 * OpenDocument spreadsheets (ods), read and written by hand: no JS library keeps their styling.
 * Untouched cells are written back as their original XML; edited or restyled cells are generated.
 * The other parts of the package (styles.xml, settings.xml, meta.xml, …) stay byte for byte.
 */

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
};

export interface OdsContext {
  files: Record<string, Uint8Array>;
  /** Original content.xml text (prologue, root element and everything that is not a table). */
  content: string;
}

interface RawOds {
  /** Original `<table:table-cell …>` XML of an untouched cell. */
  xml: string;
  styleName?: string;
  type?: string;
  /** Cached result as read; a formula whose result changed is regenerated. */
  v?: Cell['v'];
}

/** Cells repeated more often than this are only expanded when they hold something. */
const MAX_REPEAT = 1024;
const MAX_ROWS = 1_048_576;

function attr(el: Element, ns: string, name: string): string | null {
  return el.getAttributeNS(ns, name);
}

function children(el: Element, ns: string, local: string): Element[] {
  return [...el.children].filter((c) => c.namespaceURI === ns && c.localName === local);
}

/** Length in cm/mm/in/pt/pc → points. */
function toPoints(value: string | null): number | undefined {
  const m = /^([\d.]+)(cm|mm|in|pt|pc|px)?$/.exec(value ?? '');
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? 'pt';
  return unit === 'cm' ? (n * 72) / 2.54 : unit === 'mm' ? (n * 72) / 25.4 : unit === 'in' ? n * 72 : unit === 'pc' ? n * 12 : unit === 'px' ? n * 0.75 : n;
}

function parseBorder(value: string | null): BorderSide | undefined {
  if (!value || value === 'none') return undefined;
  const width = toPoints(/[\d.]+(cm|mm|in|pt|px)/.exec(value)?.[0] ?? '') ?? 0.75;
  const color = /#[0-9a-fA-F]{6}/.exec(value)?.[0]?.toUpperCase();
  const style: BorderSide['style'] = /double/.test(value) ? 'double' : /dashed/.test(value) ? 'dashed' : /dotted/.test(value) ? 'dotted' : width >= 2.2 ? 'thick' : width >= 1.4 ? 'medium' : 'thin';
  return color ? { style, color } : { style };
}

function borderValue(side: BorderSide | undefined): string {
  if (!side) return 'none';
  const width = side.style === 'thick' ? '2.5pt' : side.style === 'medium' ? '1.5pt' : side.style === 'double' ? '2.2pt' : '0.75pt';
  const line = side.style === 'dashed' ? 'dashed' : side.style === 'dotted' ? 'dotted' : side.style === 'double' ? 'double' : 'solid';
  return `${width} ${line} ${side.color ?? '#000000'}`;
}

function readCellStyle(el: Element): CellStyle {
  const s: CellStyle = {};
  const text = children(el, NS.style, 'text-properties')[0];
  if (text) {
    if (attr(text, NS.fo, 'font-weight') === 'bold') s.bold = true;
    if (attr(text, NS.fo, 'font-style') === 'italic') s.italic = true;
    const underline = attr(text, NS.style, 'text-underline-style');
    if (underline && underline !== 'none') s.underline = true;
    const strike = attr(text, NS.style, 'text-line-through-style');
    if (strike && strike !== 'none') s.strike = true;
    const color = attr(text, NS.fo, 'color');
    if (color && /^#[0-9a-f]{6}$/i.test(color)) s.color = color.toUpperCase();
    const size = toPoints(attr(text, NS.fo, 'font-size'));
    if (size) s.fontSize = Math.round(size * 10) / 10;
    const font = attr(text, NS.style, 'font-name');
    if (font) s.fontName = font;
  }
  const cell = children(el, NS.style, 'table-cell-properties')[0];
  if (cell) {
    const bg = attr(cell, NS.fo, 'background-color');
    if (bg && /^#[0-9a-f]{6}$/i.test(bg)) s.fill = bg.toUpperCase();
    const valign = attr(cell, NS.style, 'vertical-align');
    if (valign === 'top' || valign === 'bottom' || valign === 'middle') s.vAlign = valign;
    if (attr(cell, NS.fo, 'wrap-option') === 'wrap') s.wrap = true;
    const all = attr(cell, NS.fo, 'border');
    const side = (name: string) => parseBorder(attr(cell, NS.fo, `border-${name}`) ?? all);
    const b = { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') };
    if (b.top || b.right || b.bottom || b.left) s.border = b;
  }
  const para = children(el, NS.style, 'paragraph-properties')[0];
  const align = para ? attr(para, NS.fo, 'text-align') : null;
  if (align === 'center') s.hAlign = 'center';
  else if (align === 'end' || align === 'right') s.hAlign = 'right';
  else if (align === 'start' || align === 'left') s.hAlign = 'left';
  return s;
}

/** Text of a `text:p`, honouring `text:s` (spaces), `text:tab` and `text:line-break`. */
function paragraphText(el: Element): string {
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.nodeValue ?? '';
    else if (node.nodeType === 1) {
      const child = node as Element;
      if (child.namespaceURI === NS.text && child.localName === 's') out += ' '.repeat(Number(attr(child, NS.text, 'c') ?? 1));
      else if (child.namespaceURI === NS.text && child.localName === 'tab') out += '\t';
      else if (child.namespaceURI === NS.text && child.localName === 'line-break') out += '\n';
      else out += paragraphText(child);
    }
  }
  return out;
}

/** OpenFormula (`of:=SUM([.A1:.B2];[Sheet2.C3])`) → Excel syntax (`=SUM(A1:B2,Sheet2!C3)`). */
export function fromOpenFormula(formula: string): string {
  let f = formula.replace(/^(of|oooc|msoxl):/, '');
  f = f.replace(/\[([^\]]*)\]/g, (_, ref: string) =>
    ref
      .split(':')
      .map((part) => {
        const m = /^\$?('?)(.*?)\1?\.(\$?[A-Z]+\$?\d+)$/.exec(part);
        if (!m) return part.replace(/^\./, '');
        const sheet = m[2];
        return sheet ? `${/[^A-Za-z0-9_]/.test(sheet) ? `'${sheet}'` : sheet}!${m[3]}` : m[3]!;
      })
      .join(':'),
  );
  // Argument separator `;` → `,` outside string literals.
  return f.replace(/("[^"]*")|;/g, (m, str: string | undefined) => str ?? ',');
}

/** Excel syntax → OpenFormula. */
export function toOpenFormula(formula: string): string {
  const body = formula.replace(/^=/, '');
  const ref = /('(?:[^']|'')+'|[A-Za-z_][\w.]*)?!?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?/g;
  let out = '';
  let last = 0;
  const strings = /"[^"]*"/g;
  const literals: Array<[number, number]> = [];
  for (let m = strings.exec(body); m; m = strings.exec(body)) literals.push([m.index, m.index + m[0].length]);
  for (let m = ref.exec(body); m; m = ref.exec(body)) {
    if (literals.some(([a, b]) => m!.index >= a && m!.index < b)) continue;
    const full = m[0];
    const hasSheet = full.includes('!');
    // A bare name followed by `(` is a function, not a reference.
    if (!hasSheet && m[1]) continue;
    const sheet = hasSheet ? m[1]!.replace(/^'(.*)'$/, '$1') : '';
    const prefix = sheet ? `${/[^A-Za-z0-9_]/.test(sheet) ? `'${sheet}'` : sheet}.` : '.';
    const a = `${prefix}${m[2]}`;
    const b = m[3] ? `:.${m[3]}` : '';
    out += body.slice(last, m.index) + `[${a}${b}]`;
    last = m.index + full.length;
  }
  out += body.slice(last);
  return `of:=${out.replace(/("[^"]*")|,/g, (match, str: string | undefined) => str ?? ';')}`;
}

/** Reasons a save would lose content (charts, macros, comments, …), as i18n reason keys. */
function unsupportedOf(files: Record<string, Uint8Array>, doc: Document): string[] {
  const reasons = new Set<string>();
  for (const name of Object.keys(files)) {
    if (/^Object \d+\//.test(name) || /^ObjectReplacements\//.test(name)) reasons.add('charts');
    else if (/^Pictures\//.test(name)) reasons.add('objects');
    else if (/^Basic\/|^Scripts\//.test(name)) reasons.add('macros');
  }
  const has = (ns: string, local: string) => doc.getElementsByTagNameNS(ns, local).length > 0;
  if (has(NS.office, 'annotation')) reasons.add('comments');
  if (has(NS.table, 'data-pilot-table')) reasons.add('pivot');
  if (has('urn:oasis:names:tc:opendocument:xmlns:drawing:1.0', 'frame')) reasons.add('objects');
  if (has(NS.text, 'span') || has(NS.text, 'a')) reasons.add('layout');
  if (has(NS.table, 'content-validations') || has('urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0', 'conditional-formats')) reasons.add('misc');
  if (has(NS.table, 'table-source') || has(NS.table, 'dde-links')) reasons.add('external');
  return [...reasons];
}

function valueOf(cell: Element): { v: CellValue; type?: string } {
  const type = attr(cell, NS.office, 'value-type');
  switch (type) {
    case 'float':
    case 'percentage':
    case 'currency':
      return { v: Number(attr(cell, NS.office, 'value')), type };
    case 'boolean':
      return { v: attr(cell, NS.office, 'boolean-value') === 'true', type };
    case 'date': {
      const iso = attr(cell, NS.office, 'date-value') ?? '';
      const date = new Date(/Z|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}${iso.includes('T') ? '' : 'T00:00:00'}Z`);
      return { v: Number.isNaN(date.getTime()) ? iso : dateToSerial(date), type };
    }
    case 'time': {
      const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(attr(cell, NS.office, 'time-value') ?? '');
      const seconds = m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
      return { v: seconds / 86400, type };
    }
    default: {
      const paragraphs = children(cell, NS.text, 'p');
      if (!paragraphs.length) return { v: null };
      return { v: paragraphs.map(paragraphText).join('\n'), type: 'string' };
    }
  }
}

export function readOds(bytes: Uint8Array): { book: Workbook; context: OdsContext; unsupported: string[] } {
  const files = unzipSync(bytes);
  const contentBytes = files['content.xml'];
  if (!contentBytes) throw new Error('ods without content.xml');
  const content = strFromU8(contentBytes);
  const doc = new DOMParser().parseFromString(content, 'application/xml');
  const cellStyles = new Map<string, CellStyle>();
  const colWidths = new Map<string, number>();
  const rowHeights = new Map<string, number>();
  for (const el of doc.getElementsByTagNameNS(NS.style, 'style')) {
    const name = attr(el, NS.style, 'name');
    if (!name) continue;
    const family = attr(el, NS.style, 'family');
    if (family === 'table-cell') cellStyles.set(name, readCellStyle(el));
    else if (family === 'table-column') {
      const pt = toPoints(attr(children(el, NS.style, 'table-column-properties')[0] ?? el, NS.style, 'column-width'));
      // Points → Excel character units (≈ 7 px per character at 96 dpi, 5 px padding).
      if (pt) colWidths.set(name, Math.max(0, Math.round((((pt * 4) / 3 - 5) / 7) * 100) / 100));
    } else if (family === 'table-row') {
      const pt = toPoints(attr(children(el, NS.style, 'table-row-properties')[0] ?? el, NS.style, 'row-height'));
      if (pt) rowHeights.set(name, Math.round(pt * 100) / 100);
    }
  }

  const book: Workbook = { sheets: [] };
  [...doc.getElementsByTagNameNS(NS.table, 'table')].forEach((table, index) => {
    const sheet = emptySheet(attr(table, NS.table, 'name') ?? `Sheet${index + 1}`);
    sheet.origin = index;
    let col = 0;
    for (const column of table.getElementsByTagNameNS(NS.table, 'table-column')) {
      const repeat = Number(attr(column, NS.table, 'number-columns-repeated') ?? 1);
      const width = colWidths.get(attr(column, NS.table, 'style-name') ?? '');
      if (width !== undefined) for (let i = 0; i < Math.min(repeat, MAX_REPEAT); i++) sheet.colWidths.set(col + i, width);
      col += repeat;
    }
    let r = 0;
    for (const row of table.getElementsByTagNameNS(NS.table, 'table-row')) {
      if (r >= MAX_ROWS) break;
      const rowRepeat = Number(attr(row, NS.table, 'number-rows-repeated') ?? 1);
      const height = rowHeights.get(attr(row, NS.table, 'style-name') ?? '');
      const cells = [...row.children].filter((c) => c.namespaceURI === NS.table && (c.localName === 'table-cell' || c.localName === 'covered-table-cell'));
      const hasContent = cells.some((c) => c.localName === 'table-cell' && (c.hasChildNodes() || attr(c, NS.office, 'value-type')));
      const times = hasContent ? Math.min(rowRepeat, MAX_REPEAT) : 1;
      for (let t = 0; t < times; t++) {
        if (height !== undefined && (hasContent || rowRepeat < MAX_REPEAT)) sheet.rowHeights.set(r + t, height);
        let c = 0;
        for (const el of cells) {
          const repeat = Number(attr(el, NS.table, 'number-columns-repeated') ?? 1);
          if (el.localName === 'covered-table-cell') {
            c += repeat;
            continue;
          }
          const styleName = attr(el, NS.table, 'style-name') ?? undefined;
          const { v, type } = valueOf(el);
          const formula = attr(el, NS.table, 'formula');
          const style = styleName ? cellStyles.get(styleName) : undefined;
          const hasStyle = style && Object.keys(style).length > 0;
          if (v !== null || formula || hasStyle) {
            const xml = serializeElement(el);
            for (let i = 0; i < Math.min(repeat, MAX_REPEAT); i++) {
              const cell: Cell = {
                v,
                ...(formula ? { f: fromOpenFormula(formula) } : {}),
                ...(hasStyle ? { s: { ...style } } : {}),
                raw: { xml: repeat > 1 ? xml.replace(/\s+table:number-columns-repeated="\d+"/, '') : xml, styleName, type, v } satisfies RawOds,
              };
              setCell(sheet, r + t, c + i, cell);
            }
            const spanC = Number(attr(el, NS.table, 'number-columns-spanned') ?? 1);
            const spanR = Number(attr(el, NS.table, 'number-rows-spanned') ?? 1);
            if (spanC > 1 || spanR > 1) sheet.merges.push({ r1: r + t, c1: c, r2: r + t + spanR - 1, c2: c + spanC - 1 });
          } else {
            const spanC = Number(attr(el, NS.table, 'number-columns-spanned') ?? 1);
            const spanR = Number(attr(el, NS.table, 'number-rows-spanned') ?? 1);
            if (spanC > 1 || spanR > 1) sheet.merges.push({ r1: r + t, c1: c, r2: r + t + spanR - 1, c2: c + spanC - 1 });
          }
          c += repeat;
        }
      }
      r += rowRepeat;
    }
    book.sheets.push(sheet);
  });
  return { book, context: { files, content }, unsupported: unsupportedOf(files, doc) };
}

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Text content as `text:p` paragraphs with `text:s`/`text:tab` for exact whitespace. */
function paragraphs(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const body = esc(line)
        .replace(/\t/g, '<text:tab/>')
        .replace(/ {2,}/g, (spaces) => ` <text:s text:c="${spaces.length - 1}"/>`)
        .replace(/^ /, '<text:s/>');
      return `<text:p>${body}</text:p>`;
    })
    .join('');
}

function serialToIso(serial: number): string {
  return serialToDate(serial).toISOString().replace(/\.000Z$/, '').replace(/T00:00:00$/, '');
}

class StylePool {
  private readonly styles = new Map<string, string>();
  readonly xml: string[] = [];
  constructor(private readonly prefix: string) {}
  get(key: string, build: (name: string) => string): string {
    const existing = this.styles.get(key);
    if (existing) return existing;
    const name = `${this.prefix}${this.styles.size + 1}`;
    this.styles.set(key, name);
    this.xml.push(build(name));
    return name;
  }
}

function cellStyleXml(name: string, s: CellStyle, dataStyle: string | null): string {
  const text: string[] = [];
  if (s.bold) text.push('fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"');
  if (s.italic) text.push('fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"');
  if (s.underline) text.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
  if (s.strike) text.push('style:text-line-through-style="solid"');
  if (s.color) text.push(`fo:color="${s.color}"`);
  if (s.fontSize) text.push(`fo:font-size="${s.fontSize}pt"`);
  if (s.fontName) text.push(`style:font-name="${esc(s.fontName)}"`);
  const cell: string[] = [];
  if (s.fill) cell.push(`fo:background-color="${s.fill}"`);
  if (s.vAlign) cell.push(`style:vertical-align="${s.vAlign}"`);
  if (s.wrap) cell.push('fo:wrap-option="wrap"');
  if (s.border) {
    for (const side of ['top', 'right', 'bottom', 'left'] as const) cell.push(`fo:border-${side}="${borderValue(s.border[side])}"`);
  }
  const align = s.hAlign === 'center' ? 'center' : s.hAlign === 'right' ? 'end' : s.hAlign === 'left' ? 'start' : null;
  return [
    `<style:style style:name="${name}" style:family="table-cell" style:parent-style-name="Default"${dataStyle ? ` style:data-style-name="${esc(dataStyle)}"` : ''}>`,
    cell.length ? `<style:table-cell-properties ${cell.join(' ')}${align ? ' style:text-align-source="fix"' : ''}/>` : align ? '<style:table-cell-properties style:text-align-source="fix"/>' : '',
    align ? `<style:paragraph-properties fo:text-align="${align}"/>` : '',
    text.length ? `<style:text-properties ${text.join(' ')}/>` : '',
    '</style:style>',
  ].join('');
}

/** Data style (number format) of an existing automatic cell style, kept when restyling. */
function dataStyleOf(doc: Document, styleName: string | undefined): string | null {
  if (!styleName) return null;
  for (const el of doc.getElementsByTagNameNS(NS.style, 'style')) {
    if (attr(el, NS.style, 'name') === styleName) return attr(el, NS.style, 'data-style-name');
  }
  return null;
}

function cellXml(cell: Cell, styleName: string | undefined, extra: string): string {
  const raw = cell.raw as RawOds | undefined;
  const style = styleName ? ` table:style-name="${esc(styleName)}"` : '';
  const formula = cell.f ? ` table:formula="${esc(toOpenFormula(cell.f))}"` : '';
  const v = cell.v;
  if (v === null) return `<table:table-cell${style}${formula}${extra}/>`;
  if (typeof v === 'boolean') return `<table:table-cell${style}${formula}${extra} office:value-type="boolean" office:boolean-value="${v}"><text:p>${v ? 'TRUE' : 'FALSE'}</text:p></table:table-cell>`;
  if (typeof v === 'number') {
    const type = raw?.type === 'date' ? 'date' : raw?.type === 'percentage' || raw?.type === 'currency' ? raw.type : 'float';
    const value = type === 'date' ? ` office:date-value="${serialToIso(v)}"` : ` office:value="${v}"`;
    return `<table:table-cell${style}${formula}${extra} office:value-type="${type}"${value}><text:p>${esc(String(v))}</text:p></table:table-cell>`;
  }
  return `<table:table-cell${style}${formula}${extra} office:value-type="string"><text:p>${''}</text:p></table:table-cell>`.replace('<text:p></text:p>', paragraphs(v));
}

/** Writes the model back: tables regenerated, everything else in content.xml and the package kept. */
export function writeOds(book: Workbook, context: OdsContext): Uint8Array {
  const doc = new DOMParser().parseFromString(context.content, 'application/xml');
  const tables = [...doc.getElementsByTagNameNS(NS.table, 'table')];
  const cellPool = new StylePool('ce-m');
  const colPool = new StylePool('co-m');
  const rowPool = new StylePool('ro-m');
  const tableXml: string[] = [];
  for (const sheet of book.sheets) {
    const original = sheet.origin !== undefined ? tables[sheet.origin] : undefined;
    const attrs = original
      ? [...original.attributes].filter((a) => !(a.namespaceURI === NS.table && a.localName === 'name')).map((a) => ` ${a.name}="${esc(a.value)}"`).join('')
      : '';
    const { rows, cols } = extent(sheet);
    const parts: string[] = [`<table:table table:name="${esc(sheet.name)}"${attrs}>`];
    for (let c = 0; c <= Math.max(cols, 0); c++) {
      const width = sheet.colWidths.get(c);
      const name = width === undefined ? null : colPool.get(String(width), (n) => `<style:style style:name="${n}" style:family="table-column"><style:table-column-properties fo:break-before="auto" style:column-width="${((width * 7 + 5) * 0.75).toFixed(2)}pt"/></style:style>`);
      parts.push(`<table:table-column${name ? ` table:style-name="${name}"` : ''} table:default-cell-style-name="Default"/>`);
    }
    const cellsByRow = new Map<number, Array<[number, Cell]>>();
    for (const [r, c, cell] of eachCell(sheet)) {
      const list = cellsByRow.get(r) ?? [];
      list.push([c, cell]);
      cellsByRow.set(r, list);
    }
    for (let r = 0; r <= rows; r++) {
      const height = sheet.rowHeights.get(r);
      const rowStyle = height === undefined ? null : rowPool.get(String(height), (n) => `<style:style style:name="${n}" style:family="table-row"><style:table-row-properties style:row-height="${height}pt" style:use-optimal-row-height="false" fo:break-before="auto"/></style:style>`);
      parts.push(`<table:table-row${rowStyle ? ` table:style-name="${rowStyle}"` : ''}>`);
      const list = cellsByRow.get(r) ?? [];
      const byCol = new Map(list);
      for (let c = 0; c <= cols; c++) {
        const merge = sheet.merges.find((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2);
        if (merge && (merge.r1 !== r || merge.c1 !== c)) {
          parts.push('<table:covered-table-cell/>');
          continue;
        }
        const span = merge ? ` table:number-columns-spanned="${merge.c2 - merge.c1 + 1}" table:number-rows-spanned="${merge.r2 - merge.r1 + 1}"` : '';
        const cell = byCol.get(c);
        if (!cell) {
          parts.push(`<table:table-cell${span}/>`);
          continue;
        }
        const raw = cell.raw as RawOds | undefined;
        if (raw && !cell.edited && !cell.restyled && !(cell.f && cell.v !== raw.v) && !span && !/number-(columns|rows)-spanned/.test(raw.xml)) {
          parts.push(raw.xml);
          continue;
        }
        let styleName = raw?.styleName;
        if (cell.restyled || (!raw && cell.s)) {
          const dataStyle = dataStyleOf(doc, raw?.styleName);
          styleName = cell.s && Object.keys(cell.s).length
            ? cellPool.get(JSON.stringify([cell.s, dataStyle]), (n) => cellStyleXml(n, cell.s!, dataStyle))
            : dataStyle
              ? cellPool.get(JSON.stringify([{}, dataStyle]), (n) => cellStyleXml(n, {}, dataStyle))
              : undefined;
        }
        parts.push(cellXml(cell, styleName, span));
      }
      parts.push('</table:table-row>');
    }
    parts.push('</table:table>');
    tableXml.push(parts.join(''));
  }

  // Splice: new automatic styles appended, the tables replaced, everything else kept verbatim.
  let content = context.content;
  const generated = [...cellPool.xml, ...colPool.xml, ...rowPool.xml].join('');
  if (generated) {
    content = /<office:automatic-styles\s*\/>/.test(content)
      ? content.replace(/<office:automatic-styles\s*\/>/, `<office:automatic-styles>${generated}</office:automatic-styles>`)
      : /<\/office:automatic-styles>/.test(content)
        ? content.replace('</office:automatic-styles>', `${generated}</office:automatic-styles>`)
        : content.replace(/(<office:body)/, `<office:automatic-styles>${generated}</office:automatic-styles>$1`);
  }
  const first = content.indexOf('<table:table ');
  const lastClose = content.lastIndexOf('</table:table>');
  const start = first >= 0 ? first : content.indexOf('</office:spreadsheet>');
  const end = lastClose >= 0 ? lastClose + '</table:table>'.length : start;
  content = content.slice(0, start) + tableXml.join('') + content.slice(end);

  const files: Zippable = {};
  // `mimetype` must be the first entry and stored uncompressed.
  files.mimetype = [context.files.mimetype ?? strToU8('application/vnd.oasis.opendocument.spreadsheet'), { level: 0 }];
  for (const [name, data] of Object.entries(context.files)) {
    if (name === 'mimetype' || name.endsWith('/')) continue;
    files[name] = name === 'content.xml' ? strToU8(content) : data;
  }
  return zipSync(files, { level: 6 });
}
