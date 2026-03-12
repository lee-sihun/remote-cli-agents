import type { AgentStatus, ContextUsage, ThreadSummary } from './protocol';

interface ActiveThreadMeta {
  contextUsage?: ContextUsage;
  model?: string;
}

export function resolveActiveThreadMeta(
  activeThreadId: string | null,
  agentStatus?: AgentStatus,
  activeThreadSummary?: ThreadSummary,
): ActiveThreadMeta {
  if (!activeThreadId) {
    return {};
  }

  const statusMatchesActiveThread = agentStatus?.activeThread === activeThreadId;

  return {
    model: activeThreadSummary?.model || (statusMatchesActiveThread ? agentStatus?.model : undefined),
    contextUsage: statusMatchesActiveThread
      ? agentStatus?.contextUsage || activeThreadSummary?.contextUsage
      : activeThreadSummary?.contextUsage,
  };
}
