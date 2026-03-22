import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateThreadId, buildWebSocketUrl } from './protocol';

describe('generateThreadId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers crypto.randomUUID when available', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => 'uuid-thread-id',
    });

    expect(generateThreadId()).toBe('uuid-thread-id');
  });

  it('falls back to a timestamp-based id when crypto.randomUUID is missing', () => {
    vi.stubGlobal('crypto', {});

    expect(generateThreadId()).toMatch(/^thread-\d+-[a-z0-9]+$/);
  });
});

describe('buildWebSocketUrl', () => {
  const base = {
    type: 'rca' as const,
    version: 1,
    sessionId: 'sess-123',
    token: 'tok-abc',
    directUrl: 'http://192.168.1.100:9470',
  };

  it('relay 있을 때 relay URL에 role/session/token 파라미터 추가', () => {
    const payload = { ...base, relay: 'ws://192.168.1.100:9470/relay' };
    const url = new URL(buildWebSocketUrl(payload));
    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/relay');
    expect(url.searchParams.get('role')).toBe('client');
    expect(url.searchParams.get('session')).toBe('sess-123');
    expect(url.searchParams.get('token')).toBe('tok-abc');
  });

  it('relay 없을 때 http directUrl → ws://.../ws 변환', () => {
    const url = new URL(buildWebSocketUrl(base));
    expect(url.protocol).toBe('ws:');
    expect(url.host).toBe('192.168.1.100:9470');
    expect(url.pathname).toBe('/ws');
    expect(url.searchParams.get('token')).toBe('tok-abc');
    expect(url.searchParams.get('sessionId')).toBe('sess-123');
  });

  it('relay 없을 때 https directUrl → wss://.../ws 변환', () => {
    const payload = { ...base, directUrl: 'https://xxx.trycloudflare.com' };
    const url = new URL(buildWebSocketUrl(payload));
    expect(url.protocol).toBe('wss:');
    expect(url.host).toBe('xxx.trycloudflare.com');
    expect(url.pathname).toBe('/ws');
  });
});
