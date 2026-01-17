import { useState } from 'react';

interface MetadataHeaderProps {
  experimentName: string;
  filePaths: string[];
  onFilePathsChange: (paths: string[]) => void;
  totalSamples: number;
  filteredCount: number;
  isDarkMode: boolean;
}

export function MetadataHeader({
  experimentName,
  filePaths,
  onFilePathsChange,
  totalSamples,
  filteredCount,
  isDarkMode,
}: MetadataHeaderProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editPath, setEditPath] = useState(filePaths[0] || '');
  const [showAllFiles, setShowAllFiles] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onFilePathsChange([editPath]);
    setIsEditing(false);
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(filePaths.join('\n'));
  };

  const getFileName = (path: string): string => {
    return path.split('/').pop() || path;
  };

  const displayPath = filePaths.length === 1 
    ? filePaths[0]
    : `${filePaths.length} files loaded`;

  return (
    <div className={`p-3 border-b space-y-2 ${isDarkMode ? 'border-gray-700' : ''}`}>
      <div className="flex flex-col gap-1">
        <div className="flex justify-between items-start gap-2">
          <div className="flex items-start gap-2">
            <div className="flex flex-col gap-1">
              <div className="text-base font-semibold">{experimentName || 'No experiment loaded'}</div>
              {isEditing ? (
                <form onSubmit={handleSubmit} className="flex gap-1">
                  <input
                    type="text"
                    value={editPath}
                    onChange={(e) => setEditPath(e.target.value)}
                    className={`text-sm px-2 py-0.5 border rounded focus:outline-none focus:ring focus:ring-blue-500 ${isDarkMode ? 'bg-gray-800 border-gray-600 text-gray-200' : 'border-gray-300'}`}
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
                  <div 
                    className={`text-sm cursor-pointer ${isDarkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-600 hover:text-gray-800'}`}
                    onClick={() => {
                      if (filePaths.length === 1) {
                        setEditPath(filePaths[0]);
                        setIsEditing(true);
                      } else {
                        setShowAllFiles(!showAllFiles);
                      }
                    }}
                    title={filePaths.length === 1 ? "Click to edit file path" : "Click to show/hide files"}
                  >
                    {displayPath}
                  </div>
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
          <div className={`flex-1 text-right text-xs truncate flex flex-col gap-1 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            <div>{new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
            <div className="flex justify-end gap-2">
              <button
                onClick={copyToClipboard}
                className={`text-xs flex items-center gap-1 cursor-pointer border-b ${isDarkMode ? 'text-gray-400 hover:text-gray-200 border-gray-600 hover:border-gray-400' : 'text-gray-500 hover:text-gray-700 border-gray-300 hover:border-gray-500'}`}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>content_copy</span>
                Log path{filePaths.length > 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
        
        <div className="flex justify-between items-center gap-2">
          <div className={`text-xs break-all line-clamp-4 ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}></div>
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
