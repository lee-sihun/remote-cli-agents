import { create } from 'zustand';
import type {
  AgentType,
  AgentInfo,
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

  // Approvals
  pendingApprovals: (ToolCall & { threadId: string; agentType: AgentType })[];

  // File explorer
  fileEntries: Map<string, FileEntry[]>;
  fileContent: Map<string, string>;

  // Git
  gitResults: Map<string, unknown>;

  // Actions
  setConnectionStatus: (status: 'disconnected' | 'connecting' | 'connected') => void;
  setActiveAgent: (agent: AgentType | null) => void;
  setActiveThread: (threadId: string | null) => void;
  processServerMessage: (msg: ServerMessage) => void;
  addUserMessage: (threadId: string, content: string) => void;
  clearMessages: (threadId: string) => void;
}

let messageIdCounter = 0;
function genId(): string {
  return `local-${Date.now()}-${++messageIdCounter}`;
}

export const useAgentStore = create<AgentState>((set, get) => ({
  connectionStatus: 'disconnected',

  agents: [],
  agentStatuses: new Map(),
  activeAgent: null,

  threads: new Map(),
  activeThread: null,

  messages: new Map(),
  streamingContent: new Map(),

  pendingApprovals: [],

  fileEntries: new Map(),
  fileContent: new Map(),

  gitResults: new Map(),

  setConnectionStatus: (status) => set({ connectionStatus: status }),

  setActiveAgent: (agent) => set({ activeAgent: agent }),

  setActiveThread: (threadId) => set({ activeThread: threadId }),

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

      case 'agent_event': {
        const event = msg.event;

        switch (event.type) {
          case 'message_start': {
            // A new assistant message is starting. Clear streaming buffer.
            const sc = new Map(state.streamingContent);
            sc.set(event.threadId, '');
            set({ streamingContent: sc });
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
            // Finalize: add the complete message, clear streaming
            const messages = new Map(state.messages);
            const existing = messages.get(event.threadId) || [];
            messages.set(event.threadId, [...existing, event.message]);

            const sc = new Map(state.streamingContent);
            sc.delete(event.threadId);

            // Update thread summary
            const threads = new Map(state.threads);
            const agentThreads = threads.get(event.agentType) || [];
            const threadIdx = agentThreads.findIndex(
              (t) => t.id === event.threadId,
            );
            if (threadIdx >= 0) {
              const updated = [...agentThreads];
              updated[threadIdx] = {
                ...updated[threadIdx],
                lastMessage:
                  event.message.content.slice(0, 100) || undefined,
                messageCount: (messages.get(event.threadId) || []).length,
                updatedAt: Date.now(),
              };
              threads.set(event.agentType, updated);
            } else {
              // New thread
              agentThreads.push({
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

            set({ messages, streamingContent: sc, threads });
            break;
          }

          case 'tool_start': {
            // Update last assistant message with tool call info
            const messages = new Map(state.messages);
            const threadMsgs = messages.get(event.threadId) || [];
            const lastAssistant = [...threadMsgs]
              .reverse()
              .find((m) => m.role === 'assistant');
            if (lastAssistant) {
              const tools = lastAssistant.toolCalls
                ? [...lastAssistant.toolCalls]
                : [];
              const existingIdx = tools.findIndex(
                (t) => t.id === event.tool.id,
              );
              if (existingIdx >= 0) {
                tools[existingIdx] = event.tool;
              } else {
                tools.push(event.tool);
              }
              const updated = threadMsgs.map((m) =>
                m.id === lastAssistant.id
                  ? { ...m, toolCalls: tools }
                  : m,
              );
              messages.set(event.threadId, updated);
              set({ messages });
            }
            break;
          }

          case 'tool_complete': {
            const messages = new Map(state.messages);
            const threadMsgs = messages.get(event.threadId) || [];
            // Find message with this tool call and update it
            const updated = threadMsgs.map((m) => {
              if (!m.toolCalls) return m;
              const toolIdx = m.toolCalls.findIndex(
                (t) => t.id === event.tool.id,
              );
              if (toolIdx < 0) return m;
              const tools = [...m.toolCalls];
              tools[toolIdx] = event.tool;
              return { ...m, toolCalls: tools };
            });
            messages.set(event.threadId, updated);

            // Remove from pending approvals if it was there
            const pendingApprovals = state.pendingApprovals.filter(
              (a) => a.id !== event.tool.id,
            );

            set({ messages, pendingApprovals });
            break;
          }

          case 'approval_required': {
            const pendingApprovals = [
              ...state.pendingApprovals,
              {
                ...event.tool,
                threadId: event.threadId,
                agentType: event.agentType,
              },
            ];
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

            // If a thread became active, set it
            const updates: Partial<AgentState> = { agentStatuses: statuses };
            if (
              event.status.activeThread &&
              event.agentType === state.activeAgent
            ) {
              updates.activeThread = event.status.activeThread;
            }

            set(updates);
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
