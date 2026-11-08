import type { PickedFile } from '@mdr/platform';
import type { TauriPlatformAdapter } from './tauri-platform.ts';

/** Poll the private durable mailbox. Only acknowledge documents committed to the library. */
export async function startIncoming(
  platform: TauriPlatformAdapter,
  receive: (files: PickedFile[]) => Promise<PickedFile[]>,
  onError: (error: unknown) => void,
): Promise<() => void> {
  let stopped = false;
  let busy = false;
  const drain = async (): Promise<void> => {
    if (stopped || busy || document.visibilityState === 'hidden') return;
    busy = true;
    try {
      for (let count = 0; count < 32; count++) {
        const files = await platform.takeLaunchFiles();
        if (!files.length) break;
        const saved = await receive(files);
        for (const file of saved) if (file.importId) await platform.acknowledgeIncoming(file.importId);
        if (platform.kind !== 'android' || saved.length !== files.length) break;
      }
    } catch (error) { onError(error); }
    finally { busy = false; }
  };
  await drain();
  const interval = platform.kind === 'android' ? window.setInterval(() => { void drain(); }, 1500) : null;
  document.addEventListener('visibilitychange', drain);
  return () => {
    stopped = true;
    if (interval !== null) window.clearInterval(interval);
    document.removeEventListener('visibilitychange', drain);
  };
}
