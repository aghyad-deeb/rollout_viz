import { useState, useEffect, useCallback } from 'react';
import type { FileInfo } from '../../types';

interface FileBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectFiles: (filePaths: string[]) => void;
  markedFiles: Set<string>;
  onToggleMark: (filePath: string) => void;
  isDarkMode: boolean;
}

export function FileBrowser({
  isOpen,
  onClose,
  onSelectFiles,
  markedFiles,
  onToggleMark,
  isDarkMode,
}: FileBrowserProps) {
  const [directoryPath, setDirectoryPath] = useState('');
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMarkedOnly, setShowMarkedOnly] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  const fetchFiles = useCallback(async (path: string) => {
    if (!path.trim()) {
      setFiles([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let response: Response;

      if (path.startsWith('s3://')) {
        // Parse S3 path: s3://bucket/prefix
        const s3Path = path.slice(5); // Remove 's3://'
        const slashIndex = s3Path.indexOf('/');
        const bucket = slashIndex > 0 ? s3Path.slice(0, slashIndex) : s3Path;
        const prefix = slashIndex > 0 ? s3Path.slice(slashIndex + 1) : '';
        
        response = await fetch(
          `/api/files/s3?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}`
        );
      } else {
        // Local directory
        response = await fetch(
          `/api/files/local?directory=${encodeURIComponent(path)}`
        );
      }

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to list files');
      }

      const data = await response.json();
      setFiles(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch files');
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      // Don't reset path if user had entered one
      setError(null);
    }
  }, [isOpen]);

  const handleBrowse = () => {
    fetchFiles(directoryPath);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleBrowse();
    }
  };

  const getFullPath = (file: FileInfo): string => {
    return directoryPath.startsWith('s3://')
      ? `s3://${directoryPath.slice(5).split('/')[0]}/${file.key}`
      : file.key;
  };

  const handleFileClick = (file: FileInfo) => {
    const filePath = getFullPath(file);
    // Toggle selection
    setSelectedFiles(prev => {
      const newSet = new Set(prev);
      if (newSet.has(filePath)) {
        newSet.delete(filePath);
      } else {
        newSet.add(filePath);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    const allPaths = displayedFiles.map(f => getFullPath(f));
    setSelectedFiles(new Set(allPaths));
  };

  const handleSelectNone = () => {
    setSelectedFiles(new Set());
  };

  const handleLoadSelected = () => {
    if (selectedFiles.size > 0) {
      onSelectFiles(Array.from(selectedFiles));
      onClose();
    }
  };

  const handleDoubleClick = (file: FileInfo) => {
    // Double-click to load just that file
    const filePath = getFullPath(file);
    onSelectFiles([filePath]);
    onClose();
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  };

  const formatDate = (isoString: string): string => {
    try {
      return new Date(isoString).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  const getFileName = (key: string): string => {
    return key.split('/').pop() || key;
  };

  const displayedFiles = showMarkedOnly
    ? files.filter(f => markedFiles.has(f.key))
    : files;

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className={`relative rounded-lg shadow-xl w-[800px] max-h-[80vh] flex flex-col ${isDarkMode ? 'bg-gray-900' : 'bg-white'}`}>
        {/* Header */}
        <div className={`flex items-center justify-between px-4 py-3 border-b ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <h2 className={`text-lg font-semibold flex items-center gap-2 ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
            <span className="material-symbols-outlined">folder_open</span>
            File Browser
          </h2>
          <button
            onClick={onClose}
            className={`p-1 rounded transition-colors ${isDarkMode ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}
          >
            <span className={`material-symbols-outlined ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>close</span>
          </button>
        </div>

        {/* Directory input */}
        <div className={`p-4 border-b ${isDarkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          <label className={`block text-sm font-medium mb-2 ${isDarkMode ? 'text-gray-300' : 'text-gray-700'}`}>
            Enter S3 path or local directory:
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={directoryPath}
              onChange={(e) => setDirectoryPath(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="s3://bucket/prefix or /path/to/local/dir"
              className={`flex-1 px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm ${isDarkMode ? 'bg-gray-800 border-gray-600 text-gray-200 placeholder-gray-500' : 'border-gray-300'}`}
            />
            <button
              onClick={handleBrowse}
              disabled={loading || !directoryPath.trim()}
              className={`px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center gap-1 ${isDarkMode ? 'disabled:bg-gray-700' : 'disabled:bg-gray-300'} disabled:cursor-not-allowed`}
            >
              {loading ? (
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              ) : (
                <span className="material-symbols-outlined text-sm">search</span>
              )}
              Browse
            </button>
          </div>
          <p className={`mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            Examples: <code className={`px-1 rounded ${isDarkMode ? 'bg-gray-800' : 'bg-gray-100'}`}>s3://my-bucket/logs/</code> or <code className={`px-1 rounded ${isDarkMode ? 'bg-gray-800' : 'bg-gray-100'}`}>/home/user/data</code>
          </p>
        </div>

        {/* Filter bar */}
        <div className={`px-4 py-2 border-b flex items-center justify-between ${isDarkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                {files.length} file{files.length !== 1 ? 's' : ''} found
              </span>
              {markedFiles.size > 0 && (
                <span className={`text-sm ${isDarkMode ? 'text-amber-400' : 'text-amber-600'}`}>
                  ({markedFiles.size} marked)
                </span>
              )}
            </div>
            {selectedFiles.size > 0 && (
              <span className={`text-sm font-medium ${isDarkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                {selectedFiles.size} selected
              </span>
            )}
            {displayedFiles.length > 0 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={handleSelectAll}
                  className={`text-xs px-2 py-1 rounded ${isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
                >
                  Select all
                </button>
                <button
                  onClick={handleSelectNone}
                  className={`text-xs px-2 py-1 rounded ${isDarkMode ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
                >
                  Clear
                </button>
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showMarkedOnly}
              onChange={(e) => setShowMarkedOnly(e.target.checked)}
              className={`rounded text-blue-600 focus:ring-blue-500 ${isDarkMode ? 'bg-gray-700 border-gray-600' : 'border-gray-300'}`}
            />
            <span className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>Show marked only</span>
          </label>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-auto min-h-[300px]">
          {error && (
            <div className={`p-4 text-center ${isDarkMode ? 'text-red-400' : 'text-red-500'}`}>
              <span className="material-symbols-outlined">error</span>
              <p className="mt-1">{error}</p>
            </div>
          )}

          {!error && files.length === 0 && !loading && (
            <div className={`p-8 text-center ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>
              <span className="material-symbols-outlined text-4xl">folder_off</span>
              <p className="mt-2">
                {directoryPath
                  ? 'No JSONL files found in this directory'
                  : 'Enter a directory path and click Browse'}
              </p>
            </div>
          )}

          {displayedFiles.length > 0 && (
            <table className="w-full">
              <thead className={`sticky top-0 ${isDarkMode ? 'bg-gray-800' : 'bg-gray-50'}`}>
                <tr className={`text-left text-xs font-medium uppercase tracking-wider ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  <th className="px-4 py-2 w-10"></th>
                  <th className="px-2 py-2 w-10"></th>
                  <th className="px-4 py-2">File Name</th>
                  <th className="px-4 py-2 w-24 text-right">Size</th>
                  <th className="px-4 py-2 w-40">Last Modified</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-gray-700' : 'divide-gray-200'}`}>
                {displayedFiles.map((file) => {
                  const isMarked = markedFiles.has(file.key);
                  const filePath = getFullPath(file);
                  const isSelected = selectedFiles.has(filePath);
                  return (
                    <tr
                      key={file.key}
                      onClick={() => handleFileClick(file)}
                      onDoubleClick={() => handleDoubleClick(file)}
                      className={`cursor-pointer transition-colors ${
                        isSelected 
                          ? isDarkMode ? 'bg-blue-900/50' : 'bg-blue-100'
                          : isDarkMode ? 'hover:bg-blue-900/30' : 'hover:bg-blue-50'
                      }`}
                    >
                      <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleMark(file.key);
                          }}
                          className={`p-1 rounded transition-colors ${
                            isMarked
                              ? 'text-amber-500 hover:text-amber-600'
                              : isDarkMode ? 'text-gray-500 hover:text-amber-400' : 'text-gray-300 hover:text-amber-400'
                          }`}
                          title={isMarked ? 'Unmark file' : 'Mark file'}
                        >
                          <span className="material-symbols-outlined text-lg">
                            {isMarked ? 'star' : 'star_outline'}
                          </span>
                        </button>
                      </td>
                      <td className="px-2 py-2">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {}}
                          className={`rounded text-blue-600 focus:ring-blue-500 cursor-pointer ${isDarkMode ? 'bg-gray-700 border-gray-600' : 'border-gray-300'}`}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2">
                          <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                            description
                          </span>
                          <span className={`text-sm truncate max-w-[300px] ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`} title={file.key}>
                            {getFileName(file.key)}
                          </span>
                        </div>
                        {file.key !== getFileName(file.key) && (
                          <p className={`text-xs ml-7 truncate max-w-[300px] ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`} title={file.key}>
                            {file.key}
                          </p>
                        )}
                      </td>
                      <td className={`px-4 py-2 text-right text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                        {formatFileSize(file.size)}
                      </td>
                      <td className={`px-4 py-2 text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                        {formatDate(file.last_modified)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div className={`px-4 py-3 border-t flex items-center justify-between ${isDarkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}>
          <p className={`text-xs ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
            Click to select files, double-click to load single file
          </p>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className={`px-4 py-2 border rounded-md transition-colors ${isDarkMode ? 'text-gray-300 bg-gray-700 border-gray-600 hover:bg-gray-600' : 'text-gray-700 bg-white border-gray-300 hover:bg-gray-50'}`}
            >
              Cancel
            </button>
            <button
              onClick={handleLoadSelected}
              disabled={selectedFiles.size === 0}
              className={`px-4 py-2 rounded-md transition-colors flex items-center gap-2 ${
                selectedFiles.size > 0
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : isDarkMode ? 'bg-gray-700 text-gray-500 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
            >
              <span className="material-symbols-outlined text-sm">folder_open</span>
              Load {selectedFiles.size > 0 ? `${selectedFiles.size} File${selectedFiles.size > 1 ? 's' : ''}` : 'Selected'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
