import { useTranslation } from '@mdr/i18n';
import { useEffect, useState } from 'react';
import { useSync } from '../sync.ts';
import { Modal } from './primitives.tsx';
import { SetupForm } from './SetupForm.tsx';
import { SyncSettings } from './SyncSettings.tsx';

/**
 * Opens by itself when the server has no users yet: step 1 creates the administrator, step 2
 * picks the library to sync. "Later" closes it; the same form stays under Settings → Server.
 */
export function SetupDialog() {
  const { t } = useTranslation();
  const needsSetup = useSync((s) => s.needsSetup);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'account' | 'library'>('account');

  useEffect(() => {
    if (needsSetup) {
      setStep('account');
      setOpen(true);
    }
  }, [needsSetup]);

  return (
    <Modal open={open} onOpenChange={setOpen} title={t('setup.title')} closeLabel={t('setup.later')}>
      {step === 'account' ? (
        <div className="grid gap-3">
          <SetupForm onDone={() => setStep('library')} />
          <button type="button" className="link-button justify-self-start small" onClick={() => setOpen(false)}>
            {t('setup.later')}
          </button>
        </div>
      ) : (
        <div className="grid gap-3">
          <p>
            <strong>{t('setup.done')}</strong> {t('setup.nextStep')}
          </p>
          <SyncSettings showSignOut={false} />
          <button type="button" className="button justify-self-start" onClick={() => setOpen(false)}>
            {t('setup.close')}
          </button>
        </div>
      )}
    </Modal>
  );
}
