import type { DocumentMeta, SessionSaveState } from '@mdr/core';
import { useTranslation } from '@mdr/i18n';
import { useEffect, useRef, useState } from 'react';
import { FileAutosaver, forkWithEdits } from '../file-documents.ts';
import { FormulaEngine } from './formulas.ts';
import type { Workbook } from './model.ts';
import { readOds, writeOds } from './ods.ts';
import { SheetEditor } from './SheetEditor.tsx';
import { readXlsx, writeXlsx } from './xlsx.ts';

interface Loaded {
  book: Workbook;
  unsupported: string[];
  write: (book: Workbook) => Promise<Uint8Array>;
}

async function load(format: 'xlsx' | 'ods', bytes: Uint8Array): Promise<Loaded> {
  const loaded = format === 'xlsx'
    ? await readXlsx(bytes).then(({ book, context, unsupported }) => ({ book, unsupported, write: (b: Workbook) => writeXlsx(b, context) }))
    : (() => {
        const { book, context, unsupported } = readOds(bytes);
        return { book, unsupported, write: async (b: Workbook) => writeOds(b, context) };
      })();
  // Functions HyperFormula does not know would lose their results on the next save.
  const engine = await FormulaEngine.create(loaded.book);
  if (engine.hasUnknownFunctions(loaded.book) && !loaded.unsupported.includes('formulas')) loaded.unsupported.push('formulas');
  engine.destroy();
  return loaded;
}

/** xlsx/ods document: the spreadsheet editor with autosave (lazy-loaded with ExcelJS and HyperFormula). */
export default function SpreadsheetFile({ meta, bytes, onError, onSaveState }: {
  meta: DocumentMeta;
  bytes: Uint8Array;
  onError(error: unknown): void;
  onSaveState(state: SessionSaveState, version?: string): void;
}) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const saver = useRef<FileAutosaver | null>(null);
  const forked = useRef(false);
  const format = meta.mime?.includes('opendocument') ? 'ods' : 'xlsx';

  useEffect(() => {
    let cancelled = false;
    load(format, bytes).then((l) => !cancelled && setLoaded(l), (error: unknown) => !cancelled && onError(error));
    return () => {
      cancelled = true;
    };
  }, [bytes, format, onError]);

  useEffect(() => {
    saver.current = new FileAutosaver(meta.id, meta.contentHash, onSaveState);
    return () => {
      void saver.current?.dispose();
      saver.current = null;
    };
    // One autosaver per opened document; its version then follows its own saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id]);

  if (!loaded) return <p className="muted file-loading">{t('app.loading')}</p>;
  return (
    <SheetEditor
      book={loaded.book}
      formulas
      formatting
      multipleSheets
      onChange={() => {
        const serialize = () => loaded.write(loaded.book);
        if (loaded.unsupported.length) {
          // The original keeps what Mavyn cannot save; the edits go to a copy.
          if (forked.current) return;
          forked.current = true;
          void serialize().then((edited) => forkWithEdits(meta.id, edited, loaded.unsupported), onError);
          return;
        }
        saver.current?.schedule(serialize);
      }}
    />
  );
}
