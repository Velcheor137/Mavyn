import { isLocale, type Locale } from '@mdr/i18n';
import type { Profile } from '@mdr/markdown-engine';
import { create } from 'zustand';
import { PREFS_KEY } from './theme-bootstrap.ts';

export type ThemeMode = 'light' | 'dark' | 'system';
export type FontFamily = 'sans' | 'serif' | 'mono';
export type ContentWidth = 'narrow' | 'medium' | 'wide' | 'full';
export type ViewMode = 'reader' | 'source' | 'split';

export interface Preferences {
  /** `null` follows the OS/browser language. */
  locale: Locale | null;
  theme: ThemeMode;
  accent: string;
  fontFamily: FontFamily;
  fontSize: number;
  lineHeight: number;
  contentWidth: ContentWidth;
  codeWrap: boolean;
  codeLineNumbers: boolean;
  editorLineNumbers: boolean;
  editorWrap: boolean;
  autosaveDelayMs: number;
  profile: Profile;
  allowHtml: boolean;
  sidebarOpen: boolean;
  sidebarWidth: number;
  outlineOpen: boolean;
  defaultViewMode: ViewMode;
}

export interface WorkspaceSnapshot {
  tabs: string[];
  active: string | null;
  viewModes: Record<string, ViewMode>;
  /** Reading position per document as a scroll fraction 0..1. */
  positions: Record<string, number>;
  /** Sidebar section that was open (validated against the library on load). */
  section?: unknown;
}

export const ACCENTS = ['#5e6ad2', '#0e8a6a', '#d9480f', '#c2255c', '#1c7ed6', '#7048e8', '#495057'] as const;

export const DEFAULT_PREFERENCES: Preferences = {
  locale: null,
  theme: 'system',
  accent: ACCENTS[0],
  fontFamily: 'sans',
  fontSize: 16,
  lineHeight: 1.7,
  contentWidth: 'medium',
  codeWrap: false,
  codeLineNumbers: false,
  editorLineNumbers: true,
  editorWrap: true,
  autosaveDelayMs: 800,
  profile: 'extended',
  allowHtml: true,
  sidebarOpen: true,
  sidebarWidth: 280,
  outlineOpen: true,
  defaultViewMode: 'reader',
};

const WORKSPACE_KEY = 'mdreader.workspace.v1';

/** localStorage may be unavailable (privacy modes, storage disabled); preferences then live in memory. */
function readJson(key: string): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or disabled storage: preferences are a convenience, keep working in memory.
  }
}

/** Validates stored preferences field by field so a corrupt or old value never breaks startup. */
export function sanitizePreferences(raw: unknown): Preferences {
  const p = { ...DEFAULT_PREFERENCES };
  if (!raw || typeof raw !== 'object') return p;
  const r = raw as Record<string, unknown>;
  const pick = <K extends keyof Preferences>(key: K, valid: (v: unknown) => boolean) => {
    if (valid(r[key])) p[key] = r[key] as Preferences[K];
  };
  const oneOf = (...values: unknown[]) => (v: unknown) => values.includes(v);
  const num = (min: number, max: number) => (v: unknown) => typeof v === 'number' && v >= min && v <= max;
  const bool = (v: unknown) => typeof v === 'boolean';
  pick('locale', (v) => v === null || isLocale(v));
  pick('theme', oneOf('light', 'dark', 'system'));
  pick('accent', (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v));
  pick('fontFamily', oneOf('sans', 'serif', 'mono'));
  pick('fontSize', num(12, 28));
  pick('lineHeight', num(1.2, 2.4));
  pick('contentWidth', oneOf('narrow', 'medium', 'wide', 'full'));
  pick('codeWrap', bool);
  pick('codeLineNumbers', bool);
  pick('editorLineNumbers', bool);
  pick('editorWrap', bool);
  pick('autosaveDelayMs', num(200, 10_000));
  pick('profile', oneOf('commonmark', 'gfm', 'extended'));
  pick('allowHtml', bool);
  pick('sidebarOpen', bool);
  pick('sidebarWidth', num(200, 520));
  pick('outlineOpen', bool);
  pick('defaultViewMode', oneOf('reader', 'source', 'split'));
  return p;
}

interface PreferencesState extends Preferences {
  set(patch: Partial<Preferences>): void;
  reset(): void;
}

export const usePreferences = create<PreferencesState>((set, get) => ({
  ...sanitizePreferences(readJson(PREFS_KEY)),
  set(patch) {
    set(patch);
    const { set: _s, reset: _r, ...prefs } = get();
    writeJson(PREFS_KEY, prefs);
  },
  reset() {
    set(DEFAULT_PREFERENCES);
    writeJson(PREFS_KEY, DEFAULT_PREFERENCES);
  },
}));

export function loadWorkspaceSnapshot(): WorkspaceSnapshot {
  const raw = readJson(WORKSPACE_KEY) as Partial<WorkspaceSnapshot> | null;
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return {
    tabs: strings(raw?.tabs),
    active: typeof raw?.active === 'string' ? raw.active : null,
    viewModes: raw?.viewModes && typeof raw.viewModes === 'object' ? raw.viewModes : {},
    positions: raw?.positions && typeof raw.positions === 'object' ? raw.positions : {},
    section: raw?.section && typeof raw.section === 'object' ? raw.section : null,
  };
}

export function saveWorkspaceSnapshot(snapshot: WorkspaceSnapshot): void {
  writeJson(WORKSPACE_KEY, snapshot);
}

const WIDTHS: Record<ContentWidth, string> = { narrow: '38rem', medium: '46rem', wide: '60rem', full: 'none' };
const FONTS: Record<FontFamily, string> = {
  sans: 'var(--font-sans)',
  serif: 'var(--font-serif)',
  mono: 'var(--font-mono)',
};

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): 'light' | 'dark' {
  return mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
}

/** Applies theme and reading preferences as attributes/CSS variables on the root element. */
export function applyPreferences(prefs: Preferences, root: HTMLElement = document.documentElement): void {
  const prefersDark = globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const theme = resolveTheme(prefs.theme, prefersDark);
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.setProperty('--color-accent', prefs.accent);
  root.style.setProperty('--reader-font', FONTS[prefs.fontFamily]);
  root.style.setProperty('--reader-font-size', `${prefs.fontSize}px`);
  root.style.setProperty('--reader-line-height', String(prefs.lineHeight));
  root.style.setProperty('--reader-width', WIDTHS[prefs.contentWidth]);
  root.dataset.codeWrap = String(prefs.codeWrap);
  root.dataset.codeLineNumbers = String(prefs.codeLineNumbers);
}
