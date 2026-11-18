/**
 * Spreadsheet model shared by the xlsx, ods and csv adapters and the editor. Rows and columns are
 * 0-based. A cell keeps the original style object of its file format (`raw`) so styling the editor
 * does not understand (theme colours, exotic borders) is written back unchanged unless the user
 * restyles that cell.
 */

export type CellValue = string | number | boolean | null;

export interface BorderSide {
  style: 'thin' | 'medium' | 'thick' | 'dashed' | 'dotted' | 'double';
  color?: string;
}

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Points. */
  fontSize?: number;
  fontName?: string;
  /** `#RRGGBB`. */
  color?: string;
  /** Solid background, `#RRGGBB`. */
  fill?: string;
  hAlign?: 'left' | 'center' | 'right';
  vAlign?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  /** Excel number format code (`0.00`, `0%`, `dd.mm.yyyy`, …). */
  numFmt?: string;
  border?: { top?: BorderSide; right?: BorderSide; bottom?: BorderSide; left?: BorderSide };
}

export interface Cell {
  /** Literal value; for formula cells the last computed result (written as the cached value). */
  v: CellValue;
  /** Formula in Excel syntax with the leading `=`, e.g. `=SUM(A1:A3)`. */
  f?: string;
  s?: CellStyle;
  /** Original format-specific style (ExcelJS style object / ODS style name), kept until restyled. */
  raw?: unknown;
  /** True once the user changed this cell's style: `s` is written instead of `raw`. */
  restyled?: boolean;
  /** True once the content changed (or is a formula): `v`/`f` are written instead of `raw`. */
  edited?: boolean;
}

