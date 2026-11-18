import { useTranslation } from '@mdr/i18n';
import { useEffect, useMemo, useState } from 'react';
import type { WorkBook, WorkSheet } from 'xlsx';

type Sheets = { names: string[]; book: WorkBook; utils: typeof import('xlsx').utils };

const ROW_STEP = 500;
const MAX_COLS = 200;

interface Grid {
  rows: string[][];
  totalRows: number;
  cols: number;
  /** `r:c` → span of a merged range's top-left cell; covered cells are listed in `hidden`. */
  spans: Map<string, { rowSpan: number; colSpan: number }>;
  hidden: Set<string>;
}

function buildGrid(sheet: WorkSheet, utils: Sheets['utils'], rowLimit: number): Grid {
  // Formatted text (`w`) as Excel shows it; formulas are never evaluated, only cached values.
  // Start at A1 so row/column labels and merged ranges line up with the sheet's addresses.
  const range = utils.decode_range(sheet['!ref'] ?? 'A1');
  range.s = { r: 0, c: 0 };
  const all = utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true, range });
  const rows = all.slice(0, rowLimit);
  const cols = Math.min(MAX_COLS, rows.reduce((max, row) => Math.max(max, row.length), 0));
  const spans = new Map<string, { rowSpan: number; colSpan: number }>();
  const hidden = new Set<string>();
  for (const merge of sheet['!merges'] ?? []) {
    spans.set(`${merge.s.r}:${merge.s.c}`, { rowSpan: merge.e.r - merge.s.r + 1, colSpan: merge.e.c - merge.s.c + 1 });
    for (let r = merge.s.r; r <= merge.e.r; r++) {
      for (let c = merge.s.c; c <= merge.e.c; c++) if (r !== merge.s.r || c !== merge.s.c) hidden.add(`${r}:${c}`);
    }
  }
  return { rows, totalRows: all.length, cols, spans, hidden };
}

export default function SheetViewer({ bytes, onError }: { bytes: Uint8Array; onError(error: unknown): void }) {
  const { t } = useTranslation();
  const [sheets, setSheets] = useState<Sheets | null>(null);
  const [active, setActive] = useState(0);
  const [rowLimit, setRowLimit] = useState(ROW_STEP);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { read, utils } = await import('xlsx');
        const book = read(bytes, { type: 'array', dense: true, cellFormula: false, cellHTML: false, cellStyles: false, bookVBA: false });
        if (!cancelled) setSheets({ names: book.SheetNames, book, utils });
      } catch (error) {
        if (!cancelled) onError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, onError]);

  const grid = useMemo(() => {
    const name = sheets?.names[active];
    const sheet = name ? sheets.book.Sheets[name] : undefined;
    return sheet && sheets ? buildGrid(sheet, sheets.utils, rowLimit) : null;
  }, [sheets, active, rowLimit]);

  if (!sheets) return <p className="muted file-loading">{t('app.loading')}</p>;

  return (
    <div className="file-sheet">
      {sheets.names.length > 1 && (
        <div className="sheet-tabs" role="tablist" aria-label={t('viewer.sheets')}>
          {sheets.names.map((name, i) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={i === active}
              className="sheet-tab"
              onClick={() => {
                setActive(i);
                setRowLimit(ROW_STEP);
              }}
            >
              {name}
            </button>
          ))}
        </div>
      )}
      {grid && grid.rows.length === 0 && <p className="muted file-loading">{t('viewer.emptySheet')}</p>}
      {grid && grid.rows.length > 0 && (
        <div className="sheet-scroll">
          <table className="sheet-table">
            <thead>
              <tr>
                <th aria-hidden />
                {Array.from({ length: grid.cols }, (_, c) => (
                  <th key={c} scope="col">{sheets.utils.encode_col(c)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row, r) => (
                <tr key={r}>
                  <th scope="row">{r + 1}</th>
                  {Array.from({ length: grid.cols }, (_, c) => {
                    const key = `${r}:${c}`;
                    if (grid.hidden.has(key)) return null;
                    const span = grid.spans.get(key);
                    return (
                      <td key={c} rowSpan={span?.rowSpan} colSpan={span?.colSpan}>
                        {row[c] ?? ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {grid.totalRows > grid.rows.length && (
            <button type="button" className="button sheet-more" onClick={() => setRowLimit((n) => n + ROW_STEP * 4)}>
              {t('viewer.moreRows', { shown: grid.rows.length, total: grid.totalRows })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
