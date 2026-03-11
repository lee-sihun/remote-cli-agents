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

// 스레드(세션) 정보
interface PtySession {
  id: string;
  pty: IPty;
  title: string;
  command: string;
  createdAt: number;
  updatedAt: number;
  cwd?: string;
}

export class PtyAdapter implements AgentAdapter {
  readonly name: string;
  readonly type = 'pty' as const;

  private sessions = new Map<string, PtySession>();
  private eventHandlers: AgentEventHandler[] = [];
  private config: AgentConfig | null = null;
  private nodePty: NodePtyModule | null = null;
  private command: string;
  private args: string[];
  private status: AgentStatus = {
    agent: 'pty',
    state: 'idle',
  };

  constructor(name?: string, command?: string, args?: string[]) {
    this.name = name || 'Generic PTY';
    this.command = command || 'bash';
    this.args = args || [];
  }

  async start(config: AgentConfig): Promise<void> {
    this.config = config;

    if (config.command) {
      this.command = config.command;
    }
    if (config.args) {
      this.args = config.args;
    }

    // node-pty 동적 로드
    try {
      this.nodePty = await import('node-pty') as unknown as NodePtyModule;
    } catch {
      throw new Error(
        'node-pty is required for PTY adapter. Install it with: npm install node-pty',
      );
    }
  }

  async stop(): Promise<void> {
    for (const [, session] of this.sessions) {
      try {
        session.pty.kill();
      } catch {
        // 종료 오류 무시
      }
    }
    this.sessions.clear();
    this.updateStatus('idle');
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, [this.command], (error) => {
        resolve(!error);
      });
    });
  }

  sendMessage(threadId: string | undefined, message: string, _config?: AgentConfig): void {
    const tid = threadId || randomUUID();
    const existingSession = this.sessions.get(tid);

    if (existingSession) {
      // 기존 PTY에 입력 전송
      existingSession.pty.write(message + '\n');
      existingSession.updatedAt = Date.now();
    } else {
      // 새 PTY 세션 시작
      this.spawnPty(tid, message);
    }
  }

  interrupt(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (session) {
      session.pty.write('\x03'); // Ctrl+C
    }
  }

  onEvent(handler: AgentEventHandler): void {
    this.eventHandlers.push(handler);
  }

  getStatus(): AgentStatus {
    return { ...this.status };
  }

  async getThreads(): Promise<ThreadSummary[]> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      agentType: 'pty' as const,
      title: s.title,
      messageCount: 0,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      cwd: s.cwd,
    }));
  }

  // PTY 리사이즈
  resize(threadId: string, cols: number, rows: number): void {
    const session = this.sessions.get(threadId);
    if (session) {
      session.pty.resize(cols, rows);
    }
  }

  // PTY에 원시 데이터 전송
  writeRaw(threadId: string, data: string): void {
    const session = this.sessions.get(threadId);
    if (session) {
      session.pty.write(data);
      session.updatedAt = Date.now();
    }
  }

  private spawnPty(sessionId: string, initialMessage?: string): void {
    if (!this.nodePty) {
      this.emit({
        type: 'error',
        threadId: sessionId,
        agentType: 'pty',
        error: 'node-pty not loaded',
      });
      return;
    }

    const cwd = this.config?.cwd || process.cwd();
    const env = { ...process.env, ...this.config?.env } as Record<string, string>;

    const pty = this.nodePty.spawn(this.command, this.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd,
      env,
    });

    const now = Date.now();
    const session: PtySession = {
      id: sessionId,
      pty,
      title: `${this.command} ${this.args.join(' ')}`.trim(),
      command: this.command,
      createdAt: now,
      updatedAt: now,
      cwd,
    };

    this.sessions.set(sessionId, session);
    this.updateStatus('running', sessionId);

    // PTY 출력을 이벤트로 전달
    pty.onData((data: string) => {
      session.updatedAt = Date.now();

      this.emit({
        type: 'pty_output',
        threadId: sessionId,
        agentType: 'pty',
        data,
      });
    });

    // PTY 종료 처리
    pty.onExit(({ exitCode }) => {
      this.sessions.delete(sessionId);

      if (exitCode !== 0) {
        this.emit({
          type: 'error',
          threadId: sessionId,
          agentType: 'pty',
          error: `PTY process exited with code ${exitCode}`,
        });
      }

      if (this.sessions.size === 0) {
        this.updateStatus('idle');
      }
    });

    // 초기 메시지가 있으면 PTY 준비 후 전송
    if (initialMessage) {
      setTimeout(() => {
        pty.write(initialMessage + '\n');
      }, 300);
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
      agentType: 'pty',
      status: { ...this.status },
    });
  }
}
