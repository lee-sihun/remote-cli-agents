import React, { useCallback, useEffect, useState } from 'react';
import {
  Folder,
  FolderOpen,
  FileText,
  FileCode,
  FileJson,
  FileImage,
  File,
  ChevronRight,
  ChevronDown,
  X,
  RefreshCw,
  ArrowLeft,
} from 'lucide-react';
import type { ClientMessage, FileEntry } from '../lib/protocol';

interface FileExplorerProps {
  open: boolean;
  onClose: () => void;
  onSend: (msg: ClientMessage) => void;
  fileEntries: Map<string, FileEntry[]>;
  fileContent: Map<string, string>;
}

function fileIcon(name: string, type: 'file' | 'directory') {
  if (type === 'directory') return null; // Handled inline
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'py':
    case 'go':
    case 'rs':
    case 'java':
    case 'c':
    case 'cpp':
    case 'rb':
    case 'php':
    case 'sh':
    case 'bash':
    case 'css':
    case 'scss':
    case 'html':
      return <FileCode size={14} className="text-(--accent)" />;
    case 'json':
    case 'yaml':
    case 'yml':
    case 'toml':
      return <FileJson size={14} className="text-(--warning)" />;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return <FileImage size={14} className="text-purple-400" />;
    case 'md':
    case 'txt':
    case 'log':
      return <FileText size={14} className="text-(--text-muted)" />;
    default:
      return <File size={14} className="text-(--text-muted)" />;
  }
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface TreeNodeProps {
  entry: FileEntry;
  path: string;
  onNavigate: (path: string) => void;
  onReadFile: (path: string) => void;
  fileEntries: Map<string, FileEntry[]>;
  onSend: (msg: ClientMessage) => void;
  depth: number;
}

function TreeNode({
  entry,
  path,
  onNavigate,
  onReadFile,
  fileEntries,
  onSend,
  depth,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const fullPath = path ? `${path}/${entry.name}` : entry.name;

  const handleClick = useCallback(() => {
    if (entry.type === 'directory') {
      if (!expanded && !fileEntries.has(fullPath)) {
        onSend({ type: 'file_list', path: fullPath });
      }
      setExpanded(!expanded);
    } else {
      onReadFile(fullPath);
    }
  }, [entry, expanded, fullPath, fileEntries, onSend, onReadFile]);

  const children = fileEntries.get(fullPath) || [];

  return (
    <div>
      <button
        onClick={handleClick}
        className="flex items-center gap-1.5 w-full px-2 py-1 text-left hover:bg-(--bg-tertiary) rounded transition-colors"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {entry.type === 'directory' ? (
          <>
            {expanded ? (
              <ChevronDown size={12} className="text-(--text-muted) shrink-0" />
            ) : (
              <ChevronRight size={12} className="text-(--text-muted) shrink-0" />
            )}
            {expanded ? (
              <FolderOpen size={14} className="text-(--warning) shrink-0" />
            ) : (
              <Folder size={14} className="text-(--warning) shrink-0" />
            )}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            {fileIcon(entry.name, entry.type)}
          </>
        )}
        <span className="text-xs font-mono truncate flex-1">
          {entry.name}
        </span>
        {entry.type === 'file' && entry.size !== undefined && (
          <span className="text-xs text-(--text-muted) shrink-0">
            {formatSize(entry.size)}
          </span>
        )}
      </button>

      {expanded && entry.type === 'directory' && (
        <div>
          {children
            .sort((a, b) => {
              // Directories first
              if (a.type !== b.type)
                return a.type === 'directory' ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => (
              <TreeNode
                key={child.name}
                entry={child}
                path={fullPath}
                onNavigate={onNavigate}
                onReadFile={onReadFile}
                fileEntries={fileEntries}
                onSend={onSend}
                depth={depth + 1}
              />
            ))}
          {children.length === 0 && (
            <div
              className="text-xs text-(--text-muted) py-1"
              style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
            >
              Empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function FileExplorer({
  open,
  onClose,
  onSend,
  fileEntries,
  fileContent,
}: FileExplorerProps) {
  const [viewingFile, setViewingFile] = useState<string | null>(null);

  // Request root listing on open
  useEffect(() => {
    if (open && !fileEntries.has('.')) {
      onSend({ type: 'file_list', path: '.' });
    }
  }, [open, fileEntries, onSend]);

  const handleReadFile = useCallback(
    (path: string) => {
      setViewingFile(path);
      if (!fileContent.has(path)) {
        onSend({ type: 'file_read', path });
      }
    },
    [fileContent, onSend],
  );

  const handleRefresh = useCallback(() => {
    onSend({ type: 'file_list', path: '.' });
  }, [onSend]);

  if (!open) return null;

  const rootEntries = fileEntries.get('.') || [];

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/40 z-40 md:hidden"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-(--bg-primary) border-l border-(--border) z-50 flex flex-col animate-slide-left shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-(--border)">
          <div className="flex items-center gap-2">
            {viewingFile ? (
              <button
                onClick={() => setViewingFile(null)}
                className="p-1 rounded hover:bg-(--bg-tertiary) transition-colors"
              >
                <ArrowLeft size={16} className="text-(--text-muted)" />
              </button>
            ) : (
              <Folder size={18} className="text-(--accent)" />
            )}
            <h2 className="font-semibold text-sm truncate">
              {viewingFile ? viewingFile.split('/').pop() : 'Files'}
            </h2>
          </div>
          <div className="flex items-center gap-1">
            {!viewingFile && (
              <button
                onClick={handleRefresh}
                className="p-1.5 rounded-lg hover:bg-(--bg-tertiary) transition-colors"
                title="Refresh"
              >
                <RefreshCw size={14} className="text-(--text-muted)" />
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-(--bg-tertiary) transition-colors"
            >
              <X size={14} className="text-(--text-muted)" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {viewingFile ? (
            <div className="p-4">
              <div className="text-xs font-mono text-(--text-muted) mb-2 break-all">
                {viewingFile}
              </div>
              <pre className="text-xs font-mono bg-(--bg-secondary) rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                {fileContent.get(viewingFile) ?? 'Loading...'}
              </pre>
            </div>
          ) : (
            <div className="py-1">
              {rootEntries
                .sort((a, b) => {
                  if (a.type !== b.type)
                    return a.type === 'directory' ? -1 : 1;
                  return a.name.localeCompare(b.name);
                })
                .map((entry) => (
                  <TreeNode
                    key={entry.name}
                    entry={entry}
                    path=""
                    onNavigate={() => {}}
                    onReadFile={handleReadFile}
                    fileEntries={fileEntries}
                    onSend={onSend}
                    depth={0}
                  />
                ))}
              {rootEntries.length === 0 && (
                <div className="p-4 text-center text-sm text-(--text-muted)">
                  No files found
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
