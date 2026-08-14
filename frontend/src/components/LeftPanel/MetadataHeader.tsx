import { useState } from 'react';

interface MetadataHeaderProps {
  experimentName: string;
  filePaths: string[];
  onFilePathsChange: (paths: string[]) => void;
  totalSamples: number;
  filteredCount: number;
  isDarkMode: boolean;
  isSharedMode?: boolean;
  /** Whether the sample table is currently in session-only random order. */
  isRandomOrder?: boolean;
  /** Shuffle (or reshuffle) the table into a session-only random order. */
  onShuffle?: () => void;
}

export function MetadataHeader({
  experimentName,
  filePaths,
  onFilePathsChange,
  totalSamples,
  filteredCount,
  isDarkMode,
  isSharedMode = false,
  isRandomOrder = false,
  onShuffle,
}: MetadataHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editPath, setEditPath] = useState(filePaths[0] || '');
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [pathCopied, setPathCopied] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onFilePathsChange([editPath]);
    setIsEditing(false);
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(filePaths.join('\n'));
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 2000);
    } catch {
      // Browser blocked the clipboard write (no user gesture, missing
      // permission, etc.). Stay silent — other copy buttons do the same.
    }
  };

  const getFileName = (path: string): string => {
    return path.split('/').pop() || path;
  };

  const displayPath = filePaths.length === 1 
    ? filePaths[0]
    : `${filePaths.length} files loaded`;

  return (
    <div className={`p-3 border-b space-y-2 ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-start gap-2">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            <div className="flex flex-col gap-1 flex-1 min-w-0">
              <div className="text-base font-semibold truncate" title={experimentName || undefined}>
                {experimentName || 'No experiment loaded'}
              </div>
              {isEditing ? (
                <form onSubmit={handleSubmit} className="flex gap-1">
                  <input
                    type="text"
                    value={editPath}
                    onChange={(e) => setEditPath(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        setIsEditing(false);
                      }
                    }}
                    className={`flex-1 min-w-0 text-sm px-2 py-0.5 border rounded focus:outline-none focus:ring focus:ring-blue-500 ${isDarkMode ? 'bg-gray-800 border-gray-600 text-gray-200' : 'border-gray-300'}`}
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="px-2 py-0.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsEditing(false)}
                    className={`px-2 py-0.5 text-xs rounded ${isDarkMode ? 'bg-gray-700 text-gray-300 hover:bg-gray-600' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="flex flex-col gap-1">
                  {isSharedMode ? (
                    <div className={`text-sm truncate ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`} title={displayPath}>
                      {displayPath}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        if (filePaths.length === 1) {
                          setEditPath(filePaths[0]);
                          setIsEditing(true);
                        } else {
                          setShowAllFiles(!showAllFiles);
                        }
                      }}
                      // aria-label is deliberately NOT derived from the path text so the
                      // accessible name stays stable and never collides with other
                      // button queries (e.g. the Shuffle control).
                      aria-label={filePaths.length === 1 ? 'Edit file path' : 'Show or hide loaded files'}
                      title={filePaths.length === 1 ? 'Click to edit file path' : 'Click to show/hide files'}
                      className={`text-sm text-left self-start max-w-full flex items-center gap-1 cursor-pointer ${isDarkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-600 hover:text-gray-800'}`}
                    >
                      <span className="truncate underline decoration-dotted underline-offset-2" title={displayPath}>
                        {displayPath}
                      </span>
                      <span className="material-symbols-outlined shrink-0" style={{ fontSize: 14 }} aria-hidden="true">
                        {filePaths.length === 1 ? 'edit' : 'unfold_more'}
                      </span>
                    </button>
                  )}
                  {showAllFiles && filePaths.length > 1 && (
                    <div className={`text-xs pl-2 border-l-2 space-y-0.5 ${isDarkMode ? 'border-gray-600 text-gray-500' : 'border-gray-300 text-gray-500'}`}>
                      {filePaths.map((path, idx) => (
                        <div key={idx} title={path} className="truncate max-w-[250px]">
                          {getFileName(path)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className={`shrink-0 text-right text-xs flex flex-col gap-1 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            {!isSharedMode && (
              <div className="flex justify-end gap-2">
                <button
                  onClick={copyToClipboard}
                  title={filePaths.join('\n')}
                  aria-label={`Copy path${filePaths.length > 1 ? 's' : ''}`}
                  className={`text-xs flex items-center gap-1 cursor-pointer border-b ${
                    pathCopied
                      ? (isDarkMode ? 'text-green-400 border-green-400' : 'text-green-600 border-green-600')
                      : (isDarkMode ? 'text-gray-400 hover:text-gray-200 border-gray-600 hover:border-gray-400' : 'text-gray-500 hover:text-gray-700 border-gray-300 hover:border-gray-500')
                  }`}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>
                    {pathCopied ? 'check' : 'content_copy'}
                  </span>
                  {pathCopied ? 'Copied' : `Copy path${filePaths.length > 1 ? 's' : ''}`}
                </button>
              </div>
            )}
          </div>
        </div>
        
        <div className="flex justify-between items-center gap-2">
          <div className="text-xs">
            {onShuffle && (
              <button
                onClick={onShuffle}
                title={isRandomOrder
                  ? 'Reshuffle (this session only). Click any column header to restore the original order.'
                  : 'Shuffle rollouts into a random order (this session only; not saved, links still work)'}
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors ${
                  isRandomOrder
                    ? (isDarkMode ? 'border-blue-500 text-blue-300 bg-blue-500/15' : 'border-blue-500 text-blue-600 bg-blue-50')
                    : (isDarkMode ? 'border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-400' : 'border-gray-300 text-gray-500 hover:text-gray-700 hover:border-gray-500')
                }`}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>shuffle</span>
                {isRandomOrder ? 'Shuffled' : 'Shuffle'}
              </button>
            )}
          </div>
          <div className={`text-xs text-right ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            Samples:{' '}
            <span className="whitespace-nowrap">
              <span className={`font-semibold ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>{filteredCount}</span>
              {filteredCount !== totalSamples && (
                <span> of {totalSamples}</span>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
