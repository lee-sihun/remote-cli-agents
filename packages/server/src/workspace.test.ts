import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, ThreadSummary, Workspace } from '@rca/shared';

describe('workspace', () => {
  let tempHomeDir: string;

  beforeEach(() => {
    tempHomeDir = mkdtempSync(join(tmpdir(), 'rca-ws-test-'));
    vi.resetModules();
    vi.doMock('node:os', () => ({
      homedir: () => tempHomeDir,
    }));
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    vi.resetModules();
    rmSync(tempHomeDir, { recursive: true, force: true });
  });

  // ─── Workspace CRUD ───

  it('creates and loads workspaces', async () => {
    const store = await import('./store.ts');

    const ws1 = store.createWorkspace('Project A', '/home/user/project-a');
    const ws2 = store.createWorkspace('Project B', '/home/user/project-b');

    expect(ws1.name).toBe('Project A');
    expect(ws1.path).toBe('/home/user/project-a');
    expect(ws1.id).toBeTruthy();

    const all = store.loadWorkspaces();
    expect(all).toHaveLength(2);
    expect(all.map((w) => w.name)).toEqual(['Project A', 'Project B']);
  });

  it('prevents duplicate workspace paths', async () => {
    const store = await import('./store.ts');

    const ws1 = store.createWorkspace('First', '/shared/path');
    const ws2 = store.createWorkspace('Second', '/shared/path');

    // 같은 경로면 기존 워크스페이스 반환
    expect(ws1.id).toBe(ws2.id);
    expect(store.loadWorkspaces()).toHaveLength(1);
  });

  it('updates workspace name', async () => {
    const store = await import('./store.ts');

    const ws = store.createWorkspace('Old Name', '/path');
    const updated = store.updateWorkspace(ws.id, 'New Name');

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('New Name');
    expect(store.loadWorkspaces()[0]?.name).toBe('New Name');
  });

  it('deletes workspace and its thread/message files', async () => {
    const store = await import('./store.ts');

    const ws = store.createWorkspace('Temp', '/tmp/temp-ws');

    // 스레드 및 메시지 저장
    const thread: ThreadSummary = {
      id: 'thread-ws-del',
      agentType: 'claude',
      title: 'Will be deleted',
      messageCount: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    store.saveThread('claude', thread, ws.id);
    store.appendMessage(thread.id, {
      id: 'msg-1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
    });

    const msgFile = join(tempHomeDir, '.rca', 'data', 'messages', `${thread.id}.json`);
    const threadFile = join(tempHomeDir, '.rca', 'data', 'threads', `${ws.id}.json`);
    expect(existsSync(msgFile)).toBe(true);
    expect(existsSync(threadFile)).toBe(true);

    // 워크스페이스 삭제
    const deleted = store.deleteWorkspace(ws.id);
    expect(deleted).toBe(true);

    expect(store.loadWorkspaces()).toHaveLength(0);
    expect(existsSync(threadFile)).toBe(false);
    expect(existsSync(msgFile)).toBe(false);
  });

  it('touchWorkspace updates lastAccessedAt', async () => {
    const store = await import('./store.ts');

    const ws = store.createWorkspace('Touch', '/path');
    const before = ws.lastAccessedAt;

    // 시간 차이 확보
    await new Promise((r) => setTimeout(r, 10));
    store.touchWorkspace(ws.id);

    const after = store.loadWorkspaces()[0]!.lastAccessedAt;
    expect(after).toBeGreaterThan(before);
  });

  // ─── Thread 격리 ───

  it('isolates threads per workspace', async () => {
    const store = await import('./store.ts');

    const ws1 = store.createWorkspace('WS1', '/ws1');
    const ws2 = store.createWorkspace('WS2', '/ws2');

    const thread1: ThreadSummary = {
      id: 'thread-in-ws1',
      agentType: 'claude',
      title: 'WS1 Thread',
      messageCount: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const thread2: ThreadSummary = {
      id: 'thread-in-ws2',
      agentType: 'claude',
      title: 'WS2 Thread',
      messageCount: 0,
      createdAt: 2,
      updatedAt: 2,
    };

    store.saveThread('claude', thread1, ws1.id);
    store.saveThread('claude', thread2, ws2.id);

    // 워크스페이스별 격리 확인
    const ws1Threads = store.loadThreads('claude', ws1.id);
    const ws2Threads = store.loadThreads('claude', ws2.id);

    expect(ws1Threads).toHaveLength(1);
    expect(ws1Threads[0]?.id).toBe('thread-in-ws1');

    expect(ws2Threads).toHaveLength(1);
    expect(ws2Threads[0]?.id).toBe('thread-in-ws2');
  });

  it('supports multiple agent types in the same workspace', async () => {
    const store = await import('./store.ts');

    const ws = store.createWorkspace('Multi', '/multi');

    store.saveThread('claude', {
      id: 'claude-t',
      agentType: 'claude',
      title: 'Claude Thread',
      messageCount: 0,
      createdAt: 1,
      updatedAt: 1,
    }, ws.id);

    store.saveThread('codex', {
      id: 'codex-t',
      agentType: 'codex',
      title: 'Codex Thread',
      messageCount: 0,
      createdAt: 2,
      updatedAt: 2,
    }, ws.id);

    expect(store.loadThreads('claude', ws.id)).toHaveLength(1);
    expect(store.loadThreads('codex', ws.id)).toHaveLength(1);

    // loadAllThreads 확인
    const all = store.loadAllThreads(ws.id);
    expect(all.get('claude')).toHaveLength(1);
    expect(all.get('codex')).toHaveLength(1);
  });

  it('renames a thread within a workspace', async () => {
    const store = await import('./store.ts');

    const ws = store.createWorkspace('Rename', '/rename');
    store.saveThread('claude', {
      id: 'thread-rename',
      agentType: 'claude',
      title: 'Before',
      messageCount: 0,
      createdAt: 1,
      updatedAt: 1,
    }, ws.id);

    const ok = store.renameThread('claude', 'thread-rename', 'After', ws.id);
    expect(ok).toBe(true);

    const threads = store.loadThreads('claude', ws.id);
    expect(threads[0]?.title).toBe('After');
  });

  // ─── 레거시 마이그레이션 ───

  it('migrates legacy threads.json to workspace-based storage', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');

    // 레거시 파일 생성
    const dataDir = join(tempHomeDir, '.rca', 'data');
    mkdirSync(dataDir, { recursive: true });

    const legacyThreads = {
      claude: [{
        id: 'legacy-thread-1',
        agentType: 'claude',
        title: 'Legacy Session',
        messageCount: 1,
        createdAt: 1000,
        updatedAt: 2000,
      }],
    };
    writeFileSync(join(dataDir, 'threads.json'), JSON.stringify(legacyThreads), 'utf-8');

    const store = await import('./store.ts');

    // 마이그레이션 실행
    store.migrateIfNeeded('/home/user/default-project');

    // 레거시 파일 삭제 확인
    expect(existsSync(join(dataDir, 'threads.json'))).toBe(false);

    // default 워크스페이스 생성 확인
    const workspaces = store.loadWorkspaces();
    expect(workspaces.length).toBeGreaterThanOrEqual(1);

    const defaultWs = workspaces[0]!;
    expect(defaultWs.path).toBe('/home/user/default-project');

    // 스레드 이전 확인
    const threads = store.loadThreads('claude', defaultWs.id);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.id).toBe('legacy-thread-1');
    expect(threads[0]?.workspaceId).toBe(defaultWs.id);
  });

  // ─── workspaceId 전파 (어댑터 통합) ───

  it('saveThread persists to correct workspace file on disk', async () => {
    const store = await import('./store.ts');

    const ws = store.createWorkspace('Persist', '/persist');

    store.saveThread('claude', {
      id: 'persist-thread',
      agentType: 'claude',
      title: 'Persisted',
      messageCount: 0,
      createdAt: 1,
      updatedAt: 1,
      workspaceId: ws.id,
    }, ws.id);

    // 디스크에서 직접 확인
    const threadFile = join(tempHomeDir, '.rca', 'data', 'threads', `${ws.id}.json`);
    expect(existsSync(threadFile)).toBe(true);

    const raw = JSON.parse(readFileSync(threadFile, 'utf-8'));
    expect(raw.claude).toHaveLength(1);
    expect(raw.claude[0].id).toBe('persist-thread');
    expect(raw.claude[0].workspaceId).toBe(ws.id);
  });

  it('thread saved to "default" is not visible in actual workspace', async () => {
    const store = await import('./store.ts');

    const ws = store.createWorkspace('Real', '/real');

    // 실수로 default에 저장된 경우
    store.saveThread('claude', {
      id: 'wrong-thread',
      agentType: 'claude',
      title: 'Wrong Place',
      messageCount: 0,
      createdAt: 1,
      updatedAt: 1,
    }, 'default');

    // 실제 워크스페이스에서는 보이지 않음
    expect(store.loadThreads('claude', ws.id)).toHaveLength(0);
    // default에만 존재
    expect(store.loadThreads('claude', 'default')).toHaveLength(1);
  });
});
