import { useTranslation } from '@mdr/i18n';
import { ZoomIn, ZoomOut } from 'lucide-react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useRef, useState } from 'react';

const ZOOMS = [0.25, 0.4, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

async function openPdf(bytes: Uint8Array): Promise<PDFDocumentLoadingTask> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // pdf.js transfers the buffer to its worker: hand it a copy so ours stays usable.
  // No XFA forms; PDF JavaScript never runs (the scripting sandbox is not loaded).
  return pdfjs.getDocument({ data: bytes.slice(), enableXfa: false, isOffscreenCanvasSupported: false });
}

function PdfPage({ pdf, number, zoom, size }: { pdf: PDFDocumentProxy; number: number; zoom: number; size: { width: number; aspect: number } }) {
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && setVisible(true), { rootMargin: '800px 0px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = holder.current;
    if (!visible || !el) return;
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    void (async () => {
      const pdfjs = await import('pdfjs-dist');
      const page = await pdf.getPage(number);
      if (cancelled) return;
      // CSS pixels per PDF point at 100 % ≈ 96/72; the canvas is rendered at device resolution.
      const viewport = page.getViewport({ scale: zoom * (96 / 72) });
      const ratio = globalThis.devicePixelRatio || 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const text = document.createElement('div');
      text.className = 'textLayer';
      el.style.setProperty('--total-scale-factor', String(viewport.scale));
      const render = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      task = render;
      await render.promise;
      if (cancelled) return;
      el.replaceChildren(canvas, text);
      await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport }).render();
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, number, zoom, visible]);

  // Placeholder sized like the first page until this one is rendered.
  const width = size.width * zoom * (96 / 72);
  return <div ref={holder} className="pdf-page" style={{ width, minHeight: width * size.aspect }} data-page={number} />;
}

export default function PdfViewer({ bytes, onError }: { bytes: Uint8Array; onError(error: unknown): void }) {
  const { t } = useTranslation();
  const [pdf, setPdf] = useState<{ doc: PDFDocumentProxy; size: { width: number; aspect: number } } | null>(null);
  const [zoomIndex, setZoomIndex] = useState(ZOOMS.indexOf(1));
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    void (async () => {
      try {
        task = await openPdf(bytes);
        if (cancelled) {
          void task.destroy();
          return;
        }
        const opened = await task.promise;
        const first = await opened.getPage(1);
        const view = first.getViewport({ scale: 1 });
        if (cancelled) return;
        // Start at the largest zoom ≤ 100 % at which the page fits the pane (phones, split screens).
        const available = (root.current?.parentElement?.clientWidth ?? 0) - 32;
        if (available > 0) {
          const fits = ZOOMS.filter((z) => z <= 1 && view.width * z * (96 / 72) <= available);
          setZoomIndex(ZOOMS.indexOf(fits.at(-1) ?? ZOOMS[0]!));
        }
        setPdf({ doc: opened, size: { width: view.width, aspect: view.height / view.width } });
      } catch (error) {
        if (!cancelled) onError(error);
      }
    })();
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [bytes, onError]);

  if (!pdf) return <p ref={root} className="muted file-loading">{t('app.loading')}</p>;
  const zoom = ZOOMS[zoomIndex]!;

  return (
    <div className="file-pdf">
      <div className="pdf-toolbar" role="toolbar" aria-label={t('viewer.zoom')}>
        <button type="button" className="icon-button" onClick={() => setZoomIndex((i) => Math.max(0, i - 1))} disabled={zoomIndex === 0} aria-label={t('viewer.zoomOut')} title={t('viewer.zoomOut')}>
          <ZoomOut size={16} aria-hidden />
        </button>
        <span className="pdf-zoom">{Math.round(zoom * 100)}%</span>
        <button type="button" className="icon-button" onClick={() => setZoomIndex((i) => Math.min(ZOOMS.length - 1, i + 1))} disabled={zoomIndex === ZOOMS.length - 1} aria-label={t('viewer.zoomIn')} title={t('viewer.zoomIn')}>
          <ZoomIn size={16} aria-hidden />
        </button>
        <span className="muted pdf-pages">{t('viewer.pages', { count: pdf.doc.numPages })}</span>
      </div>
      <div className="pdf-pages-list">
        {Array.from({ length: pdf.doc.numPages }, (_, i) => (
          <PdfPage key={i + 1} pdf={pdf.doc} number={i + 1} zoom={zoom} size={pdf.size} />
        ))}
      </div>
    </div>
  );
}
