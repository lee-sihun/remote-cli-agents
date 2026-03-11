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
import { terminateChildProcess } from '../process.js';

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
  modelUsage?: Record<string, {
    contextWindow?: number;
  }>;
  [key: string]: unknown;
}

// 스레드 정보
interface ThreadInfo {
  id: string;
  process: ChildProcess;
  runId?: string;
  sessionId?: string;
  model?: string;
  title: string;
  messages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
  cwd?: string;
  timeout?: ReturnType<typeof setTimeout>;
  contextUsage?: ContextUsage;
  config?: AgentConfig;
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
          model: t.model,
          title: t.title,
          messages: store.loadMessages(t.id),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
          cwd: t.cwd,
          contextUsage: t.contextUsage,
          config: t.config,
        });
      }
    }
  }

  async stop(): Promise<void> {
    // 활성 프로세스만 종료 (스레드 데이터는 유지)
    for (const [, thread] of this.threads) {
      if (thread.timeout) clearTimeout(thread.timeout);
      if (this.isProcessActive(thread.process)) {
        terminateChildProcess(thread.process);
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
    if (existingThread && this.isProcessActive(existingThread.process)) {
      console.log(`[claude] Killing existing process for thread ${tid} before new message`);
      if (existingThread.timeout) clearTimeout(existingThread.timeout);
      terminateChildProcess(existingThread.process);
    }

    // 기존 스레드 진입 시 in-memory contextUsage 복원
    if (existingThread?.contextUsage) {
      this.status.contextUsage = existingThread.contextUsage;
    }
    if (existingThread?.model) {
      this.status.model = existingThread.model;
    }

    const threadConfig = this.resolveThreadConfig(existingThread);

    if (existingThread?.sessionId) {
      console.log(`[claude] Resuming session ${existingThread.sessionId} for thread ${tid}`);
      this.spawnClaude(tid, message, threadConfig, existingThread.sessionId, existingThread.cwd);
    } else {
      console.log(`[claude] Starting new session for thread ${tid}`);
      this.spawnClaude(tid, message, threadConfig, undefined, threadConfig.cwd);
    }
  }

  interrupt(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (thread && this.isProcessActive(thread.process)) {
      terminateChildProcess(thread.process, 'SIGINT');
    }
  }

  approve(threadId: string, _toolCallId: string, approved: boolean): void {
    const thread = this.threads.get(threadId);
    if (!thread || !this.isProcessActive(thread.process)) return;
    void approved;
    this.emit({
      type: 'error',
      threadId,
      agentType: 'claude',
      error: 'Claude Code -p 모드는 RCA 런타임 승인 응답을 지원하지 않습니다. permissionMode를 acceptEdits, plan, dontAsk, bypassPermissions 중 하나로 사용하세요.',
    });
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
      model: t.model,
      sessionId: t.sessionId,
      contextUsage: t.contextUsage,
      config: t.config,
    }));
  }

  // Claude 프로세스 생성
  private spawnClaude(
    threadId: string,
    message: string,
    runConfig: AgentConfig,
    sessionId?: string,
    cwd?: string,
  ): void {
    const args = [
      '--output-format', 'stream-json',
      '--verbose',
    ];

    // 모델 설정 (default는 Claude Code 자체 기본값 사용)
    if (runConfig.model && runConfig.model !== 'default') {
      args.push('--model', runConfig.model);
    }

    const effortLevel = runConfig.effortLevel;
    if (effortLevel) {
      args.push('--effort', effortLevel);
    }

    if (sessionId) {
      args.push('--resume', sessionId);
    }

    // 권한 모드 설정
    const perm = runConfig.permissionMode;
    if (perm === 'bypassPermissions') {
      args.push('--dangerously-skip-permissions');
    } else if (perm && perm !== 'default') {
      args.push('--permission-mode', perm);
    }

    // -p 플래그를 마지막에 추가 (프롬프트는 stdin으로 전달)
    args.push('-p');

    // 환경변수 설정
    const env = { ...process.env, ...runConfig.env };
    delete env.CLAUDECODE; // 중첩 실행 방지 우회

    const proc = spawn('claude', args, {
      cwd: cwd || runConfig.cwd || process.cwd(),
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    // stdin으로 프롬프트 전달 후 닫기 (cmd.exe 특수문자/길이 제한 방지)
    if (proc.stdin) {
      proc.stdin.write(message);
      proc.stdin.end();
    }

    const now = Date.now();
    const existingThread = this.threads.get(threadId);
    const runId = randomUUID();

    const threadInfo: ThreadInfo = {
      id: threadId,
      process: proc,
      runId,
      sessionId: existingThread?.sessionId || sessionId,
      model: existingThread?.model,
      title: existingThread?.title || message.slice(0, 50),
      messages: existingThread?.messages || [],
      createdAt: existingThread?.createdAt || now,
      updatedAt: now,
      cwd: cwd || runConfig.cwd,
      contextUsage: existingThread?.contextUsage,
      config: runConfig,
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
      if (this.isCurrentRun(threadId, runId, proc) && this.isProcessActive(proc)) {
        console.error(`[claude] Process timeout (5min) for thread ${threadId}`);
        terminateChildProcess(proc);
      }
    }, 5 * 60 * 1000);

    threadInfo.timeout = processTimeout;
    this.threads.set(threadId, threadInfo);
    this.saveThreadMeta(threadInfo);
    this.updateStatus('running', threadId, threadInfo);

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
        if (!this.isCurrentRun(threadId, runId, proc)) return;

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
          case 'system': {
            if (event.subtype === 'init') {
              if (event.session_id) {
                threadInfo.sessionId = event.session_id;
              }
              if (event.model) {
                threadInfo.model = event.model;
                if (this.status.activeThread === threadId) {
                  this.status.model = event.model;
                }
              }
              this.saveThreadMeta(threadInfo);
            }
            break;
          }

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
              threadInfo.model = event.model;
              if (this.status.activeThread === threadId) {
                this.status.model = event.model;
              }
            }

            // 메타데이터 수집
            if (event.cost_usd) resultMeta.costUsd = event.cost_usd;
            if (event.model) resultMeta.model = event.model;

            // 컨텍스트 사용량 계산 (스레드별 저장)
            // prompt caching 문서 기준:
            // - input_tokens = 마지막 cache breakpoint 이후 입력
            // - cache_read_input_tokens = 캐시에서 읽은 입력
            // - cache_creation_input_tokens = 이번 요청에서 새로 캐시된 입력
            if (event.usage) {
              const inputTokens = (event.usage.input_tokens || 0)
                + (event.usage.cache_read_input_tokens || 0)
                + (event.usage.cache_creation_input_tokens || 0);
              const outputTokens = event.usage.output_tokens || 0;
              const totalTokens = inputTokens + outputTokens;
              resultMeta.usage = { inputTokens, outputTokens };

              const contextWindow = this.extractContextWindow(event) ?? this.estimateContextWindow([
                this.config?.model,
                event.model,
                this.status.model,
              ]);
              const percentage = Math.min(100, Math.round((totalTokens / contextWindow) * 100));
              const usage: ContextUsage = { used: totalTokens, total: contextWindow, percentage };
              threadInfo.contextUsage = usage;
              if (this.status.activeThread === threadId) {
                this.status.contextUsage = usage;
              }
            }

            // 스트리밍 버퍼 정리
            this.streamingBuffers.delete(threadId);

            // 최종 메시지 생성
            messageCompleted = true;
            // 미완료 tool call이 남아있으면 수집
            for (const [, tc] of pendingToolCalls) {
              collectedToolCalls.push({ ...tc, status: 'abandoned' });
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

          case 'rate_limit_event':
          default:
            break;
        }
      });
    }

    // stderr 에러 처리 (줄 단위 병합)
    let stderrEmitted = false;
    let stderrBuffer = '';
    const flushStderrBuffer = () => {
      const text = stderrBuffer.trim();
      stderrBuffer = '';
      if (!text) return;
      if (!this.isCurrentRun(threadId, runId, proc)) return;
      console.error('[claude stderr]', text);
      stderrEmitted = true;
      this.emit({
        type: 'error',
        threadId,
        agentType: 'claude',
        error: text,
      });
    };
    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const text = line.trim();
          if (!text) continue;
          if (!this.isCurrentRun(threadId, runId, proc)) return;
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
      if (!this.isCurrentRun(threadId, runId, proc)) return;
      flushStderrBuffer();
      this.streamingBuffers.delete(threadId);
      threadInfo.process = null as unknown as ChildProcess;
      threadInfo.runId = undefined;
      threadInfo.timeout = undefined;

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
          collectedToolCalls.push({ ...tc, status: 'abandoned' });
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

      const nextActiveThread = Array.from(this.threads.values()).find((t) => this.isProcessActive(t.process));
      if (nextActiveThread) {
        this.updateStatus('running', nextActiveThread.id, nextActiveThread);
      } else {
        this.updateStatus('idle');
      }
    });

    proc.on('error', (err) => {
      clearTimeout(processTimeout);
      if (!this.isCurrentRun(threadId, runId, proc)) return;
      this.streamingBuffers.delete(threadId);
      threadInfo.process = null as unknown as ChildProcess;
      threadInfo.runId = undefined;
      threadInfo.timeout = undefined;
      this.emit({
        type: 'error',
        threadId,
        agentType: 'claude',
        error: `Failed to spawn claude: ${err.message}`,
      });
      this.updateStatus('error', threadId, threadInfo);
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
      model: thread.model,
      sessionId: thread.sessionId,
      contextUsage: thread.contextUsage,
      config: thread.config,
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

  private isCurrentRun(threadId: string, runId: string, proc: ChildProcess): boolean {
    const thread = this.threads.get(threadId);
    return thread?.runId === runId && thread.process === proc;
  }

  private isProcessActive(proc?: ChildProcess | null): boolean {
    return !!proc && proc.exitCode === null && proc.signalCode === null && !proc.killed;
  }

  private estimateContextWindow(modelHints: Array<string | undefined>): number {
    const normalized = modelHints
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toLowerCase());

    if (normalized.some((value) => value.includes('1m'))) {
      return 1_000_000;
    }

    return 200_000;
  }

  private extractContextWindow(event: ClaudeStreamEvent): number | undefined {
    if (!event.modelUsage) return undefined;

    for (const usage of Object.values(event.modelUsage)) {
      if (typeof usage.contextWindow === 'number' && usage.contextWindow > 0) {
        return usage.contextWindow;
      }
    }

    return undefined;
  }

  private resolveThreadConfig(existingThread?: ThreadInfo): AgentConfig {
    const baseConfig = existingThread?.config || this.config || { type: 'claude' as const };
    return {
      ...baseConfig,
      type: 'claude',
      cwd: existingThread?.cwd || baseConfig.cwd || this.config?.cwd,
      env: baseConfig.env ? { ...baseConfig.env } : undefined,
    };
  }

  private updateStatus(state: AgentStatus['state'], activeThread?: string, threadInfo?: ThreadInfo): void {
    this.status.state = state;
    this.status.activeThread = activeThread;
    if (threadInfo) {
      this.status.model = threadInfo.model;
      this.status.contextUsage = threadInfo.contextUsage;
    } else if (!activeThread) {
      this.status.model = undefined;
      this.status.contextUsage = undefined;
    }

    this.emit({
      type: 'status_change',
      agentType: 'claude',
      status: { ...this.status },
    });
  }
}
