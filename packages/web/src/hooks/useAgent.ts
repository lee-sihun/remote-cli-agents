import { create } from 'zustand';
import type {
  AgentType,
  AgentInfo,
  AgentConfig,
  AgentMessage,
  AgentStatus,
  ThreadSummary,
  ToolCall,
  ServerMessage,
  FileEntry,
} from '../lib/protocol';

interface AgentState {
  // Connection
  connectionStatus: 'disconnected' | 'connecting' | 'connected';

  // Agents
  agents: AgentInfo[];
  agentStatuses: Map<AgentType, AgentStatus>;
  activeAgent: AgentType | null;

  // Threads
  threads: Map<AgentType, ThreadSummary[]>;
  activeThread: string | null;

  // Messages
  messages: Map<string, AgentMessage[]>;
  streamingContent: Map<string, string>; // threadId -> partial content being streamed
  activeToolCalls: Map<string, ToolCall[]>; // threadId -> 스트리밍 중 tool calls

  // Approvals
  pendingApprovals: (ToolCall & { threadId: string; agentType: AgentType })[];

  // File explorer
  fileEntries: Map<string, FileEntry[]>;
  fileContent: Map<string, string>;

  // Git
  gitResults: Map<string, unknown>;

  // 에이전트 설정
  agentSettings: Map<AgentType, Record<string, string>>;
  lastUsedAgentSettings: Map<AgentType, Record<string, string>>;

  // Actions
  setConnectionStatus: (status: 'disconnected' | 'connecting' | 'connected') => void;
  setActiveAgent: (agent: AgentType | null) => void;
  setActiveThread: (threadId: string | null) => void;
  setAgentSettings: (agent: AgentType, settings: Record<string, string>) => void;
  setLastUsedAgentSettings: (agent: AgentType, settings: Record<string, string>) => void;
  renameThread: (agentType: AgentType, threadId: string, title: string) => void;
  deleteThread: (agentType: AgentType, threadId: string) => void;
  upsertThreadFromUserMessage: (
    agentType: AgentType,
    threadId: string,
    content: string,
    config?: AgentConfig,
  ) => void;
  processServerMessage: (msg: ServerMessage) => void;
  addUserMessage: (threadId: string, content: string) => void;
  clearMessages: (threadId: string) => void;
}

let messageIdCounter = 0;
function genId(): string {
  return `local-${Date.now()}-${++messageIdCounter}`;
}

