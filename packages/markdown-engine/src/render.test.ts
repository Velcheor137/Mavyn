import { describe, expect, it } from 'vitest';
import { render, renderToHtml } from './index.ts';

describe('CommonMark / GFM rendering', () => {
  it('renders core blocks and inlines', () => {
    const html = renderToHtml('# H1\n\n## H2\n\nPara *em* **strong** ~~del~~ `code`\n\n> quote\n\n---\n\n1. one\n2. two\n');
    expect(html).toContain('<h1 data-line="1" id="h1">H1</h1>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<strong>strong</strong>');
    expect(html).toContain('<del>del</del>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<blockquote');
    expect(html).toContain('<hr');
    expect(html).toContain('<ol');
  });

  it('renders GFM tables with alignment and autolinks', () => {
    const html = renderToHtml('| a | b |\n|:--|--:|\n| 1 | 2 |\n\nVisit https://example.com now');
    expect(html).toMatch(/<table[^>]*>/);
    expect(html).toContain('<td align="right">2</td>');
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  it('keeps fenced code language for highlighting and mermaid', () => {
    const html = renderToHtml('```ts\nconst a = 1;\n```\n\n```mermaid\ngraph TD; A-->B\n```');
    expect(html).toContain('class="language-ts"');
    expect(html).toContain('class="language-mermaid"');
  });

  it('commonmark profile ignores GFM extensions', () => {
    const html = renderToHtml('~~x~~\n\n- [ ] task', { profile: 'commonmark' });
    expect(html).not.toContain('<del>');
    expect(html).not.toContain('type="checkbox"');
  });

  it('builds a TOC with unique Unicode anchors', () => {
    const { toc } = render('# Введение\n\n## Детали\n\n## Детали\n\n### API & SDK');
    expect(toc).toEqual([
      { depth: 1, text: 'Введение', id: 'введение', line: 1 },
      { depth: 2, text: 'Детали', id: 'детали', line: 3 },
      { depth: 2, text: 'Детали', id: 'детали-1', line: 5 },
      { depth: 3, text: 'API & SDK', id: 'api--sdk', line: 7 },
    ]);
  });

  it('extracts frontmatter without rendering it', () => {
    const result = render('---\ntitle: Заметка\ntags: [a, b]\n---\n\n# Body');
    expect(result.frontmatter).toBe('title: Заметка\ntags: [a, b]');
    expect(renderToHtml('---\ntitle: x\n---\n\nBody')).not.toContain('title: x');
  });

  it('renders footnotes and emoji shortcodes', () => {
    const html = renderToHtml('Text[^n] :tada:\n\n[^n]: The note.');
    expect(html).toContain('🎉');
    expect(html).toContain('data-footnote-ref');
    expect(html).toContain('The note.');
  });

  it('renders inline and block math with KaTeX', () => {
    const html = renderToHtml('Inline $E=mc^2$\n\n$$\n\\int_0^1 x\\,dx\n$$');
    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-display');
    expect(html).toContain('<math');
  });

  it('shows invalid TeX as an error instead of throwing', () => {
    expect(() => renderToHtml('$\\frac{$')).not.toThrow();
    expect(renderToHtml('$\\frac{$')).toContain('katex-error');
  });
});

describe('callouts', () => {
  it('renders GitHub alerts in gfm and extended', () => {
    for (const profile of ['gfm', 'extended'] as const) {
      const html = renderToHtml('> [!WARNING]\n> Be careful', { profile });
      expect(html).toContain('class="callout callout-warning"');
      expect(html).toContain('data-callout="warning"');
      expect(html).toContain('Be careful');
      expect(html).not.toContain('[!WARNING]');
    }
  });
  it('supports Obsidian titles, aliases and folding only in extended', () => {
    const src = '> [!faq]- Почему?\n> Потому что.';
    const html = renderToHtml(src, { profile: 'extended' });
    expect(html).toContain('callout-question');
    expect(html).toContain('data-callout-fold="closed"');
    expect(html).toContain('Почему?');
    expect(renderToHtml(src, { profile: 'gfm' })).not.toContain('callout');
  });
  it('leaves unknown types as blockquotes', () => {
    expect(renderToHtml('> [!BOGUS]\n> x')).toContain('<blockquote');
  });
});

describe('task list rendering', () => {
  it('annotates task items with their source offsets', () => {
    const source = '- [ ] a\n- [x] b';
    const html = renderToHtml(source);
    expect(html).toContain('data-task-offset="3"');
    expect(html).toContain('data-task-offset="11"');
    expect(html).toContain('type="checkbox"');
  });
});
