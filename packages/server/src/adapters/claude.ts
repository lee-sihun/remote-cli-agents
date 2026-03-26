import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  createSdkMcpServer,
  query,
  tool,
  type ModelInfo,
  type PermissionMode,
  type Query as ClaudeSdkQuery,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentConfig,
  AgentEvent,
  AgentMessage,
  AgentOptionDef,
  AgentStatus,
  ContextUsage,
  SystemMessageMeta,
  ThreadSummary,
  ToolCall,
} from '@rca/shared';
import { CLAUDE_OPTIONS } from '@rca/shared';
import { z } from 'zod';
import type { AgentAdapter, AgentEventHandler, ThreadStreamingState } from './types.js';
import * as store from '../store.js';
import { debugError, debugLog } from '../logger.js';

interface ThreadInfo {
  id: string;
  query?: ClaudeSdkQuery;
  runId?: string;
  sessionId?: string;
  model?: string;
  title: string;
  messages: AgentMessage[];
  createdAt: number;
  updatedAt: number;
  cwd?: string;
  workspaceId?: string;
  contextUsage?: ContextUsage;
  config?: AgentConfig;
}

interface ClaudeAdapterOptions {
  permissionApiBaseUrl?: string;
  permissionApiToken?: string;
  permissionBridgeScriptPath?: string;
}

interface PendingApproval {
  resolve: (decision: PermissionDecision) => void;
  reject: (reason?: string) => void;
  threadId: string;
  tool: ToolCall;
}

interface PermissionDecision {
  behavior: 'allow' | 'deny';
  message?: string;
  toolUseID?: string;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
}

type ClaudeSystemMessage = Extract<SDKMessage, { type: 'system' }>;

interface ClaudeStreamState {
  streamedText: string;
  pendingText: string;
  pendingReasoning: string;
  compactionMessageId?: string;
  compactionCompleted: boolean;
  compactionInProgress: boolean;
  resultReceived: boolean;
  stderrEmitted: boolean;
  emittedAssistantMessages: number;
  lastToolCallId: string | null;
  pendingToolCalls: Map<string, ToolCall>;
  toolIndexes: Map<number, string>;
  toolInputBuffers: Map<string, string>;
  resultMeta: {
    model?: string;
    costUsd?: number;
    usage?: { inputTokens: number; outputTokens: number };
  };
}

