import { createServer, type Server as HttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { randomUUID } from 'node:crypto';
import type {
  AgentType,
  AgentConfig,
  AgentInfo,
  AgentEvent,
  ClientMessage,
  ServerMessage,
} from '@rca/shared';
import { AGENT_OPTIONS } from '@rca/shared';
import type { AgentAdapter } from './adapters/types.js';
import { ClaudeAdapter } from './adapters/claude.js';
import { CodexAdapter } from './adapters/codex.js';
import { GeminiAdapter } from './adapters/gemini.js';
import { PtyAdapter } from './adapters/pty.js';
import { setupRelay, getRelayStats } from './relay/relay.js';
import * as store from './store.js';
import { sessionManager } from './session.js';
import { handleGit } from './handlers/git.js';
import { listDirectory, readFileContent } from './handlers/file.js';

// MIME 타입 맵
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

const MAX_WS_MESSAGE_BYTES = 1024 * 1024;

export type ClientMessageParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; message: string };

// 서버 설정
export interface ServerConfig {
  port: number;
  cwd: string;
  enableRelay: boolean;
  relayUrl?: string;
  connectionPayload?: import('@rca/shared').QRPayload;
}

// 서버 인스턴스
export interface ServerInstance {
  httpServer: HttpServer;
  wss: WebSocketServer;
  relayWss?: WebSocketServer;
  adapters: Map<AgentType, AgentAdapter>;
  close: () => Promise<void>;
}

// __dirname 대체 (ESM)
const __dirname = typeof import.meta.url !== 'undefined'
  ? fileURLToPath(new URL('.', import.meta.url))
  : process.cwd();

