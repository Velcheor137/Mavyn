import { fingerprint } from '@mdr/core';
import type { Root as HastRoot } from 'hast';
import type { ListItem, Root as MdastRoot } from 'mdast';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGemoji from 'remark-gemoji';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified, type PluggableList, type Processor } from 'unified';
import { visit } from 'unist-util-visit';
import { VFile } from 'vfile';
import { remarkAnnotate, remarkCallouts } from './plugins/mdast-annotations.ts';
import { rehypeHeadings, rehypeImagePolicy, type TocEntry } from './plugins/hast-post.ts';
import { remarkTaskOffsets } from './plugins/task-offsets.ts';
import { sanitizeSchema } from './schema.ts';

/**
 * - `commonmark`: CommonMark only (raw HTML still sanitized).
 * - `gfm`: GitHub-compatible — tables, task lists, strikethrough, autolinks, footnotes, emoji
 *   shortcodes, `> [!NOTE]` alerts, `$math$`, frontmatter.
 * - `extended`: `gfm` plus Obsidian-style callout types, aliases and folding.
 * Mermaid is rendered by the UI from ```mermaid fences in `gfm` and `extended`.
 */
export type Profile = 'commonmark' | 'gfm' | 'extended';

export interface RenderOptions {
  profile?: Profile;
  /** Sanitized raw HTML. When false, raw HTML is dropped entirely. */
  allowHtml?: boolean;
  allowDataImages?: boolean;
}

export interface TaskInfo {
  /** Offset of the check value character in the source (see `toggleTask`). */
  offset: number;
  checked: boolean;
  line: number;
}

export interface RenderResult {
  tree: HastRoot;
  toc: TocEntry[];
  tasks: TaskInfo[];
  frontmatter: string | null;
  /** Fingerprint of the exact source this result was rendered from. */
  sourceFingerprint: string;
}

declare module 'vfile' {
  interface DataMap {
    tasks: TaskInfo[];
    frontmatter: string | null;
  }
}

function remarkCollect() {
  return (tree: MdastRoot, file: VFile) => {
    const tasks: TaskInfo[] = [];
    let frontmatter: string | null = null;
    visit(tree, (node) => {
      if (node.type === 'listItem') {
        const offset = (node as ListItem).data?.taskOffset;
        if (offset !== undefined && typeof node.checked === 'boolean') {
          tasks.push({ offset, checked: node.checked, line: node.position?.start.line ?? 0 });
        }
      } else if ((node.type === 'yaml' || (node.type as string) === 'toml') && frontmatter === null) {
        // remark-frontmatter emits `toml` nodes too; mdast only types `yaml`.
        frontmatter = (node as { value: string }).value;
      }
    });
    file.data.tasks = tasks;
    file.data.frontmatter = frontmatter;
  };
}

type AnyProcessor = Processor<MdastRoot, MdastRoot, HastRoot, HastRoot, string>;
const processors = new Map<string, AnyProcessor>();

function getProcessor(options: Required<RenderOptions>): AnyProcessor {
  const key = `${options.profile}|${options.allowHtml}|${options.allowDataImages}`;
  const cached = processors.get(key);
  if (cached) return cached;

  const gfm = options.profile !== 'commonmark';
  const plugins: PluggableList = [remarkParse];
  if (gfm) {
    plugins.push(
      remarkGfm,
      remarkTaskOffsets,
      [remarkFrontmatter, ['yaml', 'toml']],
      remarkMath,
      remarkGemoji,
      [remarkCallouts, { githubOnly: options.profile === 'gfm' }],
    );
  }
  plugins.push(remarkCollect, remarkAnnotate, [remarkRehype, { allowDangerousHtml: options.allowHtml, clobberPrefix: '' }]);
  if (options.allowHtml) plugins.push(rehypeRaw);
  plugins.push([rehypeSanitize, sanitizeSchema], [rehypeImagePolicy, { allowDataImages: options.allowDataImages }], rehypeHeadings);
  // KaTeX runs after sanitization on trusted output; `trust: false` blocks \href, \url, \html*.
  if (gfm) plugins.push([rehypeKatex, { throwOnError: false, trust: false, strict: 'ignore', output: 'htmlAndMathml' }]);
  plugins.push(rehypeStringify);

  // unified cannot infer the tree types through a dynamic plugin list; the list above is
  // parse(mdast) → run(hast) → stringify(string).
  const processor = unified().use(plugins) as unknown as AnyProcessor;
  processor.freeze();
  processors.set(key, processor);
  return processor;
}

function resolveOptions(options: RenderOptions): Required<RenderOptions> {
  return {
    profile: options.profile ?? 'extended',
    allowHtml: options.allowHtml ?? true,
    allowDataImages: options.allowDataImages ?? true,
  };
}

/** Parses and renders Markdown to a sanitized hast tree. Synchronous and DOM-free. */
export function render(source: string, options: RenderOptions = {}): RenderResult {
  const processor = getProcessor(resolveOptions(options));
  const file = new VFile({ value: source });
  const tree = processor.runSync(processor.parse(file), file);
  return {
    tree,
    toc: file.data.toc ?? [],
    tasks: file.data.tasks ?? [],
    frontmatter: file.data.frontmatter ?? null,
    sourceFingerprint: fingerprint(source),
  };
}

/** Sanitized HTML fragment (used for export and tests). */
export function renderToHtml(source: string, options: RenderOptions = {}): string {
  const processor = getProcessor(resolveOptions(options));
  const { tree } = render(source, options);
  return processor.stringify(tree);
}
