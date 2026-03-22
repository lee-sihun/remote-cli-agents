// ─── Workspace ───

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  lastAccessedAt: number;
}

// ─── Agent Types ───

export type AgentType = "claude" | "codex";

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
  approvalMode?: string;
  sandboxMode?: string;
  workspaceId?: string;
  model?: string;
  effortLevel?: string;
  speedMode?: string;
}

// ─── 에이전트별 설정 옵션 정의 ───

export interface AgentOptionDef {
  key: string;
  label: string;
  type: "select" | "text";
  options?: { value: string; label: string }[];
  defaultValue?: string;
  description?: string;
  /** 다른 옵션 값에 따라 조건부 표시 (key: 허용 값 배열) */
  visibleWhen?: Record<string, string[]>;
}

export const CLAUDE_OPTIONS: AgentOptionDef[] = [
  {
    key: "model",
    label: "Model",
    type: "select",
    options: [
      { value: "default", label: "Default" },
      { value: "sonnet", label: "Sonnet" },
      { value: "opus", label: "Opus" },
      { value: "haiku", label: "Haiku" },
      { value: "sonnet[1m]", label: "Sonnet 1M" },
      { value: "opusplan", label: "OpusPlan" },
    ],
    defaultValue: "default",
  },
  {
    key: "effortLevel",
    label: "Reasoning",
    type: "select",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
    ],
    defaultValue: "medium",
    // 노력 수준은 Opus/Sonnet 계열만 지원
    visibleWhen: {
      model: ["default", "sonnet", "sonnet[1m]", "opus", "opusplan"],
    },
  },
  {
    key: "permissionMode",
    label: "Mode",
    type: "select",
    options: [
      { value: "default", label: "Default" },
      { value: "acceptEdits", label: "Accept edits" },
      { value: "plan", label: "Plan Mode" },
      { value: "dontAsk", label: "Don't Ask" },
      { value: "bypassPermissions", label: "Bypass Permissions" },
    ],
    defaultValue: "default",
  },
];

export const CODEX_OPTIONS: AgentOptionDef[] = [
  {
    key: "model",
    label: "Model",
    type: "select",
    options: [
      { value: "", label: "Default" },
      { value: "gpt-5.4", label: "GPT-5.4" },
      { value: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
      { value: "gpt-5.3-codex-spark", label: "GPT-5.3-Codex-Spark" },
    ],
    defaultValue: "",
  },
  {
    key: "effortLevel",
    label: "Reasoning",
    type: "select",
    options: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "XHigh" },
    ],
    defaultValue: "medium",
  },
  {
    key: "approvalMode",
    label: "Approval",
    type: "select",
    options: [
      { value: "on-request", label: "On Request" },
      { value: "untrusted", label: "Untrusted" },
      { value: "never", label: "Never Ask" },
    ],
    defaultValue: "on-request",
  },
  {
    key: "sandboxMode",
    label: "Access",
    type: "select",
    options: [
      { value: "workspace-write", label: "Workspace Write" },
      { value: "danger-full-access", label: "Full Access" },
      { value: "read-only", label: "Read Only" },
    ],
    defaultValue: "workspace-write",
  },
  {
    key: "speedMode",
    label: "Speed",
    type: "select",
    options: [
      { value: "standard", label: "Standard" },
      { value: "fast", label: "Fast" },
    ],
    defaultValue: "standard",
    visibleWhen: { model: ["gpt-5.4"] },
  },
];

export const AGENT_OPTIONS: Record<AgentType, AgentOptionDef[]> = {
  claude: CLAUDE_OPTIONS,
  codex: CODEX_OPTIONS,
};

// ─── Message Types ───

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: ToolCall[];
  reasoning?: string;
  timestamp: number;
  /** 사용 모델 */
  model?: string;
  /** API 비용 (USD) */
  costUsd?: number;
  /** 토큰 사용량 */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output?: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "requires_approval"
    | "abandoned";
}

// ─── Context Usage ───

export interface ContextUsage {
  /** 사용된 토큰 수 */
  used: number;
  /** 전체 컨텍스트 윈도우 크기 */
  total: number;
  /** 사용률 (0~100) */
  percentage: number;
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
  workspaceId?: string;
  /** 마지막 응답 모델 */
  model?: string;
  /** 마지막 컨텍스트 사용량 (디스크 저장) */
  contextUsage?: ContextUsage;
  /** Claude Code 세션 ID (--resume용, 디스크 저장) */
  sessionId?: string;
  /** 에이전트 원본 스레드 ID (Codex app-server 등) */
  remoteThreadId?: string;
  /** 스레드별 실행 설정 스냅샷 */
  config?: AgentConfig;
}