export async function createBridgeServer(config: ServerConfig): Promise<ServerInstance> {
  const { port, cwd, enableRelay } = config;

  // 에이전트 어댑터 초기화
  const adapters = new Map<AgentType, AgentAdapter>();
  const connectedClients = new Set<WebSocket>();

  // 에이전트 감지 및 초기화
  await initializeAdapters(adapters, cwd);

  // 에이전트 이벤트 → 클라이언트 브로드캐스트
  for (const [, adapter] of adapters) {
    adapter.onEvent((event: AgentEvent) => {
      broadcastToClients(connectedClients, {
        type: 'agent_event',
        event,
      });
    });
  }

  // 정적 파일 디렉토리 (빌드된 웹 클라이언트)
  const webDir = join(__dirname, '..', 'web');

  // HTTP 서버
  const httpServer = createServer(async (req, res) => {
    const url = req.url || '/';

    // API 엔드포인트
    if (url === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: Date.now() }));
      return;
    }

    if (url === '/api/agents') {
      const agents = await getAgentsList(adapters);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(agents));
      return;
    }

    if (url === '/api/connection' && config.connectionPayload) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config.connectionPayload));
      return;
    }

    if (url === '/api/relay-stats' && enableRelay) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getRelayStats()));
      return;
    }

    // 정적 파일 서빙
    await serveStaticFile(req.url || '/', webDir, res);
  });

  // WebSocket 서버 (클라이언트 연결용)
  const wss = new WebSocketServer({ noServer: true });

  // 릴레이용 WebSocket 서버 (별도 경로)
  let relayWss: WebSocketServer | undefined;
  if (enableRelay) {
    relayWss = new WebSocketServer({ noServer: true });
    setupRelay(relayWss);
  }

  // HTTP 업그레이드 핸들링 (WS 경로 분리)
  httpServer.on('upgrade', (request, socket, head) => {
    const url = request.url || '/';

    if (url.startsWith('/relay') && relayWss) {
      relayWss.handleUpgrade(request, socket, head, (ws) => {
        relayWss!.emit('connection', ws, request);
      });
    } else if (url.startsWith('/ws') || url === '/') {
      // 토큰 검증 (세션이 있는 경우)
      const params = new URL(url, `http://${request.headers.host}`).searchParams;
      const token = params.get('token') || (request.headers['x-token'] as string);
      const sessionId = params.get('sessionId') || (request.headers['x-session-id'] as string);

      if (sessionId && token) {
        if (!sessionManager.validateToken(sessionId, token)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // 클라이언트 WebSocket 연결 처리
  wss.on('connection', (ws: WebSocket) => {
    const clientId = randomUUID();
    connectedClients.add(ws);

    console.log(`[server] Client connected (${connectedClients.size} total)`);

    // 연결 확인 전송
    sendToClient(ws, {
      type: 'connection_status',
      status: 'connected',
    });

    ws.on('message', async (data) => {
      const parsed = parseClientMessagePayload(data);
      if (!parsed.ok) {
        sendToClient(ws, { type: 'error', message: parsed.message });
        return;
      }

      await handleClientMessage(ws, parsed.message, adapters, cwd);
    });

    ws.on('close', () => {
      connectedClients.delete(ws);
      console.log(`[server] Client disconnected (${connectedClients.size} total)`);
    });

    ws.on('error', (err) => {
      console.error(`[server] Client error: ${err.message}`);
      connectedClients.delete(ws);
    });

    // Heartbeat
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30000);

    ws.on('close', () => clearInterval(pingInterval));

    // 클라이언트 ID 추적
    void clientId;
  });

  // 서버 시작
  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => {
      resolve();
    });
  });

  return {
    httpServer,
    wss,
    relayWss,
    adapters,
    close: async () => {
      // 모든 어댑터 종료
      for (const [, adapter] of adapters) {
        await adapter.stop();
      }

      // WebSocket 서버 종료
      wss.close();
      relayWss?.close();

      // HTTP 서버 종료
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export function parseClientMessagePayload(data: RawData): ClientMessageParseResult {
  const raw = normalizeRawMessage(data);
  if (Buffer.byteLength(raw, 'utf-8') > MAX_WS_MESSAGE_BYTES) {
    return { ok: false, message: 'Message too large' };
  }

  try {
    return { ok: true, message: JSON.parse(raw) as ClientMessage };
  } catch {
    return { ok: false, message: 'Invalid JSON' };
  }
}

function normalizeRawMessage(data: RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString();
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString();
  }
  return Buffer.from(data).toString();
}

// 어댑터 초기화 및 설치된 에이전트 감지
async function initializeAdapters(
  adapters: Map<AgentType, AgentAdapter>,
  cwd: string,
): Promise<void> {
  const candidates: AgentAdapter[] = [
    new ClaudeAdapter(),
    new CodexAdapter(),
    new GeminiAdapter(),
    new PtyAdapter(),
  ];

  for (const adapter of candidates) {
    try {
      const available = await adapter.isAvailable();
      if (available) {
        await adapter.start({ type: adapter.type, cwd });
        adapters.set(adapter.type, adapter);
        console.log(`[server] Agent detected: ${adapter.name}`);
      } else {
        console.log(`[server] Agent not available: ${adapter.name}`);
      }
    } catch (err) {
      console.error(`[server] Failed to init ${adapter.name}: ${err}`);
    }
  }

  // PTY 어댑터는 항상 추가 (폴백)
  if (!adapters.has('pty')) {
    const ptyAdapter = new PtyAdapter();
    try {
      await ptyAdapter.start({ type: 'pty', cwd });
      adapters.set('pty', ptyAdapter);
      console.log(`[server] PTY fallback adapter ready`);
    } catch {
      console.log(`[server] PTY adapter not available (node-pty not installed)`);
    }
  }
}

// 에이전트 목록 생성
async function getAgentsList(
  adapters: Map<AgentType, AgentAdapter>,
): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = [
    {
      type: 'claude',
      name: 'Claude Code',
      available: adapters.has('claude'),
      description: 'Anthropic Claude Code - structured JSON streaming',
      options: AGENT_OPTIONS.claude,
    },
    {
      type: 'codex',
      name: 'Codex',
      available: adapters.has('codex'),
      description: 'OpenAI Codex - JSON-RPC app-server',
      options: AGENT_OPTIONS.codex,
    },
    {
      type: 'gemini',
      name: 'Gemini CLI',
      available: adapters.has('gemini'),
      description: 'Google Gemini CLI - PTY mode',
    },
    {
      type: 'pty',
      name: 'Generic PTY',
      available: adapters.has('pty'),
      description: 'Generic PTY terminal - fallback for any CLI',
    },
  ];

  return agents;
}

// 클라이언트 메시지 처리
async function handleClientMessage(
  ws: WebSocket,
  msg: ClientMessage,
  adapters: Map<AgentType, AgentAdapter>,
  cwd: string,
): Promise<void> {
  switch (msg.type) {
    case 'ping': {
      sendToClient(ws, { type: 'pong' });
      break;
    }

    case 'list_agents': {
      const agents = await getAgentsList(adapters);
      sendToClient(ws, { type: 'agents_list', agents });
      break;
    }

    case 'list_threads': {
      const adapter = adapters.get(msg.agentType);
      if (!adapter) {
        sendToClient(ws, {
          type: 'error',
          message: `Agent not available: ${msg.agentType}`,
          code: 'AGENT_NOT_FOUND',
        });
        return;
      }

      const threads = await adapter.getThreads();
      sendToClient(ws, {
        type: 'threads_list',
        agentType: msg.agentType,
        threads,
      });
      break;
    }

    case 'get_thread_messages': {
      const messages = store.loadMessages(msg.threadId);
      sendToClient(ws, {
        type: 'thread_messages',
        threadId: msg.threadId,
        messages,
      });
      break;
    }

    case 'get_thread_state': {
      const adapter = adapters.get(msg.agentType);
      const messages = store.loadMessages(msg.threadId);
      const streaming = adapter?.getStreamingState?.(msg.threadId) || undefined;
      const agentStatus = adapter?.getStatus();
      sendToClient(ws, {
        type: 'thread_state',
        threadId: msg.threadId,
        messages,
        streaming: streaming || undefined,
        agentStatus,
      });
      break;
    }

    case 'send_message': {
      const adapter = adapters.get(msg.agentType);
      if (!adapter) {
        sendToClient(ws, {
          type: 'error',
          message: `Agent not available: ${msg.agentType}`,
          code: 'AGENT_NOT_FOUND',
        });
        return;
      }

      const threadId = msg.threadId || randomUUID();
      adapter.sendMessage(threadId, msg.content);
      break;
    }

    case 'interrupt': {
      const adapter = adapters.get(msg.agentType);
      if (adapter) {
        adapter.interrupt(msg.threadId);
      }
      break;
    }

    case 'approve': {
      const adapter = adapters.get(msg.agentType);
      if (adapter?.approve) {
        adapter.approve(msg.threadId, msg.toolCallId, msg.approved);
        console.log(`[server] Approval sent: ${msg.agentType}/${msg.threadId} toolCall=${msg.toolCallId} approved=${msg.approved}`);
      } else {
        console.log(`[server] Approve not supported for ${msg.agentType}`);
      }
      break;
    }

    case 'select_agent': {
      const adapter = adapters.get(msg.agentType);
      if (!adapter) {
        sendToClient(ws, {
          type: 'error',
          message: `Agent not available: ${msg.agentType}`,
          code: 'AGENT_NOT_FOUND',
        });
        return;
      }

      // 설정 업데이트 (실행 중이면 config만 갱신, 아니면 full restart)
      if (msg.config) {
        const status = adapter.getStatus();
        if (status.state === 'running') {
          sendToClient(ws, {
            type: 'error',
            message: `Cannot change ${msg.agentType} settings while the agent is running`,
            code: 'AGENT_BUSY',
          });
          return;
        }

        await adapter.stop();
        await adapter.start(msg.config);
      }

      const agents = await getAgentsList(adapters);
      sendToClient(ws, { type: 'agents_list', agents });
      break;
    }

    case 'pty_input': {
      const adapter = adapters.get(msg.agentType);
      if (adapter && 'writeRaw' in adapter) {
        (adapter as { writeRaw: (threadId: string, data: string) => void }).writeRaw(
          msg.threadId,
          msg.data,
        );
      }
      break;
    }

    case 'pty_resize': {
      // 모든 PTY 어댑터에 리사이즈 전파
      for (const [, adapter] of adapters) {
        if ('resize' in adapter) {
          // 활성 스레드 모두에 적용
          const threads = await adapter.getThreads();
          for (const thread of threads) {
            (adapter as { resize: (threadId: string, cols: number, rows: number) => void }).resize(
              thread.id,
              msg.cols,
              msg.rows,
            );
          }
        }
      }
      break;
    }

    case 'git': {
      const result = await handleGit(msg.action, msg.params, cwd);
      sendToClient(ws, {
        type: 'git_result',
        action: msg.action,
        result,
      });
      break;
    }

    case 'file_list': {
      try {
        const entries = await listDirectory(msg.path, cwd);
        sendToClient(ws, {
          type: 'file_list_result',
          path: msg.path,
          entries,
        });
      } catch (err) {
        sendToClient(ws, {
          type: 'error',
          message: err instanceof Error ? err.message : 'Failed to list directory',
          code: 'FILE_ERROR',
        });
      }
      break;
    }

    case 'file_read': {
      try {
        const content = await readFileContent(msg.path, cwd);
        sendToClient(ws, {
          type: 'file_read_result',
          path: msg.path,
          content,
        });
      } catch (err) {
        sendToClient(ws, {
          type: 'error',
          message: err instanceof Error ? err.message : 'Failed to read file',
          code: 'FILE_ERROR',
        });
      }
      break;
    }

    default: {
      sendToClient(ws, {
        type: 'error',
        message: `Unknown message type: ${(msg as { type: string }).type}`,
      });
    }
  }
}

// 클라이언트에 메시지 전송
function sendToClient(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// 모든 연결된 클라이언트에 브로드캐스트
function broadcastToClients(clients: Set<WebSocket>, msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}

// 정적 파일 서빙
async function serveStaticFile(
  url: string,
  webDir: string,
  res: import('node:http').ServerResponse,
): Promise<void> {
  // URL 파싱 (쿼리 파라미터 제거)
  let filePath = url.split('?')[0];

  // index.html 기본값
  if (filePath === '/' || filePath === '') {
    filePath = '/index.html';
  }

  const fullPath = join(webDir, filePath);
  const ext = extname(fullPath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  try {
    const content = await readFile(fullPath);
    // SW 파일은 캐시 방지 (항상 최신 버전 제공)
    const headers: Record<string, string> = { 'Content-Type': contentType };
    if (filePath === '/sw.js' || filePath === '/registerSW.js') {
      headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    }
    res.writeHead(200, headers);
    res.end(content);
  } catch {
    // SPA 폴백: HTML이 아닌 경로에서 404면 index.html 반환
    if (!ext || ext === '.html') {
      try {
        const indexContent = await readFile(join(webDir, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(indexContent);
        return;
      } catch {
        // index.html도 없음
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}
