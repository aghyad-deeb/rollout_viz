import { useEffect, useState } from 'react';

// The Library is the landing view when nothing is loaded: the corpus grouped
// by kind (Evals / Training runs / Chats / …), derived server-side from one
// cached S3 listing. Card previews are fetched lazily per expanded group so
// browsing stays listing-cheap.

interface LibraryFile {
  path: string;
  name: string;
  size: number;
  last_modified: string;
  graded: boolean;
}

interface LibraryGroup {
  name: string;
  prefix: string;
  last_modified: string;
  file_count: number;
  total_bytes: number;
  graded: boolean;
  files: LibraryFile[];
}

interface LibraryKind {
  kind: string;
  title: string;
  total_group_count: number;
  groups: LibraryGroup[];
}

interface LibraryResponse {
  kinds: LibraryKind[];
  generated_at: string;
  from_cache: boolean;
  error?: string;
}

interface LibraryPreview {
  available: boolean;
  experiment_name?: string | null;
  model_id?: string | null;
  first_user_message?: string | null;
  message_count?: number | null;
}

interface LibraryViewProps {
  isDarkMode: boolean;
  onOpenFile: (paths: string[]) => void;
  onOpenFileBrowser: () => void;
}

// Loading a whole group goes through the existing multi-file loader; keep the
// batch well under the server's aggregate-size guard.
const LOAD_ALL_MAX_FILES = 20;

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function LibraryView({ isDarkMode, onOpenFile, onOpenFileBrowser }: LibraryViewProps) {
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, LibraryPreview>>({});

  useEffect(() => {
    let alive = true;
    fetch('/api/library')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => { if (alive) setData(body); })
      .catch(() => { if (alive) setLoadFailed(true); });
    return () => { alive = false; };
  }, []);

  const toggleGroup = (key: string, group: LibraryGroup) => {
    const next = expanded === key ? null : key;
    setExpanded(next);
    // Lazy preview: first file of the group, once.
    const first = group.files[0];
    if (next && first && !(key in previews)) {
      fetch(`/api/library/preview?file=${encodeURIComponent(first.path)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((p) => { if (p) setPreviews((prev) => ({ ...prev, [key]: p })); })
        .catch(() => {});
    }
  };

  const subtle = isDarkMode ? 'text-gray-500' : 'text-gray-400';
  const body = isDarkMode ? 'text-gray-300' : 'text-gray-700';
  const cardBase = isDarkMode
    ? 'border-gray-700 hover:bg-gray-800'
    : 'border-gray-200 hover:bg-gray-50';

  const browseButton = (
    <button
      onClick={onOpenFileBrowser}
      className={`px-3 py-1.5 text-sm rounded-md border ${
        isDarkMode
          ? 'border-gray-600 text-gray-300 hover:bg-gray-800'
          : 'border-gray-300 text-gray-600 hover:bg-gray-100'
      }`}
    >
      Browse all files…
    </button>
  );

  if (loadFailed || data?.error) {
    return (
      <div className={`flex-1 flex items-center justify-center ${subtle}`}>
        <div className="text-center">
          <span className="material-symbols-outlined" style={{ fontSize: 48 }}>library_books</span>
          <p className="mt-2 mb-3">Library unavailable{data?.error ? ` — ${data.error}` : ''}</p>
          {browseButton}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={`flex-1 flex items-center justify-center ${subtle}`}>
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500" />
      </div>
    );
  }

  const kinds = data.kinds.filter((k) => k.groups.length > 0);

  return (
    <div className="flex-1 overflow-y-auto custom-scrollbar">
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className={`text-lg font-semibold ${isDarkMode ? 'text-gray-100' : 'text-gray-900'}`}>
            Library
          </h1>
          {browseButton}
        </div>

        {kinds.length === 0 && (
          <p className={subtle}>Nothing here yet — log a rollout or browse for a file.</p>
        )}

        {kinds.map((kindEntry) => (
          <section key={kindEntry.kind} className="mb-6">
            <h2 className={`text-xs font-semibold uppercase tracking-wide mb-1.5 ${subtle}`}>
              {kindEntry.title}
              <span className="ml-2 font-normal normal-case">
                {kindEntry.total_group_count}
                {kindEntry.total_group_count > kindEntry.groups.length ? ` (showing ${kindEntry.groups.length})` : ''}
              </span>
            </h2>
            <div className={`rounded-lg border divide-y ${isDarkMode ? 'border-gray-700 divide-gray-700/60' : 'border-gray-200 divide-gray-100'}`}>
              {kindEntry.groups.map((group) => {
                const key = `${kindEntry.kind}:${group.name}`;
                const isOpen = expanded === key;
                const preview = previews[key];
                return (
                  <div key={key}>
                    <button
                      onClick={() => toggleGroup(key, group)}
                      className={`w-full text-left px-3 py-2 flex items-center gap-3 ${cardBase}`}
                    >
                      <span className={`material-symbols-outlined flex-shrink-0 ${subtle}`} style={{ fontSize: 18 }}>
                        {isOpen ? 'expand_more' : 'chevron_right'}
                      </span>
                      <span className={`text-sm font-medium truncate ${body}`}>{group.name}</span>
                      {group.graded && (
                        <span className={`text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                          isDarkMode ? 'bg-teal-900/50 text-teal-300' : 'bg-teal-100 text-teal-700'
                        }`}>
                          graded
                        </span>
                      )}
                      <span className={`ml-auto text-xs whitespace-nowrap flex-shrink-0 ${subtle}`}>
                        {group.file_count} file{group.file_count === 1 ? '' : 's'} · {formatBytes(group.total_bytes)} · {relativeTime(group.last_modified)}
                      </span>
                    </button>
                    {isOpen && (
                      <div className={`px-3 pb-2 ${isDarkMode ? 'bg-gray-800/40' : 'bg-gray-50/60'}`}>
                        {preview?.available && preview.first_user_message && (
                          <p className={`text-xs italic px-7 py-1.5 truncate ${subtle}`} title={preview.first_user_message}>
                            “{preview.first_user_message}”
                            {preview.model_id ? ` — ${preview.model_id}` : ''}
                          </p>
                        )}
                        {group.files.length > 1 && group.file_count <= LOAD_ALL_MAX_FILES && (
                          <button
                            onClick={() => onOpenFile(group.files.map((f) => f.path))}
                            className={`ml-7 mb-1 text-xs px-2 py-0.5 rounded-md ${
                              isDarkMode ? 'bg-blue-900/50 text-blue-300 hover:bg-blue-900' : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                            }`}
                          >
                            Load all {group.files.length} files
                          </button>
                        )}
                        {group.files.map((file) => (
                          <button
                            key={file.path}
                            onClick={() => onOpenFile([file.path])}
                            className={`w-full text-left pl-7 pr-2 py-1 flex items-center gap-2 text-xs rounded ${cardBase} border-0`}
                          >
                            <span className={`truncate ${body}`}>{file.name}</span>
                            {file.graded && (
                              <span className={`flex-shrink-0 ${isDarkMode ? 'text-teal-400' : 'text-teal-600'}`}>✓ graded</span>
                            )}
                            <span className={`ml-auto whitespace-nowrap flex-shrink-0 ${subtle}`}>
                              {formatBytes(file.size)} · {relativeTime(file.last_modified)}
                            </span>
                          </button>
                        ))}
                        {group.file_count > group.files.length && (
                          <p className={`pl-7 py-1 text-xs ${subtle}`}>
                            +{group.file_count - group.files.length} more — use Browse all files
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
