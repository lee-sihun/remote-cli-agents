import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentMessage, ThreadSummary } from '@rca/shared';

interface FakeStdin {
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
  deleteThread: vi.fn((agentType: string, threadId: string) => {
    const threads = (storeState.threads.get(agentType) || []).filter((thread) => thread.id !== threadId);
    storeState.threads.set(agentType, threads);
    storeState.messages.delete(threadId);
  }),
  loadMessages: vi.fn((threadId: string) => storeState.messages.get(threadId) || []),
  loadThreads: vi.fn((agentType: string) => storeState.threads.get(agentType) || []),
  renameThread: vi.fn((agentType: string, threadId: string, title: string) => {
    const threads = [...(storeState.threads.get(agentType) || [])];
    const index = threads.findIndex((thread) => thread.id === threadId);
    if (index >= 0) {
      threads[index] = { ...threads[index], title };
      storeState.threads.set(agentType, threads);
    }
  }),
  saveMessages: vi.fn((threadId: string, messages: AgentMessage[]) => {
    storeState.messages.set(threadId, [...messages]);
  }),
  saveThread: vi.fn((agentType: string, thread: ThreadSummary) => {
    const threads = [...(storeState.threads.get(agentType) || [])];
    const index = threads.findIndex((item) => item.id === thread.id);
    if (index >= 0) {
      threads[index] = thread;
    } else {
      threads.push(thread);
    }
    storeState.threads.set(agentType, threads);
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

function wireCodexRpc(
  proc: FakeChildProcess,
  handler: (request: { id: number; method: string; params?: Record<string, unknown> }) => void,
) {
  proc.stdin.write.mockImplementation((chunk: string) => {
    const request = JSON.parse(chunk.trim()) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (typeof request.id === 'number' && typeof request.method === 'string') {
      handler({
        id: request.id,
        method: request.method,
        params: request.params,
      });
    }
    return true;
  });
}

describe('CodexAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storeState.messages.clear();
    storeState.threads.clear();
    childProcessMock.execFile.mockImplementation((_: string, __: string[], callback: (error: Error | null) => void) => {
      callback(null);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts app-server without invalid CLI flags and hydrates model options from model/list', async () => {
    const proc = createFakeChildProcess();
    childProcessMock.spawn.mockReturnValue(proc);
    wireCodexRpc(proc, (request) => {
      if (request.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'codex-test' } })}\n`);
      }
      if (request.method === 'model/list') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            data: [{
              model: 'gpt-5.4',
              displayName: 'gpt-5.4',
              supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }],
              defaultReasoningEffort: 'medium',
              isDefault: true,
            }],
          },
        })}\n`);
      }
    });

