import GithubSlugger from 'github-slugger';
import type { Element, Root } from 'hast';
import { toString } from 'hast-util-to-string';
import { visit } from 'unist-util-visit';
import type { VFile } from 'vfile';

declare module 'vfile' {
  interface DataMap {
    toc: TocEntry[];
  }
}

export interface TocEntry {
  depth: number;
  text: string;
  id: string;
  line: number | null;
}

const HEADING = /^h([1-6])$/;

/**
 * Runs after sanitization: assigns GitHub-compatible heading ids (unique per document, Unicode
 * kept, so Cyrillic headings get Cyrillic anchors) and collects the table of contents.
 */
export function rehypeHeadings() {
  return (tree: Root, file: VFile) => {
    const toc: TocEntry[] = [];
    file.data.toc = toc;
    const slugger = new GithubSlugger();
    visit(tree, 'element', (node: Element) => {
      const match = HEADING.exec(node.tagName);
      if (!match) return;
      const text = toString(node).trim();
      const id = slugger.slug(text || 'section');
      node.properties.id = id;
      const line = Number(node.properties.dataLine);
      toc.push({ depth: Number(match[1]), text, id, line: Number.isInteger(line) && line > 0 ? line : null });
    });
  };
}

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;

/**
 * `data:` URLs survive sanitization only for `src`; keep them only for raster images (no SVG,
 * which can carry script). Images are lazy-loaded.
 */
export function rehypeImagePolicy(options: { allowDataImages: boolean }) {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      const src = node.properties.src;
      if (typeof src === 'string' && /^data:/i.test(src)) {
        if (node.tagName !== 'img' || !options.allowDataImages || !SAFE_DATA_IMAGE.test(src)) {
          delete node.properties.src;
        }
      }
      if (node.tagName === 'img') node.properties.loading = 'lazy';
    });
  };
}
