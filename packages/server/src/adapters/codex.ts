import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentOptionDef,
  AgentStatus,
  ContextUsage,
  ThreadSummary,
  ToolCall,
} from '@rca/shared';
import { CODEX_OPTIONS } from '@rca/shared';
import type { AgentAdapter, AgentEventHandler, ThreadStreamingState } from './types.js';
import * as store from '../store.js';
import { terminateChildProcess } from '../process.js';
import { debugLog, debugError } from '../logger.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccessResponse {
  jsonrpc?: '2.0';
  id: number;
  result: unknown;
}

interface JsonRpcErrorResponse {
  jsonrpc?: '2.0';
  id: number;
  error: { code: number; message: string };
}

interface JsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcServerRequest extends JsonRpcNotification {
  id: number;
}

interface CodexModelDescriptor {
  model: string;
  displayName: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort: string;
  isDefault: boolean;
}

interface CodexConfigRequirements {
  allowedApprovalPolicies?: string[];
  allowedSandboxModes?: string[];
}

interface ThreadInfo {
  id: string;
  remoteThreadId?: string;
  title: string;
  messages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
  cwd?: string;
  model?: string;
  contextUsage?: ContextUsage;
  config?: AgentConfig;
  path?: string;
  workspaceId?: string;
}

interface PendingRpcRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingApprovalRequest {
  id: number;
  method: string;
  threadId: string;
  toolCall: ToolCall;
  params: Record<string, unknown>;
}

interface CodexThreadPayload {
  id?: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  cwd?: string;
  name?: string | null;
  path?: string | null;
}

interface CodexTurnPayload {
  id?: string;
  status?: string;
  error?: { message?: string | null } | null;
}

interface CodexThreadStartResult {
  thread?: CodexThreadPayload;
  model?: string;
  cwd?: string;
  approvalPolicy?: string;
  reasoningEffort?: string | null;
}

const DEFAULT_CODEX_MODEL = 'gpt-5.4';
const DEFAULT_CODEX_REASONING = 'medium';
const DEFAULT_CODEX_SANDBOX = 'danger-full-access';
const DEFAULT_CODEX_APPROVAL = 'never';
const DEFAULT_CODEX_SPEED = 'standard';

export class CodexAdapter implements AgentAdapter {
  readonly name = 'Codex';
  readonly type = 'codex' as const;

  private process: ChildProcess | null = null;
  private threads = new Map<string, ThreadInfo>();
  private eventHandlers: AgentEventHandler[] = [];
  private config: AgentConfig | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, PendingRpcRequest>();
  private pendingApprovalRequests = new Map<string, PendingApprovalRequest>();
  private initialized = false;
  private status: AgentStatus = {
    agent: 'codex',
    state: 'idle',
  };

  private loadedThreadIds = new Set<string>();
  private activeTurns = new Map<string, string>();
  private accumulatedText = new Map<string, string>();
  private currentMessageIds = new Map<string, string>();
  private activeToolCalls = new Map<string, Map<string, ToolCall>>();
  private availableModels: CodexModelDescriptor[] = [];
  private configRequirements: CodexConfigRequirements | null = null;

  async start(config: AgentConfig): Promise<void> {
    this.config = normalizeCodexConfig(config);
    this.restoreStoredThreads();
    await this.spawnAppServer();
    this.config = normalizeCodexConfig(this.config, this.configRequirements);
  }

  async stop(): Promise<void> {
    if (this.process && !this.process.killed) {
      terminateChildProcess(this.process);
    }
    this.process = null;
    this.initialized = false;

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex app-server stopped'));
    }

    this.pendingRequests.clear();
    this.pendingApprovalRequests.clear();
    this.loadedThreadIds.clear();
    this.activeTurns.clear();
    this.accumulatedText.clear();
    this.currentMessageIds.clear();
    this.activeToolCalls.clear();
    this.threads.clear();
    this.availableModels = [];
    this.configRequirements = null;
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

  getOptions(): AgentOptionDef[] {
    return buildCodexOptionDefs(this.availableModels, this.configRequirements);
  }

  sendMessage(threadId: string | undefined, message: string, config?: AgentConfig): void {
    const tid = threadId || randomUUID();
    const existingThread = this.threads.get(tid);
    const runConfig = this.resolveThreadConfig(existingThread, config);

    debugLog(`[codex] Queueing turn for client thread ${tid} ${formatCodexLog({
      model: runConfig.model || '',
      approvalMode: runConfig.approvalMode || '',
      sandboxMode: readConfigString(runConfig, 'sandboxMode') || '',
      speedMode: readConfigString(runConfig, 'speedMode') || '',
      cwd: runConfig.cwd || '',
    })}`);
    void this.runTurn(tid, message, runConfig);
  }

  interrupt(threadId: string): void {
    const thread = this.threads.get(threadId);
    const turnId = this.activeTurns.get(threadId);
    if (!turnId || !thread?.remoteThreadId) {
      return;
    }

    void this.sendRpc('turn/interrupt', {
      threadId: thread.remoteThreadId,
      turnId,
    }).catch(() => {
      // 인터럽트 실패는 무시
    });
  }

  approve(threadId: string, toolCallId: string, approved: boolean): void {
    const approval = this.pendingApprovalRequests.get(toolCallId);
    if (!approval || approval.threadId !== threadId) {
      return;
    }

    const response = buildApprovalResponse(approval.method, approval.params, approved);
    debugLog(`[codex approval <-] ${approval.method} ${formatCodexLog({
      threadId,
      toolCallId,
      approved,
      response,
    })}`);
    this.writeJson({
      jsonrpc: '2.0',
      id: approval.id,
      result: response,
    });

    this.pendingApprovalRequests.delete(toolCallId);

    const active = this.activeToolCalls.get(threadId);
    const tool = active?.get(toolCallId);
    if (tool) {
      tool.status = approved ? 'running' : 'failed';
      this.upsertToolMessage(threadId, { ...tool });
    }

    this.updateStatus(this.activeTurns.size > 0 ? 'running' : 'idle', this.currentActiveThread());
  }

