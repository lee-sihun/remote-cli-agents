import React, { useCallback, useEffect, useState } from 'react';
import {
  GitBranch,
  GitCommit,
  Upload,
  Download,
  Archive,
  ArchiveRestore,
  RefreshCw,
  X,
  FileText,
  FilePlus,
  FileX,
  FilePen,
  Loader2,
} from 'lucide-react';
import type { ClientMessage } from '../lib/protocol';

interface GitPanelProps {
  open: boolean;
  onClose: () => void;
  onSend: (msg: ClientMessage) => void;
  gitResults: Map<string, unknown>;
}

interface GitStatus {
  branch?: string;
  ahead?: number;
  behind?: number;
  files?: Array<{
    path: string;
    status: string;
    staged: boolean;
  }>;
}

function fileStatusIcon(status: string) {
  switch (status) {
    case 'added':
      return <FilePlus size={14} className="text-[var(--success)]" />;
    case 'deleted':
      return <FileX size={14} className="text-[var(--error)]" />;
    case 'modified':
      return <FilePen size={14} className="text-[var(--warning)]" />;
    default:
      return <FileText size={14} className="text-[var(--text-muted)]" />;
  }
}

export default function GitPanel({
  open,
  onClose,
  onSend,
  gitResults,
}: GitPanelProps) {
  const [commitMessage, setCommitMessage] = useState('');
  const [loading, setLoading] = useState<string | null>(null);

  const gitStatus = gitResults.get('status') as GitStatus | undefined;

  const requestStatus = useCallback(() => {
    onSend({ type: 'git', action: 'status' });
  }, [onSend]);

  useEffect(() => {
    if (open) {
      requestStatus();
    }
  }, [open, requestStatus]);

  // Clear loading when result arrives
  useEffect(() => {
    setLoading(null);
  }, [gitResults]);

  const handleAction = useCallback(
    (action: string, params?: Record<string, unknown>) => {
      setLoading(action);
      onSend({ type: 'git', action, params });
    },
    [onSend],
  );

  const handleCommit = useCallback(() => {
    if (!commitMessage.trim()) return;
    handleAction('commit', { message: commitMessage.trim() });
    setCommitMessage('');
  }, [commitMessage, handleAction]);

  if (!open) return null;

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/40 z-40 md:hidden"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-sm bg-[var(--bg-primary)] border-l border-[var(--border)] z-50 flex flex-col animate-slide-left shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <GitBranch size={18} className="text-[var(--accent)]" />
            <h2 className="font-semibold text-sm">Git</h2>
            {gitStatus?.branch && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                {gitStatus.branch}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={requestStatus}
              className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
              title="Refresh"
            >
              <RefreshCw
                size={14}
                className={`text-[var(--text-muted)] ${loading === 'status' ? 'animate-spin' : ''}`}
              />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              <X size={14} className="text-[var(--text-muted)]" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Branch info */}
          {gitStatus && (
            <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
              {gitStatus.ahead !== undefined && gitStatus.ahead > 0 && (
                <span className="text-[var(--success)]">
                  +{gitStatus.ahead} ahead
                </span>
              )}
              {gitStatus.behind !== undefined && gitStatus.behind > 0 && (
                <span className="text-[var(--warning)]">
                  -{gitStatus.behind} behind
                </span>
              )}
            </div>
          )}

          {/* Changed files */}
          <div>
            <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
              Changed Files
            </h3>
            {gitStatus?.files && gitStatus.files.length > 0 ? (
              <div className="space-y-0.5">
                {gitStatus.files.map((file) => (
                  <div
                    key={file.path}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] transition-colors"
                  >
                    {fileStatusIcon(file.status)}
                    <span className="text-xs font-mono truncate flex-1">
                      {file.path}
                    </span>
                    {file.staged && (
                      <span className="text-xs text-[var(--success)]">
                        staged
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">
                No changes detected
              </p>
            )}
          </div>

          {/* Commit form */}
          <div>
            <h3 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
              Commit
            </h3>
            <textarea
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder="Commit message..."
              rows={3}
              className="w-full px-3 py-2 rounded-lg bg-[var(--input-bg)] border border-[var(--input-border)] text-sm placeholder-[var(--text-muted)] focus:border-[var(--accent)] focus:outline-none resize-none mb-2"
            />
            <button
              onClick={handleCommit}
              disabled={!commitMessage.trim() || loading === 'commit'}
              className="flex items-center justify-center gap-2 w-full py-2 rounded-lg bg-[var(--accent)] text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {loading === 'commit' ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <GitCommit size={14} />
              )}
              Commit
            </button>
          </div>
        </div>

        {/* Action buttons */}
        <div className="p-4 border-t border-[var(--border)] grid grid-cols-2 gap-2">
          <button
            onClick={() => handleAction('pull')}
            disabled={loading === 'pull'}
            className="flex items-center justify-center gap-2 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-sm hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-40"
          >
            {loading === 'pull' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Pull
          </button>
          <button
            onClick={() => handleAction('push')}
            disabled={loading === 'push'}
            className="flex items-center justify-center gap-2 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-sm hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-40"
          >
            {loading === 'push' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Upload size={14} />
            )}
            Push
          </button>
          <button
            onClick={() => handleAction('stash')}
            disabled={loading === 'stash'}
            className="flex items-center justify-center gap-2 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-sm hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-40"
          >
            {loading === 'stash' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Archive size={14} />
            )}
            Stash
          </button>
          <button
            onClick={() => handleAction('stash_pop')}
            disabled={loading === 'stash_pop'}
            className="flex items-center justify-center gap-2 py-2 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-sm hover:bg-[var(--bg-tertiary)] transition-colors disabled:opacity-40"
          >
            {loading === 'stash_pop' ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <ArchiveRestore size={14} />
            )}
            Unstash
          </button>
        </div>
      </div>
    </>
  );
}
