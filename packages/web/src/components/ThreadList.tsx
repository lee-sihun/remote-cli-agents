import React from 'react';
import {
  MessageSquare,
  Plus,
  Clock,
  Bot,
} from 'lucide-react';
import type { AgentType, ThreadSummary } from '../lib/protocol';

interface ThreadListProps {
  threads: Map<AgentType, ThreadSummary[]>;
  activeAgent: AgentType | null;
  activeThread: string | null;
  onSelectThread: (threadId: string) => void;
  onNewChat: () => void;
}

function formatTime(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function agentLabel(type: AgentType): string {
  switch (type) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'pty':
      return 'Terminal';
    default:
      return type;
  }
}

export default function ThreadList({
  threads,
  activeAgent,
  activeThread,
  onSelectThread,
  onNewChat,
}: ThreadListProps) {
  // Get threads for active agent, or all if no agent selected
  const displayThreads: (ThreadSummary & { agentType: AgentType })[] = [];

  if (activeAgent) {
    const agentThreads = threads.get(activeAgent) || [];
    for (const t of agentThreads) {
      displayThreads.push({ ...t, agentType: activeAgent });
    }
  } else {
    for (const [agentType, agentThreads] of threads) {
      for (const t of agentThreads) {
        displayThreads.push({ ...t, agentType });
      }
    }
  }

  // Sort by updatedAt desc
  displayThreads.sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="flex flex-col h-full">
      {/* Thread list */}
      <div className="flex-1 overflow-y-auto">
        {displayThreads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-4 text-center">
            <MessageSquare
              size={32}
              className="text-(--text-muted) mb-3"
            />
            <p className="text-sm text-(--text-muted)">
              No conversations yet
            </p>
            <p className="text-xs text-(--text-muted) mt-1">
              Start a new chat to begin
            </p>
          </div>
        ) : (
          <div className="p-2 space-y-0.5">
            {displayThreads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => onSelectThread(thread.id)}
                className={`w-full text-left p-3 rounded-lg transition-colors ${
                  thread.id === activeThread
                    ? 'bg-(--bg-tertiary)'
                    : 'hover:bg-(--bg-tertiary)/50'
                }`}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      {!activeAgent && (
                        <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-(--bg-hover) text-(--text-muted)">
                          <Bot size={10} />
                          {agentLabel(thread.agentType)}
                        </span>
                      )}
                      <span className="text-sm font-medium truncate flex-1">
                        {thread.title}
                      </span>
                    </div>
                    {thread.lastMessage && (
                      <p className="text-xs text-(--text-muted) truncate">
                        {thread.lastMessage}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-(--text-muted) shrink-0">
                    <Clock size={10} />
                    {formatTime(thread.updatedAt)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* New chat button */}
      <div className="p-3 border-t border-(--border)">
        <button
          onClick={onNewChat}
          className="flex items-center justify-center gap-2 w-full py-2.5 rounded-lg bg-(--accent) text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <Plus size={16} />
          New Chat
        </button>
      </div>
    </div>
  );
}
