import { useTranslation } from '@mdr/i18n';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Combine,
  Italic,
  Paintbrush,
  Plus,
  Redo2,
  Strikethrough,
  Table2,
  Trash2,
  Type,
  Underline,
  Undo2,
  WrapText,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { FormulaEngine } from './formulas.ts';
import {
  address,
  cloneWorkbook,
  columnName,
  DEFAULT_COL_WIDTH,
  DEFAULT_ROW_HEIGHT,
  emptySheet,
  extent,
  formatValue,
  getCell,
  mergeAt,
  parseInput,
  setCell,
  shiftCols,
  shiftRows,
  type BorderSide,
  type Cell,
  type CellStyle,
  type Range,
  type Workbook,
} from './model.ts';

export interface SheetEditorProps {
  /** Edited in place; the host serializes it after `onChange`. */
  book: Workbook;
  /** Formulas are recalculated (xlsx, ods); CSV keeps literal text. */
  formulas: boolean;
  /** Fonts, colours, borders, merges, sizes (not in CSV). */
  formatting: boolean;
  /** Adding, renaming, deleting and moving sheets (not in CSV). */
  multipleSheets: boolean;
  readOnly?: boolean;
  /** Called after every change, before it is shown; return false to cancel the change. */
  beforeChange?: () => boolean | Promise<boolean>;
  onChange(): void;
}

const HEADER_W = 48;
const HEADER_H = 24;
const pxOfWidth = (chars: number) => Math.round(chars * 7 + 5);
const pxOfHeight = (points: number) => Math.round((points * 4) / 3);
const NUMBER_FORMATS = ['General', '0', '0.00', '#,##0', '#,##0.00', '0%', '0.00%', 'dd.mm.yyyy', 'dd.mm.yyyy hh:mm', 'hh:mm'];
const UNDO_LIMIT = 100;

interface Selection {
  /** Anchor (where the selection started) and focus (active cell). */
  ar: number;
  ac: number;
  fr: number;
  fc: number;
}

const rangeOf = (s: Selection): Range => ({ r1: Math.min(s.ar, s.fr), c1: Math.min(s.ac, s.fc), r2: Math.max(s.ar, s.fr), c2: Math.max(s.ac, s.fc) });

/** Prefix sums of sizes so position lookups are cheap; recomputed when sizes change. */
function offsets(count: number, size: (i: number) => number): number[] {
  const out = new Array<number>(count + 1);
  out[0] = 0;
  for (let i = 0; i < count; i++) out[i + 1] = out[i]! + size(i);
  return out;
}

function indexAt(offs: number[], pos: number): number {
  let lo = 0;
  let hi = offs.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offs[mid]! <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function borderCss(side: BorderSide | undefined): string | undefined {
  if (!side) return undefined;
  const width = side.style === 'thick' ? 3 : side.style === 'medium' ? 2 : 1;
  const line = side.style === 'dashed' ? 'dashed' : side.style === 'dotted' ? 'dotted' : side.style === 'double' ? 'double' : 'solid';
  return `${side.style === 'double' ? 3 : width}px ${line} ${side.color ?? '#000'}`;
}

function cellCss(style: CellStyle | undefined, numeric: boolean): CSSProperties {
  const css: CSSProperties = {};
  if (!style) return numeric ? { justifyContent: 'flex-end' } : css;
  if (style.bold) css.fontWeight = 600;
  if (style.italic) css.fontStyle = 'italic';
  const deco = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) css.textDecoration = deco;
  if (style.color) css.color = style.color;
  if (style.fill) css.background = style.fill;
  if (style.fontSize) css.fontSize = `${Math.max(6, Math.min(48, style.fontSize * 1.1))}px`;
  if (style.fontName) css.fontFamily = `"${style.fontName}", var(--font-sans)`;
  const align = style.hAlign ?? (numeric ? 'right' : 'left');
  css.justifyContent = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
  css.alignItems = style.vAlign === 'top' ? 'flex-start' : style.vAlign === 'middle' ? 'center' : 'flex-end';
  if (style.wrap) css.whiteSpace = 'pre-wrap';
  if (style.border) {
    css.borderTop = borderCss(style.border.top);
    css.borderRight = borderCss(style.border.right);
    css.borderBottom = borderCss(style.border.bottom);
    css.borderLeft = borderCss(style.border.left);
  }
  return css;
}

