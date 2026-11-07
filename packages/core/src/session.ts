import { AppError, toAppError } from './errors.ts';
import { fingerprint } from './hash.ts';
import { TextHistory } from './history.ts';
import { applyEdits, type TextEdit } from './text.ts';

export type EditOrigin = 'editor' | 'task' | 'history' | 'external';

export interface EditEvent {
  edits: TextEdit[];
  origin: EditOrigin;
  text: string;
}

export type SessionSaveState =
  | { kind: 'saved'; at: number }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'conflict' }
  | { kind: 'error'; code: string };

/**
 * Persists `text`, which was derived from the version identified by `baseVersion`. Must reject
 * with `file.external_change` if the stored version is no longer `baseVersion`, and resolve with
 * the new version id otherwise.
 */
export type SaveFn = (text: string, baseVersion: string) => Promise<string>;

export interface DocumentSessionOptions {
  text: string;
  version: string;
  save: SaveFn;
  autosaveDelayMs?: number;
}

type Listener = (event: EditEvent | null) => void;

/**
 * Single source of truth for an open document: text, undo history and save state. Every edit —
 * typing, checkbox toggles, undo/redo — flows through `apply()`, so views stay consistent and
 * history survives autosave.
 */
export class DocumentSession {
  private _text: string;
  private _fingerprint: string;
  private _version: string;
  private _saveState: SessionSaveState;
  private readonly history = new TextHistory();
  private readonly listeners = new Set<Listener>();
  private readonly save: SaveFn;
  private autosaveDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(options: DocumentSessionOptions) {
    this._text = options.text;
    this._fingerprint = fingerprint(options.text);
    this._version = options.version;
    this._saveState = { kind: 'saved', at: Date.now() };
    this.save = options.save;
    this.autosaveDelayMs = options.autosaveDelayMs ?? 800;
  }

  get text(): string {
    return this._text;
  }
  get fingerprint(): string {
    return this._fingerprint;
  }
  get version(): string {
    return this._version;
  }
  get saveState(): SessionSaveState {
    return this._saveState;
  }
  get canUndo(): boolean {
    return this.history.canUndo;
  }
  get canRedo(): boolean {
    return this.history.canRedo;
  }

  setAutosaveDelay(ms: number): void {
    this.autosaveDelayMs = ms;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Applies edits expressed against the current text. `group` merges rapid consecutive edits
   * (typing) into one undo step; task toggles use their own step.
   */
  apply(edits: TextEdit[], origin: EditOrigin, group: string | null = null): void {
    if (edits.length === 0) return;
    if (this._saveState.kind === 'conflict' && origin !== 'external') {
      throw new AppError('file.external_change');
    }
    const before = this._text;
    const after = applyEdits(before, edits);
    if (origin !== 'history') this.history.record(before, edits, group);
    if (origin === 'task') this.history.seal();
    this.commit(after, { edits, origin, text: after });
  }

  undo(): boolean {
    const edits = this.history.undo();
    if (!edits) return false;
    this.commit(applyEdits(this._text, edits), { edits, origin: 'history', text: '' });
    return true;
  }

  redo(): boolean {
    const edits = this.history.redo();
    if (!edits) return false;
    this.commit(applyEdits(this._text, edits), { edits, origin: 'history', text: '' });
    return true;
  }

  /** Saves immediately (e.g. Ctrl+S, closing the tab). Resolves once persisted. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.inflight) await this.inflight;
    if (this._saveState.kind !== 'dirty' && this._saveState.kind !== 'error') return;
    const text = this._text;
    this.setSaveState({ kind: 'saving' });
    const run = (async () => {
      try {
        const version = await this.save(text, this._version);
        this._version = version;
        this.setSaveState(this._text === text ? { kind: 'saved', at: Date.now() } : { kind: 'dirty' });
      } catch (error) {
        const appError = toAppError(error);
        this.setSaveState(appError.code === 'file.external_change' ? { kind: 'conflict' } : { kind: 'error', code: appError.code });
      }
    })();
    this.inflight = run;
    await run;
    this.inflight = null;
    if (this._saveState.kind === 'dirty') this.scheduleSave();
  }

  /**
   * Replaces the document with an externally changed version (reload after conflict, or a sync
   * pull). Recorded as one undoable step so the user can get their text back.
   */
  replaceFromExternal(text: string, version: string): void {
    const before = this._text;
    this._version = version;
    this._saveState = { kind: 'saved', at: Date.now() };
    if (before === text) {
      this.emit(null);
      return;
    }
    const edits: TextEdit[] = [{ from: 0, to: before.length, insert: text }];
    this.history.record(before, edits);
    this.history.seal();
    this._text = text;
    this._fingerprint = fingerprint(text);
    this.emit({ edits, origin: 'external', text });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }

  private commit(text: string, event: EditEvent): void {
    this._text = text;
    this._fingerprint = fingerprint(text);
    event.text = text;
    if (this._saveState.kind !== 'conflict') this._saveState = { kind: 'dirty' };
    this.emit(event);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this._saveState.kind === 'conflict') return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.autosaveDelayMs);
  }

  private setSaveState(state: SessionSaveState): void {
    this._saveState = state;
    this.emit(null);
  }

  private emit(event: EditEvent | null): void {
    for (const listener of this.listeners) listener(event);
  }
}