// ─── Agent Status ───

export interface AgentStatus {
  agent: AgentType;
  state: "idle" | "running" | "waiting_approval" | "error";
  activeThread?: string;
  model?: string;
  contextUsage?: ContextUsage;
}

// ─── Agent Events ───

export type AgentEvent =
  | { type: "message_start"; threadId: string; agentType: AgentType }
  | {
      type: "message_delta";
      threadId: string;
      agentType: AgentType;
      content: string;
    }
  | {
      type: "message_complete";
      threadId: string;
      agentType: AgentType;
      message: AgentMessage;
    }
  | {
      type: "tool_start";
      threadId: string;
      agentType: AgentType;
      tool: ToolCall;
    }
  | {
      type: "tool_complete";
      threadId: string;
      agentType: AgentType;
      tool: ToolCall;
    }
  | {
      type: "approval_required";
      threadId: string;
      agentType: AgentType;
      tool: ToolCall;
    }
  | { type: "error"; threadId: string; agentType: AgentType; error: string }
  | { type: "status_change"; agentType: AgentType; status: AgentStatus };

// ─── Client → Server Messages ───

export type ClientMessage =
  | {
      type: "send_message";
      agentType: AgentType;
      threadId?: string;
      content: string;
      config?: AgentConfig;
      workspaceId?: string;
    }
  | { type: "interrupt"; agentType: AgentType; threadId: string }
  | {
      type: "approve";
      agentType: AgentType;
      threadId: string;
      toolCallId: string;
      approved: boolean;
    }
  | { type: "list_threads"; agentType: AgentType; workspaceId?: string }
  | {
      type: "rename_thread";
      agentType: AgentType;
      threadId: string;
      title: string;
    }
  | { type: "delete_thread"; agentType: AgentType; threadId: string }
  | { type: "get_thread_messages"; agentType: AgentType; threadId: string }
  | { type: "get_thread_state"; agentType: AgentType; threadId: string }
  | { type: "list_agents" }
  | { type: "select_agent"; agentType: AgentType; config?: AgentConfig }
  // 워크스페이스
  | { type: "list_workspaces" }
  | { type: "create_workspace"; name: string; path: string }
  | { type: "update_workspace"; id: string; name: string }
  | { type: "delete_workspace"; id: string }
  | { type: "browse_directory"; path: string }
  | { type: "git"; action: string; params?: Record<string, unknown>; workspaceId?: string }
  | { type: "file_list"; path: string; workspaceId?: string }
  | { type: "file_read"; path: string; workspaceId?: string }
  | { type: "ping" };

// ─── Server → Client Messages ───

export type ServerMessage =
  | { type: "agent_event"; event: AgentEvent }
  | { type: "agents_list"; agents: AgentInfo[] }
  | { type: "threads_list"; agentType: AgentType; threads: ThreadSummary[] }
  | { type: "thread_messages"; threadId: string; messages: AgentMessage[] }
  | {
      type: "thread_state";
      threadId: string;
      messages: AgentMessage[];
      streaming?: { content: string; toolCalls: ToolCall[] };
      agentStatus?: AgentStatus;
    }
  | {
      type: "connection_status";
      status: "connected" | "disconnected" | "reconnecting";
    }
  // 워크스페이스
  | { type: "workspaces_list"; workspaces: Workspace[] }
  | { type: "workspace_created"; workspace: Workspace }
  | { type: "workspace_deleted"; id: string }
  | { type: "directory_list"; path: string; entries: DirEntry[] }
  | { type: "git_result"; action: string; result: unknown; workspaceId?: string }
  | { type: "file_list_result"; path: string; entries: FileEntry[]; workspaceId?: string }
  | { type: "file_read_result"; path: string; content: string; workspaceId?: string }
  | { type: "error"; message: string; code?: string }
  | { type: "pong" };

export interface DirEntry {
  name: string;
  path: string;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  modified?: number;
}

// ─── QR Payload ───

export interface QRPayload {
  type: "rca";
  version: number;
  relay?: string;
  sessionId: string;
  directUrl: string;
  token: string;
}

// ─── Relay Roles ───

export type RelayRole = "host" | "client";
