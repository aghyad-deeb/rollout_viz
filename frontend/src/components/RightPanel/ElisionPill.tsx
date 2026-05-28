import { useState, useRef, useEffect } from 'react';

interface ElisionPillProps {
  /** The collapsed text — shown as a hover-preview tooltip. */
  text: string;
  /** User-edited label. Undefined → show the default. */
  label?: string;
  isDarkMode: boolean;
  /** Effective line-placement state — drives the right-click menu ticks. */
  joinBefore?: boolean;
  joinAfter?: boolean;
  onChangeLabel: (label: string | undefined) => void;
  onRemove: () => void;
  onHide: () => void;
  /** Toggle whether the pill shares a line with the text before / after it. */
  onToggleJoinBefore?: () => void;
  onToggleJoinAfter?: () => void;
}

/**
 * Inline `[...]` pill standing in for a collapsed span of message text.
 *  - Left click  -> expand (remove the collapse).
 *  - Right click -> a small menu: edit the label, hide the marker, or
 *    toggle whether the pill sits on the same line as the surrounding text.
 * The edit input and the menu carry `presentation-chrome` so the captured
 * image shows only a static `[label]`.
 */
export function ElisionPill({
  text,
  label,
  isDarkMode,
  joinBefore = false,
  joinAfter = false,
  onChangeLabel,
  onRemove,
  onHide,
  onToggleJoinBefore,
  onToggleJoinAfter,
}: ElisionPillProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Dismiss the right-click menu on any outside click / Escape / scroll.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const display = label && label.trim() ? label.trim() : '...';
  // Whitespace-collapsed copy of the hidden text, surfaced on hover.
  const preview = text.replace(/\s+/g, ' ').trim();

  const commit = () => {
    onChangeLabel(draft.trim() || undefined);
    setEditing(false);
  };

  const pillClass = isDarkMode
    ? 'border-gray-500 text-gray-400 hover:bg-gray-700/50'
    : 'border-gray-400 text-gray-500 hover:bg-gray-100';

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`presentation-chrome inline-block align-baseline mx-0.5 px-1 text-xs rounded border ${
          isDarkMode ? 'bg-gray-800 border-gray-500 text-gray-200' : 'bg-white border-gray-400 text-gray-800'
        }`}
        value={draft}
        size={Math.max(draft.length, 6)}
        placeholder="label…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        }}
        onBlur={commit}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  const menuItem = isDarkMode ? 'hover:bg-gray-700 text-gray-200' : 'hover:bg-gray-100 text-gray-700';

  // One menu row. `active === false` hides the leading icon (used so the
  // checkmark only shows when a same-line toggle is on); `undefined` keeps
  // it visible (used for the static Edit / Hide icons).
  const menuRow = (icon: string, rowLabel: string, onClick: () => void, active?: boolean) => (
    <button
      type="button"
      className={`flex w-full items-center gap-1.5 px-3 py-1 text-left ${menuItem}`}
      onClick={() => { setMenu(null); onClick(); }}
    >
      <span
        className="material-symbols-outlined"
        style={{ fontSize: 14, visibility: active === false ? 'hidden' : 'visible' }}
      >
        {icon}
      </span>
      <span>{rowLabel}</span>
    </button>
  );

  return (
    <>
      <span
        className={`elision-pill inline align-baseline mx-0.5 px-1 rounded border border-dashed text-xs whitespace-normal break-words [overflow-wrap:anywhere] cursor-pointer transition-colors ${pillClass}`}
        title={`Collapsed: ${preview.slice(0, 120)}${preview.length > 120 ? '...' : ''} (click to expand, right-click for options)`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        [{display}]
      </span>
      {menu && (
        <div
          data-testid="elision-pill-menu"
          className={`presentation-chrome fixed z-[200] min-w-[13rem] py-1 rounded-md border shadow-lg text-xs ${
            isDarkMode ? 'bg-gray-800 border-gray-600' : 'bg-white border-gray-300'
          }`}
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menuRow('edit', 'Edit text', () => { setDraft(label ?? ''); setEditing(true); })}
          {menuRow('visibility_off', 'Hide ellipsis', onHide)}
          <div className={`my-1 border-t ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`} />
          {menuRow('check', 'Same line as text before', () => onToggleJoinBefore?.(), joinBefore)}
          {menuRow('check', 'Same line as text after', () => onToggleJoinAfter?.(), joinAfter)}
        </div>
      )}
    </>
  );
}
