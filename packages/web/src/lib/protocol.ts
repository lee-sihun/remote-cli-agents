// Re-export types from @rca/shared for compile-time use.
// These types are erased at runtime by TypeScript, so the browser
// never actually loads the shared package.

export type {
  AgentType,
  AgentInfo,
  AgentConfig,
  AgentOptionDef,
  ContextUsage,
  AgentMessage,
  ToolCall,
  ThreadSummary,
  AgentStatus,
  AgentEvent,
  ClientMessage,
  ServerMessage,
  FileEntry,
  DirEntry,
  Workspace,
  QRPayload,
} from '@rca/shared';

// Runtime helpers

export function isValidQRPayload(obj: unknown): obj is import('@rca/shared').QRPayload {
  if (!obj || typeof obj !== 'object') return false;
  const p = obj as Record<string, unknown>;
  return (
    p.type === 'rca' &&
    typeof p.version === 'number' &&
    typeof p.sessionId === 'string' &&
    typeof p.directUrl === 'string' &&
    typeof p.token === 'string'
  );
}

export function parseQRPayload(input: string): import('@rca/shared').QRPayload | null {
  try {
    const parsed = JSON.parse(input);
    if (isValidQRPayload(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

export function buildWebSocketUrl(payload: import('@rca/shared').QRPayload): string {
  const base = new URL(payload.directUrl);
  const wsProtocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = new URL(`${wsProtocol}//${base.host}/ws`);
  wsUrl.searchParams.set('token', payload.token);
  wsUrl.searchParams.set('sessionId', payload.sessionId);
  return wsUrl.toString();
}

export function generateThreadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `thread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
