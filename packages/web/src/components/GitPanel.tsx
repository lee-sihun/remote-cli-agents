import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  GitBranch,
  GitCommit,
  GitGraph,
  Upload,
  Download,
  RefreshCw,
  X,
  FilePlus,
  FileX,
  FilePen,
  FileText,
  Minus,
  Plus,
  ChevronDown,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import type { ClientMessage } from '../lib/protocol';
import GitDiffViewer from './GitDiffViewer';
import GitBranchPicker from './GitBranchPicker';

interface GitPanelProps {
  open: boolean;
  onClose: () => void;
  onSend: (msg: ClientMessage) => void;
  gitResults: Map<string, unknown>;
}

interface GitFile {
  path: string;
  status: string;
}

interface GitStatus {
  branch?: string;
  ahead?: number;
  behind?: number;
  stagedFiles?: GitFile[];
  unstagedFiles?: GitFile[];
  clean?: boolean;
  _error?: string;
}

interface Branch {
  name: string;
  current: boolean;
  remote: boolean;
}

interface DiffResult {
  diff?: string;
  file?: string;
  staged?: boolean;
  _error?: string;
}

interface BranchesResult {
  branches?: Branch[];
  _error?: string;
}

interface LogCommit {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  timestamp: number;
  subject: string;
}

interface LogResult {
  commits?: LogCommit[];
  hasMore?: boolean;
  nextSkip?: number;
  _error?: string;
}

interface SelectedFile {
  path: string;
  staged: boolean;
}

interface CommitFile {
  path: string;
  nextPath?: string;
  status: string;
}

interface CommitFilesResult {
  commit?: LogCommit;
  files?: CommitFile[];
  _error?: string;
}

interface CommitDiffResult {
  hash?: string;
  file?: string;
  diff?: string;
  _error?: string;
}

interface SelectedCommitDiff {
  hash: string;
  file: string;
}

type GitTab = 'changes' | 'history';

const HISTORY_PAGE_SIZE = 30;
const REFRESH_AFTER = new Set(['commit', 'stage', 'unstage', 'checkout', 'pull', 'push']);

function fileStatusIcon(status: string) {
  switch (status) {
    case 'added':
      return <FilePlus size={13} className="text-(--success) shrink-0" />;
    case 'deleted':
      return <FileX size={13} className="text-(--error) shrink-0" />;
    case 'modified':
      return <FilePen size={13} className="text-(--warning) shrink-0" />;
    case 'untracked':
      return <FilePlus size={13} className="text-(--text-muted) shrink-0" />;
    default:
      return <FileText size={13} className="text-(--text-muted) shrink-0" />;
  }
}

