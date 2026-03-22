import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { sessionManager } from './session.ts';

class MockAdapter {
  readonly type;
  readonly name;

  constructor(type: 'claude' | 'codex' | 'gemini' | 'pty', name: string) {
    this.type = type;
    this.name = name;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async isAvailable(): Promise<boolean> { return false; }
  sendMessage(): void {}
  interrupt(): void {}
  onEvent(): void {}
  getStatus() { return { agent: this.type, state: 'idle' as const }; }
  async getThreads() { return []; }
}

vi.mock('./adapters/claude.js', () => ({
  ClaudeAdapter: class extends MockAdapter {
    constructor() { super('claude', 'Claude Code'); }
  },
}));

vi.mock('./adapters/codex.js', () => ({
  CodexAdapter: class extends MockAdapter {
    constructor() { super('codex', 'Codex'); }
  },
}));

vi.mock('./handlers/git.js', () => ({
  handleGit: vi.fn(),
}));

vi.mock('./handlers/file.js', () => ({
  listDirectory: vi.fn(),
  readFileContent: vi.fn(),
}));

describe('WebSocket token validation', () => {
  let server: Awaited<ReturnType<typeof import('./server.ts')['createBridgeServer']>>;
  let port: number;

  beforeEach(async () => {
    sessionManager.clear();
    const { createBridgeServer } = await import('./server.ts');
    server = await createBridgeServer({
      port: 0,
      cwd: process.cwd(),
    });
    port = (server.httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await server.close();
    sessionManager.clear();
  });

  it('rejects invalid session tokens during WebSocket upgrade', async () => {
    const { sessionId } = sessionManager.create();

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?sessionId=${sessionId}&token=invalid`);

      ws.on('unexpected-response', (_request, response) => {
        expect(response.statusCode).toBe(401);
        resolve();
      });

      ws.on('open', () => reject(new Error('WebSocket connection should have been rejected')));
      ws.on('error', () => {
        // unexpected-response와 함께 발생 가능
      });
    });
  });

  it('accepts valid session tokens during WebSocket upgrade', async () => {
    const { sessionId, token } = sessionManager.create();

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?sessionId=${sessionId}&token=${token}`);

      ws.on('open', () => {
        ws.close();
        resolve();
      });

      ws.on('unexpected-response', (_request, response) => {
        reject(new Error(`Unexpected upgrade rejection: ${response.statusCode}`));
      });

      ws.on('error', reject);
    });
  });
});
