import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentMessage, ThreadSummary } from '@rca/shared';

interface StoreState {
  messages: Map<string, AgentMessage[]>;
  threads: Map<string, ThreadSummary[]>;
}

interface FakeQueryOptions {
  initResult?: {
    models: Array<Record<string, unknown>>;
  };
}

class FakeQuery implements AsyncIterable<unknown>, AsyncIterator<unknown> {
  readonly close = vi.fn(() => {
    this.closed = true;
    this.flushPendingDone();
  });

  readonly initializationResult = vi.fn(async () => this.initResult);
  readonly interrupt = vi.fn(async () => {});
  readonly supportedModels = vi.fn(async () => this.initResult.models);

  private closed = false;
  private readonly initResult: { models: Array<Record<string, unknown>> };
  private readonly queue: unknown[] = [];
  private failure: unknown;
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<unknown>) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(options: FakeQueryOptions = {}) {
    this.initResult = options.initResult || {
      models: [
        {
          value: 'sonnet',
          displayName: 'Sonnet',
          description: 'Balanced model',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'medium', 'high'],
        },
        {
          value: 'opus',
          displayName: 'Opus',
          description: 'Deep reasoning model',
          supportsEffort: true,
          supportedEffortLevels: ['medium', 'high', 'max'],
        },
      ],
    };
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return this;
  }

  async next(): Promise<IteratorResult<unknown>> {
    if (this.queue.length > 0) {
      return {
        done: false,
        value: this.queue.shift(),
      };
    }

    if (this.failure !== undefined) {
      const error = this.failure;
      this.failure = undefined;
      throw error;
    }

    if (this.closed) {
      return {
        done: true,
        value: undefined,
      };
    }

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  push(message: unknown): void {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve({
        done: false,
        value: message,
      });
      return;
    }

    this.queue.push(message);
  }

  fail(error: unknown): void {
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
      return;
    }

    this.failure = error;
  }

  finish(): void {
    this.closed = true;
    this.flushPendingDone();
  }

  private flushPendingDone(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve({
        done: true,
        value: undefined,
      });
    }
  }
}

const queryQueue = vi.hoisted<FakeQuery[]>(() => []);
const queryMock = vi.hoisted(() => vi.fn(() => queryQueue.shift() || new FakeQuery()));
const createSdkMcpServerMock = vi.hoisted(() => vi.fn((options: Record<string, unknown>) => ({
  type: 'sdk',
  ...options,
})));
const toolMock = vi.hoisted(() => vi.fn((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
  name,
  description,
  inputSchema,
  handler,
})));

const storeState = vi.hoisted<StoreState>(() => ({
  messages: new Map(),
  threads: new Map(),
}));

const storeMock = vi.hoisted(() => ({
  appendMessage: vi.fn((threadId: string, message: AgentMessage) => {
    const messages = storeState.messages.get(threadId) || [];
    storeState.messages.set(threadId, [...messages, message]);
  }),
  deleteThread: vi.fn((agentType: string, threadId: string, workspaceId: string) => {
    const threads = storeState.threads.get(agentType) || [];
    storeState.threads.set(agentType, threads.filter((thread) => thread.id !== threadId));
    storeState.messages.delete(threadId);
    void workspaceId;
  }),
  loadMessages: vi.fn((threadId: string) => storeState.messages.get(threadId) || []),
  loadThreads: vi.fn((agentType: string) => storeState.threads.get(agentType) || []),
  loadWorkspaces: vi.fn(() => []),
  saveMessages: vi.fn((threadId: string, messages: AgentMessage[]) => {
    storeState.messages.set(threadId, [...messages]);
  }),
  saveThread: vi.fn((agentType: string, thread: ThreadSummary) => {
    const threads = storeState.threads.get(agentType) || [];
    const nextThreads = [...threads];
    const index = nextThreads.findIndex((item) => item.id === thread.id);
    if (index >= 0) {
      nextThreads[index] = thread;
    } else {
      nextThreads.push(thread);
    }
    storeState.threads.set(agentType, nextThreads);
  }),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: createSdkMcpServerMock,
  query: queryMock,
  tool: toolMock,
}));

