import type { ListItem, Nodes } from 'mdast';
import type { CompileContext, Extension } from 'mdast-util-from-markdown';
import type { Processor } from 'unified';

interface TokenLike {
  type: string;
  start: { offset: number };
}

declare module 'mdast' {
  interface ListItemData {
    /** UTF-16 offset of the character between `[` and `]` of a GFM task marker. */
    taskOffset?: number;
  }
}

/**
 * Records the exact source offset of every GFM task-list check value on its `listItem` while
 * micromark tokens are still available. Offsets come from the tokenizer, never from matching the
 * label text, so duplicate labels, nesting and blockquotes map unambiguously.
 *
 * Must be `use`d after remark-gfm: mdast-util-from-markdown merges `exit` handlers by key, so ours
 * replaces the GFM handler for these two tokens and therefore also sets `checked` like it does.
 */
export function remarkTaskOffsets(this: Processor): void {
  const data = this.data() as { fromMarkdownExtensions?: Array<Extension | Extension[]> };
  const extensions = (data.fromMarkdownExtensions ??= []);
  extensions.push({
    exit: {
      taskListCheckValueChecked: exitCheck,
      taskListCheckValueUnchecked: exitCheck,
    },
  });
}

function exitCheck(this: CompileContext, token: TokenLike): void {
  // Stack is [..., listItem, paragraph] while the check is being tokenized.
  const parent = this.stack[this.stack.length - 2] as Nodes | undefined;
  if (parent?.type !== 'listItem') return;
  const item = parent as ListItem;
  item.checked = token.type === 'taskListCheckValueChecked';
  item.data = { ...item.data, taskOffset: token.start.offset };
}
