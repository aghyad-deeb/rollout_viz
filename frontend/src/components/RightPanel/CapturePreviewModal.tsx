import { useEffect, useState, type CSSProperties } from 'react';

interface CapturePreviewModalProps {
  /** Object URL of the rendered capture PNG. */
  imageUrl: string;
  isDarkMode: boolean;
  onCopy: () => void | Promise<void>;
  onDownload: () => void;
  onClose: () => void;
}

// Checkerboard backing so a white or a dark-navy export both stand out
// clearly in the preview area.
const CHECKER: CSSProperties = {
  backgroundColor: '#9ca3af',
  backgroundImage:
    'linear-gradient(45deg, rgba(0,0,0,0.13) 25%, transparent 25%),' +
    'linear-gradient(-45deg, rgba(0,0,0,0.13) 25%, transparent 25%),' +
    'linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.13) 75%),' +
    'linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.13) 75%)',
  backgroundSize: '18px 18px',
  backgroundPosition: '0 0, 0 9px, 9px -9px, -9px 0',
};

/**
 * Modal that shows a rendered capture PNG before it goes to the clipboard,
 * so the user can check theme / width / font-size / collapses, then copy
 * or download it. Esc or a backdrop click closes it.
 */
export function CapturePreviewModal({
  imageUrl,
  isDarkMode,
  onCopy,
  onDownload,
  onClose,
}: CapturePreviewModalProps) {
  const [copied, setCopied] = useState(false);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopy = async () => {
    await onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const panel = isDarkMode ? 'bg-gray-800 text-gray-100' : 'bg-white text-gray-800';
  const border = isDarkMode ? 'border-gray-700' : 'border-gray-200';
  const ghostBtn = isDarkMode
    ? 'text-gray-200 bg-gray-700 hover:bg-gray-600'
    : 'text-gray-700 bg-gray-200 hover:bg-gray-300';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
      data-testid="capture-preview-backdrop"
    >
      <div
        className={`flex flex-col max-w-[90vw] max-h-[90vh] rounded-lg shadow-2xl overflow-hidden ${panel}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`flex items-center justify-between gap-4 px-4 py-2 border-b ${border}`}>
          <span className="text-sm font-medium flex items-center gap-1.5">
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>preview</span>
            Capture preview{dims ? ` (${dims.w} x ${dims.h} px)` : ''}
          </span>
          <button
            onClick={onClose}
            className={`flex items-center justify-center w-7 h-7 rounded ${ghostBtn}`}
            title="Close (Esc)"
            aria-label="Close preview"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>

        {/* items-START, not center: a tall export centered inside an
            overflow-auto flex container has its top pushed above the scroll
            origin and becomes unreachable. Horizontally it still centers. */}
        <div className="overflow-auto custom-scrollbar p-4 flex items-start justify-center" style={CHECKER}>
          <img
            src={imageUrl}
            alt="Capture preview"
            className="max-w-full h-auto block shadow-lg"
            onLoad={(e) => setDims({
              w: e.currentTarget.naturalWidth,
              h: e.currentTarget.naturalHeight,
            })}
          />
        </div>

        <div className={`flex items-center justify-end gap-2 px-4 py-2 border-t ${border}`}>
          <button
            onClick={onDownload}
            className={`flex items-center gap-1.5 px-3 h-8 rounded text-sm font-medium ${ghostBtn}`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>download</span>
            Download
          </button>
          <button
            onClick={handleCopy}
            className={`flex items-center gap-1.5 px-3 h-8 rounded text-sm font-medium text-white ${
              copied ? 'bg-green-600' : 'bg-sky-600 hover:bg-sky-700'
            }`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
              {copied ? 'check' : 'content_copy'}
            </span>
            {copied ? 'Copied!' : 'Copy to clipboard'}
          </button>
        </div>
      </div>
    </div>
  );
}
