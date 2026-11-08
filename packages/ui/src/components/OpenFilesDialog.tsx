import { useTranslation } from '@mdr/i18n';
import { Copy, Link2 } from 'lucide-react';
import { useServices } from '../services.tsx';
import { addFiles, notifyError } from '../workspace.ts';
import { Modal } from './primitives.tsx';

/** Asks whether to import (copy) or link (edit in place) before showing the system picker. */
export function OpenFilesDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { t } = useTranslation();
  const { platform } = useServices();
  const canLink = platform.capabilities.linkFiles;

  const pick = async (link: boolean) => {
    onOpenChange(false);
    try {
      const files = await platform.pickFiles({ link, multiple: true });
      if (files.length) await addFiles(files);
    } catch (error) {
      notifyError(error);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={t('open.title')} closeLabel={t('open.cancel')}>
      <div className="grid gap-3">
        <button type="button" className="choice" onClick={() => void pick(false)}>
          <Copy size={18} aria-hidden />
          <span>
            <strong>{t('open.import')}</strong>
            <span className="muted">{t('open.importHint')}</span>
          </span>
        </button>
        <button type="button" className="choice" onClick={() => void pick(true)} disabled={!canLink} aria-describedby={canLink ? undefined : 'link-unsupported'}>
          <Link2 size={18} aria-hidden />
          <span>
            <strong>{t('open.link')}</strong>
            <span className="muted">{t(platform.kind === 'web' ? 'open.linkHint' : 'open.linkHintNative')}</span>
          </span>
        </button>
        {!canLink && (
          <p id="link-unsupported" className="muted small">
            {t('open.linkUnsupported')}
          </p>
        )}
      </div>
    </Modal>
  );
}