const CLAUDE_PERMISSION_MCP_SERVER_KEY = 'rca-permission';
const CLAUDE_PERMISSION_TOOL_NAME = 'rca_approve_permission';
const CLAUDE_PERMISSION_PROMPT_TOOL_NAME = `mcp__${CLAUDE_PERMISSION_MCP_SERVER_KEY}__${CLAUDE_PERMISSION_TOOL_NAME}`;

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'Claude Code';
  readonly type = 'claude' as const;

  private threads = new Map<string, ThreadInfo>();
  private eventHandlers: AgentEventHandler[] = [];
  private config: AgentConfig | null = null;
  private readonly options: ClaudeAdapterOptions;
  private availableModels: ModelInfo[] = [];
  private status: AgentStatus = {
    agent: 'claude',
    state: 'idle',
  };
  private streamingBuffers = new Map<string, { content: string; toolCalls: ToolCall[] }>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private interruptedRuns = new Set<string>();

  constructor(options: ClaudeAdapterOptions = {}) {
    this.options = options;
  }

  async start(config: AgentConfig): Promise<void> {
    this.config = config;
    this.restoreStoredThreads();
    await this.refreshCapabilities(config);
  }

  async stop(): Promise<void> {
    for (const [, thread] of this.threads) {
      this.rejectPendingApprovalsForThread(thread.id, 'Claude session stopped before the permission request was answered.');
      this.closeThreadQuery(thread);
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

  getOptions(): AgentOptionDef[] {
    return buildClaudeOptionDefs(this.availableModels);
  }

  sendMessage(threadId: string | undefined, message: string, config?: AgentConfig): void {
    const tid = threadId || randomUUID();
    const existingThread = this.threads.get(tid);

    if (existingThread && this.isQueryActive(existingThread)) {
      debugLog(`[claude] Closing existing query for thread ${tid} before new message`);
      this.rejectPendingApprovalsForThread(tid, 'Claude session restarted before the permission request was answered.');
      this.closeThreadQuery(existingThread);
    }

    if (existingThread?.contextUsage) {
      this.status.contextUsage = existingThread.contextUsage;
    }
    if (existingThread?.model) {
      this.status.model = existingThread.model;
    }

    const threadConfig = this.resolveThreadConfig(existingThread, config);
    void this.runClaudeQuery(tid, message, threadConfig);
  }

  interrupt(threadId: string): void {
    const thread = this.threads.get(threadId);
    if (!thread?.query) {
      return;
    }

    if (thread.runId) {
      this.interruptedRuns.add(this.getRunKey(threadId, thread.runId));
    }

    void thread.query.interrupt().catch((error) => {
      debugError('[claude] Failed to interrupt query', error);
    });
  }

  approve(threadId: string, toolCallId: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(toolCallId);
    if (!pending || pending.threadId !== threadId) {
      return;
    }

    this.pendingApprovals.delete(toolCallId);
    pending.resolve(
      approved
        ? {
          behavior: 'allow',
          toolUseID: toolCallId,
        }
        : {
          behavior: 'deny',
          message: 'User rejected the permission request.',
          toolUseID: toolCallId,
        },
    );

    const thread = this.threads.get(threadId);
    if (thread && this.isQueryActive(thread)) {
      this.updateStatus('running', threadId, thread);
    } else {
      this.updateStatus('idle');
    }
  }

  requestPermission(
    threadId: string,
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
  ): Promise<PermissionDecision> {
    const thread = this.threads.get(threadId);
    if (!thread || !this.isQueryActive(thread)) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'Claude session is not running.',
        toolUseID: toolUseId,
      });
    }

    const existing = this.pendingApprovals.get(toolUseId);
    if (existing) {
      return Promise.resolve({
        behavior: 'deny',
        message: 'A permission request with the same tool_use_id is already pending.',
        toolUseID: toolUseId,
      });
    }

    const tool: ToolCall = {
      id: toolUseId,
      name: toolName,
      input,
      status: 'requires_approval',
    };

    this.updateStatus('waiting_approval', threadId, thread);
    this.emit({
      type: 'approval_required',
      threadId,
      agentType: 'claude',
      tool,
    });

    return new Promise<PermissionDecision>((resolve) => {
      this.pendingApprovals.set(toolUseId, {
        threadId,
        tool,
        resolve,
        reject: (reason) => {
          resolve({
            behavior: 'deny',
            message: reason || 'Permission request was cancelled.',
            toolUseID: toolUseId,
          });
        },
      });
    });
  }

  onEvent(handler: AgentEventHandler): void {
    this.eventHandlers.push(handler);
  }

  getStatus(): AgentStatus {
    return {
      ...this.status,
      contextUsage: this.status.contextUsage === null
        ? null
        : this.status.contextUsage
          ? { ...this.status.contextUsage }
          : undefined,
    };
  }

  getStreamingState(threadId: string): ThreadStreamingState | null {
    return this.streamingBuffers.get(threadId) || null;
  }

  async getThreads(workspaceId?: string): Promise<ThreadSummary[]> {
    const all = Array.from(this.threads.values());
    const filtered = workspaceId
      ? all.filter((thread) => (thread.workspaceId || 'default') === workspaceId)
      : all;

    return filtered.map((thread) => ({
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
      workspaceId: thread.workspaceId,
      model: thread.model,
      sessionId: thread.sessionId,
      contextUsage: thread.contextUsage,
      config: thread.config,
    }));
  }

  renameThread(threadId: string, title: string, workspaceId?: string): void {
    const thread = this.threads.get(threadId);
    if (!thread) {
      return;
    }

    thread.title = title;
    if (workspaceId) {
      thread.workspaceId = workspaceId;
    }
    this.saveThreadMeta(thread);
  }

  deleteThread(threadId: string, workspaceId?: string): void {
    const thread = this.threads.get(threadId);
    const wsId = workspaceId || thread?.workspaceId || 'default';

    if (!thread) {
      store.deleteThread('claude', threadId, wsId);
      return;
    }

    this.rejectPendingApprovalsForThread(threadId, 'Claude session was deleted.');
    this.closeThreadQuery(thread);

    this.streamingBuffers.delete(threadId);
    this.threads.delete(threadId);
    store.deleteThread('claude', threadId, wsId);

    if (this.status.activeThread === threadId) {
      const nextActiveThread = Array.from(this.threads.values()).find((candidate) => this.isQueryActive(candidate));
      if (nextActiveThread) {
        this.updateStatus('running', nextActiveThread.id, nextActiveThread);
      } else {
        this.updateStatus('idle');
      }
    }
  }

  private restoreStoredThreads(): void {
    const workspaces = store.loadWorkspaces();
    const workspaceIds = workspaces.length > 0
      ? workspaces.map((workspace) => workspace.id)
      : ['default'];

    for (const workspaceId of workspaceIds) {
      const saved = store.loadThreads('claude', workspaceId);
      for (const thread of saved) {
        if (this.threads.has(thread.id)) {
          continue;
        }

        this.threads.set(thread.id, {
          id: thread.id,
          sessionId: thread.sessionId,
          model: thread.model,
          title: thread.title,
          messages: store.loadMessages(thread.id),
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          cwd: thread.cwd,
          workspaceId,
          contextUsage: thread.contextUsage,
          config: thread.config,
        });
      }
    }
  }

  private async refreshCapabilities(config: AgentConfig): Promise<void> {
    let probe: ClaudeSdkQuery | undefined;
    try {
      probe = query({
        prompt: '',
        options: {
          cwd: config.cwd || process.cwd(),
          env: sanitizeClaudeEnv(config.env),
          includePartialMessages: false,
          persistSession: false,
          settingSources: ['user', 'project', 'local'],
        },
      });
      const init = await probe.initializationResult();
      this.availableModels = init.models || [];
    } catch (error) {
      debugError('[claude] Failed to load SDK capabilities', error);
      this.availableModels = [];
    } finally {
      probe?.close();
    }
  }

  private resolveThreadConfig(existingThread?: ThreadInfo, overrideConfig?: AgentConfig): AgentConfig {
    const baseConfig = {
      ...(this.config || { type: 'claude' as const }),
      ...(existingThread?.config || {}),
      ...(overrideConfig || {}),
    };

    return {
      ...baseConfig,
      type: 'claude',
      cwd: existingThread?.cwd || overrideConfig?.cwd || baseConfig.cwd || this.config?.cwd,
      env: baseConfig.env ? { ...baseConfig.env } : undefined,
    };
  }

  private async runClaudeQuery(threadId: string, message: string, runConfig: AgentConfig): Promise<void> {
    const existingThread = this.threads.get(threadId);
    const now = Date.now();
    const runId = randomUUID();
    const threadSessionId = existingThread?.sessionId || randomUUID();
    const resumeSessionId = existingThread?.sessionId;
    const cwd = existingThread?.cwd || runConfig.cwd;

    const userMessage: AgentMessage = {
      id: randomUUID(),
      role: 'user',
      content: message,
      timestamp: now,
    };

    const threadInfo: ThreadInfo = {
      id: threadId,
      runId,
      sessionId: threadSessionId,
      model: existingThread?.model,
      title: existingThread?.title || message.slice(0, 50),
      messages: existingThread?.messages || [],
      createdAt: existingThread?.createdAt || now,
      updatedAt: now,
      cwd,
      workspaceId: existingThread?.workspaceId || runConfig.workspaceId,
      contextUsage: existingThread?.contextUsage,
      config: runConfig,
    };

    threadInfo.messages.push(userMessage);
    store.appendMessage(threadId, userMessage);

    this.streamingBuffers.set(threadId, { content: '', toolCalls: [] });
    this.threads.set(threadId, threadInfo);
    this.saveThreadMeta(threadInfo);
    this.updateStatus('running', threadId, threadInfo);

    this.emit({
      type: 'message_start',
      threadId,
      agentType: 'claude',
    });

    let sdkQuery: ClaudeSdkQuery;
    try {
      const permissionMcpServer = readConfigString(runConfig, 'permissionMode') === 'bypassPermissions'
        ? undefined
        : this.buildPermissionMcpServer(threadId);

      sdkQuery = query({
        prompt: message,
        options: {
          cwd: cwd || process.cwd(),
          env: sanitizeClaudeEnv(runConfig.env),
          includePartialMessages: true,
          persistSession: true,
          settingSources: ['user', 'project', 'local'],
          model: normalizeClaudeModel(runConfig.model),
          effort: normalizeClaudeEffort(readConfigString(runConfig, 'effortLevel')),
          permissionMode: normalizeClaudePermissionMode(readConfigString(runConfig, 'permissionMode')),
          allowDangerouslySkipPermissions: readConfigString(runConfig, 'permissionMode') === 'bypassPermissions',
          resume: resumeSessionId,
          sessionId: resumeSessionId ? undefined : threadSessionId,
          mcpServers: permissionMcpServer
            ? {
              [CLAUDE_PERMISSION_MCP_SERVER_KEY]: permissionMcpServer,
            }
            : undefined,
          permissionPromptToolName: permissionMcpServer
            ? CLAUDE_PERMISSION_PROMPT_TOOL_NAME
            : undefined,
          stderr: (data) => {
            this.handleQueryStderr(threadId, runId, data);
          },
        },
      });
    } catch (error) {
      this.streamingBuffers.delete(threadId);
      threadInfo.runId = undefined;
      this.emit({
        type: 'error',
        threadId,
        agentType: 'claude',
        error: error instanceof Error ? error.message : String(error),
      });
      this.updateStatus('error', threadId, threadInfo);
      return;
    }

    threadInfo.query = sdkQuery;

    try {
      const init = await sdkQuery.initializationResult();
      this.availableModels = init.models || this.availableModels;
    } catch (error) {
      debugError('[claude] Failed to read SDK initialization result', error);
    }

    const state = this.createStreamState();

    const saveThreadMessages = () => {
      store.saveMessages(threadId, threadInfo.messages);
      this.saveThreadMeta(threadInfo);
    };

    const upsertAssistantMessage = (entry: AgentMessage) => {
      const existingIndex = threadInfo.messages.findIndex((messageItem) => messageItem.id === entry.id);
      if (existingIndex >= 0) {
        threadInfo.messages[existingIndex] = entry;
      } else {
        threadInfo.messages.push(entry);
        state.emittedAssistantMessages += 1;
      }

      threadInfo.updatedAt = Date.now();
      saveThreadMessages();
      this.emit({
        type: 'message_complete',
        threadId,
        agentType: 'claude',
        message: entry,
      });
    };

    const emitSystemMessage = (
      content: string,
      systemMeta?: SystemMessageMeta,
      messageId?: string,
    ) => {
      upsertAssistantMessage({
        id: messageId || randomUUID(),
        role: 'system',
        content,
        timestamp: Date.now(),
        systemMeta,
      });
    };

    const syncStreamingToolCalls = () => {
      const buffer = this.streamingBuffers.get(threadId);
      if (!buffer) {
        return;
      }
      buffer.toolCalls = Array.from(state.pendingToolCalls.values()).map((tool) => ({ ...tool }));
    };

    const upsertToolMessage = (tool: ToolCall) => {
      const existing = threadInfo.messages.find((messageItem) => messageItem.id === tool.id);
      const entry: AgentMessage = {
        id: tool.id,
        role: 'assistant',
        content: '',
        timestamp: existing?.timestamp || Date.now(),
        toolCalls: [{ ...tool }],
      };
      syncStreamingToolCalls();
      upsertAssistantMessage(entry);
    };

    const emitToolStart = (tool: ToolCall) => {
      this.emit({
        type: 'tool_start',
        threadId,
        agentType: 'claude',
        tool: { ...tool },
      });
    };

    const emitToolComplete = (tool: ToolCall) => {
      this.emit({
        type: 'tool_complete',
        threadId,
        agentType: 'claude',
        tool: { ...tool },
      });
    };

    const flushTextSegment = (
      text: string,
      meta?: { model?: string; costUsd?: number; usage?: { inputTokens: number; outputTokens: number } },
    ) => {
      const normalized = text.trim();
      const reasoning = state.pendingReasoning || undefined;
      state.pendingText = '';
      state.pendingReasoning = '';

      const buffer = this.streamingBuffers.get(threadId);
      if (buffer) {
        buffer.content = '';
      }

      if (!normalized && !reasoning) {
        return;
      }

      upsertAssistantMessage({
        id: randomUUID(),
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
        reasoning,
        model: meta?.model,
        costUsd: meta?.costUsd,
        usage: meta?.usage,
      });
    };

    const processAssistantMessage = (sdkMessage: SDKAssistantMessage) => {
      const messageRecord = sdkMessage.message as Record<string, unknown>;
      const contentBlocks = readArray(messageRecord, 'content');
      if (!contentBlocks) {
        return;
      }

      for (const blockValue of contentBlocks) {
        if (!isRecord(blockValue)) {
          continue;
        }

        const blockType = readString(blockValue, 'type');
        if (blockType === 'thinking') {
          const thinking = readString(blockValue, 'thinking');
          if (thinking && !state.pendingReasoning) {
            state.pendingReasoning = thinking;
          }
          continue;
        }

        if (blockType === 'text') {
          const text = readString(blockValue, 'text');
          if (text && !state.pendingText && !state.streamedText) {
            state.pendingText = text;
          }
          continue;
        }

        if (blockType !== 'tool_use') {
          continue;
        }

        if (state.pendingText || state.pendingReasoning) {
          flushTextSegment(state.pendingText);
        }

        const toolId = readString(blockValue, 'id') || randomUUID();
        const tool: ToolCall = {
          id: toolId,
          name: readString(blockValue, 'name') || 'Tool',
          input: readRecord(blockValue, 'input') || {},
          status: 'running',
        };

        const existed = state.pendingToolCalls.has(tool.id);
        state.pendingToolCalls.set(tool.id, tool);
        state.lastToolCallId = tool.id;
        syncStreamingToolCalls();
        if (!existed) {
          emitToolStart(tool);
        }
        upsertToolMessage(tool);
      }
    };

    const processUserMessage = (sdkMessage: SDKUserMessage) => {
      const messageRecord = sdkMessage.message as Record<string, unknown>;
      const contentBlocks = readArray(messageRecord, 'content');
      if (!contentBlocks) {
        return;
      }

      for (const blockValue of contentBlocks) {
        if (!isRecord(blockValue) || readString(blockValue, 'type') !== 'tool_result') {
          continue;
        }

        const toolId = readString(blockValue, 'tool_use_id') || state.lastToolCallId;
        if (!toolId) {
          continue;
        }

        const existingTool = state.pendingToolCalls.get(toolId);
        if (!existingTool) {
          continue;
        }

        existingTool.output = formatClaudeContent(readUnknown(blockValue, 'content'));
        existingTool.status = readBoolean(blockValue, 'is_error') ? 'failed' : 'completed';
        state.pendingToolCalls.delete(existingTool.id);
        syncStreamingToolCalls();
        emitToolComplete(existingTool);
        upsertToolMessage({ ...existingTool });
      }
    };

    const processPartialMessage = (sdkMessage: SDKMessage) => {
      if (sdkMessage.type !== 'stream_event') {
        return;
      }

      const event = sdkMessage.event as Record<string, unknown>;
      const eventType = readString(event, 'type');
      if (eventType === 'content_block_start') {
        const index = readNumber(event, 'index');
        const contentBlock = readRecord(event, 'content_block');
        if (!contentBlock) {
          return;
        }

        const blockType = readString(contentBlock, 'type');
        if (blockType !== 'tool_use') {
          return;
        }

        if (state.pendingText || state.pendingReasoning) {
          flushTextSegment(state.pendingText);
        }

        const tool: ToolCall = {
          id: readString(contentBlock, 'id') || randomUUID(),
          name: readString(contentBlock, 'name') || 'Tool',
          input: readRecord(contentBlock, 'input') || {},
          status: 'running',
        };

        if (typeof index === 'number') {
          state.toolIndexes.set(index, tool.id);
        }
        const existed = state.pendingToolCalls.has(tool.id);
        state.pendingToolCalls.set(tool.id, tool);
        state.lastToolCallId = tool.id;
        syncStreamingToolCalls();
        if (!existed) {
          emitToolStart(tool);
        }
        upsertToolMessage(tool);
        return;
      }

      if (eventType !== 'content_block_delta') {
        return;
      }

      const delta = readRecord(event, 'delta');
      const index = readNumber(event, 'index');
      if (!delta) {
        return;
      }

      const deltaType = readString(delta, 'type');
      if (deltaType === 'text_delta') {
        const text = readString(delta, 'text');
        if (!text) {
          return;
        }

        state.pendingText += text;
        state.streamedText += text;
        const buffer = this.streamingBuffers.get(threadId);
        if (buffer) {
          buffer.content += text;
        }
        this.emit({
          type: 'message_delta',
          threadId,
          agentType: 'claude',
          content: text,
        });
        return;
      }

      if (deltaType === 'thinking_delta') {
        const thinking = readString(delta, 'thinking') || readString(delta, 'text');
        if (thinking) {
          state.pendingReasoning += thinking;
        }
        return;
      }

      if (deltaType !== 'input_json_delta' || typeof index !== 'number') {
        return;
      }

      const toolId = state.toolIndexes.get(index);
      const partialJson = readString(delta, 'partial_json');
      if (!toolId || !partialJson) {
        return;
      }

      const nextInput = `${state.toolInputBuffers.get(toolId) || ''}${partialJson}`;
      state.toolInputBuffers.set(toolId, nextInput);
      const parsed = tryParseJsonRecord(nextInput);
      if (!parsed) {
        return;
      }

      const tool = state.pendingToolCalls.get(toolId);
      if (!tool) {
        return;
      }

      tool.input = parsed;
      syncStreamingToolCalls();
      upsertToolMessage({ ...tool });
    };

    const processResultMessage = (sdkMessage: SDKResultMessage) => {
      state.resultReceived = true;

      if (sdkMessage.subtype !== 'success' && sdkMessage.errors.length > 0) {
        const visibleErrors = sdkMessage.errors.filter(
          (error) => !this.shouldSuppressInterruptedError(threadId, runId, error),
        );

        if (visibleErrors.length > 0) {
          this.emit({
            type: 'error',
            threadId,
            agentType: 'claude',
            error: visibleErrors.join('\n'),
          });
        }
      }

      state.resultMeta.costUsd = sdkMessage.total_cost_usd;
      if (!state.resultMeta.model) {
        state.resultMeta.model = pickClaudeModelFromUsage(sdkMessage.modelUsage);
      }

      const usage = toClaudeUsageSummary(sdkMessage);
      if (usage) {
        state.resultMeta.usage = usage;
      }

      const contextUsage = toClaudeContextUsage(sdkMessage);
      if (contextUsage) {
        threadInfo.contextUsage = contextUsage;
        if (this.status.activeThread === threadId) {
          this.status.contextUsage = contextUsage;
        }
      }

      if (hasClaudeCompactionIteration(sdkMessage) && !state.compactionCompleted) {
        state.compactionCompleted = true;
        state.compactionMessageId = state.compactionMessageId || `compaction:${runId}`;
        emitSystemMessage(
          'Context compacted. Continuing with a refreshed window.',
          { kind: 'context_compaction', status: 'completed' },
          state.compactionMessageId,
        );
      }

      if (!threadInfo.model) {
        threadInfo.model = pickClaudeModelFromUsage(sdkMessage.modelUsage);
      }
      if (this.status.activeThread === threadId) {
        this.updateStatus('running', threadId, threadInfo);
      }

      this.streamingBuffers.delete(threadId);

      for (const [, tool] of state.pendingToolCalls) {
        emitToolComplete({ ...tool, status: 'abandoned' });
        upsertToolMessage({ ...tool, status: 'abandoned' });
      }
      state.pendingToolCalls.clear();

      if (state.pendingText || state.pendingReasoning) {
        flushTextSegment(state.pendingText, state.resultMeta);
      } else if (sdkMessage.type === 'result' && 'result' in sdkMessage && sdkMessage.result) {
        if (!state.streamedText) {
          flushTextSegment(sdkMessage.result, state.resultMeta);
        } else if (sdkMessage.result.startsWith(state.streamedText)) {
          const suffix = sdkMessage.result.slice(state.streamedText.length);
          if (suffix) {
            state.streamedText += suffix;
            flushTextSegment(suffix, state.resultMeta);
          }
        } else if (sdkMessage.result !== state.streamedText) {
          state.streamedText += sdkMessage.result;
          flushTextSegment(sdkMessage.result, state.resultMeta);
        }
      }

      saveThreadMessages();
    };

    const finalizeWithoutResult = (interrupted = false) => {
      this.streamingBuffers.delete(threadId);
      for (const [, tool] of state.pendingToolCalls) {
        emitToolComplete({ ...tool, status: 'abandoned' });
        upsertToolMessage({ ...tool, status: 'abandoned' });
      }
      state.pendingToolCalls.clear();

      if (state.pendingText || state.pendingReasoning) {
        flushTextSegment(state.pendingText, state.resultMeta);
        return;
      }

      if (interrupted) {
        saveThreadMessages();
        return;
      }

      if (state.emittedAssistantMessages === 0) {
        flushTextSegment('[응답 없음]');
      } else {
        saveThreadMessages();
      }
    };

    const processSystemMessage = (sdkMessage: ClaudeSystemMessage) => {
      threadInfo.updatedAt = Date.now();
      threadInfo.sessionId = sdkMessage.session_id;

      if (sdkMessage.subtype === 'status') {
        const status = readString(sdkMessage as unknown as Record<string, unknown>, 'status');
        if (status === 'compacting' && !state.compactionInProgress) {
          state.compactionInProgress = true;
          state.compactionMessageId = state.compactionMessageId || `compaction:${runId}`;
          emitSystemMessage(
            'Context compaction started.',
            { kind: 'context_compaction', status: 'running' },
            state.compactionMessageId,
          );
        } else if (!status) {
          state.compactionInProgress = false;
        }
      }

      if (sdkMessage.subtype === 'compact_boundary' && !state.compactionCompleted) {
        state.compactionCompleted = true;
        state.compactionInProgress = false;
        state.compactionMessageId = state.compactionMessageId || `compaction:${runId}`;
        emitSystemMessage(
          'Context compacted. Continuing with a refreshed window.',
          { kind: 'context_compaction', status: 'completed' },
          state.compactionMessageId,
        );
      }

      if (sdkMessage.subtype === 'init') {
        threadInfo.model = sdkMessage.model;
        if (this.status.activeThread === threadId) {
          this.status.model = sdkMessage.model;
        }
      }

      this.saveThreadMeta(threadInfo);
    };

    try {
      for await (const sdkMessage of sdkQuery) {
        if (!this.isCurrentRun(threadId, runId, sdkQuery)) {
          continue;
        }

        threadInfo.updatedAt = Date.now();
        if ('session_id' in sdkMessage && typeof sdkMessage.session_id === 'string') {
          threadInfo.sessionId = sdkMessage.session_id;
        }

        switch (sdkMessage.type) {
          case 'system':
            processSystemMessage(sdkMessage);
            break;
          case 'stream_event':
            processPartialMessage(sdkMessage);
            break;
          case 'assistant':
            processAssistantMessage(sdkMessage);
            break;
          case 'user':
            processUserMessage(sdkMessage);
            break;
          case 'result':
            processResultMessage(sdkMessage);
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (this.isCurrentRun(threadId, runId, sdkQuery)) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.shouldSuppressInterruptedError(threadId, runId, message)) {
          debugLog(`[claude] Suppressed interrupt error for thread ${threadId}: ${message}`);
        } else {
          state.stderrEmitted = true;
          this.emit({
            type: 'error',
            threadId,
            agentType: 'claude',
            error: message,
          });
        }
      }
    } finally {
      const wasInterrupted = this.interruptedRuns.delete(this.getRunKey(threadId, runId));
      if (!this.isCurrentRun(threadId, runId, sdkQuery)) {
        return;
      }

      if (!state.resultReceived) {
        finalizeWithoutResult(wasInterrupted);
      }

      this.rejectPendingApprovalsForThread(
        threadId,
        wasInterrupted
          ? 'Claude session was interrupted.'
          : 'Claude session ended before the permission request was answered.',
      );
      threadInfo.query = undefined;
      threadInfo.runId = undefined;

      const nextActiveThread = Array.from(this.threads.values()).find((thread) => this.isQueryActive(thread));
      if (nextActiveThread) {
        this.updateStatus('running', nextActiveThread.id, nextActiveThread);
      } else {
        this.updateStatus('idle');
      }
    }
  }

  private getRunKey(threadId: string, runId: string): string {
    return `${threadId}:${runId}`;
  }

  private shouldSuppressInterruptedError(threadId: string, runId: string, message: string): boolean {
    if (!this.interruptedRuns.has(this.getRunKey(threadId, runId))) {
      return false;
    }

    return /request was aborted|ede_diagnostic|makeRequest|processTicksAndRejections/i.test(message);
  }

  private buildPermissionMcpServer(threadId: string) {
    const bridgeConfig = this.createPermissionBridgeMcpServer(threadId);
    if (bridgeConfig) {
      return bridgeConfig;
    }

    return this.createPermissionSdkMcpServer(threadId);
  }

  private createPermissionBridgeMcpServer(threadId: string) {
    const { permissionApiBaseUrl, permissionApiToken, permissionBridgeScriptPath } = this.options;
    if (!permissionApiBaseUrl || !permissionApiToken || !permissionBridgeScriptPath) {
      return null;
    }

    const env = Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
    ) as Record<string, string>;

    return {
      type: 'stdio' as const,
      command: process.execPath,
      args: [permissionBridgeScriptPath],
      env: {
        ...env,
        RCA_CLAUDE_PERMISSION_API_URL: `${permissionApiBaseUrl}/api/internal/claude/permission-request`,
        RCA_CLAUDE_PERMISSION_API_TOKEN: permissionApiToken,
        RCA_CLAUDE_THREAD_ID: threadId,
      },
    };
  }

  private createPermissionSdkMcpServer(threadId: string) {
    return createSdkMcpServer({
      name: `${CLAUDE_PERMISSION_MCP_SERVER_KEY}-${threadId}`,
      tools: [
        tool(
          CLAUDE_PERMISSION_TOOL_NAME,
          'Routes Claude Code permission prompts to the RCA approval UI.',
          {
            tool_name: z.string(),
            input: z.record(z.string(), z.unknown()).optional(),
            tool_use_id: z.string(),
          },
          async ({ tool_name: toolName, input, tool_use_id: toolUseId }) => {
            const normalizedInput = input || {};
            const decision = await this.requestPermission(
              threadId,
              toolName,
              normalizedInput,
              toolUseId,
            );
            const normalizedDecision = decision.behavior === 'allow'
              ? {
                ...decision,
                updatedInput: decision.updatedInput || normalizedInput,
              }
              : decision;

            return {
              content: [{
                type: 'text',
                text: JSON.stringify(normalizedDecision),
              }],
            };
          },
        ),
      ],
    });
  }

  private handleQueryStderr(threadId: string, runId: string, data: string): void {
    const thread = this.threads.get(threadId);
    if (!thread || !thread.query || !this.isCurrentRun(threadId, runId, thread.query)) {
      return;
    }

    const lines = data
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      if (this.shouldSuppressInterruptedError(threadId, runId, line)) {
        debugLog(`[claude] Suppressed interrupt stderr for thread ${threadId}: ${line}`);
        continue;
      }

      debugError('[claude stderr]', line);
      this.emit({
        type: 'error',
        threadId,
        agentType: 'claude',
        error: line,
      });
    }
  }

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
      workspaceId: thread.workspaceId,
      model: thread.model,
      sessionId: thread.sessionId,
      contextUsage: thread.contextUsage,
      config: thread.config,
    }, thread.workspaceId || 'default');
  }

  private emit(event: AgentEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error('[claude] Event handler error:', error);
      }
    }
  }

  private closeThreadQuery(thread: ThreadInfo): void {
    thread.query?.close();
    thread.query = undefined;
    thread.runId = undefined;
  }

  private isCurrentRun(threadId: string, runId: string, sdkQuery: ClaudeSdkQuery): boolean {
    const thread = this.threads.get(threadId);
    return thread?.runId === runId && thread.query === sdkQuery;
  }

  private isQueryActive(thread?: ThreadInfo | null): boolean {
    return Boolean(thread?.query && thread.runId);
  }

  private rejectPendingApprovalsForThread(threadId: string, reason: string): void {
    const pendingIds = Array.from(this.pendingApprovals.entries())
      .filter(([, pending]) => pending.threadId === threadId)
      .map(([toolCallId]) => toolCallId);

    for (const toolCallId of pendingIds) {
      const pending = this.pendingApprovals.get(toolCallId);
      if (!pending) {
        continue;
      }

      this.pendingApprovals.delete(toolCallId);
      pending.reject(reason);
    }
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

  private createStreamState(): ClaudeStreamState {
    return {
      streamedText: '',
      pendingText: '',
      pendingReasoning: '',
      compactionMessageId: undefined,
      compactionCompleted: false,
      compactionInProgress: false,
      resultReceived: false,
      stderrEmitted: false,
      emittedAssistantMessages: 0,
      lastToolCallId: null,
      pendingToolCalls: new Map(),
      toolIndexes: new Map(),
      toolInputBuffers: new Map(),
      resultMeta: {},
    };
  }
}