// localStorage 헬퍼
function loadSaved<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function saveTo(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function loadSavedAgentSettings(key: string): Map<AgentType, Record<string, string>> {
  const saved = loadSaved<Partial<Record<AgentType, Record<string, string>>>>(key, {});
  return new Map(Object.entries(saved) as Array<[AgentType, Record<string, string>]>);
}

function saveAgentSettings(key: string, map: Map<AgentType, Record<string, string>>): void {
  saveTo(key, Object.fromEntries(map));
}

function summarizeThreadContent(content: string, maxLength: number): string {
  return content.trim().slice(0, maxLength) || 'New conversation';
}

function reconcileActiveToolCalls(
  activeToolCalls: Map<string, ToolCall[]>,
  threadId: string,
  message: AgentMessage,
): Map<string, ToolCall[]> {
  if (!message.toolCalls || message.toolCalls.length === 0) {
    return activeToolCalls;
  }

  const next = new Map(activeToolCalls);
  const existing = next.get(threadId) || [];
  if (existing.length === 0) {
    return next;
  }

  const updates = new Map(message.toolCalls.map((tool) => [tool.id, tool]));
  const remaining = existing
    .map((tool) => updates.get(tool.id) || tool)
    .filter((tool) => tool.status === 'pending' || tool.status === 'running' || tool.status === 'requires_approval');

  if (remaining.length > 0) {
    next.set(threadId, remaining);
  } else {
    next.delete(threadId);
  }

  return next;
}

function reconcilePendingApprovals(
  pendingApprovals: (ToolCall & { threadId: string; agentType: AgentType })[],
  threadId: string,
  message: AgentMessage,
): (ToolCall & { threadId: string; agentType: AgentType })[] {
  const resolvedToolIds = new Set(
    (message.toolCalls || [])
      .filter((tool) => tool.status !== 'requires_approval')
      .map((tool) => tool.id),
  );

  if (resolvedToolIds.size === 0) {
    return pendingApprovals;
  }

  return pendingApprovals.filter(
    (approval) => approval.threadId !== threadId || !resolvedToolIds.has(approval.id),
  );
}

export const useAgentStore = create<AgentState>((set, get) => ({
  connectionStatus: 'disconnected',

  agents: [],
  agentStatuses: new Map(),
  activeAgent: loadSaved<AgentType | null>('rca_active_agent', null),

  threads: new Map(),
  activeThread: loadSaved<string | null>('rca_active_thread', null),

  messages: new Map(),
  streamingContent: new Map(),
  activeToolCalls: new Map(),

  pendingApprovals: [],

  fileEntries: new Map(),
  fileContent: new Map(),

  gitResults: new Map(),

  agentSettings: loadSavedAgentSettings('rca_agent_settings'),
  lastUsedAgentSettings: loadSavedAgentSettings('rca_last_used_agent_settings'),

  setConnectionStatus: (status) => set({ connectionStatus: status }),

  setActiveAgent: (agent) => {
    saveTo('rca_active_agent', agent);
    set({ activeAgent: agent });
  },

  setActiveThread: (threadId) => {
    saveTo('rca_active_thread', threadId);
    set({ activeThread: threadId });
  },

  setAgentSettings: (agent, settings) => {
    const map = new Map(get().agentSettings);
    map.set(agent, settings);
    saveAgentSettings('rca_agent_settings', map);
    set({ agentSettings: map });
  },

  setLastUsedAgentSettings: (agent, settings) => {
    const map = new Map(get().lastUsedAgentSettings);
    map.set(agent, settings);
    saveAgentSettings('rca_last_used_agent_settings', map);
    set({ lastUsedAgentSettings: map });
  },

  renameThread: (agentType, threadId, title) => {
    const trimmed = title.trim();
    if (!trimmed) {
      return;
    }

    const threads = new Map(get().threads);
    const agentThreads = [...(threads.get(agentType) || [])];
    const threadIndex = agentThreads.findIndex((thread) => thread.id === threadId);
    if (threadIndex < 0) {
      return;
    }

    agentThreads[threadIndex] = {
      ...agentThreads[threadIndex],
      title: trimmed,
    };
    threads.set(agentType, agentThreads);
    set({ threads });
  },

  deleteThread: (agentType, threadId) => {
    const state = get();
    const threads = new Map(state.threads);
    threads.set(
      agentType,
      (threads.get(agentType) || []).filter((thread) => thread.id !== threadId),
    );

    const messages = new Map(state.messages);
    messages.delete(threadId);

    const streamingContent = new Map(state.streamingContent);
    streamingContent.delete(threadId);

    const activeToolCalls = new Map(state.activeToolCalls);
    activeToolCalls.delete(threadId);

    const pendingApprovals = state.pendingApprovals.filter(
      (approval) => approval.threadId !== threadId,
    );

    const updates: Partial<AgentState> = {
      threads,
      messages,
      streamingContent,
      activeToolCalls,
      pendingApprovals,
    };

    if (state.activeThread === threadId) {
      saveTo('rca_active_thread', null);
      updates.activeThread = null;
    }

    set(updates);
  },

  upsertThreadFromUserMessage: (agentType, threadId, content, config) => {
    const state = get();
    const now = Date.now();
    const threads = new Map(state.threads);
    const agentThreads = [...(threads.get(agentType) || [])];
    const existingMessages = state.messages.get(threadId) || [];
    const threadIndex = agentThreads.findIndex((thread) => thread.id === threadId);
    const title = summarizeThreadContent(content, 50);
    const lastMessage = summarizeThreadContent(content, 100);

    if (threadIndex >= 0) {
      const existing = agentThreads[threadIndex];
      agentThreads[threadIndex] = {
        ...existing,
        title: existing.title || title,
        lastMessage,
        messageCount: existingMessages.length + 1,
        updatedAt: now,
        config: config || existing.config,
      };
    } else {
      agentThreads.unshift({
        id: threadId,
        agentType,
        title,
        lastMessage,
        messageCount: existingMessages.length + 1,
        createdAt: now,
        updatedAt: now,
        config,
      });
    }

    threads.set(agentType, agentThreads);
    set({ threads });
  },

  addUserMessage: (threadId, content) => {
    const msgs = new Map(get().messages);
    const existing = msgs.get(threadId) || [];
    const userMsg: AgentMessage = {
      id: genId(),
      role: 'user',
      content,
      timestamp: Date.now(),
    };
    msgs.set(threadId, [...existing, userMsg]);
    set({ messages: msgs });
  },

  clearMessages: (threadId) => {
    const msgs = new Map(get().messages);
    msgs.delete(threadId);
    set({ messages: msgs });
  },

  processServerMessage: (msg) => {
    const state = get();

    switch (msg.type) {
      case 'agents_list': {
        set({ agents: msg.agents });
        // Auto-select first available agent if none selected
        if (!state.activeAgent && msg.agents.length > 0) {
          const available = msg.agents.find((a) => a.available);
          if (available) {
            // setActiveAgent로 localStorage에도 저장
            saveTo('rca_active_agent', available.type);
            set({ activeAgent: available.type });
          }
        }
        break;
      }

      case 'threads_list': {
        const threads = new Map(state.threads);
        threads.set(msg.agentType, msg.threads);
        set({ threads });
        break;
      }

      case 'thread_messages': {
        const messages = new Map(state.messages);
        messages.set(msg.threadId, msg.messages);
        set({ messages });
        break;
      }

      case 'thread_state': {
        // 메시지 복원
        const messages = new Map(state.messages);
        messages.set(msg.threadId, msg.messages);
        const updates: Partial<AgentState> = { messages };

        // 스트리밍 상태 복원
        const sc = new Map(state.streamingContent);
        const atc = new Map(state.activeToolCalls);
        if (msg.streaming) {
          sc.set(msg.threadId, msg.streaming.content);

          if (msg.streaming.toolCalls.length > 0) {
            atc.set(msg.threadId, msg.streaming.toolCalls);
          } else {
            atc.delete(msg.threadId);
          }
        } else {
          sc.delete(msg.threadId);
          atc.delete(msg.threadId);
        }
        updates.streamingContent = sc;
        updates.activeToolCalls = atc;

        // 에이전트 상태 복원
        if (msg.agentStatus) {
          const statuses = new Map(state.agentStatuses);
          statuses.set(msg.agentStatus.agent, msg.agentStatus);
          updates.agentStatuses = statuses;
        }

        set(updates);
        break;
      }

      case 'agent_event': {
        const event = msg.event;

        switch (event.type) {
          case 'message_start': {
            // 새 assistant 메시지 시작. 스트리밍 버퍼 및 tool calls 초기화.
            const sc = new Map(state.streamingContent);
            sc.set(event.threadId, '');
            const atc = new Map(state.activeToolCalls);
            atc.delete(event.threadId);
            const pendingApprovals = state.pendingApprovals.filter(
              (approval) => approval.threadId !== event.threadId,
            );
            set({ streamingContent: sc, activeToolCalls: atc, pendingApprovals });
            break;
          }

          case 'message_delta': {
            // Append streaming content
            const sc = new Map(state.streamingContent);
            const current = sc.get(event.threadId) || '';
            sc.set(event.threadId, current + event.content);
            set({ streamingContent: sc });
            break;
          }

          case 'message_complete': {
            const messages = new Map(state.messages);
            const existing = messages.get(event.threadId) || [];
            const existingIndex = existing.findIndex((message) => message.id === event.message.id);
            if (existingIndex >= 0) {
              const updated = [...existing];
              updated[existingIndex] = event.message;
              messages.set(event.threadId, updated);
            } else {
              messages.set(event.threadId, [...existing, event.message]);
            }

            const sc = new Map(state.streamingContent);
            sc.delete(event.threadId);

            // Update thread summary
            const threads = new Map(state.threads);
            const agentThreads = [...(threads.get(event.agentType) || [])];
            const threadIdx = agentThreads.findIndex(
              (t) => t.id === event.threadId,
            );
            if (threadIdx >= 0) {
              const updated = [...agentThreads];
              updated[threadIdx] = {
                ...updated[threadIdx],
                lastMessage:
                  event.message.content.slice(0, 100)
                  || updated[threadIdx].lastMessage,
                messageCount: (messages.get(event.threadId) || []).length,
                updatedAt: Date.now(),
              };
              threads.set(event.agentType, updated);
            } else {
              // New thread
              agentThreads.unshift({
                id: event.threadId,
                agentType: event.agentType,
                title:
                  event.message.content.slice(0, 50) || 'New conversation',
                lastMessage: event.message.content.slice(0, 100) || undefined,
                messageCount: (messages.get(event.threadId) || []).length,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
              threads.set(event.agentType, agentThreads);
            }

            const atc = reconcileActiveToolCalls(
              state.activeToolCalls,
              event.threadId,
              event.message,
            );

            const pendingApprovals = reconcilePendingApprovals(
              state.pendingApprovals,
              event.threadId,
              event.message,
            );

            set({
              messages,
              streamingContent: sc,
              threads,
              activeToolCalls: atc,
              pendingApprovals,
            });
            break;
          }

          case 'tool_start': {
            const atc = new Map(state.activeToolCalls);
            const existing = atc.get(event.threadId) || [];
            const nextTools = [...existing];
            const toolIndex = nextTools.findIndex((tool) => tool.id === event.tool.id);
            if (toolIndex >= 0) {
              nextTools[toolIndex] = event.tool;
            } else {
              nextTools.push(event.tool);
            }
            atc.set(event.threadId, nextTools);
            set({ activeToolCalls: atc });
            break;
          }

          case 'tool_complete': {
            // activeToolCalls에서 업데이트
            const atc = new Map(state.activeToolCalls);
            const tools = atc.get(event.threadId) || [];
            const updatedTools = tools.map((t) =>
              t.id === event.tool.id ? event.tool : t,
            );
            atc.set(event.threadId, updatedTools);

            // Remove from pending approvals
            const pendingApprovals = state.pendingApprovals.filter(
              (a) => a.id !== event.tool.id,
            );

            set({ activeToolCalls: atc, pendingApprovals });
            break;
          }

          case 'approval_required': {
            const nextApproval = {
              ...event.tool,
              threadId: event.threadId,
              agentType: event.agentType,
            };
            const pendingApprovals = state.pendingApprovals.filter(
              (approval) => approval.id !== nextApproval.id,
            );
            pendingApprovals.push(nextApproval);
            set({ pendingApprovals });
            break;
          }

          case 'error': {
            // Add error as system message
            const messages = new Map(state.messages);
            const existing = messages.get(event.threadId) || [];
            messages.set(event.threadId, [
              ...existing,
              {
                id: genId(),
                role: 'system',
                content: `Error: ${event.error}`,
                timestamp: Date.now(),
              },
            ]);
            set({ messages });
            break;
          }

          case 'status_change': {
            const statuses = new Map(state.agentStatuses);
            statuses.set(event.agentType, event.status);
            set({ agentStatuses: statuses });
            break;
          }

          case 'pty_output': {
            // PTY output is handled directly in TerminalView via onMessage
            break;
          }
        }
        break;
      }

      case 'connection_status': {
        const newStatus = msg.status === 'reconnecting' ? 'connecting' : msg.status;
        const updates: Partial<AgentState> = { connectionStatus: newStatus };

        // 재연결 시 이전 에이전트 상태 초기화 (서버가 fresh 상태)
        if (newStatus === 'connected') {
          updates.agentStatuses = new Map();
          updates.streamingContent = new Map();
          updates.activeToolCalls = new Map();
          updates.pendingApprovals = [];
        }

        set(updates);
        break;
      }

      case 'file_list_result': {
        const entries = new Map(state.fileEntries);
        entries.set(msg.path, msg.entries);
        set({ fileEntries: entries });
        break;
      }

      case 'file_read_result': {
        const content = new Map(state.fileContent);
        content.set(msg.path, msg.content);
        set({ fileContent: content });
        break;
      }

      case 'git_result': {
        const results = new Map(state.gitResults);
        results.set(msg.action, msg.result);
        set({ gitResults: results });
        break;
      }

      case 'error': {
        console.error('[RCA] Server error:', msg.message);
        break;
      }

      case 'pong':
        break;
    }
  },
}));
