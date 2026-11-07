import { foldKey } from '@mdr/core';

export interface SearchHit {
  documentId: string;
  score: number;
  /** Snippet with match ranges relative to `snippet`. */
  snippet: string;
  ranges: Array<[number, number]>;
  inTitle: boolean;
}

const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

export function tokenize(text: string): string[] {
  return foldKey(text).match(TOKEN) ?? [];
}

interface Indexed {
  title: string;
  text: string;
  folded: string;
  tokens: Set<string>;
}

/**
 * In-memory full-text index for the web build (desktop uses SQLite FTS5). Unicode-aware
 * tokenization with case/ё folding and prefix matching, so `задач` finds `задачи` and `Задача`.
 * No stemming: documented limitation, consistent across Russian and English.
 */
export class SearchIndex {
  private readonly docs = new Map<string, Indexed>();
  private readonly postings = new Map<string, Set<string>>();

  upsert(documentId: string, title: string, text: string): void {
    this.remove(documentId);
    const tokens = new Set([...tokenize(title), ...tokenize(text)]);
    this.docs.set(documentId, { title, text, folded: foldKey(text), tokens });
    for (const token of tokens) {
      let set = this.postings.get(token);
      if (!set) {
        set = new Set();
        this.postings.set(token, set);
      }
      set.add(documentId);
    }
  }

  remove(documentId: string): void {
    const doc = this.docs.get(documentId);
    if (!doc) return;
    for (const token of doc.tokens) {
      const set = this.postings.get(token);
      set?.delete(documentId);
      if (set?.size === 0) this.postings.delete(token);
    }
    this.docs.delete(documentId);
  }

  get size(): number {
    return this.docs.size;
  }

  search(query: string, limit = 50): SearchHit[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    // Every term must match some token by prefix (AND semantics).
    const perTerm = terms.map((term) => {
      const matching = new Set<string>();
      for (const [token, ids] of this.postings) {
        if (token.startsWith(term)) for (const id of ids) matching.add(id);
      }
      return matching;
    });
    const candidates = [...perTerm[0]!].filter((id) => perTerm.every((set) => set.has(id)));

    const hits: SearchHit[] = [];
    for (const id of candidates) {
      const doc = this.docs.get(id)!;
      const foldedTitle = foldKey(doc.title);
      const inTitle = terms.every((t) => foldedTitle.includes(t));
      let score = inTitle ? 10 : 0;
      for (const term of terms) {
        for (let i = doc.folded.indexOf(term); i !== -1 && score < 1000; i = doc.folded.indexOf(term, i + term.length)) score++;
      }
      hits.push({ documentId: id, score, inTitle, ...makeSnippet(doc.text, doc.folded, terms) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

export function makeSnippet(text: string, folded: string, terms: string[], radius = 60): { snippet: string; ranges: Array<[number, number]> } {
  // foldKey preserves length for the scripts we care about (NFC lowercase, ё→е); if it did not,
  // fall back to an unhighlighted prefix rather than misplacing highlights.
  if (folded.length !== text.length) return { snippet: text.slice(0, radius * 2), ranges: [] };
  const first = Math.min(...terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0));
  if (!Number.isFinite(first)) return { snippet: text.slice(0, radius * 2), ranges: [] };
  const start = Math.max(0, first - radius);
  const end = Math.min(text.length, first + radius);
  const prefix = start > 0 ? '…' : '';
  const snippet = prefix + text.slice(start, end).replace(/\s+/g, ' ') + (end < text.length ? '…' : '');
  const window = prefix + folded.slice(start, end).replace(/\s+/g, ' ');
  const ranges: Array<[number, number]> = [];
  for (const term of terms) {
    for (let i = window.indexOf(term); i !== -1; i = window.indexOf(term, i + term.length)) ranges.push([i, i + term.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return { snippet, ranges };
}
