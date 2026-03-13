import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentMessage, ThreadSummary } from '@rca/shared';

interface FakeStdin {
  end: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

interface FakeChildProcess extends EventEmitter {
  exitCode: number | null;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
  signalCode: NodeJS.Signals | null;
  stderr: PassThrough;
  stdin: FakeStdin;
  stdout: PassThrough;
}

interface StoreState {
  messages: Map<string, AgentMessage[]>;
  threads: Map<string, ThreadSummary[]>;
}

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const storeState = vi.hoisted<StoreState>(() => ({
  messages: new Map(),
  threads: new Map(),
}));

const storeMock = vi.hoisted(() => ({
  appendMessage: vi.fn((threadId: string, message: AgentMessage) => {
    const messages = storeState.messages.get(threadId) || [];
    storeState.messages.set(threadId, [...messages, message]);
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

vi.mock('node:child_process', () => childProcessMock);

vi.mock('../store.js', () => storeMock);

const createFakeChildProcess = (): FakeChildProcess => {
  const proc = new EventEmitter() as FakeChildProcess;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = {
    write: vi.fn(),
    end: vi.fn(),
  };
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn((signal?: NodeJS.Signals) => {
    proc.killed = true;
    proc.signalCode = signal ?? null;
    proc.exitCode = proc.exitCode ?? 1;
    return true;
  });
  return proc;
};

const flushStreamEvents = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('ClaudeAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    storeState.messages.clear();
    storeState.threads.clear();
    childProcessMock.execFile.mockImplementation((_: string, __: string[], callback: (error: Error | null) => void) => {
      callback(null);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes prompt to stdin and closes it in -p mode', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9001;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-stdin', 'hello claude');

    expect(proc.stdin.write).toHaveBeenCalledWith('hello claude');
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);
    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--session-id', expect.any(String), '-p']),
      expect.objectContaining({
        shell: false,
      }),
    );
  });

  it('passes effort level through the official CLI flag', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9002;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({
      type: 'claude',
      cwd: 'C:/workspace',
      model: 'sonnet',
      ...({ effortLevel: 'high' } as Record<string, string>),
    });
    adapter.sendMessage('thread-effort', 'hello');

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--model', 'sonnet', '--effort', 'high', '-p']),
      expect.objectContaining({
        env: expect.not.objectContaining({
          CLAUDECODE: expect.anything(),
        }),
      }),
    );
  });

  it('emits approval_required and resolves the pending decision when approved', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9004;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-approval', 'hello');
    const decisionPromise = adapter.requestPermission(
      'thread-approval',
      'Edit',
      { file_path: 'a.ts' },
      'tool-1',
    );

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

    await expect(decisionPromise).resolves.toEqual({
      behavior: 'allow',
      toolUseID: 'tool-1',
    });
    expect(adapter.getStatus().state).toBe('running');
  });

  it('removes CLAUDECODE from the child environment', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9003;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    process.env.CLAUDECODE = 'nested';

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-env', 'hello');

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({
        env: expect.not.objectContaining({
          CLAUDECODE: expect.anything(),
        }),
      }),
    );

