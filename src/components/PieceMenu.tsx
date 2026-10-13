import { useState } from 'react';
import { t } from '../i18n';
import { navigate } from '../app/router';
import { deletePiece } from '../data/repo';
import { downloadMusicXml } from '../data/download';
import type { Piece } from '../data/types';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';
import { Modal } from './Modal';

/** The … menu for a saved piece (library card and Practice screen). */
export function PieceMenu({ piece, from, onClose }: { piece: Piece; from: 'home' | 'practice'; onClose: () => void }) {
  const [removing, setRemoving] = useState(false);
  if (removing) {
    return (
      <ConfirmDialog
        message={t.home.confirmDelete(piece.title)}
        confirmLabel={t.home.confirmDeleteYes}
        onCancel={() => setRemoving(false)}
        onConfirm={async () => {
          await deletePiece(piece.id);
          onClose();
          if (from === 'practice') navigate('/home', { replace: true });
        }}
      />
    );
  }
  return (
    <Modal title={piece.title} onClose={onClose}>
      <div className="stack">
        {from === 'home' && (
          <button className="btn primary big" onClick={() => navigate(`/practice/${piece.id}`)}>
            <Icon name="play_arrow" filled /> {t.home.practise}
          </button>
        )}
        <button className="btn big" onClick={() => navigate(`/review/${piece.id}?from=${from}`)} data-testid="edit-music">
          <Icon name="edit" /> {t.home.editPiece}
        </button>
        <button
          className="btn big"
          onClick={async () => {
            await downloadMusicXml(piece.musicxml, piece.title);
            onClose();
          }}
          data-testid="download-music"
        >
          <Icon name="download" /> {t.home.download}
        </button>
        {from === 'home' && (
          <button className="btn danger" onClick={() => setRemoving(true)}>
            <Icon name="delete" /> {t.home.deletePiece}
          </button>
        )}
      </div>
    </Modal>
  );
}
