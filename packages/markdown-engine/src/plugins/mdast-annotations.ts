import type { Blockquote, Paragraph, Root, Text } from 'mdast';
import { visit } from 'unist-util-visit';

const SOURCE_MAPPED = new Set([
  'heading',
  'paragraph',
  'blockquote',
  'list',
  'listItem',
  'code',
  'table',
  'thematicBreak',
  'math',
  'html',
]);

/**
 * Adds `data-line` (1-based source line) to block elements for preview → source navigation and
 * `data-task-offset` to task list items. Values are only hints for the UI; edits are validated
 * against the trusted task list returned by `render()` and the source text itself.
 */
export function remarkAnnotate() {
  return (tree: Root) => {
    visit(tree, (node) => {
      if (!SOURCE_MAPPED.has(node.type) || !node.position) return;
      const props: Record<string, string | number> = { dataLine: node.position.start.line };
      if (node.type === 'listItem' && node.data?.taskOffset !== undefined) {
        props.dataTaskOffset = node.data.taskOffset;
      }
      node.data = { ...node.data, hProperties: { ...(node.data?.hProperties ?? {}), ...props } };
    });
  };
}

export const CALLOUT_TYPES = ['note', 'tip', 'important', 'warning', 'caution', 'info', 'danger', 'success', 'question', 'quote', 'example', 'bug', 'abstract', 'todo', 'failure'] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

const GITHUB_ALERTS = new Set<CalloutType>(['note', 'tip', 'important', 'warning', 'caution']);

const ALIASES: Record<string, CalloutType> = {
  hint: 'tip',
  error: 'danger',
  check: 'success',
  done: 'success',
  faq: 'question',
  help: 'question',
  summary: 'abstract',
  tldr: 'abstract',
  attention: 'warning',
  fail: 'failure',
  missing: 'failure',
  cite: 'quote',
};

const MARKER = /^\[!([a-z]+)\]([+-]?)(?:[ \t]+([^\n]*))?(?:\n|$)/i;

/**
 * GitHub alerts (`> [!NOTE]`) and Obsidian-style callouts (`> [!tip]- Title`). Only the rendered
 * tree changes; the source is untouched. Unknown types render as a plain blockquote.
 */
export function remarkCallouts(options: { githubOnly: boolean }) {
  return (tree: Root) => {
    visit(tree, 'blockquote', (node: Blockquote) => {
      const first = node.children[0];
      if (first?.type !== 'paragraph') return;
      const head = first.children[0];
      if (head?.type !== 'text') return;
      const match = MARKER.exec(head.value);
      if (!match) return;
      const raw = match[1]!.toLowerCase();
      const type = (CALLOUT_TYPES as readonly string[]).includes(raw) ? (raw as CalloutType) : options.githubOnly ? undefined : ALIASES[raw];
      if (!type || (options.githubOnly && !GITHUB_ALERTS.has(type))) return;

      head.value = head.value.slice(match[0].length);
      if (head.value === '') first.children.shift();
      if (first.children[0]?.type === 'break') first.children.shift();
      if (first.children.length === 0) node.children.shift();

      const title = match[3]?.trim();
      const titleNode: Paragraph = {
        type: 'paragraph',
        children: title ? [{ type: 'text', value: title } satisfies Text] : [],
        data: { hProperties: { className: ['callout-title'], dataCalloutTitle: title ? 'custom' : 'default' } },
      };
      node.children.unshift(titleNode);
      node.data = {
        ...node.data,
        hName: 'div',
        hProperties: {
          ...(node.data?.hProperties ?? {}),
          className: ['callout', `callout-${type}`],
          dataCallout: type,
          ...(match[2] ? { dataCalloutFold: match[2] === '-' ? 'closed' : 'open' } : {}),
        },
      };
    });
  };
}