vi.mock('../store.js', () => storeMock);

const enqueueQueries = (...queries: FakeQuery[]) => {
  queryQueue.push(...queries);
};

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const createSystemInit = (sessionId: string, model = 'claude-sonnet') => ({
  type: 'system' as const,
  subtype: 'init' as const,
  session_id: sessionId,
  model,
});

const createTextDelta = (text: string) => ({
  type: 'stream_event' as const,
  session_id: 'session-1',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'text_delta',
      text,
    },
  },
});

const createThinkingDelta = (thinking: string) => ({
  type: 'stream_event' as const,
  session_id: 'session-1',
  event: {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'thinking_delta',
      thinking,
    },
  },
});

const createToolStart = () => ({
  type: 'stream_event' as const,
  session_id: 'session-1',
  event: {
    type: 'content_block_start',
    index: 1,
    content_block: {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Edit',
      input: { file_path: 'a.ts' },
    },
  },
});

const createToolResult = () => ({
  type: 'user' as const,
  session_id: 'session-1',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'done',
        is_error: false,
      },
    ],
  },
});

const createResult = (overrides: Record<string, unknown> = {}) => ({
  type: 'result' as const,
  subtype: 'success' as const,
  session_id: 'session-1',
  is_error: false,
  result: 'final answer',
  total_cost_usd: 0.12,
  duration_ms: 10,
  duration_api_ms: 5,
  num_turns: 1,
  stop_reason: 'end_turn',
  permission_denials: [],
  usage: {
    input_tokens: 100,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
    output_tokens: 25,
  },
  modelUsage: {
    'claude-sonnet': {
      inputTokens: 100,
      outputTokens: 25,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 10,
      webSearchRequests: 0,
      costUSD: 0.12,
      contextWindow: 1_000_000,
      maxOutputTokens: 8192,
    },
  },
  ...overrides,
});

