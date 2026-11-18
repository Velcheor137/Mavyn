import { emptySheet, eachCell, extent, setCell, type Workbook } from './model.ts';

/**
 * CSV/TSV as a one-sheet table. Cells stay the exact text of the file (no number parsing), so a
 * save writes unchanged cells byte for byte; formulas and formatting do not exist in CSV.
 */
export interface CsvDialect {
  delimiter: ',' | ';' | '\t' | '|';
  lineEnding: '\n' | '\r\n';
  /** Whether the text ended with a line break. */
  finalNewline: boolean;
}

/** Picks the delimiter that splits the first lines into the most consistent number of fields. */
export function detectDialect(text: string, fileName = ''): CsvDialect {
  const lineEnding = text.includes('\r\n') ? '\r\n' : '\n';
  const finalNewline = text.endsWith('\n');
  if (/\.tsv$/i.test(fileName)) return { delimiter: '\t', lineEnding, finalNewline };
  const sample = text.slice(0, 64 * 1024);
  let best: CsvDialect['delimiter'] = ',';
  let bestScore = -1;
  for (const delimiter of [',', ';', '\t', '|'] as const) {
    const rows = parseRows(sample, delimiter).slice(0, 20).filter((r) => r.length > 1 || r[0] !== '');
    if (rows.length === 0) continue;
    const widths = rows.map((r) => r.length);
    const first = widths[0]!;
    if (first < 2) continue;
    const consistent = widths.filter((w) => w === first).length;
    const score = consistent * 1000 + first;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }
  return { delimiter: best, lineEnding, finalNewline };
}

/** RFC 4180 parsing (quotes, doubled quotes, line breaks inside quotes). */
export function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function readCsv(text: string, fileName: string): { book: Workbook; dialect: CsvDialect } {
  const dialect = detectDialect(text, fileName);
  const sheet = emptySheet(fileName.replace(/\.[^.]+$/, '') || 'Sheet1');
  parseRows(text, dialect.delimiter).forEach((row, r) => {
    row.forEach((value, c) => {
      if (value !== '') setCell(sheet, r, c, { v: value });
    });
  });
  return { book: { sheets: [sheet] }, dialect };
}

function quote(value: string, delimiter: string): string {
  return /["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function writeCsv(book: Workbook, dialect: CsvDialect): string {
  const sheet = book.sheets[0];
  if (!sheet) return '';
  const { rows, cols } = extent(sheet);
  const grid: string[][] = Array.from({ length: rows + 1 }, () => Array.from({ length: cols + 1 }, () => ''));
  for (const [r, c, cell] of eachCell(sheet)) grid[r]![c] = cell.v === null ? '' : String(cell.v);
  // Rectangular like spreadsheet programs write it: every row has the full number of fields.
  const lines = grid.map((row) => row.map((v) => quote(v, dialect.delimiter)).join(dialect.delimiter));
  const text = lines.join(dialect.lineEnding);
  return dialect.finalNewline && text !== '' ? text + dialect.lineEnding : text;
}
