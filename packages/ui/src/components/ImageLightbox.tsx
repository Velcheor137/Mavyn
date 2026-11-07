import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from '@mdr/i18n';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useMemo, useState, type RefObject } from 'react';

export function ImageLightbox({
  src,
  container,
  onClose,
  onNavigate,
}: {
  src: string | null;
  container: RefObject<HTMLElement | null>;
  onClose(): void;
  onNavigate(src: string): void;
}) {
  const { t } = useTranslation();
  const [zoomed, setZoomed] = useState(false);
  const gallery = useMemo(
    () => (src ? [...(container.current?.querySelectorAll<HTMLImageElement>('img[data-gallery]') ?? [])].map((img) => ({ src: img.src, alt: img.alt })) : []),
    [src, container],
  );
  const index = gallery.findIndex((g) => g.src === src || g.src.endsWith(src ?? '\0'));
  const current = gallery[index] ?? (src ? { src, alt: '' } : null);
  const go = (delta: number) => {
    if (gallery.length < 2) return;
    setZoomed(false);
    onNavigate(gallery[(index + delta + gallery.length) % gallery.length]!.src);
  };

  return (
    <Dialog.Root open={src !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay lightbox-overlay" />
        <Dialog.Content
          className="lightbox"
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') go(1);
            if (e.key === 'ArrowLeft') go(-1);
          }}
        >
          <Dialog.Title className="sr-only">{current?.alt || t('image.open')}</Dialog.Title>
          <Dialog.Description className="sr-only">{gallery.length > 1 ? t('image.counter', { current: index + 1, total: gallery.length }) : ''}</Dialog.Description>
          {current && (
            <img
              src={current.src}
              alt={current.alt}
              className={zoomed ? 'lightbox-image zoomed' : 'lightbox-image'}
              onClick={() => setZoomed((z) => !z)}
              referrerPolicy="no-referrer"
            />
          )}
          <div className="lightbox-controls">
            {gallery.length > 1 && (
              <>
                <button type="button" className="icon-button" onClick={() => go(-1)} aria-label={t('image.previous')}>
                  <ChevronLeft size={18} aria-hidden />
                </button>
                <span className="muted">{t('image.counter', { current: index + 1, total: gallery.length })}</span>
                <button type="button" className="icon-button" onClick={() => go(1)} aria-label={t('image.next')}>
                  <ChevronRight size={18} aria-hidden />
                </button>
              </>
            )}
            <Dialog.Close className="icon-button" aria-label={t('image.close')}>
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
