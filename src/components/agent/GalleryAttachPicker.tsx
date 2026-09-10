import { createPortal } from 'react-dom';
import { OutputsGallery } from '@/components/media/OutputsGallery';

/** Full-screen outputs-gallery picker for attaching an existing server file to a chat message.
 * OutputsGallery's selection mode auto-copies non-input files into ComfyUI's input folder and
 * reports the resulting input path, so the picked reference needs no upload. */
export function GalleryAttachPicker({ onClose, onPick, title, allowVideos = true }: {
  onClose: () => void;
  /** Receives `subfolder/filename` inside the input folder. */
  onPick: (inputPath: string) => void;
  title: string;
  allowVideos?: boolean;
}) {
  return createPortal(
    <div className="fixed inset-0 z-[9999] bg-[#0b0c0f] overflow-auto">
      <OutputsGallery
        isFileSelectionMode={true}
        allowImages={true}
        allowVideos={allowVideos}
        initialFolder="output"
        onFileSelect={path => { onPick(path); onClose(); }}
        onBackClick={onClose}
        selectionTitle={title}
      />
    </div>,
    document.body,
  );
}