describe('ClaudeAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    queryQueue.length = 0;
    storeState.messages.clear();
    storeState.threads.clear();
    delete process.env.CLAUDECODE;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hydrates Claude model and reasoning options from the SDK', async () => {
    enqueueQueries(new FakeQuery({
      initResult: {
        models: [
          {
            value: 'sonnet',
            displayName: 'Sonnet',
            description: 'Balanced',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high'],
          },
          {
            value: 'opus',
            displayName: 'Opus',
            description: 'Deep reasoning',
            supportsEffort: true,
            supportedEffortLevels: ['medium', 'high', 'max'],
          },
        ],
      },
    }));

    const { ClaudeAdapter } = await import('./claude.ts');
    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });

    expect(adapter.getOptions()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'model',
        options: expect.arrayContaining([
          { value: 'default', label: 'Default' },
          { value: 'sonnet', label: 'Sonnet' },
          { value: 'opus', label: 'Opus' },
        ]),
      }),
      expect.objectContaining({
        key: 'effortLevel',
        options: expect.arrayContaining([
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
          { value: 'max', label: 'Max' },
        ]),
      }),
    ]));
  });

  it('runs the Claude SDK query with normalized options and a sanitized environment', async () => {
    const probe = new FakeQuery();
    const runtime = new FakeQuery();
    enqueueQueries(probe, runtime);
    process.env.CLAUDECODE = 'nested';

    const { ClaudeAdapter } = await import('./claude.ts');
    const adapter = new ClaudeAdapter();
    await adapter.start({
      type: 'claude',
      cwd: 'C:/workspace',
      model: 'sonnet',
      permissionMode: 'plan',
      effortLevel: 'high',
      env: {
        TEST_VALUE: '1',
      },
    });

    adapter.sendMessage('thread-sdk-options', 'hello');
    await flushAsync();

    const runtimeCall = queryMock.mock.calls[1]?.[0];
    expect(runtimeCall).toEqual(expect.objectContaining({
      prompt: 'hello',
      options: expect.objectContaining({
        cwd: 'C:/workspace',
        model: 'sonnet',
        permissionMode: 'plan',
        effort: 'high',
        includePartialMessages: true,
        settingSources: ['user', 'project', 'local'],
        permissionPromptToolName: 'mcp__rca-permission__rca_approve_permission',
        sessionId: expect.any(String),
        env: expect.objectContaining({
          TEST_VALUE: '1',
        }),
      }),
    }));
    expect(runtimeCall?.options?.env).not.toHaveProperty('CLAUDECODE');
  });

  it('resumes stored Claude threads with the persisted session id and config snapshot', async () => {
    storeState.threads.set('claude', [{
      id: 'thread-restored',
      agentType: 'claude',
      title: 'Restored thread',
      messageCount: 1,
      createdAt: 1,
      updatedAt: 2,
      cwd: 'C:/saved-workspace',
      model: 'claude-sonnet',
      sessionId: 'saved-session',
      config: {
        type: 'claude',
        cwd: 'C:/saved-workspace',
        model: 'sonnet',
        permissionMode: 'plan',
        effortLevel: 'high',
      },
    }]);

    enqueueQueries(new FakeQuery(), new FakeQuery());

    const { ClaudeAdapter } = await import('./claude.ts');
    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace', model: 'opus' });

    adapter.sendMessage('thread-restored', 'continue');
    await flushAsync();

    const runtimeCall = queryMock.mock.calls[1]?.[0];
    expect(runtimeCall?.options).toEqual(expect.objectContaining({
      cwd: 'C:/saved-workspace',
      model: 'sonnet',
      permissionMode: 'plan',
      effort: 'high',
      resume: 'saved-session',
    }));
    expect(runtimeCall?.options?.sessionId).toBeUndefined();
  });

  it('emits approval_required through canUseTool and resolves after approve()', async () => {
    enqueueQueries(new FakeQuery(), new FakeQuery());

    const { ClaudeAdapter } = await import('./claude.ts');
    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-approval', 'hello');
    await flushAsync();

    const permissionTool = queryMock.mock.calls[1]?.[0]?.options?.mcpServers?.['rca-permission']?.tools?.[0];
    const permissionPromise = permissionTool?.handler({
      tool_name: 'Edit',
      input: { file_path: 'a.ts' },
      tool_use_id: 'tool-1',
    });

    expect(adapter.getStatus().state).toBe('waiting_approval');
    expect(events).toContainEqual({
      type: 'approval_required',
      threadId: 'thread-approval',
      agentType: 'claude',
      tool: {
        id: 'tool-1',
        name: 'Edit',
        input: { file_path: 'a.ts' },
        status: 'requires_approval',
      },
    });

    adapter.approve('thread-approval', 'tool-1', true);

    await expect(permissionPromise).resolves.toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify({
          behavior: 'allow',
          toolUseID: 'tool-1',
          updatedInput: { file_path: 'a.ts' },
        }),
      }],
    });
    expect(adapter.getStatus().state).toBe('running');
  });

  it('interrupts the active Claude SDK query', async () => {
    const probe = new FakeQuery();
    const runtime = new FakeQuery();
    enqueueQueries(probe, runtime);

    const { ClaudeAdapter } = await import('./claude.ts');
    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-interrupt', 'hello');
    await flushAsync();

    adapter.interrupt('thread-interrupt');

    expect(runtime.interrupt).toHaveBeenCalledTimes(1);
  });

  it('suppresses abort diagnostics after a user interrupt', async () => {
    const runtime = new FakeQuery();
    enqueueQueries(new FakeQuery(), runtime);

    const { ClaudeAdapter } = await import('./claude.ts');
    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-interrupt-noise', 'hello');
    await flushAsync();

    const runtimeCall = queryMock.mock.calls[1]?.[0];
    adapter.interrupt('thread-interrupt-noise');
    runtimeCall?.options?.stderr?.('[ede_diagnostic] result_type=user stop_reason=tool_use Error: Request was aborted.');
    runtime.fail(new Error('Request was aborted.'));
    await flushAsync();

    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(adapter.getStatus().state).toBe('idle');
    expect(storeState.messages.get('thread-interrupt-noise')).toEqual([
      expect.objectContaining({
        role: 'user',
        content: 'hello',
      }),
    ]);
  });

  it('parses SDK partial text, tool activity, result usage, and session metadata', async () => {
    const probe = new FakeQuery();
    const runtime = new FakeQuery();
    enqueueQueries(probe, runtime);

    const { ClaudeAdapter } = await import('./claude.ts');
    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-flow', 'inspect this');
    await flushAsync();

    runtime.push(createSystemInit('session-1', 'claude-sonnet'));
    runtime.push(createThinkingDelta('analyzing'));
    runtime.push(createTextDelta('partial answer'));
    runtime.push(createToolStart());
    runtime.push(createToolResult());
    runtime.push(createResult());
    runtime.finish();
    await flushAsync();

    const deltaEvent = events.find((event) => event.type === 'message_delta');
    const completeEvents = events.filter((event): event is Extract<AgentEvent, { type: 'message_complete' }> => (
      event.type === 'message_complete'
    ));
    const toolEvents = events.filter((event) => event.type === 'tool_start' || event.type === 'tool_complete');

    expect(deltaEvent?.type === 'message_delta' ? deltaEvent.content : null).toBe('partial answer');
    expect(completeEvents).toHaveLength(4);
    expect(toolEvents).toEqual([
      {
        type: 'tool_start',
        threadId: 'thread-flow',
        agentType: 'claude',
        tool: {
          id: 'tool-1',
          name: 'Edit',
          input: { file_path: 'a.ts' },
          status: 'running',
        },
      },
      {
        type: 'tool_complete',
        threadId: 'thread-flow',
        agentType: 'claude',
        tool: {
          id: 'tool-1',
          name: 'Edit',
          input: { file_path: 'a.ts' },
          output: 'done',
          status: 'completed',
        },
      },
    ]);
    expect(completeEvents[0]?.message.content).toBe('partial answer');
    expect(completeEvents[0]?.message.reasoning).toBe('analyzing');
    expect(completeEvents[1]?.message.toolCalls?.[0]).toEqual({
      id: 'tool-1',
      name: 'Edit',
      input: { file_path: 'a.ts' },
      status: 'running',
    });
    expect(completeEvents[2]?.message.toolCalls?.[0]).toEqual({
      id: 'tool-1',
      name: 'Edit',
      input: { file_path: 'a.ts' },
      output: 'done',
      status: 'completed',
    });
    expect(completeEvents[3]?.message.content).toBe('final answer');
    const threads = await adapter.getThreads();
    expect(threads[0]?.model).toBe('claude-sonnet');
    expect(threads[0]?.sessionId).toBe('session-1');
    expect(threads[0]?.contextUsage).toEqual({
      used: 185,
      total: 1_000_000,
      percentage: 0,
    });
    expect(adapter.getStreamingState('thread-flow')).toBeNull();
  });

  it('keeps running state aligned with the last active Claude thread', async () => {
    const runtimeA = new FakeQuery();
    const runtimeB = new FakeQuery();
    enqueueQueries(new FakeQuery(), runtimeA, runtimeB);

    const { ClaudeAdapter } = await import('./claude.ts');
    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });

    adapter.sendMessage('thread-a', 'first');
    adapter.sendMessage('thread-b', 'second');
    await flushAsync();

    expect(adapter.getStatus().state).toBe('running');
    expect(adapter.getStatus().activeThread).toBe('thread-b');

    runtimeB.push(createResult({ session_id: 'session-b' }));
    runtimeB.finish();
    await flushAsync();

    expect(adapter.getStatus().state).toBe('running');
    expect(adapter.getStatus().activeThread).toBe('thread-a');

    runtimeA.push(createResult({ session_id: 'session-a' }));
    runtimeA.finish();
    await flushAsync();

    expect(adapter.getStatus().state).toBe('idle');
  });

  it('uses compaction iterations for Claude billed usage and effective context usage', async () => {
    const runtime = new FakeQuery();
    enqueueQueries(new FakeQuery(), runtime);

    const { ClaudeAdapter } = await import('./claude.ts');
    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-compact', 'keep going');
    await flushAsync();

    runtime.push(createSystemInit('session-compact', 'claude-sonnet'));
    runtime.push(createResult({
      usage: {
        input_tokens: 23_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 1_000,
        iterations: [
          {
            type: 'compaction',
            input_tokens: 180_000,
            output_tokens: 3_500,
          },
          {
            type: 'message',
            input_tokens: 23_000,
            output_tokens: 1_000,
          },
        ],
      },
      modelUsage: {
        'claude-sonnet': {
          inputTokens: 203_000,
          outputTokens: 4_500,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.12,
          contextWindow: 200_000,
          maxOutputTokens: 8192,
        },
      },
    }));
    runtime.finish();
    await flushAsync();

    const completed = events.filter((event): event is Extract<AgentEvent, { type: 'message_complete' }> => (
      event.type === 'message_complete'
    ));
    expect(completed.at(-1)?.message.usage).toEqual({
      inputTokens: 203_000,
      outputTokens: 4_500,
    });

    const threads = await adapter.getThreads();
    expect(threads[0]?.contextUsage).toEqual({
      used: 24_000,
      total: 200_000,
      percentage: 12,
    });
  });

  it('closes the previous query and ignores late events when the same thread restarts', async () => {
    const runtimeA = new FakeQuery();
    const runtimeB = new FakeQuery();
    enqueueQueries(new FakeQuery(), runtimeA, runtimeB);

    const { ClaudeAdapter } = await import('./claude.ts');
    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-restart', 'first');
    await flushAsync();
    adapter.sendMessage('thread-restart', 'second');
    await flushAsync();

    expect(runtimeA.close).toHaveBeenCalledTimes(1);

    runtimeA.push(createResult({ result: 'late result' }));
    runtimeA.finish();
    runtimeB.push(createResult({ result: 'current result' }));
    runtimeB.finish();
    await flushAsync();

    const completed = events.filter((event): event is Extract<AgentEvent, { type: 'message_complete' }> => (
      event.type === 'message_complete'
    ));
    expect(completed.at(-1)?.message.content).toBe('current result');
    expect(completed.some((event) => event.message.content === 'late result')).toBe(false);
  });

  it('reuses the generated session id as resume target after an unfinished run', async () => {
    const runtimeA = new FakeQuery();
    const runtimeB = new FakeQuery();
    enqueueQueries(new FakeQuery(), runtimeA, runtimeB);

    const { ClaudeAdapter } = await import('./claude.ts');
    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });

    adapter.sendMessage('thread-generated-session', 'first');
    await flushAsync();

    const firstSessionId = queryMock.mock.calls[1]?.[0]?.options?.sessionId;
    expect(firstSessionId).toEqual(expect.any(String));

    runtimeA.finish();
    await flushAsync();

    adapter.sendMessage('thread-generated-session', 'retry');
    await flushAsync();

    expect(queryMock.mock.calls[2]?.[0]?.options).toEqual(expect.objectContaining({
      resume: firstSessionId,
    }));
  });

  it('denies pending permission requests if the query ends first', async () => {
    const runtime = new FakeQuery();
    enqueueQueries(new FakeQuery(), runtime);

    const { ClaudeAdapter } = await import('./claude.ts');
    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-permission-close', 'hello');
    await flushAsync();

    const permissionTool = queryMock.mock.calls[1]?.[0]?.options?.mcpServers?.['rca-permission']?.tools?.[0];
    const decisionPromise = permissionTool?.handler({
      tool_name: 'Bash',
      input: { command: 'rm -rf tmp' },
      tool_use_id: 'tool-close',
    });

    runtime.finish();
    await flushAsync();

    await expect(decisionPromise).resolves.toEqual({
      content: [{
        type: 'text',
        text: JSON.stringify({
          behavior: 'deny',
          message: 'Claude session ended before the permission request was answered.',
          toolUseID: 'tool-close',
        }),
      }],
    });
  });

  it('emits an error and leaves the adapter recoverable when query creation fails synchronously', async () => {
    enqueueQueries(new FakeQuery());

    const { ClaudeAdapter } = await import('./claude.ts');
    const errors: string[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      if (event.type === 'error') {
        errors.push(event.error);
      }
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    queryMock.mockImplementationOnce(() => {
      throw new Error('query failed');
    });

    adapter.sendMessage('thread-query-error', 'hello');
    await flushAsync();

    expect(errors).toContain('query failed');
    expect(adapter.getStatus().state).toBe('error');
  });
});
