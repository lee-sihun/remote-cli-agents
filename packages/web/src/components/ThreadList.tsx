import React, { useMemo, useState } from 'react';
import {
  Check,
  MessageSquare,
  Plus,
  Clock,
  Bot,
  Pencil,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { AgentType, ThreadSummary } from '../lib/protocol';

interface ThreadListProps {
  threads: Map<AgentType, ThreadSummary[]>;
  activeAgent: AgentType | null;
  activeThread: string | null;
  runningThreadIds: Set<string>;
  onSelectThread: (threadId: string) => void;
  onRenameThread: (agentType: AgentType, threadId: string, title: string) => void;
  onDeleteThread: (agentType: AgentType, threadId: string) => void;
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
    default:
      return type;
  }
}

export default function ThreadList({
  threads,
  activeAgent,
  activeThread,
  runningThreadIds,
  onSelectThread,
  onRenameThread,
  onDeleteThread,
  onNewChat,
}: ThreadListProps) {
  const [query, setQuery] = useState('');
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  const displayThreads = useMemo(() => {
    const items: (ThreadSummary & { agentType: AgentType })[] = [];

    if (activeAgent) {
      const agentThreads = threads.get(activeAgent) || [];
      for (const thread of agentThreads) {
        items.push({ ...thread, agentType: activeAgent });
      }
    } else {
      for (const [agentType, agentThreads] of threads) {
        for (const thread of agentThreads) {
          items.push({ ...thread, agentType });
        }
      }
    }

    const normalizedQuery = query.trim().toLowerCase();
    const filtered = normalizedQuery
      ? items.filter((thread) => thread.title.toLowerCase().includes(normalizedQuery))
      : items;

    filtered.sort((a, b) => b.updatedAt - a.updatedAt);
    return filtered;
  }, [activeAgent, query, threads]);

  const hasAnyThreads = useMemo(() => {
    for (const agentThreads of threads.values()) {
      if (agentThreads.length > 0) {
        return true;
      }
    }
    return false;
  }, [threads]);

  const submitRename = (agentType: AgentType, threadId: string) => {
    const trimmed = draftTitle.trim();
    if (!trimmed) {
      return;
    }

    onRenameThread(agentType, threadId, trimmed);
    setEditingThreadId(null);
    setDraftTitle('');
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-(--border)">
        <label className="relative block">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-(--text-muted)"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by title"
            className="w-full rounded-lg border border-(--border) bg-(--bg-primary) py-2 pl-9 pr-3 text-sm text-(--text-primary) outline-none transition-colors focus:border-(--accent)"
          />
        </label>
      </div>

      <div className="scroll-hover-area flex-1 overflow-y-auto">
        {!hasAnyThreads ? (
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
        ) : displayThreads.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-4 text-center">
            <Search
              size={28}
              className="text-(--text-muted) mb-3"
            />
            <p className="text-sm text-(--text-muted)">
              No matching sessions
            </p>
            <p className="text-xs text-(--text-muted) mt-1">
              Try a different title keyword
            </p>
          </div>
        ) : (
          <div className="p-2 space-y-0.5">
            {displayThreads.map((thread) => (
              <div
                key={thread.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectThread(thread.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectThread(thread.id);
                  }
                }}
                className={`w-full cursor-default text-left p-3 rounded-lg transition-colors ${
                  thread.id === activeThread
                    ? 'bg-(--bg-tertiary)'
                    : 'hover:bg-(--bg-tertiary)/50'
                }`}
              >
                <div className="flex items-start gap-2">
                  <div
                    className="flex flex-1 items-start gap-2 min-w-0 text-left"
                  >
                    <span
                      className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${
                        runningThreadIds.has(thread.id)
                          ? 'bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.65)]'
                          : 'bg-(--border)'
                      }`}
                    />
                    <div className="flex-1 min-w-0 cursor-default">
                      {editingThreadId === thread.id ? (
                        <div
                          className="flex items-center gap-1"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <input
                            value={draftTitle}
                            onChange={(event) => setDraftTitle(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                submitRename(thread.agentType, thread.id);
                              }
                              if (event.key === 'Escape') {
                                setEditingThreadId(null);
                                setDraftTitle('');
                              }
                            }}
                            className="flex-1 rounded-md border border-(--accent) bg-(--bg-primary) px-2 py-1 text-sm outline-none"
                            autoFocus
                          />
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              submitRename(thread.agentType, thread.id);
                            }}
                            className="rounded-md p-1 text-(--text-muted) hover:bg-(--bg-hover) hover:text-(--text-primary)"
                            title="Save title"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setEditingThreadId(null);
                              setDraftTitle('');
                            }}
                            className="rounded-md p-1 text-(--text-muted) hover:bg-(--bg-hover) hover:text-(--text-primary)"
                            title="Cancel rename"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 mb-0.5">
                          {!activeAgent && (
                            <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-(--bg-hover) text-(--text-muted)">
                              <Bot size={10} />
                              {agentLabel(thread.agentType)}
                            </span>
                          )}
                          <span className="flex-1 cursor-default truncate text-sm font-medium">
                            {thread.title}
                          </span>
                        </div>
                      )}
                      {thread.lastMessage && editingThreadId !== thread.id && (
                        <p className="cursor-default truncate text-xs text-(--text-muted)">
                          {thread.lastMessage}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <div className="flex items-center gap-1 text-xs text-(--text-muted)">
                      <Clock size={10} />
                      {formatTime(thread.updatedAt)}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setEditingThreadId(thread.id);
                          setDraftTitle(thread.title);
                        }}
                        className="rounded-md p-1 text-(--text-muted) hover:bg-(--bg-hover) hover:text-(--text-primary)"
                        title="Rename session"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteThread(thread.agentType, thread.id);
                        }}
                        className="rounded-md p-1 text-(--text-muted) hover:bg-(--bg-hover) hover:text-(--error)"
                        title="Delete session"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
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
