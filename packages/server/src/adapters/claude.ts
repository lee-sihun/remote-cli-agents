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
import * as store from '../store.js';

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
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
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
  timeout?: ReturnType<typeof setTimeout>;
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

    // 저장된 스레드 복원 (프로세스 없이 메타데이터만)
    const saved = store.loadThreads('claude');
    for (const t of saved) {
      if (!this.threads.has(t.id)) {
        this.threads.set(t.id, {
          id: t.id,
          process: null as unknown as ChildProcess,
          sessionId: t.sessionId,
          title: t.title,
          messages: store.loadMessages(t.id),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          cwd: t.cwd,
        });
      }
    }
  }

  async stop(): Promise<void> {
    // 활성 프로세스만 종료 (스레드 데이터는 유지)
    for (const [, thread] of this.threads) {
      if (thread.timeout) clearTimeout(thread.timeout);
      if (thread.process && !thread.process.killed) {
        thread.process.kill('SIGTERM');
      }
    }
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

    // 기존 스레드 진입 시 저장된 contextUsage 복원
    if (existingThread) {
      const saved = store.loadThreads('claude').find((t) => t.id === tid);
      if (saved?.contextUsage) {
        this.status.contextUsage = saved.contextUsage;
      }
    }

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
      '--output-format', 'stream-json',
      '--verbose',
    ];

    // 모델 설정 (default는 Claude Code 자체 기본값 사용)
    if (this.config?.model && this.config.model !== 'default') {
      args.push('--model', this.config.model);
    }

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    // 권한 모드 설정
    const perm = this.config?.permissionMode;
    if (perm === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    } else if (perm && perm !== 'default') {
      args.push('--permission-mode', perm);
    }

    // -p 플래그를 마지막에 추가 (프롬프트는 stdin으로 전달)
    args.push('-p');

    // 환경변수 설정
    const env = { ...process.env, ...this.config?.env };
    delete env.CLAUDECODE; // 중첩 실행 방지 우회

    // 추론 단계 (effort level) — Opus/Sonnet만 지원, Haiku는 무시
    const model = this.config?.model || 'default';
    const effortLevel = (this.config as unknown as Record<string, unknown>)?.effortLevel as string | undefined;
    if (effortLevel && model !== 'haiku') {
      env.CLAUDE_CODE_EFFORT_LEVEL = effortLevel;
    }

    const proc = spawn('claude', args, {
      cwd: cwd || this.config?.cwd || process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    // stdin으로 프롬프트 전달 후 닫기 (cmd.exe 특수문자/길이 제한 방지)
    if (proc.stdin) {
      proc.stdin.write(message);
      proc.stdin.end();
    }

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

    // 사용자 메시지 추가 + 저장
    const userMessage: AgentMessage = {
      id: randomUUID(),
      role: 'user',
      content: message,
      timestamp: now,
    };
    threadInfo.messages.push(userMessage);
    store.appendMessage(threadId, userMessage);

    // 타임아웃 (5분)
    const processTimeout = setTimeout(() => {
      if (!proc.killed) {
        console.error(`[claude] Process timeout (5min) for thread ${threadId}`);
        proc.kill('SIGTERM');
      }
    }, 5 * 60 * 1000);

    threadInfo.timeout = processTimeout;
    this.threads.set(threadId, threadInfo);
    this.saveThreadMeta(threadInfo);
    this.updateStatus('running', threadId);

    this.emit({
      type: 'message_start',
      threadId,
      agentType: 'claude',
    });

    // stdout에서 JSON 이벤트 파싱
    let accumulatedText = '';
    let currentToolCall: ToolCall | null = null;
    let messageCompleted = false;

    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        let event: ClaudeStreamEvent;
        try {
          event = JSON.parse(trimmed);
        } catch {
          console.log('[claude stdout] (non-JSON)', trimmed.slice(0, 200));
          return;
        }

        console.log('[claude event]', event.type, event.subtype || '', JSON.stringify(event).slice(0, 300));

        threadInfo.updatedAt = Date.now();

        switch (event.type) {
          case 'assistant': {
            // stream-json 형식: message.content 배열에서 텍스트/tool_use 추출
            const msg = event.message as {
              content?: Array<{
                type: string;
                text?: string;
                thinking?: string;
                id?: string;
                name?: string;
                input?: Record<string, unknown>;
              }>;
            } | undefined;

            if (msg?.content) {
              for (const block of msg.content) {
                if (block.type === 'text' && block.text) {
                  accumulatedText += block.text;
                  this.emit({
                    type: 'message_delta',
                    threadId,
                    agentType: 'claude',
                    content: block.text,
                  });
                } else if (block.type === 'tool_use' && block.name) {
                  // assistant 이벤트 내 tool_use 블록
                  currentToolCall = {
                    id: block.id || randomUUID(),
                    name: block.name,
                    input: block.input || {},
                    status: 'running',
                  };
                  this.emit({
                    type: 'tool_start',
                    threadId,
                    agentType: 'claude',
                    tool: currentToolCall,
                  });
                }
              }
            }
            break;
          }

          case 'user': {
            // tool_result (사용자 이벤트 내 tool 결과)
            const userMsg = event.message as {
              content?: Array<{
                type: string;
                content?: string;
                tool_use_id?: string;
                is_error?: boolean;
              }>;
            } | undefined;

            if (userMsg?.content) {
              for (const block of userMsg.content) {
                if (block.type === 'tool_result' && currentToolCall) {
                  currentToolCall.output = block.content || '';
                  currentToolCall.status = block.is_error ? 'failed' : 'completed';
                  this.emit({
                    type: 'tool_complete',
                    threadId,
                    agentType: 'claude',
                    tool: { ...currentToolCall },
                  });
                  currentToolCall = null;
                }
              }
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

            // 컨텍스트 사용량 계산
            if (event.usage) {
              const inputTokens = (event.usage.input_tokens || 0)
                + (event.usage.cache_read_input_tokens || 0)
                + (event.usage.cache_creation_input_tokens || 0);
              const totalTokens = inputTokens + (event.usage.output_tokens || 0);
              // 모델별 컨텍스트 윈도우 크기 추정
              const model = this.status.model || this.config?.model || 'default';
              const contextWindow = model.includes('1m') ? 1_000_000
                : model.includes('haiku') ? 200_000
                : 200_000; // Sonnet/Opus 기본값
              const percentage = Math.min(100, Math.round((totalTokens / contextWindow) * 100));
              this.status.contextUsage = { used: totalTokens, total: contextWindow, percentage };
            }

            // 최종 메시지 생성 (accumulatedText 없으면 result 필드 사용)
            messageCompleted = true;
            const finalText = accumulatedText || (event.result as string) || '';
            const assistantMessage: AgentMessage = {
              id: randomUUID(),
              role: 'assistant',
              content: finalText,
              timestamp: Date.now(),
            };

            threadInfo.messages.push(assistantMessage);
            store.appendMessage(threadId, assistantMessage);
            this.saveThreadMeta(threadInfo);

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

    // stderr 에러 처리 (실시간 출력)
    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          console.error('[claude stderr]', text);
          this.emit({
            type: 'error',
            threadId,
            agentType: 'claude',
            error: text,
          });
        }
      });
    }

    // 프로세스 종료 처리
    proc.on('close', (code) => {
      clearTimeout(processTimeout);

      if (code !== 0 && code !== null) {
        this.emit({
          type: 'error',
          threadId,
          agentType: 'claude',
          error: `Claude process exited with code ${code}`,
        });
      }

      // result 이벤트 없이 종료된 경우 message_complete 보장
      if (!messageCompleted) {
        const assistantMessage: AgentMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: accumulatedText || (code !== 0 ? `[프로세스 종료: code ${code}]` : '[응답 없음]'),
          timestamp: Date.now(),
        };
        threadInfo.messages.push(assistantMessage);
        store.appendMessage(threadId, assistantMessage);
        this.saveThreadMeta(threadInfo);

        this.emit({
          type: 'message_complete',
          threadId,
          agentType: 'claude',
          message: assistantMessage,
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

  // 스레드 메타데이터 디스크 저장
  private saveThreadMeta(thread: ThreadInfo): void {
    store.saveThread('claude', {
      id: thread.id,
      agentType: 'claude',
      title: thread.title,
      lastMessage: thread.messages.length > 0
        ? thread.messages[thread.messages.length - 1].content.slice(0, 100)
        : undefined,
      messageCount: thread.messages.length,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      cwd: thread.cwd,
      sessionId: thread.sessionId,
      contextUsage: this.status.contextUsage,
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
