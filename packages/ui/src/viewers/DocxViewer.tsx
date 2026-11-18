import { useEffect, useRef } from 'react';

/** Document styles stay inside the shadow root; the page itself is always a white sheet. */
const SHADOW_CSS = `
:host { display: block; }
.docx-wrapper { background: transparent !important; padding: 16px !important; display: flex; flex-direction: column; align-items: safe center !important; gap: 16px; }
.docx-wrapper > section.docx { box-shadow: 0 1px 4px rgb(0 0 0 / 0.18); margin: 0 !important; max-width: 100%; box-sizing: border-box; background: white; color: black; color-scheme: light; }
img { max-width: 100%; }
a { color: #1a56c4; }
`;

const SAFE_LINK = /^(https?:|mailto:|#)/i;

/** Removes anything the document could use to reach the network or run code. */
function harden(root: ParentNode): void {
  for (const el of root.querySelectorAll('script, iframe, object, embed, link, meta, base, form')) el.remove();
  for (const img of root.querySelectorAll<HTMLImageElement>('img')) {
    const src = img.getAttribute('src') ?? '';
    if (!/^(data:|blob:)/i.test(src)) img.remove();
  }
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (!SAFE_LINK.test(href)) {
      a.removeAttribute('href');
      continue;
    }
    if (!href.startsWith('#')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer nofollow';
    }
  }
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
  }
}

export default function DocxViewer({ bytes, onError }: { bytes: Uint8Array; onError(error: unknown): void }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    shadow.replaceChildren();
    void (async () => {
      try {
        const { renderAsync } = await import('docx-preview');
        // Render detached, harden, then attach: nothing unsafe is ever connected to the page.
        const styles = document.createElement('div');
        const body = document.createElement('div');
        await renderAsync(bytes, body, styles, {
          className: 'docx',
          inWrapper: true,
          ignoreLastRenderedPageBreak: true,
          useBase64URL: true,
          // altChunk embeds raw HTML in an iframe: never render it.
          renderAltChunks: false,
          renderComments: false,
          renderChanges: false,
          experimental: false,
        });
        if (cancelled) return;
        const content = document.createDocumentFragment();
        content.append(...styles.childNodes, ...body.childNodes);
        harden(content);
        const base = document.createElement('style');
        base.textContent = SHADOW_CSS;
        shadow.replaceChildren(base, content);
      } catch (error) {
        if (!cancelled) onError(error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, onError]);

  return <div ref={host} className="file-docx" />;
}
