import type { DocumentSession } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readCsv, writeCsv, type CsvDialect } from './csv.ts';
import type { Workbook } from './model.ts';
import { SheetEditor } from './SheetEditor.tsx';

/**
 * CSV/TSV as an editable table. The document stays text (merge, search, encodings work as for any
 * text file); table edits are written back as CSV with the file's delimiter and line endings.
 */
export function CsvTable({ session, fileName }: { session: DocumentSession; fileName: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ book: Workbook; dialect: CsvDialect; text: string }>(() => ({ ...readCsv(session.text, fileName), text: session.text }));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const written = useRef(session.text);

  // Text changed elsewhere (source view, sync merge, reload): re-read the table.
  useEffect(
    () =>
      session.subscribe((event) => {
        if (event?.origin === 'table' || session.text === written.current) return;
        written.current = session.text;
        setState({ ...readCsv(session.text, fileName), text: session.text });
      }),
    [session, fileName],
  );

  const flush = useMemo(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const text = writeCsv(state.book, state.dialect);
      if (text === session.text) return;
      written.current = text;
      session.apply([{ from: 0, to: session.text.length, insert: text }], 'table', 'table');
    },
    [session, state],
  );
  useEffect(() => () => flush(), [flush]);

  return (
    <div className="sheet-editor">
      <p className="sheet-notice">{t('sheet.csvHint')}</p>
      <SheetEditor
        key={state.text}
        book={state.book}
        formulas={false}
        formatting={false}
        multipleSheets={false}
        onChange={() => {
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(flush, 400);
        }}
      />
    </div>
  );
}
