import { useEffect, useState } from 'react';
import { renderMarkdownLite } from '../RolloutChat/markdownLite';

// "Run files" drawer: the context files that live NEXT TO the loaded rollout
// file — for an auto_eval run that's plan.md / meta.json / results_summary.json
// two levels up and summary.json / execution.jsonl (the evaluator transcript)
// beside target.jsonl. Listed via GET /api/companion, read via GET /api/raw.
// Companion .jsonl files are themselves transcripts — those link out to a
// fresh viewer tab instead of rendering inline.

interface Companion {
  path: string;
  name: string;
  size: number | null;
  kind: 'markdown' | 'json' | 'jsonl';
}

interface CompanionDrawerProps {
  filePath: string;
  isDarkMode: boolean;
  onClose: () => void;
}

function formatBytes(n: number | null): string {
  if (n === null) return '';
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function CompanionDrawer({ filePath, isDarkMode, onClose }: CompanionDrawerProps) {
  const [companions, setCompanions] = useState<Companion[] | null>(null);
  const [selected, setSelected] = useState<Companion | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentTruncated, setContentTruncated] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);

  // Reset when the loaded file changes — in-render key adjustment (the
  // sanctioned alternative to synchronous setState inside the effect).
  const [fetchedPath, setFetchedPath] = useState<string | null>(null);
  if (fetchedPath !== filePath) {
    setFetchedPath(filePath);
    setCompanions(null);
    setSelected(null);
    setContent(null);
  }

  useEffect(() => {
    let alive = true;
    fetch(`/api/companion?file=${encodeURIComponent(filePath)}`)
      .then((r) => (r.ok ? r.json() : { companions: [] }))
      .then((data) => { if (alive) setCompanions(data.companions ?? []); })
      .catch(() => { if (alive) setCompanions([]); });
    return () => { alive = false; };
  }, [filePath]);

  const openCompanion = (companion: Companion) => {
    setSelected(companion);
    setContent(null);
    setContentTruncated(false);
    setContentLoading(true);
    fetch(`/api/raw?file=${encodeURIComponent(companion.path)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        setContentTruncated(r.headers.get('X-Truncated') === 'true');
        return r.text();
      })
      .then((text) => setContent(text))
      .catch(() => setContent('Could not load this file.'))
      .finally(() => setContentLoading(false));
  };

  const subtle = isDarkMode ? 'text-gray-500' : 'text-gray-400';
  const body = isDarkMode ? 'text-gray-300' : 'text-gray-700';
  const border = isDarkMode ? 'border-gray-700' : 'border-gray-200';

  const prettyContent = (companion: Companion, raw: string) => {
    if (companion.kind === 'markdown') {
      return <div className={`text-sm leading-relaxed ${body}`}>{renderMarkdownLite(raw)}</div>;
    }
    let text = raw;
    if (companion.kind === 'json') {
      try {
        text = JSON.stringify(JSON.parse(raw), null, 2);
      } catch { /* show as-is */ }
    }
    return (
      <pre className={`text-xs whitespace-pre-wrap break-words font-data ${body}`}>{text}</pre>
    );
  };

  return (
    // Layout mirrors CommentsPanel: on sm+ a STATIC flex sibling of the
    // content column, so opening it shrinks the transcript instead of covering
    // the text being read. Below sm it falls back to a full-width overlay.
    <div
      className={`absolute inset-y-0 right-0 z-20 w-full max-w-full sm:static sm:shrink-0 sm:w-[24rem] flex flex-col border-l shadow-xl ${
        isDarkMode ? 'bg-[var(--bg-secondary)] border-[var(--border-color)]' : 'bg-white border-gray-200'
      }`}
      role="dialog"
      aria-label="Run files"
    >
      <div className={`flex items-center gap-2 px-3 py-2 border-b ${border}`}>
        <span className={`material-symbols-outlined ${subtle}`} style={{ fontSize: 18 }}>folder_open</span>
        <span className={`text-sm font-semibold ${body}`}>Run files</span>
        {selected && (
          <button
            onClick={() => setSelected(null)}
            className={`text-xs px-1.5 py-0.5 rounded ${isDarkMode ? 'hover:bg-gray-800 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
          >
            ← list
          </button>
        )}
        <button
          onClick={onClose}
          aria-label="Close run files"
          className={`ml-auto flex items-center justify-center w-6 h-6 rounded ${isDarkMode ? 'hover:bg-gray-800 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>close</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-3">
        {selected ? (
          contentLoading ? (
            <div className={`text-sm ${subtle}`}>Loading {selected.name}…</div>
          ) : (
            <>
              <div className={`text-xs mb-2 ${subtle}`}>
                {selected.name}
                {contentTruncated && ' — truncated to the first 2MB'}
              </div>
              {content !== null && prettyContent(selected, content)}
            </>
          )
        ) : companions === null ? (
          <div className={`text-sm ${subtle}`}>Looking for companion files…</div>
        ) : companions.length === 0 ? (
          <div className={`text-sm ${subtle}`}>
            No companion files next to this rollout file.
          </div>
        ) : (
          <div className="space-y-0.5">
            {companions.map((companion) =>
              companion.kind === 'jsonl' ? (
                <a
                  key={companion.path}
                  href={`/?file=${encodeURIComponent(companion.path)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm ${
                    isDarkMode ? 'hover:bg-gray-800' : 'hover:bg-gray-50'
                  } ${body}`}
                  title="A transcript — opens in a new viewer tab"
                >
                  <span className={`material-symbols-outlined flex-shrink-0 ${subtle}`} style={{ fontSize: 16 }}>open_in_new</span>
                  <span className="truncate">{companion.name}</span>
                  <span className={`ml-auto text-xs flex-shrink-0 ${subtle}`}>{formatBytes(companion.size)}</span>
                </a>
              ) : (
                <button
                  key={companion.path}
                  onClick={() => openCompanion(companion)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left ${
                    isDarkMode ? 'hover:bg-gray-800' : 'hover:bg-gray-50'
                  } ${body}`}
                >
                  <span className={`material-symbols-outlined flex-shrink-0 ${subtle}`} style={{ fontSize: 16 }}>
                    {companion.kind === 'markdown' ? 'description' : 'data_object'}
                  </span>
                  <span className="truncate">{companion.name}</span>
                  <span className={`ml-auto text-xs flex-shrink-0 ${subtle}`}>{formatBytes(companion.size)}</span>
                </button>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
