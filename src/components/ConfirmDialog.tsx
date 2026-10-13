import type { ReactNode } from 'react';
import { t } from '../i18n';
import { Icon } from './Icon';
import { Modal } from './Modal';

/**
 * "Are you sure?" before anything that can't be undone. The safe choice comes
 * first (and gets the focus), so a quick tap or Enter never deletes anything.
 */
export function ConfirmDialog({
  message,
  confirmLabel,
  cancelLabel = t.common.keepIt,
  title = t.common.areYouSure,
  onConfirm,
  onCancel,
}: {
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  title?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="stack confirm-dialog">
        <p>{message}</p>
        <button className="btn primary big" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button className="btn danger big" onClick={() => void onConfirm()} data-testid="confirm-yes">
          <Icon name="delete" /> {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