/**
 * Spreadsheet editor for xlsx, ods and CSV: virtualized grid, formula bar, formatting, rows and
 * columns, sheets, undo while open, clipboard as tab-separated text. Works with touch: tap selects,
 * double tap edits, the toolbar wraps on narrow screens.
 */
export function SheetEditor({ book, formulas, formatting, multipleSheets, readOnly = false, beforeChange, onChange }: SheetEditorProps) {
  const { t, i18n } = useTranslation();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [active, setActive] = useState(0);
  const [sel, setSel] = useState<Selection>({ ar: 0, ac: 0, fr: 0, fc: 0 });
  const [editing, setEditing] = useState<string | null>(null);
  // Last pointer was a finger/pen: the idle cell input then asks for no on-screen keyboard.
  const [touch, setTouch] = useState(false);
  const [view, setView] = useState({ top: 0, left: 0, width: 800, height: 400 });
  const [renaming, setRenaming] = useState<number | null>(null);
  const engine = useRef<FormulaEngine | null>(null);
  const [engineReady, setEngineReady] = useState(!formulas);
  const undo = useRef<Workbook[]>([]);
  const redo = useRef<Workbook[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const colHeader = useRef<HTMLDivElement>(null);
  const rowHeader = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const dragging = useRef(false);
  const sheet = book.sheets[active] ?? book.sheets[0]!;
  const locale = i18n.language;

  // Formula engine for the whole workbook (rebuilt after undo/redo).
  const rebuildEngine = useCallback(async () => {
    if (!formulas) return;
    engine.current?.destroy();
    engine.current = await FormulaEngine.create(book);
    book.sheets.forEach((_, i) => engine.current!.refreshValues(book, i));
    setEngineReady(true);
    rerender();
  }, [book, formulas]);
  useEffect(() => {
    void rebuildEngine();
    return () => {
      engine.current?.destroy();
      engine.current = null;
    };
  }, [rebuildEngine]);

  const used = extent(sheet);
  const rowCount = Math.max(used.rows + 101, 200);
  const colCount = Math.max(used.cols + 11, 26);
  const colOffs = useMemo(() => offsets(colCount, (c) => pxOfWidth(sheet.colWidths.get(c) ?? DEFAULT_COL_WIDTH)), [colCount, sheet, sheet.colWidths.size, view.width]); // eslint-disable-line react-hooks/exhaustive-deps
  const rowOffs = useMemo(() => offsets(rowCount, (r) => pxOfHeight(sheet.rowHeights.get(r) ?? DEFAULT_ROW_HEIGHT)), [rowCount, sheet, sheet.rowHeights.size, view.height]); // eslint-disable-line react-hooks/exhaustive-deps
  const [sizeVersion, bumpSizes] = useReducer((n: number) => n + 1, 0);
  void sizeVersion;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    // Before layout (or without one, as in tests) assume a typical pane size.
    const update = () => setView({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth || 1000, height: el.clientHeight || 600 });
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);

  const onScroll = () => {
    const el = scroller.current!;
    setView({ top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth || 1000, height: el.clientHeight || 600 });
    if (colHeader.current) colHeader.current.style.transform = `translateX(${-el.scrollLeft}px)`;
    if (rowHeader.current) rowHeader.current.style.transform = `translateY(${-el.scrollTop}px)`;
  };

  const r1 = indexAt(rowOffs, view.top);
  const r2 = Math.min(rowCount - 1, indexAt(rowOffs, view.top + view.height) + 1);
  const c1 = indexAt(colOffs, view.left);
  const c2 = Math.min(colCount - 1, indexAt(colOffs, view.left + view.width) + 1);

  const display = (r: number, c: number, cell: Cell | undefined): { text: string; numeric: boolean } => {
    if (!cell) return { text: '', numeric: false };
    const value = formulas && cell.f && engine.current ? engine.current.value(active, r, c) : cell.v;
    return { text: formatValue(value, cell.s?.numFmt, locale), numeric: typeof value === 'number' };
  };

  const rawInput = (cell: Cell | undefined): string => (cell?.f ? cell.f : cell?.v === null || cell?.v === undefined ? '' : String(cell.v));

  /** Runs a change: snapshot for undo, the edit, recalculation, notify. */
  const change = async (edit: () => void): Promise<void> => {
    if (readOnly) return;
    if (beforeChange && !(await beforeChange())) return;
    undo.current.push(cloneWorkbook(book));
    if (undo.current.length > UNDO_LIMIT) undo.current.shift();
    redo.current = [];
    edit();
    if (engine.current) book.sheets.forEach((_, i) => engine.current!.refreshValues(book, i));
    rerender();
    onChange();
  };

  const restore = async (from: Workbook[], to: Workbook[]) => {
    const snapshot = from.pop();
    if (!snapshot) return;
    to.push(cloneWorkbook(book));
    book.sheets = snapshot.sheets;
    if (active >= book.sheets.length) setActive(book.sheets.length - 1);
    await rebuildEngine();
    rerender();
    onChange();
  };

  const writeCell = (r: number, c: number, input: string) => {
    const old = getCell(sheet, r, c);
    const isFormula = formulas && input.startsWith('=') && input.length > 1;
    const value = isFormula ? null : formulas ? parseInput(input) : input === '' ? null : input;
    const next: Cell | undefined = value === null && !isFormula && !old?.s
      ? undefined
      : { ...(old ?? {}), v: value, edited: true, ...(isFormula ? { f: input } : { f: undefined }) };
    if (next && !isFormula) delete next.f;
    setCell(sheet, r, c, next);
    engine.current?.setContent(active, r, c, isFormula ? input : value);
  };

  const commit = (input: string, move: 'down' | 'right' | 'none' = 'down') => {
    const { fr, fc } = sel;
    setEditing(null);
    if (input !== rawInput(getCell(sheet, fr, fc))) void change(() => writeCell(fr, fc, input));
    if (move === 'down') select(fr + 1, fc);
    else if (move === 'right') select(fr, fc + 1);
    scroller.current?.focus();
  };

  const select = (r: number, c: number, extend = false) => {
    const rr = Math.max(0, Math.min(rowCount - 1, r));
    const cc = Math.max(0, Math.min(colCount - 1, c));
    setSel((s) => (extend ? { ...s, fr: rr, fc: cc } : { ar: rr, ac: cc, fr: rr, fc: cc }));
    // Keep the active cell visible.
    const el = scroller.current;
    if (el) {
      const top = rowOffs[rr]!;
      const bottom = rowOffs[rr + 1]!;
      const left = colOffs[cc]!;
      const right = colOffs[cc + 1]!;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
      if (left < el.scrollLeft) el.scrollLeft = left;
      else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    }
  };

  const range = rangeOf(sel);
  const forRange = (fn: (r: number, c: number) => void) => {
    for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) fn(r, c);
  };

  const restyle = (patch: (s: CellStyle) => CellStyle) =>
    void change(() =>
      forRange((r, c) => {
        const old = getCell(sheet, r, c);
        const s = patch({ ...(old?.s ?? {}) });
        setCell(sheet, r, c, { ...(old ?? { v: null }), s, restyled: true });
      }),
    );

  const activeCell = getCell(sheet, sel.fr, sel.fc);
  const activeStyle = activeCell?.s ?? {};
  const toggle = (key: 'bold' | 'italic' | 'underline' | 'strike' | 'wrap') => restyle((s) => ({ ...s, [key]: !activeStyle[key] }));

  const clearRange = () =>
    void change(() =>
      forRange((r, c) => {
        const old = getCell(sheet, r, c);
        if (!old) return;
        setCell(sheet, r, c, old.s ? { ...old, v: null, f: undefined, edited: true } : undefined);
        engine.current?.setContent(active, r, c, null);
      }),
    );

  const structural = (kind: 'rowAbove' | 'rowBelow' | 'colLeft' | 'colRight' | 'deleteRows' | 'deleteCols') =>
    void change(() => {
      const e = engine.current;
      if (kind === 'rowAbove' || kind === 'rowBelow') {
        const at = kind === 'rowAbove' ? range.r1 : range.r2 + 1;
        e?.insertRows(active, at, 1);
        shiftRows(sheet, at, 1);
      } else if (kind === 'colLeft' || kind === 'colRight') {
        const at = kind === 'colLeft' ? range.c1 : range.c2 + 1;
        e?.insertCols(active, at, 1);
        shiftCols(sheet, at, 1);
      } else if (kind === 'deleteRows') {
        const n = range.r2 - range.r1 + 1;
        e?.removeRows(active, range.r1, n);
        shiftRows(sheet, range.r1, -n);
      } else {
        const n = range.c2 - range.c1 + 1;
        e?.removeCols(active, range.c1, n);
        shiftCols(sheet, range.c1, -n);
      }
      // Cell values moved with the cells; formulas are re-read from the engine (references moved).
      for (const [, row] of sheet.cells) for (const [, cell] of row) cell.edited = true;
      e?.syncInto(book);
    });

  const toggleMerge = () =>
    void change(() => {
      const existing = sheet.merges.filter((m) => !(m.r2 < range.r1 || m.r1 > range.r2 || m.c2 < range.c1 || m.c1 > range.c2));
      if (existing.length) sheet.merges = sheet.merges.filter((m) => !existing.includes(m));
      else if (range.r1 !== range.r2 || range.c1 !== range.c2) sheet.merges.push({ ...range });
    });

  const setBorders = (mode: 'all' | 'outer' | 'none') =>
    void change(() =>
      forRange((r, c) => {
        const old = getCell(sheet, r, c);
        const side: BorderSide = { style: 'thin', color: '#000000' };
        const border = mode === 'none'
          ? undefined
          : mode === 'all'
            ? { top: side, right: side, bottom: side, left: side }
            : {
                ...(old?.s?.border ?? {}),
                ...(r === range.r1 ? { top: side } : {}),
                ...(r === range.r2 ? { bottom: side } : {}),
                ...(c === range.c1 ? { left: side } : {}),
                ...(c === range.c2 ? { right: side } : {}),
              };
        const s: CellStyle = { ...(old?.s ?? {}) };
        if (border) s.border = border;
        else delete s.border;
        setCell(sheet, r, c, { ...(old ?? { v: null }), s, restyled: true });
      }),
    );

  // ---- sheets ----
  const addSheet = () =>
    void change(() => {
      let n = book.sheets.length + 1;
      while (book.sheets.some((s) => s.name === `${t('sheet.sheet')} ${n}`)) n++;
      const name = `${t('sheet.sheet')} ${n}`;
      book.sheets.push(emptySheet(name));
      engine.current?.addSheet(name, book.sheets.length - 1);
      setActive(book.sheets.length - 1);
    });
  const removeSheet = (index: number) => {
    if (book.sheets.length < 2 || !window.confirm(t('sheet.deleteConfirm', { name: book.sheets[index]!.name }))) return;
    void change(() => {
      book.sheets.splice(index, 1);
      engine.current?.removeSheet(index);
      setActive(Math.max(0, index - 1));
    });
  };
  const renameSheet = (index: number, name: string) => {
    setRenaming(null);
    const trimmed = name.trim();
    if (!trimmed || trimmed === book.sheets[index]!.name || book.sheets.some((s) => s.name.toLowerCase() === trimmed.toLowerCase())) return;
    void change(() => {
      engine.current?.renameSheet(index, trimmed);
      book.sheets[index]!.name = trimmed;
      engine.current?.syncInto(book);
    });
  };
  const moveSheet = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= book.sheets.length) return;
    void change(() => {
      const [moved] = book.sheets.splice(index, 1);
      book.sheets.splice(to, 0, moved!);
      engine.current?.moveSheet(index, to);
      setActive(to);
    });
  };

  // ---- clipboard (tab-separated text) ----
  const copy = async (cut: boolean) => {
    const lines: string[] = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const row: string[] = [];
      for (let c = range.c1; c <= range.c2; c++) row.push(display(r, c, getCell(sheet, r, c)).text);
      lines.push(row.join('\t'));
    }
    await navigator.clipboard?.writeText(lines.join('\n')).catch(() => undefined);
    if (cut) clearRange();
  };
  const paste = async () => {
    const text = await navigator.clipboard?.readText().catch(() => '');
    if (!text) return;
    const rows = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((l) => l.split('\t'));
    void change(() => rows.forEach((row, i) => row.forEach((value, j) => writeCell(sel.fr + i, sel.fc + j, value))));
  };

  // ---- keyboard ----
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing !== null) return;
    const mod = e.ctrlKey || e.metaKey;
    const { fr, fc } = sel;
    const move = (dr: number, dc: number) => {
      e.preventDefault();
      select(fr + dr, fc + dc, e.shiftKey);
    };
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      void restore(e.shiftKey ? redo.current : undo.current, e.shiftKey ? undo.current : redo.current);
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      void restore(redo.current, undo.current);
    } else if (mod && e.key.toLowerCase() === 'c') void copy(false);
    else if (mod && e.key.toLowerCase() === 'x') void copy(true);
    else if (mod && e.key.toLowerCase() === 'v') {
      e.preventDefault();
      void paste();
    } else if (mod && e.key.toLowerCase() === 'b' && formatting) {
      e.preventDefault();
      toggle('bold');
    } else if (mod && e.key.toLowerCase() === 'i' && formatting) {
      e.preventDefault();
      toggle('italic');
    } else if (e.key === 'ArrowDown') move(1, 0);
    else if (e.key === 'ArrowUp') move(-1, 0);
    else if (e.key === 'ArrowLeft') move(0, -1);
    else if (e.key === 'ArrowRight') move(0, 1);
    else if (e.key === 'Tab') move(0, e.shiftKey ? -1 : 1);
    else if (e.key === 'Enter') move(e.shiftKey ? -1 : 1, 0);
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      clearRange();
    } else if (e.key === 'F2' && !readOnly) {
      e.preventDefault();
      setEditing(rawInput(activeCell));
    } else if (e.key.length === 1 && !mod && !e.altKey && !readOnly) {
      e.preventDefault();
      setEditing(e.key);
    }
  };

  useEffect(() => {
    if (editing === null) return;
    const el = editor.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- pointer selection ----
  const cellAt = (e: ReactPointerEvent): { r: number; c: number } => {
    const rect = scroller.current!.getBoundingClientRect();
    const x = e.clientX - rect.left + scroller.current!.scrollLeft;
    const y = e.clientY - rect.top + scroller.current!.scrollTop;
    return { r: indexAt(rowOffs, y), c: indexAt(colOffs, x) };
  };
  const onPointerDown = (e: ReactPointerEvent) => {
    setTouch(e.pointerType !== 'mouse');
    if ((e.target as HTMLElement).closest('textarea')) return;
    if (editing !== null) commit(editing, 'none');
    const { r, c } = cellAt(e);
    select(r, c, e.shiftKey);
    dragging.current = e.pointerType === 'mouse';
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (!dragging.current) return;
    const { r, c } = cellAt(e);
    if (r !== sel.fr || c !== sel.fc) setSel((s) => ({ ...s, fr: r, fc: c }));
  };

  // ---- column/row resize ----
  const resize = (axis: 'col' | 'row', index: number, e: ReactPointerEvent) => {
    if (!formatting || readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const start = axis === 'col' ? e.clientX : e.clientY;
    const initial = axis === 'col' ? colOffs[index + 1]! - colOffs[index]! : rowOffs[index + 1]! - rowOffs[index]!;
    let latest = initial;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      latest = Math.max(axis === 'col' ? 20 : 12, initial + (axis === 'col' ? ev.clientX : ev.clientY) - start);
      if (axis === 'col') sheet.colWidths.set(index, Math.round(((latest - 5) / 7) * 100) / 100);
      else sheet.rowHeights.set(index, Math.round(((latest * 3) / 4) * 100) / 100);
      bumpSizes();
      rerender();
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      if (latest !== initial) {
        // The live preview already changed the sheet; record it as one undoable change.
        const snapshot = cloneWorkbook(book);
        const s = snapshot.sheets[active]!;
        if (axis === 'col') s.colWidths.set(index, Math.round(((initial - 5) / 7) * 100) / 100);
        else s.rowHeights.set(index, Math.round(((initial * 3) / 4) * 100) / 100);
        undo.current.push(snapshot);
        redo.current = [];
        onChange();
      }
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  };

  // ---- render ----
  const cells: ReactNode[] = [];
  const covered = (r: number, c: number) => {
    const m = mergeAt(sheet, r, c);
    return m && (m.r1 !== r || m.c1 !== c);
  };
  const drawnMerges = new Set<Range>();
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      let merge = mergeAt(sheet, r, c);
      let rr = r;
      let cc = c;
      if (merge) {
        if (drawnMerges.has(merge)) continue;
        drawnMerges.add(merge);
        rr = merge.r1;
        cc = merge.c1;
      } else if (covered(r, c)) continue;
      const cell = getCell(sheet, rr, cc);
      if (!cell && !merge) continue;
      const { text, numeric } = display(rr, cc, cell);
      const right = merge ? merge.c2 + 1 : cc + 1;
      const bottom = merge ? merge.r2 + 1 : rr + 1;
      cells.push(
        <div
          key={`${rr}:${cc}`}
          className={`sheet-cell${merge ? ' sheet-merged' : ''}`}
          style={{ left: colOffs[cc], top: rowOffs[rr], width: colOffs[right]! - colOffs[cc]!, height: rowOffs[bottom]! - rowOffs[rr]!, ...cellCss(cell?.s, numeric) }}
          data-error={typeof text === 'string' && text.startsWith('#') && cell?.f ? 'true' : undefined}
        >
          <span>{text}</span>
        </div>,
      );
      merge = undefined;
    }
  }

  const selRange = range;
  const activeMerge = mergeAt(sheet, sel.fr, sel.fc);
  const activeBox = activeMerge ?? { r1: sel.fr, c1: sel.fc, r2: sel.fr, c2: sel.fc };
  const box = (rg: Range): CSSProperties => ({ left: colOffs[rg.c1], top: rowOffs[rg.r1], width: colOffs[rg.c2 + 1]! - colOffs[rg.c1]!, height: rowOffs[rg.r2 + 1]! - rowOffs[rg.r1]! });

  const formulaValue = editing ?? rawInput(activeCell);

  return (
    <div className="sheet-editor">
      {!readOnly && (
        <div className="sheet-toolbar" role="toolbar" aria-label={t('sheet.toolbar')}>
          <button type="button" className="icon-button" onClick={() => void restore(undo.current, redo.current)} disabled={!undo.current.length} aria-label={t('editor.undo')} title={`${t('editor.undo')} (Ctrl+Z)`}>
            <Undo2 size={15} aria-hidden />
          </button>
          <button type="button" className="icon-button" onClick={() => void restore(redo.current, undo.current)} disabled={!redo.current.length} aria-label={t('editor.redo')} title={`${t('editor.redo')} (Ctrl+Y)`}>
            <Redo2 size={15} aria-hidden />
          </button>
          {formatting && (
            <>
              <span className="sheet-toolbar-sep" aria-hidden />
              {([['bold', Bold, 'Ctrl+B'], ['italic', Italic, 'Ctrl+I'], ['underline', Underline, ''], ['strike', Strikethrough, '']] as const).map(([key, Icon, hint]) => (
                <button key={key} type="button" className="icon-button" aria-pressed={Boolean(activeStyle[key])} onClick={() => toggle(key)} aria-label={t(`sheet.${key}`)} title={hint ? `${t(`sheet.${key}`)} (${hint})` : t(`sheet.${key}`)}>
                  <Icon size={15} aria-hidden />
                </button>
              ))}
              <label className="icon-button sheet-color" title={t('sheet.textColor')}>
                <Type size={15} aria-hidden />
                <input type="color" aria-label={t('sheet.textColor')} value={activeStyle.color ?? '#000000'} onChange={(e) => { const color = e.currentTarget.value.toUpperCase(); restyle((s) => ({ ...s, color })); }} />
              </label>
              <label className="icon-button sheet-color" title={t('sheet.fillColor')}>
                <Paintbrush size={15} aria-hidden />
                <input type="color" aria-label={t('sheet.fillColor')} value={activeStyle.fill ?? '#FFFFFF'} onChange={(e) => { const fill = e.currentTarget.value.toUpperCase(); restyle((s) => ({ ...s, fill })); }} />
              </label>
              <select className="input sheet-select" aria-label={t('sheet.fontSize')} value={activeStyle.fontSize ?? ''} onChange={(e) => { const size = Number(e.currentTarget.value); restyle((s) => { const next = { ...s }; if (size) next.fontSize = size; else delete next.fontSize; return next; }); }}>
                <option value="">{t('sheet.fontSize')}</option>
                {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <span className="sheet-toolbar-sep" aria-hidden />
              {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight]] as const).map(([align, Icon]) => (
                <button key={align} type="button" className="icon-button" aria-pressed={activeStyle.hAlign === align} onClick={() => restyle((s) => ({ ...s, hAlign: s.hAlign === align ? undefined : align }))} aria-label={t(`sheet.align_${align}`)} title={t(`sheet.align_${align}`)}>
                  <Icon size={15} aria-hidden />
                </button>
              ))}
              <button type="button" className="icon-button" aria-pressed={Boolean(activeStyle.wrap)} onClick={() => toggle('wrap')} aria-label={t('sheet.wrap')} title={t('sheet.wrap')}>
                <WrapText size={15} aria-hidden />
              </button>
              <button type="button" className="icon-button" onClick={toggleMerge} aria-label={t('sheet.merge')} title={t('sheet.merge')}>
                <Combine size={15} aria-hidden />
              </button>
              <select className="input sheet-select" aria-label={t('sheet.borders')} value="" onChange={(e) => { const mode = e.currentTarget.value as 'all' | 'outer' | 'none'; if (mode) setBorders(mode); }}>
                <option value="">{t('sheet.borders')}</option>
                <option value="all">{t('sheet.borders_all')}</option>
                <option value="outer">{t('sheet.borders_outer')}</option>
                <option value="none">{t('sheet.borders_none')}</option>
              </select>
              <select className="input sheet-select" aria-label={t('sheet.numberFormat')} value={activeStyle.numFmt ?? 'General'} onChange={(e) => { const numFmt = e.currentTarget.value; restyle((s) => { const next = { ...s }; if (numFmt === 'General') delete next.numFmt; else next.numFmt = numFmt; return next; }); }}>
                {(NUMBER_FORMATS.includes(activeStyle.numFmt ?? 'General') ? NUMBER_FORMATS : [activeStyle.numFmt!, ...NUMBER_FORMATS]).map((f) => <option key={f} value={f}>{f === 'General' ? t('sheet.formatGeneral') : f}</option>)}
              </select>
            </>
          )}
          <span className="sheet-toolbar-sep" aria-hidden />
          <select className="input sheet-select" aria-label={t('sheet.rowsColumns')} value="" onChange={(e) => { const kind = e.currentTarget.value as Parameters<typeof structural>[0]; if (kind) structural(kind); }}>
            <option value="">{t('sheet.rowsColumns')}</option>
            <option value="rowAbove">{t('sheet.insertRowAbove')}</option>
            <option value="rowBelow">{t('sheet.insertRowBelow')}</option>
            <option value="colLeft">{t('sheet.insertColLeft')}</option>
            <option value="colRight">{t('sheet.insertColRight')}</option>
            <option value="deleteRows">{t('sheet.deleteRows')}</option>
            <option value="deleteCols">{t('sheet.deleteCols')}</option>
          </select>
        </div>
      )}
      <div className="sheet-formula-bar">
        <span className="sheet-address" aria-label={t('sheet.cell')}>{activeMerge ? address(activeMerge.r1, activeMerge.c1) : address(sel.fr, sel.fc)}</span>
        <input
          className="input sheet-formula-input"
          aria-label={formulas ? t('sheet.formulaBar') : t('sheet.valueBar')}
          value={formulaValue}
          readOnly={readOnly || !engineReady}
          onFocus={() => editing === null && !readOnly && setEditing(rawInput(activeCell))}
          onChange={(e) => setEditing(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value); }
            else if (e.key === 'Escape') { setEditing(null); scroller.current?.focus(); }
          }}
        />
      </div>
      <div className="sheet-grid" style={{ '--sheet-header-w': `${HEADER_W}px`, '--sheet-header-h': `${HEADER_H}px` } as CSSProperties}>
        <div className="sheet-corner" aria-hidden />
        <div className="sheet-col-headers" aria-hidden>
          <div ref={colHeader} className="sheet-header-track" style={{ width: colOffs[colCount] }}>
            {Array.from({ length: c2 - c1 + 1 }, (_, i) => c1 + i).map((c) => (
              <div key={c} className={`sheet-col-header${c >= selRange.c1 && c <= selRange.c2 ? ' active' : ''}`} style={{ left: colOffs[c], width: colOffs[c + 1]! - colOffs[c]! }}>
                {columnName(c)}
                <span className="sheet-resize sheet-resize-col" onPointerDown={(e) => resize('col', c, e)} />
              </div>
            ))}
          </div>
        </div>
        <div className="sheet-row-headers" aria-hidden>
          <div ref={rowHeader} className="sheet-header-track" style={{ height: rowOffs[rowCount] }}>
            {Array.from({ length: r2 - r1 + 1 }, (_, i) => r1 + i).map((r) => (
              <div key={r} className={`sheet-row-header${r >= selRange.r1 && r <= selRange.r2 ? ' active' : ''}`} style={{ top: rowOffs[r], height: rowOffs[r + 1]! - rowOffs[r]! }}>
                {r + 1}
                <span className="sheet-resize sheet-resize-row" onPointerDown={(e) => resize('row', r, e)} />
              </div>
            ))}
          </div>
        </div>
        <div
          ref={scroller}
          className="sheet-scroller"
          tabIndex={0}
          role="grid"
          aria-label={sheet.name}
          aria-rowcount={rowCount}
          aria-colcount={colCount}
          aria-readonly={readOnly}
          onScroll={onScroll}
          onFocus={(e) => {
            // Typing goes to the cell input, so IME, on-screen keyboards and pasted text start an edit too.
            if (e.target === e.currentTarget && !readOnly) editor.current?.focus({ preventScroll: true });
          }}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => (dragging.current = false)}
          onDoubleClick={() => !readOnly && setEditing(rawInput(activeCell))}
        >
          <div className="sheet-canvas" style={{ width: colOffs[colCount], height: rowOffs[rowCount] }}>
            {cells}
            <div className="sheet-selection" style={box(selRange)} aria-hidden />
            <div className="sheet-active" style={box(activeBox)} aria-hidden />
            {!readOnly && (
              <textarea
                // Idle (not editing) it is invisible and only receives typing; on touch it is
                // remounted for an edit so the on-screen keyboard opens.
                key={touch && editing !== null ? 'edit' : 'idle'}
                ref={editor}
                className={`sheet-cell-editor${editing === null ? ' idle' : ''}`}
                style={{ ...box(activeBox), ...cellCss(activeCell?.s, false) }}
                value={editing ?? ''}
                inputMode={editing === null && touch ? 'none' : undefined}
                aria-label={t('sheet.editCell', { cell: address(sel.fr, sel.fc) })}
                onChange={(e) => setEditing(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (editing === null) return; // navigation keys are handled by the grid
                  if (e.key === 'Enter' && !e.altKey) { e.preventDefault(); commit(e.currentTarget.value, e.shiftKey ? 'none' : 'down'); }
                  else if (e.key === 'Tab') { e.preventDefault(); commit(e.currentTarget.value, 'right'); }
                  else if (e.key === 'Escape') { e.preventDefault(); setEditing(null); scroller.current?.focus(); }
                }}
                onBlur={(e) => editing !== null && commit(e.currentTarget.value, 'none')}
              />
            )}
          </div>
        </div>
      </div>
      {(multipleSheets || book.sheets.length > 1) && (
        <div className="sheet-tabs" role="tablist" aria-label={t('sheet.sheets')}>
          {book.sheets.map((s, i) =>
            renaming === i ? (
              <input key={i} className="input sheet-tab-input" autoFocus defaultValue={s.name} aria-label={t('sheet.rename')}
                onBlur={(e) => renameSheet(i, e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') renameSheet(i, e.currentTarget.value); else if (e.key === 'Escape') setRenaming(null); }} />
            ) : (
              <span key={i} className="sheet-tab-wrap">
                <button type="button" role="tab" aria-selected={i === active} className="sheet-tab" onClick={() => { setActive(i); setSel({ ar: 0, ac: 0, fr: 0, fc: 0 }); }} onDoubleClick={() => multipleSheets && !readOnly && setRenaming(i)} title={multipleSheets && !readOnly ? t('sheet.renameHint') : undefined}>
                  <Table2 size={13} aria-hidden />
                  {s.name}
                </button>
                {multipleSheets && !readOnly && i === active && (
                  <>
                    <button type="button" className="icon-button small" onClick={() => moveSheet(i, -1)} disabled={i === 0} aria-label={t('sheet.moveLeft')} title={t('sheet.moveLeft')}>‹</button>
                    <button type="button" className="icon-button small" onClick={() => moveSheet(i, 1)} disabled={i === book.sheets.length - 1} aria-label={t('sheet.moveRight')} title={t('sheet.moveRight')}>›</button>
                    <button type="button" className="icon-button small icon-button-danger" onClick={() => removeSheet(i)} disabled={book.sheets.length < 2} aria-label={t('sheet.delete')} title={t('sheet.delete')}>
                      <Trash2 size={12} aria-hidden />
                    </button>
                  </>
                )}
              </span>
            ),
          )}
          {multipleSheets && !readOnly && (
            <button type="button" className="icon-button small" onClick={addSheet} aria-label={t('sheet.add')} title={t('sheet.add')}>
              <Plus size={14} aria-hidden />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
