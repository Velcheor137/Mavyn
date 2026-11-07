import { useTranslation } from '@mdr/i18n';
import { ImageOff, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

export type ImagePolicy = 'load' | 'insecure' | 'local';

export function classifyImageSource(src: string): ImagePolicy {
  if (/^(https:|data:image\/|blob:)/i.test(src)) return 'load';
  if (/^http:/i.test(src)) return 'insecure';
  return 'local';
}

/**
 * Remote HTTPS and inline raster images load lazily. Plain HTTP is blocked (mixed content,
 * tracking). Relative paths need a platform resolver (desktop); the web build cannot read
 * sibling files of an imported document, so they show a placeholder with the alt text.
 */
export function MarkdownImage({ src, alt, title, onOpen }: { src: string; alt: string; title?: string | undefined; onOpen: ((src: string) => void) | null }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const policy = classifyImageSource(src);

  if (policy !== 'load' || failed) {
    const message = policy === 'insecure' ? t('image.blockedInsecure') : policy === 'local' ? t('image.unavailable') : t('image.loadFailed');
    return (
      <span className="image-placeholder" role="img" aria-label={`${alt} — ${message}`} title={src}>
        {policy === 'insecure' ? <ShieldAlert size={16} aria-hidden /> : <ImageOff size={16} aria-hidden />}
        <span>{alt || message}</span>
      </span>
    );
  }

  const img = <img src={src} alt={alt} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} data-gallery="" />;
  if (!onOpen) return img;
  return (
    <button type="button" className="image-button" onClick={() => onOpen(src)} aria-label={`${t('image.open')}: ${alt}`}>
      {img}
    </button>
  );
}
