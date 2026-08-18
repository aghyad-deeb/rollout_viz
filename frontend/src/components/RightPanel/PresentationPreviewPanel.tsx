import { useState } from 'react';
import {
  encodeImage,
  downloadBlob,
  copyImageToClipboard,
  captureWidthPresets,
  capturePageWidthPt,
  capturePhysicalSizeIn,
  FONT_SIZE_PRESETS,
  PAPER_BODY_PT,
  type DownloadFormat,
} from '../../utils/captureImage';
import {
  PRESENTATION_ROLE_OPTIONS,
  parsePresentationToolCallsJson,
  type PresentationMessageDraft,
} from '../../utils/presentationDraft';
import type { CaptureStyle, ExportWidth, FontSize } from '../../types';

interface PresentationPreviewPanelProps {
  /** Object URL of the rendered capture PNG (for display), or null. */
  imageUrl: string | null;
  /** The capture PNG Blob itself — used for copy / download so they don't
   *  depend on the (revocable) object URL. Null before the first capture. */
  imageBlob: Blob | null;
  /** True while the shown image is behind the latest edits (a re-render is
   *  debouncing/in flight) — the preview dims and Copy/Download hold so a
   *  stale image can't be exported. */
  isPending?: boolean;
  isDarkMode: boolean;
  imageTheme: 'light' | 'dark';
  exportWidth: ExportWidth;
  fontSize: FontSize;
  /** Figure style — 'screen' (the app's look) or 'paper' (figure style). */
  captureStyle?: CaptureStyle;
  onImageThemeChange: (theme: 'light' | 'dark') => void;
  onExportWidthChange: (width: ExportWidth) => void;
  onFontSizeChange: (size: FontSize) => void;
  /** Required: the style toggle is always live, never a decorative control. */
  onCaptureStyleChange: (style: CaptureStyle) => void;
  activeMessageIndex: number | null;
  /** One label per message card (e.g. its effective role/display label) —
   *  the card count is derived from this array's length. */
  messageLabels: string[];
  /** Base name (no extension) for downloaded / copied captures. */
  exportBaseName?: string;
  activeDraft: PresentationMessageDraft | null;
  activeDraftDirty: boolean;
  draftCount: number;
  onActiveMessageIndexChange: (index: number | null) => void;
  onActiveDraftChange: (draft: PresentationMessageDraft) => void;
  onResetActiveDraft: () => void;
  onClearDrafts: () => void;
}

const FORMATS: { id: DownloadFormat; label: string; ext: string }[] = [
  { id: 'png', label: 'PNG', ext: 'png' },
  { id: 'jpeg', label: 'JPEG', ext: 'jpg' },
  { id: 'webp', label: 'WebP', ext: 'webp' },
  { id: 'pdf', label: 'PDF', ext: 'pdf' },
];

// The one new capture control: which figure style a capture is rendered in.
const CAPTURE_STYLES: { id: CaptureStyle; label: string; title: string }[] = [
  { id: 'screen', label: 'Screen', title: "The app's transcript look — role colors, card tints, your theme" },
  { id: 'paper',  label: 'Paper',  title: `Research-paper figure — white ground, ink only, typeset at ${PAPER_BODY_PT}pt for the chosen column width` },
];

// Tooltips for the controls the paper style pins (it is designed at final
// size on the printed page, so neither is a free choice there).
const LOCKED_BY_PAPER = {
  theme: 'Locked by the Paper figure style — a paper figure is always light (it sits on the page). Switch to Screen to choose a theme.',
  font: `Locked by the Paper figure style — body text is typeset at ${PAPER_BODY_PT}pt for the chosen column width. Switch to Screen to choose a size.`,
};

// Persisted so the download format-picker stays on the user's last choice.
// The two figure styles keep SEPARATE keys and separate defaults: a screen
// capture is a screenshot (PNG), a paper capture is a figure destined for
// LaTeX (a vector-page PDF at its nominal column width, lossless inside).
// Splitting the keys means picking PNG for a paper figure never demotes the
// screen style's default, or vice versa.
const FORMAT_KEY = 'rollout_viz_capture_format';
const PAPER_FORMAT_KEY = 'rollout_viz_capture_format_paper';

