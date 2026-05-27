import { useState } from 'react';
import {
  encodeImage,
  downloadBlob,
  copyImageToClipboard,
  EXPORT_WIDTH_PRESETS,
  FONT_SIZE_PRESETS,
  type DownloadFormat,
} from '../../utils/captureImage';
import type { ExportWidth, FontSize } from '../../types';

interface PresentationPreviewPanelProps {
  /** Object URL of the rendered capture PNG (for display), or null. */
  imageUrl: string | null;
  /** The capture PNG Blob itself — used for copy / download so they don't
   *  depend on the (revocable) object URL. Null before the first capture. */
  imageBlob: Blob | null;
  isDarkMode: boolean;
  imageTheme: 'light' | 'dark';
  exportWidth: ExportWidth;
  fontSize: FontSize;
  onImageThemeChange: (theme: 'light' | 'dark') => void;
  onExportWidthChange: (width: ExportWidth) => void;
  onFontSizeChange: (size: FontSize) => void;
}

const FORMATS: { id: DownloadFormat; label: string; ext: string }[] = [
  { id: 'png', label: 'PNG', ext: 'png' },
  { id: 'jpeg', label: 'JPEG', ext: 'jpg' },
  { id: 'webp', label: 'WebP', ext: 'webp' },
  { id: 'pdf', label: 'PDF', ext: 'pdf' },
];

// Persisted so the download format-picker stays on the user's last choice.
const FORMAT_KEY = 'rollout_viz_capture_format';

function loadFormat(): DownloadFormat {
  const saved = localStorage.getItem(FORMAT_KEY);
  return saved === 'jpeg' || saved === 'webp' || saved === 'png' ? saved : 'png';
}

/**
 * Left-panel content while Presentation Mode is on: the image-capture
 * settings, a live preview of the active card's capture, and a download
 * control whose format picker remembers the last format used.
 */
export function PresentationPreviewPanel({
  imageUrl,
  imageBlob,
  isDarkMode,
  imageTheme,
  exportWidth,
  fontSize,
  onImageThemeChange,
  onExportWidthChange,
  onFontSizeChange,
}: PresentationPreviewPanelProps) {
  const [format, setFormat] = useState<DownloadFormat>(loadFormat);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'copied' | 'saved' | null>(null);

  const pickFormat = (f: DownloadFormat) => {
    setFormat(f);
    try { localStorage.setItem(FORMAT_KEY, f); } catch { /* ignore */ }
  };

  const handleDownload = async () => {
    if (!imageBlob || busy) return;
    setBusy(true);
    try {
      const blob = await encodeImage(imageBlob, format);
      const ext = FORMATS.find((f) => f.id === format)?.ext ?? 'png';
      downloadBlob(blob, `rollout-capture.${ext}`);
    } catch { /* ignore */ }
    finally { setBusy(false); }
  };

  // Copy the previewed PNG (deep-link metadata included) to the clipboard.
  // The Blob is passed straight in — fetching the object URL first risked a
  // revoked URL and pushed the clipboard write past the user-gesture
  // window, which is what made this fail intermittently.
  const handleCopy = async () => {
    if (!imageBlob || busy) return;
    setBusy(true);
    try {
      const ok = await copyImageToClipboard(imageBlob, '');
      setCopied(ok ? 'copied' : 'saved');
      setTimeout(() => setCopied(null), 2000);
    } catch { /* ignore */ }
    finally { setBusy(false); }
  };

  const muted = isDarkMode ? 'text-gray-400' : 'text-gray-500';
  const border = isDarkMode ? 'border-gray-700' : 'border-gray-200';
  const ctrl = isDarkMode
    ? 'bg-gray-800 border-gray-600 text-gray-200'
    : 'bg-white border-gray-300 text-gray-700';

  return (
    <div className={`h-full flex flex-col ${isDarkMode ? 'bg-[#16213e]' : 'bg-gray-50'}`}>
      <div
        className={`px-3 py-2 border-b text-sm font-medium flex items-center gap-1.5 ${border} ${
          isDarkMode ? 'text-gray-200' : 'text-gray-700'
        }`}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>preview</span>
        Capture preview
      </div>

      {/* Image-capture settings */}
      <div className={`px-3 py-2 border-b flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs ${border}`}>
        <div className="flex items-center gap-1.5">
          <span className={muted}>Theme</span>
          <div className={`flex rounded overflow-hidden border ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}>
            {(['light', 'dark'] as const).map((t) => (
              <button
                key={t}
                onClick={() => onImageThemeChange(t)}
                className={`px-2 py-0.5 ${
                  imageTheme === t
                    ? 'bg-sky-600 text-white'
                    : isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {t === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-1.5">
          <span className={muted}>Width</span>
          <select
            value={exportWidth}
            onChange={(e) => onExportWidthChange(e.target.value as ExportWidth)}
            className={`px-1.5 py-0.5 rounded border ${ctrl}`}
          >
            {EXPORT_WIDTH_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className={muted}>Font</span>
          <select
            value={fontSize}
            onChange={(e) => onFontSizeChange(e.target.value as FontSize)}
            className={`px-1.5 py-0.5 rounded border ${ctrl}`}
          >
            {FONT_SIZE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex-1 overflow-auto p-3 flex items-start justify-center">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt="Live capture preview"
            className="max-w-full h-auto rounded shadow-lg"
          />
        ) : (
          <div
            className={`h-full flex items-center justify-center text-center text-sm px-6 ${
              isDarkMode ? 'text-gray-500' : 'text-gray-400'
            }`}
          >
            <div>
              <span className="material-symbols-outlined block mx-auto mb-2" style={{ fontSize: 36 }}>
                image
              </span>
              Click a message card to preview how its capture will look.
            </div>
          </div>
        )}
      </div>

      {imageUrl && (
        <div className={`flex items-center gap-2 px-3 py-2 border-t ${border}`}>
          <select
            value={format}
            onChange={(e) => pickFormat(e.target.value as DownloadFormat)}
            title="Download format"
            className={`px-1.5 py-1 text-xs rounded border ${ctrl}`}
          >
            {FORMATS.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </select>
          <button
            onClick={handleDownload}
            disabled={busy}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-60"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>download</span>
            {busy ? 'Preparing...' : 'Download'}
          </button>
          <button
            onClick={handleCopy}
            disabled={busy}
            title="Copy image to clipboard"
            className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium disabled:opacity-60 ${
              copied
                ? 'bg-green-600 text-white'
                : isDarkMode ? 'bg-gray-700 text-gray-200 hover:bg-gray-600' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
              {copied ? 'check' : 'content_copy'}
            </span>
            {copied === 'copied' ? 'Copied' : copied === 'saved' ? 'Saved' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}
