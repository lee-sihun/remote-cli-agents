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
  ContextUsage,
} from '@rca/shared';
import type { AgentAdapter, AgentEventHandler, ThreadStreamingState } from './types.js';
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
  contextUsage?: ContextUsage;
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
  // per-thread 스트리밍 버퍼 (재연결 동기화용)
  private streamingBuffers = new Map<string, { content: string; toolCalls: ToolCall[] }>();

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
          contextUsage: t.contextUsage,
        });
      }
    }
  }

  async stop(): Promise<void> {
    // 활성 프로세스만 종료 (스레드 데이터는 유지)
    for (const [, thread] of this.threads) {
      if (thread.timeout) clearTimeout(thread.timeout);
      if (thread.process && !thread.process.killed) {
        if (process.platform === 'win32') {
          thread.process.kill();
        } else {
          thread.process.kill('SIGTERM');
        }
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

    // 기존 프로세스가 실행 중이면 종료 후 재시작
    if (existingThread?.process && !existingThread.process.killed) {
      console.log(`[claude] Killing existing process for thread ${tid} before new message`);
      if (existingThread.timeout) clearTimeout(existingThread.timeout);
      if (process.platform === 'win32') {
        existingThread.process.kill();
      } else {
        existingThread.process.kill('SIGTERM');
      }
    }

    // 기존 스레드 진입 시 in-memory contextUsage 복원
    if (existingThread?.contextUsage) {
      this.status.contextUsage = existingThread.contextUsage;
    }

    if (existingThread?.sessionId) {
      console.log(`[claude] Resuming session ${existingThread.sessionId} for thread ${tid}`);
      this.spawnClaude(tid, message, existingThread.sessionId, existingThread.cwd);
    } else {
      console.log(`[claude] Starting new session for thread ${tid}`);
      this.spawnClaude(tid, message, undefined, this.config?.cwd);
    }
  }

  interrupt(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (thread?.process && !thread.process.killed) {
      if (process.platform === 'win32') {
        thread.process.kill();
      } else {
        thread.process.kill('SIGINT');
      }
    }
  }

  approve(threadId: string, _toolCallId: string, approved: boolean): void {
    const thread = this.threads.get(threadId);
    if (!thread?.process || thread.process.killed) return;

    // Claude Code stdin으로 승인/거부 응답 전달
    const response = approved ? 'y\n' : 'n\n';
    try {
      thread.process.stdin?.write(response);
    } catch {
      console.error(`[claude] Failed to write approval for thread ${threadId}`);
    }
  }

  onEvent(handler: AgentEventHandler): void {
    this.eventHandlers.push(handler);
  }

  getStatus(): AgentStatus {
    return { ...this.status };
  }

  getStreamingState(threadId: string): ThreadStreamingState | null {
    return this.streamingBuffers.get(threadId) || null;
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
      sessionId: t.sessionId,
      contextUsage: t.contextUsage,
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
      contextUsage: existingThread?.contextUsage,
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
        if (process.platform === 'win32') {
          proc.kill();
        } else {
          proc.kill('SIGTERM');
        }
      }
    }, 5 * 60 * 1000);

    threadInfo.timeout = processTimeout;
    this.threads.set(threadId, threadInfo);
    this.saveThreadMeta(threadInfo);
    this.updateStatus('running', threadId);

    // 스트리밍 버퍼 초기화
    this.streamingBuffers.set(threadId, { content: '', toolCalls: [] });

    this.emit({
      type: 'message_start',
      threadId,
      agentType: 'claude',
    });

    // stdout에서 JSON 이벤트 파싱
    let accumulatedText = '';
    let accumulatedReasoning = '';
    const pendingToolCalls = new Map<string, ToolCall>(); // tool_use_id → ToolCall
    let lastToolCallId: string | null = null; // 가장 최근 tool_use ID (순차 fallback용)
    let messageCompleted = false;
    const collectedToolCalls: ToolCall[] = []; // 완료된 도구 호출 수집 (디스크 저장용)
    let resultMeta: { model?: string; costUsd?: number; usage?: { inputTokens: number; outputTokens: number } } = {};

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
              const buf = this.streamingBuffers.get(threadId);
              for (const block of msg.content) {
                if (block.type === 'thinking' && block.thinking) {
                  accumulatedReasoning += block.thinking;
                } else if (block.type === 'text' && block.text) {
                  accumulatedText += block.text;
                  if (buf) buf.content += block.text;
                  this.emit({
                    type: 'message_delta',
                    threadId,
                    agentType: 'claude',
                    content: block.text,
                  });
                } else if (block.type === 'tool_use' && block.name) {
                  const toolCall: ToolCall = {
                    id: block.id || randomUUID(),
                    name: block.name,
                    input: block.input || {},
                    status: 'running',
                  };
                  pendingToolCalls.set(toolCall.id, toolCall);
                  lastToolCallId = toolCall.id;
                  if (buf) buf.toolCalls.push(toolCall);
                  this.emit({
                    type: 'tool_start',
                    threadId,
                    agentType: 'claude',
                    tool: toolCall,
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
              const buf = this.streamingBuffers.get(threadId);
              for (const block of userMsg.content) {
                if (block.type === 'tool_result') {
                  // tool_use_id로 매칭, 없으면 마지막 tool_use로 fallback
                  const matchId = block.tool_use_id || lastToolCallId;
                  const matched = matchId ? pendingToolCalls.get(matchId) : undefined;
                  if (!matched) continue;

                  matched.output = block.content || '';
                  matched.status = block.is_error ? 'failed' : 'completed';
                  // 버퍼 내 도구 상태 업데이트
                  if (buf) {
                    const idx = buf.toolCalls.findIndex((t) => t.id === matched.id);
                    if (idx >= 0) buf.toolCalls[idx] = { ...matched };
                  }
                  collectedToolCalls.push({ ...matched });
                  pendingToolCalls.delete(matched.id);
                  this.emit({
                    type: 'tool_complete',
                    threadId,
                    agentType: 'claude',
                    tool: { ...matched },
                  });
                }
              }
            }
            break;
          }

          case 'result': {
            // 세션 ID 저장 (재연결용)
            if (event.session_id) {
              threadInfo.sessionId = event.session_id;
              console.log(`[claude] Session ID saved: ${event.session_id} for thread ${threadId}`);
            }

            if (event.model) {
              this.status.model = event.model;
            }

            // 메타데이터 수집
            if (event.cost_usd) resultMeta.costUsd = event.cost_usd;
            if (event.model) resultMeta.model = event.model;

            // 컨텍스트 사용량 계산 (스레드별 저장)
            if (event.usage) {
              const inputTokens = (event.usage.input_tokens || 0)
                + (event.usage.cache_read_input_tokens || 0)
                + (event.usage.cache_creation_input_tokens || 0);
              const outputTokens = event.usage.output_tokens || 0;
              const totalTokens = inputTokens + outputTokens;
              resultMeta.usage = { inputTokens, outputTokens };

              const model = this.status.model || this.config?.model || 'default';
              const contextWindow = model.includes('1m') ? 1_000_000
                : model.includes('haiku') ? 200_000
                : 200_000;
              const percentage = Math.min(100, Math.round((totalTokens / contextWindow) * 100));
              const usage: ContextUsage = { used: totalTokens, total: contextWindow, percentage };
              threadInfo.contextUsage = usage;
              this.status.contextUsage = usage;
            }

            // 스트리밍 버퍼 정리
            this.streamingBuffers.delete(threadId);

            // 최종 메시지 생성
            messageCompleted = true;
            // 미완료 tool call이 남아있으면 수집
            for (const [, tc] of pendingToolCalls) {
              collectedToolCalls.push({ ...tc, status: 'completed' });
            }
            pendingToolCalls.clear();
            const finalText = accumulatedText || (event.result as string) || '';
            const assistantMessage: AgentMessage = {
              id: randomUUID(),
              role: 'assistant',
              content: finalText,
              timestamp: Date.now(),
              toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
              reasoning: accumulatedReasoning || undefined,
              model: resultMeta.model,
              costUsd: resultMeta.costUsd,
              usage: resultMeta.usage,
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
    let stderrEmitted = false;
    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          console.error('[claude stderr]', text);
          stderrEmitted = true;
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
      this.streamingBuffers.delete(threadId);

      // stderr에서 이미 에러를 전송했으면 close 에러 중복 방지
      if (code !== 0 && code !== null && !stderrEmitted) {
        this.emit({
          type: 'error',
          threadId,
          agentType: 'claude',
          error: `Claude process exited with code ${code}`,
        });
      }

      // result 이벤트 없이 종료된 경우 message_complete 보장
      if (!messageCompleted) {
        for (const [, tc] of pendingToolCalls) {
          collectedToolCalls.push({ ...tc, status: 'completed' });
        }
        pendingToolCalls.clear();
        const assistantMessage: AgentMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: accumulatedText || (code !== 0 ? `[프로세스 종료: code ${code}]` : '[응답 없음]'),
          timestamp: Date.now(),
          toolCalls: collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
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
      clearTimeout(processTimeout);
      this.streamingBuffers.delete(threadId);
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
      contextUsage: thread.contextUsage,
    });
  }

  private emit(event: AgentEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error('[claude] Event handler error:', err);
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