function isDownloadFormat(value: string | null): value is DownloadFormat {
  return FORMATS.some((format) => format.id === value);
}

function formatKey(style: CaptureStyle): string {
  return style === 'paper' ? PAPER_FORMAT_KEY : FORMAT_KEY;
}

function loadFormat(style: CaptureStyle): DownloadFormat {
  let saved: string | null = null;
  try { saved = localStorage.getItem(formatKey(style)); } catch { /* ignore */ }
  if (isDownloadFormat(saved)) return saved;
  return style === 'paper' ? 'pdf' : 'png';
}

/**
 * Left-panel content while Presentation Mode is on: the image-capture
 * settings, presentation-only card edits, a live preview of the active card's
 * capture, and a download control whose format picker remembers the last
 * format used.
 */
export function PresentationPreviewPanel({
  imageUrl,
  imageBlob,
  isPending = false,
  isDarkMode,
  imageTheme,
  exportWidth,
  fontSize,
  captureStyle = 'screen',
  onImageThemeChange,
  onExportWidthChange,
  onFontSizeChange,
  onCaptureStyleChange,
  activeMessageIndex,
  messageLabels,
  exportBaseName,
  activeDraft,
  activeDraftDirty,
  draftCount,
  onActiveMessageIndexChange,
  onActiveDraftChange,
  onResetActiveDraft,
  onClearDrafts,
}: PresentationPreviewPanelProps) {
  const isPaper = captureStyle === 'paper';
  const [format, setFormat] = useState<DownloadFormat>(() => loadFormat(captureStyle));
  // Rendered raster dimensions, read off the preview <img> — only their ratio
  // is used, to state the figure's final PHYSICAL size (see the footer).
  const [pixelSize, setPixelSize] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'copied' | 'saved' | null>(null);
  const [isCardEditOpen, setIsCardEditOpen] = useState(false);

  // Switching figure style swaps in that style's remembered format (PDF for
  // paper, PNG for screen, unless the user chose otherwise IN THAT STYLE).
  // In-render state adjustment — React's recommended alternative to an effect.
  const [formatStyle, setFormatStyle] = useState<CaptureStyle>(captureStyle);
  if (formatStyle !== captureStyle) {
    setFormatStyle(captureStyle);
    setFormat(loadFormat(captureStyle));
  }

  // Null under the screen style (a screenshot has no physical size) and until
  // the preview image has reported its dimensions.
  const physicalSize = pixelSize
    ? capturePhysicalSizeIn(captureStyle, exportWidth, pixelSize.w, pixelSize.h)
    : null;

  const pickFormat = (f: DownloadFormat) => {
    setFormat(f);
    try { localStorage.setItem(formatKey(captureStyle), f); } catch { /* ignore */ }
  };

  const handleDownload = async () => {
    if (!imageBlob || busy) return;
    setBusy(true);
    try {
      // Paper PDFs carry their nominal physical width (234pt for a column),
      // so the figure drops into LaTeX at 1:1.
      const blob = await encodeImage(imageBlob, format, capturePageWidthPt(captureStyle, exportWidth));
      const ext = FORMATS.find((f) => f.id === format)?.ext ?? 'png';
      downloadBlob(blob, `${exportBaseName ?? 'rollout-capture'}.${ext}`);
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
      const ok = await copyImageToClipboard(imageBlob, '', `${exportBaseName ?? 'rollout-capture'}.png`);
      setCopied(ok ? 'copied' : 'saved');
      setTimeout(() => setCopied(null), 2000);
    } catch { /* ignore */ }
    finally { setBusy(false); }
  };

  const updateDraft = (patch: Partial<PresentationMessageDraft>) => {
    if (!activeDraft) return;
    onActiveDraftChange({ ...activeDraft, ...patch });
  };

  const toolCallsParse = activeDraft
    ? parsePresentationToolCallsJson(activeDraft.toolCallsJson)
    : null;
  const toolCallsError = toolCallsParse && !toolCallsParse.ok ? toolCallsParse.error : null;

  const muted = isDarkMode ? 'text-gray-400' : 'text-gray-500';
  const border = isDarkMode ? 'border-gray-700' : 'border-gray-200';
  const ctrl = isDarkMode
    ? 'bg-gray-800 border-gray-600 text-gray-200'
    : 'bg-white border-gray-300 text-gray-700';
  const ghostBtn = isDarkMode
    ? 'text-gray-300 hover:bg-gray-700 disabled:text-gray-600'
    : 'text-gray-600 hover:bg-gray-100 disabled:text-gray-300';

  return (
    <div className={`h-full flex flex-col ${isDarkMode ? 'bg-[var(--bg-secondary)]' : 'bg-gray-50'}`}>
      <div
        className={`px-3 py-2 border-b text-sm font-medium flex items-center gap-1.5 ${border} ${
          isDarkMode ? 'text-gray-200' : 'text-gray-700'
        }`}
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>preview</span>
        Capture preview
      </div>

      {/* Image-capture settings */}
      {/* @container: the row labels come back whenever THIS PANEL (not the
          viewport — the divider is user-resizable) is wide enough; below
          that they live on aria-label/title only. */}
      <div className={`@container px-3 py-2 border-b flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs ${border}`}>
        {/* Figure style governs the three controls after it, so it leads.
            Screen = the app's own transcript look (the default, forever);
            Paper = the research-paper figure style (white, ink-only, typeset
            at final size), which pins the theme and the font size. */}
        {/* No visible "Style" / "Theme" text: each group's buttons already
            say what they are (Screen/Paper, Light/Dark) and the two words were
            the last thing pushing the row onto a second line under 1280px.
            The names survive for AT on the groups' aria-labels. */}
        <div className="flex items-center gap-1">
          <div
            role="group"
            aria-label="Figure style"
            className={`flex rounded overflow-hidden border ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}
          >
            {CAPTURE_STYLES.map((s) => (
              <button
                key={s.id}
                onClick={() => onCaptureStyleChange(s.id)}
                title={s.title}
                aria-pressed={captureStyle === s.id}
                className={`px-1.5 py-0.5 ${
                  captureStyle === s.id
                    ? 'bg-sky-600 text-white'
                    : isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <div role="group" aria-label="Image theme" className={`flex rounded overflow-hidden border ${isDarkMode ? 'border-gray-600' : 'border-gray-300'}`}>
            {(['light', 'dark'] as const).map((t) => {
              // Paper is always light. The Light button therefore reads as
              // SELECTED BUT LOCKED — same sky fill as a live selection, held
              // back to 60% and carrying a lock glyph — rather than the old
              // gray wash, which looked like "off" and left the group
              // apparently unselected. `aria-pressed` states it for AT.
              const isSelected = isPaper ? t === 'light' : imageTheme === t;
              const isLocked = isPaper && t === 'light';
              return (
                <button
                  key={t}
                  onClick={() => onImageThemeChange(t)}
                  disabled={isPaper}
                  aria-pressed={isSelected}
                  title={isPaper ? LOCKED_BY_PAPER.theme : undefined}
                  className={`px-1.5 py-0.5 inline-flex items-center gap-0.5 disabled:cursor-not-allowed ${
                    isSelected
                      ? `bg-sky-600 text-white ${isLocked ? 'opacity-60' : ''}`
                      : `disabled:opacity-50 ${isDarkMode ? 'bg-gray-800 text-gray-300 hover:bg-gray-700' : 'bg-white text-gray-600 hover:bg-gray-50'}`
                  }`}
                >
                  {isLocked && (
                    <span className="material-symbols-outlined" style={{ fontSize: 12 }} aria-hidden="true">lock</span>
                  )}
                  {t === 'light' ? 'Light' : 'Dark'}
                </button>
              );
            })}
          </div>
        </div>
        {/* Named for AT and on hover, not in ink: the option text ("Column
            (3.25 in)", "Paper 1-column", "Slide") already says "width", and at
            a 1280px window the four visible words were what still forced the
            row onto a second line. */}
        <span className={`hidden @[34rem]:inline ${muted}`} aria-hidden="true">Width</span>
        <select
          aria-label="Export width"
          title="Export width"
          value={exportWidth}
          onChange={(e) => onExportWidthChange(e.target.value as ExportWidth)}
          className={`px-1 py-0.5 rounded border ${ctrl}`}
        >
          {captureWidthPresets(captureStyle).map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {/* Under Paper the size is not a choice — it is the derived final
            size. A disabled dropdown still listing Small/Medium/Large invites
            a click that does nothing AND is the widest control in the row (it
            is what pushed the settings onto a second line). A locked readout
            states the actual value in a third of the width. */}
        {isPaper ? (
          <span
            data-testid="paper-font-locked"
            aria-label={`Font size ${PAPER_BODY_PT}pt, locked`}
            title={LOCKED_BY_PAPER.font}
            className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded border ${ctrl} opacity-70`}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 12 }} aria-hidden="true">lock</span>
            {PAPER_BODY_PT}pt
          </span>
        ) : (
          <label className="flex items-center gap-1">
            <span className={`hidden @[34rem]:inline ${muted}`} aria-hidden="true">Font</span>
            <select
              aria-label="Font size"
              title="Font size"
              value={fontSize}
              onChange={(e) => onFontSizeChange(e.target.value as FontSize)}
              className={`px-1 py-0.5 rounded border ${ctrl}`}
            >
              {FONT_SIZE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className={`border-b text-xs ${border}`}>
        <button
          type="button"
          aria-expanded={isCardEditOpen}
          onClick={() => setIsCardEditOpen((open) => !open)}
          className={`w-full px-3 py-2 flex items-center justify-between gap-2 text-left ${
            isDarkMode ? 'hover:bg-gray-800/70' : 'hover:bg-gray-100'
          }`}
        >
          <span className={`inline-flex items-center gap-1.5 font-medium ${isDarkMode ? 'text-gray-200' : 'text-gray-700'}`}>
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>
              {isCardEditOpen ? 'expand_less' : 'expand_more'}
            </span>
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>edit_square</span>
            Card edit
          </span>
          <span className={`inline-flex items-center gap-2 min-w-0 ${muted}`}>
            <span className="truncate">
              {activeMessageIndex === null
                ? 'No card'
                : `#${activeMessageIndex + 1} · ${messageLabels[activeMessageIndex] ?? ''}`}
            </span>
            {activeDraftDirty && <span className={isDarkMode ? 'text-sky-300' : 'text-sky-700'}>Modified</span>}
          </span>
        </button>

        {isCardEditOpen && (
          <div className="px-3 pb-2 space-y-2">
            <div className="flex items-center justify-end gap-1">
              <button
                onClick={onResetActiveDraft}
                disabled={!activeDraft || !activeDraftDirty}
                className={`px-1.5 py-0.5 rounded disabled:pointer-events-none ${ghostBtn}`}
              >
                Reset
              </button>
              <button
                onClick={onClearDrafts}
                disabled={draftCount === 0}
                className={`px-1.5 py-0.5 rounded disabled:pointer-events-none ${ghostBtn}`}
              >
                Clear all
              </button>
            </div>

            <label className="flex items-center gap-1.5">
              <span className={muted}>Card</span>
              <select
                aria-label="Card"
                value={activeMessageIndex ?? ''}
                onChange={(e) => onActiveMessageIndexChange(e.target.value === '' ? null : Number(e.target.value))}
                className={`min-w-0 flex-1 px-1.5 py-0.5 rounded border ${ctrl}`}
              >
                <option value="">Select a card</option>
                {messageLabels.map((messageLabel, index) => (
                  <option key={index} value={index}>{`#${index + 1} · ${messageLabel}`}</option>
                ))}
              </select>
            </label>

            {activeDraft ? (
              <div className="space-y-2">
                <label className="flex items-center gap-1.5">
                  <span className={muted}>Role</span>
                  <select
                    aria-label="Role"
                    value={activeDraft.role}
                    onChange={(e) => updateDraft({ role: e.target.value as PresentationMessageDraft['role'] })}
                    className={`min-w-0 flex-1 px-1.5 py-0.5 rounded border ${ctrl}`}
                  >
                    {PRESENTATION_ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>{role}</option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5">
                  <span className={muted}>Label</span>
                  <input
                    aria-label="Label"
                    type="text"
                    value={activeDraft.displayLabel ?? ''}
                    onChange={(e) => updateDraft({ displayLabel: e.target.value })}
                    placeholder={activeDraft.role === 'file' ? 'example.py' : activeDraft.role}
                    className={`min-w-0 flex-1 px-1.5 py-0.5 rounded border ${ctrl}`}
                  />
                </label>
                <label className="block space-y-1">
                  <span className={muted}>Content</span>
                  <textarea
                    aria-label="Content"
                    value={activeDraft.content}
                    onChange={(e) => updateDraft({ content: e.target.value })}
                    rows={5}
                    className={`w-full resize-y rounded border px-2 py-1 font-mono text-[11px] leading-4 ${ctrl}`}
                  />
                </label>

                {activeDraft.role === 'assistant' && (
                  <>
                    <label className="block space-y-1">
                      <span className={muted}>Reasoning</span>
                      <textarea
                        aria-label="Reasoning"
                        value={activeDraft.reasoning}
                        onChange={(e) => updateDraft({ reasoning: e.target.value })}
                        rows={3}
                        className={`w-full resize-y rounded border px-2 py-1 font-mono text-[11px] leading-4 ${ctrl}`}
                      />
                    </label>

                    <label className="block space-y-1">
                      <span className={muted}>Tool calls JSON</span>
                      <textarea
                        aria-label="Tool calls JSON"
                        value={activeDraft.toolCallsJson}
                        onChange={(e) => updateDraft({ toolCallsJson: e.target.value })}
                        rows={3}
                        className={`w-full resize-y rounded border px-2 py-1 font-mono text-[11px] leading-4 ${
                          toolCallsError ? 'border-red-400 text-red-700 bg-red-50' : ctrl
                        }`}
                      />
                    </label>
                    {toolCallsError && <div className="text-red-500">{toolCallsError}</div>}
                  </>
                )}
              </div>
            ) : (
              <div className={`py-3 text-center ${muted}`}>Click or select a message card to edit it.</div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto custom-scrollbar p-3 flex items-start justify-center relative">
        {imageUrl ? (
          <>
            <img
              src={imageUrl}
              alt="Live capture preview"
              onLoad={(e) => setPixelSize({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })}
              className={`max-w-full h-auto rounded shadow-lg transition-opacity ${isPending ? 'opacity-40' : ''}`}
            />
            {isPending && (
              <div className={`absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2 py-1 rounded-full text-xs shadow ${
                isDarkMode ? 'bg-gray-800 text-gray-300' : 'bg-white text-gray-600'
              }`}>
                <span className="material-symbols-outlined animate-spin" style={{ fontSize: 13 }} aria-hidden="true">progress_activity</span>
                Updating preview…
              </div>
            )}
          </>
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
        <div className={`px-3 py-2 border-t space-y-1.5 ${border}`}>
        {/* Final physical size. A paper figure is placed at 1:1, so the
            question before download is "does this fit the page?" — which the
            pixel count cannot answer (the raster is supersampled). The width
            is the chosen column; the height is whatever this card came out to. */}
        {/* Gated on isPending like the Download button: for ~400ms after a
            style flip the live style and the PREVIOUS raster's dimensions
            disagree, and a confidently wrong size is worse than a beat of
            silence. */}
        {physicalSize && !isPending && (
          <div data-testid="paper-size-readout" className={`text-[11px] ${muted}`}>
            Final size {physicalSize.widthIn.toFixed(2)} × {physicalSize.heightIn.toFixed(2)} in
            {' '}<span className="opacity-70">at 1:1</span>
          </div>
        )}
        <div className="flex items-center gap-2">
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
            disabled={busy || isPending}
            title={isPending ? 'Preview is updating — hold on' : undefined}
            className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium text-white bg-sky-600 hover:bg-sky-700 disabled:opacity-60"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 17 }}>download</span>
            {busy ? 'Preparing...' : isPending ? 'Updating…' : 'Download'}
          </button>
          <button
            onClick={handleCopy}
            disabled={busy || isPending}
            title={isPending ? 'Preview is updating — hold on' : 'Copy image to clipboard'}
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
        </div>
      )}
    </div>
  );
}
