import React from 'react';
import { FolderOpen, ChevronDown, Plus, Pencil, Trash2, Check, X } from 'lucide-react';
import type { Workspace } from '../lib/protocol';

interface WorkspaceSelectorProps {
  workspaces: Workspace[];
  activeWorkspace: string | null;
  onSelect: (workspaceId: string) => void;
  onCreateNew: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

const WorkspaceSelector = ({
  workspaces,
  activeWorkspace,
  onSelect,
  onCreateNew,
  onRename,
  onDelete,
}: WorkspaceSelectorProps) => {
  const [open, setOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState('');
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setEditingId(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const active = workspaces.find((w) => w.id === activeWorkspace);

  // 최근 접속 순 정렬
  const sorted = [...workspaces].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);

  const handleStartEdit = (e: React.MouseEvent, ws: Workspace) => {
    e.stopPropagation();
    setEditingId(ws.id);
    setEditName(ws.name);
  };

  const handleSaveEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (editingId && editName.trim()) {
      onRename(editingId, editName.trim());
    }
    setEditingId(null);
  };

  const handleCancelEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(null);
  };

  const handleDelete = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    onDelete(id);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-(--bg-secondary) border border-(--border) hover:bg-(--bg-tertiary) transition-colors w-full"
      >
        <FolderOpen size={16} className="text-(--accent) shrink-0" />
        <div className="flex-1 text-left min-w-0">
          <span className="text-sm font-medium truncate block">
            {active ? active.name : 'Select Workspace'}
          </span>
          {active && (
            <span className="text-xs text-(--text-muted) truncate block">
              {active.path}
            </span>
          )}
        </div>
        <ChevronDown
          size={14}
          className={`text-(--text-muted) transition-transform shrink-0 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-(--bg-secondary) border border-(--border) rounded-lg shadow-xl z-50 overflow-hidden animate-fade-in">
          {sorted.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-(--text-muted)">
              No workspaces yet
            </div>
          )}
          {sorted.map((ws) => (
            <div
              key={ws.id}
              className={`flex items-center gap-2 w-full px-3 py-2.5 hover:bg-(--bg-tertiary) transition-colors cursor-pointer ${
                ws.id === activeWorkspace ? 'bg-(--bg-tertiary)' : ''
              }`}
              onClick={() => {
                if (editingId !== ws.id) {
                  onSelect(ws.id);
                  setOpen(false);
                }
              }}
            >
              <FolderOpen size={14} className="text-(--text-muted) shrink-0" />
              <div className="flex-1 min-w-0">
                {editingId === ws.id ? (
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveEdit(e as unknown as React.MouseEvent);
                        if (e.key === 'Escape') handleCancelEdit(e as unknown as React.MouseEvent);
                      }}
                      className="text-sm bg-(--bg-primary) border border-(--border) rounded px-1.5 py-0.5 w-full outline-none focus:border-(--accent)"
                      autoFocus
                    />
                    <button onClick={handleSaveEdit} className="p-0.5 hover:text-(--success)">
                      <Check size={12} />
                    </button>
                    <button onClick={handleCancelEdit} className="p-0.5 hover:text-(--error)">
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="text-sm font-medium truncate">{ws.name}</div>
                    <div className="text-xs text-(--text-muted) truncate">{ws.path}</div>
                  </>
                )}
              </div>
              {editingId !== ws.id && (
                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100" style={{ opacity: ws.id === activeWorkspace ? 1 : undefined }}>
                  <button
                    onClick={(e) => handleStartEdit(e, ws)}
                    className="p-1 rounded hover:bg-(--bg-primary) text-(--text-muted) hover:text-(--text-primary)"
                    title="Rename"
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    onClick={(e) => handleDelete(e, ws.id)}
                    className="p-1 rounded hover:bg-(--bg-primary) text-(--text-muted) hover:text-(--error)"
                    title="Delete"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* 새 워크스페이스 */}
          <div className="border-t border-(--border)">
            <button
              onClick={() => {
                setOpen(false);
                onCreateNew();
              }}
              className="flex items-center gap-2 w-full px-3 py-2.5 text-left hover:bg-(--bg-tertiary) transition-colors text-(--accent)"
            >
              <Plus size={14} />
              <span className="text-sm font-medium">New Workspace</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkspaceSelector;