function statusBadge(status: string) {
  const map: Record<string, { label: string; cls: string }> = {
    added: { label: 'A', cls: 'text-(--success) bg-(--success)/10' },
    deleted: { label: 'D', cls: 'text-(--error) bg-(--error)/10' },
    modified: { label: 'M', cls: 'text-(--warning) bg-(--warning)/10' },
    renamed: { label: 'R', cls: 'text-sky-500 bg-sky-500/10' },
    untracked: { label: 'U', cls: 'text-(--text-muted) bg-(--bg-tertiary)' },
  };
  const { label, cls } = map[status] ?? { label: '?', cls: 'text-(--text-muted)' };

  return (
    <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${cls}`}>
      {label}
    </span>
  );
}

function formatCommitDate(timestamp: number) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp);
}

export default function GitPanel({ open, onClose, onSend, gitResults }: GitPanelProps) {
  const [commitMessage, setCommitMessage] = useState('');
  const [loading, setLoading] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<LogCommit | null>(null);
  const [selectedCommitDiff, setSelectedCommitDiff] = useState<SelectedCommitDiff | null>(null);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [activeTab, setActiveTab] = useState<GitTab>('changes');
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);
  const [historyItems, setHistoryItems] = useState<LogCommit[]>([]);
  const [historySkip, setHistorySkip] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);

  const pendingRefreshRef = useRef<{ action: string; prev: unknown } | null>(null);
  const historyLoadMoreRef = useRef(false);

  const gitStatus = gitResults.get('status') as GitStatus | undefined;
  const diffResult = gitResults.get('diff') as DiffResult | undefined;
  const branchesResult = gitResults.get('branches') as BranchesResult | undefined;
  const logResult = gitResults.get('log') as LogResult | undefined;
  const commitFilesResult = gitResults.get('commit_files') as CommitFilesResult | undefined;
  const commitDiffResult = gitResults.get('commit_diff') as CommitDiffResult | undefined;

  const isDiffMatch =
    diffResult &&
    !diffResult._error &&
    diffResult.file === selectedFile?.path &&
    diffResult.staged === selectedFile?.staged;

  const isCommitDiffMatch =
    commitDiffResult &&
    !commitDiffResult._error &&
    commitDiffResult.hash === selectedCommitDiff?.hash &&
    commitDiffResult.file === selectedCommitDiff?.file;

  const requestStatus = useCallback(() => {
    setLoading('status');
    onSend({ type: 'git', action: 'status' });
  }, [onSend]);

  const requestBranches = useCallback(() => {
    setLoading('branches');
    onSend({ type: 'git', action: 'branches' });
  }, [onSend]);

  const requestLog = useCallback((skip = 0) => {
    setLoading('log');
    onSend({ type: 'git', action: 'log', params: { count: HISTORY_PAGE_SIZE, skip } });
  }, [onSend]);

  const requestCommitFiles = useCallback((hash: string) => {
    setLoading('commit_files');
    onSend({ type: 'git', action: 'commit_files', params: { hash } });
  }, [onSend]);

  const requestCommitDiff = useCallback((hash: string, file: string) => {
    setLoading('commit_diff');
    onSend({ type: 'git', action: 'commit_diff', params: { hash, file } });
  }, [onSend]);

  useEffect(() => {
    if (open) {
      requestStatus();
      if (activeTab === 'history') {
        historyLoadMoreRef.current = false;
        requestLog(0);
      }
    }
  }, [activeTab, open, requestLog, requestStatus]);

  useEffect(() => {
    if (!open) {
      setSelectedFile(null);
      setSelectedCommit(null);
      setSelectedCommitDiff(null);
      setActiveTab('changes');
      setHistoryItems([]);
      setHistorySkip(0);
      setHistoryHasMore(false);
    }
  }, [open]);

  useEffect(() => {
    if (showBranchPicker) {
      requestBranches();
    }
  }, [showBranchPicker, requestBranches]);

  useEffect(() => {
    if (!logResult) return;
    const commits = logResult.commits ?? [];

    setHistoryItems((prev) => {
      if (!historyLoadMoreRef.current) return commits;

      const seen = new Set(prev.map((commit) => commit.hash));
      return [...prev, ...commits.filter((commit) => !seen.has(commit.hash))];
    });

    setHistoryHasMore(Boolean(logResult.hasMore));
    setHistorySkip(logResult.nextSkip ?? commits.length);
    historyLoadMoreRef.current = false;
  }, [logResult]);

  useEffect(() => {
    const pending = pendingRefreshRef.current;
    if (!pending) {
      setLoading((prev) => (prev === 'status' || prev === 'log' || prev === 'branches' ? null : prev));
      return;
    }

    const next = gitResults.get(pending.action);
    if (next === undefined || Object.is(next, pending.prev)) return;
    pendingRefreshRef.current = null;
    setLoading(null);
    requestStatus();
  }, [gitResults, requestStatus]);

  useEffect(() => {
    if (loading === null) return;

    if (
      (loading === 'status' && gitResults.get('status') !== undefined) ||
      (loading === 'log' && gitResults.get('log') !== undefined) ||
      (loading === 'branches' && gitResults.get('branches') !== undefined) ||
      (loading === 'diff' && gitResults.get('diff') !== undefined) ||
      (loading === 'commit_files' && gitResults.get('commit_files') !== undefined) ||
      (loading === 'commit_diff' && gitResults.get('commit_diff') !== undefined)
    ) {
      setLoading(null);
    }
  }, [gitResults, loading]);

  const handleAction = useCallback(
    (action: string, params?: Record<string, unknown>) => {
      setLoading(action);
      if (REFRESH_AFTER.has(action)) {
        pendingRefreshRef.current = { action, prev: gitResults.get(action) };
      }
      onSend({ type: 'git', action, params });
    },
    [gitResults, onSend],
  );

  const handleStage = useCallback((file: string) => handleAction('stage', { file }), [handleAction]);
  const handleUnstage = useCallback((file: string) => handleAction('unstage', { file }), [handleAction]);
  const handleStageAll = useCallback(() => handleAction('stage'), [handleAction]);
  const handleUnstageAll = useCallback(() => handleAction('unstage'), [handleAction]);

  const handleSelectFile = useCallback((path: string, staged: boolean) => {
    setSelectedFile({ path, staged });
    setLoading('diff');
    onSend({ type: 'git', action: 'diff', params: { file: path, staged } });
  }, [onSend]);

  const handleCommit = useCallback(() => {
    if (!commitMessage.trim()) return;
    handleAction('commit', { message: commitMessage.trim() });
    setCommitMessage('');
  }, [commitMessage, handleAction]);

  const handleCheckout = useCallback((branch: string) => {
    handleAction('checkout', { branch });
    setShowBranchPicker(false);
  }, [handleAction]);

  const handleSelectCommit = useCallback((commit: LogCommit) => {
    setSelectedCommit(commit);
    setSelectedCommitDiff(null);
    requestCommitFiles(commit.hash);
  }, [requestCommitFiles]);

  const handleSelectCommitFile = useCallback((hash: string, file: string) => {
    setSelectedCommitDiff({ hash, file });
    requestCommitDiff(hash, file);
  }, [requestCommitDiff]);

  const handleLoadMoreHistory = useCallback(() => {
    if (!historyHasMore || loading === 'log') return;
    historyLoadMoreRef.current = true;
    requestLog(historySkip);
  }, [historyHasMore, historySkip, loading, requestLog]);

  const handleHistoryScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (activeTab !== 'history' || !historyHasMore || loading === 'log') return;

    const target = event.currentTarget;
    const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;

    if (remaining < 120) {
      historyLoadMoreRef.current = true;
      requestLog(historySkip);
    }
  }, [activeTab, historyHasMore, historySkip, loading, requestLog]);

  if (!open) return null;

  const stagedFiles = gitStatus?.stagedFiles ?? [];
  const unstagedFiles = gitStatus?.unstagedFiles ?? [];
  const currentBranch = gitStatus?.branch ?? '';
  const branches = branchesResult?.branches ?? [];
  const commitFiles = commitFilesResult?.files ?? [];

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40 md:hidden" onClick={onClose} />

      <div className="fixed right-0 top-0 bottom-0 w-full max-w-sm bg-(--bg-primary) border-l border-(--border) z-50 flex flex-col animate-slide-left shadow-2xl">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-(--border) shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <GitBranch size={16} className="text-(--accent) shrink-0" />
            <h2 className="font-semibold text-sm shrink-0">Source Control</h2>
            {currentBranch && (
              <button
                onClick={() => setShowBranchPicker((value) => !value)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-(--bg-tertiary) hover:bg-(--bg-hover) transition-colors min-w-0"
              >
                <span className="text-xs font-mono truncate max-w-30 text-(--text-secondary)">
                  {currentBranch}
                </span>
                <ChevronDown size={11} className="text-(--text-muted) shrink-0" />
              </button>
            )}
            {(gitStatus?.ahead ?? 0) > 0 && (
              <span className="text-xs text-(--success) shrink-0">↑{gitStatus?.ahead}</span>
            )}
            {(gitStatus?.behind ?? 0) > 0 && (
              <span className="text-xs text-(--warning) shrink-0">↓{gitStatus?.behind}</span>
            )}
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => {
                requestStatus();
                if (activeTab === 'history') {
                  historyLoadMoreRef.current = false;
                  requestLog(0);
                }
                if (selectedCommit) requestCommitFiles(selectedCommit.hash);
                if (selectedCommitDiff) requestCommitDiff(selectedCommitDiff.hash, selectedCommitDiff.file);
              }}
              className="p-1.5 rounded-lg hover:bg-(--bg-tertiary) transition-colors"
              title="Refresh"
            >
              <RefreshCw
                size={13}
                className={`text-(--text-muted) ${
                  loading === 'status' ||
                  loading === 'log' ||
                  loading === 'branches' ||
                  loading === 'commit_files' ||
                  loading === 'commit_diff'
                    ? 'animate-spin'
                    : ''
                }`}
              />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-(--bg-tertiary) transition-colors"
            >
              <X size={13} className="text-(--text-muted)" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden relative">
          {showBranchPicker && (
            <GitBranchPicker
              branches={branches}
              currentBranch={currentBranch}
              loading={loading === 'branches'}
              onSelect={handleCheckout}
              onClose={() => setShowBranchPicker(false)}
            />
          )}

          {selectedFile && !showBranchPicker ? (
            <GitDiffViewer
              filePath={selectedFile.path}
              diff={isDiffMatch ? (diffResult?.diff ?? null) : null}
              loading={loading === 'diff' || (!!selectedFile && !isDiffMatch && !diffResult?._error)}
              onBack={() => setSelectedFile(null)}
            />
          ) : selectedCommitDiff && selectedCommit && !showBranchPicker ? (
            <GitDiffViewer
              filePath={selectedCommitDiff.file}
              subtitle={`${selectedCommit.shortHash} · ${selectedCommit.subject}`}
              diff={isCommitDiffMatch ? (commitDiffResult?.diff ?? null) : null}
              loading={loading === 'commit_diff' || (!!selectedCommitDiff && !isCommitDiffMatch && !commitDiffResult?._error)}
              onBack={() => setSelectedCommitDiff(null)}
              emptyMessage="No file diff available for this commit"
            />
          ) : selectedCommit && !showBranchPicker ? (
            <div className="h-full flex flex-col overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-(--border) shrink-0">
                <button
                  onClick={() => setSelectedCommit(null)}
                  className="p-1 rounded hover:bg-(--bg-tertiary) transition-colors"
                  title="Back"
                >
                  <ChevronRight size={16} className="text-(--text-muted) rotate-180" />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-(--text-primary) break-words">
                    {selectedCommit.subject}
                  </p>
                  <p className="text-xs text-(--text-muted) truncate">
                    {selectedCommit.shortHash} · {selectedCommit.author} · {formatCommitDate(selectedCommit.timestamp)}
                  </p>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto scroll-hover-area px-2 py-2 space-y-1">
                {commitFilesResult?._error && (
                  <div className="text-xs text-(--error) bg-(--error)/10 rounded-lg px-3 py-2">
                    {commitFilesResult._error}
                  </div>
                )}

                {loading === 'commit_files' && commitFiles.length === 0 ? (
                  <div className="flex items-center justify-center h-24">
                    <Loader2 size={16} className="animate-spin text-(--text-muted)" />
                  </div>
                ) : commitFiles.length === 0 ? (
                  <p className="text-xs text-(--text-muted) text-center py-6">
                    No changed files in this commit
                  </p>
                ) : (
                  commitFiles.map((file) => (
                    <button
                      key={`${selectedCommit.hash}:${file.path}:${file.nextPath ?? ''}`}
                      onClick={() => handleSelectCommitFile(selectedCommit.hash, file.nextPath ?? file.path)}
                      className="w-full flex items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-(--bg-tertiary) transition-colors"
                    >
                      {fileStatusIcon(file.status)}
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-mono text-(--text-primary) truncate">
                          {file.nextPath ?? file.path}
                        </p>
                        {file.nextPath && file.nextPath !== file.path && (
                          <p className="text-[11px] text-(--text-muted) truncate">
                            from {file.path}
                          </p>
                        )}
                      </div>
                      {statusBadge(file.status)}
                    </button>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="h-full flex flex-col overflow-hidden">
              <div className="px-2 pt-2 pb-1 shrink-0">
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-(--bg-secondary) p-1 border border-(--border)">
                  <button
                    onClick={() => {
                      setSelectedCommit(null);
                      setSelectedCommitDiff(null);
                      setActiveTab('changes');
                    }}
                    className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                      activeTab === 'changes'
                        ? 'bg-(--bg-primary) text-(--text-primary)'
                        : 'text-(--text-muted) hover:text-(--text-primary)'
                    }`}
                  >
                    <FileText size={13} />
                    Changes
                  </button>
                  <button
                    onClick={() => {
                      setSelectedCommit(null);
                      setSelectedCommitDiff(null);
                      setActiveTab('history');
                      historyLoadMoreRef.current = false;
                      requestLog(0);
                    }}
                    className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors ${
                      activeTab === 'history'
                        ? 'bg-(--bg-primary) text-(--text-primary)'
                        : 'text-(--text-muted) hover:text-(--text-primary)'
                    }`}
                  >
                    <GitGraph size={13} />
                    History
                  </button>
                </div>
              </div>

              <div
                className="flex-1 overflow-y-auto scroll-hover-area px-1 py-1 space-y-0.5"
                onScroll={handleHistoryScroll}
              >
                {activeTab === 'changes' ? (
                  <>
                    {gitStatus?._error && (
                      <div className="text-xs text-(--error) bg-(--error)/10 rounded-lg px-3 py-2 mx-2">
                        {gitStatus._error}
                      </div>
                    )}

                    <div>
                      <button
                        onClick={() => setStagedOpen((value) => !value)}
                        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-(--bg-tertiary) rounded transition-colors group"
                      >
                        <div className="flex items-center gap-1.5">
                          {stagedOpen ? (
                            <ChevronDown size={13} className="text-(--text-muted)" />
                          ) : (
                            <ChevronRight size={13} className="text-(--text-muted)" />
                          )}
                          <span className="text-xs font-semibold text-(--text-secondary) uppercase tracking-wider">
                            Staged Changes
                          </span>
                          {stagedFiles.length > 0 && (
                            <span className="text-xs text-(--text-muted)">({stagedFiles.length})</span>
                          )}
                        </div>
                        {stagedFiles.length > 0 && (
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              handleUnstageAll();
                            }}
                            className="opacity-0 group-hover:opacity-100 text-xs text-(--text-muted) hover:text-(--text-primary) px-1.5 py-0.5 rounded hover:bg-(--bg-hover) transition-all"
                            title="Unstage all"
                          >
                            Unstage all
                          </button>
                        )}
                      </button>

                      {stagedOpen && (
                        <div className="space-y-0.5 ml-1">
                          {stagedFiles.length === 0 ? (
                            <p className="text-xs text-(--text-muted) px-4 py-1">No staged files</p>
                          ) : (
                            stagedFiles.map((file) => (
                              <div
                                key={`staged-${file.path}`}
                                className="flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-(--bg-tertiary) transition-colors cursor-pointer group"
                                onClick={() => handleSelectFile(file.path, true)}
                              >
                                {fileStatusIcon(file.status)}
                                <span className="text-xs font-mono truncate flex-1 text-(--text-primary)">
                                  {file.path.split('/').at(-1)}
                                </span>
                                <span className="text-xs text-(--text-muted) font-mono truncate hidden group-hover:hidden max-w-20">
                                  {file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''}
                                </span>
                                {statusBadge(file.status)}
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleUnstage(file.path);
                                  }}
                                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-(--bg-hover) transition-all"
                                  title="Unstage"
                                >
                                  {loading === 'unstage' ? (
                                    <Loader2 size={12} className="animate-spin text-(--text-muted)" />
                                  ) : (
                                    <Minus size={12} className="text-(--text-muted)" />
                                  )}
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>

                    <div>
                      <button
                        onClick={() => setChangesOpen((value) => !value)}
                        className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-(--bg-tertiary) rounded transition-colors group"
                      >
                        <div className="flex items-center gap-1.5">
                          {changesOpen ? (
                            <ChevronDown size={13} className="text-(--text-muted)" />
                          ) : (
                            <ChevronRight size={13} className="text-(--text-muted)" />
                          )}
                          <span className="text-xs font-semibold text-(--text-secondary) uppercase tracking-wider">
                            Changes
                          </span>
                          {unstagedFiles.length > 0 && (
                            <span className="text-xs text-(--text-muted)">({unstagedFiles.length})</span>
                          )}
                        </div>
                        {unstagedFiles.length > 0 && (
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              handleStageAll();
                            }}
                            className="opacity-0 group-hover:opacity-100 text-xs text-(--text-muted) hover:text-(--text-primary) px-1.5 py-0.5 rounded hover:bg-(--bg-hover) transition-all"
                            title="Stage all"
                          >
                            Stage all
                          </button>
                        )}
                      </button>

                      {changesOpen && (
                        <div className="space-y-0.5 ml-1">
                          {unstagedFiles.length === 0 ? (
                            <p className="text-xs text-(--text-muted) px-4 py-1">No unstaged files</p>
                          ) : (
                            unstagedFiles.map((file) => (
                              <div
                                key={`unstaged-${file.path}`}
                                className="flex items-center gap-1.5 px-2 py-1.5 rounded hover:bg-(--bg-tertiary) transition-colors cursor-pointer group"
                                onClick={() => handleSelectFile(file.path, false)}
                              >
                                {fileStatusIcon(file.status)}
                                <span className="text-xs font-mono truncate flex-1 text-(--text-primary)">
                                  {file.path.split('/').at(-1)}
                                </span>
                                {statusBadge(file.status)}
                                <button
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    handleStage(file.path);
                                  }}
                                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-(--bg-hover) transition-all"
                                  title="Stage"
                                >
                                  {loading === 'stage' ? (
                                    <Loader2 size={12} className="animate-spin text-(--text-muted)" />
                                  ) : (
                                    <Plus size={12} className="text-(--text-muted)" />
                                  )}
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      )}
                    </div>

                    {gitStatus && !gitStatus._error && gitStatus.clean && (
                      <p className="text-xs text-(--text-muted) text-center py-6">
                        Working tree is clean
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    {logResult?._error && (
                      <div className="text-xs text-(--error) bg-(--error)/10 rounded-lg px-3 py-2 mx-2">
                        {logResult._error}
                      </div>
                    )}

                    {loading === 'log' && historyItems.length === 0 ? (
                      <div className="flex items-center justify-center h-24">
                        <Loader2 size={16} className="animate-spin text-(--text-muted)" />
                      </div>
                    ) : historyItems.length === 0 ? (
                      <p className="text-xs text-(--text-muted) text-center py-6">
                        No commit history available
                      </p>
                    ) : (
                      <div className="px-1 py-1">
                        {historyItems.map((commit, index) => (
                          <button
                            key={commit.hash}
                            onClick={() => handleSelectCommit(commit)}
                            className="w-full grid grid-cols-[24px_minmax(0,1fr)] gap-2 rounded-lg px-2 py-2 text-left hover:bg-(--bg-tertiary) transition-colors"
                          >
                            <div className="relative flex justify-center pt-0.5">
                              {index < historyItems.length - 1 && (
                                <span className="absolute top-4 bottom-[-10px] w-px bg-(--border)" />
                              )}
                              <span className="relative z-10 mt-0.5 h-2.5 w-2.5 rounded-full border border-(--accent) bg-(--bg-primary)" />
                            </div>
                            <div className="min-w-0">
                              <div className="flex items-start justify-between gap-2">
                                <p className="text-xs font-medium text-(--text-primary) break-words">
                                  {commit.subject}
                                </p>
                                <span className="shrink-0 rounded bg-(--bg-secondary) px-1.5 py-0.5 text-[10px] font-mono text-(--text-muted)">
                                  {commit.shortHash}
                                </span>
                              </div>
                              <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-(--text-muted)">
                                <span className="truncate">{commit.author}</span>
                                <span className="shrink-0">{formatCommitDate(commit.timestamp)}</span>
                              </div>
                            </div>
                          </button>
                        ))}

                        {historyHasMore && (
                          <button
                            onClick={handleLoadMoreHistory}
                            disabled={loading === 'log'}
                            className="mt-2 w-full rounded-lg border border-(--border) bg-(--bg-secondary) px-3 py-2 text-xs text-(--text-secondary) hover:bg-(--bg-tertiary) transition-colors disabled:opacity-50"
                          >
                            {loading === 'log' ? 'Loading older commits...' : 'Load older commits'}
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              <div className="px-3 pt-2 pb-3 border-t border-(--border) shrink-0">
                <textarea
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) handleCommit();
                  }}
                  placeholder="Commit message (Ctrl+Enter)"
                  rows={2}
                  className="w-full px-2.5 py-2 rounded-lg bg-(--input-bg) border border-(--input-border) text-xs placeholder-(--text-muted) focus:border-(--accent) focus:outline-none resize-none mb-2"
                />
                <button
                  onClick={handleCommit}
                  disabled={!commitMessage.trim() || loading === 'commit' || stagedFiles.length === 0}
                  className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded-lg bg-(--accent) text-white text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed mb-2"
                >
                  {loading === 'commit' ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <GitCommit size={13} />
                  )}
                  Commit
                </button>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handleAction('pull')}
                    disabled={loading === 'pull'}
                    className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-(--bg-secondary) border border-(--border) text-xs hover:bg-(--bg-tertiary) transition-colors disabled:opacity-40"
                  >
                    {loading === 'pull' ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Download size={13} />
                    )}
                    Pull
                  </button>
                  <button
                    onClick={() => handleAction('push')}
                    disabled={loading === 'push'}
                    className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-(--bg-secondary) border border-(--border) text-xs hover:bg-(--bg-tertiary) transition-colors disabled:opacity-40"
                  >
                    {loading === 'push' ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Upload size={13} />
                    )}
                    Push
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