    const { CodexAdapter } = await import('./codex.ts');
    const adapter = new CodexAdapter();
    await adapter.start({ type: 'codex', cwd: 'C:/workspace' });

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'codex',
      ['app-server'],
      expect.objectContaining({
        cwd: 'C:/workspace',
      }),
    );
    expect(adapter.getOptions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'model',
          options: expect.arrayContaining([
            expect.objectContaining({ value: 'gpt-5.4', label: 'gpt-5.4' }),
          ]),
        }),
        expect.objectContaining({ key: 'sandboxMode' }),
        expect.objectContaining({ key: 'serviceTier' }),
      ]),
    );
  });

  it('starts a new thread with the remote Codex thread id and persists the assistant reply', async () => {
    const proc = createFakeChildProcess();
    childProcessMock.spawn.mockReturnValue(proc);
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];

    wireCodexRpc(proc, (request) => {
      requests.push({ method: request.method, params: request.params });

      if (request.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'codex-test' } })}\n`);
      }
      if (request.method === 'model/list') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [] } })}\n`);
      }
      if (request.method === 'thread/start') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            thread: {
              id: 'thread-new',
              createdAt: 1,
              updatedAt: 1,
              cwd: 'C:/workspace',
              preview: '',
              name: null,
            },
            model: 'gpt-5.4',
          },
        })}\n`);
      }
      if (request.method === 'turn/start') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            turn: {
              id: 'turn-1',
              status: 'inProgress',
              error: null,
            },
          },
        })}\n`);
      }
    });

    const { CodexAdapter } = await import('./codex.ts');
    const adapter = new CodexAdapter();
    await adapter.start({ type: 'codex', cwd: 'C:/workspace' });
    adapter.sendMessage('client-thread-new', 'Reply with exactly OK', {
      type: 'codex',
      cwd: 'C:/workspace',
      model: 'gpt-5.4',
      approvalMode: 'on-request',
      sandboxMode: 'workspace-write',
    });

    await flushStreamEvents();

    const threadStart = requests.find((request) => request.method === 'thread/start');
    const turnStart = requests.find((request) => request.method === 'turn/start');

    expect(threadStart?.params).toEqual(expect.objectContaining({
      cwd: 'C:/workspace',
      model: 'gpt-5.4',
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    }));
    expect(turnStart?.params).toEqual({
      threadId: 'thread-new',
      input: [{
        type: 'text',
        text: 'Reply with exactly OK',
        text_elements: [],
      }],
    });

    proc.stdout.write(`${JSON.stringify({
      method: 'turn/started',
      params: {
        threadId: 'thread-new',
        turn: {
          id: 'turn-1',
          status: 'inProgress',
          error: null,
        },
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-new',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'OK',
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'thread-new',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            totalTokens: 120,
          },
          modelContextWindow: 1000,
        },
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      method: 'turn/completed',
      params: {
        threadId: 'thread-new',
        turn: {
          id: 'turn-1',
          status: 'completed',
          error: null,
        },
      },
    })}\n`);

    await flushStreamEvents();

    expect(storeState.messages.get('client-thread-new')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: 'OK',
        model: 'gpt-5.4',
      }),
    ]));
    expect(storeMock.saveThread).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        id: 'client-thread-new',
        remoteThreadId: 'thread-new',
      }),
    );
    expect(adapter.getStatus().state).toBe('idle');
  });

  it('emits Codex assistant text and tool updates in chronological order', async () => {
    const proc = createFakeChildProcess();
    childProcessMock.spawn.mockReturnValue(proc);

    wireCodexRpc(proc, (request) => {
      if (request.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'codex-test' } })}\n`);
      }
      if (request.method === 'model/list') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [] } })}\n`);
      }
      if (request.method === 'thread/start') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            thread: {
              id: 'thread-chronology',
              createdAt: 1,
              updatedAt: 1,
              cwd: 'C:/workspace',
            },
            model: 'gpt-5.4',
          },
        })}\n`);
      }
      if (request.method === 'turn/start') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            turn: {
              id: 'turn-chronology',
              status: 'inProgress',
              error: null,
            },
          },
        })}\n`);
      }
    });

    const { CodexAdapter } = await import('./codex.ts');
    const adapter = new CodexAdapter();
    const events: AgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start({ type: 'codex', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-chronology', 'run', { type: 'codex', cwd: 'C:/workspace' });
    await flushStreamEvents();

    proc.stdout.write(`${JSON.stringify({
      method: 'turn/started',
      params: {
        threadId: 'thread-chronology',
        turn: {
          id: 'turn-chronology',
          status: 'inProgress',
          error: null,
        },
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-chronology',
        turnId: 'turn-chronology',
        itemId: 'msg-before-tool',
        delta: '결과 보고',
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      method: 'item/started',
      params: {
        threadId: 'thread-chronology',
        item: {
          id: 'tool-chronology',
          type: 'commandExecution',
          command: 'npm test',
          cwd: 'C:/workspace',
          status: 'inProgress',
        },
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      method: 'item/completed',
      params: {
        threadId: 'thread-chronology',
        item: {
          id: 'tool-chronology',
          type: 'commandExecution',
          command: 'npm test',
          cwd: 'C:/workspace',
          aggregatedOutput: 'ok',
          status: 'completed',
        },
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'thread-chronology',
        turnId: 'turn-chronology',
        itemId: 'msg-after-tool',
        delta: '최종 요약',
      },
    })}\n`);
    proc.stdout.write(`${JSON.stringify({
      method: 'turn/completed',
      params: {
        threadId: 'thread-chronology',
        turn: {
          id: 'turn-chronology',
          status: 'completed',
          error: null,
        },
      },
    })}\n`);
    await flushStreamEvents();

    const completed = events.filter((event): event is Extract<AgentEvent, { type: 'message_complete' }> => (
      event.type === 'message_complete'
    ));
    expect(completed).toHaveLength(4);
    expect(completed[0]?.message.content).toBe('결과 보고');
    expect(completed[1]?.message.toolCalls?.[0]).toMatchObject({
      id: 'tool-chronology',
      status: 'running',
    });
    expect(completed[2]?.message.toolCalls?.[0]).toMatchObject({
      id: 'tool-chronology',
      status: 'completed',
      output: 'ok',
    });
    expect(completed[3]?.message.content).toBe('최종 요약');

    expect(storeState.messages.get('thread-chronology')).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: 'run' }),
      expect.objectContaining({ id: 'msg-before-tool', role: 'assistant', content: '결과 보고' }),
      expect.objectContaining({
        id: 'tool-chronology',
        role: 'assistant',
        toolCalls: [expect.objectContaining({ status: 'completed' })],
      }),
      expect.objectContaining({ id: 'msg-after-tool', role: 'assistant', content: '최종 요약' }),
    ]));
  });

  it('resumes stored threads before sending and uses the active turn id for interrupts', async () => {
    storeState.threads.set('codex', [{
      id: 'client-thread-resume',
      agentType: 'codex',
      title: 'Stored thread',
      messageCount: 1,
      createdAt: 1,
      updatedAt: 2,
      cwd: 'C:/workspace',
      remoteThreadId: 'thread-resume',
      config: {
        type: 'codex',
        model: 'gpt-5.4',
      },
    }]);
    storeState.messages.set('client-thread-resume', [{
      id: 'message-1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
    }]);

    const proc = createFakeChildProcess();
    childProcessMock.spawn.mockReturnValue(proc);
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];

    wireCodexRpc(proc, (request) => {
      requests.push({ method: request.method, params: request.params });

      if (request.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'codex-test' } })}\n`);
      }
      if (request.method === 'model/list') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [] } })}\n`);
      }
      if (request.method === 'thread/resume') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            thread: {
              id: 'thread-resume',
              createdAt: 1,
              updatedAt: 2,
              cwd: 'C:/workspace',
            },
            model: 'gpt-5.4',
          },
        })}\n`);
      }
      if (request.method === 'turn/start') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            turn: {
              id: 'turn-resume',
              status: 'inProgress',
              error: null,
            },
          },
        })}\n`);
      }
      if (request.method === 'turn/interrupt') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }
    });

    const { CodexAdapter } = await import('./codex.ts');
    const adapter = new CodexAdapter();
    await adapter.start({ type: 'codex', cwd: 'C:/workspace' });
    adapter.sendMessage('client-thread-resume', 'continue', {
      type: 'codex',
      cwd: 'C:/workspace',
      sandboxMode: 'workspace-write',
    });

    await flushStreamEvents();

    proc.stdout.write(`${JSON.stringify({
      method: 'turn/started',
      params: {
        threadId: 'thread-resume',
        turn: {
          id: 'turn-resume',
          status: 'inProgress',
          error: null,
        },
      },
    })}\n`);
    await flushStreamEvents();

    adapter.interrupt('client-thread-resume');
    await flushStreamEvents();

    expect(requests.find((request) => request.method === 'thread/resume')?.params).toEqual(expect.objectContaining({
      threadId: 'thread-resume',
      persistExtendedHistory: false,
      sandbox: 'workspace-write',
    }));
    expect(requests.find((request) => request.method === 'turn/interrupt')?.params).toEqual({
      threadId: 'thread-resume',
      turnId: 'turn-resume',
    });
  });

  it('reuses the stored thread config when no new overrides are provided', async () => {
    storeState.threads.set('codex', [{
      id: 'thread-restored-config',
      agentType: 'codex',
      title: 'Stored thread',
      messageCount: 1,
      createdAt: 1,
      updatedAt: 2,
      cwd: 'C:/saved-workspace',
      remoteThreadId: 'thread-restored-config',
      config: {
        type: 'codex',
        model: 'gpt-5.4',
        effortLevel: 'high',
        approvalMode: 'never',
        sandboxMode: 'danger-full-access',
      },
    }]);

    const proc = createFakeChildProcess();
    childProcessMock.spawn.mockReturnValue(proc);
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];

    wireCodexRpc(proc, (request) => {
      requests.push({ method: request.method, params: request.params });
      if (request.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'codex-test' } })}\n`);
      }
      if (request.method === 'model/list') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [] } })}\n`);
      }
      if (request.method === 'thread/resume') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            thread: {
              id: 'thread-restored-config',
              createdAt: 1,
              updatedAt: 2,
              cwd: 'C:/saved-workspace',
            },
            model: 'gpt-5.4',
          },
        })}\n`);
      }
      if (request.method === 'turn/start') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            turn: {
              id: 'turn-restored-config',
              status: 'inProgress',
              error: null,
            },
          },
        })}\n`);
      }
    });

    const { CodexAdapter } = await import('./codex.ts');
    const adapter = new CodexAdapter();
    await adapter.start({ type: 'codex', cwd: 'C:/workspace', approvalMode: 'on-request' });
    adapter.sendMessage('thread-restored-config', 'continue');
    await flushStreamEvents();

    expect(requests.find((request) => request.method === 'thread/resume')?.params).toEqual(expect.objectContaining({
      threadId: 'thread-restored-config',
      cwd: 'C:/saved-workspace',
      model: 'gpt-5.4',
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      persistExtendedHistory: false,
    }));
  });

  it('starts a fresh Codex thread for legacy stored threads without a remote thread id', async () => {
    storeState.threads.set('codex', [{
      id: 'legacy-local-thread',
      agentType: 'codex',
      title: 'Legacy thread',
      messageCount: 1,
      createdAt: 1,
      updatedAt: 2,
      cwd: 'C:/workspace',
      config: {
        type: 'codex',
        model: 'gpt-5.4',
      },
    }]);

    const proc = createFakeChildProcess();
    childProcessMock.spawn.mockReturnValue(proc);
    const requests: Array<{ method: string; params?: Record<string, unknown> }> = [];

    wireCodexRpc(proc, (request) => {
      requests.push({ method: request.method, params: request.params });

      if (request.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'codex-test' } })}\n`);
      }
      if (request.method === 'model/list') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [] } })}\n`);
      }
      if (request.method === 'thread/start') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            thread: {
              id: 'thread-migrated',
              createdAt: 1,
              updatedAt: 2,
              cwd: 'C:/workspace',
            },
            model: 'gpt-5.4',
          },
        })}\n`);
      }
      if (request.method === 'turn/start') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            turn: {
              id: 'turn-migrated',
              status: 'inProgress',
              error: null,
            },
          },
        })}\n`);
      }
    });

    const { CodexAdapter } = await import('./codex.ts');
    const adapter = new CodexAdapter();
    await adapter.start({ type: 'codex', cwd: 'C:/workspace' });
    adapter.sendMessage('legacy-local-thread', 'continue', {
      type: 'codex',
      cwd: 'C:/workspace',
    });

    await flushStreamEvents();

    expect(requests.some((request) => request.method === 'thread/resume')).toBe(false);
    expect(requests.find((request) => request.method === 'turn/start')?.params).toEqual({
      threadId: 'thread-migrated',
      input: [{
        type: 'text',
        text: 'continue',
        text_elements: [],
      }],
    });
    expect(storeMock.saveThread).toHaveBeenCalledWith(
      'codex',
      expect.objectContaining({
        id: 'legacy-local-thread',
        remoteThreadId: 'thread-migrated',
      }),
    );
  });

  it('relays approval requests back to app-server responses', async () => {
    const proc = createFakeChildProcess();
    childProcessMock.spawn.mockReturnValue(proc);
    const writes: string[] = [];

    wireCodexRpc(proc, (request) => {
      writes.push(JSON.stringify(request));
      if (request.method === 'initialize') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'codex-test' } })}\n`);
      }
      if (request.method === 'model/list') {
        proc.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [] } })}\n`);
      }
      if (request.method === 'thread/start') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            thread: {
              id: 'thread-approval',
              createdAt: 1,
              updatedAt: 1,
              cwd: 'C:/workspace',
            },
            model: 'gpt-5.4',
          },
        })}\n`);
      }
      if (request.method === 'turn/start') {
        proc.stdout.write(`${JSON.stringify({
          id: request.id,
          result: {
            turn: {
              id: 'turn-approval',
              status: 'inProgress',
              error: null,
            },
          },
        })}\n`);
      }
    });

    proc.stdin.write.mockImplementation((chunk: string) => {
      writes.push(chunk.trim());
      const request = JSON.parse(chunk.trim()) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (typeof request.id === 'number' && typeof request.method === 'string') {
        if (request.method === 'initialize') {
          proc.stdout.write(`${JSON.stringify({ id: request.id, result: { userAgent: 'codex-test' } })}\n`);
        }
        if (request.method === 'model/list') {
          proc.stdout.write(`${JSON.stringify({ id: request.id, result: { data: [] } })}\n`);
        }
        if (request.method === 'thread/start') {
          proc.stdout.write(`${JSON.stringify({
            id: request.id,
            result: {
              thread: {
                id: 'thread-approval',
                createdAt: 1,
                updatedAt: 1,
                cwd: 'C:/workspace',
              },
              model: 'gpt-5.4',
            },
          })}\n`);
        }
        if (request.method === 'turn/start') {
          proc.stdout.write(`${JSON.stringify({
            id: request.id,
            result: {
              turn: {
                id: 'turn-approval',
                status: 'inProgress',
                error: null,
              },
            },
          })}\n`);
        }
      }
      return true;
    });

    const { CodexAdapter } = await import('./codex.ts');
    const adapter = new CodexAdapter();
    const events: AgentEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    await adapter.start({ type: 'codex', cwd: 'C:/workspace' });
    adapter.sendMessage('thread-approval', 'run something', { type: 'codex', cwd: 'C:/workspace' });
    await flushStreamEvents();

    proc.stdout.write(`${JSON.stringify({
      id: 91,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thread-approval',
        itemId: 'cmd-1',
        command: 'npm test',
        cwd: 'C:/workspace',
      },
    })}\n`);
    await flushStreamEvents();

    expect(events).toContainEqual({
      type: 'approval_required',
      threadId: 'thread-approval',
      agentType: 'codex',
      tool: {
        id: 'cmd-1',
        name: 'commandExecution',
        input: {
          command: 'npm test',
          cwd: 'C:/workspace',
          reason: '',
        },
        status: 'requires_approval',
      },
    });

    adapter.approve('thread-approval', 'cmd-1', true);

    expect(writes.some((entry) => entry.includes('"id":91') && entry.includes('"decision":"approved"'))).toBe(true);
  });
});
