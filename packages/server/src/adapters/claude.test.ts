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

vi.mock('node:child_process', () => childProcessMock);

vi.mock('../store.js', () => ({
  appendMessage: vi.fn((threadId: string, message: AgentMessage) => {
    const messages = storeState.messages.get(threadId) || [];
    storeState.messages.set(threadId, [...messages, message]);
  }),
  loadMessages: vi.fn((threadId: string) => storeState.messages.get(threadId) || []),
  loadThreads: vi.fn((agentType: string) => storeState.threads.get(agentType) || []),
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
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-stdin', 'hello claude');

    expect(proc.stdin.write).toHaveBeenCalledWith('hello claude');
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);
  });

  it('passes effort level through the official CLI flag', async () => {
    const proc = createFakeChildProcess();
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
      expect.any(Object),
    );
  });

  it('kills the previous process and ignores its late close event on same thread', async () => {
    const firstProc = createFakeChildProcess();
    const secondProc = createFakeChildProcess();
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

    expect(firstProc.kill).toHaveBeenCalledTimes(1);
    if (process.platform === 'win32') {
      expect(firstProc.kill).toHaveBeenCalledWith();
    } else {
      expect(firstProc.kill).toHaveBeenCalledWith('SIGTERM');
    }
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(2);

    firstProc.emit('close', 1);
    await flushStreamEvents();

    const completeEvents = events.filter((event) => event.type === 'message_complete');
    expect(completeEvents).toHaveLength(0);
  });

  it('parses assistant, tool and result events and stores session/context metadata', async () => {
    const proc = createFakeChildProcess();
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
      content: 'partial answer',
      toolCalls: [{
        id: 'tool-1',
        name: 'edit_file',
        input: { path: 'a.ts' },
        status: 'running',
      }],
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
    const toolStart = events.find((event) => event.type === 'tool_start');
    const toolComplete = events.find((event) => event.type === 'tool_complete');
    const messageComplete = events.find((event) => event.type === 'message_complete');

    expect(deltaEvent && deltaEvent.type === 'message_delta' ? deltaEvent.content : null).toBe('partial answer');
    expect(toolStart && toolStart.type === 'tool_start' ? toolStart.tool.name : null).toBe('edit_file');
    expect(toolComplete && toolComplete.type === 'tool_complete' ? toolComplete.tool.output : null).toBe('done');
    expect(messageComplete && messageComplete.type === 'message_complete' ? messageComplete.message.reasoning : null).toBe('analyzing');
    expect(messageComplete && messageComplete.type === 'message_complete' ? messageComplete.message.toolCalls?.[0]?.status : null).toBe('completed');
    expect(adapter.getStatus().contextUsage).toEqual({
      used: 175,
      total: 1_000_000,
      percentage: 0,
    });

    const threads = await adapter.getThreads();
    expect(threads[0]?.sessionId).toBe('session-1');
    expect(threads[0]?.contextUsage).toEqual({
      used: 175,
      total: 1_000_000,
      percentage: 0,
    });
    expect(adapter.getStreamingState('thread-flow')).toBeNull();
  });

  it('passes --resume on subsequent messages after session id is captured', async () => {
    const firstProc = createFakeChildProcess();
    const secondProc = createFakeChildProcess();
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

  it('restores saved threads on start and resumes with persisted session id', async () => {
    storeState.threads.set('claude', [{
      id: 'thread-restored',
      agentType: 'claude',
      title: 'Restored thread',
      messageCount: 1,
      createdAt: 1,
      updatedAt: 2,
      cwd: 'C:/saved-workspace',
      sessionId: 'saved-session',
      contextUsage: {
        used: 200,
        total: 200_000,
        percentage: 0,
      },
    }]);
    storeState.messages.set('thread-restored', [{
      id: 'message-1',
      role: 'assistant',
      content: 'saved message',
      timestamp: 1,
    }]);

    const proc = createFakeChildProcess();
    childProcessMock.spawn.mockReturnValue(proc);
    const { ClaudeAdapter } = await import('./claude.ts');

    const adapter = new ClaudeAdapter();
    await adapter.start({ type: 'claude', cwd: 'C:/workspace' });

    const threads = await adapter.getThreads();
    expect(threads[0]?.sessionId).toBe('saved-session');
    expect(threads[0]?.contextUsage?.used).toBe(200);

    adapter.sendMessage('thread-restored', 'continue');

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--resume', 'saved-session', '-p']),
      expect.objectContaining({
        cwd: 'C:/saved-workspace',
      }),
    );
  });

  it('avoids duplicate error events when stderr is followed by a non-zero close', async () => {
    const proc = createFakeChildProcess();
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

  it('emits fallback message and clears streaming state on spawn error', async () => {
    const proc = createFakeChildProcess();
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

  it('creates a fallback assistant message when the process closes before result', async () => {
    const proc = createFakeChildProcess();
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
  });

  it('logs handler errors without breaking remaining event delivery', async () => {
    const proc = createFakeChildProcess();
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
});
