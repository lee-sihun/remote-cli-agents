import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentConfig,
  AgentEvent,
  AgentStatus,
  ThreadSummary,
} from '@rca/shared';
import type { AgentAdapter, AgentEventHandler } from './types.js';

// node-pty 타입 (동적 임포트용)
interface IPty {
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (e: { exitCode: number; signal?: number }) => void) => void;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: (signal?: string) => void;
  pid: number;
}

interface NodePtyModule {
  spawn: (
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ) => IPty;
}

// 스레드 정보
interface ThreadInfo {
  id: string;
  pty: IPty;
  title: string;
  createdAt: number;
  updatedAt: number;
  cwd?: string;
}

export class GeminiAdapter implements AgentAdapter {
  readonly name = 'Gemini CLI';
  readonly type = 'gemini' as const;

  private threads = new Map<string, ThreadInfo>();
  private eventHandlers: AgentEventHandler[] = [];
  private config: AgentConfig | null = null;
  private nodePty: NodePtyModule | null = null;
  private status: AgentStatus = {
    agent: 'gemini',
    state: 'idle',
  };

  async start(config: AgentConfig): Promise<void> {
    this.config = config;

    // node-pty 동적 로드
    try {
      this.nodePty = await import('node-pty') as unknown as NodePtyModule;
    } catch {
      throw new Error(
        'node-pty is required for Gemini CLI adapter. Install it with: npm install node-pty',
      );
    }
  }

  async stop(): Promise<void> {
    for (const [, thread] of this.threads) {
      try {
        thread.pty.kill();
      } catch {
        // 종료 오류 무시
      }
    }
    this.threads.clear();
    this.updateStatus('idle');
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, ['gemini'], (error) => {
        resolve(!error);
      });
    });
  }

  sendMessage(threadId: string | undefined, message: string, _config?: AgentConfig): void {
    const tid = threadId || randomUUID();
    const existingThread = this.threads.get(tid);

    if (existingThread) {
      // 기존 PTY에 입력 전송
      existingThread.pty.write(message + '\n');
      existingThread.updatedAt = Date.now();
    } else {
      // 새 PTY 세션 시작
      this.spawnGemini(tid, message);
    }
  }

  interrupt(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (thread) {
      // Ctrl+C 전송
      thread.pty.write('\x03');
    }
  }

  onEvent(handler: AgentEventHandler): void {
    this.eventHandlers.push(handler);
  }

  getStatus(): AgentStatus {
    return { ...this.status };
  }

  async getThreads(): Promise<ThreadSummary[]> {
    return Array.from(this.threads.values()).map((t) => ({
      id: t.id,
      agentType: 'gemini' as const,
      title: t.title,
      messageCount: 0, // PTY 모드에서는 메시지 카운트 미지원
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      cwd: t.cwd,
    }));
  }

  renameThread(threadId: string, title: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }

    thread.title = title;
  }

  deleteThread(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }

    try {
      thread.pty.kill();
    } catch {
      // ignore
    }
    this.threads.delete(threadId);

    if (this.status.activeThread === threadId) {
      this.updateStatus(this.threads.size > 0 ? 'running' : 'idle');
    }
  }

  // PTY 리사이즈
  resize(threadId: string, cols: number, rows: number): void {
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.pty.resize(cols, rows);
    }
  }

  // PTY에 원시 데이터 전송
  writeRaw(threadId: string, data: string): void {
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.pty.write(data);
      thread.updatedAt = Date.now();
    }
  }

  private spawnGemini(threadId: string, initialMessage?: string): void {
    if (!this.nodePty) {
      this.emit({
        type: 'error',
        threadId,
        agentType: 'gemini',
        error: 'node-pty not loaded',
      });
      return;
    }

    const cwd = this.config?.cwd || process.cwd();
    const env = { ...process.env, ...this.config?.env } as Record<string, string>;

    const pty = this.nodePty.spawn('gemini', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env,
    });

    const now = Date.now();
    const threadInfo: ThreadInfo = {
      id: threadId,
      pty,
      title: initialMessage?.slice(0, 50) || 'Gemini Session',
      createdAt: now,
      updatedAt: now,
      cwd,
    };

    this.threads.set(threadId, threadInfo);
    this.updateStatus('running', threadId);

    // PTY 출력을 이벤트로 전달
    pty.onData((data: string) => {
      threadInfo.updatedAt = Date.now();

      this.emit({
        type: 'pty_output',
        threadId,
        agentType: 'gemini',
        data,
      });
    });

    // PTY 종료 처리
    pty.onExit(({ exitCode }) => {
      this.threads.delete(threadId);

      if (exitCode !== 0) {
        this.emit({
          type: 'error',
          threadId,
          agentType: 'gemini',
          error: `Gemini process exited with code ${exitCode}`,
        });
      }

      const hasActiveThreads = this.threads.size > 0;
      if (!hasActiveThreads) {
        this.updateStatus('idle');
      }
    });

    // 초기 메시지 전송 (PTY가 준비된 후 약간의 지연)
    if (initialMessage) {
      setTimeout(() => {
        pty.write(initialMessage + '\n');
      }, 500);
    }
  }

  private emit(event: AgentEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // 이벤트 핸들러 오류 무시
      }
    }
  }

  private updateStatus(state: AgentStatus['state'], activeThread?: string): void {
    this.status.state = state;
    this.status.activeThread = activeThread;

    this.emit({
      type: 'status_change',
      agentType: 'gemini',
      status: { ...this.status },
    });
  }
}
