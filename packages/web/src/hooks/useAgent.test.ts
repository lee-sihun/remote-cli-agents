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

  it('adds a new thread summary immediately when the first user message is sent', async () => {
    const { useAgentStore } = await import('./useAgent.ts');

    useAgentStore.getState().upsertThreadFromUserMessage(
      'claude',
      'thread-1',
      'Investigate sidebar refresh issue',
      {
        type: 'claude',
        model: 'sonnet',
        permissionMode: 'plan',
      },
    );
    useAgentStore.getState().addUserMessage(
      'thread-1',
      'Investigate sidebar refresh issue',
    );

    const threads = useAgentStore.getState().threads.get('claude') || [];

    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: 'thread-1',
      agentType: 'claude',
      title: 'Investigate sidebar refresh issue',
      lastMessage: 'Investigate sidebar refresh issue',
      messageCount: 1,
      config: {
        type: 'claude',
        model: 'sonnet',
        permissionMode: 'plan',
      },
    });
  });

  it('persists current settings and last-used defaults separately', async () => {
    const { useAgentStore } = await import('./useAgent.ts');

    useAgentStore.getState().setAgentSettings('claude', {
      model: 'opus',
      permissionMode: 'acceptEdits',
    });
    useAgentStore.getState().setLastUsedAgentSettings('claude', {
      model: 'sonnet',
      permissionMode: 'plan',
    });

    expect(JSON.parse(localStorage.getItem('rca_agent_settings') || '{}')).toEqual({
      claude: {
        model: 'opus',
        permissionMode: 'acceptEdits',
      },
    });
    expect(JSON.parse(localStorage.getItem('rca_last_used_agent_settings') || '{}')).toEqual({
      claude: {
        model: 'sonnet',
        permissionMode: 'plan',
      },
    });
  });

  it('renames an existing thread in place', async () => {
    const { useAgentStore } = await import('./useAgent.ts');

    useAgentStore.setState({
      threads: new Map([[
        'claude',
        [{
          id: 'thread-1',
          agentType: 'claude',
          title: 'Old title',
          messageCount: 1,
          createdAt: 1,
          updatedAt: 2,
        }],
      ]]),
    });

    useAgentStore.getState().renameThread('claude', 'thread-1', 'Renamed title');

    expect(useAgentStore.getState().threads.get('claude')?.[0]?.title).toBe('Renamed title');
  });

  it('deletes thread state and clears active thread when removing the selected session', async () => {
    const { useAgentStore } = await import('./useAgent.ts');

    useAgentStore.setState({
      activeThread: 'thread-1',
      threads: new Map([[
        'claude',
        [{
          id: 'thread-1',
          agentType: 'claude',
          title: 'Delete me',
          messageCount: 1,
          createdAt: 1,
          updatedAt: 2,
        }],
      ]]),
      messages: new Map([['thread-1', [{
        id: 'message-1',
        role: 'assistant',
        content: 'hello',
        timestamp: 1,
      }]]]),
      streamingContent: new Map([['thread-1', 'partial']]),
      activeToolCalls: new Map([['thread-1', [baseToolCall]]]),
      pendingApprovals: [{
        ...baseToolCall,
        status: 'requires_approval',
        threadId: 'thread-1',
        agentType: 'claude',
      }],
    });

    useAgentStore.getState().deleteThread('claude', 'thread-1');

    expect(useAgentStore.getState().activeThread).toBeNull();
    expect(useAgentStore.getState().threads.get('claude')).toEqual([]);
    expect(useAgentStore.getState().messages.has('thread-1')).toBe(false);
    expect(useAgentStore.getState().streamingContent.has('thread-1')).toBe(false);
    expect(useAgentStore.getState().activeToolCalls.has('thread-1')).toBe(false);
    expect(useAgentStore.getState().pendingApprovals).toEqual([]);
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

  it('does not merge unrelated active tool calls into completed assistant messages', async () => {
    const { useAgentStore } = await import('./useAgent.ts');

    useAgentStore.setState({
      activeToolCalls: new Map([['thread-1', [baseToolCall]]]),
    });

    useAgentStore.getState().processServerMessage({
      type: 'agent_event',
      event: {
        type: 'message_complete',
        threadId: 'thread-1',
        agentType: 'claude',
        message: {
          id: 'assistant-2',
          role: 'assistant',
          content: 'checkpoint',
          timestamp: 3,
        },
      },
    });

    const messages = useAgentStore.getState().messages.get('thread-1') || [];

    expect(messages[0]?.content).toBe('checkpoint');
    expect(messages[0]?.toolCalls).toBeUndefined();
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

  it('keeps pending approvals when a text-only assistant message is completed', async () => {
    const { useAgentStore } = await import('./useAgent.ts');

    useAgentStore.setState({
      pendingApprovals: [{
        ...baseToolCall,
        status: 'requires_approval',
        threadId: 'thread-1',
        agentType: 'claude',
      }],
    });

    useAgentStore.getState().processServerMessage({
      type: 'agent_event',
      event: {
        type: 'message_complete',
        threadId: 'thread-1',
        agentType: 'claude',
        message: {
          id: 'assistant-keep-approval',
          role: 'assistant',
          content: 'waiting on approval',
          timestamp: 4,
        },
      },
    });

    expect(useAgentStore.getState().pendingApprovals).toHaveLength(1);
    expect(useAgentStore.getState().pendingApprovals[0]?.id).toBe('tool-1');
  });

  it('clears stale running state on reconnect without message_complete', async () => {
    const { useAgentStore } = await import('./useAgent.ts');

    useAgentStore.setState({
      streamingContent: new Map([['thread-1', 'partial response']]),
      activeToolCalls: new Map([['thread-1', [baseToolCall]]]),
      pendingApprovals: [{
        ...baseToolCall,
        status: 'requires_approval',
        threadId: 'thread-1',
        agentType: 'claude',
      }],
      agentStatuses: new Map([['claude', {
        agent: 'claude',
        state: 'running',
        activeThread: 'thread-1',
      }]]),
    });

    useAgentStore.getState().processServerMessage({
      type: 'connection_status',
      status: 'connected',
    });

    expect(useAgentStore.getState().streamingContent.size).toBe(0);
    expect(useAgentStore.getState().activeToolCalls.size).toBe(0);
    expect(useAgentStore.getState().pendingApprovals).toHaveLength(0);
    expect(useAgentStore.getState().agentStatuses.size).toBe(0);
  });

  it('keeps streaming content isolated by thread while another thread is active', async () => {
    const { useAgentStore } = await import('./useAgent.ts');

    useAgentStore.setState({
      activeThread: 'thread-2',
      streamingContent: new Map([['thread-2', 'existing stream']]),
    });

    useAgentStore.getState().processServerMessage({
      type: 'agent_event',
      event: {
        type: 'message_delta',
        threadId: 'thread-1',
        agentType: 'claude',
        content: 'background stream',
      },
    });

    expect(useAgentStore.getState().streamingContent.get('thread-1')).toBe('background stream');
    expect(useAgentStore.getState().streamingContent.get('thread-2')).toBe('existing stream');
    expect(useAgentStore.getState().activeThread).toBe('thread-2');
  });
});