export interface Range {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface Sheet {
  name: string;
  /** Sparse cells: row → column → cell. */
  cells: Map<number, Map<number, Cell>>;
  merges: Range[];
  /** Column widths in characters (Excel units); missing = default. */
  colWidths: Map<number, number>;
  /** Row heights in points; missing = default. */
  rowHeights: Map<number, number>;
  frozen?: { rows: number; cols: number };
  /** Format-specific handle of the sheet in the loaded file (ExcelJS worksheet id, ODS index). */
  origin?: number;
}

export interface Workbook {
  sheets: Sheet[];
}

export const DEFAULT_COL_WIDTH = 9.14;
export const DEFAULT_ROW_HEIGHT = 15;

export function emptySheet(name: string): Sheet {
  return { name, cells: new Map(), merges: [], colWidths: new Map(), rowHeights: new Map() };
}

export function getCell(sheet: Sheet, r: number, c: number): Cell | undefined {
  return sheet.cells.get(r)?.get(c);
}

export function setCell(sheet: Sheet, r: number, c: number, cell: Cell | undefined): void {
  let row = sheet.cells.get(r);
  if (!cell) {
    row?.delete(c);
    if (row && row.size === 0) sheet.cells.delete(r);
    return;
  }
  if (!row) {
    row = new Map();
    sheet.cells.set(r, row);
  }
  row.set(c, cell);
}

/** Every cell, row by row, column by column. */
export function* eachCell(sheet: Sheet): Generator<[number, number, Cell]> {
  for (const r of [...sheet.cells.keys()].sort((a, b) => a - b)) {
    const row = sheet.cells.get(r)!;
    for (const c of [...row.keys()].sort((a, b) => a - b)) yield [r, c, row.get(c)!];
  }
}

/** Last used row and column (-1 when empty). */
export function extent(sheet: Sheet): { rows: number; cols: number } {
  let rows = -1;
  let cols = -1;
  for (const [r, row] of sheet.cells) {
    if (row.size === 0) continue;
    rows = Math.max(rows, r);
    for (const c of row.keys()) cols = Math.max(cols, c);
  }
  for (const m of sheet.merges) {
    rows = Math.max(rows, m.r2);
    cols = Math.max(cols, m.c2);
  }
  return { rows, cols };
}

export function columnName(c: number): string {
  let name = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export function columnIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function address(r: number, c: number): string {
  return `${columnName(c)}${r + 1}`;
}

export function parseAddress(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (!m) return null;
  return { r: Number(m[2]) - 1, c: columnIndex(m[1]!) };
}

export function parseRange(ref: string): Range | null {
  const [a, b = a] = ref.split(':');
  const p = parseAddress(a!);
  const q = parseAddress(b!);
  if (!p || !q) return null;
  return { r1: Math.min(p.r, q.r), c1: Math.min(p.c, q.c), r2: Math.max(p.r, q.r), c2: Math.max(p.c, q.c) };
}

export function rangeRef(range: Range): string {
  return `${address(range.r1, range.c1)}:${address(range.r2, range.c2)}`;
}

export function mergeAt(sheet: Sheet, r: number, c: number): Range | undefined {
  return sheet.merges.find((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2);
}

function shiftKeys<T>(map: Map<number, T>, at: number, delta: number): Map<number, T> {
  const next = new Map<number, T>();
  for (const [k, v] of map) {
    if (k < at) next.set(k, v);
    else if (delta < 0 && k < at - delta) continue; // deleted
    else next.set(k + delta, v);
  }
  return next;
}

/**
 * Inserts (`count` > 0) or deletes (`count` < 0) rows at `at`, moving styles, merges and heights.
 * Cell contents are re-read from the formula engine afterwards (it adjusts references).
 */
export function shiftRows(sheet: Sheet, at: number, count: number): void {
  sheet.cells = shiftKeys(sheet.cells, at, count);
  sheet.rowHeights = shiftKeys(sheet.rowHeights, at, count);
  sheet.merges = shiftRanges(sheet.merges, at, count, 'r');
}

export function shiftCols(sheet: Sheet, at: number, count: number): void {
  for (const [r, row] of sheet.cells) sheet.cells.set(r, shiftKeys(row, at, count));
  sheet.colWidths = shiftKeys(sheet.colWidths, at, count);
  sheet.merges = shiftRanges(sheet.merges, at, count, 'c');
}

function shiftRanges(ranges: Range[], at: number, count: number, axis: 'r' | 'c'): Range[] {
  const out: Range[] = [];
  for (const m of ranges) {
    const lo = axis === 'r' ? m.r1 : m.c1;
    const hi = axis === 'r' ? m.r2 : m.c2;
    let nlo = lo;
    let nhi = hi;
    if (count > 0) {
      if (lo >= at) nlo += count;
      if (hi >= at) nhi += count;
    } else {
      const end = at - count; // first index after the deleted block
      const map = (i: number) => (i < at ? i : i >= end ? i + count : at);
      nlo = map(lo);
      nhi = hi < end && hi >= at ? at - 1 : map(hi);
      if (nhi < nlo) continue;
    }
    const next = axis === 'r' ? { ...m, r1: nlo, r2: nhi } : { ...m, c1: nlo, c2: nhi };
    if (next.r1 === next.r2 && next.c1 === next.c2) continue;
    out.push(next);
  }
  return out;
}

/** Parses typed input: number (dot or comma decimal), boolean, or text. */
export function parseInput(input: string): CellValue {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (/^[+-]?(\d+([.,]\d+)?|[.,]\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed.replace(',', '.'));
  const upper = trimmed.toUpperCase();
  if (upper === 'TRUE' || upper === 'ИСТИНА') return true;
  if (upper === 'FALSE' || upper === 'ЛОЖЬ') return false;
  return input;
}

/** Excel serial date (1900 system) → JS Date (UTC). */
export function serialToDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86_400_000));
}

export function dateToSerial(date: Date): number {
  return date.getTime() / 86_400_000 + 25569;
}

/** Displays a value with a (small subset of) Excel number formats. */
export function formatValue(value: CellValue, numFmt: string | undefined, locale: string): string {
  if (value === null) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return value;
  const fmt = (numFmt ?? 'General').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  if (/[dmyhs]/i.test(fmt) && !/^[#0.,% ]*$/.test(fmt)) {
    const date = serialToDate(value);
    const timeOnly = !/[dy]/i.test(fmt);
    const hasTime = /h/i.test(fmt);
    const options: Intl.DateTimeFormatOptions = { timeZone: 'UTC' };
    if (!timeOnly) Object.assign(options, { year: 'numeric', month: '2-digit', day: '2-digit' });
    if (hasTime) Object.assign(options, { hour: '2-digit', minute: '2-digit' });
    return new Intl.DateTimeFormat(locale, options).format(date);
  }
  const decimals = (/\.(0+)/.exec(fmt)?.[1]?.length) ?? undefined;
  if (fmt.includes('%')) {
    return new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: decimals ?? 0, maximumFractionDigits: decimals ?? 0 }).format(value);
  }
  if (decimals !== undefined || /[#0]/.test(fmt)) {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals ?? 0,
      maximumFractionDigits: decimals ?? 0,
      useGrouping: fmt.includes(','),
    }).format(value);
  }
  return new Intl.NumberFormat(locale, { maximumSignificantDigits: 15, useGrouping: false }).format(value);
}

/** Deep copy (sheets are edited in place by the editor; adapters keep their own originals). */
export function cloneWorkbook(book: Workbook): Workbook {
  return {
    sheets: book.sheets.map((s) => ({
      ...s,
      cells: new Map([...s.cells].map(([r, row]) => [r, new Map([...row].map(([c, cell]) => [c, { ...cell, s: cell.s ? { ...cell.s } : undefined }]))])),
      merges: s.merges.map((m) => ({ ...m })),
      colWidths: new Map(s.colWidths),
      rowHeights: new Map(s.rowHeights),
      frozen: s.frozen ? { ...s.frozen } : undefined,
    })),
  };
}
