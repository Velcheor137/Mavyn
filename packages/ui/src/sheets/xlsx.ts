import type { Borders, Cell as XCell, CellValue as XValue, Fill, Font, Style, Workbook as XWorkbook, Worksheet } from 'exceljs';
import { unzipSync } from 'fflate';
import { dateToSerial, emptySheet, eachCell, parseRange, rangeRef, setCell, type BorderSide, type Cell, type CellStyle, type CellValue, type Workbook } from './model.ts';

/**
 * xlsx through ExcelJS. The loaded ExcelJS workbook is kept and patched on save, so everything it
 * round-trips (page setup, defined names, theme, properties) survives; parts it would drop are
 * reported by `unsupportedParts` so the first edit goes to a copy.
 */
export interface XlsxContext {
  workbook: XWorkbook;
}

/** Zip parts the adapter writes back unchanged or regenerates; anything else is reported. */
const KNOWN_PARTS = [
  /^\[Content_Types\]\.xml$/,
  /^_rels\/\.rels$/,
  /^docProps\//,
  /^xl\/workbook\.xml$/,
  /^xl\/_rels\/workbook\.xml\.rels$/,
  /^xl\/worksheets\/sheet\d+\.xml$/,
  /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/,
  /^xl\/styles\.xml$/,
  /^xl\/sharedStrings\.xml$/,
  /^xl\/theme\/theme\d+\.xml$/,
  /^xl\/calcChain\.xml$/,
  // Dynamic-array metadata; without it Excel treats spilled formulas as ordinary ones.
  /^xl\/metadata\.xml$/,
  /^xl\/printerSettings\//,
];

