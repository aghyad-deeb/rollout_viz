import { useState, useEffect, useCallback } from 'react';
import type { FileInfo } from '../../types';

interface FolderInfo {
  key: string;
  name: string;
  type: 'folder';
}

interface FileInfoExtended extends FileInfo {
  name?: string;
  type?: 'file';
}

interface ContentsResponse {
  folders: FolderInfo[];
  files: FileInfoExtended[];
}

interface FileBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectFiles: (filePaths: string[]) => void;
  markedFiles: Set<string>;
  onToggleMark: (filePath: string) => void;
  isDarkMode: boolean;
}

type SortColumn = 'name' | 'size' | 'last_modified';
type SortOrder = 'asc' | 'desc';

export function FileBrowser({
  isOpen,
  onClose,
  onSelectFiles,
  markedFiles,
  onToggleMark,
  isDarkMode,
}: FileBrowserProps) {
  const [directoryPath, setDirectoryPath] = useState('');
  const [currentPath, setCurrentPath] = useState(''); // The path we're currently viewing
  const [folders, setFolders] = useState<FolderInfo[]>([]);
  const [files, setFiles] = useState<FileInfoExtended[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showMarkedOnly, setShowMarkedOnly] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [browseMode, setBrowseMode] = useState<'navigate' | 'browse'>('navigate'); // navigate = show folders, browse = recursive files
  const [sortColumn, setSortColumn] = useState<SortColumn>('last_modified');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [searchTerm, setSearchTerm] = useState('');

  // Fetch contents (folders + files at current level)
  const fetchContents = useCallback(async (path: string) => {
    if (!path.trim()) {
      setFolders([]);
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
          `/api/contents/s3?bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}`
        );
      } else {
        // Local directory
        response = await fetch(
          `/api/contents/local?directory=${encodeURIComponent(path)}`
        );
      }

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to list contents');
      }

      const data: ContentsResponse = await response.json();
      setFolders(data.folders);
      setFiles(data.files);
      setCurrentPath(path);
      setBrowseMode('navigate');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch contents');
      setFolders([]);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch all files recursively (original browse behavior)
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
      setFolders([]);
      setFiles(data);
      setCurrentPath(path);
      setBrowseMode('browse');
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

  const handleNavigate = () => {
    fetchContents(directoryPath);
  };

  const handleBrowseAll = () => {
    fetchFiles(directoryPath);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNavigate();
    }
  };

  // Navigate into a folder
  const navigateToFolder = (folder: FolderInfo) => {
    let newPath: string;
    if (currentPath.startsWith('s3://')) {
      // For S3, reconstruct the full path
      const bucket = currentPath.slice(5).split('/')[0];
      newPath = `s3://${bucket}/${folder.key}`;
    } else {
      newPath = folder.key;
    }
    setDirectoryPath(newPath);
    fetchContents(newPath);
  };

  // Navigate to parent folder
  const navigateToParent = () => {
    if (!currentPath) return;
    
    let parentPath: string;
    if (currentPath.startsWith('s3://')) {
      // For S3
      const s3Path = currentPath.slice(5); // Remove 's3://'
      const bucket = s3Path.split('/')[0];
      const prefix = s3Path.slice(bucket.length + 1); // +1 for the /
      
      // Remove trailing slash and go up one level
      const trimmedPrefix = prefix.replace(/\/$/, '');
      const lastSlash = trimmedPrefix.lastIndexOf('/');
      
      if (lastSlash > 0) {
        parentPath = `s3://${bucket}/${trimmedPrefix.slice(0, lastSlash + 1)}`;
      } else {
        parentPath = `s3://${bucket}/`;
      }
    } else {
      // For local paths
      const parts = currentPath.replace(/\/$/, '').split('/');
      parts.pop();
      parentPath = parts.join('/') || '/';
    }
    
    setDirectoryPath(parentPath);
    fetchContents(parentPath);
  };

  const getFullPath = (file: FileInfoExtended): string => {
    if (browseMode === 'browse') {
      // In browse mode, files already have full paths for local, or need bucket prefix for S3
      return currentPath.startsWith('s3://')
        ? `s3://${currentPath.slice(5).split('/')[0]}/${file.key}`
        : file.key;
    } else {
      // In navigate mode, files already have full keys
      return currentPath.startsWith('s3://')
        ? `s3://${currentPath.slice(5).split('/')[0]}/${file.key}`
        : file.key;
    }
  };

  const handleFileClick = (file: FileInfoExtended) => {
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

  const handleDoubleClick = (file: FileInfoExtended) => {
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

  // Handle column header click for sorting
  const handleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      // Toggle order if same column
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      // New column, default to descending for dates, ascending for name
      setSortColumn(column);
      setSortOrder(column === 'last_modified' ? 'desc' : 'asc');
    }
  };

  // Filter and sort files
  const displayedFiles = (() => {
    let result = showMarkedOnly
      ? files.filter(f => markedFiles.has(f.key))
      : files;

    // Apply search filter
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      result = result.filter(f => {
        const fileName = (f.name || getFileName(f.key)).toLowerCase();
        const fullPath = f.key.toLowerCase();
        return fileName.includes(term) || fullPath.includes(term);
      });
    }

    // Apply sorting
    result = [...result].sort((a, b) => {
      let comparison = 0;
      
      switch (sortColumn) {
        case 'name':
          const nameA = (a.name || getFileName(a.key)).toLowerCase();
          const nameB = (b.name || getFileName(b.key)).toLowerCase();
          comparison = nameA.localeCompare(nameB);
          break;
        case 'size':
          comparison = a.size - b.size;
          break;
        case 'last_modified':
          comparison = new Date(a.last_modified).getTime() - new Date(b.last_modified).getTime();
          break;
      }
      
      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return result;
  })();

  // Also sort folders by name
  const displayedFolders = [...folders].sort((a, b) => {
    const comparison = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    return sortColumn === 'name' && sortOrder === 'desc' ? -comparison : comparison;
  });

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
              onClick={handleNavigate}
              disabled={loading || !directoryPath.trim()}
              className={`px-4 py-2 border rounded-md transition-colors flex items-center gap-1 ${
                isDarkMode 
                  ? 'border-gray-600 text-gray-300 hover:bg-gray-700 disabled:bg-gray-800 disabled:text-gray-600' 
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400'
              } disabled:cursor-not-allowed`}
              title="Navigate into folder to see subfolders"
            >
              {loading && browseMode === 'navigate' ? (
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              ) : (
                <span className="material-symbols-outlined text-sm">folder_open</span>
              )}
              Open
            </button>
            <button
              onClick={handleBrowseAll}
              disabled={loading || !directoryPath.trim()}
              className={`px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center gap-1 ${isDarkMode ? 'disabled:bg-gray-700' : 'disabled:bg-gray-300'} disabled:cursor-not-allowed`}
              title="Browse all JSONL files recursively"
            >
              {loading && browseMode === 'browse' ? (
                <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>
              ) : (
                <span className="material-symbols-outlined text-sm">search</span>
              )}
              Browse All
            </button>
          </div>
          <p className={`mt-1 text-xs ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            <strong>Open:</strong> Navigate into folder to see subfolders. <strong>Browse All:</strong> List all JSONL files recursively.
          </p>
        </div>

        {/* Current path breadcrumb */}
        {currentPath && (
          <div className={`px-4 py-2 border-b flex items-center gap-2 ${isDarkMode ? 'border-gray-700 bg-gray-800/50' : 'border-gray-200 bg-gray-50'}`}>
            <button
              onClick={navigateToParent}
              className={`p-1 rounded transition-colors ${isDarkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-200 text-gray-500'}`}
              title="Go to parent folder"
            >
              <span className="material-symbols-outlined text-sm">arrow_upward</span>
            </button>
            <span className={`text-sm font-mono truncate ${isDarkMode ? 'text-gray-300' : 'text-gray-600'}`}>
              {currentPath}
            </span>
            {browseMode === 'browse' && (
              <span className={`text-xs px-2 py-0.5 rounded ${isDarkMode ? 'bg-blue-900 text-blue-300' : 'bg-blue-100 text-blue-700'}`}>
                recursive
              </span>
            )}
          </div>
        )}

        {/* Filter bar */}
        <div className={`px-4 py-2 border-b flex flex-col gap-2 ${isDarkMode ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}>
          {/* Search input */}
          <div className="flex items-center gap-2">
            <div className={`flex-1 flex items-center gap-2 px-3 py-1.5 border rounded-md ${isDarkMode ? 'bg-gray-900 border-gray-600' : 'bg-white border-gray-300'}`}>
              <span className={`material-symbols-outlined text-sm ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>search</span>
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Search files..."
                className={`flex-1 bg-transparent focus:outline-none text-sm ${isDarkMode ? 'text-gray-200 placeholder-gray-500' : 'text-gray-800 placeholder-gray-400'}`}
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className={`p-0.5 rounded ${isDarkMode ? 'hover:bg-gray-700 text-gray-500' : 'hover:bg-gray-100 text-gray-400'}`}
                >
                  <span className="material-symbols-outlined text-sm">close</span>
                </button>
              )}
            </div>
          </div>

          {/* Stats and controls */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                {folders.length > 0 && (
                  <span className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                    {displayedFolders.length} folder{displayedFolders.length !== 1 ? 's' : ''}
                  </span>
                )}
                <span className={`text-sm ${isDarkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  {displayedFiles.length}{searchTerm ? ` of ${files.length}` : ''} file{displayedFiles.length !== 1 ? 's' : ''}
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
        </div>

        {/* File list */}
        <div className="flex-1 overflow-auto min-h-[300px]">
          {error && (
            <div className={`p-4 text-center ${isDarkMode ? 'text-red-400' : 'text-red-500'}`}>
              <span className="material-symbols-outlined">error</span>
              <p className="mt-1">{error}</p>
            </div>
          )}

          {!error && displayedFolders.length === 0 && displayedFiles.length === 0 && !loading && (
            <div className={`p-8 text-center ${isDarkMode ? 'text-gray-500' : 'text-gray-500'}`}>
              <span className="material-symbols-outlined text-4xl">folder_off</span>
              <p className="mt-2">
                {searchTerm
                  ? 'No files match your search'
                  : currentPath
                    ? 'No folders or JSONL files found in this directory'
                    : 'Enter a directory path and click Open or Browse All'}
              </p>
            </div>
          )}

          {(displayedFolders.length > 0 || displayedFiles.length > 0) && (
            <table className="w-full">
              <thead className={`sticky top-0 ${isDarkMode ? 'bg-gray-800' : 'bg-gray-50'}`}>
                <tr className={`text-left text-xs font-medium uppercase tracking-wider ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  <th className="px-4 py-2 w-10"></th>
                  <th className="px-2 py-2 w-10"></th>
                  <th 
                    className={`px-4 py-2 cursor-pointer select-none hover:${isDarkMode ? 'text-gray-200' : 'text-gray-700'} transition-colors`}
                    onClick={() => handleSort('name')}
                  >
                    <div className="flex items-center gap-1">
                      Name
                      {sortColumn === 'name' && (
                        <span className="material-symbols-outlined text-xs">
                          {sortOrder === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                        </span>
                      )}
                    </div>
                  </th>
                  <th 
                    className={`px-4 py-2 w-24 text-right cursor-pointer select-none hover:${isDarkMode ? 'text-gray-200' : 'text-gray-700'} transition-colors`}
                    onClick={() => handleSort('size')}
                  >
                    <div className="flex items-center justify-end gap-1">
                      Size
                      {sortColumn === 'size' && (
                        <span className="material-symbols-outlined text-xs">
                          {sortOrder === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                        </span>
                      )}
                    </div>
                  </th>
                  <th 
                    className={`px-4 py-2 w-40 cursor-pointer select-none hover:${isDarkMode ? 'text-gray-200' : 'text-gray-700'} transition-colors`}
                    onClick={() => handleSort('last_modified')}
                  >
                    <div className="flex items-center gap-1">
                      Last Modified
                      {sortColumn === 'last_modified' && (
                        <span className="material-symbols-outlined text-xs">
                          {sortOrder === 'asc' ? 'arrow_upward' : 'arrow_downward'}
                        </span>
                      )}
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody className={`divide-y ${isDarkMode ? 'divide-gray-700' : 'divide-gray-200'}`}>
                {/* Folders first */}
                {displayedFolders.map((folder) => (
                  <tr
                    key={folder.key}
                    onClick={() => navigateToFolder(folder)}
                    className={`cursor-pointer transition-colors ${isDarkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                  >
                    <td className="px-4 py-2">
                      {/* No star for folders */}
                    </td>
                    <td className="px-2 py-2">
                      {/* No checkbox for folders */}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <span className={`material-symbols-outlined text-lg ${isDarkMode ? 'text-amber-500' : 'text-amber-600'}`}>
                          folder
                        </span>
                        <span className={`text-sm ${isDarkMode ? 'text-gray-200' : 'text-gray-800'}`}>
                          {folder.name}
                        </span>
                      </div>
                    </td>
                    <td className={`px-4 py-2 text-right text-sm ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                      —
                    </td>
                    <td className={`px-4 py-2 text-sm ${isDarkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                      —
                    </td>
                  </tr>
                ))}
                {/* Files */}
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
                            {file.name || getFileName(file.key)}
                          </span>
                        </div>
                        {browseMode === 'browse' && file.key !== getFileName(file.key) && (
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
