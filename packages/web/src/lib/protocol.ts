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
  QRPayload,
  RelayRole,
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
  if (payload.relay) {
    // Connect via relay
    const url = new URL(payload.relay);
    url.searchParams.set('session', payload.sessionId);
    url.searchParams.set('token', payload.token);
    url.searchParams.set('role', 'client');
    return url.toString();
  }
  // Direct connection
  const url = new URL(payload.directUrl);
  url.searchParams.set('token', payload.token);
  return url.toString();
}

export function generateThreadId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `thread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