  onEvent(handler: AgentEventHandler): void {
    this.eventHandlers.push(handler);
  }

  getStatus(): AgentStatus {
    return {
      ...this.status,
      contextUsage: this.status.contextUsage ? { ...this.status.contextUsage } : undefined,
    };
  }

  getStreamingState(threadId: string): ThreadStreamingState | null {
    const content = this.accumulatedText.get(threadId);
    if (content === undefined) {
      return null;
    }

    return {
      content: content || '',
      toolCalls: [],
    };
  }

  async getThreads(workspaceId?: string): Promise<ThreadSummary[]> {
    let threads = Array.from(this.threads.values());
    if (workspaceId) {
      threads = threads.filter((t) => t.workspaceId === workspaceId);
    }
    return threads
      .map((thread) => toThreadSummary(thread))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  renameThread(threadId: string, title: string, workspaceId?: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      store.renameThread('codex', threadId, title, workspaceId || 'default');
      return;
    }

    thread.title = title;
    thread.updatedAt = Date.now();
    persistThread(thread);
  }

  deleteThread(threadId: string, workspaceId?: string): void {
    this.pendingApprovalRequests.forEach((request, toolCallId) => {
      if (request.threadId === threadId) {
        this.pendingApprovalRequests.delete(toolCallId);
      }
    });
    this.activeTurns.delete(threadId);
    this.loadedThreadIds.delete(threadId);
    this.accumulatedText.delete(threadId);
    this.currentMessageIds.delete(threadId);
    this.activeToolCalls.delete(threadId);
    const thread = this.threads.get(threadId);
    this.threads.delete(threadId);
    store.deleteThread('codex', threadId, workspaceId || thread?.workspaceId || 'default');

    if (this.status.activeThread === threadId) {
      this.updateStatus(this.activeTurns.size > 0 ? 'running' : 'idle', this.currentActiveThread());
    }
  }

  private restoreStoredThreads(): void {
    const workspaces = store.loadWorkspaces();
    // 워크스페이스 없으면 'default'에서만 로드
    const wsIds = workspaces.length > 0 ? workspaces.map((ws) => ws.id) : ['default'];

    for (const wsId of wsIds) {
      const savedThreads = store.loadThreads('codex', wsId);
      for (const thread of savedThreads) {
        this.threads.set(thread.id, {
          id: thread.id,
          remoteThreadId: thread.remoteThreadId,
          title: thread.title,
          messages: store.loadMessages(thread.id),
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          cwd: thread.cwd,
          model: thread.model,
          contextUsage: thread.contextUsage,
          config: thread.config,
          workspaceId: wsId,
        });
      }
    }
  }

  private async spawnAppServer(): Promise<void> {
    const proc = spawn('codex', ['app-server'], {
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
        debugError('[codex stderr]', chunk.toString());
      });
    }

