// ─── Agent Types ───

export type AgentType = 'claude' | 'codex' | 'gemini' | 'pty';

export interface AgentInfo {
  type: AgentType;
  name: string;
  available: boolean;
  description: string;
  options?: AgentOptionDef[];
}

export interface AgentConfig {
  type: AgentType;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  permissionMode?: string;
  model?: string;
}

// ─── 에이전트별 설정 옵션 정의 ───

export interface AgentOptionDef {
  key: string;
  label: string;
  type: 'select' | 'text';
  options?: { value: string; label: string }[];
  defaultValue?: string;
  description?: string;
}

export const CLAUDE_OPTIONS: AgentOptionDef[] = [
  {
    key: 'model',
    label: 'Model',
    type: 'select',
    options: [
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
      { value: 'haiku', label: 'Haiku' },
      { value: 'opusplan', label: 'OpusPlan' },
    ],
    defaultValue: 'sonnet',
  },
  {
    key: 'effortLevel',
    label: 'Reasoning',
    type: 'select',
    options: [
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
    ],
    defaultValue: 'medium',
  },
  {
    key: 'permissionMode',
    label: 'Mode',
    type: 'select',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'acceptEdits', label: 'Auto Edit' },
      { value: 'plan', label: 'Plan' },
      { value: 'bypassPermissions', label: 'Bypass' },
    ],
    defaultValue: 'default',
  },
];

export const CODEX_OPTIONS: AgentOptionDef[] = [
  {
    key: 'model',
    label: 'Model',
    type: 'select',
    options: [
      { value: '', label: 'Default' },
      { value: 'codex-mini-latest', label: 'Codex Mini' },
      { value: 'gpt-4.1', label: 'GPT-4.1' },
      { value: 'o4-mini', label: 'o4-mini' },
      { value: 'o3', label: 'o3' },
      { value: 'o3-mini', label: 'o3-mini' },
    ],
    defaultValue: '',
  },
  {
    key: 'approvalMode',
    label: 'Mode',
    type: 'select',
    options: [
      { value: 'on-request', label: 'On Request' },
      { value: 'full-auto', label: 'Full Auto' },
      { value: 'never', label: 'Bypass' },
    ],
    defaultValue: 'on-request',
  },
];

export const AGENT_OPTIONS: Record<AgentType, AgentOptionDef[]> = {
  claude: CLAUDE_OPTIONS,
  codex: CODEX_OPTIONS,
  gemini: [],
  pty: [],
};

// ─── Message Types ───

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  reasoning?: string;
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'requires_approval';
}

export interface ThreadSummary {
  id: string;
  agentType: AgentType;
  title: string;
  lastMessage?: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
  cwd?: string;
}

// ─── Agent Status ───

export interface AgentStatus {
  agent: AgentType;
  state: 'idle' | 'running' | 'waiting_approval' | 'error';
  activeThread?: string;
  model?: string;
}

// ─── Agent Events ───

export type AgentEvent =
  | { type: 'message_start'; threadId: string; agentType: AgentType }
  | { type: 'message_delta'; threadId: string; agentType: AgentType; content: string }
  | { type: 'message_complete'; threadId: string; agentType: AgentType; message: AgentMessage }
  | { type: 'tool_start'; threadId: string; agentType: AgentType; tool: ToolCall }
  | { type: 'tool_complete'; threadId: string; agentType: AgentType; tool: ToolCall }
  | { type: 'approval_required'; threadId: string; agentType: AgentType; tool: ToolCall }
  | { type: 'error'; threadId: string; agentType: AgentType; error: string }
  | { type: 'status_change'; agentType: AgentType; status: AgentStatus }
  | { type: 'pty_output'; threadId: string; agentType: AgentType; data: string };

// ─── Client → Server Messages ───

export type ClientMessage =
  | { type: 'send_message'; agentType: AgentType; threadId?: string; content: string }
  | { type: 'interrupt'; agentType: AgentType; threadId: string }
  | { type: 'approve'; agentType: AgentType; threadId: string; toolCallId: string; approved: boolean }
  | { type: 'list_threads'; agentType: AgentType }
  | { type: 'get_thread_messages'; agentType: AgentType; threadId: string }
  | { type: 'list_agents' }
  | { type: 'select_agent'; agentType: AgentType; config?: AgentConfig }
  | { type: 'pty_input'; agentType: AgentType; threadId: string; data: string }
  | { type: 'pty_resize'; cols: number; rows: number }
  | { type: 'git'; action: string; params?: Record<string, unknown> }
  | { type: 'file_list'; path: string }
  | { type: 'file_read'; path: string }
  | { type: 'ping' };

// ─── Server → Client Messages ───

export type ServerMessage =
  | { type: 'agent_event'; event: AgentEvent }
  | { type: 'agents_list'; agents: AgentInfo[] }
  | { type: 'threads_list'; agentType: AgentType; threads: ThreadSummary[] }
  | { type: 'thread_messages'; threadId: string; messages: AgentMessage[] }
  | { type: 'connection_status'; status: 'connected' | 'disconnected' | 'reconnecting' }
  | { type: 'git_result'; action: string; result: unknown }
  | { type: 'file_list_result'; path: string; entries: FileEntry[] }
  | { type: 'file_read_result'; path: string; content: string }
  | { type: 'error'; message: string; code?: string }
  | { type: 'pong' };

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
}

// ─── QR Payload ───

export interface QRPayload {
  type: 'rca';
  version: number;
  relay?: string;
  sessionId: string;
  directUrl: string;
  token: string;
}

// ─── Relay Roles ───

export type RelayRole = 'host' | 'client';
