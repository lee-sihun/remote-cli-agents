import { ChevronLeft, Loader2 } from 'lucide-react';

interface GitDiffViewerProps {
  filePath: string;
  diff: string | null;
  loading: boolean;
  onBack: () => void;
}

// unified diff 한 줄 파싱
function DiffLine({ line }: { line: string }) {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return (
      <div className="text-xs font-mono text-(--text-muted) px-3 py-0.5 select-text">
        {line}
      </div>
    );
  }
  if (line.startsWith('@@')) {
    return (
      <div className="text-xs font-mono text-sky-500 dark:text-sky-400 px-3 py-0.5 bg-(--bg-tertiary) select-text">
        {line}
      </div>
    );
  }
  if (line.startsWith('+')) {
    return (
      <div className="text-xs font-mono text-emerald-600 dark:text-emerald-400 bg-emerald-50/60 dark:bg-emerald-950/30 px-3 py-0.5 select-text whitespace-pre-wrap break-all">
        {line}
      </div>
    );
  }
  if (line.startsWith('-')) {
    return (
      <div className="text-xs font-mono text-red-600 dark:text-red-400 bg-red-50/60 dark:bg-red-950/30 px-3 py-0.5 select-text whitespace-pre-wrap break-all">
        {line}
      </div>
    );
  }
  return (
    <div className="text-xs font-mono text-(--text-secondary) px-3 py-0.5 select-text whitespace-pre-wrap break-all">
      {line}
    </div>
  );
}

const GitDiffViewer = ({ filePath, diff, loading, onBack }: GitDiffViewerProps) => {
  const fileName = filePath.split('/').at(-1) ?? filePath;

  return (
    <div className="flex flex-col h-full">
      {/* diff 뷰어 헤더 */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-(--border) shrink-0">
        <button
          onClick={onBack}
          className="p-1 rounded hover:bg-(--bg-tertiary) transition-colors"
          title="뒤로가기"
        >
          <ChevronLeft size={16} className="text-(--text-muted)" />
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-mono font-medium truncate text-(--text-primary)">
            {fileName}
          </p>
          <p className="text-xs text-(--text-muted) truncate">{filePath}</p>
        </div>
      </div>

      {/* diff 내용 */}
      <div className="flex-1 overflow-y-auto scroll-hover-area">
        {loading ? (
          <div className="flex items-center justify-center h-20">
            <Loader2 size={16} className="animate-spin text-(--text-muted)" />
          </div>
        ) : !diff ? (
          <p className="text-xs text-(--text-muted) px-4 py-4">변경사항 없음</p>
        ) : (
          <div>
            {diff.split('\n').map((line, i) => (
              <DiffLine key={i} line={line} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default GitDiffViewer;
