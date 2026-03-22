import { Check, GitBranch, Loader2 } from 'lucide-react';

interface Branch {
  name: string;
  current: boolean;
  remote: boolean;
}

interface GitBranchPickerProps {
  branches: Branch[];
  currentBranch: string;
  loading: boolean;
  onSelect: (branch: string) => void;
  onClose: () => void;
}

const GitBranchPicker = ({ branches, currentBranch, loading, onSelect, onClose }: GitBranchPickerProps) => {
  const localBranches = branches.filter((b) => !b.remote);
  const remoteBranches = branches.filter((b) => b.remote);

  const renderBranch = (branch: Branch) => (
    <button
      key={branch.name}
      onClick={() => {
        if (!branch.current) onSelect(branch.name);
        onClose();
      }}
      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-(--bg-tertiary) transition-colors text-left"
    >
      <GitBranch size={13} className="text-(--text-muted) shrink-0" />
      <span className="text-xs font-mono truncate flex-1 text-(--text-primary)">
        {branch.name}
      </span>
      {branch.current && (
        <Check size={13} className="text-(--accent) shrink-0" />
      )}
    </button>
  );

  return (
    <div
      className="absolute inset-0 z-10 bg-(--bg-primary) flex flex-col"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="px-3 py-2 border-b border-(--border) shrink-0">
        <p className="text-xs font-semibold text-(--text-muted) uppercase tracking-wider">
          Switch Branch
        </p>
      </div>

      <div className="flex-1 overflow-y-auto scroll-hover-area">
        {loading ? (
          <div className="flex items-center justify-center h-16">
            <Loader2 size={16} className="animate-spin text-(--text-muted)" />
          </div>
        ) : (
          <>
            {localBranches.length > 0 && (
              <div>
                <p className="text-xs text-(--text-muted) px-3 pt-3 pb-1 uppercase tracking-wider font-medium">
                  Local
                </p>
                {localBranches.map(renderBranch)}
              </div>
            )}

            {remoteBranches.length > 0 && (
              <div>
                <p className="text-xs text-(--text-muted) px-3 pt-3 pb-1 uppercase tracking-wider font-medium">
                  Remote
                </p>
                {remoteBranches.map(renderBranch)}
              </div>
            )}

            {branches.length === 0 && (
              <p className="text-xs text-(--text-muted) px-3 py-4">
                No branches found
              </p>
            )}
          </>
        )}
      </div>

      <div className="p-3 border-t border-(--border) shrink-0">
        <p className="text-xs text-(--text-muted) text-center">
          Current: <span className="font-mono text-(--text-primary)">{currentBranch}</span>
        </p>
      </div>
    </div>
  );
};

export default GitBranchPicker;
