import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  GitBranch,
  GitCommit,
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

interface SelectedFile {
  path: string;
  staged: boolean;
}

// status/checkout/stage/unstage/commit 이후 자동 갱신
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
    added:     { label: 'A', cls: 'text-(--success) bg-(--success)/10' },
    deleted:   { label: 'D', cls: 'text-(--error) bg-(--error)/10' },
    modified:  { label: 'M', cls: 'text-(--warning) bg-(--warning)/10' },
    renamed:   { label: 'R', cls: 'text-sky-500 bg-sky-500/10' },
    untracked: { label: 'U', cls: 'text-(--text-muted) bg-(--bg-tertiary)' },
  };
  const { label, cls } = map[status] ?? { label: '?', cls: 'text-(--text-muted)' };
  return (
    <span className={`text-[10px] font-bold px-1 py-0.5 rounded ${cls}`}>
      {label}
    </span>
  );
}

export default function GitPanel({ open, onClose, onSend, gitResults }: GitPanelProps) {
  const [commitMessage, setCommitMessage] = useState('');
  const [loading, setLoading] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<SelectedFile | null>(null);
  const [showBranchPicker, setShowBranchPicker] = useState(false);
  const [stagedOpen, setStagedOpen] = useState(true);
  const [changesOpen, setChangesOpen] = useState(true);

  const pendingRefreshRef = useRef<{ action: string; prev: unknown } | null>(null);

  const gitStatus = gitResults.get('status') as GitStatus | undefined;
  const diffResult = gitResults.get('diff') as DiffResult | undefined;
  const branchesResult = gitResults.get('branches') as BranchesResult | undefined;

  // 선택된 파일의 diff가 맞는지 확인 (stale 방지)
  const isDiffMatch =
    diffResult &&
    !diffResult._error &&
    diffResult.file === selectedFile?.path &&
    diffResult.staged === selectedFile?.staged;

  const requestStatus = useCallback(() => {
    onSend({ type: 'git', action: 'status' });
  }, [onSend]);

  const requestBranches = useCallback(() => {
    onSend({ type: 'git', action: 'branches' });
  }, [onSend]);

  useEffect(() => {
    if (open) {
      requestStatus();
    }
  }, [open, requestStatus]);

  // 브랜치 피커 열릴 때 목록 조회
  useEffect(() => {
    if (showBranchPicker) {
      requestBranches();
    }
  }, [showBranchPicker, requestBranches]);

  // 결과 도착 → 로딩 해제 + 쓰기 액션 후 status 자동 갱신
  useEffect(() => {
    setLoading(null);
    const pending = pendingRefreshRef.current;
    if (!pending) return;
    const next = gitResults.get(pending.action);
    if (next === undefined || Object.is(next, pending.prev)) return;
    pendingRefreshRef.current = null;
    requestStatus();
  }, [gitResults, requestStatus]);

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

  const handleStage = useCallback(
    (file: string) => handleAction('stage', { file }),
    [handleAction],
  );

  const handleUnstage = useCallback(
    (file: string) => handleAction('unstage', { file }),
    [handleAction],
  );

  const handleStageAll = useCallback(
    () => handleAction('stage'),
    [handleAction],
  );

  const handleUnstageAll = useCallback(
    () => handleAction('unstage'),
    [handleAction],
  );

  const handleSelectFile = useCallback(
    (path: string, staged: boolean) => {
      setSelectedFile({ path, staged });
      onSend({ type: 'git', action: 'diff', params: { file: path, staged } });
    },
    [onSend],
  );

  const handleCommit = useCallback(() => {
    if (!commitMessage.trim()) return;
    handleAction('commit', { message: commitMessage.trim() });
    setCommitMessage('');
  }, [commitMessage, handleAction]);

  const handleCheckout = useCallback(
    (branch: string) => {
      handleAction('checkout', { branch });
      setShowBranchPicker(false);
    },
    [handleAction],
  );

  if (!open) return null;

  const stagedFiles = gitStatus?.stagedFiles ?? [];
  const unstagedFiles = gitStatus?.unstagedFiles ?? [];
  const currentBranch = gitStatus?.branch ?? '';
  const branches = branchesResult?.branches ?? [];

  return (
    <>
      {/* 모바일 오버레이 */}
      <div
        className="fixed inset-0 bg-black/40 z-40 md:hidden"
        onClick={onClose}
      />

      {/* 패널 */}
      <div className="fixed right-0 top-0 bottom-0 w-full max-w-sm bg-(--bg-primary) border-l border-(--border) z-50 flex flex-col animate-slide-left shadow-2xl">

        {/* 헤더 */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-(--border) shrink-0">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <GitBranch size={16} className="text-(--accent) shrink-0" />
            <h2 className="font-semibold text-sm shrink-0">소스 제어</h2>
            {/* 브랜치 전환 버튼 */}
            {currentBranch && (
              <button
                onClick={() => setShowBranchPicker((v) => !v)}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-(--bg-tertiary) hover:bg-(--bg-hover) transition-colors min-w-0"
              >
                <span className="text-xs font-mono truncate max-w-30 text-(--text-secondary)">
                  {currentBranch}
                </span>
                <ChevronDown size={11} className="text-(--text-muted) shrink-0" />
              </button>
            )}
            {/* ahead/behind */}
            {(gitStatus?.ahead ?? 0) > 0 && (
              <span className="text-xs text-(--success) shrink-0">↑{gitStatus!.ahead}</span>
            )}
            {(gitStatus?.behind ?? 0) > 0 && (
              <span className="text-xs text-(--warning) shrink-0">↓{gitStatus!.behind}</span>
            )}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={requestStatus}
              className="p-1.5 rounded-lg hover:bg-(--bg-tertiary) transition-colors"
              title="새로고침"
            >
              <RefreshCw
                size={13}
                className={`text-(--text-muted) ${loading === 'status' ? 'animate-spin' : ''}`}
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

        {/* 패널 본문 (브랜치 피커 or diff or 파일목록) */}
        <div className="flex-1 overflow-hidden relative">

          {/* 브랜치 피커 오버레이 */}
          {showBranchPicker && (
            <GitBranchPicker
              branches={branches}
              currentBranch={currentBranch}
              loading={loading === 'branches'}
              onSelect={handleCheckout}
              onClose={() => setShowBranchPicker(false)}
            />
          )}

          {/* diff 뷰어 */}
          {selectedFile && !showBranchPicker ? (
            <GitDiffViewer
              filePath={selectedFile.path}
              diff={isDiffMatch ? (diffResult?.diff ?? null) : null}
              loading={loading === 'diff' || (!!selectedFile && !isDiffMatch && !diffResult?._error)}
              onBack={() => setSelectedFile(null)}
            />
          ) : (
            /* 파일 목록 + 커밋 폼 */
            <div className="h-full flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto scroll-hover-area px-1 py-1 space-y-0.5">

                {/* 에러 */}
                {gitStatus?._error && (
                  <div className="text-xs text-(--error) bg-(--error)/10 rounded-lg px-3 py-2 mx-2">
                    {gitStatus._error}
                  </div>
                )}

                {/* Staged Changes */}
                <div>
                  <button
                    onClick={() => setStagedOpen((v) => !v)}
                    className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-(--bg-tertiary) rounded transition-colors group"
                  >
                    <div className="flex items-center gap-1.5">
                      {stagedOpen
                        ? <ChevronDown size={13} className="text-(--text-muted)" />
                        : <ChevronRight size={13} className="text-(--text-muted)" />
                      }
                      <span className="text-xs font-semibold text-(--text-secondary) uppercase tracking-wider">
                        스테이징된 변경사항
                      </span>
                      {stagedFiles.length > 0 && (
                        <span className="text-xs text-(--text-muted)">({stagedFiles.length})</span>
                      )}
                    </div>
                    {stagedFiles.length > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleUnstageAll(); }}
                        className="opacity-0 group-hover:opacity-100 text-xs text-(--text-muted) hover:text-(--text-primary) px-1.5 py-0.5 rounded hover:bg-(--bg-hover) transition-all"
                        title="전체 언스테이징"
                      >
                        전체 취소
                      </button>
                    )}
                  </button>

                  {stagedOpen && (
                    <div className="space-y-0.5 ml-1">
                      {stagedFiles.length === 0 ? (
                        <p className="text-xs text-(--text-muted) px-4 py-1">없음</p>
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
                            {/* 언스테이징 버튼 */}
                            <button
                              onClick={(e) => { e.stopPropagation(); handleUnstage(file.path); }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-(--bg-hover) transition-all"
                              title="언스테이징"
                            >
                              {loading === 'unstage'
                                ? <Loader2 size={12} className="animate-spin text-(--text-muted)" />
                                : <Minus size={12} className="text-(--text-muted)" />
                              }
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* Changes (Unstaged) */}
                <div>
                  <button
                    onClick={() => setChangesOpen((v) => !v)}
                    className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-(--bg-tertiary) rounded transition-colors group"
                  >
                    <div className="flex items-center gap-1.5">
                      {changesOpen
                        ? <ChevronDown size={13} className="text-(--text-muted)" />
                        : <ChevronRight size={13} className="text-(--text-muted)" />
                      }
                      <span className="text-xs font-semibold text-(--text-secondary) uppercase tracking-wider">
                        변경사항
                      </span>
                      {unstagedFiles.length > 0 && (
                        <span className="text-xs text-(--text-muted)">({unstagedFiles.length})</span>
                      )}
                    </div>
                    {unstagedFiles.length > 0 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleStageAll(); }}
                        className="opacity-0 group-hover:opacity-100 text-xs text-(--text-muted) hover:text-(--text-primary) px-1.5 py-0.5 rounded hover:bg-(--bg-hover) transition-all"
                        title="전체 스테이징"
                      >
                        전체 추가
                      </button>
                    )}
                  </button>

                  {changesOpen && (
                    <div className="space-y-0.5 ml-1">
                      {unstagedFiles.length === 0 ? (
                        <p className="text-xs text-(--text-muted) px-4 py-1">없음</p>
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
                            {/* 스테이징 버튼 */}
                            <button
                              onClick={(e) => { e.stopPropagation(); handleStage(file.path); }}
                              className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-(--bg-hover) transition-all"
                              title="스테이징"
                            >
                              {loading === 'stage'
                                ? <Loader2 size={12} className="animate-spin text-(--text-muted)" />
                                : <Plus size={12} className="text-(--text-muted)" />
                              }
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* 변경사항 없음 */}
                {gitStatus && !gitStatus._error && gitStatus.clean && (
                  <p className="text-xs text-(--text-muted) text-center py-6">
                    변경사항 없음
                  </p>
                )}
              </div>

              {/* 커밋 폼 */}
              <div className="px-3 pt-2 pb-3 border-t border-(--border) shrink-0">
                <textarea
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleCommit();
                  }}
                  placeholder="커밋 메시지 (Ctrl+Enter)"
                  rows={2}
                  className="w-full px-2.5 py-2 rounded-lg bg-(--input-bg) border border-(--input-border) text-xs placeholder-(--text-muted) focus:border-(--accent) focus:outline-none resize-none mb-2"
                />
                <button
                  onClick={handleCommit}
                  disabled={!commitMessage.trim() || loading === 'commit' || stagedFiles.length === 0}
                  className="flex items-center justify-center gap-1.5 w-full py-1.5 rounded-lg bg-(--accent) text-white text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed mb-2"
                >
                  {loading === 'commit'
                    ? <Loader2 size={13} className="animate-spin" />
                    : <GitCommit size={13} />
                  }
                  커밋
                </button>

                {/* Pull / Push */}
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => handleAction('pull')}
                    disabled={loading === 'pull'}
                    className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-(--bg-secondary) border border-(--border) text-xs hover:bg-(--bg-tertiary) transition-colors disabled:opacity-40"
                  >
                    {loading === 'pull'
                      ? <Loader2 size={13} className="animate-spin" />
                      : <Download size={13} />
                    }
                    Pull
                  </button>
                  <button
                    onClick={() => handleAction('push')}
                    disabled={loading === 'push'}
                    className="flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-(--bg-secondary) border border-(--border) text-xs hover:bg-(--bg-tertiary) transition-colors disabled:opacity-40"
                  >
                    {loading === 'push'
                      ? <Loader2 size={13} className="animate-spin" />
                      : <Upload size={13} />
                    }
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
