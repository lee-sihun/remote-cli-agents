import { WebSocket } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentConfig,
  AgentEvent,
  AgentStatus,
  AgentType,
  ClientMessage,
  ThreadSummary,
} from '@rca/shared';
import { handleClientMessage, parseClientMessagePayload, sendToClient } from './server.ts';

interface FakeAdapter {
  approve?: (threadId: string, toolCallId: string, approved: boolean) => void;
  getStatus: () => AgentStatus;
  getStreamingState?: (threadId: string) => { content: string; toolCalls: [] } | null;
  getThreads: () => Promise<ThreadSummary[]>;
  interrupt: (threadId: string) => void;
  isAvailable: () => Promise<boolean>;
  name: string;
  onEvent: (handler: (event: AgentEvent) => void) => void;
  readonly type: AgentType;
  sendMessage: (threadId: string, message: string) => void;
  start: (config: AgentConfig) => Promise<void>;
  stop: () => Promise<void>;
}

const storeMock = vi.hoisted(() => ({
  loadMessages: vi.fn(),
}));

vi.mock('./store.js', () => storeMock);

const createFakeWebSocket = () => ({
  readyState: WebSocket.OPEN,
  send: vi.fn(),
});

const createFakeAdapter = (overrides: Partial<FakeAdapter> = {}): FakeAdapter => ({
  getStatus: () => ({
    agent: 'claude',
    state: 'idle',
  }),
  getThreads: async () => [],
  interrupt: vi.fn(),
  isAvailable: async () => true,
  name: 'Claude Code',
  onEvent: vi.fn(),
  type: 'claude',
  sendMessage: vi.fn(),
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  ...overrides,
});

describe('server helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeMock.loadMessages.mockReturnValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects payloads larger than 1MB', () => {
    const raw = JSON.stringify({
      type: 'send_message',
      agentType: 'claude',
      threadId: 'thread-1',
      content: 'a'.repeat(1024 * 1024),
    });

    const result = parseClientMessagePayload(raw);

    expect(result).toEqual({
      ok: false,
      message: 'Message too large',
    });
  });

  it('rejects invalid JSON payloads', () => {
    const result = parseClientMessagePayload('{invalid-json');

    expect(result).toEqual({
      ok: false,
      message: 'Invalid JSON',
    });
  });

  it('parses valid client messages', () => {
    const result = parseClientMessagePayload(JSON.stringify({
      type: 'ping',
    }));

    expect(result).toEqual({
      ok: true,
      message: {
        type: 'ping',
      },
    });
  });

  it('returns all thread summaries for list_threads', async () => {
    const ws = createFakeWebSocket();
    const adapter = createFakeAdapter({
      getThreads: async () => [
        {
          id: 'thread-1',
          agentType: 'claude',
          title: 'First',
          messageCount: 1,
          createdAt: 1,
          updatedAt: 2,
        },
        {
          id: 'thread-2',
          agentType: 'claude',
          title: 'Second',
          messageCount: 2,
          createdAt: 3,
          updatedAt: 4,
        },
      ],
    });
    const adapters = new Map<AgentType, FakeAdapter>([['claude', adapter]]);

    await handleClientMessage(
      ws as unknown as WebSocket,
      { type: 'list_threads', agentType: 'claude' },
      adapters as never,
      'C:/workspace',
    );

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'threads_list',
      agentType: 'claude',
      threads: await adapter.getThreads(),
    }));
  });

  it('includes streaming state and agent status in get_thread_state responses', async () => {
    const ws = createFakeWebSocket();
    const adapter = createFakeAdapter({
      getStatus: () => ({
        agent: 'claude',
        state: 'running',
        activeThread: 'thread-1',
      }),
      getStreamingState: () => ({
        content: 'partial',
        toolCalls: [],
      }),
    });
    const adapters = new Map<AgentType, FakeAdapter>([['claude', adapter]]);
    storeMock.loadMessages.mockReturnValue([{
      id: 'message-1',
      role: 'assistant',
      content: 'saved',
      timestamp: 1,
    }]);

    await handleClientMessage(
      ws as unknown as WebSocket,
      { type: 'get_thread_state', agentType: 'claude', threadId: 'thread-1' },
      adapters as never,
      'C:/workspace',
    );

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'thread_state',
      threadId: 'thread-1',
      messages: [{
        id: 'message-1',
        role: 'assistant',
        content: 'saved',
        timestamp: 1,
      }],
      streaming: {
        content: 'partial',
        toolCalls: [],
      },
      agentStatus: {
        agent: 'claude',
        state: 'running',
        activeThread: 'thread-1',
      },
    }));
  });

  it('rejects config changes while an agent is already running', async () => {
    const ws = createFakeWebSocket();
    const adapter = createFakeAdapter({
      getStatus: () => ({
        agent: 'claude',
        state: 'running',
        activeThread: 'thread-1',
      }),
    });
    const adapters = new Map<AgentType, FakeAdapter>([['claude', adapter]]);

    await handleClientMessage(
      ws as unknown as WebSocket,
      {
        type: 'select_agent',
        agentType: 'claude',
        config: {
          type: 'claude',
          permissionMode: 'plan',
        },
      },
      adapters as never,
      'C:/workspace',
    );

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'error',
      message: 'Cannot change claude settings while the agent is running',
      code: 'AGENT_BUSY',
    }));
    expect(adapter.start).not.toHaveBeenCalled();
    expect(adapter.stop).not.toHaveBeenCalled();
  });

  it('logs WebSocket send failures without throwing', () => {
    const ws = createFakeWebSocket();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ws.send.mockImplementation(() => {
      throw new Error('socket failed');
    });

    expect(() => {
      sendToClient(ws as unknown as WebSocket, {
        type: 'pong',
      });
    }).not.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[server] Failed to send message to client:',
      expect.any(Error),
    );
  });

  it('uses server-generated thread ids only when the client omits one', async () => {
    const ws = createFakeWebSocket();
    const adapter = createFakeAdapter();
    const adapters = new Map<AgentType, FakeAdapter>([['claude', adapter]]);

    await handleClientMessage(
      ws as unknown as WebSocket,
      {
        type: 'send_message',
        agentType: 'claude',
        threadId: 'client-thread-id',
        content: 'hello',
      } satisfies ClientMessage,
      adapters as never,
      'C:/workspace',
    );

    expect(adapter.sendMessage).toHaveBeenCalledWith('client-thread-id', 'hello');
  });
});
