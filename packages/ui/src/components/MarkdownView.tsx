import type { Element, ElementContent } from 'hast';
import { toJsxRuntime, type Components } from 'hast-util-to-jsx-runtime';
import type { RenderResult } from '@mdr/markdown-engine';
import { Children, createContext, memo, useContext, useMemo, type ComponentProps, type MouseEvent } from 'react';
import { CALLOUT_TYPES, type CalloutType } from '@mdr/markdown-engine';
import { Fragment, jsx, jsxs } from 'react/jsx-runtime';
import { useTranslation } from '@mdr/i18n';
import { CodeBlock } from './CodeBlock.tsx';
import { MermaidBlock } from './MermaidBlock.tsx';
import { MarkdownImage } from './MarkdownImage.tsx';

export interface MarkdownViewProps {
  result: RenderResult;
  /** Optimistic task states (offset → checked) until the next render arrives. */
  overrides: ReadonlyMap<number, boolean>;
  onToggleTask(offset: number, checked: boolean): void;
  onOpenImage(src: string): void;
  onInternalLink(href: string): void;
  readOnly?: boolean;
}

interface TaskContextValue {
  offset: number | null;
  label: string;
}

const TaskContext = createContext<TaskContextValue>({ offset: null, label: '' });

interface ViewContextValue {
  trusted: ReadonlySet<number>;
  overrides: ReadonlyMap<number, boolean>;
  onToggleTask(offset: number, checked: boolean): void;
  onOpenImage(src: string): void;
  onInternalLink(href: string): void;
  readOnly: boolean;
}

const ViewContext = createContext<ViewContextValue | null>(null);
/** Images inside links must not become buttons (nested interactive content). */
const InLinkContext = createContext(false);

function textOf(node: ElementContent, skipLists: boolean): string {
  if (node.type === 'text') return node.value;
  if (node.type !== 'element') return '';
  if (skipLists && (node.tagName === 'ul' || node.tagName === 'ol')) return '';
  return node.children.map((c) => textOf(c, skipLists)).join('');
}

function TaskItem({ node, children, ...props }: ComponentProps<'li'> & { node?: Element }) {
  const raw = (props as Record<string, unknown>)['data-task-offset'];
  const offset = raw === undefined ? null : Number(raw);
  const label = useMemo(() => (node ? node.children.map((c) => textOf(c, true)).join('').trim() : ''), [node]);
  return (
    <TaskContext.Provider value={{ offset: Number.isInteger(offset) ? offset : null, label }}>
      <li {...props}>{children}</li>
    </TaskContext.Provider>
  );
}

function TaskCheckbox(props: ComponentProps<'input'> & { node?: Element }) {
  const { node: _node, ...rest } = props;
  const task = useContext(TaskContext);
  const view = useContext(ViewContext)!;
  const { t } = useTranslation();
  if (rest.type !== 'checkbox') return <input {...rest} />;
  // Only checkboxes produced from Markdown task syntax (verified offsets) are interactive.
  if (task.offset === null || !view.trusted.has(task.offset) || view.readOnly) {
    return <input {...rest} disabled className="task-checkbox" />;
  }
  const offset = task.offset;
  const checked = view.overrides.get(offset) ?? Boolean(rest.checked);
  return (
    <input
      type="checkbox"
      className="task-checkbox"
      checked={checked}
      aria-label={t(checked ? 'a11y.taskCheckboxDone' : 'a11y.taskCheckbox', { label: task.label })}
      onChange={(e) => view.onToggleTask(offset, e.currentTarget.checked)}
    />
  );
}

function Pre({ node, children, ...props }: ComponentProps<'pre'> & { node?: Element }) {
  const code = node?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
  if (!code) return <pre {...props}>{children}</pre>;
  const classes = Array.isArray(code.properties.className) ? code.properties.className.map(String) : [];
  const language = classes.find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? null;
  const text = textOf(code, false).replace(/\n$/, '');
  const line = (props as Record<string, unknown>)['data-line'];
  if (language === 'mermaid') return <MermaidBlock code={text} line={line === undefined ? undefined : String(line)} />;
  return <CodeBlock code={text} language={language} line={line === undefined ? undefined : String(line)} />;
}

