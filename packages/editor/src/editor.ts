import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { DocumentSession, TextEdit } from '@mdr/core';
import { formatCommands, type FormatCommand } from './commands.ts';
import { chooseLineSeparator, OffsetMapper } from './offsets.ts';

/** Marks transactions that mirror session changes, so they are not fed back into the session. */
const fromSession = Annotation.define<boolean>();

export interface EditorOptions {
  lineNumbers: boolean;
  wrap: boolean;
  readOnly?: boolean;
}

export interface MarkdownEditorConfig {
  parent: HTMLElement;
  session: DocumentSession;
  options: EditorOptions;
  ariaLabel: string;
  placeholder?: string;
  /** Called with the 1-based source line at the top of the viewport (for split-view sync). */
  onTopLineChange?: (line: number) => void;
}

export interface MarkdownEditor {
  view: EditorView;
  setOptions(options: EditorOptions): void;
  scrollToLine(line: number): void;
  format(command: FormatCommand): void;
  focus(): void;
  destroy(): void;
}

const highlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: '600', color: 'var(--color-fg)' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.link, tags.url], color: 'var(--color-accent)' },
  { tag: [tags.monospace, tags.processingInstruction], color: 'var(--color-code-fg)' },
  { tag: [tags.meta, tags.comment, tags.contentSeparator], color: 'var(--color-fg-muted)' },
  { tag: tags.quote, color: 'var(--color-fg-muted)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--color-syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--color-syntax-string)' },
  { tag: [tags.number, tags.bool, tags.atom], color: 'var(--color-syntax-number)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'var(--editor-font-size, 14px)', backgroundColor: 'transparent', color: 'var(--color-fg)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '16px 0', caretColor: 'var(--color-accent)' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--color-fg-subtle)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--color-hover)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--color-selection) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--color-accent)' },
  '.cm-panels': { backgroundColor: 'var(--color-surface)', color: 'var(--color-fg)', borderColor: 'var(--color-border)' },
  '.cm-searchMatch': { backgroundColor: 'var(--color-search-match)' },
});

export function createMarkdownEditor(config: MarkdownEditorConfig): MarkdownEditor {
  const { session } = config;
  const separator = chooseLineSeparator(session.text);
  const mapper = new OffsetMapper(separator);
  const optionsCompartment = new Compartment();

  const optionExtensions = (options: EditorOptions): Extension => [
    options.lineNumbers ? [lineNumbers(), highlightActiveLineGutter()] : [],
    options.wrap ? EditorView.lineWrapping : [],
    EditorState.readOnly.of(options.readOnly ?? false),
  ];

  const toSession = EditorView.updateListener.of((update) => {
    if (update.docChanged && !update.transactions.some((tr) => tr.annotation(fromSession))) {
      const edits: TextEdit[] = [];
      const startDoc = update.startState.doc;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        edits.push({
          from: mapper.toOffset(startDoc, fromA),
          to: mapper.toOffset(startDoc, toA),
          insert: inserted.sliceString(0, inserted.length, separator),
        });
      });
      session.apply(edits, 'editor', 'typing');
    }
    if (config.onTopLineChange && (update.viewportChanged || update.geometryChanged)) {
      const block = update.view.lineBlockAtHeight(update.view.scrollDOM.scrollTop);
      config.onTopLineChange(update.state.doc.lineAt(block.from).number);
    }
  });

  const view = new EditorView({
    parent: config.parent,
    state: EditorState.create({
      doc: session.text,
      extensions: [
        EditorState.lineSeparator.of(separator),
        highlightSpecialChars(),
        drawSelection(),
        highlightActiveLine(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightSelectionMatches(),
        search({ top: true }),
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        syntaxHighlighting(highlight),
        theme,
        config.placeholder ? placeholderExt(config.placeholder) : [],
        EditorView.contentAttributes.of({ 'aria-label': config.ariaLabel, spellcheck: 'true', autocorrect: 'off' }),
        // History lives in the DocumentSession so undo spans task toggles and survives autosave.
        keymap.of([
          { key: 'Mod-z', run: () => session.undo(), preventDefault: true },
          { key: 'Mod-Shift-z', run: () => session.redo(), preventDefault: true },
          { key: 'Mod-y', run: () => session.redo(), preventDefault: true },
          { key: 'Mod-b', run: formatCommands.bold },
          { key: 'Mod-i', run: formatCommands.italic },
          { key: 'Mod-k', run: formatCommands.link },
          ...closeBracketsKeymap,
          ...searchKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),
        optionsCompartment.of(optionExtensions(config.options)),
        toSession,
      ],
    }),
  });

  // Mirror edits from other sources (checkbox toggles, undo/redo, external reloads).
  const unsubscribe = session.subscribe((event) => {
    if (!event || event.origin === 'editor') return;
    const doc = view.state.doc;
    const changes = event.edits.map((edit) => ({
      from: mapper.toPos(doc, edit.from),
      to: mapper.toPos(doc, edit.to),
      insert: edit.insert,
    }));
    view.dispatch({ changes, annotations: [fromSession.of(true)] });
    if (view.state.sliceDoc() !== session.text) {
      // Should not happen; resynchronise rather than diverge silently.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: session.text }, annotations: [fromSession.of(true)] });
    }
  });

  return {
    view,
    setOptions(options) {
      view.dispatch({ effects: optionsCompartment.reconfigure(optionExtensions(options)) });
    },
    scrollToLine(line) {
      const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: 'start' }) });
    },
    format(command) {
      formatCommands[command](view);
      view.focus();
    },
    focus() {
      view.focus();
    },
    destroy() {
      unsubscribe();
      view.destroy();
    },
  };
}