const PART_REASONS: Array<[RegExp, string]> = [
  [/^xl\/charts\/|^xl\/chartsheets\//, 'charts'],
  [/^xl\/pivot(Tables|Cache)\//, 'pivot'],
  [/vbaProject\.bin$/, 'macros'],
  [/^xl\/(embeddings|activeX|ctrlProps|drawings|media)\//, 'objects'],
  [/^xl\/(comments\d*\.xml|threadedComments|persons)/, 'comments'],
  [/^xl\/externalLinks\//, 'external'],
];

/** Reasons (i18n keys `files.reason_*`) why saving would lose something in this zip package. */
export function unsupportedParts(bytes: Uint8Array): string[] {
  const names: string[] = [];
  unzipSync(bytes, { filter: (file) => (names.push(file.name), false) });
  const reasons = new Set<string>();
  for (const name of names) {
    if (name.endsWith('/') || KNOWN_PARTS.some((re) => re.test(name))) continue;
    reasons.add(PART_REASONS.find(([re]) => re.test(name))?.[1] ?? 'misc');
  }
  return [...reasons];
}

async function loadExcelJs(): Promise<typeof import('exceljs')> {
  const mod = (await import('exceljs')) as unknown as { default?: typeof import('exceljs') } & typeof import('exceljs');
  return mod.default ?? mod;
}

function argbToHex(color: { argb?: string } | undefined): string | undefined {
  const argb = color?.argb;
  if (!argb || !/^[0-9a-f]{8}$/i.test(argb)) return undefined;
  return `#${argb.slice(2).toUpperCase()}`;
}

function hexToArgb(hex: string): { argb: string } {
  return { argb: `FF${hex.replace('#', '').toUpperCase()}` };
}

const BORDER_STYLES = new Set(['thin', 'medium', 'thick', 'dashed', 'dotted', 'double']);

function fromBorder(side: Partial<Borders>['top'] | undefined): BorderSide | undefined {
  if (!side?.style) return undefined;
  const style = BORDER_STYLES.has(side.style) ? (side.style as BorderSide['style']) : 'thin';
  const color = argbToHex(side.color);
  return color ? { style, color } : { style };
}

function toBorder(side: BorderSide | undefined): Partial<Borders>['top'] | undefined {
  return side ? { style: side.style, ...(side.color ? { color: hexToArgb(side.color) } : {}) } : undefined;
}

/** ExcelJS style → editor style (what the grid can show). */
export function fromStyle(style: Partial<Style> | undefined): CellStyle | undefined {
  if (!style) return undefined;
  const s: CellStyle = {};
  const font = style.font;
  if (font?.bold) s.bold = true;
  if (font?.italic) s.italic = true;
  if (font?.underline) s.underline = true;
  if (font?.strike) s.strike = true;
  if (font?.size) s.fontSize = font.size;
  if (font?.name) s.fontName = font.name;
  const color = argbToHex(font?.color);
  if (color) s.color = color;
  const fill = style.fill as (Fill & { fgColor?: { argb?: string } }) | undefined;
  if (fill?.type === 'pattern' && fill.pattern === 'solid') {
    const bg = argbToHex(fill.fgColor);
    if (bg) s.fill = bg;
  }
  const h = style.alignment?.horizontal;
  if (h === 'left' || h === 'center' || h === 'right') s.hAlign = h;
  const v = style.alignment?.vertical;
  if (v === 'top' || v === 'bottom') s.vAlign = v;
  else if (v === 'middle') s.vAlign = 'middle';
  if (style.alignment?.wrapText) s.wrap = true;
  if (style.numFmt) s.numFmt = style.numFmt;
  const border = style.border;
  if (border) {
    const b = { top: fromBorder(border.top), right: fromBorder(border.right), bottom: fromBorder(border.bottom), left: fromBorder(border.left) };
    if (b.top || b.right || b.bottom || b.left) s.border = b;
  }
  return Object.keys(s).length ? s : undefined;
}

/** Editor style over the original ExcelJS style (unknown properties of the original stay). */
export function toStyle(s: CellStyle | undefined, original: Partial<Style> | undefined): Partial<Style> {
  const out: Partial<Style> = { ...(original ?? {}) };
  const font: Partial<Font> = { ...(original?.font ?? {}) };
  font.bold = s?.bold || undefined;
  font.italic = s?.italic || undefined;
  font.underline = s?.underline || undefined;
  font.strike = s?.strike || undefined;
  if (s?.fontSize) font.size = s.fontSize;
  if (s?.fontName) font.name = s.fontName;
  if (s?.color) font.color = hexToArgb(s.color);
  else if (argbToHex(font.color)) delete font.color;
  out.font = font;
  if (s?.fill) out.fill = { type: 'pattern', pattern: 'solid', fgColor: hexToArgb(s.fill) };
  else if ((original?.fill as { pattern?: string } | undefined)?.pattern === 'solid') delete out.fill;
  out.alignment = { ...(original?.alignment ?? {}), horizontal: s?.hAlign, vertical: s?.vAlign, wrapText: s?.wrap || undefined };
  if (s?.numFmt) out.numFmt = s.numFmt;
  else delete out.numFmt;
  out.border = s?.border
    ? { top: toBorder(s.border.top), right: toBorder(s.border.right), bottom: toBorder(s.border.bottom), left: toBorder(s.border.left) }
    : {};
  return out;
}

interface RawXlsx {
  style: Partial<Style>;
  value: XValue;
}

function plainValue(cell: XCell): { v: CellValue; f?: string; richText?: boolean } {
  const value = cell.value as XValue;
  if (value === null || value === undefined) return { v: null };
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return { v: value };
  if (value instanceof Date) return { v: dateToSerial(value) };
  if (typeof value === 'object') {
    const formula = cell.formula;
    if (formula) {
      const result = (value as { result?: unknown }).result;
      const v = typeof result === 'number' || typeof result === 'string' || typeof result === 'boolean' ? result : result instanceof Date ? dateToSerial(result) : null;
      return { v, f: `=${formula}` };
    }
    if ('richText' in value) return { v: value.richText.map((r) => r.text).join(''), richText: true };
    if ('text' in value) return { v: String((value as { text: unknown }).text) };
    if ('error' in value) return { v: String((value as { error: unknown }).error) };
  }
  return { v: String(value) };
}

/** Reads an xlsx file. `unsupported` lists what a save would lose (i18n reason keys). */
export async function readXlsx(bytes: Uint8Array): Promise<{ book: Workbook; context: XlsxContext; unsupported: string[] }> {
  const ExcelJS = await loadExcelJs();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes.slice().buffer as ArrayBuffer);
  const unsupported = new Set(unsupportedParts(bytes));
  const book: Workbook = { sheets: [] };
  workbook.eachSheet((ws: Worksheet) => {
    const sheet = emptySheet(ws.name);
    sheet.origin = ws.id;
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (row.height && !Number.isNaN(row.height)) sheet.rowHeights.set(rowNumber - 1, row.height);
      row.eachCell({ includeEmpty: true }, (xc, colNumber) => {
        const { v, f, richText } = plainValue(xc);
        if (richText) unsupported.add('layout');
        const style = (xc.style ?? {}) as Partial<Style>;
        const s = fromStyle(style);
        if (v === null && !f && !s) return;
        // Formulas are written explicitly (shared formulas would break when cells move), except ones
        // using newer functions whose `_xlfn.` prefix only the original text keeps.
        const prefixed = f?.includes('_xl') ?? false;
        const cell: Cell = {
          v,
          ...(f ? { f: f.replace(/_xl(fn|ws)\./g, ''), edited: !prefixed } : {}),
          ...(s ? { s } : {}),
          raw: { style, value: xc.value } satisfies RawXlsx,
        };
        setCell(sheet, rowNumber - 1, colNumber - 1, cell);
      });
    });
    for (const col of (ws.model as unknown as { cols?: unknown[] }).cols ?? []) {
      const { min, max, width } = col as { min: number; max: number; width?: number };
      if (width) for (let c = min; c <= max && c - min < 16384; c++) sheet.colWidths.set(c - 1, width);
    }
    for (const ref of ws.model.merges ?? []) {
      const range = parseRange(ref);
      if (range) sheet.merges.push(range);
    }
    const view = ws.views?.[0] as { state?: string; xSplit?: number; ySplit?: number } | undefined;
    if (view?.state === 'frozen') sheet.frozen = { rows: view.ySplit ?? 0, cols: view.xSplit ?? 0 };
    const model = ws.model as unknown as { conditionalFormattings?: unknown[]; dataValidations?: Record<string, unknown>; tables?: unknown[] };
    if (model.conditionalFormattings?.length || Object.keys(model.dataValidations ?? {}).length || model.tables?.length) unsupported.add('misc');
    book.sheets.push(sheet);
  });
  return { book, context: { workbook }, unsupported: [...unsupported] };
}

/** Writes the model into the loaded workbook (patching it) and returns the xlsx bytes. */
export async function writeXlsx(book: Workbook, context: XlsxContext): Promise<Uint8Array> {
  const wb = context.workbook;
  const keep = new Set(book.sheets.map((s) => s.origin).filter((id): id is number => id !== undefined));
  for (const ws of [...wb.worksheets]) if (!keep.has(ws.id)) wb.removeWorksheet(ws.id);
  book.sheets.forEach((sheet, index) => {
    let ws = sheet.origin !== undefined ? wb.getWorksheet(sheet.origin) : undefined;
    if (!ws) {
      ws = wb.addWorksheet(sheet.name);
      sheet.origin = ws.id;
    }
    ws.name = sheet.name;
    (ws as unknown as { orderNo: number }).orderNo = index;
    writeSheet(ws, sheet);
  });
  const out = await wb.xlsx.writeBuffer();
  return new Uint8Array(out as ArrayBuffer);
}

function writeSheet(ws: Worksheet, sheet: Workbook['sheets'][number]): void {
  for (const ref of [...(ws.model.merges ?? [])]) ws.unMergeCells(ref);
  // Clear every existing cell, then write the model (rows/columns may have moved).
  ws.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.value = null;
      cell.style = {};
    });
    row.height = undefined as unknown as number;
  });
  for (const [r, c, cell] of eachCell(sheet)) {
    const xc = ws.getCell(r + 1, c + 1);
    const raw = cell.raw as RawXlsx | undefined;
    xc.value = !cell.edited && raw
      ? raw.value
      : cell.f
        ? ({ formula: cell.f.slice(1), result: cell.v ?? undefined } as XValue)
        : (cell.v as XValue);
    xc.style = (cell.restyled || !raw ? toStyle(cell.s, raw?.style) : raw.style) as Style;
  }
  for (const m of sheet.merges) ws.mergeCells(rangeRef(m));
  for (const [c, width] of sheet.colWidths) ws.getColumn(c + 1).width = width;
  for (const [r, height] of sheet.rowHeights) ws.getRow(r + 1).height = height;
  // Keep the original view (zoom, selection); only the frozen panes follow the editor.
  const view = { ...((ws.views?.[0] as object | undefined) ?? {}) } as Record<string, unknown>;
  if (sheet.frozen && (sheet.frozen.rows || sheet.frozen.cols)) Object.assign(view, { state: 'frozen', xSplit: sheet.frozen.cols, ySplit: sheet.frozen.rows });
  else if (view.state === 'frozen') Object.assign(view, { state: 'normal', xSplit: undefined, ySplit: undefined });
  ws.views = [view as never, ...(ws.views ?? []).slice(1)];
}
