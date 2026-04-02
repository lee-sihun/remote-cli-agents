import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { TUNNEL_URL_PATTERN, ensureBinary, resolveBinary, startQuickTunnel } from './tunnel.js';

// node:child_process mock
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('cloudflared', () => ({
  bin: '/mock/cloudflared',
  install: vi.fn(async () => '/mock/cloudflared'),
}));

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(existsSync);

async function loadCloudflaredModule() {
  return await import('cloudflared');
}

// spawn이 반환하는 가짜 ChildProcess
function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

afterEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
});

describe('TUNNEL_URL_PATTERN', () => {
  it('trycloudflare.com URL 매칭', () => {
    const text = 'INF Your quick Tunnel has been created! https://random-words.trycloudflare.com';
    const match = text.match(TUNNEL_URL_PATTERN);
    expect(match?.[0]).toBe('https://random-words.trycloudflare.com');
  });

  it('다른 도메인 미매칭', () => {
    expect('https://example.com'.match(TUNNEL_URL_PATTERN)).toBeNull();
  });
});

describe('startQuickTunnel', () => {
  it('패키지 바이너리가 없으면 자동 설치 후 경로 반환', async () => {
    const mod = await loadCloudflaredModule();
    const install = vi.mocked(mod.install);
    mockExistsSync.mockReturnValue(false);

    const binaryPath = await ensureBinary();

    expect(binaryPath).toBe('/mock/cloudflared');
    expect(install).toHaveBeenCalledWith('/mock/cloudflared', 'latest');
  });

  it('패키지 바이너리가 이미 있으면 설치를 건너뜀', async () => {
    const mod = await loadCloudflaredModule();
    const install = vi.mocked(mod.install);
    mockExistsSync.mockReturnValue(true);

    const binaryPath = await ensureBinary();

    expect(binaryPath).toBe('/mock/cloudflared');
    expect(install).not.toHaveBeenCalled();
  });

  it('resolveBinary는 패키지 바이너리 경로를 우선 반환', async () => {
    const binaryPath = await resolveBinary();
    expect(binaryPath).toBe('/mock/cloudflared');
  });

  it('stdout에서 URL 파싱 시 TunnelResult 반환', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const promise = startQuickTunnel(9470, { binaryPath: 'cloudflared', timeoutMs: 5000 });

    // stdout에 URL 출력 시뮬레이션
    proc.stdout.emit('data', Buffer.from('https://test-tunnel.trycloudflare.com\n'));

    const result = await promise;
    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://test-tunnel.trycloudflare.com');
    expect(typeof result?.cleanup).toBe('function');
  });

  it('stderr에서 URL 파싱 시 TunnelResult 반환', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const promise = startQuickTunnel(9470, { binaryPath: 'cloudflared', timeoutMs: 5000 });

    proc.stderr.emit('data', Buffer.from('INF | https://hello-world.trycloudflare.com |'));

    const result = await promise;
    expect(result?.url).toBe('https://hello-world.trycloudflare.com');
  });

  it('spawn 에러 시 null 반환', async () => {
    mockSpawn.mockImplementation(() => { throw new Error('not found'); });

    const result = await startQuickTunnel(9470, { binaryPath: 'no-such-binary', timeoutMs: 5000 });
    expect(result).toBeNull();
  });

  it('프로세스 종료(비정상) 시 null 반환', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const promise = startQuickTunnel(9470, { binaryPath: 'cloudflared', timeoutMs: 5000 });
    proc.emit('exit', 1);

    const result = await promise;
    expect(result).toBeNull();
  });

  it('URL 없이 정상 종료(exit 0) 시 null 반환', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const promise = startQuickTunnel(9470, { binaryPath: 'cloudflared', timeoutMs: 5000 });
    proc.emit('exit', 0);

    const result = await promise;
    expect(result).toBeNull();
  });

  it('타임아웃 시 null 반환 + 프로세스 kill', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const result = await startQuickTunnel(9470, { binaryPath: 'cloudflared', timeoutMs: 50 });

    expect(result).toBeNull();
    expect(proc.kill).toHaveBeenCalled();
  });

  it('cleanup 호출 시 프로세스 kill', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const promise = startQuickTunnel(9470, { binaryPath: 'cloudflared', timeoutMs: 5000 });
    proc.stdout.emit('data', Buffer.from('https://cleanup-test.trycloudflare.com'));

    const result = await promise;
    result?.cleanup();
    expect(proc.kill).toHaveBeenCalled();
  });

  it('URL 파싱 성공 후 이중 호출 방지 (finish 한 번만)', async () => {
    const proc = makeFakeProc();
    mockSpawn.mockReturnValue(proc as unknown as ReturnType<typeof spawn>);

    const promise = startQuickTunnel(9470, { binaryPath: 'cloudflared', timeoutMs: 5000 });

    // 두 번 emit해도 첫 번째만 유효
    proc.stdout.emit('data', Buffer.from('https://first.trycloudflare.com'));
    proc.stdout.emit('data', Buffer.from('https://second.trycloudflare.com'));

    const result = await promise;
    expect(result?.url).toBe('https://first.trycloudflare.com');
  });
});
