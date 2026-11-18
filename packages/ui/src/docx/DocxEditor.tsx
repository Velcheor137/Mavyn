import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-tables/style/tables.css';
import { useTranslation } from '@mdr/i18n';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Highlighter,
  ImagePlus,
  IndentDecrease,
  IndentIncrease,
  Italic,
  List,
  ListOrdered,
  Redo2,
  Strikethrough,
  Table,
  Type,
  Underline,
  Undo2,
} from 'lucide-react';
import { baseKeymap, toggleMark } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import type { MarkType, Node as PMNode } from 'prosemirror-model';
import { EditorState, NodeSelection, Plugin, type Command, type Transaction } from 'prosemirror-state';
import { addColumnAfter, addColumnBefore, addRowAfter, addRowBefore, deleteColumn, deleteRow, deleteTable, goToNextCell, isInTable, tableEditing } from 'prosemirror-tables';
import { EditorView } from 'prosemirror-view';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { emuToPx, HIGHLIGHT_NAMES, pxToEmu, schema } from './convert.ts';
import { addImage, ensureList, type DocxPackage } from './package.ts';

const FONTS = ['Calibri', 'Arial', 'Times New Roman', 'Cambria', 'Georgia', 'Verdana', 'Courier New'];
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif'];

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return Boolean(type.isInSet(state.storedMarks ?? $from.marks()));
  return state.doc.rangeHasMark(from, to, type);
}

function setMark(type: MarkType, attrs: Record<string, unknown> | null): Command {
  return (state, dispatch) => {
    const { from, to, empty } = state.selection;
    if (!dispatch) return true;
    const tr = state.tr;
    if (empty) {
      tr.removeStoredMark(type);
      if (attrs) tr.addStoredMark(type.create(attrs));
    } else {
      tr.removeMark(from, to, type);
      if (attrs) tr.addMark(from, to, type.create(attrs));
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Applies `patch` to the attributes of every paragraph in the selection. */
function setParagraphs(patch: (attrs: Record<string, unknown>) => Record<string, unknown>): Command {
  return (state, dispatch) => {
    const { from, to } = state.selection;
    const tr = state.tr;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (node.type !== schema.nodes.paragraph) return true;
      tr.setNodeMarkup(pos, undefined, patch({ ...node.attrs }));
      return false;
    });
    if (dispatch) dispatch(tr.scrollIntoView());
    return true;
  };
}

function currentParagraph(state: EditorState): PMNode | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 0; d--) if ($from.node(d).type === schema.nodes.paragraph) return $from.node(d);
  return null;
}

function newTable(rows: number, cols: number): PMNode {
  const cell = () => schema.nodes.table_cell!.create(null, schema.nodes.paragraph!.create());
  const borders = '<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr>';
  return schema.nodes.table!.create({ tblPr: borders, grid: Array.from({ length: cols }, () => 2400) }, Array.from({ length: rows }, () => schema.nodes.table_row!.create(null, Array.from({ length: cols }, cell))));
}

function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 200, height: img.naturalHeight || 150 });
    img.onerror = () => resolve({ width: 200, height: 150 });
    img.src = src;
  });
}

/** CSS of the document's paragraph styles, scoped to the editor. */
function documentCss(pkg: DocxPackage): string {
  const rules = [`.docx-editor .ProseMirror{${pkg.defaultCss}}`];
  for (const style of pkg.styles) {
    const fallback = style.heading ? `font-weight:600;font-size:${[0, 20, 16, 14, 13, 12, 11, 11, 11, 11][style.heading]}pt;` : '';
    rules.push(`.docx-editor [data-style="${CSS.escape(style.id)}"]{${fallback}${style.css}}`);
  }
  return rules.join('\n');
}

export interface DocxEditorProps {
  pkg: DocxPackage;
  doc: PMNode;
  onChange(doc: PMNode): void;
}

/**
 * Word document editor: text, character and paragraph formatting, document styles, lists, tables
 * and pictures. Layout is close to Word (page width, styles) but not paginated; the exact page view
 * is the viewer. Pasted content is reduced to the schema (no scripts, remote images or links).
 */
