import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type {
  AgentConfig,
  AgentEvent,
  AgentStatus,
  AgentMessage,
  ToolCall,
  ThreadSummary,
} from '@rca/shared';
import type { AgentAdapter, AgentEventHandler } from './types.js';

// Claude stream-json 이벤트 타입
interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  text?: string;
  content?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  result?: string;
  session_id?: string;
  cost_usd?: number;
  duration_ms?: number;
  model?: string;
  [key: string]: unknown;
}

// 스레드 정보
interface ThreadInfo {
  id: string;
  process: ChildProcess;
  sessionId?: string;
  title: string;
  messages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
  cwd?: string;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'Claude Code';
  readonly type = 'claude' as const;

  private threads = new Map<string, ThreadInfo>();
  private eventHandlers: AgentEventHandler[] = [];
  private config: AgentConfig | null = null;
  private status: AgentStatus = {
    agent: 'claude',
    state: 'idle',
  };

  async start(config: AgentConfig): Promise<void> {
    this.config = config;
  }

  async stop(): Promise<void> {
    // 모든 활성 프로세스 종료
    for (const [, thread] of this.threads) {
      if (thread.process && !thread.process.killed) {
        thread.process.kill('SIGTERM');
      }
    }
    this.threads.clear();
    this.updateStatus('idle');
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, ['claude'], (error) => {
        resolve(!error);
      });
    });
  }

  sendMessage(threadId: string | undefined, message: string): void {
    const tid = threadId || randomUUID();
    const existingThread = this.threads.get(tid);

    if (existingThread && existingThread.sessionId) {
      // 기존 스레드에 재연결 (--resume)
      this.spawnClaude(tid, message, existingThread.sessionId, existingThread.cwd);
    } else {
      // 새 스레드 시작
      this.spawnClaude(tid, message, undefined, this.config?.cwd);
    }
  }

  interrupt(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (thread && thread.process && !thread.process.killed) {
      thread.process.kill('SIGINT');
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
      agentType: 'claude' as const,
      title: t.title,
      lastMessage: t.messages.length > 0
        ? t.messages[t.messages.length - 1].content.slice(0, 100)
        : undefined,
      messageCount: t.messages.length,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      cwd: t.cwd,
    }));
  }

  // Claude 프로세스 생성
  private spawnClaude(
    threadId: string,
    message: string,
    sessionId?: string,
    cwd?: string,
  ): void {
    const args = [
      '-p', message,
      '--output-format', 'stream-json',
    ];

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    if (this.config?.permissionMode === 'full') {
      args.push('--dangerously-skip-permissions');
    }

    const proc = spawn('claude', args, {
      cwd: cwd || this.config?.cwd || process.cwd(),
      env: { ...process.env, ...this.config?.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    const now = Date.now();
    const existingThread = this.threads.get(threadId);

    const threadInfo: ThreadInfo = {
      id: threadId,
      process: proc,
      sessionId: existingThread?.sessionId || sessionId,
      title: existingThread?.title || message.slice(0, 50),
      messages: existingThread?.messages || [],
      createdAt: existingThread?.createdAt || now,
      updatedAt: now,
      cwd,
    };

    // 사용자 메시지 추가
    threadInfo.messages.push({
      id: randomUUID(),
      role: 'user',
      content: message,
      timestamp: now,
    });

    this.threads.set(threadId, threadInfo);
    this.updateStatus('running', threadId);

    this.emit({
      type: 'message_start',
      threadId,
      agentType: 'claude',
    });

    // stdout에서 JSON 이벤트 파싱
    let accumulatedText = '';
    let currentToolCall: ToolCall | null = null;

    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let event: ClaudeStreamEvent;
        try {
          event = JSON.parse(trimmed);
        } catch {
          return; // JSON 파싱 실패한 줄은 무시
        }

        threadInfo.updatedAt = Date.now();

        switch (event.type) {
          case 'assistant': {
            if (event.subtype === 'text' && event.text) {
              accumulatedText += event.text;
              this.emit({
                type: 'message_delta',
                threadId,
                agentType: 'claude',
                content: event.text,
              });
            }
            break;
          }

          case 'tool_use': {
            currentToolCall = {
              id: event.tool_use_id || randomUUID(),
              name: event.tool_name || 'unknown',
              input: (event.tool_input as Record<string, unknown>) || {},
              status: 'running',
            };

            this.emit({
              type: 'tool_start',
              threadId,
              agentType: 'claude',
              tool: currentToolCall,
            });
            break;
          }

          case 'tool_result': {
            if (currentToolCall) {
              currentToolCall.output = event.result || event.content || '';
              currentToolCall.status = 'completed';

              this.emit({
                type: 'tool_complete',
                threadId,
                agentType: 'claude',
                tool: { ...currentToolCall },
              });
              currentToolCall = null;
            }
            break;
          }

          case 'result': {
            // 세션 ID 저장 (재연결용)
            if (event.session_id) {
              threadInfo.sessionId = event.session_id;
            }

            if (event.model) {
              this.status.model = event.model;
            }

            // 최종 메시지 생성
            const assistantMessage: AgentMessage = {
              id: randomUUID(),
              role: 'assistant',
              content: accumulatedText,
              timestamp: Date.now(),
            };

            threadInfo.messages.push(assistantMessage);

            this.emit({
              type: 'message_complete',
              threadId,
              agentType: 'claude',
              message: assistantMessage,
            });

            accumulatedText = '';
            break;
          }

          default:
            break;
        }
      });
    }

    // stderr 에러 처리
    if (proc.stderr) {
      let stderrData = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrData += chunk.toString();
      });

      proc.stderr.on('end', () => {
        if (stderrData.trim()) {
          this.emit({
            type: 'error',
            threadId,
            agentType: 'claude',
            error: stderrData.trim(),
          });
        }
      });
    }

    // 프로세스 종료 처리
    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this.emit({
          type: 'error',
          threadId,
          agentType: 'claude',
          error: `Claude process exited with code ${code}`,
        });
      }

      // idle 상태로 전환 (다른 활성 스레드가 없으면)
      const hasActiveThreads = Array.from(this.threads.values()).some(
        (t) => t.id !== threadId && t.process && !t.process.killed,
      );

      if (!hasActiveThreads) {
        this.updateStatus('idle');
      }
    });

    proc.on('error', (err) => {
      this.emit({
        type: 'error',
        threadId,
        agentType: 'claude',
        error: `Failed to spawn claude: ${err.message}`,
      });
      this.updateStatus('error');
    });
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
      agentType: 'claude',
      status: { ...this.status },
    });
  }
}
