import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  closeLabel,
  children,
  wide,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  closeLabel: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={`dialog-content ${wide ? 'dialog-wide' : ''}`} {...(description ? {} : { 'aria-describedby': undefined })}>
          <div className="dialog-header">
            <Dialog.Title className="dialog-title">{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label={closeLabel}>
              <X size={16} aria-hidden />
            </Dialog.Close>
          </div>
          {description && <Dialog.Description className="muted px-5">{description}</Dialog.Description>}
          <div className="dialog-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function Field({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="field-control">{children}</div>
    </div>
  );
}

export function Switch({ id, checked, onChange, label }: { id: string; checked: boolean; onChange(value: boolean): void; label: string }) {
  return (
    <label className="switch-row" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
    </label>
  );
}
