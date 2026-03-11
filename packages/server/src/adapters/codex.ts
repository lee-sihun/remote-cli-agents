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
import type { AgentAdapter, AgentEventHandler, ThreadStreamingState } from './types.js';
import * as store from '../store.js';
import { terminateChildProcess } from '../process.js';

// JSON-RPC 요청
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

// JSON-RPC 응답
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: Record<string, unknown>;
}

// Codex 이벤트 파라미터 타입
interface CodexItemDelta {
  threadId?: string;
  type?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
}

// 스레드 정보
interface ThreadInfo {
  id: string;
  title: string;
  messages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
  cwd?: string;
}

export class CodexAdapter implements AgentAdapter {
  readonly name = 'Codex';
  readonly type = 'codex' as const;

  private process: ChildProcess | null = null;
  private threads = new Map<string, ThreadInfo>();
  private eventHandlers: AgentEventHandler[] = [];
  private config: AgentConfig | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }>();
  private initialized = false;
  private status: AgentStatus = {
    agent: 'codex',
    state: 'idle',
  };

  // 현재 진행 중인 응답 텍스트 누적
  private accumulatedText = new Map<string, string>();
  private currentToolCalls = new Map<string, ToolCall>();
  private collectedToolCalls = new Map<string, ToolCall[]>(); // 완료된 도구 수집

  async start(config: AgentConfig): Promise<void> {
    this.config = config;
    const savedThreads = store.loadThreads('codex');
    for (const thread of savedThreads) {
      this.threads.set(thread.id, {
        id: thread.id,
        title: thread.title,
        messages: store.loadMessages(thread.id),
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        cwd: thread.cwd,
      });
    }
    await this.spawnAppServer();
  }

  async stop(): Promise<void> {
    if (this.process && !this.process.killed) {
      terminateChildProcess(this.process);
    }
    this.process = null;
    this.initialized = false;
    this.threads.clear();
    this.pendingRequests.clear();
    this.accumulatedText.clear();
    this.currentToolCalls.clear();
    this.updateStatus('idle');
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      execFile(cmd, ['codex'], (error) => {
        resolve(!error);
      });
    });
  }

  sendMessage(threadId: string | undefined, message: string, _config?: AgentConfig): void {
    const tid = threadId || randomUUID();
    const existingThread = this.threads.get(tid);

    if (!existingThread) {
      // 새 스레드 생성
      const now = Date.now();
      this.threads.set(tid, {
        id: tid,
        title: message.slice(0, 50),
        messages: [],
        createdAt: now,
        updatedAt: now,
        cwd: this.config?.cwd,
      });

      // 스레드 시작
      this.sendRpc('thread/start', { threadId: tid })
        .then(() => this.startTurn(tid, message))
        .catch((err) => {
          this.emit({
            type: 'error',
            threadId: tid,
            agentType: 'codex',
            error: `Failed to start thread: ${String(err)}`,
          });
        });
    } else {
      // 기존 스레드에 메시지 전송
      this.startTurn(tid, message);
    }
  }

  interrupt(threadId: string): void {
    this.sendRpc('turn/interrupt', { threadId }).catch(() => {
      // 인터럽트 실패 시 무시
    });
  }

  onEvent(handler: AgentEventHandler): void {
    this.eventHandlers.push(handler);
  }

  getStatus(): AgentStatus {
    return { ...this.status };
  }

  getStreamingState(threadId: string): ThreadStreamingState | null {
    const content = this.accumulatedText.get(threadId);
    if (content === undefined) return null;
    const tool = this.currentToolCalls.get(threadId);
    return { content, toolCalls: tool ? [tool] : [] };
  }

  async getThreads(): Promise<ThreadSummary[]> {
    return Array.from(this.threads.values()).map((t) => ({
      id: t.id,
      agentType: 'codex' as const,
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

  renameThread(threadId: string, title: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      store.renameThread('codex', threadId, title);
      return;
    }

    thread.title = title;
    store.saveThread('codex', {
      id: thread.id,
      agentType: 'codex',
      title: thread.title,
      lastMessage: thread.messages.length > 0
        ? thread.messages[thread.messages.length - 1].content.slice(0, 100)
        : undefined,
      messageCount: thread.messages.length,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      cwd: thread.cwd,
      contextUsage: this.status.contextUsage,
    });
  }

  deleteThread(threadId: string): void {
    this.accumulatedText.delete(threadId);
    this.currentToolCalls.delete(threadId);
    this.collectedToolCalls.delete(threadId);
    this.threads.delete(threadId);
    store.deleteThread('codex', threadId);

    if (this.status.activeThread === threadId) {
      this.updateStatus('idle');
    }
  }

  // app-server 프로세스 생성
  private async spawnAppServer(): Promise<void> {
    const args = ['app-server'];

    // 모델 설정
    if (this.config?.model) {
      args.push('--model', this.config.model);
    }

    // 승인 모드 설정
    const approvalMode = (this.config as unknown as Record<string, unknown>)?.approvalMode as string | undefined;
    if (approvalMode === 'full-auto') {
      args.push('--full-auto');
    } else if (approvalMode === 'never') {
      args.push('--ask-for-approval', 'never');
    } else if (approvalMode) {
      args.push('--ask-for-approval', approvalMode);
    }

    const proc = spawn('codex', args, {
      cwd: this.config?.cwd || process.cwd(),
      env: { ...process.env, ...this.config?.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    this.process = proc;

    if (proc.stdout) {
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', (line) => this.handleLine(line));
    }

    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        console.error('[codex stderr]', chunk.toString());
      });
    }

    proc.on('close', (code) => {
      console.log(`[codex] app-server exited with code ${code}`);
      this.initialized = false;
      this.updateStatus('error');
    });

    proc.on('error', (err) => {
      console.error(`[codex] Failed to spawn: ${err.message}`);
      this.updateStatus('error');
    });

    // initialization handshake
    await this.sendRpc('initialize', {
      protocolVersion: '1.0',
      clientInfo: { name: 'rca-server', version: '0.1.0' },
    });

    this.initialized = true;
  }

  // JSON-RPC 요청 전송
  private sendRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        reject(new Error('Codex app-server is not running'));
        return;
      }

      const id = ++this.requestId;
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, { resolve, reject });

      const data = JSON.stringify(request) + '\n';
      this.process.stdin.write(data, (err) => {
        if (err) {
          this.pendingRequests.delete(id);
          reject(err);
        }
      });

      // 타임아웃 (30초)
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, 30000);
    });
  }

  // turn 시작 (메시지 전송)
  private async startTurn(threadId: string, message: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;

    const now = Date.now();
    thread.messages.push({
      id: randomUUID(),
      role: 'user',
      content: message,
      timestamp: now,
    });
    thread.updatedAt = now;

    this.updateStatus('running', threadId);
    this.accumulatedText.set(threadId, '');

    this.emit({
      type: 'message_start',
      threadId,
      agentType: 'codex',
    });

    try {
      await this.sendRpc('turn/start', {
        threadId,
        message: { role: 'user', content: message },
      });
    } catch (err) {
      this.emit({
        type: 'error',
        threadId,
        agentType: 'codex',
        error: `Failed to start turn: ${String(err)}`,
      });
      this.updateStatus('idle');
    }
  }

  // stdout 라인 처리
  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    // JSON-RPC 응답 (id가 있는 경우)
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);

      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // 이벤트 (notification - id가 없고 method가 있는 경우)
    if (msg.method) {
      this.handleEvent(msg.method, (msg.params || {}) as CodexItemDelta);
    }
  }

  // Codex 이벤트 처리
  private handleEvent(method: string, params: CodexItemDelta): void {
    const threadId = params.threadId || this.status.activeThread || '';
    if (!threadId || !this.threads.has(threadId)) {
      return;
    }

    switch (method) {
      case 'turn/started': {
        this.collectedToolCalls.set(threadId, []);
        this.updateStatus('running', threadId);
        break;
      }

      case 'item/delta': {
        if (params.type === 'text' && params.text) {
          // 텍스트 델타
          const current = this.accumulatedText.get(threadId) || '';
          this.accumulatedText.set(threadId, current + params.text);

          this.emit({
            type: 'message_delta',
            threadId,
            agentType: 'codex',
            content: params.text,
          });
        } else if (params.type === 'tool_call') {
          // 도구 호출 시작
          const toolCall: ToolCall = {
            id: params.toolCallId || randomUUID(),
            name: params.toolName || 'unknown',
            input: params.toolInput || {},
            status: 'running',
          };

          this.currentToolCalls.set(threadId, toolCall);

          this.emit({
            type: 'tool_start',
            threadId,
            agentType: 'codex',
            tool: toolCall,
          });
        } else if (params.type === 'tool_result') {
          // 도구 결과
          const toolCall = this.currentToolCalls.get(threadId);
          if (toolCall) {
            toolCall.output = params.toolOutput || params.text || '';
            toolCall.status = 'completed';

            const collected = this.collectedToolCalls.get(threadId) || [];
            collected.push({ ...toolCall });
            this.collectedToolCalls.set(threadId, collected);

            this.emit({
              type: 'tool_complete',
              threadId,
              agentType: 'codex',
              tool: { ...toolCall },
            });

            this.currentToolCalls.delete(threadId);
          }
        }
        break;
      }

      case 'turn/completed': {
        const thread = this.threads.get(threadId);
        const text = this.accumulatedText.get(threadId) || '';

        // 컨텍스트 사용량 계산
        if (params.usage) {
          const totalTokens = params.usage.total_tokens
            || ((params.usage.input_tokens || 0) + (params.usage.output_tokens || 0));
          const model = this.config?.model || '';
          // Codex 모델별 컨텍스트 윈도우 크기 추정
          const contextWindow = model.includes('o3') || model.includes('o4') ? 200_000
            : model.includes('gpt-4') ? 1_047_576
            : 200_000;
          const percentage = Math.min(100, Math.round((totalTokens / contextWindow) * 100));
          this.status.contextUsage = { used: totalTokens, total: contextWindow, percentage };
        }

        const tools = this.collectedToolCalls.get(threadId) || [];
        const assistantMessage: AgentMessage = {
          id: randomUUID(),
          role: 'assistant',
          content: text,
          timestamp: Date.now(),
          toolCalls: tools.length > 0 ? tools : undefined,
          usage: params.usage ? {
            inputTokens: params.usage.input_tokens || 0,
            outputTokens: params.usage.output_tokens || 0,
          } : undefined,
        };

        if (thread) {
          thread.messages.push(assistantMessage);
          thread.updatedAt = Date.now();

          // 스레드 메타데이터 디스크 저장
          store.saveThread('codex', {
            id: thread.id,
            agentType: 'codex',
            title: thread.title,
            lastMessage: assistantMessage.content.slice(0, 100) || undefined,
            messageCount: thread.messages.length,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
            cwd: thread.cwd,
            contextUsage: this.status.contextUsage,
          });
        }

        this.emit({
          type: 'message_complete',
          threadId,
          agentType: 'codex',
          message: assistantMessage,
        });

        this.accumulatedText.delete(threadId);
        this.collectedToolCalls.delete(threadId);
        this.updateStatus('idle');
        break;
      }

      default:
        break;
    }
  }

  private emit(event: AgentEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        console.error('[codex] Event handler error:', err);
      }
    }
  }

  private updateStatus(state: AgentStatus['state'], activeThread?: string): void {
    this.status.state = state;
    this.status.activeThread = activeThread;

    this.emit({
      type: 'status_change',
      agentType: 'codex',
      status: { ...this.status },
    });
  }
}