function Link({ node: _node, href, children, ...props }: ComponentProps<'a'> & { node?: Element }) {
  const view = useContext(ViewContext)!;
  if (!href) return <a {...props}>{children}</a>;
  const external = /^(https?:|mailto:)/i.test(href);
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (external) return;
    event.preventDefault();
    view.onInternalLink(href);
  };
  return (
    <a {...props} href={href} onClick={onClick} {...(external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {})}>
      <InLinkContext.Provider value={true}>{children}</InLinkContext.Provider>
    </a>
  );
}

function Image({ node: _node, src, alt, ...props }: ComponentProps<'img'> & { node?: Element }) {
  const view = useContext(ViewContext)!;
  const inLink = useContext(InLinkContext);
  return <MarkdownImage src={typeof src === 'string' ? src : ''} alt={alt ?? ''} title={props.title} onOpen={inLink ? null : view.onOpenImage} />;
}

const CalloutContext = createContext<CalloutType | null>(null);

function Div({ node: _node, children, ...props }: ComponentProps<'div'> & { node?: Element }) {
  const attrs = props as Record<string, unknown>;
  const type = attrs['data-callout'];
  if (typeof type !== 'string' || !(CALLOUT_TYPES as readonly string[]).includes(type)) return <div {...props}>{children}</div>;
  const fold = attrs['data-callout-fold'];
  const content = <CalloutContext.Provider value={type as CalloutType}>{children}</CalloutContext.Provider>;
  if (fold !== 'open' && fold !== 'closed') return <div {...props} role="note">{content}</div>;
  // Foldable callout (`> [!tip]-`): the title paragraph becomes the summary.
  const [title, ...rest] = Children.toArray(children);
  return (
    <details className={props.className} open={fold === 'open'}>
      <summary>
        <CalloutContext.Provider value={type as CalloutType}>{title}</CalloutContext.Provider>
      </summary>
      <CalloutContext.Provider value={type as CalloutType}>{rest}</CalloutContext.Provider>
    </details>
  );
}

function Paragraph({ node: _node, children, ...props }: ComponentProps<'p'> & { node?: Element }) {
  const callout = useContext(CalloutContext);
  const { t } = useTranslation();
  const isDefaultTitle = (props as Record<string, unknown>)['data-callout-title'] === 'default';
  if (callout && isDefaultTitle) return <p {...props}>{t(`callout.${callout}`)}</p>;
  return <p {...props}>{children}</p>;
}

const components: Partial<Components> = {
  div: Div as Components['div'],
  p: Paragraph as Components['p'],
  li: TaskItem as Components['li'],
  input: TaskCheckbox as Components['input'],
  pre: Pre as Components['pre'],
  a: Link as Components['a'],
  img: Image as Components['img'],
};

/** Renders a sanitized hast tree as React. */
export const MarkdownView = memo(function MarkdownView(props: MarkdownViewProps) {
  const trusted = useMemo(() => new Set(props.result.tasks.map((t) => t.offset)), [props.result.tasks]);
  const content = useMemo(
    () =>
      toJsxRuntime(props.result.tree, {
        Fragment,
        jsx,
        jsxs,
        components,
        passNode: true,
        elementAttributeNameCase: 'react',
        stylePropertyNameCase: 'dom',
      }),
    [props.result.tree],
  );
  const value: ViewContextValue = {
    trusted,
    overrides: props.overrides,
    onToggleTask: props.onToggleTask,
    onOpenImage: props.onOpenImage,
    onInternalLink: props.onInternalLink,
    readOnly: props.readOnly ?? false,
  };
  return (
    <ViewContext.Provider value={value}>
      <div className="markdown-body">{content}</div>
    </ViewContext.Provider>
  );
});
