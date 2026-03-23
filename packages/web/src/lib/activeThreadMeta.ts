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
  const hasExplicitContextUsage = Boolean(
    agentStatus && Object.prototype.hasOwnProperty.call(agentStatus, 'contextUsage'),
  );

  return {
    model: activeThreadSummary?.model || (statusMatchesActiveThread ? agentStatus?.model : undefined),
    contextUsage: statusMatchesActiveThread
      ? hasExplicitContextUsage
        ? agentStatus?.contextUsage || undefined
        : activeThreadSummary?.contextUsage
      : activeThreadSummary?.contextUsage,
  };
}