    proc.on('close', (code) => {
      this.initialized = false;
      for (const pending of this.pendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Codex app-server exited with code ${String(code)}`));
      }
      this.pendingRequests.clear();
      this.updateStatus('error');
    });

    proc.on('error', (err) => {
      console.error(`[codex] Failed to spawn: ${err.message}`);
      this.updateStatus('error');
    });

    await this.sendRpc('initialize', {
      clientInfo: { name: 'rca-server', version: '0.1.0' },
      capabilities: {
        experimentalApi: true,
      },
    });

    this.initialized = true;
    await this.refreshModels();
    await this.refreshConfigRequirements();
  }

  private async refreshModels(): Promise<void> {
    try {
      const result = await this.sendRpc('model/list', {
        cursor: null,
        includeHidden: false,
      }) as { data?: Array<Record<string, unknown>> };

      this.availableModels = (result.data || [])
        .map((model) => toCodexModelDescriptor(model))
        .filter((model): model is CodexModelDescriptor => model !== null);
    } catch (error) {
      console.error('[codex] Failed to load model list:', error);
      this.availableModels = [];
    }
  }

  private async refreshConfigRequirements(): Promise<void> {
    try {
      const result = await this.sendRpc('configRequirements/read', {}, 1_500) as {
        requirements?: Record<string, unknown> | null;
      };
      const requirements = result.requirements;
      if (!requirements || typeof requirements !== 'object') {
        this.configRequirements = null;
        return;
      }

      this.configRequirements = {
        allowedApprovalPolicies: normalizeCodexRequirementValues(
          readArray(requirements, 'allowedApprovalPolicies'),
          normalizeCodexApprovalPolicy,
        ),
        allowedSandboxModes: normalizeCodexRequirementValues(
          readArray(requirements, 'allowedSandboxModes'),
          normalizeCodexSandboxMode,
        ),
      };
    } catch (error) {
      console.error('[codex] Failed to load config requirements:', error);
      this.configRequirements = null;
    }
  }

  private async runTurn(threadId: string, message: string, config: AgentConfig): Promise<void> {
    const threadExists = this.threads.has(threadId);
    const thread = this.ensureThread(threadId, config, message);
    const userMessage: AgentMessage = {
      id: randomUUID(),
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };

    thread.messages.push(userMessage);
    thread.updatedAt = userMessage.timestamp;
    thread.config = config;
    store.appendMessage(threadId, userMessage);
    persistThread(thread);

    this.accumulatedText.set(threadId, '');
    this.currentMessageIds.delete(threadId);
    this.activeToolCalls.delete(threadId);

    this.emit({
      type: 'message_start',
      threadId,
      agentType: 'codex',
    });

    try {
      await this.ensureThreadLoaded(thread, config, threadExists);
      if (!thread.remoteThreadId) {
        throw new Error('Codex thread id was not initialized');
      }
      const result = await this.sendRpc('turn/start', {
        threadId: thread.remoteThreadId,
        input: [
          {
            type: 'text',
            text: message,
            text_elements: [],
          },
        ],
      }) as { turn?: CodexTurnPayload };

      if (result.turn?.id) {
        this.markTurnActive(threadId, result.turn.id);
      } else {
        this.updateStatus('running', threadId);
      }
    } catch (error) {
      this.accumulatedText.delete(threadId);
      this.currentMessageIds.delete(threadId);
      this.activeToolCalls.delete(threadId);
      this.emit({
        type: 'error',
        threadId,
        agentType: 'codex',
        error: `Failed to start Codex turn: ${error instanceof Error ? error.message : String(error)}`,
      });
      this.updateStatus(this.activeTurns.size > 0 ? 'running' : 'idle', this.currentActiveThread());
    }
  }

  private ensureThread(threadId: string, config: AgentConfig, fallbackTitle: string): ThreadInfo {
    const existing = this.threads.get(threadId);
    if (existing) {
      if (!existing.cwd) {
        existing.cwd = config.cwd;
      }
      if (!existing.config) {
        existing.config = config;
      }
      return existing;
    }

    const now = Date.now();
    const thread: ThreadInfo = {
      id: threadId,
      title: summarizeTitle(fallbackTitle),
      messages: [],
      createdAt: now,
      updatedAt: now,
      cwd: config.cwd,
      workspaceId: config.workspaceId,
      config,
    };
    this.threads.set(threadId, thread);
    return thread;
  }

  private resolveThreadConfig(existingThread?: ThreadInfo, overrideConfig?: AgentConfig): AgentConfig {
    const baseConfig = {
      ...(this.config || { type: 'codex' as const }),
      ...(existingThread?.config || {}),
      ...(overrideConfig || {}),
    };

    return normalizeCodexConfig({
      ...baseConfig,
      type: 'codex',
      cwd: existingThread?.cwd || overrideConfig?.cwd || baseConfig.cwd || this.config?.cwd,
      env: baseConfig.env ? { ...baseConfig.env } : undefined,
    }, this.configRequirements);
  }

  private async ensureThreadLoaded(thread: ThreadInfo, config: AgentConfig, existingThread: boolean): Promise<void> {
    if (this.loadedThreadIds.has(thread.id) && thread.remoteThreadId) {
      return;
    }

    const params = buildThreadConfigParams(config, this.configRequirements);
    const canResume = existingThread && Boolean(thread.remoteThreadId);
    const result = canResume
      ? await this.sendRpc('thread/resume', {
        threadId: thread.remoteThreadId,
        persistExtendedHistory: false,
        ...params,
      }) as CodexThreadStartResult
      : await this.sendRpc('thread/start', {
        experimentalRawEvents: false,
        persistExtendedHistory: false,
        ...params,
      }) as CodexThreadStartResult;

    this.loadedThreadIds.add(thread.id);
    this.updateThreadFromPayload(thread, result.thread, result.model, config);
  }

  private sendRpc(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
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

      debugLog(`[codex rpc ->] ${method} ${formatCodexLog(params || {})}`);

      const timer = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          return;
        }

        this.pendingRequests.delete(id);
        debugError(`[codex rpc !!] ${method} timeout`);
        pending.reject(new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { method, resolve, reject, timer });
      this.writeJson(request as unknown as Record<string, unknown>);
    });
  }

  private writeJson(payload: Record<string, unknown>): void {
    if (!this.process?.stdin) {
      return;
    }

    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    let parsed:
      | JsonRpcSuccessResponse
      | JsonRpcErrorResponse
      | JsonRpcNotification
      | JsonRpcServerRequest;

    try {
      parsed = JSON.parse(trimmed) as typeof parsed;
    } catch {
      return;
    }

    if ('id' in parsed && typeof parsed.id === 'number' && !('method' in parsed)) {
      const pending = this.pendingRequests.get(parsed.id);
      if (!pending) {
        return;
      }

      clearTimeout(pending.timer);
      this.pendingRequests.delete(parsed.id);

      if ('error' in parsed) {
        debugError(`[codex rpc !!] ${pending.method} ${formatCodexLog(parsed.error)}`);
        pending.reject(new Error(parsed.error.message));
      } else {
        debugLog(`[codex rpc <-] ${pending.method} ${formatCodexLog(parsed.result)}`);
        pending.resolve(parsed.result);
      }
      return;
    }

    if ('id' in parsed && typeof parsed.id === 'number' && 'method' in parsed) {
      debugLog(`[codex approval ->] ${parsed.method} ${formatCodexLog(parsed.params || {})}`);
      this.handleServerRequest(parsed);
      return;
    }

    if ('method' in parsed) {
      if (shouldLogCodexNotification(parsed.method)) {
        debugLog(`[codex event] ${parsed.method} ${formatCodexLog(parsed.params || {})}`);
      }
      this.handleNotification(parsed.method, parsed.params || {});
    }
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    const params = request.params || {};
    const remoteThreadId = readString(params, 'threadId')
      || readString(params, 'conversationId');
    const threadId = (remoteThreadId && this.resolveClientThreadId(remoteThreadId))
      || this.currentActiveThread()
      || '';

    if (!threadId || !this.threads.has(threadId)) {
      this.writeJson({
        jsonrpc: '2.0',
        id: request.id,
        result: buildApprovalResponse(request.method, params, false),
      });
      return;
    }

    const toolCall = buildApprovalToolCall(request.method, params);
    if (!toolCall) {
      this.writeJson({
        jsonrpc: '2.0',
        id: request.id,
        result: buildApprovalResponse(request.method, params, false),
      });
      return;
    }

    const active = this.getOrCreateActiveTools(threadId);
    active.set(toolCall.id, toolCall);
    this.pendingApprovalRequests.set(toolCall.id, {
      id: request.id,
      method: request.method,
      threadId,
      toolCall,
      params,
    });

    this.flushAssistantText(threadId);
    this.upsertToolMessage(threadId, { ...toolCall });
    this.updateStatus('waiting_approval', threadId);
    this.emit({
      type: 'approval_required',
      threadId,
      agentType: 'codex',
      tool: { ...toolCall },
    });
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'thread/started': {
        const payload = readRecord(params, 'thread');
        const payloadId = payload ? readString(payload, 'id') : undefined;
        if (!payload || !payloadId) {
          return;
        }
        const thread = this.findThreadByRemoteId(payloadId);
        if (!thread) {
          return;
        }
        this.loadedThreadIds.add(thread.id);
        this.updateThreadFromPayload(thread, payload, undefined, thread.config || this.config || undefined);
        break;
      }

      case 'thread/name/updated': {
        const remoteThreadId = readString(params, 'threadId');
        const threadId = remoteThreadId ? this.resolveClientThreadId(remoteThreadId) : undefined;
        const name = readString(params, 'threadName');
        if (!threadId || !name) {
          return;
        }
        const thread = this.threads.get(threadId);
        if (!thread) {
          return;
        }
        thread.title = name;
        thread.updatedAt = Date.now();
        persistThread(thread);
        break;
      }

      case 'thread/status/changed': {
        const remoteThreadId = readString(params, 'threadId');
        const threadId = remoteThreadId ? this.resolveClientThreadId(remoteThreadId) : undefined;
        const status = readRecord(params, 'status');
        if (!threadId || !status || this.activeTurns.has(threadId)) {
          return;
        }
        if (status.type === 'systemError') {
          this.emit({
            type: 'error',
            threadId,
            agentType: 'codex',
            error: 'Codex thread entered systemError state.',
          });
          this.updateStatus('error', threadId);
        }
        break;
      }

      case 'thread/tokenUsage/updated': {
        const remoteThreadId = readString(params, 'threadId');
        const threadId = remoteThreadId ? this.resolveClientThreadId(remoteThreadId) : undefined;
        const tokenUsage = readRecord(params, 'tokenUsage');
        if (!threadId || !tokenUsage) {
          return;
        }

        const total = readRecord(tokenUsage, 'total');
        const modelContextWindow = readNumber(tokenUsage, 'modelContextWindow');
        if (!total || modelContextWindow === undefined) {
          return;
        }

        const usage = createContextUsage(
          readNumber(total, 'totalTokens') || 0,
          modelContextWindow,
        );

        const thread = this.threads.get(threadId);
        if (thread) {
          thread.contextUsage = usage;
          persistThread(thread);
        }

        if (this.status.activeThread === threadId) {
          this.status.contextUsage = usage;
          this.emitStatusChange();
        }
        break;
      }

      case 'turn/started': {
        const remoteThreadId = readString(params, 'threadId');
        const threadId = remoteThreadId ? this.resolveClientThreadId(remoteThreadId) : undefined;
        const turn = readRecord(params, 'turn');
        const turnId = turn ? readString(turn, 'id') : undefined;
        if (!threadId || !turnId) {
          return;
        }

        this.markTurnActive(threadId, turnId);
        break;
      }

      case 'item/agentMessage/delta': {
        const remoteThreadId = readString(params, 'threadId');
        const threadId = remoteThreadId ? this.resolveClientThreadId(remoteThreadId) : undefined;
        const itemId = readString(params, 'itemId');
        const delta = readString(params, 'delta');
        if (!threadId || !delta) {
          return;
        }

        const current = this.accumulatedText.get(threadId) || '';
        this.accumulatedText.set(threadId, current + delta);
        if (itemId) {
          this.currentMessageIds.set(threadId, itemId);
        }

        this.emit({
          type: 'message_delta',
          threadId,
          agentType: 'codex',
          content: delta,
        });
        break;
      }

      case 'item/started': {
        this.handleItemStarted(params);
        break;
      }

      case 'item/completed': {
        this.handleItemCompleted(params);
        break;
      }

      case 'model/rerouted': {
        const remoteThreadId = readString(params, 'threadId');
        const threadId = remoteThreadId ? this.resolveClientThreadId(remoteThreadId) : undefined;
        const toModel = readString(params, 'toModel');
        if (!threadId || !toModel) {
          return;
        }

        const thread = this.threads.get(threadId);
        if (!thread) {
          return;
        }

        thread.model = toModel;
        persistThread(thread);

        if (this.status.activeThread === threadId) {
          this.status.model = toModel;
          this.emitStatusChange();
        }
        break;
      }

      case 'turn/completed': {
        this.handleTurnCompleted(params);
        break;
      }

      case 'error': {
        const remoteThreadId = readString(params, 'threadId');
        const threadId = (remoteThreadId && this.resolveClientThreadId(remoteThreadId))
          || this.currentActiveThread()
          || '';
        const message = readString(params, 'message') || 'Codex app-server error';
        this.emit({
          type: 'error',
          threadId,
          agentType: 'codex',
          error: message,
        });
        this.updateStatus('error', threadId || undefined);
        break;
      }

      default:
        break;
    }
  }

  private handleItemStarted(params: Record<string, unknown>): void {
    const remoteThreadId = readString(params, 'threadId');
    const threadId = remoteThreadId ? this.resolveClientThreadId(remoteThreadId) : undefined;
    const item = readRecord(params, 'item');
    if (!threadId || !item) {
      return;
    }

    if (item.type === 'agentMessage') {
      const itemId = readString(item, 'id');
      const currentMessageId = this.currentMessageIds.get(threadId);
      if (itemId && currentMessageId && currentMessageId !== itemId) {
        this.flushAssistantText(threadId);
      }
      if (itemId) {
        this.currentMessageIds.set(threadId, itemId);
      }
      return;
    }

    const toolCall = mapThreadItemToToolCall(item);
    if (!toolCall) {
      return;
    }

    this.flushAssistantText(threadId);
    this.getOrCreateActiveTools(threadId).set(toolCall.id, toolCall);
    this.upsertToolMessage(threadId, { ...toolCall });
  }

  private handleItemCompleted(params: Record<string, unknown>): void {
    const remoteThreadId = readString(params, 'threadId');
    const threadId = remoteThreadId ? this.resolveClientThreadId(remoteThreadId) : undefined;
    const item = readRecord(params, 'item');
    if (!threadId || !item) {
      return;
    }

    if (item.type === 'agentMessage') {
      const itemId = readString(item, 'id');
      const text = readString(item, 'text');
      if (itemId) {
        this.currentMessageIds.set(threadId, itemId);
      }
      if (text !== undefined && !(this.accumulatedText.get(threadId) || '').trim()) {
        this.accumulatedText.set(threadId, text);
      }
      this.flushAssistantText(threadId);
      return;
    }

    const active = this.activeToolCalls.get(threadId);
    const itemId = readString(item, 'id');
    if (!active || !itemId) {
      return;
    }

    const existing = active.get(itemId);
    if (!existing) {
      return;
    }

    const completed = mapThreadItemToToolCall(item, existing);
    if (!completed) {
      return;
    }

    active.delete(itemId);
    this.upsertToolMessage(threadId, { ...completed });
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    const remoteThreadId = readString(params, 'threadId');
    const threadId = remoteThreadId ? this.resolveClientThreadId(remoteThreadId) : undefined;
    const turn = readRecord(params, 'turn');
    if (!threadId || !turn) {
      return;
    }

    const thread = this.threads.get(threadId);
    const turnId = readString(turn, 'id');
    const turnStatus = readString(turn, 'status');
    const error = readRecord(turn, 'error');

    if (turnId) {
      this.activeTurns.delete(threadId);
    }

    const errorMessage = error ? readString(error, 'message') : undefined;
    if (turnStatus === 'failed' && errorMessage) {
      this.emit({
        type: 'error',
        threadId,
        agentType: 'codex',
        error: errorMessage,
      });
    }

    if (thread) {
      this.flushAssistantText(threadId);
    }

    this.accumulatedText.delete(threadId);
    this.currentMessageIds.delete(threadId);
    this.activeToolCalls.delete(threadId);
    this.updateStatus(this.activeTurns.size > 0 ? 'running' : 'idle', this.currentActiveThread());
  }

  private flushAssistantText(threadId: string): void {
    const content = this.accumulatedText.get(threadId) || '';
    const trimmed = content.trim();
    const thread = this.threads.get(threadId);

    this.accumulatedText.set(threadId, '');

    if (!thread || !trimmed) {
      this.currentMessageIds.delete(threadId);
      return;
    }

    const message: AgentMessage = {
      id: this.currentMessageIds.get(threadId) || randomUUID(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      model: thread.model,
    };

    this.currentMessageIds.delete(threadId);
    this.upsertAssistantMessage(threadId, message);
  }

  private upsertToolMessage(threadId: string, tool: ToolCall): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }

    const existing = thread.messages.find((message) => message.id === tool.id);
    this.upsertAssistantMessage(threadId, {
      id: tool.id,
      role: 'assistant',
      content: '',
      timestamp: existing?.timestamp || Date.now(),
      toolCalls: [{ ...tool }],
      model: thread.model,
    });
  }

  private upsertAssistantMessage(threadId: string, message: AgentMessage): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }

    const existingIndex = thread.messages.findIndex((entry) => entry.id === message.id);
    if (existingIndex >= 0) {
      thread.messages[existingIndex] = message;
    } else {
      thread.messages.push(message);
    }

    thread.updatedAt = message.timestamp;
    store.saveMessages(threadId, thread.messages);
    persistThread(thread);
    this.emit({
      type: 'message_complete',
      threadId,
      agentType: 'codex',
      message,
    });
  }

  private markTurnActive(threadId: string, turnId: string): void {
    if (this.activeTurns.has(threadId)) {
      this.activeTurns.delete(threadId);
    }
    this.activeTurns.set(threadId, turnId);

    const thread = this.threads.get(threadId);
    this.status.state = 'running';
    this.status.activeThread = threadId;
    this.status.model = thread?.model;
    this.status.contextUsage = thread?.contextUsage;
    this.emitStatusChange();
  }

  private currentActiveThread(): string | undefined {
    const activeThreads = Array.from(this.activeTurns.keys());
    return activeThreads[activeThreads.length - 1];
  }

  private findThreadByRemoteId(remoteThreadId: string): ThreadInfo | undefined {
    for (const thread of this.threads.values()) {
      if (thread.remoteThreadId === remoteThreadId) {
        return thread;
      }
    }

    return this.threads.get(remoteThreadId);
  }

  private resolveClientThreadId(remoteThreadId: string): string | undefined {
    return this.findThreadByRemoteId(remoteThreadId)?.id;
  }

  private updateThreadFromPayload(
    thread: ThreadInfo,
    payload?: CodexThreadPayload,
    model?: string,
    config?: AgentConfig,
  ): void {
    if (payload?.id) {
      thread.remoteThreadId = payload.id;
    }
    if (payload?.name) {
      thread.title = payload.name;
    } else if (!thread.title && payload?.preview) {
      thread.title = summarizeTitle(payload.preview);
    }

    if (payload?.createdAt) {
      thread.createdAt = payload.createdAt * 1000;
    }
    if (payload?.updatedAt) {
      thread.updatedAt = payload.updatedAt * 1000;
    }
    if (payload?.cwd) {
      thread.cwd = payload.cwd;
    }
    if (payload?.path) {
      thread.path = payload.path;
    }
    if (model) {
      thread.model = model;
    }
    if (config) {
      thread.config = config;
    }

    persistThread(thread);
  }

  private getOrCreateActiveTools(threadId: string): Map<string, ToolCall> {
    const existing = this.activeToolCalls.get(threadId);
    if (existing) {
      return existing;
    }

    const created = new Map<string, ToolCall>();
    this.activeToolCalls.set(threadId, created);
    return created;
  }

  private emit(event: AgentEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('[codex] Event handler error:', error);
      }
    }
  }

  private updateStatus(state: AgentStatus['state'], activeThread?: string): void {
    this.status = {
      ...this.status,
      state,
      activeThread,
    };

    if (!activeThread) {
      this.status.model = undefined;
      this.status.contextUsage = undefined;
    }

    this.emitStatusChange();
  }

  private emitStatusChange(): void {
    this.emit({
      type: 'status_change',
      agentType: 'codex',
      status: this.getStatus(),
    });
  }
}

function normalizeCodexConfig(
  config: AgentConfig,
  requirements: CodexConfigRequirements | null = null,
): AgentConfig {
  const normalized = { ...config };
  const normalizedRecord = normalized as Record<string, unknown>;
  const approvalMode = normalizeConfigSelection(
    normalized.approvalMode,
    normalizeCodexApprovalPolicy,
    DEFAULT_CODEX_APPROVAL,
    requirements?.allowedApprovalPolicies,
  );
  const sandboxMode = normalizeConfigSelection(
    readConfigString(normalized, 'sandboxMode'),
    normalizeCodexSandboxMode,
    DEFAULT_CODEX_SANDBOX,
    requirements?.allowedSandboxModes,
  );

  if (approvalMode) {
    normalized.approvalMode = approvalMode;
  } else {
    delete normalized.approvalMode;
  }

  if (sandboxMode) {
    normalizedRecord.sandboxMode = sandboxMode;
  } else {
    delete normalizedRecord.sandboxMode;
  }

  if (normalizedRecord.speedMode && !isSpeedMode(normalizedRecord.speedMode)) {
    normalizedRecord.speedMode = DEFAULT_CODEX_SPEED;
  }

  if (normalized.effortLevel && !isReasoningEffort(normalized.effortLevel)) {
    normalized.effortLevel = DEFAULT_CODEX_REASONING;
  }

  return normalized;
}

function buildThreadConfigParams(
  config: AgentConfig,
  requirements: CodexConfigRequirements | null = null,
): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  if (config.cwd) {
    params.cwd = config.cwd;
  }
  if (config.model) {
    params.model = config.model;
  }
  const approvalMode = normalizeConfigSelection(
    config.approvalMode,
    normalizeCodexApprovalPolicy,
    DEFAULT_CODEX_APPROVAL,
    requirements?.allowedApprovalPolicies,
  );
  if (approvalMode) {
    params.approvalPolicy = approvalMode;
  }

  const sandboxMode = normalizeConfigSelection(
    readConfigString(config, 'sandboxMode'),
    normalizeCodexSandboxMode,
    DEFAULT_CODEX_SANDBOX,
    requirements?.allowedSandboxModes,
  );
  if (sandboxMode) {
    params.sandbox = sandboxMode;
  }

  const speedMode = readConfigString(config, 'speedMode');
  if (config.model === 'gpt-5.4' && speedMode === 'fast') {
    params.serviceTier = 'fast';
  }

  return params;
}

function buildCodexOptionDefs(
  models: CodexModelDescriptor[],
  requirements: CodexConfigRequirements | null = null,
): AgentOptionDef[] {
  const approvalOptions = filterCodexApprovalOptions(requirements);
  const sandboxOptions = filterCodexSandboxOptions(requirements);
  const defaultApproval = resolveOptionDefault(approvalOptions, DEFAULT_CODEX_APPROVAL);
  const defaultSandbox = resolveOptionDefault(sandboxOptions, DEFAULT_CODEX_SANDBOX);

  if (models.length === 0) {
    return CODEX_OPTIONS.map((option) => {
      if (option.key === 'approvalMode') {
        return {
          ...option,
          options: approvalOptions,
          defaultValue: defaultApproval,
        };
      }
      if (option.key === 'sandboxMode') {
        return {
          ...option,
          options: sandboxOptions,
          defaultValue: defaultSandbox,
        };
      }
      return option;
    });
  }

  const modelOptions = [
    { value: '', label: 'Default' },
    ...models.map((model) => ({
      value: model.model,
      label: formatCodexModelLabel(model.displayName),
    })),
  ];

  const defaultModel = models.find((model) => model.model === DEFAULT_CODEX_MODEL)?.model
    || models.find((model) => model.isDefault)?.model
    || models[0]?.model
    || DEFAULT_CODEX_MODEL;
  const effortOptions = Array.from(new Map(
    models.flatMap((model) => model.supportedReasoningEfforts).map((effort) => [effort, effort]),
  ).values()).map((effort) => ({
    value: effort,
    label: effort === 'xhigh' ? 'XHigh' : capitalize(effort),
  }));

  return [
    {
      key: 'model',
      label: 'Model',
      type: 'select',
      options: modelOptions,
      defaultValue: defaultModel,
      description: 'Codex app-server model/list 기준',
    },
    {
      key: 'effortLevel',
      label: 'Reasoning',
      type: 'select',
      options: effortOptions,
      defaultValue: models.find((model) => model.model === defaultModel)?.defaultReasoningEffort || DEFAULT_CODEX_REASONING,
      visibleWhen: effortOptions.length > 0 ? { model: models.map((model) => model.model) } : undefined,
      description: '선택 모델의 reasoning effort',
    },
    {
      key: 'approvalMode',
      label: 'Approval',
      type: 'select',
      options: approvalOptions,
      defaultValue: defaultApproval,
      description: 'Codex ask-for-approval 정책',
    },
    {
      key: 'sandboxMode',
      label: 'Access',
      type: 'select',
      options: sandboxOptions,
      defaultValue: defaultSandbox,
      description: 'Codex sandbox 모드',
    },
    {
      key: 'speedMode',
      label: 'Speed',
      type: 'select',
      options: [
        { value: 'standard', label: 'Standard' },
        { value: 'fast', label: 'Fast' },
      ],
      defaultValue: DEFAULT_CODEX_SPEED,
      visibleWhen: {
        model: ['gpt-5.4'],
      },
      description: 'GPT-5.4 Fast 모드',
    },
  ];
}

function buildApprovalToolCall(method: string, params: Record<string, unknown>): ToolCall | null {
  const itemId = readString(params, 'itemId')
    || readString(params, 'approvalId')
    || readString(params, 'callId')
    || randomUUID();

  switch (method) {
    case 'item/commandExecution/requestApproval':
      return {
        id: itemId,
        name: 'commandExecution',
        input: {
          command: readString(params, 'command') || '',
          cwd: readString(params, 'cwd') || '',
          reason: readString(params, 'reason') || '',
        },
        status: 'requires_approval',
      };

    case 'item/fileChange/requestApproval':
      return {
        id: itemId,
        name: 'fileChange',
        input: {
          reason: readString(params, 'reason') || '',
          grantRoot: readString(params, 'grantRoot') || '',
        },
        status: 'requires_approval',
      };

    case 'item/permissions/requestApproval':
      return {
        id: itemId,
        name: 'permissions',
        input: {
          reason: readString(params, 'reason') || '',
          permissions: readRecord(params, 'permissions') || {},
        },
        status: 'requires_approval',
      };

    case 'execCommandApproval':
      return {
        id: itemId,
        name: 'commandExecution',
        input: {
          command: readArray(params, 'command') || [],
          cwd: readString(params, 'cwd') || '',
          reason: readString(params, 'reason') || '',
        },
        status: 'requires_approval',
      };

    case 'applyPatchApproval':
      return {
        id: itemId,
        name: 'fileChange',
        input: {
          reason: readString(params, 'reason') || '',
          grantRoot: readString(params, 'grantRoot') || '',
          fileChanges: readRecord(params, 'fileChanges') || {},
        },
        status: 'requires_approval',
      };

    default:
      return null;
  }
}

function buildApprovalResponse(
  method: string,
  params: Record<string, unknown>,
  approved: boolean,
): Record<string, unknown> {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'execCommandApproval':
      return { decision: approved ? 'approved' : 'denied' };

    case 'item/fileChange/requestApproval':
    case 'applyPatchApproval':
      return { decision: approved ? 'accept' : 'decline' };

    case 'item/permissions/requestApproval':
      return approved
        ? { permissions: readRecord(params, 'permissions') || {}, scope: 'turn' }
        : { permissions: {}, scope: 'turn' };

    default:
      return {};
  }
}

function mapThreadItemToToolCall(item: Record<string, unknown>, existing?: ToolCall): ToolCall | null {
  const itemId = readString(item, 'id');
  if (!itemId) {
    return null;
  }

  switch (item.type) {
    case 'commandExecution':
      return {
        id: itemId,
        name: 'commandExecution',
        input: {
          command: readString(item, 'command') || '',
          cwd: readString(item, 'cwd') || '',
        },
        output: readString(item, 'aggregatedOutput') || existing?.output,
        status: mapToolStatus(readString(item, 'status'), existing ? 'completed' : 'running'),
      };

    case 'fileChange':
      return {
        id: itemId,
        name: 'fileChange',
        input: {
          changes: readArray(item, 'changes') || [],
        },
        status: mapPatchStatus(readString(item, 'status'), existing ? 'completed' : 'running'),
      };

    case 'mcpToolCall': {
      const server = readString(item, 'server') || 'mcp';
      const tool = readString(item, 'tool') || 'tool';
      const error = readRecord(item, 'error');
      return {
        id: itemId,
        name: `mcp:${server}/${tool}`,
        input: readRecord(item, 'arguments') || {},
        output: error ? JSON.stringify(error) : JSON.stringify(readRecord(item, 'result') || {}),
        status: mapToolStatus(readString(item, 'status'), existing ? 'completed' : 'running'),
      };
    }

    case 'dynamicToolCall':
      return {
        id: itemId,
        name: readString(item, 'tool') || 'dynamicTool',
        input: readRecord(item, 'arguments') || {},
        output: JSON.stringify(readArray(item, 'contentItems') || []),
        status: mapDynamicToolStatus(readString(item, 'status'), existing ? 'completed' : 'running'),
      };

    case 'webSearch':
      return {
        id: itemId,
        name: 'webSearch',
        input: {
          query: readString(item, 'query') || '',
          action: readRecord(item, 'action') || null,
        },
        status: existing ? 'completed' : 'running',
      };

    default:
      return existing ? { ...existing } : null;
  }
}

function mapToolStatus(status: string | undefined, fallback: ToolCall['status']): ToolCall['status'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
    case 'denied':
    case 'aborted':
      return 'failed';
    case 'inProgress':
    case 'pending':
      return 'running';
    default:
      return fallback;
  }
}

function mapPatchStatus(status: string | undefined, fallback: ToolCall['status']): ToolCall['status'] {
  switch (status) {
    case 'applied':
    case 'completed':
      return 'completed';
    case 'failed':
    case 'rejected':
    case 'cancelled':
      return 'failed';
    case 'pending':
      return 'running';
    default:
      return fallback;
  }
}

function mapDynamicToolStatus(status: string | undefined, fallback: ToolCall['status']): ToolCall['status'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'pending':
    case 'running':
      return 'running';
    default:
      return fallback;
  }
}

function toCodexModelDescriptor(model: Record<string, unknown>): CodexModelDescriptor | null {
  const modelId = readString(model, 'model');
  const displayName = readString(model, 'displayName');
  if (!modelId || !displayName) {
    return null;
  }

  return {
    model: modelId,
    displayName,
    supportedReasoningEfforts: (readArray(model, 'supportedReasoningEfforts') || [])
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (entry && typeof entry === 'object' && typeof (entry as { reasoningEffort?: unknown }).reasoningEffort === 'string') {
          return (entry as { reasoningEffort: string }).reasoningEffort;
        }
        return null;
      })
      .filter((effort): effort is string => Boolean(effort)),
    defaultReasoningEffort: readString(model, 'defaultReasoningEffort') || DEFAULT_CODEX_REASONING,
    isDefault: Boolean(model.isDefault),
  };
}

function formatCodexModelLabel(label: string): string {
  return label
    .split('-')
    .map((part) => {
      const normalized = part.trim();
      if (!normalized) {
        return normalized;
      }

      if (normalized.toLowerCase() === 'gpt') {
        return 'GPT';
      }

      if (/^[a-z][a-z0-9]*$/i.test(normalized)) {
        const lower = normalized.toLowerCase();
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      }

      return normalized;
    })
    .join('-');
}

function toThreadSummary(thread: ThreadInfo): ThreadSummary {
  return {
    id: thread.id,
    agentType: 'codex',
    title: thread.title,
    lastMessage: thread.messages.length > 0
      ? thread.messages[thread.messages.length - 1]?.content.slice(0, 100)
      : undefined,
    messageCount: thread.messages.length,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    cwd: thread.cwd,
    workspaceId: thread.workspaceId,
    model: thread.model,
    contextUsage: thread.contextUsage,
    remoteThreadId: thread.remoteThreadId,
    config: thread.config,
  };
}

function persistThread(thread: ThreadInfo): void {
  store.saveThread('codex', toThreadSummary(thread), thread.workspaceId || 'default');
}

function summarizeTitle(content: string): string {
  return content.trim().slice(0, 50) || 'New conversation';
}

function createContextUsage(used: number, total: number): ContextUsage {
  return {
    used,
    total,
    percentage: total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0,
  };
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' ? value : undefined;
}

function readRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = obj[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readArray(obj: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = obj[key];
  return Array.isArray(value) ? value : undefined;
}

function readConfigString(config: AgentConfig, key: string): string | undefined {
  const value = (config as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function codexApprovalOptions(): Array<{ value: string; label: string }> {
  return [
    { value: 'on-request', label: 'On Request' },
    { value: 'untrusted', label: 'Unless Trusted' },
    { value: 'never', label: 'Never Ask' },
    { value: 'on-failure', label: 'On Failure' },
  ];
}

function codexSandboxOptions(): Array<{ value: string; label: string }> {
  return [
    { value: 'workspace-write', label: 'Workspace Write' },
    { value: 'danger-full-access', label: 'Full Access' },
    { value: 'read-only', label: 'Read Only' },
  ];
}

function filterCodexApprovalOptions(
  requirements: CodexConfigRequirements | null,
): Array<{ value: string; label: string }> {
  const options = codexApprovalOptions();
  const allowed = requirements?.allowedApprovalPolicies;
  if (!allowed) {
    return options;
  }

  return options.filter((option) => allowed.includes(option.value));
}

function filterCodexSandboxOptions(
  requirements: CodexConfigRequirements | null,
): Array<{ value: string; label: string }> {
  const options = codexSandboxOptions();
  const allowed = requirements?.allowedSandboxModes;
  if (!allowed) {
    return options;
  }

  return options.filter((option) => allowed.includes(option.value));
}

function normalizeCodexApprovalPolicy(value: unknown): string | null {
  switch (normalizeCodexEnumValue(value)) {
    case 'on-request':
      return 'on-request';
    case 'unless-trusted':
    case 'untrusted':
      return 'untrusted';
    case 'never':
      return 'never';
    case 'on-failure':
      return 'on-failure';
    default:
      return null;
  }
}

function normalizeCodexSandboxMode(value: unknown): string | null {
  switch (normalizeCodexEnumValue(value)) {
    case 'read-only':
      return 'read-only';
    case 'workspace-write':
      return 'workspace-write';
    case 'danger-full-access':
      return 'danger-full-access';
    default:
      return null;
  }
}

function normalizeCodexRequirementValues(
  values: unknown[] | undefined,
  normalize: (value: unknown) => string | null,
): string[] | undefined {
  if (!values) {
    return undefined;
  }

  const normalized = values
    .map((value) => normalize(value))
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(normalized));
}

function normalizeConfigSelection(
  value: unknown,
  normalize: (candidate: unknown) => string | null,
  fallbackValue: string,
  allowedValues?: string[],
): string | undefined {
  const normalized = normalize(value);
  const hasConfiguredValue = typeof value === 'string'
    ? value.trim().length > 0
    : value !== undefined && value !== null;

  if (!allowedValues) {
    if (normalized) {
      return normalized;
    }
    return hasConfiguredValue ? fallbackValue : undefined;
  }

  if (normalized && allowedValues.includes(normalized)) {
    return normalized;
  }
  if (!hasConfiguredValue) {
    return undefined;
  }
  if (allowedValues.includes(fallbackValue)) {
    return fallbackValue;
  }

  return allowedValues[0];
}

function resolveOptionDefault(
  options: Array<{ value: string; label: string }>,
  fallbackValue: string,
): string {
  if (options.some((option) => option.value === fallbackValue)) {
    return fallbackValue;
  }

  return options[0]?.value || '';
}

function normalizeCodexEnumValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();

  return normalized || null;
}

function isApprovalPolicy(value: unknown): value is string {
  return value === 'untrusted' || value === 'on-request' || value === 'never' || value === 'on-failure';
}

function isSandboxMode(value: unknown): value is string {
  return value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access';
}

function isSpeedMode(value: unknown): value is string {
  return value === 'standard' || value === 'fast';
}

function isReasoningEffort(value: unknown): value is string {
  return value === 'none'
    || value === 'minimal'
    || value === 'low'
    || value === 'medium'
    || value === 'high'
    || value === 'xhigh';
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function shouldLogCodexNotification(method: string): boolean {
  return method !== 'item/agentMessage/delta';
}

function formatCodexLog(value: unknown): string {
  try {
    return JSON.stringify(summarizeCodexLogValue(value));
  } catch {
    return '[unserializable]';
  }
}

function summarizeCodexLogValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (depth >= 3) {
    return '[depth-limited]';
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, 4).map((item) => summarizeCodexLogValue(item, depth + 1));
    if (value.length > 4) {
      items.push(`...(${value.length - 4} more)`);
    }
    return items;
  }

  const record = value as Record<string, unknown>;
  const summarized: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(record)) {
    summarized[key] = summarizeCodexLogValue(entry, depth + 1);
  }

  return summarized;
}
