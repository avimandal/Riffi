import { useRef, useState } from 'react';
import { t } from '../../i18n';
import { Link } from '../../app/router';
import { Icon } from '../../components/Icon';

/** Does a drag carry files (not text or a link)? */
const hasFiles = (e: React.DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');

/**
 * One big friendly box for adding sheet-music photos. Tap or click anywhere to
 * open the device's own picker (one input, no `capture`, so phones offer both the
 * camera and the photo library); on a computer, photos can also be dropped on it.
 * Once there are pages it shrinks to a compact "Add another page".
 */
export function UploadBox({ compact, full, onFiles }: { compact: boolean; full: boolean; onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  // dragenter/dragleave fire for every child; count them to know when the drag really left.
  const depth = useRef(0);

  const open = () => {
    if (!full) input.current?.click();
  };

  return (
    <div
      className={`dropzone${compact ? ' compact' : ''}${over ? ' over' : ''}${full ? ' full' : ''}`}
      data-testid="upload-box"
      onClick={(e) => {
        // The privacy link inside keeps its own job; the button handles its own click.
        if ((e.target as HTMLElement).closest('a, button')) return;
        open();
      }}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = full ? 'none' : 'copy';
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        if (!full) onFiles([...e.dataTransfer.files]);
      }}
    >
      <button type="button" className="dropzone-main" onClick={open} disabled={full} aria-describedby={compact ? undefined : 'dropzone-help'}>
        <span className="dropzone-art" aria-hidden>
          <Icon name="photo_camera" filled className="dropzone-camera" />
          <span className="dropzone-note">
            <Icon name="music_note" filled />
          </span>
        </span>
        <span className="dropzone-text">
          <span className="dropzone-title">{over ? t.add.dropOver : full ? t.add.full : compact ? t.add.addAnother : t.add.dropTitle}</span>
          {!compact && (
            <span className="dropzone-help" id="dropzone-help">
              <span className="for-touch">{t.add.dropHelp}</span>
              <span className="for-mouse">{t.add.dropHelpMouse}</span>
            </span>
          )}
        </span>
      </button>
      <p className="dropzone-privacy">
        <Icon name="shield_person" />{t.add.onlyMusic}<Link to="/privacy">{t.profiles.privacyLink}</Link>
      </p>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        data-testid="photo-input"
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
    </div>
  );
}
