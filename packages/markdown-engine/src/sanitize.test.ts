import type { Element, Nodes } from 'hast';
import { fromHtml } from 'hast-util-from-html';
import { describe, expect, it } from 'vitest';
import { renderToHtml } from './index.ts';

const FORBIDDEN_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'style', 'form', 'meta', 'base', 'link', 'svg', 'template', 'noscript', 'button']);
const URL_PROPS = ['href', 'src', 'action', 'formAction', 'xLinkHref', 'poster', 'cite'];
const DANGEROUS_URL = /^\s*(?:javascript|vbscript|data:text\/html|data:image\/svg)/i;

/** Parses the output like a browser would and reports anything executable or style-injecting. */
function findViolations(html: string): string[] {
  const violations: string[] = [];
  const walk = (node: Nodes, insideKatex: boolean) => {
    if (node.type === 'element') {
      const el: Element = node;
      // KaTeX output is generated after sanitization and uses inline styles for layout only.
      insideKatex ||= /\bkatex\b/.test(String(el.properties.className ?? ''));
      if (FORBIDDEN_TAGS.has(el.tagName)) violations.push(`tag <${el.tagName}>`);
      for (const [key, value] of Object.entries(el.properties)) {
        if (/^on[A-Z]/.test(key)) violations.push(`handler ${key}`);
        if (key === 'style' && !insideKatex) violations.push(`style=${String(value)}`);
        if (key === 'srcDoc') violations.push('srcdoc');
        if (URL_PROPS.includes(key) && DANGEROUS_URL.test(String(value))) violations.push(`${key}=${String(value)}`);
      }
    }
    if ('children' in node) for (const child of node.children) walk(child, insideKatex);
  };
  walk(fromHtml(html, { fragment: true }), false);
  return violations;
}

/**
 * Every payload here must render without any executable or style-injecting content. Adding an
 * attribute or protocol to the sanitize schema must keep this suite green.
 */
const PAYLOADS: Array<[string, string]> = [
  ['script tag', '<script>alert(1)</script>'],
  ['script in paragraph', 'Hi <script src="https://evil.example/x.js"></script> there'],
  ['img onerror', '<img src="x" onerror="alert(1)">'],
  ['svg onload', '<svg onload="alert(1)"><circle r="5"/></svg>'],
  ['svg script', '<svg><script>alert(1)</script></svg>'],
  ['iframe', '<iframe src="https://evil.example"></iframe>'],
  ['object/embed', '<object data="x.swf"></object><embed src="x.swf">'],
  ['javascript link (md)', '[click](javascript:alert(1))'],
  ['javascript link (html)', '<a href="javascript:alert(1)">x</a>'],
  ['encoded javascript', '<a href="jav&#x09;ascript:alert(1)">x</a>'],
  ['vbscript', '[x](vbscript:msgbox(1))'],
  ['data html link', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
  ['svg data image', '![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)'],
  ['style attribute', '<p style="background:url(javascript:alert(1))">x</p>'],
  ['style tag', '<style>body{display:none}</style>'],
  ['form', '<form action="https://evil.example"><input name="password"><button>Go</button></form>'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
  ['base tag', '<base href="https://evil.example/">'],
  ['link stylesheet', '<link rel="stylesheet" href="https://evil.example/x.css">'],
  ['math href', '$\\href{javascript:alert(1)}{x}$'],
  ['katex html class', '$\\htmlClass{x}{y}$'],
  ['details ontoggle', '<details open ontoggle="alert(1)"><summary>s</summary></details>'],
  ['mxss noscript', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
  ['template', '<template><img src=x onerror=alert(1)></template>'],
  ['srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ['formaction', '<button formaction="javascript:alert(1)">x</button>'],
];

describe('sanitization', () => {
  for (const [name, payload] of PAYLOADS) {
    it(`neutralises ${name}`, () => {
      expect(findViolations(renderToHtml(payload))).toEqual([]);
    });
  }

  it('detector itself catches unsanitized payloads', () => {
    expect(findViolations('<img src=x onerror=alert(1)><a href="javascript:x">a</a><p style="x">')).toHaveLength(3);
  });

  it('keeps safe HTML and raster data images', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const html = renderToHtml(`<details><summary>More</summary>Hidden <kbd>Ctrl</kbd></details>\n\n![dot](${png})`);
    expect(html).toContain('<details>');
    expect(html).toContain('<kbd>Ctrl</kbd>');
    expect(html).toContain(`src="${png}"`);
    expect(html).toContain('loading="lazy"');
  });

  it('can drop data images and raw HTML by policy', () => {
    expect(renderToHtml('![x](data:image/png;base64,AAAA)', { allowDataImages: false })).not.toContain('data:');
    expect(renderToHtml('a <kbd>b</kbd>', { allowHtml: false })).not.toContain('<kbd>');
  });

  it('prefixes user-supplied ids to prevent DOM clobbering', () => {
    expect(renderToHtml('<a id="location" name="cookie">x</a>')).toContain('id="user-content-location"');
  });

  it('keeps relative links and mailto', () => {
    const html = renderToHtml('[doc](./other.md#part) [mail](mailto:a@b.c) ![i](img/a.png)');
    expect(html).toContain('href="./other.md#part"');
    expect(html).toContain('href="mailto:a@b.c"');
    expect(html).toContain('src="img/a.png"');
  });
});
