import { useTranslation } from '@mdr/i18n';
import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

const MAX_HIGHLIGHT_CHARS = 200_000;

/** Lazily highlights with Shiki (loaded on first use); plain text until then or on failure. */
async function highlight(code: string, language: string): Promise<string | null> {
  const shiki = await import('shiki');
  const lang = language in shiki.bundledLanguages || language in shiki.bundledLanguagesAlias ? language : null;
  if (!lang) return null;
  // Shiki escapes the code itself; the output contains only its own spans and inline color vars.
  return shiki.codeToHtml(code, {
    lang,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
}

export function CodeBlock({ code, language, line }: { code: string; language: string | null; line?: string | undefined }) {
  const { t } = useTranslation();
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    if (!language || code.length > MAX_HIGHLIGHT_CHARS) return;
    highlight(code, language.toLowerCase())
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        // Highlighting is progressive enhancement; the plain block is already shown.
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
    setTimeout(() => setCopied('idle'), 1500);
  };

  const lines = code.split('\n').length;
  return (
    <div className="code-block group" data-line={line}>
      <div className="code-block-header">
        <span className="code-block-lang">{language ?? ''}</span>
        <button type="button" className="icon-button" onClick={() => void copy()} aria-label={t('code.copy')} title={t('code.copy')}>
          {copied === 'ok' ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          <span className="sr-only" aria-live="polite">
            {copied === 'ok' ? t('code.copied') : copied === 'failed' ? t('code.copyFailed') : ''}
          </span>
        </button>
      </div>
      <div className="code-block-body">
        <div className="code-line-numbers" aria-hidden>
          {Array.from({ length: lines }, (_, i) => (
            <span key={i}>{i + 1}</span>
          ))}
        </div>
        {html ? (
          <div className="code-highlighted" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre>
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
