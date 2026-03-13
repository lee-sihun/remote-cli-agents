import React, { useCallback, useEffect, useState } from 'react';
import { FolderOpen, ChevronRight, ChevronDown, X, ArrowUp } from 'lucide-react';
import type { ClientMessage, DirEntry, ServerMessage } from '../lib/protocol';

interface FolderBrowserProps {
  open: boolean;
  onClose: () => void;
  onSelect: (name: string, path: string) => void;
  onSend: (msg: ClientMessage) => void;
  directoryEntries: Map<string, DirEntry[]>;
}

const FolderBrowser = ({
  open,
  onClose,
  onSelect,
  onSend,
  directoryEntries,
}: FolderBrowserProps) => {
  const [currentPath, setCurrentPath] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  // 루트 디렉토리 결정 (OS별)
  const getRootPath = useCallback(() => {
    // 서버에서 browse_directory 결과의 path 필드를 사용
    if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')) {
      return 'C:\\';
    }
    return '/';
  }, []);

  // 초기 로드
  useEffect(() => {
    if (open && !currentPath) {
      const root = getRootPath();
      setCurrentPath(root);
      onSend({ type: 'browse_directory', path: root });
    }
  }, [open, currentPath, getRootPath, onSend]);

  const handleNavigate = useCallback((path: string) => {
    setCurrentPath(path);
    onSend({ type: 'browse_directory', path });
  }, [onSend]);

  const handleToggleExpand = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        // 하위 디렉토리 로드
        onSend({ type: 'browse_directory', path });
      }
      return next;
    });
  }, [onSend]);

  const handleSelectFolder = useCallback((path: string) => {
    setSelectedPath(path);
    // 폴더명 자동 채움
    const folderName = path.split(/[/\\]/).filter(Boolean).pop() || '';
    setWorkspaceName(folderName);
  }, []);

  const handleGoUp = useCallback(() => {
    if (!currentPath) return;
    // 상위 디렉토리
    const sep = currentPath.includes('\\') ? '\\' : '/';
    const parts = currentPath.split(sep).filter(Boolean);
    if (parts.length <= 1) {
      // 루트
      const root = currentPath.includes('\\') ? `${parts[0]}\\` : '/';
      handleNavigate(root);
      return;
    }
    parts.pop();
    const parent = currentPath.includes('\\')
      ? parts.join('\\') + '\\'
      : '/' + parts.join('/');
    handleNavigate(parent);
  }, [currentPath, handleNavigate]);

  const handleCreate = useCallback(() => {
    if (!selectedPath || !workspaceName.trim()) return;
    onSelect(workspaceName.trim(), selectedPath);
    // 초기화
    setSelectedPath('');
    setWorkspaceName('');
    setCurrentPath('');
    setExpandedPaths(new Set());
  }, [selectedPath, workspaceName, onSelect]);

  if (!open) return null;

  const entries = directoryEntries.get(currentPath) || [];

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-(--bg-secondary) border border-(--border) rounded-xl shadow-2xl w-full max-w-lg flex flex-col" style={{ maxHeight: '80vh' }}>
        {/* 헤더 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-(--border)">
          <h2 className="text-sm font-semibold">New Workspace</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-(--bg-tertiary) text-(--text-muted)"
          >
            <X size={16} />
          </button>
        </div>

        {/* 이름 입력 */}
        <div className="px-4 pt-3">
          <label className="block text-xs text-(--text-muted) mb-1">Name</label>
          <input
            type="text"
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            placeholder="my-project"
            className="w-full px-3 py-2 text-sm bg-(--bg-primary) border border-(--border) rounded-lg outline-none focus:border-(--accent) transition-colors"
          />
        </div>

        {/* 경로 표시 + 상위 이동 */}
        <div className="px-4 pt-3">
          <label className="block text-xs text-(--text-muted) mb-1">Folder</label>
          <div className="flex items-center gap-1">
            <button
              onClick={handleGoUp}
              className="p-1.5 rounded hover:bg-(--bg-tertiary) text-(--text-muted) shrink-0"
              title="Go up"
            >
              <ArrowUp size={14} />
            </button>
            <div className="flex-1 px-2 py-1.5 text-xs bg-(--bg-primary) border border-(--border) rounded truncate text-(--text-secondary)">
              {currentPath || '/'}
            </div>
          </div>
        </div>

        {/* 폴더 목록 */}
        <div className="flex-1 overflow-y-auto px-4 py-2 min-h-0" style={{ maxHeight: '40vh' }}>
          {entries.length === 0 ? (
            <div className="py-6 text-center text-xs text-(--text-muted)">
              Empty or loading...
            </div>
          ) : (
            <div className="space-y-0.5">
              {entries.map((entry) => (
                <button
                  key={entry.path}
                  onClick={() => handleSelectFolder(entry.path)}
                  onDoubleClick={() => handleNavigate(entry.path)}
                  className={`flex items-center gap-2 w-full px-2 py-1.5 rounded text-left transition-colors ${
                    entry.path === selectedPath
                      ? 'bg-(--accent)/15 text-(--accent)'
                      : 'hover:bg-(--bg-tertiary) text-(--text-primary)'
                  }`}
                >
                  <FolderOpen size={14} className="shrink-0 text-(--text-muted)" />
                  <span className="text-sm truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 선택된 경로 */}
        {selectedPath && (
          <div className="px-4 py-2 text-xs text-(--text-muted) border-t border-(--border)">
            Selected: <span className="text-(--text-secondary)">{selectedPath}</span>
          </div>
        )}

        {/* 하단 버튼 */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-(--border)">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg hover:bg-(--bg-tertiary) transition-colors text-(--text-muted)"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!selectedPath || !workspaceName.trim()}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-(--accent) text-white hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
};

export default FolderBrowser;
