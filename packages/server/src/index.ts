import { networkInterfaces } from 'node:os';
import { WebSocket } from 'ws';
import type { QRPayload } from '@rca/shared';
import { createBridgeServer, type ServerConfig } from './server.js';
import { sessionManager } from './session.js';
import { printQR } from './qr.js';
import { startQuickTunnel } from './tunnel.js';

const DEFAULT_PORT = 9470;

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFlag(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

// CLI 인자 파싱
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): {
  port: number;
  relay: string | null;
  noRelay: boolean;
  noTunnel: boolean;
  cwd: string;
  command: string;
} {
  let port = parsePort(env.RCA_PORT || env.PORT, DEFAULT_PORT);
  let relay: string | null = env.RCA_RELAY_URL || null;
  let noRelay = parseFlag(env.RCA_NO_RELAY);
  let noTunnel = parseFlag(env.RCA_NO_TUNNEL);
  let cwd = env.RCA_CWD || process.cwd();
  let command = 'up';

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === 'up' || arg === 'relay') {
      command = arg;
      continue;
    }

    if (arg === '--port' || arg === '-p') {
      const val = argv[++i];
      if (val) port = parseInt(val, 10);
      continue;
    }

    if (arg.startsWith('--port=')) {
      port = parseInt(arg.split('=')[1], 10);
      continue;
    }

    if (arg === '--relay') {
      relay = argv[++i] || null;
      continue;
    }

    if (arg.startsWith('--relay=')) {
      relay = arg.split('=')[1] || null;
      continue;
    }

    if (arg === '--no-relay') {
      noRelay = true;
      continue;
    }

    if (arg === '--no-tunnel') {
      noTunnel = true;
      continue;
    }

    if (arg === '--cwd') {
      cwd = argv[++i] || process.cwd();
      continue;
    }

    if (arg.startsWith('--cwd=')) {
      cwd = arg.split('=')[1] || process.cwd();
      continue;
    }
  }

  return { port, relay, noRelay, noTunnel, cwd, command };
}

// LAN IP 주소 조회
function getLanIp(): string {
  const interfaces = networkInterfaces();

  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;

    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }

  return '127.0.0.1';
}

// 릴레이 서버에 호스트로 연결
function connectToRelay(
  relayUrl: string,
  sessionId: string,
  token: string,
): WebSocket {
  console.log(`[relay] Connecting to relay: ${relayUrl}`);

  const ws = new WebSocket(relayUrl, {
    headers: {
      'x-role': 'host',
      'x-session-id': sessionId,
      'x-token': token,
    },
  });

  ws.on('open', () => {
    console.log(`[relay] Connected to relay server`);
  });

  ws.on('close', () => {
    console.log(`[relay] Disconnected from relay, reconnecting in 5s...`);
    setTimeout(() => {
      connectToRelay(relayUrl, sessionId, token);
    }, 5000);
  });

  ws.on('error', (err) => {
    console.error(`[relay] Connection error: ${err.message}`);
  });

  // 릴레이에서 받은 메시지를 로컬 처리
  ws.on('message', (data) => {
    // 클라이언트 메시지를 로컬 서버로 전달
    // 구현 시 로컬 WebSocket 서버의 메시지 핸들러와 연결 필요
    void data;
  });

  return ws;
}

// 메인 실행 함수
export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);

  console.log('');
  console.log('  Remote CLI Agents v0.1.0');
  console.log('');

  // relay 전용 모드
  if (args.command === 'relay') {
    await startRelayOnly(args.port);
    return;
  }

  // 세션 생성 (서버 시작 전에 생성하여 connectionPayload로 전달)
  const { sessionId, token } = sessionManager.create();
  const lanIp = getLanIp();
  const directUrl = `http://${lanIp}:${args.port}`;

  // 릴레이 URL 결정
  let relayWsUrl: string | undefined;
  if (args.relay && !args.noRelay) {
    relayWsUrl = args.relay;
  } else if (!args.noRelay) {
    relayWsUrl = `ws://${lanIp}:${args.port}/relay`;
  }

  // 연결 페이로드 (서버 API + QR 코드에서 공유)
  const payload: QRPayload = {
    type: 'rca',
    version: 1,
    relay: relayWsUrl,
    sessionId,
    directUrl,
    token,
  };

  // Bridge 서버 시작
  const config: ServerConfig = {
    port: args.port,
    cwd: args.cwd,
    enableRelay: !args.noRelay,
    relayUrl: args.relay || undefined,
    connectionPayload: payload,
  };

  const server = await createBridgeServer(config);

  // 감지된 에이전트 출력
  const agentNames = Array.from(server.adapters.keys());
  console.log(`  Detected agents: ${agentNames.length > 0 ? agentNames.join(', ') : 'none'}`);

  console.log(`  Server started on ${directUrl}`);
  console.log(`  Working directory: ${args.cwd}`);
  console.log('');

  // 릴레이 연결
  if (args.relay && !args.noRelay) {
    connectToRelay(args.relay, sessionId, token);
  }

  // Quick Tunnel 시작
  // --relay 지정 시 터널 스킵, --no-relay / --no-tunnel 도 스킵
  // RCA_TUNNEL_URL 또는 CLOUDFLARE_TUNNEL_URL 환경변수로 정식 터널 URL 직접 지정 가능
  let tunnelCleanup: (() => void) | null = null;
  const envTunnelUrl = process.env.RCA_TUNNEL_URL || process.env.CLOUDFLARE_TUNNEL_URL;

  if (envTunnelUrl && !args.relay && !args.noRelay && !args.noTunnel) {
    payload.directUrl = envTunnelUrl;
    payload.relay = undefined;
    console.log(`  Tunnel: ${envTunnelUrl}`);
  } else if (!args.relay && !args.noRelay && !args.noTunnel) {
    console.log('  Starting Cloudflare tunnel...');
    const tunnel = await startQuickTunnel(args.port);
    if (tunnel) {
      payload.directUrl = tunnel.url;
      payload.relay = undefined;
      tunnelCleanup = tunnel.cleanup;
      console.log(`  Tunnel: ${tunnel.url}`);
    } else {
      // 터널 실패 → relay 제거하여 QR 스캔 시 LAN 직접 연결로 fallback
      payload.relay = undefined;
      console.log('  Tunnel unavailable, using LAN mode');
    }
  }

  console.log('');
  console.log('  Scan this QR code to connect:');
  await printQR(payload);

  // 종료 처리
  const shutdown = async () => {
    console.log('\n  Shutting down...');
    tunnelCleanup?.();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 릴레이 전용 모드
async function startRelayOnly(port: number): Promise<void> {
  const { setupRelay, getRelayStats } = await import('./relay/relay.js');
  const { createServer } = await import('node:http');
  const { WebSocketServer } = await import('ws');

  const httpServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(getRelayStats()));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  const wss = new WebSocketServer({ server: httpServer });
  setupRelay(wss);

  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => resolve());
  });

  const lanIp = getLanIp();
  console.log(`  Relay server started`);
  console.log(`  URL: ws://${lanIp}:${port}`);
  console.log('');

  process.on('SIGINT', () => {
    console.log('\n  Shutting down relay...');
    wss.close();
    httpServer.close();
    process.exit(0);
  });
}

// 직접 실행 시 메인 함수 호출
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