export function DocxEditor({ pkg, doc, onChange }: DocxEditorProps) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const css = useMemo(() => documentCss(pkg), [pkg]);
  const changed = useRef(onChange);
  changed.current = onChange;

  const insertImageFile = async (file: File) => {
    const v = view.current;
    if (!v || !IMAGE_TYPES.includes(file.type)) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const rid = addImage(pkg, bytes, file.type);
    const src = pkg.images.get(rid) ?? '';
    const size = await imageSize(src);
    const scale = Math.min(1, pkg.pageWidthPx / size.width);
    const node = schema.nodes.image!.create({ rid, src, cx: pxToEmu(size.width * scale), cy: pxToEmu(size.height * scale) });
    v.dispatch(v.state.tr.replaceSelectionWith(node).scrollIntoView());
    v.focus();
  };

  useEffect(() => {
    const pastePictures = new Plugin({
      props: {
        handlePaste: (_view, event) => {
          const files = [...(event.clipboardData?.files ?? [])].filter((f) => IMAGE_TYPES.includes(f.type));
          if (!files.length) return false;
          for (const f of files) void insertImageFile(f);
          return true;
        },
        handleDrop: (_view, event) => {
          const files = [...((event as DragEvent).dataTransfer?.files ?? [])].filter((f) => IMAGE_TYPES.includes(f.type));
          if (!files.length) return false;
          for (const f of files) void insertImageFile(f);
          return true;
        },
      },
    });
    const state = EditorState.create({
      doc,
      plugins: [
        history(),
        keymap({
          'Mod-z': undo,
          'Mod-Shift-z': redo,
          'Mod-y': redo,
          'Mod-b': toggleMark(schema.marks.bold!),
          'Mod-i': toggleMark(schema.marks.italic!),
          'Mod-u': toggleMark(schema.marks.underline!),
          'Shift-Enter': (s, d) => {
            if (d) d(s.tr.replaceSelectionWith(schema.nodes.hard_break!.create()).scrollIntoView());
            return true;
          },
          Tab: goToNextCell(1),
          'Shift-Tab': goToNextCell(-1),
        }),
        keymap(baseKeymap),
        tableEditing(),
        pastePictures,
      ],
    });
    const v = new EditorView(host.current!, {
      state,
      attributes: { class: 'docx-page', spellcheck: 'true', 'aria-label': t('docx.editorLabel'), role: 'textbox', 'aria-multiline': 'true' },
      dispatchTransaction(tr: Transaction) {
        const next = v.state.apply(tr);
        v.updateState(next);
        rerender();
        if (tr.docChanged) changed.current(next.doc);
      },
    });
    view.current = v;
    rerender();
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once per loaded document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  const run = (command: Command) => {
    const v = view.current;
    if (!v) return;
    command(v.state, v.dispatch);
    v.focus();
  };

  const state = view.current?.state;
  const paragraph = state ? currentParagraph(state) : null;
  const inTable = state ? isInTable(state) : false;
  const selectedImage = state?.selection instanceof NodeSelection && state.selection.node.type === schema.nodes.image ? state.selection.node : null;
  const isActive = (type: MarkType) => (state ? markActive(state, type) : false);
  const styleOptions = pkg.styles.filter((s) => s.heading || /normal|title|subtitle|quote|list/i.test(s.name)).sort((a, b) => (a.heading ?? 0) - (b.heading ?? 0));

  const toggleList = (kind: 'bullet' | 'decimal') => {
    const numId = paragraph?.attrs.listKind === kind ? null : ensureList(pkg, kind);
    run(setParagraphs((a) => ({ ...a, numId, listKind: numId ? kind : null, ilvl: numId ? a.ilvl : 0 })));
  };

  const resizeImage = (widthPx: number) => {
    const v = view.current;
    if (!v || !selectedImage || !(v.state.selection instanceof NodeSelection)) return;
    const ratio = (selectedImage.attrs.cy as number) / (selectedImage.attrs.cx as number);
    const cx = pxToEmu(Math.max(16, Math.min(pkg.pageWidthPx * 2, widthPx)));
    v.dispatch(v.state.tr.setNodeMarkup(v.state.selection.from, undefined, { ...selectedImage.attrs, cx, cy: Math.round(cx * ratio) }));
  };

  return (
    <div className="docx-editor">
      <style>{css}</style>
      <div className="sheet-toolbar docx-toolbar" role="toolbar" aria-label={t('docx.toolbar')}>
        <button type="button" className="icon-button" onClick={() => run(undo)} aria-label={t('editor.undo')} title={`${t('editor.undo')} (Ctrl+Z)`}><Undo2 size={15} aria-hidden /></button>
        <button type="button" className="icon-button" onClick={() => run(redo)} aria-label={t('editor.redo')} title={`${t('editor.redo')} (Ctrl+Y)`}><Redo2 size={15} aria-hidden /></button>
        <span className="sheet-toolbar-sep" aria-hidden />
        <select className="input sheet-select" aria-label={t('docx.style')} value={(paragraph?.attrs.style as string | null) ?? ''} onChange={(e) => { const style = e.currentTarget.value || null; run(setParagraphs((a) => ({ ...a, style }))); }}>
          <option value="">{t('docx.styleNormal')}</option>
          {styleOptions.filter((s) => !/^normal$/i.test(s.name)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="input sheet-select" aria-label={t('docx.font')} value="" onChange={(e) => { const name = e.currentTarget.value; if (name) run(setMark(schema.marks.font!, { name, xml: '' })); }}>
          <option value="">{t('docx.font')}</option>
          {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select className="input sheet-select" aria-label={t('sheet.fontSize')} value="" onChange={(e) => { const pt = Number(e.currentTarget.value); if (pt) run(setMark(schema.marks.size!, { half: pt * 2 })); }}>
          <option value="">{t('sheet.fontSize')}</option>
          {SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <span className="sheet-toolbar-sep" aria-hidden />
        {([['bold', Bold], ['italic', Italic], ['underline', Underline], ['strike', Strikethrough]] as const).map(([name, Icon]) => (
          <button key={name} type="button" className="icon-button" aria-pressed={isActive(schema.marks[name]!)} onClick={() => run(toggleMark(schema.marks[name]!))} aria-label={t(`sheet.${name}`)} title={t(`sheet.${name}`)}>
            <Icon size={15} aria-hidden />
          </button>
        ))}
        <label className="icon-button sheet-color" title={t('sheet.textColor')}>
          <Type size={15} aria-hidden />
          <input type="color" aria-label={t('sheet.textColor')} onChange={(e) => run(setMark(schema.marks.color!, { value: e.currentTarget.value.slice(1).toUpperCase() }))} />
        </label>
        <label className="icon-button sheet-color docx-highlight" title={t('docx.highlight')}>
          <Highlighter size={15} aria-hidden />
          <select aria-label={t('docx.highlight')} value="" onChange={(e) => { const value = e.currentTarget.value; run(setMark(schema.marks.highlight!, value === 'none' ? null : { value })); }}>
            <option value="" disabled>{t('docx.highlight')}</option>
            <option value="none">{t('docx.noHighlight')}</option>
            {HIGHLIGHT_NAMES.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <span className="sheet-toolbar-sep" aria-hidden />
        {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight], ['both', AlignJustify]] as const).map(([align, Icon]) => (
          <button key={align} type="button" className="icon-button" aria-pressed={paragraph?.attrs.align === align} onClick={() => run(setParagraphs((a) => ({ ...a, align: a.align === align ? null : align })))} aria-label={t(`docx.align_${align}`)} title={t(`docx.align_${align}`)}>
            <Icon size={15} aria-hidden />
          </button>
        ))}
        <button type="button" className="icon-button" aria-pressed={paragraph?.attrs.listKind === 'bullet'} onClick={() => toggleList('bullet')} aria-label={t('docx.bulletList')} title={t('docx.bulletList')}><List size={15} aria-hidden /></button>
        <button type="button" className="icon-button" aria-pressed={paragraph?.attrs.listKind === 'decimal'} onClick={() => toggleList('decimal')} aria-label={t('docx.numberedList')} title={t('docx.numberedList')}><ListOrdered size={15} aria-hidden /></button>
        <button type="button" className="icon-button" disabled={!paragraph?.attrs.numId} onClick={() => run(setParagraphs((a) => ({ ...a, ilvl: Math.max(0, (a.ilvl as number) - 1) })))} aria-label={t('docx.outdent')} title={t('docx.outdent')}><IndentDecrease size={15} aria-hidden /></button>
        <button type="button" className="icon-button" disabled={!paragraph?.attrs.numId} onClick={() => run(setParagraphs((a) => ({ ...a, ilvl: Math.min(8, (a.ilvl as number) + 1) })))} aria-label={t('docx.indent')} title={t('docx.indent')}><IndentIncrease size={15} aria-hidden /></button>
        <span className="sheet-toolbar-sep" aria-hidden />
        <button type="button" className="icon-button" onClick={() => run((s, d) => { if (d) d(s.tr.replaceSelectionWith(newTable(3, 3)).scrollIntoView()); return true; })} aria-label={t('docx.insertTable')} title={t('docx.insertTable')}><Table size={15} aria-hidden /></button>
        {inTable && (
          <select className="input sheet-select" aria-label={t('docx.tableActions')} value="" onChange={(e) => {
            const commands: Record<string, Command> = { rowBefore: addRowBefore, rowAfter: addRowAfter, colBefore: addColumnBefore, colAfter: addColumnAfter, deleteRow, deleteColumn, deleteTable };
            const command = commands[e.currentTarget.value];
            if (command) run(command);
          }}>
            <option value="">{t('docx.tableActions')}</option>
            <option value="rowBefore">{t('sheet.insertRowAbove')}</option>
            <option value="rowAfter">{t('sheet.insertRowBelow')}</option>
            <option value="colBefore">{t('sheet.insertColLeft')}</option>
            <option value="colAfter">{t('sheet.insertColRight')}</option>
            <option value="deleteRow">{t('docx.deleteRow')}</option>
            <option value="deleteColumn">{t('docx.deleteColumn')}</option>
            <option value="deleteTable">{t('docx.deleteTable')}</option>
          </select>
        )}
        <button type="button" className="icon-button" onClick={() => fileInput.current?.click()} aria-label={t('docx.insertImage')} title={t('docx.insertImage')}><ImagePlus size={15} aria-hidden /></button>
        <input ref={fileInput} type="file" accept={IMAGE_TYPES.join(',')} hidden onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) void insertImageFile(f); e.currentTarget.value = ''; }} />
        {selectedImage && (
          <label className="docx-image-size">
            <span>{t('docx.imageWidth')}</span>
            <input className="input" type="number" min={16} step={10} value={emuToPx(selectedImage.attrs.cx as number)} onChange={(e) => resizeImage(Number(e.currentTarget.value))} />
          </label>
        )}
      </div>
      <div className="docx-scroll">
        <div className="docx-sheet" style={{ maxWidth: `${pkg.pageWidthPx + 96}px` }}>
          <div ref={host} />
        </div>
      </div>
    </div>
  );
}