function buildClaudeOptionDefs(models: ModelInfo[]): AgentOptionDef[] {
  if (models.length === 0) {
    return CLAUDE_OPTIONS;
  }

  const effortOptions = buildClaudeEffortOptions(models);
  const effortVisibleModels = models
    .filter((model) => model.supportsEffort && (model.supportedEffortLevels?.length || 0) > 0)
    .map((model) => model.value);

  return [
    {
      key: 'model',
      label: 'Model',
      type: 'select',
      options: [
        { value: 'default', label: 'Default' },
        ...models.map((model) => ({
          value: model.value,
          label: model.displayName,
        })),
      ],
      defaultValue: 'default',
    },
    {
      key: 'effortLevel',
      label: 'Reasoning',
      type: 'select',
      options: effortOptions,
      defaultValue: effortOptions.some((option) => option.value === 'medium') ? 'medium' : effortOptions[0]?.value || '',
      visibleWhen: effortVisibleModels.length > 0
        ? { model: ['default', ...effortVisibleModels] }
        : undefined,
    },
    CLAUDE_OPTIONS.find((option) => option.key === 'permissionMode') || {
      key: 'permissionMode',
      label: 'Mode',
      type: 'select',
      options: [],
      defaultValue: 'default',
    },
  ];
}

function buildClaudeEffortOptions(models: ModelInfo[]): Array<{ value: string; label: string }> {
  const levels = Array.from(new Set(models.flatMap((model) => model.supportedEffortLevels || [])));
  if (levels.length === 0) {
    return [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ];
  }

  const orderedLevels = ['low', 'medium', 'high', 'max'].filter((level) => levels.includes(level as never));
  return orderedLevels.map((level) => ({
    value: level,
    label: level === 'max'
      ? 'Max'
      : `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
  }));
}

function normalizeClaudeModel(value: string | undefined): string | undefined {
  if (!value || value === 'default') {
    return undefined;
  }

  return value;
}

function normalizeClaudeEffort(value: string | undefined): 'low' | 'medium' | 'high' | 'max' | undefined {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'max') {
    return value;
  }

  return undefined;
}

function normalizeClaudePermissionMode(value: string | undefined): PermissionMode | undefined {
  if (
    value === 'default'
    || value === 'acceptEdits'
    || value === 'bypassPermissions'
    || value === 'plan'
    || value === 'dontAsk'
  ) {
    return value;
  }

  return undefined;
}

function sanitizeClaudeEnv(env?: Record<string, string>): Record<string, string | undefined> {
  const nextEnv = { ...process.env, ...(env || {}) };
  delete nextEnv.CLAUDECODE;
  return nextEnv;
}

function pickClaudeModelFromUsage(modelUsage: Record<string, unknown> | undefined): string | undefined {
  if (!modelUsage) {
    return undefined;
  }

  const modelNames = Object.keys(modelUsage);
  return modelNames[0];
}

function toClaudeUsageSummary(
  result: SDKResultMessage,
): { inputTokens: number; outputTokens: number } | undefined {
  const iterationUsage = readClaudeUsageIterations(result);
  const totals = iterationUsage.length > 0
    ? iterationUsage.reduce(
      (sum, usage) => ({
        inputTokens: sum.inputTokens + usage.inputTokens,
        outputTokens: sum.outputTokens + usage.outputTokens,
      }),
      { inputTokens: 0, outputTokens: 0 },
    )
    : readClaudeTopLevelUsage(result);
  const { inputTokens, outputTokens } = totals;

  if (inputTokens === 0 && outputTokens === 0) {
    return undefined;
  }

  return { inputTokens, outputTokens };
}

function toClaudeContextUsage(result: SDKResultMessage): ContextUsage | undefined {
  const primaryModel = pickClaudeModelFromUsage(result.modelUsage);
  const modelUsage = primaryModel ? readRecord(result.modelUsage as Record<string, unknown>, primaryModel) : undefined;
  const contextWindow = readNumber(modelUsage || {}, 'contextWindow');
  const effectiveUsage = readClaudeEffectiveIterationUsage(result)
    || readClaudeModelUsage(modelUsage)
    || readClaudeTopLevelUsage(result);

  const inputTokens = effectiveUsage.inputTokens;
  const outputTokens = effectiveUsage.outputTokens;
  const totalTokens = inputTokens + outputTokens;

  if (!contextWindow || contextWindow <= 0) {
    return undefined;
  }

  return {
    used: totalTokens,
    total: contextWindow,
    percentage: Math.min(100, Math.round((totalTokens / contextWindow) * 100)),
  };
}

function readClaudeEffectiveIterationUsage(
  result: SDKResultMessage,
): { inputTokens: number; outputTokens: number } | undefined {
  const iterations = readClaudeUsageIterations(result);
  if (iterations.length === 0) {
    return undefined;
  }

  for (let index = iterations.length - 1; index >= 0; index -= 1) {
    const iteration = iterations[index];
    if (iteration.type !== 'compaction') {
      return {
        inputTokens: iteration.inputTokens,
        outputTokens: iteration.outputTokens,
      };
    }
  }

  return undefined;
}

function hasClaudeCompactionIteration(result: SDKResultMessage): boolean {
  return readClaudeUsageIterations(result).some((iteration) => iteration.type === 'compaction');
}

function readClaudeUsageIterations(
  result: SDKResultMessage,
): Array<{ type?: string; inputTokens: number; outputTokens: number }> {
  const usageRecord = result.usage as unknown as Record<string, unknown>;
  const iterations = readArray(usageRecord, 'iterations');
  if (!iterations) {
    return [];
  }

  return iterations.flatMap((iteration): Array<{ type?: string; inputTokens: number; outputTokens: number }> => {
    if (!isRecord(iteration)) {
      return [];
    }

    return [{
      type: readString(iteration, 'type'),
      inputTokens: readSnakeCaseUsage(iteration).inputTokens,
      outputTokens: readNumber(iteration, 'output_tokens') || 0,
    }];
  });
}

function readClaudeTopLevelUsage(
  result: SDKResultMessage,
): { inputTokens: number; outputTokens: number } {
  return readSnakeCaseUsage(result.usage as unknown as Record<string, unknown>);
}

function readClaudeModelUsage(
  usage: Record<string, unknown> | undefined,
): { inputTokens: number; outputTokens: number } | undefined {
  if (!usage) {
    return undefined;
  }

  const counts = {
    inputTokens: (
      (readNumber(usage, 'inputTokens') || 0)
      + (readNumber(usage, 'cacheReadInputTokens') || 0)
      + (readNumber(usage, 'cacheCreationInputTokens') || 0)
    ),
    outputTokens: readNumber(usage, 'outputTokens') || 0,
  };

  if (counts.inputTokens === 0 && counts.outputTokens === 0) {
    return undefined;
  }

  return counts;
}

function readSnakeCaseUsage(
  usage: Record<string, unknown>,
): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: (
      (readNumber(usage, 'input_tokens') || 0)
      + (readNumber(usage, 'cache_read_input_tokens') || 0)
      + (readNumber(usage, 'cache_creation_input_tokens') || 0)
    ),
    outputTokens: readNumber(usage, 'output_tokens') || 0,
  };
}

function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function formatClaudeContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (!Array.isArray(value)) {
    return value === undefined ? '' : JSON.stringify(value);
  }

  return value
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (!isRecord(item)) {
        return JSON.stringify(item);
      }

      return readString(item, 'text')
        || readString(item, 'thinking')
        || JSON.stringify(item);
    })
    .join('');
}

function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(obj: Record<string, unknown>, key: string): boolean | undefined {
  const value = obj[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === 'number' ? value : undefined;
}

function readRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = obj[key];
  return isRecord(value) ? value : undefined;
}

function readArray(obj: Record<string, unknown>, key: string): unknown[] | undefined {
  const value = obj[key];
  return Array.isArray(value) ? value : undefined;
}

function readUnknown(obj: Record<string, unknown>, key: string): unknown {
  return obj[key];
}

function readConfigString(config: AgentConfig, key: string): string | undefined {
  const value = (config as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
