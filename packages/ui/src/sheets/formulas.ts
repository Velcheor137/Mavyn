import type { HyperFormula, RawCellContent } from 'hyperformula';
import { eachCell, extent, getCell, setCell, type CellValue, type Workbook } from './model.ts';

/**
 * Formula recalculation with HyperFormula (GPLv3; Mavyn is GPLv3 because of it). The engine owns
 * cell contents while a workbook is open: structural edits (insert/delete rows and columns, sheet
 * renames) go through it so references in formulas are adjusted, then the model is re-read.
 */
export class FormulaEngine {
  private constructor(private readonly hf: HyperFormula, private readonly ids: number[]) {}

  static async create(book: Workbook): Promise<FormulaEngine> {
    const { HyperFormula: HF } = await import('hyperformula');
    const sheets: Record<string, RawCellContent[][]> = {};
    for (const sheet of book.sheets) {
      const { rows, cols } = extent(sheet);
      const grid: RawCellContent[][] = Array.from({ length: rows + 1 }, () => Array.from({ length: cols + 1 }, () => null));
      for (const [r, c, cell] of eachCell(sheet)) grid[r]![c] = cell.f ?? cell.v;
      sheets[sheet.name] = grid;
    }
    const hf = HF.buildFromSheets(sheets, { licenseKey: 'gpl-v3', useArrayArithmetic: true });
    const ids = book.sheets.map((s) => hf.getSheetId(s.name)!);
    return new FormulaEngine(hf, ids);
  }

  /** Computed value: number, text, boolean, or an error code such as `#DIV/0!`. */
  value(sheet: number, r: number, c: number): CellValue {
    const v = this.hf.getCellValue({ sheet: this.ids[sheet]!, row: r, col: c });
    if (v === null || v === undefined) return null;
    if (typeof v === 'object') return (v as { value: string }).value;
    return v as CellValue;
  }

  setContent(sheet: number, r: number, c: number, content: string | number | boolean | null): void {
    this.hf.setCellContents({ sheet: this.ids[sheet]!, row: r, col: c }, [[content]]);
  }

  insertRows(sheet: number, at: number, count: number): void {
    this.hf.addRows(this.ids[sheet]!, [at, count]);
  }

  removeRows(sheet: number, at: number, count: number): void {
    this.hf.removeRows(this.ids[sheet]!, [at, count]);
  }

  insertCols(sheet: number, at: number, count: number): void {
    this.hf.addColumns(this.ids[sheet]!, [at, count]);
  }

  removeCols(sheet: number, at: number, count: number): void {
    this.hf.removeColumns(this.ids[sheet]!, [at, count]);
  }

  addSheet(name: string, index: number): void {
    const added = this.hf.addSheet(name);
    this.ids.splice(index, 0, this.hf.getSheetId(added)!);
  }

  removeSheet(index: number): void {
    this.hf.removeSheet(this.ids[index]!);
    this.ids.splice(index, 1);
  }

  renameSheet(index: number, name: string): void {
    this.hf.renameSheet(this.ids[index]!, name);
  }

  moveSheet(from: number, to: number): void {
    const [id] = this.ids.splice(from, 1);
    this.ids.splice(to, 0, id!);
  }

  /** Whether `name` would be accepted as a sheet name (unique, valid). */
  isSheetNameFree(name: string): boolean {
    return this.hf.isItPossibleToAddSheet(name);
  }

  /**
   * Re-reads formulas (references may have moved) and computed values into the model. Cells whose
   * formula text changed are marked edited so they are written explicitly.
   */
  syncInto(book: Workbook): void {
    book.sheets.forEach((sheet, index) => {
      const id = this.ids[index]!;
      for (const [r, c, cell] of eachCell(sheet)) {
        if (!cell.f) continue;
        const formula = this.hf.getCellFormula({ sheet: id, row: r, col: c });
        if (formula && formula !== cell.f) setCell(sheet, r, c, { ...cell, f: formula, edited: true });
      }
      this.refreshValues(book, index);
    });
  }

  /** Copies computed values of formula cells into `v` (the cached result written to the file). */
  refreshValues(book: Workbook, index: number): void {
    const sheet = book.sheets[index]!;
    for (const [r, c, cell] of eachCell(sheet)) {
      if (cell.f) cell.v = this.value(index, r, c);
    }
  }

  /** True when any formula uses a function the engine does not know (`#NAME?`). */
  hasUnknownFunctions(book: Workbook): boolean {
    return book.sheets.some((sheet, index) => {
      for (const [r, c, cell] of eachCell(sheet)) {
        if (cell.f && this.value(index, r, c) === '#NAME?') return true;
      }
      return false;
    });
  }

  destroy(): void {
    this.hf.destroy();
  }
}

/** Contents for the engine from typed input: formulas when enabled, otherwise literal text. */
export function engineContent(book: Workbook, sheet: number, r: number, c: number): string | number | boolean | null {
  const cell = getCell(book.sheets[sheet]!, r, c);
  return cell?.f ?? cell?.v ?? null;
}
