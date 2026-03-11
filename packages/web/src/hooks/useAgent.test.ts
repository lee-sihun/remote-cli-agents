import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentStatus, ToolCall } from '../lib/protocol';

interface LocalStorageMock {
  clear: () => void;
  getItem: (key: string) => string | null;
  key: (index: number) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
  readonly length: number;
}

const createLocalStorageMock = (): LocalStorageMock => {
  const storage = new Map<string, string>();

  return {
    clear: () => storage.clear(),
    getItem: (key) => storage.get(key) ?? null,
    key: (index) => Array.from(storage.keys())[index] ?? null,
    removeItem: (key) => {
      storage.delete(key);
    },
    setItem: (key, value) => {
      storage.set(key, value);
    },
    get length() {
      return storage.size;
    },
  };
};

const baseStatus: AgentStatus = {
  agent: 'claude',
  state: 'idle',
};

const baseToolCall: ToolCall = {
  id: 'tool-1',
  name: 'edit_file',
  input: { path: 'src/App.tsx' },
  status: 'running',
};

describe('useAgentStore', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createLocalStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('clears stale streaming state when thread_state has no streaming payload', async () => {
    const { useAgentStore } = await import('./useAgent.ts');

    useAgentStore.setState({
      streamingContent: new Map([['thread-1', 'partial response']]),
      activeToolCalls: new Map([['thread-1', [baseToolCall]]]),
    });

    useAgentStore.getState().processServerMessage({
      type: 'thread_state',
      threadId: 'thread-1',
      messages: [],
      agentStatus: baseStatus,
    });

    expect(useAgentStore.getState().streamingContent.has('thread-1')).toBe(false);
    expect(useAgentStore.getState().activeToolCalls.has('thread-1')).toBe(false);
  });

  it('deduplicates tool calls and upserts completed assistant messages', async () => {
    const { useAgentStore } = await import('./useAgent.ts');

    useAgentStore.setState({
      messages: new Map([[
        'thread-1',
        [{
          id: 'assistant-1',
          role: 'assistant',
          content: 'stale',
          timestamp: 1,
        }],
      ]]),
      activeToolCalls: new Map([['thread-1', [baseToolCall]]]),
      threads: new Map([[
        'claude',
        [{
          id: 'thread-1',
          agentType: 'claude',
          title: 'Thread',
          messageCount: 1,
          createdAt: 1,
          updatedAt: 1,
        }],
      ]]),
    });

    useAgentStore.getState().processServerMessage({
      type: 'agent_event',
      event: {
        type: 'message_complete',
        threadId: 'thread-1',
        agentType: 'claude',
        message: {
          id: 'assistant-1',
          role: 'assistant',
          content: 'final',
          timestamp: 2,
          toolCalls: [{
            ...baseToolCall,
            status: 'completed',
            output: 'done',
          }],
        },
      },
    });

    const messages = useAgentStore.getState().messages.get('thread-1') || [];

    expect(messages).toHaveLength(1);
    expect(messages[0]?.content).toBe('final');
    expect(messages[0]?.toolCalls).toEqual([{
      ...baseToolCall,
      status: 'completed',
      output: 'done',
    }]);
  });

  it('deduplicates repeated approval requests by toolCall id', async () => {
    const { useAgentStore } = await import('./useAgent.ts');

    const approvalEvent = {
      type: 'agent_event' as const,
      event: {
        type: 'approval_required' as const,
        threadId: 'thread-1',
        agentType: 'claude' as const,
        tool: {
          ...baseToolCall,
          status: 'requires_approval' as const,
        },
      },
    };

    useAgentStore.getState().processServerMessage(approvalEvent);
    useAgentStore.getState().processServerMessage(approvalEvent);

    expect(useAgentStore.getState().pendingApprovals).toHaveLength(1);
    expect(useAgentStore.getState().pendingApprovals[0]?.id).toBe('tool-1');
  });
});
