import type { FileFingerprint } from '@mdr/core';

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
  /** Present when the platform can save back to the original file. */
  locator: string | null;
  fingerprint: FileFingerprint | null;
}

export interface PlatformCapabilities {
  /** Can edit files in place (File System Access API, native filesystem, Android SAF). */
  linkFiles: boolean;
  /** Supports OS file associations / "Open with". */
  fileAssociations: boolean;
  print: boolean;
}

export interface PlatformAdapter {
  readonly kind: 'web' | 'desktop' | 'android';
  readonly capabilities: PlatformCapabilities;
  /** Shows the file picker. `link` asks for writable access to originals where supported. */
  pickFiles(options: { link: boolean; multiple: boolean }): Promise<PickedFile[]>;
  /** Reads a linked file. Throws `file.not_found` / `file.permission_denied`. */
  readLinked(locator: string): Promise<{ bytes: Uint8Array; fingerprint: FileFingerprint }>;
  /**
   * Writes a linked file if it still matches `expected`; otherwise throws `file.external_change`.
   * Implementations write crash-safely (temporary file + atomic replace) where the platform allows.
   */
  writeLinked(locator: string, bytes: Uint8Array, expected: FileFingerprint): Promise<FileFingerprint>;
  /** Offers bytes to the user as a downloaded/saved file. */
  saveAs(name: string, bytes: Uint8Array, mime: string): Promise<void>;
  /** Files passed by the OS at launch or via "Open with" while running. */
  onOpenFiles?(handler: (files: PickedFile[]) => void): () => void;
}

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd', '.mdx', '.txt'] as const;

export function isMarkdownName(name: string): boolean {
  const lower = name.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
