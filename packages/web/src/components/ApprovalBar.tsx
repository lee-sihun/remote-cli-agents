import React from 'react';
import { ShieldAlert, Check, X, ChevronDown, ChevronRight } from 'lucide-react';
import type { ToolCall, AgentType } from '../lib/protocol';

interface ApprovalBarProps {
  approvals: (ToolCall & { threadId: string; agentType: AgentType })[];
  onApprove: (
    agentType: AgentType,
    threadId: string,
    toolCallId: string,
    approved: boolean,
  ) => void;
}

function ApprovalItem({
  approval,
  onApprove,
}: {
  approval: ToolCall & { threadId: string; agentType: AgentType };
  onApprove: ApprovalBarProps['onApprove'];
}) {
  const [expanded, setExpanded] = React.useState(false);

  return (
    <div className="bg-(--bg-secondary) border border-(--warning)/40 rounded-xl p-3 animate-slide-up">
      <div className="flex items-start gap-3">
        <div className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg bg-(--warning)/10">
          <ShieldAlert size={16} className="text-(--warning)" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium">Permission Required</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-(--bg-tertiary) text-(--text-muted)">
              {approval.name}
            </span>
          </div>

          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-(--text-muted) hover:text-(--text-secondary) transition-colors"
          >
            {expanded ? (
              <ChevronDown size={12} />
            ) : (
              <ChevronRight size={12} />
            )}
            {expanded ? 'Hide details' : 'Show details'}
          </button>

          {expanded && (
            <pre className="mt-2 p-2 rounded-lg bg-(--bg-primary) text-xs font-mono overflow-x-auto max-h-40 overflow-y-auto">
              {JSON.stringify(approval.input, null, 2)}
            </pre>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() =>
              onApprove(
                approval.agentType,
                approval.threadId,
                approval.id,
                false,
              )
            }
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-(--error)/10 text-(--error) text-sm font-medium hover:bg-(--error)/20 transition-colors"
          >
            <X size={14} />
            <span className="hidden sm:inline">Reject</span>
          </button>
          <button
            onClick={() =>
              onApprove(
                approval.agentType,
                approval.threadId,
                approval.id,
                true,
              )
            }
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-(--success)/10 text-(--success) text-sm font-medium hover:bg-(--success)/20 transition-colors"
          >
            <Check size={14} />
            <span className="hidden sm:inline">Approve</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ApprovalBar({
  approvals,
  onApprove,
}: ApprovalBarProps) {
  if (approvals.length === 0) return null;

  return (
    <div className="border-t border-(--border) bg-(--bg-primary) p-3 sm:p-4 space-y-2">
      {approvals.map((approval) => (
        <ApprovalItem
          key={approval.id}
          approval={approval}
          onApprove={onApprove}
        />
      ))}
    </div>
  );
}
