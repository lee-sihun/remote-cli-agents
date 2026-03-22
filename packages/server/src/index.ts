import { networkInterfaces } from 'node:os';
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
  noTunnel: boolean;
  cwd: string;
} {
  let port = parsePort(env.RCA_PORT || env.PORT, DEFAULT_PORT);
  let noTunnel = parseFlag(env.RCA_NO_TUNNEL);
  let cwd = env.RCA_CWD || process.cwd();

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--port' || arg === '-p') {
      const val = argv[++i];
      if (val) port = parseInt(val, 10);
      continue;
    }

    if (arg.startsWith('--port=')) {
      port = parseInt(arg.split('=')[1], 10);
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

  return { port, noTunnel, cwd };
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

// 메인 실행 함수
export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);

  console.log('');
  console.log('  Remote CLI Agents v0.1.0');
  console.log('');

  // 세션 생성 (서버 시작 전에 생성하여 connectionPayload로 전달)
  const { sessionId, token } = sessionManager.create();
  const lanIp = getLanIp();
  const directUrl = `http://${lanIp}:${args.port}`;

  // 연결 페이로드 (서버 API + QR 코드에서 공유)
  const payload: QRPayload = {
    type: 'rca',
    version: 1,
    sessionId,
    directUrl,
    token,
  };

  // Bridge 서버 시작
  const config: ServerConfig = {
    port: args.port,
    cwd: args.cwd,
    connectionPayload: payload,
  };

  const server = await createBridgeServer(config);

  // 감지된 에이전트 출력
  const agentNames = Array.from(server.adapters.keys());
  console.log(`  Detected agents: ${agentNames.length > 0 ? agentNames.join(', ') : 'none'}`);

  console.log(`  Server started on ${directUrl}`);
  console.log(`  Working directory: ${args.cwd}`);
  console.log('');

  // Quick Tunnel 시작
  // RCA_TUNNEL_URL 또는 CLOUDFLARE_TUNNEL_URL 환경변수로 정식 터널 URL 직접 지정 가능
  let tunnelCleanup: (() => void) | null = null;
  const envTunnelUrl = process.env.RCA_TUNNEL_URL || process.env.CLOUDFLARE_TUNNEL_URL;

  if (envTunnelUrl && !args.noTunnel) {
    payload.directUrl = envTunnelUrl;
    console.log(`  Tunnel: ${envTunnelUrl}`);
  } else if (!args.noTunnel) {
    console.log('  Starting Cloudflare tunnel...');
    const tunnel = await startQuickTunnel(args.port);
    if (tunnel) {
      payload.directUrl = tunnel.url;
      tunnelCleanup = tunnel.cleanup;
      console.log(`  Tunnel: ${tunnel.url}`);
    } else {
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

// 직접 실행 시 메인 함수 호출
main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
