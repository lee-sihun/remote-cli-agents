import { spawn, type ChildProcess } from 'node:child_process';

export const TUNNEL_URL_PATTERN = /https:\/\/[\w-]+\.trycloudflare\.com/;

// 터널 시작 타임아웃 (ms)
const TIMEOUT_MS = 30_000;

export interface TunnelResult {
  url: string;
  cleanup: () => void;
}

// cloudflared 바이너리 경로 결정
// 1순위: npm optionalDependency로 설치된 cloudflared 패키지
// 2순위: 시스템 PATH의 cloudflared
export async function resolveBinary(): Promise<string> {
  try {
    // optionalDependency이므로 동적 import + any 캐스트
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = await import('cloudflared' as string) as any;
    const bin: unknown = mod?.bin ?? mod?.default?.bin;
    if (typeof bin === 'string' && bin) return bin;
  } catch {
    // 패키지 미설치 → 시스템 바이너리 시도
  }
  return 'cloudflared';
}

// Cloudflare Quick Tunnel 시작
// 성공 시 TunnelResult 반환, 실패/미설치 시 null 반환
export async function startQuickTunnel(
  port: number,
  options?: { binaryPath?: string; timeoutMs?: number },
): Promise<TunnelResult | null> {
  const binaryPath = options?.binaryPath ?? await resolveBinary();
  const timeoutMs = options?.timeoutMs ?? TIMEOUT_MS;

  return new Promise((resolve) => {
    let proc: ChildProcess;
    let resolved = false;

    const finish = (result: TunnelResult | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      proc?.kill();
      finish(null);
    }, timeoutMs);

    try {
      proc = spawn(binaryPath, ['tunnel', '--url', `http://127.0.0.1:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      finish(null);
      return;
    }

    const handleOutput = (data: Buffer) => {
      const match = data.toString().match(TUNNEL_URL_PATTERN);
      if (match) {
        finish({
          url: match[0],
          cleanup: () => { proc.kill(); },
        });
      }
    };

    proc.stdout?.on('data', handleOutput);
    proc.stderr?.on('data', handleOutput);

    proc.on('error', () => finish(null));

    // URL 출력 없이 종료 시 null 반환 (정상/비정상 종료 모두)
    proc.on('exit', () => finish(null));
  });
}