    delete process.env.CLAUDECODE;
  });

  it('kills the previous process and ignores its late close event on same thread', async () => {
    const firstProc = createFakeChildProcess();
    const secondProc = createFakeChildProcess();
    firstProc.pid = 9101;
    secondProc.pid = 9102;
    childProcessMock.spawn
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-same', 'first');
    adapter.sendMessage('thread-same', 'second');

    if (process.platform === 'win32') {
      expect(childProcessMock.execFile).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '9101', '/T', '/F'],
        expect.any(Function),
      );
    } else {
      expect(firstProc.kill).toHaveBeenCalledTimes(1);
      expect(firstProc.kill).toHaveBeenCalledWith('SIGTERM');
    }
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(2);

    firstProc.emit('close', 1);
    await flushStreamEvents();

    const completeEvents = events.filter((event) => event.type === 'message_complete');
    expect(completeEvents).toHaveLength(0);
  });

  it('keeps running state until all active threads finish and tracks the last active thread', async () => {
    const firstProc = createFakeChildProcess();
    const secondProc = createFakeChildProcess();
    firstProc.pid = 9201;
    secondProc.pid = 9202;
    childProcessMock.spawn
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-a', 'first');
    adapter.sendMessage('thread-b', 'second');

    expect(adapter.getStatus().state).toBe('running');
    expect(adapter.getStatus().activeThread).toBe('thread-b');

    secondProc.emit('close', 0);
    await flushStreamEvents();

    expect(adapter.getStatus().state).toBe('running');
    expect(adapter.getStatus().activeThread).toBe('thread-a');

    firstProc.emit('close', 0);
    await flushStreamEvents();

    expect(adapter.getStatus().state).toBe('idle');
  });

  it('keeps status model and context usage aligned with the active thread', async () => {
    const firstProc = createFakeChildProcess();
    const secondProc = createFakeChildProcess();
    firstProc.pid = 9251;
    secondProc.pid = 9252;
    childProcessMock.spawn
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-a', 'first');
    adapter.sendMessage('thread-b', 'second');

    firstProc.stdout.write(`${JSON.stringify({
      type: 'result',
      result: 'first done',
      model: 'claude-sonnet',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
      },
    })}\n`);
    secondProc.stdout.write(`${JSON.stringify({
      type: 'result',
      result: 'second done',
      model: 'claude-opus',
      usage: {
        input_tokens: 20,
        output_tokens: 10,
      },
    })}\n`);
    await flushStreamEvents();

    expect(adapter.getStatus().activeThread).toBe('thread-b');
    expect(adapter.getStatus().model).toBe('claude-opus');
    expect(adapter.getStatus().contextUsage).toEqual({
      used: 30,
      total: 200_000,
      percentage: 0,
    });

    secondProc.emit('close', 0);
    await flushStreamEvents();

    expect(adapter.getStatus().activeThread).toBe('thread-a');
    expect(adapter.getStatus().model).toBe('claude-sonnet');
    expect(adapter.getStatus().contextUsage).toEqual({
      used: 15,
      total: 200_000,
      percentage: 0,
    });
  });

  it('parses assistant, tool and result events and stores session/context metadata', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9301;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace', model: 'sonnet[1m]' });
    adapter.sendMessage('thread-flow', 'inspect this');

    proc.stdout.write(`${JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'session-init',
      model: 'claude-sonnet',
    })}\n`);
    await flushStreamEvents();

    expect(adapter.getStatus().model).toBe('claude-sonnet');
    expect((await adapter.getThreads())[0]?.sessionId).toBe('session-init');

    proc.stdout.write(`${JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'analyzing' },
          { type: 'text', text: 'partial answer' },
          { type: 'tool_use', id: 'tool-1', name: 'edit_file', input: { path: 'a.ts' } },
        ],
      },
    })}\n`);
    await flushStreamEvents();

    expect(adapter.getStreamingState('thread-flow')).toEqual({
      content: '',
      toolCalls: [],
    });

    proc.stdout.write(`${JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'done', is_error: false },
        ],
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      type: 'result',
      result: 'final answer',
      session_id: 'session-1',
      model: 'claude-sonnet',
      cost_usd: 0.12,
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 10,
        output_tokens: 25,
      },
      modelUsage: {
        'claude-sonnet': {
          contextWindow: 1_000_000,
        },
      },
    })}\n`);
    await flushStreamEvents();

    const deltaEvent = events.find((event) => event.type === 'message_delta');
    const completeEvents = events.filter((event) => event.type === 'message_complete');

    expect(deltaEvent && deltaEvent.type === 'message_delta' ? deltaEvent.content : null).toBe('partial answer');
    expect(completeEvents).toHaveLength(4);
    expect(completeEvents[0] && completeEvents[0].type === 'message_complete'
      ? completeEvents[0].message.content
      : null).toBe('partial answer');
    expect(completeEvents[0] && completeEvents[0].type === 'message_complete'
      ? completeEvents[0].message.reasoning
      : null).toBe('analyzing');
    expect(completeEvents[1] && completeEvents[1].type === 'message_complete'
      ? completeEvents[1].message.toolCalls?.[0]?.status
      : null).toBe('running');
    expect(completeEvents[2] && completeEvents[2].type === 'message_complete'
      ? completeEvents[2].message.toolCalls?.[0]
      : null).toEqual({
      id: 'tool-1',
      name: 'edit_file',
      input: { path: 'a.ts' },
      output: 'done',
      status: 'completed',
    });
    expect(completeEvents[3] && completeEvents[3].type === 'message_complete'
      ? completeEvents[3].message.content
      : null).toBe('final answer');
    expect(adapter.getStatus().contextUsage).toEqual({
      used: 185,
      total: 1_000_000,
      percentage: 0,
    });

    const threads = await adapter.getThreads();
    expect(threads[0]?.sessionId).toBe('session-1');
    expect(threads[0]?.contextUsage).toEqual({
      used: 185,
      total: 1_000_000,
      percentage: 0,
    });
    expect(adapter.getStreamingState('thread-flow')).toBeNull();
  });

  it('passes --resume on subsequent messages after session id is captured', async () => {
    const firstProc = createFakeChildProcess();
    const secondProc = createFakeChildProcess();
    firstProc.pid = 9401;
    secondProc.pid = 9402;
    childProcessMock.spawn
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-resume', 'first');

    firstProc.stdout.write(`${JSON.stringify({
      type: 'result',
      result: 'done',
      session_id: 'resume-session',
    })}\n`);
    await flushStreamEvents();

    firstProc.emit('close', 0);
    await flushStreamEvents();

    adapter.sendMessage('thread-resume', 'second');

    expect(childProcessMock.spawn).toHaveBeenNthCalledWith(
      2,
      'claude',
      expect.arrayContaining(['--resume', 'resume-session', '-p']),
      expect.any(Object),
    );
  });

  it('persists thread metadata on start and after result completion', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9501;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-save-meta', 'hello');

    expect(storeMock.saveThread).toHaveBeenCalledTimes(1);
    expect(storeMock.saveThread).toHaveBeenLastCalledWith('claude', expect.objectContaining({
      id: 'thread-save-meta',
      messageCount: 1,
    }), expect.any(String));
    expect(storeMock.appendMessage).toHaveBeenCalledWith('thread-save-meta', expect.objectContaining({
      role: 'user',
      content: 'hello',
    }));

    proc.stdout.write(`${JSON.stringify({
      type: 'result',
      result: 'done',
      session_id: 'saved-session',
    })}\n`);
    await flushStreamEvents();

    expect(storeMock.saveThread).toHaveBeenCalledTimes(3);
    expect(storeMock.saveThread).toHaveBeenLastCalledWith('claude', expect.objectContaining({
      id: 'thread-save-meta',
      sessionId: 'saved-session',
      messageCount: 2,
      lastMessage: 'done',
    }), expect.any(String));
    expect(storeMock.saveMessages).toHaveBeenCalledWith('thread-save-meta', expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: 'done',
      }),
    ]));
    expect(storeMock.appendMessage).not.toHaveBeenCalledWith('thread-save-meta', expect.objectContaining({
      role: 'assistant',
      content: 'done',
    }));
  });

  it('restores saved threads on start and resumes with persisted session id', async () => {
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
      contextUsage: {
        used: 200,
        total: 200_000,
        percentage: 0,
      },
      config: {
        type: 'claude',
        cwd: 'C:/saved-workspace',
        model: 'sonnet',
        permissionMode: 'plan',
        effortLevel: 'high',
      },
    }]);
    storeState.messages.set('thread-restored', [{
      id: 'message-1',
      role: 'assistant',
      content: 'saved message',
      timestamp: 1,
    }]);

    const proc = createFakeChildProcess();
    proc.pid = 9601;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });

    const threads = await adapter.getThreads();
    expect(threads[0]?.sessionId).toBe('saved-session');
    expect(threads[0]?.contextUsage?.used).toBe(200);
    expect(threads[0]?.model).toBe('claude-sonnet');
    expect(threads[0]?.config?.model).toBe('sonnet');

    adapter.sendMessage('thread-restored', 'continue');

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--model', 'sonnet', '--effort', 'high', '--permission-mode', 'plan', '--resume', 'saved-session', '-p']),
      expect.objectContaining({
        cwd: 'C:/saved-workspace',
      }),
    );
  });

  it('keeps each thread configuration snapshot when the global config changes later', async () => {
    const firstProc = createFakeChildProcess();
    const secondProc = createFakeChildProcess();
    firstProc.pid = 9651;
    secondProc.pid = 9652;
    childProcessMock.spawn
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({
      type: 'claude',
      cwd: 'C:/workspace',
      model: 'sonnet',
      permissionMode: 'plan',
      effortLevel: 'high',
    });
    adapter.sendMessage('thread-config', 'first');

    firstProc.emit('close', 0);
    await flushStreamEvents();

    await adapter.start({
      type: 'claude',
      cwd: 'C:/workspace',
      model: 'opus',
      permissionMode: 'acceptEdits',
      effortLevel: 'medium',
    });
    adapter.sendMessage('thread-config', 'second');

    expect(childProcessMock.spawn).toHaveBeenNthCalledWith(
      2,
      'claude',
      expect.arrayContaining(['--model', 'sonnet', '--effort', 'high', '--permission-mode', 'plan', '-p']),
      expect.any(Object),
    );
  });

  it('updates an existing thread with message-scoped config overrides', async () => {
    const firstProc = createFakeChildProcess();
    const secondProc = createFakeChildProcess();
    firstProc.pid = 9661;
    secondProc.pid = 9662;
    childProcessMock.spawn
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({
      type: 'claude',
      cwd: 'C:/workspace',
      model: 'sonnet',
      permissionMode: 'plan',
      effortLevel: 'high',
    });
    adapter.sendMessage('thread-override', 'first');

    firstProc.emit('close', 0);
    await flushStreamEvents();

    adapter.sendMessage('thread-override', 'second', {
      type: 'claude',
      model: 'opus',
      permissionMode: 'acceptEdits',
      effortLevel: 'medium',
    });

    expect(childProcessMock.spawn).toHaveBeenNthCalledWith(
      2,
      'claude',
      expect.arrayContaining(['--model', 'opus', '--effort', 'medium', '--permission-mode', 'acceptEdits', '-p']),
      expect.any(Object),
    );

    const threads = await adapter.getThreads();
    expect(threads[0]?.config).toMatchObject({
      type: 'claude',
      model: 'opus',
      permissionMode: 'acceptEdits',
      effortLevel: 'medium',
    });
  });

  it('avoids duplicate error events when stderr is followed by a non-zero close', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9701;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-error', 'hello');

    proc.stderr.write('permission denied');
    await flushStreamEvents();
    proc.emit('close', 2);
    await flushStreamEvents();

    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0] && errors[0].type === 'error' ? errors[0].error : null).toBe('permission denied');
  });

  it('merges split stderr chunks before emitting an error event', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9702;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const errors: string[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      if (event.type === 'error') {
        errors.push(event.error);
      }
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-stderr-split', 'hello');

    proc.stderr.write('permission ');
    proc.stderr.write('denied\n');
    await flushStreamEvents();

    expect(errors).toEqual(['permission denied']);
  });

  it('emits fallback message and clears streaming state on spawn error', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9801;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-spawn-error', 'hello');

    expect(adapter.getStreamingState('thread-spawn-error')).toEqual({
      content: '',
      toolCalls: [],
    });

    proc.emit('error', new Error('spawn failed'));
    await flushStreamEvents();

    expect(adapter.getStreamingState('thread-spawn-error')).toBeNull();
    expect(events.some((event) => event.type === 'error' && event.error.includes('spawn failed'))).toBe(true);
  });

  it('terminates long-running processes through the timeout path', async () => {
    vi.useFakeTimers();

    const proc = createFakeChildProcess();
    proc.pid = 9851;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-timeout', 'hello');

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    if (process.platform === 'win32') {
      expect(childProcessMock.execFile).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '9851', '/T', '/F'],
        expect.any(Function),
      );
    } else {
      expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    }
  });

  it('creates a fallback assistant message when the process closes before result', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9901;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-close', 'hello');

    proc.stdout.write(`${JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'partial' }],
      },
    })}\n`);
    await flushStreamEvents();
    proc.emit('close', 0);
    await flushStreamEvents();

    const completed = events.find((event) => event.type === 'message_complete');
    expect(completed && completed.type === 'message_complete' ? completed.message.content : null).toBe('partial');
    expect(storeMock.saveThread).toHaveBeenCalledTimes(2);
    expect(storeMock.saveThread).toHaveBeenLastCalledWith('claude', expect.objectContaining({
      id: 'thread-close',
      messageCount: 2,
      lastMessage: 'partial',
    }), expect.any(String));
    expect(storeMock.saveMessages).toHaveBeenCalledWith('thread-close', expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: 'partial',
      }),
    ]));
  });

  it('persists the last assistant message on non-zero process close', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9902;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-close-error', 'hello');

    proc.stdout.write(`${JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'partial error output' }],
      },
    })}\n`);
    await flushStreamEvents();
    proc.emit('close', 2);
    await flushStreamEvents();

    expect(storeMock.saveMessages).toHaveBeenCalledWith('thread-close-error', expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: 'partial error output',
      }),
    ]));
    expect(storeMock.saveThread).toHaveBeenLastCalledWith('claude', expect.objectContaining({
      id: 'thread-close-error',
      lastMessage: 'partial error output',
      messageCount: 2,
    }), expect.any(String));
  });

  it('completes pending tool calls from result even when tool_result is missing', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9911;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-pending-tool', 'hello');

    proc.stdout.write(`${JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'tool-2', name: 'read_file', input: { path: 'b.ts' } },
        ],
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      type: 'result',
      result: 'done',
    })}\n`);
    await flushStreamEvents();

    const completed = events.filter((event) => event.type === 'message_complete');
    expect(completed).toHaveLength(5);
    expect(completed[2] && completed[2].type === 'message_complete'
      ? completed[2].message.toolCalls?.[0]?.status
      : null).toBe('abandoned');
    expect(completed[3] && completed[3].type === 'message_complete'
      ? completed[3].message.toolCalls?.[0]?.status
      : null).toBe('abandoned');
    expect(completed[4] && completed[4].type === 'message_complete'
      ? completed[4].message.content
      : null).toBe('done');
  });

  it('keeps pending tool calls stable when another assistant event arrives before tool_result', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9912;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-tool-gap', 'hello');

    proc.stdout.write(`${JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-gap', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'continuing after tool' },
        ],
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      type: 'result',
      result: 'continuing after tool',
    })}\n`);
    await flushStreamEvents();

    const completed = events.filter((event) => event.type === 'message_complete');
    expect(completed).toHaveLength(3);
    expect(completed[1] && completed[1].type === 'message_complete'
      ? completed[1].message.toolCalls?.[0]?.status
      : null).toBe('abandoned');
    expect(completed[2] && completed[2].type === 'message_complete'
      ? completed[2].message.content
      : null).toBe('continuing after tool');
  });

  it('falls back to the latest tool call id when tool_result omits tool_use_id', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9921;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter();
    adapter.onEvent((event) => {
      events.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-tool-fallback', 'hello');

    proc.stdout.write(`${JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'a.ts' } },
        ],
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', content: 'done', is_error: false },
        ],
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      type: 'result',
      result: 'done',
    })}\n`);
    await flushStreamEvents();

    const completed = events.filter((event) => event.type === 'message_complete');
    expect(completed).toHaveLength(3);
    expect(completed[1] && completed[1].type === 'message_complete'
      ? completed[1].message.toolCalls?.[0]
      : null).toEqual({
      id: 'tool-1',
      name: 'read_file',
      input: { path: 'a.ts' },
      output: 'done',
      status: 'completed',
    });
    expect(completed[2] && completed[2].type === 'message_complete'
      ? completed[2].message.content
      : null).toBe('done');
  });

  it('logs handler errors without breaking remaining event delivery', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9931;
    childProcessMock.spawn.mockReturnValue(proc);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    const received: AgentEvent[] = [];

    adapter.onEvent(() => {
      throw new Error('handler failed');
    });
    adapter.onEvent((event) => {
      received.push(event);
    });

    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-handler', 'hello');
    proc.emit('error', new Error('spawn failed'));
    await flushStreamEvents();

    expect(received.some((event) => event.type === 'error')).toBe(true);
    expect(consoleErrorSpy).toHaveBeenCalledWith('[claude] Event handler error:', expect.any(Error));
  });

  it('passes prompts through stdin instead of shell arguments on shell-sensitive input', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9941;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const dangerousPrompt = 'echo hacked && del C:\\temp\\*';
    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-shell-safe', dangerousPrompt);

    const spawnArgs = childProcessMock.spawn.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).not.toContain(dangerousPrompt);
    expect(proc.stdin.write).toHaveBeenCalledWith(dangerousPrompt);
  });

  it('keeps a generated session id so a failed first run can resume on retry', async () => {
    const firstProc = createFakeChildProcess();
    const secondProc = createFakeChildProcess();
    firstProc.pid = 9942;
    secondProc.pid = 9943;
    childProcessMock.spawn
      .mockReturnValueOnce(firstProc)
      .mockReturnValueOnce(secondProc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-generated-session', 'first');

    const firstArgs = childProcessMock.spawn.mock.calls[0]?.[1] as string[];
    const sessionIndex = firstArgs.indexOf('--session-id');
    expect(sessionIndex).toBeGreaterThanOrEqual(0);
    const generatedSessionId = firstArgs[sessionIndex + 1];
    expect(generatedSessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    firstProc.emit('close', 1);
    await flushStreamEvents();

    adapter.sendMessage('thread-generated-session', 'retry');

    expect(childProcessMock.spawn).toHaveBeenNthCalledWith(
      2,
      'claude',
      expect.arrayContaining(['--resume', generatedSessionId, '-p']),
      expect.any(Object),
    );
  });

  it('wires the permission bridge flags when bridge options are configured', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9951;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter({
      permissionApiBaseUrl: 'http://127.0.0.1:9470',
      permissionApiToken: 'secret-token',
      permissionBridgeScriptPath: 'C:/workspace/packages/server/bin/claude-permission-bridge.mjs',
    });
    await adapter.start({ type: 'claude', cwd: 'C:/workspace', permissionMode: 'default' });
    adapter.sendMessage('thread-bridge', 'hello');

    const spawnArgs = childProcessMock.spawn.mock.calls[0]?.[1] as string[];
    expect(spawnArgs).toEqual(expect.arrayContaining([
      '--mcp-config',
      expect.stringMatching(/rca-claude-permission-.*\.json$/),
      '--permission-prompt-tool',
      'mcp__rca-permission__rca_approve_permission',
      '-p',
    ]));
  });

  it('denies pending permission requests if the Claude process exits first', async () => {
    const proc = createFakeChildProcess();
    proc.pid = 9952;
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-approval-close', 'hello');

    const decisionPromise = adapter.requestPermission(
      'thread-approval-close',
      'Bash',
      { command: 'rm -rf tmp' },
      'tool-close',
    );

    proc.emit('close', 1);
    await flushStreamEvents();

    await expect(decisionPromise).resolves.toEqual({
      behavior: 'deny',
      message: 'Claude session ended before the permission request was answered.',
      toolUseID: 'tool-close',
    });
  });
});
